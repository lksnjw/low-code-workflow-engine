import { randomBytes } from "node:crypto";
import { assertErpnextWriteArguments, assertErpnextWriteReceipt } from "../tools/erpnext-document-write.js";
import { OperationPolicyBlocked, prepareOperationPolicy } from "../governance/record-workflow-policy.js";
import { captureUserMcpBinding, withUserMcpBinding } from "../tools/user-mcp-credentials.js";
import { boundedOperation } from "../core/bounded-operation.js";
import { canonicalJSONBytes, resolvedParameterHashBytes } from "../core/canonical-json.js";
import type { CurrentUser, HandlerServices } from "../http/handlers/common.js";
import { HandlerFailure, validateWorkflow } from "../http/handlers/common.js";
import { operationGovernanceBinding } from "../governance/service.js";
import type { Execution, ReportWindow, ReportWindowInputBinding, Repository, RepositoryState } from "../repository/store.js";
import { effectiveStepKind, type Workflow } from "../models/schemas.js";
import { parseWorkflowYAMLStrict, workflowContentHash } from "../parser/workflow.js";
import { withoutSecretFields } from "../redact/secrets.js";
import { publicExecution } from "../redact/public-model-usage.js";
import { newReadProgress, appendExecutionEvent, assertCurrentRunController } from "./read-checkpoints.js";
import { advanceOperationDecisions } from "./operation-control-checkpoints.js";
import { assertOperationReturnCompletion } from "./operation-return-checkpoints.js";
import { assertExecutionRetry, type ExecutionRetryRequest } from "./execution-retry.js";
import { operationValueState } from "./operation-merge-checkpoints.js";
import { prepareProtectedSelection, checkpointProtectedSelection, queueProtectedHandler, confirmedProtectedOperationTransition, assertProtectedCheckpointOwnership } from "./operation-protected-checkpoints.js";
import { assertConfirmedOperationResults } from "./operation-result-evidence.js";
import { requeueConfirmedProtectedCheckpoint } from "./operation-protected-recovery.js";
import { operationClaimDenial } from "./operation-claim-checkpoints.js";
import { operationControlTransition } from "../workflows/operation-control-flow.js";
import { scheduledReportPaths } from "./scheduled-report-paths.js";
import { selectScheduledReportEvidence } from "./scheduled-report-evidence.js";
import { assertScheduledRelatedRead } from "./scheduled-related-read.js";
import { prepareOperationExecution } from "../workflows/operation-compilation-lifecycle.js";
import { isOperationToolNode, resolveReadBinding, type CompiledOperationPlan, type OperationToolNode } from "../workflows/compiled-read.js";
import { modelInputItemCount } from "../workflows/model-input.js";
import { validateToolInput } from "../tools/tool-input-schema.js";
import { validateToolArguments } from "../agent/workflow-runtime-validator.js";
import { discoverTools } from "../agent/tool-discovery.js";
import { acknowledgedReadToolFailure, dispatchReadTool } from "../tools/read-tool-broker.js";
import { createDispatchIdentity } from "../tools/registry.js";
import { issueOperationDispatchPermit, retireOperationDispatchPermit } from "../tools/operation-dispatch-permit.js";
import { hasReservedBridgeRole } from "../tools/erpbridge-contract.js";
import { assertConsumedRuntimeApproval, consumeRuntimeApproval, requestRuntimeApproval, runtimeApprovalPolicyHash, runtimeApprovalEvidence } from "./runtime-approvals.js";
import type { OperationIntent } from "./operation-state.js";
import type { ToolDefinition } from "../registry/schemas.js";
import { assertReportCursorProgress, assertReportPageProgress, assertScheduledReportCoverageReceipt, completeCursorPaginatedReport, completePaginatedReport,
  assertReportRelatedKeyProgress, confirmScheduledReportCoverage, confirmScheduledReportCursor, confirmScheduledReportPage, newReportCursorProgress, newReportPageProgress,
  protectedReportPageOutput, reportPagination, type ReportCoverageReceipt } from "../tools/report-coverage-contract.js";
import { assertRuntimeAgentEgress, assertRuntimeAnalysisEgress } from "../providers/egress-policy.js";
import { ANALYSIS_PROMPT_VERSION } from "../providers/runtime.js";
import { promptData } from "../prompts/contracts.js";
import { validateValue } from "../structured-output/validate.js";
import { runRuntimeAgent, RuntimeAgentKnownFailure } from "./runtime-agent.js";
import { boundMcpConnection } from "../tools/mcp-dispatch-context.js";
import type { ReviewedReadBusinessFailure } from "../tools/read-business-error.js";
import { bindExecutionHost, residentExecutionAllowed, requireResidentExecution } from "./execution-host.js";
import { assertOperationTaskReady, operationTaskGeneration, operationTaskReceipt, operationTaskCommandSchema, prepareOperationTaskGeneration,
  completeOperationTaskGeneration, dispatchOperationTaskOutbox, requireOperationTaskAdmission, type OperationTaskCommand } from "./operation-task-outbox.js";
import { assertWorkflowLifecycleScope, type WorkflowLifecycleScope } from "./workflow-lifecycle-host.js";

const queues = new WeakMap<Repository, OperationJobQueue>();
const digest = (value: unknown) => resolvedParameterHashBytes(canonicalJSONBytes(value));
export function supportsOperationJobs(services: HandlerServices): boolean {
  const storage = services.repository.persistence;
  return storage === null || storage.readQueueDurability === "encrypted-single-writer" && storage.executionCheckpointDurability === "encrypted-record-transactions/v1" && !!storage.saveExecutionCheckpoint;
}
export function operationJobQueue(services: HandlerServices): OperationJobQueue {
  let queue = queues.get(services.repository);
  if (!queue || queue.closed) { queue = new OperationJobQueue(services); queues.set(services.repository, queue); }
  return queue;
}
type Active = { id: string; actorId: string; leaseId: string; controller: AbortController; valid: boolean; expiresAt: number; governanceHash?: string; governanceExpiresAt?: number; timer?: NodeJS.Timeout; task?: Promise<void>;
  taskCommand?: OperationTaskCommand; deadlineAt?: number };
function audit(state: RepositoryState, run: Execution, action: string) {
  state.auditLogs.push({ id: `operation-audit-${randomBytes(12).toString("hex")}`, actor: run.startedBy, source: "operation-job/v1", action,
    resource: { type: "execution", id: run.id }, after: { status: run.status }, createdAt: new Date().toISOString() });
}
function finish(state: RepositoryState, run: Execution, status: string, summary: string) {
  run.status = status; run.completedAt = new Date().toISOString(); run.durationMs = Math.max(0, Date.parse(run.completedAt) - Date.parse(run.startedAt)); run.agentSummary = summary;
  if (run.operationSecret) { run.operationSecret.state = status === "RECOVERY_REQUIRED" || status === "RECONCILIATION_REQUIRED" ? "RECOVERY_REQUIRED" : "FINISHED"; delete run.operationSecret.lease; }
  if (status === "FAILED" || status === "CANCELLED") for (const attempt of Object.values(run.readProgress?.attempts ?? {})) {
    if (attempt.status !== "PREPARING") continue;
    attempt.status = status; attempt.completedAt = run.completedAt;
    const entry = state.timelines[run.id]?.find(item => item.attemptId === attempt.id);
    if (entry) Object.assign(entry, { status, outcome: "NOT_DISPATCHED", completedAt: run.completedAt });
    appendExecutionEvent(state, run, "node.not_dispatched", { outcome: "NOT_DISPATCHED", status }, attempt.nodeId, attempt.id);
  }
  appendExecutionEvent(state, run, `run.${status.toLowerCase()}`, { status }); audit(state, run, `execution.${status.toLowerCase()}`);
}
function recover(state: RepositoryState, run: Execution, reason: string) {
  if (run.operationSecret?.state !== "CLAIMED" || run.status !== "RUNNING") return;
  if (requeueConfirmedProtectedCheckpoint(state, run, reason)) { audit(state, run, "operation.protected_checkpoint_requeued"); return; }
  const progress = run.readProgress!, attempt = Object.values(progress.attempts).findLast(item => ["PREPARING", "DISPATCH_INTENT"].includes(item.status));
  const resumablePages = attempt?.status === "PREPARING" ? run.reportPageSecret?.[attempt.nodeId] : undefined;
  const pageInFlight = attempt && Object.values(run.operationSecret.intents).some(intent => intent.nodeId === attempt.nodeId && intent.state === "DISPATCH_INTENT");
  if (attempt && resumablePages && !pageInFlight && run.workflowSnapshot?.operationCompilation?.schemaVersion !== "workflow-operation-ir/v8") {
    progress.epoch++; progress.recoveryReason = reason; run.status = "PENDING"; run.agentSummary = "Confirmed report pages were saved. The next bounded page is queued; no uncertain page is replayed.";
    run.operationSecret.state = "QUEUED"; delete run.operationSecret.lease;
    appendExecutionEvent(state, run, "node.report_pages_requeued", { nextPage: resumablePages.profile === "schedule-report-pages/v1" ? resumablePages.nextPage : resumablePages.pages.length + 1,
      confirmedPages: resumablePages.pages.length, continuationProfile: resumablePages.profile, reason }, attempt.nodeId, attempt.id);
    audit(state, run, "operation.report_pages_requeued"); return;
  }
  const uncertain = attempt?.status === "DISPATCH_INTENT";
  const uncertainIntent = uncertain && attempt ? Object.values(run.operationSecret.intents).findLast(value => value.nodeId === attempt.nodeId && value.state === "DISPATCH_INTENT") : undefined;
  let uncertainAnalysis = false;
  if (uncertain && attempt && run.operationSecret.analysisProvider) {
    try { uncertainAnalysis = effectiveStepKind(parseWorkflowYAMLStrict(run.workflowSnapshot!.yaml).steps[attempt.stepIndex]!) === "analysis"; } catch { uncertainAnalysis = false; }
  }
  const uncertainAgent = uncertainIntent?.dispatchKind === "agent-model" || uncertainIntent?.dispatchKind === "agent-tool";
  if (attempt) {
    attempt.status = uncertain ? "UNKNOWN" : "FAILED"; attempt.completedAt = new Date().toISOString();
    const intent = uncertainIntent ?? Object.values(run.operationSecret.intents).findLast(value => value.nodeId === attempt.nodeId && value.state === "DISPATCH_INTENT"); if (intent) intent.state = "UNKNOWN";
    const entry = state.timelines[run.id]?.find(item => item.attemptId === attempt.id);
    if (entry) { entry.status = uncertain ? "UNKNOWN" : "FAILED"; entry.outcome = uncertain ? "UNKNOWN" : "NOT_DISPATCHED"; entry.completedAt = attempt.completedAt; }
    appendExecutionEvent(state, run, uncertain ? "node.outcome_unknown" : "node.interrupted", { outcome: uncertain ? "UNKNOWN" : "NOT_DISPATCHED", reason }, attempt.nodeId, attempt.id);
  }
  progress.epoch++; progress.recoveryReason = reason;
  run.failure = { failureCategory: uncertainAgent ? "AGENT_OUTCOME_UNKNOWN" : uncertainAnalysis ? "ANALYSIS_OUTCOME_UNKNOWN" : uncertain ? "OPERATION_OUTCOME_UNKNOWN" : "OPERATION_INTERRUPTED", failedStepId: attempt?.nodeId ?? "checkpoint", reason };
  finish(state, run, uncertainAgent || uncertainAnalysis ? "RECOVERY_REQUIRED" : uncertain ? "RECONCILIATION_REQUIRED" : "RECOVERY_REQUIRED",
    uncertainAgent ? "A runtime-agent model turn or governed read may have completed, but no result was acknowledged. It was not replayed and no later effect ran." :
    uncertainAnalysis ? "The model call may have completed, but no validated result was acknowledged. It was not replayed, no later effect ran, and a separate new execution is required." :
      uncertain ? "An operation intent has no confirmed outcome. Saved results are retained; the action was not automatically replayed. Reconcile with the ERP before retrying." :
        "Execution was interrupted before a new dispatch. Saved results are retained; recovery requires fresh authorization.");
}
function recordValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Scheduled report evidence is not an object result");
  return value as Record<string, unknown>;
}
function assertCoverageBeforeScheduledEffect(run: Execution, plan: CompiledOperationPlan, live: readonly ToolDefinition[], effectIndex: number): void {
  const source = run.scheduleSource;
  if (!source) return;
  const effectId = plan.ir.root.nodes[effectIndex]?.id;
  const evidence = effectId ? scheduledReportPaths(plan, live, source.reportWindowBinding).get(effectId) : undefined;
  const scheduledReads = evidence ? selectScheduledReportEvidence(evidence, run.readProgress!) : undefined;
  if (!scheduledReads?.length) throw new Error("Scheduled effects require prior confirmed in-scope report coverage");
  const receipts = run.reportCoverages ?? (run.reportCoverage ? { [run.reportCoverage.nodeId]: run.reportCoverage } : {});
  const requiredReceipts: ReportCoverageReceipt[] = [];
  for (const { node, tool } of scheduledReads) {
    const receipt = receipts[node.id];
    if (!receipt || !tool?.report_coverage_contract || tool.tool_id !== receipt.toolId || node.capability.contractHash !== receipt.contractHash)
      throw new Error("Scheduled report coverage no longer matches the reviewed read contract");
    const args = resolveReadBinding(node.inputs, operationValueState(run, plan.ir.flow, node.id)) as Record<string, unknown>;
    assertScheduledReportCoverageReceipt(receipt, { tool, nodeId: node.id, contractHash: node.capability.contractHash, args,
      output: recordValue(run.stepOutputs?.[node.id]), startAt: source.reportWindow.startAt, endAt: source.reportWindow.endAt });
    requiredReceipts.push(receipt);
  }
  const projected = requiredReceipts.filter(receipt => receipt.relatedRecords?.mode === "PROJECTED");
  const matched = requiredReceipts.filter(receipt => receipt.relatedRecords?.mode === "REQUESTED_MATCHED");
  if (projected.length || matched.length) {
    if (projected.length !== 1 || matched.length !== 1 || projected[0]!.relatedRecords!.relationName !== matched[0]!.relatedRecords!.relationName ||
        projected[0]!.relatedRecords!.keysHash !== matched[0]!.relatedRecords!.keysHash ||
        projected[0]!.relatedRecords!.keyCount !== matched[0]!.relatedRecords!.keyCount)
      throw new Error("Scheduled related-record coverage is missing or inconsistent");
  }
}
/** Separate fair, bounded single-writer operation worker. Waits hold no worker
 * or HTTP/DB transaction; restart never automatically replays an intent. */
export class OperationJobQueue {
  readonly #workerId = `operation-worker-${randomBytes(16).toString("hex")}`;
  readonly #active = new Map<string, Active>();
  readonly #unsubscribe: () => void;
  #closed = false; #started = false; #pumping = false; #repump = false; #stalled = false; #lastActor = "";
  #waitTimer: NodeJS.Timeout | undefined;
  get closed() { return this.#closed; }
  constructor(readonly services: HandlerServices) {
    bindExecutionHost(services.repository);
    if (!supportsOperationJobs(services)) throw new HandlerFailure(503, "Operations require qualified encrypted scoped persistence", { code: "OPERATION_STORAGE_UNSUPPORTED" });
    this.#unsubscribe = services.repository.observeCommits({ committed: state => { this.observe(state); this.scheduleWaitExpiry(state);
      if (Object.values(state.executions).some(run => run.operationSecret?.state === "QUEUED" && run.status === "PENDING")) this.kick();
    }, unavailable: () => {
      this.#stalled = true; for (const control of this.#active.values()) { control.valid = false; control.controller.abort(new Error("Operation storage authority unavailable")); }
    } });
  }
  private scheduleWaitExpiry(state: Readonly<RepositoryState>) {
    if (this.#waitTimer) clearTimeout(this.#waitTimer); this.#waitTimer = undefined;
    if (!this.#started || this.#closed || this.#stalled) return;
    const deadlines = Object.values(state.executions).filter(run => run.status === "AWAITING_APPROVAL" && run.operationSecret?.state === "WAITING")
      .map(run => Date.parse(run.runtimeApprovalSecret?.records[run.runtimeApprovalSecret.activeId]?.expiresAt ?? "")).filter(Number.isFinite);
    if (!deadlines.length) return;
    this.#waitTimer = setTimeout(() => { void this.expireWaits().catch(() => { this.#stalled = true; }); }, Math.max(1, Math.min(...deadlines) - Date.now())); this.#waitTimer.unref();
  }
  private async expireWaits() {
    return this.expireApprovals(Date.now(), 100, () => this.services.repository.assertAuthority());
  }
  async expireWaitingApprovalInvocation(scope: WorkflowLifecycleScope) {
    const assertReady = () => { assertWorkflowLifecycleScope(this.services.repository, scope); if (this.#closed || this.#stalled) throw new Error("Operation expiry owner is unavailable"); };
    assertReady(); return this.expireApprovals(scope.nowMs, scope.expiryLimit, assertReady);
  }
  private async expireApprovals(nowMs: number, limit: number, assertReady: () => void) {
    assertReady();
    const ids = await this.services.repository.readAuthoritative(state => Object.values(state.executions).filter(run => run.status === "AWAITING_APPROVAL" && run.operationSecret?.state === "WAITING" &&
      Date.parse(run.runtimeApprovalSecret?.records[run.runtimeApprovalSecret.activeId]?.expiresAt ?? "") <= nowMs)
      .sort((a,b) => a.runtimeApprovalSecret!.records[a.runtimeApprovalSecret!.activeId]!.expiresAt.localeCompare(b.runtimeApprovalSecret!.records[b.runtimeApprovalSecret!.activeId]!.expiresAt) || a.id.localeCompare(b.id)).slice(0, limit).map(run => run.id));
    assertReady(); let expired = 0;
    for (const id of ids) {
      assertReady();
      const changed = await this.services.repository.mutateExecution(id, state => {
      assertReady();
      const run = state.executions[id]!;
      if (run.status !== "AWAITING_APPROVAL" || run.operationSecret?.state !== "WAITING") return false;
      const record = runtimeApprovalEvidence(run, run.runtimeApprovalSecret!.activeId);
      if (Date.parse(record.expiresAt) > nowMs) return false;
      if (record.state !== "PENDING" || run.operationSecret.lease || record.binding.executionId !== run.id || record.binding.workflowId !== run.workflowId ||
          record.binding.nodeId !== run.pendingApproval?.stepId || nowMs < Date.parse(record.requestedAt) ||
          Object.values(run.operationSecret.intents).some(intent => intent.invocationId === record.binding.invocationId))
        throw new Error("Approval expiry cannot certify an unconfirmed or dispatched action");
      delete run.pendingApproval; run.failure = { failureCategory: "RUNTIME_APPROVAL_EXPIRED", failedStepId: record.binding.nodeId };
      appendExecutionEvent(state, run, "approval.expired", { approvalId: record.id, version: record.version, reviewHash: record.reviewHash, expiresAt: record.expiresAt }, record.binding.nodeId, record.binding.invocationId);
      finish(state, run, "FAILED", "The exact approval expired before dispatch. Previous saved results remain available; no automatic operation replay occurred.");
      assertReady(); return true;
      });
      assertReady(); if (changed) expired++;
    }
    return expired;
  }
  private observe(state: Readonly<RepositoryState>) {
    for (const control of this.#active.values()) {
      try {
        const run = state.executions[control.id], job = run?.operationSecret;
        if (!run || run.status !== "RUNNING" || !job || job.state !== "CLAIMED" || job.lease?.id !== control.leaseId || job.lease.workerId !== this.#workerId || job.lease.expiresAt <= Date.now() || run.readProgress?.cancellation || state.users[job.actorId]?.roleId !== job.roleId) throw new Error("Operation claim changed");
        if (control.taskCommand) {
          const { ledger, generation } = operationTaskGeneration(run, control.taskCommand);
          if (generation.completion || ledger.generations.at(-1)!.taskId !== control.taskCommand.taskId) throw new Error("Operation task generation changed");
        }
        assertCurrentRunController(state as RepositoryState, run, job.actorId, job.admittedRole);
        const governance = operationGovernanceBinding(state.governancePolicy);
        if (control.governanceHash && control.governanceHash !== digest(governance.authority)) throw new Error("Operation governance policy changed");
        if (control.governanceExpiresAt !== undefined && governance.expiresAt !== undefined) {
          // Renewal may not extend this invocation's original authorization
          // window. A shorter current deadline immediately fences dispatch.
          control.governanceExpiresAt = Math.min(control.governanceExpiresAt, governance.expiresAt);
          if (Date.now() >= control.governanceExpiresAt) throw new Error("Operation governance policy expired");
        }
        const snapshot = run.workflowSnapshot!, publication = state.versions[run.workflowId]?.findLast(item => item.version === snapshot.version && item.artifactState === "PUBLISHED");
        if (!publication || publication.yaml !== snapshot.yaml) throw new Error("Operation publication changed");
        const compiled = prepareOperationExecution(state, this.services, publication, snapshot.yaml, job.admittedRole, snapshot.operationCompilation);
        if (compiled.plan.ir.schemaVersion === "workflow-operation-ir/v8") {
          assertProtectedCheckpointOwnership(state as RepositoryState, run, compiled.plan, { leaseId: control.leaseId, epoch: run.readProgress!.epoch });
          assertConfirmedOperationResults(state as RepositoryState, run, compiled.plan);
          confirmedProtectedOperationTransition(state as RepositoryState, run, compiled.plan);
        }
        const active = run.runtimeApprovalSecret?.records[run.runtimeApprovalSecret.activeId];
        if (active?.state === "CONSUMED" && run.readProgress?.attempts[active.binding.nodeId]?.status === "DISPATCH_INTENT") assertConsumedRuntimeApproval(state as RepositoryState, run.id, active.consumption!.intentId);
        control.valid = true; control.expiresAt = job.lease.expiresAt;
      } catch { control.valid = false; control.controller.abort(new Error("Current operation authorization changed")); }
    }
  }
  private assert(control: Active) {
    this.services.repository.assertAuthority();
    if (this.#closed || this.#stalled || !control.valid || control.controller.signal.aborted || Date.now() >= control.expiresAt ||
        control.governanceExpiresAt !== undefined && Date.now() >= control.governanceExpiresAt ||
        control.deadlineAt !== undefined && Date.now() >= control.deadlineAt) throw new Error("Operation worker is fenced");
  }
  /** Identity evidence only; no compilation, model/tool entry or admission. */
  findAdmission(state: Readonly<RepositoryState>, workflowId: string, actorId: string, key: string): Execution | null {
    const scope = digest(["operation/v1", actorId, workflowId, key]);
    const runs = Object.values(state.executions).filter(run => run.operationSecret?.idempotencyScope === scope);
    if (!runs.length) return null;
    const run = runs[0]!;
    if (runs.length !== 1 || run.operationSecret?.actorId !== actorId || run.startedBy.id !== actorId || run.workflowId !== workflowId)
      throw new HandlerFailure(409, "Operation admission identity is inconsistent");
    return run;
  }
  async admit(workflow: Workflow, rawInput: Record<string, unknown>, user: CurrentUser, key: string, traceId: string,
    source?: { profile: "workflow-schedule-source/v1"; scheduleId: string; scheduleRevision: number; occurrenceId: string; scheduledFor: string;
      scheduleHash: string; reportWindow: ReportWindow; reportWindowBinding: ReportWindowInputBinding; inputHash: string }, lifecycleScope?: WorkflowLifecycleScope, retry?: ExecutionRetryRequest) {
    const assertLifecycle = () => { if (lifecycleScope) assertWorkflowLifecycleScope(this.services.repository, lifecycleScope); };
    assertLifecycle();
    requireOperationTaskAdmission(this.services.repository);
    if (workflow.recoverySource) throw new HandlerFailure(409, "Linked recovery workflows can only be admitted once through their exact source artifact", { code: "RECOVERY_ARTIFACT_ADMISSION_REQUIRED" });
    if (workflow.emailDeliverySource) throw new HandlerFailure(409, "Linked email-delivery workflows can only be admitted once from their exact reviewed draft", { code: "EMAIL_DELIVERY_ADMISSION_REQUIRED" });
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) throw new HandlerFailure(422, "Operation runs require a stable 16–128 character idempotency key", { code: "OPERATION_KEY_REQUIRED" });
    const input = structuredClone(rawInput);
    if (canonicalJSONBytes(input).length > 64000) throw new HandlerFailure(422, "Operation input exceeds supported bounds");
    // Stable through credential/key rotation. The private scope is an identity,
    // not dispatch authority or an upstream idempotency promise.
    const scope = digest(["operation/v1", user.id, workflow.id, key]);
    const fingerprint = digest({ sourceHash: workflowContentHash(workflow.yaml), version: workflow.publishedVersion, input, source: source ?? null, ...(retry ? { retry } : {}) });
    const result = await this.services.repository.mutate(state => {
      assertLifecycle();
      const existing = Object.values(state.executions).find(run => run.operationSecret?.idempotencyScope === scope);
      if (existing) {
        if (existing.operationSecret!.requestFingerprint !== fingerprint) throw new HandlerFailure(409, "Operation key already belongs to different inputs or publication");
        assertCurrentRunController(state, existing, user.id, user.role);
        assertLifecycle(); return { execution: publicExecution(existing), replayed: true };
      }
      const current = state.workflows[workflow.id], publication = state.versions[workflow.id]?.findLast(item => item.version === workflow.publishedVersion && item.artifactState === "PUBLISHED");
      const retrySource = retry ? assertExecutionRetry(state, workflow, user, retry, input).link : undefined;
      if (!current || current.archived || current.yaml !== workflow.yaml || current.publishedVersion !== workflow.publishedVersion || !publication || publication.yaml !== workflow.yaml || current.pendingGenerationApproval?.steps.length) throw new HandlerFailure(409, "A current accepted immutable operation publication is required");
      if (source) {
        const schedule = state.schedules[source.scheduleId], occurrence = state.scheduleOccurrences[source.occurrenceId];
        if (!schedule || schedule.state !== "ACTIVE" || schedule.revision !== source.scheduleRevision || schedule.scheduleHash !== source.scheduleHash ||
          schedule.workflowId !== workflow.id || schedule.workflowVersion !== workflow.publishedVersion || schedule.servicePrincipalId !== user.id ||
          !occurrence || occurrence.state !== "ADMITTING" || occurrence.scheduleId !== source.scheduleId || occurrence.scheduleRevision !== source.scheduleRevision ||
          occurrence.scheduledFor !== source.scheduledFor || canonicalJSONBytes(occurrence.reportWindow).compare(canonicalJSONBytes(source.reportWindow)) !== 0 ||
          canonicalJSONBytes(schedule.reportWindowBinding).compare(canonicalJSONBytes(source.reportWindowBinding)) !== 0 || digest(input) !== source.inputHash)
          throw new HandlerFailure(409, "Schedule or occurrence changed before final admission", { code: "SCHEDULE_ADMISSION_CHANGED" });
      }
      const compiled = prepareOperationExecution(state, this.services, publication, workflow.yaml, user.role);
      if (compiled.plan.ir.inputSchema && validateToolInput(compiled.plan.ir.inputSchema, input).length) throw new HandlerFailure(422, "Operation input does not match its schema");
      const analysisNodes = compiled.plan.ir.root.nodes.filter(node => node.kind === "analysis");
      const agentNodes = compiled.plan.ir.root.nodes.filter(node => node.kind === "agent");
      let analysisProvider: NonNullable<Execution["operationSecret"]>["analysisProvider"];
      let agentProvider: NonNullable<Execution["operationSecret"]>["agentProvider"];
      if (analysisNodes.length) {
        const runtime = this.services.providerRuntime, configuration = runtime?.configuration, binding = runtime?.binding;
        if (!runtime?.configured || !configuration || !binding || binding.providerId !== configuration.id)
          throw new HandlerFailure(503, "A configured model provider is required for durable analysis nodes", { code: "ANALYSIS_PROVIDER_REQUIRED" });
        try {
          for (const node of analysisNodes) {
            runtime.snapshot(node.model || configuration.model);
            assertRuntimeAnalysisEgress(configuration.egressPolicy!, configuration.baseURL, node.dataClass);
          }
        } catch (error) { throw new HandlerFailure(422, error instanceof Error ? error.message : "Durable analysis provider admission failed", { code: "ANALYSIS_PROVIDER_DENIED" }); }
        analysisProvider = { configuration: structuredClone(configuration), configurationRevision: binding.configurationRevision };
      }
      if (agentNodes.length) {
        const runtime = this.services.providerRuntime, configuration = runtime?.configuration, binding = runtime?.binding;
        if (!runtime?.configured || !configuration || !binding || binding.providerId !== configuration.id)
          throw new HandlerFailure(503, "A configured model provider is required for durable agent nodes", { code: "AGENT_PROVIDER_REQUIRED" });
        try {
          for (const node of agentNodes) {
            runtime.snapshot(node.model || configuration.model);
            assertRuntimeAgentEgress(configuration.egressPolicy!, configuration.baseURL, node.dataClass);
          }
        } catch (error) { throw new HandlerFailure(422, error instanceof Error ? error.message : "Durable agent provider admission failed", { code: "AGENT_PROVIDER_DENIED" }); }
        agentProvider = { configuration: structuredClone(configuration), configurationRevision: binding.configurationRevision };
      }
      // Model egress has separate authority. Require the write-approval policy
      // only when this immutable publication actually contains an effect.
      if (compiled.plan.ir.root.nodes.some(node => node.kind === "action" && node.effectClass !== "read")) runtimeApprovalPolicyHash(state, user.id);
      const id = `operation-${randomBytes(16).toString("hex")}`, now = new Date().toISOString();
      const run: Execution = { id, workflowId: workflow.id, workflowName: workflow.name, status: "PENDING", startedAt: now, completedAt: null, durationMs: 0,
        ...(this.services.userMcpCredentials ? { erpCredentialSecret: captureUserMcpBinding(this.services, state, user.id)! } : {}),
        startedBy: { id: user.id, name: user.name }, tokens: { input: 0, output: 0, total: 0 }, costUsd: 0, traceId,
        // This run uses today's policy registry; the immutable compilation
        // receipt separately retains the registry observed at publication.
        workflowSnapshot: { yaml: workflow.yaml, version: workflow.publishedVersion, contentHash: compiled.plan.sourceHash, registryHash: this.services.registries.hash(), input,
          executionProfile: "sequential-operation-v1", operationCompilation: compiled.receipt }, readProgress: newReadProgress(this.services.repository), stepOutputs: {},
        operationSecret: { profile: "operation-job/v1", actorId: user.id, roleId: state.users[user.id]!.roleId, admittedRole: user.role, state: "QUEUED", idempotencyScope: scope, requestFingerprint: fingerprint, createdAt: now, intents: {},
          ...(analysisProvider ? { analysisProvider } : {}), ...(agentProvider ? { agentProvider } : {}) },
        ...(source ? { scheduleSource: structuredClone(source) } : {}),
        ...(retrySource ? { retrySource } : {}),
        agentSummary: compiled.plan.ir.root.nodes.some(node => node.kind === "action" && node.effectClass !== "read")
          ? "Operation queued. Each write requires an independent exact approval; nothing is confirmed by queue admission."
          : "Read-and-model workflow queued. Model and tool results require saved acknowledgements; no ERP write or notification is in this publication." };
      assertCurrentRunController(state, run, user.id, user.role);
      state.executions[id] = run; state.timelines[id] = []; state.executionEvents[id] = []; state.executionLogs[id] = [];
      appendExecutionEvent(state, run, "run.queued", { profile: "operation-job/v1", persistence: run.readProgress!.persistence }); audit(state, run, "execution.queued");
      if (retrySource) appendExecutionEvent(state, run, "run.retry_queued", { sourceExecutionId: retrySource.sourceExecutionId, freshApprovalRequired: true });
      if (!residentExecutionAllowed(this.services.repository)) prepareOperationTaskGeneration(run);
      assertLifecycle(); return { execution: publicExecution(run), replayed: false };
    });
    assertLifecycle();
    if (!residentExecutionAllowed(this.services.repository)) {
      const taskDispatch = await dispatchOperationTaskOutbox(this.services.repository, String(result.execution.id));
      assertLifecycle(); return { ...result, taskDispatch };
    }
    this.kick(); return result;
  }
  /** One private original generation, never a browser supplied continuation or
   * approval. Delivery may stop at an acknowledged wait, not business success. */
  async executeTask(raw: unknown, options: { timeoutMs: number; signal?: AbortSignal }) {
    const repository = this.services.repository, command = operationTaskCommandSchema.parse(raw);
    if (residentExecutionAllowed(repository) || this.#closed || this.#stalled) throw new Error("Operation tasks require an available bounded owner");
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 100 || options.timeoutMs > Math.min(240_000, this.services.config.readWorkerLeaseMs - 100)) throw new Error("Operation task deadline must fit inside its fixed lease");
    const initial = await repository.readAuthoritative(state => {
      const run = state.executions[command.executionId]; if (!run) throw new Error("Original operation is unavailable");
      const { generation } = operationTaskGeneration(run, command);
      if (!generation.completion && run.operationSecret!.state === "QUEUED") assertOperationTaskReady(state, run, command);
      return { run: structuredClone(run), completed: !!generation.completion };
    });
    const receipt = () => repository.readAuthoritative(state => operationTaskReceipt(state, state.executions[command.executionId]!, command));
    if (initial.completed) return receipt();
    const retireOriginal = async (lease: NonNullable<NonNullable<Execution["operationSecret"]>["lease"]>) => {
      await repository.mutateExecution(command.executionId, state => {
        const run = state.executions[command.executionId]!; operationTaskGeneration(run, command);
        if (run.status !== "RUNNING" || run.operationSecret?.lease?.id !== lease.id || run.operationSecret.lease.workerId !== lease.workerId) return;
        recover(state, run, "OPERATION_TASK_INTERRUPTED");
      });
    };
    if (initial.run.operationSecret!.state === "CLAIMED") {
      const lease = initial.run.operationSecret!.lease;
      if (!lease || Date.now() < lease.expiresAt) throw new Error("Original operation claim is live; retry its original task after expiry");
      await retireOriginal(lease);
    } else if (initial.run.operationSecret!.state === "QUEUED") {
      if (this.#active.size || options.signal?.aborted) throw new Error("Operation task owner is busy or cancelled");
      const control: Active = { id: command.executionId, actorId: initial.run.operationSecret!.actorId, leaseId: randomBytes(16).toString("hex"),
        controller: new AbortController(), valid: false, expiresAt: Date.now() + this.services.config.readWorkerLeaseMs, taskCommand: command,
        deadlineAt: Date.now() + options.timeoutMs };
      const expire = () => { control.valid = false; control.controller.abort(); };
      options.signal?.addEventListener("abort", expire, { once: true }); this.#active.set(control.id, control);
      try {
        control.task = boundedOperation(() => this.process(control), { timeoutMs: options.timeoutMs, signal: control.controller.signal,
          label: "Operation task processing", onAbandon: expire });
        try { await control.task; } catch { expire(); await retireOriginal({ id: control.leaseId, workerId: this.#workerId, expiresAt: control.expiresAt }); }
      } finally { options.signal?.removeEventListener("abort", expire); expire(); this.#active.delete(control.id); }
    }
    await repository.mutateExecution(command.executionId, state => {
      const run = state.executions[command.executionId]!;
      if (["DONE", "AWAITING_APPROVAL"].includes(run.status)) {
        const snapshot = run.workflowSnapshot!, publication = state.versions[run.workflowId]?.findLast(value => value.version === snapshot.version && value.yaml === snapshot.yaml && value.artifactState === "PUBLISHED");
        const compiled = publication?.compiledOperation as { plan?: CompiledOperationPlan; receipt?: unknown } | undefined;
        if (!compiled?.plan || !canonicalJSONBytes(compiled.receipt).equals(canonicalJSONBytes(snapshot.operationCompilation))) throw new Error("Original operation compilation receipt changed");
        assertConfirmedOperationResults(state, run, compiled.plan);
      }
      const completion = completeOperationTaskGeneration(state, run, command);
      if (completion.milestone === "CONTINUATION") prepareOperationTaskGeneration(run);
    });
    const result = await receipt();
    if (result.milestone === "CONTINUATION") await dispatchOperationTaskOutbox(repository, command.executionId);
    return result;
  }
  async start() {
    requireResidentExecution(this.services.repository);
    if (this.#started || this.#closed) return; this.#started = true;
    const jobs = await this.services.repository.read(state => Object.values(state.executions).filter(run => run.operationSecret && !run.operationSecret.taskDispatchSecret).map(run => ({ id: run.id, state: run.operationSecret!.state })));
    for (const { id } of jobs.filter(job => job.state === "CLAIMED")) await this.services.repository.mutateExecution(id, state => recover(state, state.executions[id]!, "OPERATION_WORKER_RESTARTED"));
    if (jobs.some(job => job.state === "WAITING")) await this.services.repository.readAuthoritative(state => this.scheduleWaitExpiry(state));
    if (jobs.some(job => job.state === "QUEUED")) this.kick();
  }
  kick() {
    if (!residentExecutionAllowed(this.services.repository) || !this.#started || this.#closed || this.#stalled) return;
    if (this.#pumping) { this.#repump = true; return; }
    void this.pump().catch(() => { this.#stalled = true; });
  }
  private async pump() {
    if (!residentExecutionAllowed(this.services.repository)) return;
    this.#pumping = true;
    try {
      while (!this.#closed && !this.#stalled && this.#active.size < this.services.config.readWorkerConcurrency) {
        const id = await this.services.repository.readAuthoritative(state => {
          const counts = new Map<string, number>(); for (const c of this.#active.values()) counts.set(c.actorId, (counts.get(c.actorId) ?? 0) + 1);
          const pending = Object.values(state.executions).filter(run => !run.operationSecret?.taskDispatchSecret && run.status === "PENDING" && run.operationSecret?.profile === "operation-job/v1" && run.operationSecret.state === "QUEUED" && !this.#active.has(run.id) && (counts.get(run.operationSecret.actorId) ?? 0) < this.services.config.readWorkerPerActor)
            .sort((a, b) => a.operationSecret!.createdAt.localeCompare(b.operationSecret!.createdAt) || a.id.localeCompare(b.id));
          return pending.find(run => run.operationSecret!.actorId !== this.#lastActor)?.id ?? pending[0]?.id;
        });
        if (!id) break;
        const actorId = await this.services.repository.readAuthoritative(state => state.executions[id]!.operationSecret!.actorId);
        const control: Active = { id, actorId, leaseId: randomBytes(16).toString("hex"), controller: new AbortController(), valid: false, expiresAt: 0 };
        this.#active.set(id, control); this.#lastActor = actorId;
        control.task = this.process(control).catch(() => {}).finally(() => { if (control.timer) clearInterval(control.timer); this.#active.delete(id); this.kick(); });
      }
    } finally { this.#pumping = false; if (this.#repump) { this.#repump = false; this.kick(); } }
  }
  private async process(control: Active) {
    const expected = await this.services.repository.readAuthoritative(state => state.executions[control.id]?.erpCredentialSecret);
    return withUserMcpBinding(this.services, control.actorId, expected, () => this.processBound(control));
  }
  private async processBound(control: Active) {
    const { services } = this, repository = services.repository, id = control.id;
    let executingPlan: CompiledOperationPlan | undefined, executingEpoch: number | undefined;
    let knownCoverageFailure: { nodeId: string; intentKey: string; intentId: string; output: Record<string, unknown>; message: string } | undefined;
    let knownAnalysisFailure: { nodeId: string; intentId: string; message: string; inputTokens: number; outputTokens: number } | undefined;
    let knownAgentFailure: { nodeId: string; code: string; message: string } | undefined;
    let knownReadFailure: { nodeId: string; intentKey: string; intentId: string; argumentHash: string; output: Record<string, unknown>; businessFailure?: ReviewedReadBusinessFailure } | undefined;
    const captureReadFailure = async (nodeId: string, intentKey: string, intentId: string, args: Record<string, unknown>, tool: ToolDefinition, call: Promise<Record<string, unknown>>) => {
      try { return await call; }
      catch (error) {
        const failure = acknowledgedReadToolFailure(error);
        if (failure) knownReadFailure = { nodeId, intentKey, intentId, argumentHash: digest(args), output: protectedReportPageOutput(tool, failure.result),
          ...(failure.businessFailure ? { businessFailure: failure.businessFailure } : {}) };
        throw error;
      }
    };
    try {
      const initial = await repository.mutateExecution(id, state => {
        const run = state.executions[id]!, job = run.operationSecret!;
        if (run.status !== "PENDING" || job.state !== "QUEUED") throw new Error("Operation is not queued");
        if (control.taskCommand) assertOperationTaskReady(state, run, control.taskCommand);
        else if (job.taskDispatchSecret) throw new Error("Resident worker cannot claim a task-owned operation");
        const denied = operationClaimDenial(state, run);
        if (denied) { finish(state, run, denied.status, denied.summary); return undefined; }
        run.status = "RUNNING"; job.state = "CLAIMED"; job.lease = { id: control.leaseId, workerId: this.#workerId,
          expiresAt: control.taskCommand ? control.expiresAt : Date.now() + services.config.readWorkerLeaseMs };
        appendExecutionEvent(state, run, "run.started", { profile: "operation-job/v1" }); return structuredClone(run);
      });
      if (!initial) return;
      this.assert(control);
      if (!control.taskCommand) { control.timer = setInterval(() => { void repository.mutateExecution(id, state => {
        this.assert(control); const run = state.executions[id]!; if (run.operationSecret?.lease?.id !== control.leaseId) throw new Error("Operation lease changed");
        run.operationSecret.lease.expiresAt = Date.now() + services.config.readWorkerLeaseMs;
      }).catch(() => { control.valid = false; control.controller.abort(); }); }, Math.max(1000, Math.floor(services.config.readWorkerLeaseMs / 3))); control.timer.unref(); }
      const snapshot = initial.workflowSnapshot!, actor = await repository.effectiveUser(control.actorId);
      if (!actor || actor.role !== initial.operationSecret!.admittedRole) throw new Error("Operation actor changed");
      const plan = await repository.readAuthoritative(state => {
        control.governanceHash = digest(operationGovernanceBinding(state.governancePolicy).authority);
        const publication = state.versions[initial.workflowId]?.findLast(item => item.version === snapshot.version && item.artifactState === "PUBLISHED");
        if (!publication || publication.yaml !== snapshot.yaml) throw new Error("Operation publication changed");
        return prepareOperationExecution(state, services, publication, snapshot.yaml, actor.role, snapshot.operationCompilation).plan;
      });
      executingPlan = plan; executingEpoch = initial.readProgress!.epoch;
      const protectedReadContext = plan.ir.schemaVersion === "workflow-operation-ir/v8" ?
        { protectedOperation: { plan, owner: { leaseId: control.leaseId, epoch: initial.readProgress!.epoch } } } : {};
      const connectionIds = new Set<string>();
      for (const node of plan.ir.root.nodes) {
        if (node.kind === "action" && node.capability.admission) connectionIds.add(node.capability.admission.connectionId);
        if (node.kind === "agent") for (const capability of node.allowedCapabilities) connectionIds.add(capability.admission.connectionId);
      }
      const bindings = new Map([...connectionIds].map(connectionId => { const bound = boundMcpConnection(services, connectionId); return [connectionId,
        { ...bound, generation: bound.session.discoveryGeneration ?? 0, roleMapHash: canonicalJSONBytes(bound.roleMap) }] as const; }));
      const assertContext = () => {
        this.assert(control);
        for (const [connectionId, expected] of bindings) { const current = boundMcpConnection(services, connectionId);
          if (current.session !== expected.session || current.session.available === false || expected.generation !== (current.session.discoveryGeneration ?? 0) ||
              !expected.roleMapHash.equals(canonicalJSONBytes(current.roleMap))) throw new Error("Operation connection context changed"); }
        if (snapshot.registryHash !== services.registries.hash()) throw new Error("Operation registry changed");
      };
      const liveByConnection = new Map<string, readonly ToolDefinition[]>();
      await Promise.all([...bindings].map(async ([connectionId, value]) => { liveByConnection.set(connectionId, await discoverTools(value.session, services.registries)); }));
      const live = [...new Map([...liveByConnection.values()].flatMap(tools => tools.map(tool => [tool.tool_id, tool] as const))).values()];
      assertContext();
      const gate = await validateWorkflow(services, "OperationJobWorker", snapshot.yaml, actor, { executionId: id, workflowId: initial.workflowId, traceId: initial.traceId, signal: control.controller.signal });
      if (!gate.result.passed || !gate.token) throw new Error("Operation deterministic verification failed");
      await repository.readAuthoritative(state => {
        const governance = operationGovernanceBinding(state.governancePolicy);
        if (control.governanceHash !== digest(governance.authority)) throw new Error("Operation governance policy changed during verification");
        if (governance.expiresAt !== undefined) control.governanceExpiresAt = governance.expiresAt;
      });
      this.assert(control);
      while (true) {
        const next = plan.ir.flow ? await repository.mutateExecution(id, state => {
          assertContext(); const run = state.executions[id]!;
          const next = advanceOperationDecisions(state, run, plan, { leaseId: control.leaseId, epoch: initial.readProgress!.epoch });
          if (next.kind === "failed") finish(state, run, "FAILED", "The selected control boundary has no confirmed contract-valid value. No later node or effect ran.");
          return next;
        }) : await repository.readAuthoritative(state => { const index = state.executions[id]!.readProgress!.nextStepIndex;
          return index < plan.ir.root.nodes.length ? { kind: "action" as const, index } : { kind: "complete" as const }; });
        if (next.kind === "failed") return;
        if (next.kind === "complete") break;
        const index = next.index;
        assertContext(); const node = plan.ir.root.nodes[index]!;
        if (node.kind === "agent") {
          const agentConnections = new Set(node.allowedCapabilities.map(value => value.admission.connectionId));
          if (agentConnections.size !== 1) throw new Error("A runtime-agent node must use one exact ERPBridge connection");
          const agentConnectionId = [...agentConnections][0]!, agentLive = liveByConnection.get(agentConnectionId);
          if (!agentLive) throw new Error("Runtime-agent ERPBridge connection is unavailable");
          const resolvedInput = await repository.mutateExecution(id, state => {
            this.assert(control); const run = state.executions[id]!, progress = run.readProgress!;
            if (progress.nextStepIndex !== index) throw new Error("Runtime-agent pointer changed");
            if (!progress.attempts[node.id]) {
              const startedAt = new Date().toISOString(), attemptId = `${id}:${node.id}`;
              progress.attempts[node.id] = { id: attemptId, nodeId: node.id, stepIndex: index, status: "PREPARING", startedAt };
              (state.timelines[id] ??= []).push({ id: `timeline-${node.id}`, nodeId: node.id, attemptId, label: node.description ?? `Agent ${node.id}`,
                status: "RUNNING", phase: "PREPARING", startedAt, sideEffect: false });
              appendExecutionEvent(state, run, "node.agent_preparing", { dataClass: node.dataClass, maxRounds: node.maxRounds, maxToolCalls: node.maxToolCalls }, node.id, attemptId);
            } else if (progress.attempts[node.id]!.status !== "PREPARING") throw new Error("A runtime-agent invocation cannot be replayed");
            return resolveReadBinding(node.input, operationValueState(run, plan.ir.flow, node.id));
          });
          const inputJSON = JSON.stringify(resolvedInput), itemCount = modelInputItemCount(node.input, resolvedInput);
          if (itemCount > node.maxInputItems || [...inputJSON].length > node.maxInputChars) throw new Error("Runtime-agent input exceeds its reviewed bounds");
          const captured = initial.operationSecret!.agentProvider;
          if (!captured || !services.providerRuntime) throw new Error("Captured runtime-agent provider is unavailable");
          assertRuntimeAgentEgress(captured.configuration.egressPolicy!, captured.configuration.baseURL, node.dataClass);
          const model = node.model || captured.configuration.model;
          const runtime = services.providerRuntime.restoreCaptured(captured.configuration, captured.configurationRevision).snapshot(model);
          const pendingCalls = new Map<string, { intentKey: string; intentId: string }>();
          let result;
          try {
            result = await runRuntimeAgent({ node, taskInput: resolvedInput, runtime, tools: agentLive, workflowId: initial.workflowId, executionId: id,
              actor: { id: actor.id, role: actor.role }, ...(initial.traceId ? { traceId: initial.traceId } : {}), signal: control.controller.signal,
              hooks: {
                beforeModel: async (round, messages) => {
                  const intentKey = `${node.id}:model:${round}`, intentId = `intent-${randomBytes(16).toString("hex")}`;
                  await repository.mutateExecution(id, state => {
                    assertContext(); const run = state.executions[id]!, attempt = run.readProgress!.attempts[node.id]!, current = run.operationSecret!.agentProvider;
                    const fresh = resolveReadBinding(node.input, operationValueState(run, plan.ir.flow, node.id));
                    if (attempt.status !== "PREPARING" || run.readProgress!.nextStepIndex !== index || !canonicalJSONBytes(fresh).equals(canonicalJSONBytes(resolvedInput)) ||
                        run.operationSecret!.intents[intentKey] || !current || !canonicalJSONBytes(current).equals(canonicalJSONBytes(captured)))
                      throw new Error("Runtime-agent model intent facts changed or are already used");
                    assertRuntimeAgentEgress(current.configuration.egressPolicy!, current.configuration.baseURL, node.dataClass);
                    const now = new Date().toISOString(); run.operationSecret!.intents[intentKey] = { id: intentId, nodeId: node.id,
                      invocationId: `${attempt.id}:model:${round}`, operationKey: `${id}:${node.id}:model:${round}`, dispatchKind: "agent-model",
                      argumentHash: digest({ messages, model, round, configurationRevision: current.configurationRevision }), state: "DISPATCH_INTENT", preparedAt: now };
                    attempt.status = "DISPATCH_INTENT"; attempt.dispatchIntentAt = now;
                    const entry = state.timelines[id]!.find(value => value.attemptId === attempt.id)!; entry.phase = `MODEL_${round + 1}_DISPATCH_INTENT`;
                    appendExecutionEvent(state, run, "node.agent_model_dispatch_intent", { intentId, round: round + 1, model }, node.id, attempt.id); audit(state, run, "operation.agent_model_dispatch_intent");
                  });
                },
                afterModel: async (round, turn) => {
                  const intentKey = `${node.id}:model:${round}`;
                  await repository.mutateExecution(id, state => {
                    assertContext(); const run = state.executions[id]!, attempt = run.readProgress!.attempts[node.id]!, intent = run.operationSecret!.intents[intentKey]!;
                    if (attempt.status !== "DISPATCH_INTENT" || !intent || intent.state !== "DISPATCH_INTENT") throw new Error("Runtime-agent model result does not own the current intent");
                    const now = new Date().toISOString(); intent.state = "ACKNOWLEDGED"; intent.completedAt = now; intent.evidenceMeaning = "agent-model-turn";
                    attempt.status = "PREPARING"; delete attempt.dispatchIntentAt;
                    run.tokens.input += turn.measured === true ? turn.inputTokens : 0; run.tokens.output += turn.measured === true ? turn.outputTokens : 0; run.tokens.total = run.tokens.input + run.tokens.output;
                    const entry = state.timelines[id]!.find(value => value.attemptId === attempt.id)!; entry.phase = `MODEL_${round + 1}_ACKNOWLEDGED`;
                    appendExecutionEvent(state, run, "node.agent_model_acknowledged", { intentId: intent.id, round: round + 1,
                      inputTokens: turn.measured === true ? turn.inputTokens : 0, outputTokens: turn.measured === true ? turn.outputTokens : 0,
                      proposedToolCalls: turn.toolCalls.length }, node.id, attempt.id); audit(state, run, "operation.agent_model_acknowledged");
                  });
                },
                callTool: async (capability, tool, call, round, callIndex, agentSignal) => {
                  const intentKey = `${node.id}:tool:${round}:${callIndex}`, intentId = `intent-${randomBytes(16).toString("hex")}`;
                  pendingCalls.set(`${round}:${callIndex}`, { intentKey, intentId });
                  const persistIntent = async () => repository.mutateExecution(id, state => {
                    assertContext(); const run = state.executions[id]!, attempt = run.readProgress!.attempts[node.id]!, current = run.operationSecret!.agentProvider;
                    if (attempt.status !== "PREPARING" || run.readProgress!.nextStepIndex !== index || run.operationSecret!.intents[intentKey] || !current ||
                        !canonicalJSONBytes(current).equals(canonicalJSONBytes(captured))) throw new Error("Runtime-agent tool intent facts changed or are already used");
                    const now = new Date().toISOString(); run.operationSecret!.intents[intentKey] = { id: intentId, nodeId: node.id,
                      invocationId: `${attempt.id}:tool:${round}:${callIndex}`, operationKey: `${id}:${node.id}:tool:${round}:${callIndex}`, dispatchKind: "agent-tool",
                      argumentHash: digest({ capability, arguments: call.arguments }), state: "DISPATCH_INTENT", preparedAt: now };
                    attempt.status = "DISPATCH_INTENT"; attempt.dispatchIntentAt = now;
                    const entry = state.timelines[id]!.find(value => value.attemptId === attempt.id)!; entry.phase = `TOOL_${round + 1}_${callIndex + 1}_DISPATCH_INTENT`;
                    appendExecutionEvent(state, run, "node.agent_tool_dispatch_intent", { intentId, round: round + 1, call: callIndex + 1, action: capability.action }, node.id, attempt.id);
                    audit(state, run, "operation.agent_tool_dispatch_intent");
                  });
                  return captureReadFailure(node.id, intentKey, intentId, { capability, arguments: call.arguments }, tool, dispatchReadTool(services, actor.id, capability.action, call.arguments, { workflowId: initial.workflowId, executionId: id,
                    signal: agentSignal, assertDispatch: assertContext, beforeDispatch: persistIntent,
                    dynamicPlan: { admissionPin: capability.admission, contractHash: capability.contractHash, toolId: tool.tool_id } }));
                },
                afterTool: async (capability, _call, output, round, callIndex) => {
                  const pending = pendingCalls.get(`${round}:${callIndex}`); if (!pending) throw new Error("Runtime-agent tool result has no private intent");
                  await repository.mutateExecution(id, state => {
                    assertContext(); const run = state.executions[id]!, attempt = run.readProgress!.attempts[node.id]!, intent = run.operationSecret!.intents[pending.intentKey]!;
                    if (attempt.status !== "DISPATCH_INTENT" || !intent || intent.id !== pending.intentId || intent.state !== "DISPATCH_INTENT")
                      throw new Error("Runtime-agent tool result does not own the current intent");
                    const now = new Date().toISOString(); intent.state = "ACKNOWLEDGED"; intent.completedAt = now; intent.evidenceMeaning = "agent-tool-result";
                    attempt.status = "PREPARING"; delete attempt.dispatchIntentAt;
                    const entry = state.timelines[id]!.find(value => value.attemptId === attempt.id)!; entry.phase = `TOOL_${round + 1}_${callIndex + 1}_ACKNOWLEDGED`;
                    appendExecutionEvent(state, run, "node.agent_tool_acknowledged", { intentId: intent.id, round: round + 1, call: callIndex + 1,
                      action: capability.action, resultHash: digest(withoutSecretFields(output)) }, node.id, attempt.id); audit(state, run, "operation.agent_tool_acknowledged");
                  });
                  pendingCalls.delete(`${round}:${callIndex}`);
                },
              } });
          } catch (error) {
            if (error instanceof RuntimeAgentKnownFailure) knownAgentFailure = { nodeId: node.id, code: error.code, message: error.message };
            throw error;
          }
          await repository.mutateExecution(id, state => {
            assertContext(); const run = state.executions[id]!, attempt = run.readProgress!.attempts[node.id]!;
            if (attempt.status !== "PREPARING" || run.readProgress!.nextStepIndex !== index) throw new Error("Runtime-agent completion does not own the current node");
            const finalIntent = run.operationSecret!.intents[`${node.id}:model:${result.rounds - 1}`];
            if (!finalIntent || finalIntent.state !== "ACKNOWLEDGED") throw new Error("Runtime-agent completion lacks an acknowledged final model turn");
            finalIntent.evidenceMeaning = "agent-structured-output";
            const now = new Date().toISOString(); attempt.status = "DONE"; attempt.completedAt = now;
            run.stepOutputs![node.id] = { structuredContent: structuredClone(result.output) }; run.readProgress!.nextStepIndex++;
            const entry = state.timelines[id]!.find(value => value.attemptId === attempt.id)!;
            Object.assign(entry, { status: "DONE", phase: "COMPLETE", outcome: "AGENT_STRUCTURED_OUTPUT", completedAt: now,
              durationMs: Math.max(0, Date.parse(now) - Date.parse(attempt.startedAt)), output: { structuredContent: structuredClone(result.output) } });
            appendExecutionEvent(state, run, "node.agent_completed", { outcome: "AGENT_STRUCTURED_OUTPUT", rounds: result.rounds, toolCalls: result.toolCalls,
              inputTokens: result.inputTokens, outputTokens: result.outputTokens, latencyMs: result.latencyMs }, node.id, attempt.id); audit(state, run, "operation.agent_completed");
          });
          continue;
        }
        if (node.kind === "analysis") {
          const resolvedInput = await repository.mutateExecution(id, state => {
            this.assert(control); const run = state.executions[id]!, progress = run.readProgress!;
            if (progress.nextStepIndex !== index) throw new Error("Analysis pointer changed");
            if (!progress.attempts[node.id]) {
              const startedAt = new Date().toISOString(), attemptId = `${id}:${node.id}`;
              progress.attempts[node.id] = { id: attemptId, nodeId: node.id, stepIndex: index, status: "PREPARING", startedAt };
              (state.timelines[id] ??= []).push({ id: `timeline-${node.id}`, nodeId: node.id, attemptId, label: node.description ?? `Analyse ${node.id}`,
                status: "RUNNING", phase: "PREPARING", startedAt, sideEffect: false });
              appendExecutionEvent(state, run, "node.analysis_preparing", { dataClass: node.dataClass }, node.id, attemptId);
            } else if (progress.attempts[node.id]!.status !== "PREPARING") throw new Error("An analysis invocation cannot be replayed");
            return resolveReadBinding(node.input, operationValueState(run, plan.ir.flow, node.id));
          });
          const inputJSON = JSON.stringify(resolvedInput), itemCount = modelInputItemCount(node.input, resolvedInput);
          if (itemCount > node.maxInputItems || [...inputJSON].length > node.maxInputChars) throw new Error("Analysis input exceeds its reviewed bounds");
          const captured = initial.operationSecret!.analysisProvider;
          if (!captured || !services.providerRuntime) throw new Error("Captured analysis provider is unavailable");
          assertRuntimeAnalysisEgress(captured.configuration.egressPolicy!, captured.configuration.baseURL, node.dataClass);
          const model = node.model || captured.configuration.model;
          const runtime = services.providerRuntime.restoreCaptured(captured.configuration, captured.configurationRevision).snapshot(model);
          const prompt = promptData({ INSTRUCTION: node.instruction, OUTPUT_SCHEMA: node.outputSchema, INPUT: resolvedInput });
          const intentId = `intent-${randomBytes(16).toString("hex")}`;
          await repository.mutateExecution(id, state => {
            assertContext(); const run = state.executions[id]!, attempt = run.readProgress!.attempts[node.id]!, current = run.operationSecret!.analysisProvider;
            const fresh = resolveReadBinding(node.input, operationValueState(run, plan.ir.flow, node.id));
            if (attempt.status !== "PREPARING" || run.readProgress!.nextStepIndex !== index || !canonicalJSONBytes(fresh).equals(canonicalJSONBytes(resolvedInput)) ||
                run.operationSecret!.intents[node.id] || !current || !canonicalJSONBytes(current).equals(canonicalJSONBytes(captured)))
              throw new Error("Analysis intent facts changed or are already used");
            assertRuntimeAnalysisEgress(current.configuration.egressPolicy!, current.configuration.baseURL, node.dataClass);
            const now = new Date().toISOString(); run.operationSecret!.intents[node.id] = { id: intentId, nodeId: node.id, invocationId: attempt.id, dispatchKind: "analysis",
              operationKey: `${id}:${node.id}`, argumentHash: digest({ input: resolvedInput, instruction: node.instruction, outputSchema: node.outputSchema,
                dataClass: node.dataClass, model, maxOutputTokens: node.maxOutputTokens, configurationRevision: current.configurationRevision }), state: "DISPATCH_INTENT", preparedAt: now };
            attempt.status = "DISPATCH_INTENT"; attempt.dispatchIntentAt = now;
            const entry = state.timelines[id]!.find(value => value.attemptId === attempt.id)!; entry.phase = "MODEL_DISPATCH_INTENT";
            appendExecutionEvent(state, run, "node.analysis_dispatch_intent", { intentId, dataClass: node.dataClass, model }, node.id, attempt.id);
            audit(state, run, "operation.analysis_dispatch_intent");
          });
          assertContext();
          const response = await runtime.generate(prompt, ANALYSIS_PROMPT_VERSION, control.controller.signal, model,
            { workflowId: initial.workflowId, executionId: id, ...(initial.traceId ? { traceId: initial.traceId } : {}), actor: { id: actor.id, role: actor.role },
              maxOutputTokens: node.maxOutputTokens, egress: { purpose: "runtime_analysis", dataClass: node.dataClass } });
          let safeOutput: Record<string, unknown>;
          try {
            const decoded: unknown = JSON.parse(response.text), redacted = withoutSecretFields(decoded);
            const errors = validateValue(node.outputSchema, redacted);
            if (errors.length || !redacted || typeof redacted !== "object" || Array.isArray(redacted) || canonicalJSONBytes(redacted).length > 1_000_000)
              throw new Error(errors.join("; ") || "Analysis output exceeds supported bounds");
            safeOutput = redacted as Record<string, unknown>;
          } catch (error) {
            knownAnalysisFailure = { nodeId: node.id, intentId, message: error instanceof Error ? error.message : "Analysis output is invalid",
              inputTokens: response.measured ? response.inputTokens : 0, outputTokens: response.measured ? response.outputTokens : 0 };
            throw error;
          }
          await repository.mutateExecution(id, state => {
            assertContext(); const run = state.executions[id]!, attempt = run.readProgress!.attempts[node.id]!, intent = run.operationSecret!.intents[node.id]!;
            if (attempt.status !== "DISPATCH_INTENT" || intent.id !== intentId || intent.state !== "DISPATCH_INTENT") throw new Error("Analysis result does not own the current intent");
            assertRuntimeAnalysisEgress(run.operationSecret!.analysisProvider!.configuration.egressPolicy!, run.operationSecret!.analysisProvider!.configuration.baseURL, node.dataClass);
            const now = new Date().toISOString(); intent.state = "ACKNOWLEDGED"; intent.completedAt = now; intent.evidenceMeaning = "analysis-structured-output";
            attempt.status = "DONE"; attempt.completedAt = now; run.stepOutputs![node.id] = { structuredContent: structuredClone(safeOutput) };
            run.tokens.input += response.measured ? response.inputTokens : 0; run.tokens.output += response.measured ? response.outputTokens : 0;
            run.tokens.total = run.tokens.input + run.tokens.output; run.readProgress!.nextStepIndex++;
            const entry = state.timelines[id]!.find(value => value.attemptId === attempt.id)!;
            Object.assign(entry, { status: "DONE", phase: "COMPLETE", outcome: "ANALYSIS_STRUCTURED_OUTPUT", completedAt: now,
              durationMs: Math.max(0, Date.parse(now) - Date.parse(attempt.startedAt)), output: { structuredContent: structuredClone(safeOutput) } });
            appendExecutionEvent(state, run, "node.analysis_completed", { intentId, outcome: "ANALYSIS_STRUCTURED_OUTPUT", inputTokens: response.measured ? response.inputTokens : 0,
              outputTokens: response.measured ? response.outputTokens : 0 }, node.id, attempt.id); audit(state, run, "operation.analysis_result_acknowledged");
          });
          continue;
        }
        const connectionId = node.capability.admission?.connectionId;
        if (!connectionId) throw new Error("Operation node has no immutable ERPBridge connection pin");
        const nodeBinding = bindings.get(connectionId), nodeLive = liveByConnection.get(connectionId);
        const tool = nodeLive?.find(tool => tool.tool_id === node.capability.toolId);
        if (!tool) throw new Error("Operation live tool is unavailable");
        const args = await repository.mutateExecution(id, state => {
          this.assert(control); const run = state.executions[id]!, progress = run.readProgress!;
          if (progress.nextStepIndex !== index) throw new Error("Operation pointer changed");
          if (!progress.attempts[node.id]) {
            const startedAt = new Date().toISOString(), attemptId = `${id}:${node.id}`;
            progress.attempts[node.id] = { id: attemptId, nodeId: node.id, stepIndex: index, status: "PREPARING", startedAt };
            (state.timelines[id] ??= []).push({ id: `timeline-${node.id}`, nodeId: node.id, attemptId, label: node.capability.action, status: "RUNNING", phase: "PREPARING", startedAt, sideEffect: node.effectClass !== "read" });
            appendExecutionEvent(state, run, "node.preparing", {}, node.id, attemptId);
          } else if (progress.attempts[node.id]!.status !== "PREPARING") throw new Error("An operation invocation cannot be replayed");
          return resolveReadBinding(node.inputs, operationValueState(run, plan.ir.flow, node.id)) as Record<string, unknown>;
        });
        if (validateToolInput(tool.input_schema, args).length) throw new Error("Resolved operation arguments are invalid");
        if (initial.scheduleSource && node.effectClass === "read" && tool.report_coverage_contract?.requested_key_coverage)
          await repository.readAuthoritative(state => assertScheduledRelatedRead(state, state.executions[id]!, plan, live, node, args));
        const issues = validateToolArguments(node.capability.action, args, tool);
        if (issues.missing.length || issues.invalid.length) throw new Error("Resolved operation arguments failed runtime validation");
        if (hasReservedBridgeRole(tool)) {
          const identity = createDispatchIdentity(actor, nodeBinding!.roleMap);
          if (Object.hasOwn(args, "role") || !identity.erpbridgeRole || !tool.bridge_contract?.remote_roles.includes(identity.erpbridgeRole))
            throw new Error("Operation requires a current reviewed mapped ERPBridge role");
        }
        const pagination = node.effectClass === "read" && initial.scheduleSource ? reportPagination(tool) : null;
        if (pagination?.profile === "opaque-cursor/v1") {
          if (Object.hasOwn(args, pagination.cursor_parameter)) throw new Error("Workflow-authored report cursor values are not allowed");
          let cursorDone = false;
          while (!cursorDone) {
            assertContext();
            const cursorState = await repository.mutateExecution(id, state => {
              this.assert(control); const run = state.executions[id]!, attempt = run.readProgress!.attempts[node.id]!;
              if (attempt.status !== "PREPARING" || run.readProgress!.nextStepIndex !== index || run.reportCoverages?.[node.id] || run.reportCoverage?.nodeId === node.id) throw new Error("Report cursor pointer changed");
              const existing = run.reportPageSecret?.[node.id];
              if (existing && existing.profile !== "schedule-report-cursors/v1") throw new Error("Report cursor profile changed");
              const progress = existing ?? newReportCursorProgress(tool, node.id, node.capability.contractHash,
                initial.scheduleSource!.reportWindow.startAt, initial.scheduleSource!.reportWindow.endAt);
              if (progress.nodeId !== node.id || progress.toolId !== tool.tool_id || progress.contractHash !== node.capability.contractHash ||
                  progress.startAt !== initial.scheduleSource!.reportWindow.startAt || progress.endAt !== initial.scheduleSource!.reportWindow.endAt ||
                  progress.maxPages !== pagination.max_pages)
                throw new Error("Report cursor evidence is inconsistent or exhausted");
              assertReportCursorProgress(tool, progress); (run.reportPageSecret ??= {})[node.id] = progress;
              return { ordinal: progress.pages.length + 1, cursor: progress.nextCursor, items: structuredClone(progress.items),
                pages: structuredClone(progress.pages), snapshotValue: progress.snapshotValue, totalCount: progress.totalCount };
            });
            const ordinal = cursorState.ordinal, cursorArgs = { ...structuredClone(args), [pagination.cursor_parameter]: cursorState.cursor };
            if (validateToolInput(tool.input_schema, cursorArgs).length) throw new Error("Server-derived report cursor arguments are invalid");
            const cursorIssues = validateToolArguments(node.capability.action, cursorArgs, tool);
            if (cursorIssues.missing.length || cursorIssues.invalid.length) throw new Error("Server-derived report cursor arguments failed runtime validation");
            const intentKey = `${node.id}:cursor:${ordinal}`, cursorIntentId = `intent-${randomBytes(16).toString("hex")}`;
            const persistCursorIntent = async () => { await repository.mutateExecution(id, state => {
              assertContext(); const run = state.executions[id]!, attempt = run.readProgress!.attempts[node.id]!, progress = run.reportPageSecret?.[node.id];
              assertScheduledRelatedRead(state, run, plan, live, node, args);
              const fresh = resolveReadBinding(node.inputs, operationValueState(run, plan.ir.flow, node.id));
              if (attempt.status !== "PREPARING" || !canonicalJSONBytes(fresh).equals(canonicalJSONBytes(args)) || !progress ||
                  progress.profile !== "schedule-report-cursors/v1" || progress.nextCursor !== cursorState.cursor || progress.pages.length + 1 !== ordinal ||
                  run.operationSecret!.intents[intentKey]) throw new Error("Report cursor intent facts changed or are already used");
              const now = new Date().toISOString(), intent: OperationIntent = { id: cursorIntentId, nodeId: node.id, invocationId: `${attempt.id}:cursor:${ordinal}`,
                operationKey: `${id}:${node.id}:cursor:${ordinal}`, argumentHash: digest(cursorArgs), state: "DISPATCH_INTENT", preparedAt: now };
              run.operationSecret!.intents[intentKey] = intent; attempt.status = "DISPATCH_INTENT"; attempt.dispatchIntentAt = now;
              const entry = state.timelines[id]!.find(value => value.attemptId === attempt.id)!; entry.status = "RUNNING"; entry.phase = `CURSOR_PAGE_${ordinal}_DISPATCH_INTENT`;
              appendExecutionEvent(state, run, "node.report_page_dispatch_intent", { intentId: cursorIntentId, page: ordinal, continuationProfile: pagination.profile }, node.id, attempt.id);
              audit(state, run, "operation.report_page_dispatch_intent");
            }); };
            const cursorOutput = await captureReadFailure(node.id, intentKey, cursorIntentId, cursorArgs, tool, dispatchReadTool(services, actor.id, node.capability.action, cursorArgs, { workflowId: initial.workflowId, executionId: id,
              signal: control.controller.signal, assertDispatch: assertContext, beforeDispatch: persistCursorIntent, ...protectedReadContext,
              plan: { yaml: snapshot.yaml, stepIndex: index, token: gate.token, admissionPin: node.capability.admission!, contractHash: node.capability.contractHash, toolId: node.capability.toolId } }));
            let confirmed;
            try {
              confirmed = confirmScheduledReportCursor({ tool, args: cursorArgs, output: cursorOutput, startAt: initial.scheduleSource!.reportWindow.startAt,
                endAt: initial.scheduleSource!.reportWindow.endAt, cursor: cursorState.cursor, ordinal });
              const candidateItems = [...cursorState.items, ...confirmed.items];
              assertReportRelatedKeyProgress(tool, cursorArgs, candidateItems, confirmed.hasMore);
              if (cursorState.snapshotValue !== undefined && confirmed.snapshotValue !== cursorState.snapshotValue)
                throw new Error("Cursor-paginated report changed its stable snapshot between pages");
              if (cursorState.totalCount !== undefined && confirmed.totalCount !== cursorState.totalCount)
                throw new Error("Cursor-paginated report changed its total record count between pages");
              if (confirmed.hasMore && [...cursorState.pages.map(page => page.cursorHash), confirmed.evidence.cursorHash].includes(confirmed.evidence.nextCursorHash))
                throw new Error("Cursor-paginated report repeated a previously used cursor");
              if (confirmed.hasMore ? candidateItems.length >= confirmed.totalCount : candidateItems.length !== confirmed.totalCount)
                throw new Error("Cursor-paginated report exhaustion does not match its declared total record count");
              if (candidateItems.length > pagination.max_items || canonicalJSONBytes(candidateItems).length > 2_000_000 ||
                  confirmed.hasMore && cursorState.pages.length + 1 >= pagination.max_pages)
                throw new Error("Cursor-paginated report exceeded its reviewed page, item or byte bound before completeness");
            } catch (error) {
              knownCoverageFailure = { nodeId: node.id, intentKey, intentId: cursorIntentId, output: protectedReportPageOutput(tool, cursorOutput),
                message: error instanceof Error ? error.message : "Scheduled report cursor coverage is unconfirmed" }; throw error;
            }
            await repository.mutateExecution(id, state => {
              assertContext(); const run = state.executions[id]!, attempt = run.readProgress!.attempts[node.id]!, intent = run.operationSecret!.intents[intentKey], progress = run.reportPageSecret?.[node.id];
              if (attempt.status !== "DISPATCH_INTENT" || !intent || intent.id !== cursorIntentId || intent.state !== "DISPATCH_INTENT" || !progress ||
                  progress.profile !== "schedule-report-cursors/v1" || progress.nextCursor !== cursorState.cursor || progress.pages.length + 1 !== ordinal)
                throw new Error("Report cursor result does not own the current intent");
              if (progress.snapshotValue !== undefined && progress.snapshotValue !== confirmed.snapshotValue) throw new Error("Report snapshot changed before cursor checkpoint");
              if (progress.totalCount !== undefined && progress.totalCount !== confirmed.totalCount) throw new Error("Report total count changed before cursor checkpoint");
              const now = new Date().toISOString(); intent.state = "ACKNOWLEDGED"; intent.completedAt = now; progress.pages.push(confirmed.evidence);
              progress.snapshotValue ??= confirmed.snapshotValue; progress.totalCount ??= confirmed.totalCount; progress.items.push(...structuredClone(confirmed.items));
              progress.lastOutput = structuredClone(cursorOutput); progress.nextCursor = confirmed.nextCursor;
              const entry = state.timelines[id]!.find(value => value.attemptId === attempt.id)!;
              appendExecutionEvent(state, run, "node.report_page_completed", { intentId: cursorIntentId, page: ordinal, itemCount: confirmed.items.length,
                hasMore: confirmed.hasMore, continuationProfile: pagination.profile }, node.id, attempt.id);
              if (confirmed.hasMore) {
                attempt.status = "PREPARING"; entry.phase = `CURSOR_PAGE_${ordinal + 1}_PREPARING`; audit(state, run, "operation.report_page_acknowledged"); return;
              }
              const completed = completeCursorPaginatedReport(tool, progress);
              const receipt = confirmScheduledReportCoverage({ tool, nodeId: node.id, contractHash: node.capability.contractHash, args,
                output: completed.output, startAt: initial.scheduleSource!.reportWindow.startAt, endAt: initial.scheduleSource!.reportWindow.endAt,
                pagination: completed.receiptPagination, confirmedAt: now });
              attempt.status = "DONE"; attempt.completedAt = now; run.stepOutputs![node.id] = completed.output;
              (run.reportCoverages ??= {})[node.id] = structuredClone(receipt); run.reportCoverage ??= structuredClone(receipt); run.readProgress!.nextStepIndex++;
              delete run.reportPageSecret![node.id]; if (!Object.keys(run.reportPageSecret!).length) delete run.reportPageSecret;
              Object.assign(entry, { status: "DONE", phase: "COMPLETE", outcome: "REPORT_COVERAGE_CONFIRMED", completedAt: now,
                durationMs: Math.max(0, Date.parse(now) - Date.parse(attempt.startedAt)), output: withoutSecretFields(completed.output) });
              appendExecutionEvent(state, run, "node.completed", { intentId: cursorIntentId, outcome: "REPORT_COVERAGE_CONFIRMED",
                pageCount: receipt.pagination!.pageCount, continuationProfile: pagination.profile }, node.id, attempt.id);
              audit(state, run, "operation.report_pages_completed"); cursorDone = true;
            });
          }
          continue;
        }
        if (pagination) {
          if (Object.hasOwn(args, pagination.page_parameter)) throw new Error("Workflow-authored report page values are not allowed");
          let pageDone = false;
          while (!pageDone) {
            assertContext();
            const pageState = await repository.mutateExecution(id, state => {
              this.assert(control); const run = state.executions[id]!, attempt = run.readProgress!.attempts[node.id]!;
              if (attempt.status !== "PREPARING" || run.readProgress!.nextStepIndex !== index || run.reportCoverages?.[node.id] || run.reportCoverage?.nodeId === node.id) throw new Error("Report pagination pointer changed");
              const existing = run.reportPageSecret?.[node.id];
              if (existing && existing.profile !== "schedule-report-pages/v1") throw new Error("Report pagination profile changed");
              const progress = existing ?? newReportPageProgress(tool, node.id, node.capability.contractHash,
                initial.scheduleSource!.reportWindow.startAt, initial.scheduleSource!.reportWindow.endAt);
              if (progress.nodeId !== node.id || progress.toolId !== tool.tool_id || progress.contractHash !== node.capability.contractHash ||
                  progress.startAt !== initial.scheduleSource!.reportWindow.startAt || progress.endAt !== initial.scheduleSource!.reportWindow.endAt ||
                  progress.maxPages !== pagination.max_pages)
                throw new Error("Report pagination evidence is inconsistent or exhausted");
              assertReportPageProgress(tool, progress);
              (run.reportPageSecret ??= {})[node.id] = progress;
              return { page: progress.nextPage, items: structuredClone(progress.items), pages: structuredClone(progress.pages), snapshotValue: progress.snapshotValue, totalCount: progress.totalCount };
            });
            const page = pageState.page, pageArgs = { ...structuredClone(args), [pagination.page_parameter]: page };
            if (validateToolInput(tool.input_schema, pageArgs).length) throw new Error("Server-derived report page arguments are invalid");
            const pageIssues = validateToolArguments(node.capability.action, pageArgs, tool);
            if (pageIssues.missing.length || pageIssues.invalid.length) throw new Error("Server-derived report page arguments failed runtime validation");
            const intentKey = `${node.id}:page:${page}`, pageIntentId = `intent-${randomBytes(16).toString("hex")}`;
            const persistPageIntent = async () => { await repository.mutateExecution(id, state => {
              assertContext(); const run = state.executions[id]!, attempt = run.readProgress!.attempts[node.id]!, progress = run.reportPageSecret?.[node.id];
              assertScheduledRelatedRead(state, run, plan, live, node, args);
              const fresh = resolveReadBinding(node.inputs, operationValueState(run, plan.ir.flow, node.id));
              if (attempt.status !== "PREPARING" || !canonicalJSONBytes(fresh).equals(canonicalJSONBytes(args)) || !progress ||
                  progress.profile !== "schedule-report-pages/v1" || progress.nextPage !== page ||
                  run.operationSecret!.intents[intentKey]) throw new Error("Report page intent facts changed or are already used");
              const now = new Date().toISOString(), intent: OperationIntent = { id: pageIntentId, nodeId: node.id, invocationId: `${attempt.id}:page:${page}`,
                operationKey: `${id}:${node.id}:page:${page}`, argumentHash: digest(pageArgs), state: "DISPATCH_INTENT", preparedAt: now };
              run.operationSecret!.intents[intentKey] = intent; attempt.status = "DISPATCH_INTENT"; attempt.dispatchIntentAt = now;
              const entry = state.timelines[id]!.find(value => value.attemptId === attempt.id)!; entry.status = "RUNNING"; entry.phase = `PAGE_${page}_DISPATCH_INTENT`;
              appendExecutionEvent(state, run, "node.report_page_dispatch_intent", { intentId: pageIntentId, page }, node.id, attempt.id); audit(state, run, "operation.report_page_dispatch_intent");
            }); };
            const pageOutput = await captureReadFailure(node.id, intentKey, pageIntentId, pageArgs, tool, dispatchReadTool(services, actor.id, node.capability.action, pageArgs, { workflowId: initial.workflowId, executionId: id,
              signal: control.controller.signal, assertDispatch: assertContext, beforeDispatch: persistPageIntent, ...protectedReadContext,
              plan: { yaml: snapshot.yaml, stepIndex: index, token: gate.token, admissionPin: node.capability.admission!, contractHash: node.capability.contractHash, toolId: node.capability.toolId } }));
            let confirmed;
            try {
              confirmed = confirmScheduledReportPage({ tool, args: pageArgs, output: pageOutput, startAt: initial.scheduleSource!.reportWindow.startAt,
                endAt: initial.scheduleSource!.reportWindow.endAt, page });
              const candidateItems = [...pageState.items, ...confirmed.items];
              assertReportRelatedKeyProgress(tool, pageArgs, candidateItems, confirmed.hasMore);
              if (pageState.snapshotValue !== undefined && confirmed.snapshotValue !== pageState.snapshotValue)
                throw new Error("Paginated report changed its stable snapshot between pages");
              if (pageState.totalCount !== undefined && confirmed.totalCount !== pageState.totalCount)
                throw new Error("Paginated report changed its total record count between pages");
              if (confirmed.hasMore ? candidateItems.length >= confirmed.totalCount : candidateItems.length !== confirmed.totalCount)
                throw new Error("Paginated report exhaustion does not match its declared total record count");
              if (candidateItems.length > pagination.max_items || canonicalJSONBytes(candidateItems).length > 2_000_000 || confirmed.hasMore && pageState.pages.length + 1 >= pagination.max_pages)
                throw new Error("Paginated report exceeded its reviewed page, item or byte bound before completeness");
            } catch (error) {
              knownCoverageFailure = { nodeId: node.id, intentKey, intentId: pageIntentId, output: protectedReportPageOutput(tool, pageOutput),
                message: error instanceof Error ? error.message : "Scheduled report page coverage is unconfirmed" }; throw error;
            }
            await repository.mutateExecution(id, state => {
              assertContext(); const run = state.executions[id]!, attempt = run.readProgress!.attempts[node.id]!, intent = run.operationSecret!.intents[intentKey], progress = run.reportPageSecret?.[node.id];
              if (attempt.status !== "DISPATCH_INTENT" || !intent || intent.id !== pageIntentId || intent.state !== "DISPATCH_INTENT" || !progress ||
                  progress.profile !== "schedule-report-pages/v1" || progress.nextPage !== page)
                throw new Error("Report page result does not own the current intent");
              if (progress.snapshotValue !== undefined && progress.snapshotValue !== confirmed.snapshotValue) throw new Error("Report snapshot changed before checkpoint");
              if (progress.totalCount !== undefined && progress.totalCount !== confirmed.totalCount) throw new Error("Report total count changed before checkpoint");
              const now = new Date().toISOString(); intent.state = "ACKNOWLEDGED"; intent.completedAt = now; progress.pages.push(confirmed.evidence);
              progress.snapshotValue ??= confirmed.snapshotValue; progress.totalCount ??= confirmed.totalCount;
              progress.items.push(...structuredClone(confirmed.items)); progress.lastOutput = structuredClone(pageOutput); progress.nextPage++;
              const entry = state.timelines[id]!.find(value => value.attemptId === attempt.id)!;
              appendExecutionEvent(state, run, "node.report_page_completed", { intentId: pageIntentId, page, itemCount: confirmed.items.length, hasMore: confirmed.hasMore }, node.id, attempt.id);
              if (confirmed.hasMore) {
                attempt.status = "PREPARING"; entry.phase = `PAGE_${progress.nextPage}_PREPARING`; audit(state, run, "operation.report_page_acknowledged"); return;
              }
              const completed = completePaginatedReport(tool, progress);
              const receipt = confirmScheduledReportCoverage({ tool, nodeId: node.id, contractHash: node.capability.contractHash, args,
                output: completed.output, startAt: initial.scheduleSource!.reportWindow.startAt, endAt: initial.scheduleSource!.reportWindow.endAt,
                pagination: completed.receiptPagination, confirmedAt: now });
              attempt.status = "DONE"; attempt.completedAt = now; run.stepOutputs![node.id] = completed.output;
              (run.reportCoverages ??= {})[node.id] = structuredClone(receipt); run.reportCoverage ??= structuredClone(receipt); run.readProgress!.nextStepIndex++;
              delete run.reportPageSecret![node.id]; if (!Object.keys(run.reportPageSecret!).length) delete run.reportPageSecret;
              Object.assign(entry, { status: "DONE", phase: "COMPLETE", outcome: "REPORT_COVERAGE_CONFIRMED", completedAt: now,
                durationMs: Math.max(0, Date.parse(now) - Date.parse(attempt.startedAt)), output: withoutSecretFields(completed.output) });
              appendExecutionEvent(state, run, "node.completed", { intentId: pageIntentId, outcome: "REPORT_COVERAGE_CONFIRMED", pageCount: receipt.pagination!.pageCount }, node.id, attempt.id);
              audit(state, run, "operation.report_pages_completed"); pageDone = true;
            });
          }
          continue;
        }
        const assertSelectedPolicy = node.effectClass === "read" ? undefined : await prepareOperationPolicy(services, actor, tool.mcp_tool_name, args, control.controller.signal, initial.traceId);
        const pending = await repository.readAuthoritative(state => state.executions[id]!.runtimeApprovalSecret);
        if (node.effectClass !== "read" && initial.scheduleSource)
          await repository.readAuthoritative(state => assertCoverageBeforeScheduledEffect(state.executions[id]!, plan, live, index));
        if (node.effectClass !== "read" && (!pending || pending.records[pending.activeId]?.binding.nodeId !== node.id)) {
          const binding = await repository.readAuthoritative(state => {
            const run = state.executions[id]!, pin = node.capability.admission!;
            return { executionId: id, workflowId: run.workflowId, nodeId: node.id, invocationId: run.readProgress!.attempts[node.id]!.id, operationKey: `${id}:${node.id}`,
              sourceHash: plan.sourceHash, semanticHash: plan.semanticHash, connectionId: pin.connectionId, connectionBinding: nodeBinding!.session.admissionBinding!, capabilityId: pin.capabilityId,
              capabilityRevision: pin.revisionId, admissionVersion: pin.admissionVersion, contractHash: pin.contractHash, argumentHash: digest(args), requesterId: actor.id,
              requesterRoleId: run.operationSecret!.roleId, workerEpoch: run.readProgress!.epoch, policyHash: runtimeApprovalPolicyHash(state, actor.id) };
          });
          await requestRuntimeApproval(repository, id, binding, args, `Review exact ${node.effectClass} action ${node.capability.action}. Automatic retry is disabled.`); return;
        }
        let output: Record<string, unknown>;
        const intentId = `intent-${randomBytes(16).toString("hex")}`;
        const persistIntent = async () => { await repository.mutateExecution(id, state => {
          assertContext(); const run = state.executions[id]!, attempt = run.readProgress!.attempts[node.id]!;
          assertSelectedPolicy?.(state);
          assertScheduledRelatedRead(state, run, plan, live, node, args);
          const fresh = resolveReadBinding(node.inputs, operationValueState(run, plan.ir.flow, node.id));
          if (attempt.status !== "PREPARING" || !canonicalJSONBytes(fresh).equals(canonicalJSONBytes(args)) || run.operationSecret!.intents[node.id]) throw new Error("Operation intent facts changed or are already used");
          if (node.effectClass !== "read") assertCoverageBeforeScheduledEffect(run, plan, live, index);
          const record = run.runtimeApprovalSecret?.records[run.runtimeApprovalSecret.activeId];
          if (node.effectClass !== "read") {
            if (!record || record.binding.nodeId !== node.id) throw new Error("Exact operation approval is required");
            consumeRuntimeApproval(state, id, record.binding, args, intentId);
          }
          const now = new Date().toISOString();
          const intent: OperationIntent = { id: intentId, nodeId: node.id, invocationId: attempt.id, operationKey: `${id}:${node.id}`, argumentHash: digest(args), state: "DISPATCH_INTENT", preparedAt: now,
            ...(node.effectClass === "read" ? {} : { approvalId: record!.id }) };
          run.operationSecret!.intents[node.id] = intent; attempt.status = "DISPATCH_INTENT"; attempt.dispatchIntentAt = now;
          const entry = state.timelines[id]!.find(entry => entry.attemptId === attempt.id)!; entry.status = "RUNNING"; entry.phase = "DISPATCH_INTENT";
          appendExecutionEvent(state, run, "node.dispatch_intent", { intentId, sideEffect: node.effectClass !== "read" }, node.id, attempt.id); audit(state, run, "operation.dispatch_intent");
        }); };
        if (node.effectClass === "read") output = await captureReadFailure(node.id, node.id, intentId, args, tool, dispatchReadTool(services, actor.id, node.capability.action, args, { workflowId: initial.workflowId, executionId: id, signal: control.controller.signal, assertDispatch: assertContext,
          beforeDispatch: persistIntent, ...protectedReadContext, plan: { yaml: snapshot.yaml, stepIndex: index, token: gate.token, admissionPin: node.capability.admission!, contractHash: node.capability.contractHash, toolId: node.capability.toolId } }));
        else {
          assertErpnextWriteArguments(tool, args);
          const identity = createDispatchIdentity(actor, nodeBinding!.roleMap), resolved = await services.validator.evaluateResolvedStep(id, snapshot.yaml, index, args, gate.token, identity, {
            executionId: id, workflowId: initial.workflowId, traceId: initial.traceId, actor: { id: actor.id, role: actor.role },
          });
          if (!resolved.capability || resolved.violation) throw new Error("Exact operation dispatch capability was denied");
          await persistIntent();
          const permit = await issueOperationDispatchPermit(repository, id, intentId, tool, args, identity, assertContext);
          try {
            output = await nodeBinding!.session.clientFor(tool, node.capability.admission).execute(node.capability.action, resolved.capability, args, identity, control.controller.signal,
              async () => { assertContext(); await repository.readAuthoritative(state => { assertSelectedPolicy?.(state); assertConsumedRuntimeApproval(state as RepositoryState, id, intentId); }); assertContext(); }, assertContext, permit);
          } finally { retireOperationDispatchPermit(permit); }
          if (!confirmedOperationResult(tool, output, args)) throw new Error("Operation tool returned no contract confirmation");
        }
        let coverageReceipt: ReportCoverageReceipt | undefined;
        if (node.effectClass === "read" && initial.scheduleSource && tool.report_coverage_contract) {
          try {
            coverageReceipt = confirmScheduledReportCoverage({ tool, nodeId: node.id, contractHash: node.capability.contractHash, args, output,
              startAt: initial.scheduleSource.reportWindow.startAt, endAt: initial.scheduleSource.reportWindow.endAt });
          } catch (error) {
            knownCoverageFailure = { nodeId: node.id, intentKey: node.id, intentId, output: structuredClone(output), message: error instanceof Error ? error.message : "Scheduled report coverage is unconfirmed" };
            throw error;
          }
        }
        await repository.mutateExecution(id, state => {
          assertContext(); const run = state.executions[id]!, attempt = run.readProgress!.attempts[node.id]!, intent = run.operationSecret!.intents[node.id]!;
          if (attempt.status !== "DISPATCH_INTENT" || intent.id !== intentId || intent.state !== "DISPATCH_INTENT") throw new Error("Operation result does not own the current intent");
          const now = new Date().toISOString(); intent.state = "ACKNOWLEDGED"; intent.completedAt = now;
          if (tool.operation_contract) intent.evidenceMeaning = tool.operation_contract.confirmation.meaning;
          attempt.status = "DONE"; attempt.completedAt = now; run.stepOutputs![node.id] = structuredClone(output); run.readProgress!.nextStepIndex++;
          if (coverageReceipt) {
            if (!run.scheduleSource || run.reportCoverages?.[node.id] || run.reportCoverage?.nodeId === node.id) throw new Error("Scheduled report coverage evidence is duplicated or detached");
            (run.reportCoverages ??= {})[node.id] = structuredClone(coverageReceipt); run.reportCoverage ??= structuredClone(coverageReceipt);
          }
          const entry = state.timelines[id]!.find(entry => entry.attemptId === attempt.id)!; Object.assign(entry, { status: "DONE", outcome: node.effectClass === "read" ? "READ_CONFIRMED" : intent.evidenceMeaning, completedAt: now, durationMs: Math.max(0, Date.parse(now) - Date.parse(attempt.startedAt)), output: withoutSecretFields(output) });
          appendExecutionEvent(state, run, "node.completed", { intentId, outcome: entry.outcome }, node.id, attempt.id); audit(state, run, "operation.result_acknowledged");
        });
      }
      await repository.mutateExecution(id, state => { assertContext(); const run = state.executions[id]!;
        if (run.readProgress!.nextStepIndex !== plan.ir.root.nodes.length || (plan.ir.flow ? (plan.ir.schemaVersion === "workflow-operation-ir/v8" ?
          confirmedProtectedOperationTransition(state, run, plan) : operationControlTransition(plan.ir.flow, run.readProgress!)).kind !== "complete" :
          Object.values(run.readProgress!.attempts).some(attempt => attempt.status !== "DONE"))) throw new Error("Operation is incomplete");
        const last = plan.ir.root.nodes.findLast(node => run.readProgress!.attempts[node.id]?.status === "DONE");
        if (!assertOperationReturnCompletion(state, run, plan)) { if (last) run.finalOutput = run.stepOutputs![last.id]; else delete run.finalOutput; }
        const selectedEffect = plan.ir.root.nodes.some(node => node.kind === "action" && node.effectClass !== "read" && run.readProgress!.attempts[node.id]?.status === "DONE");
        const followedHandler = Object.values(run.operationSecret!.protectedScopes ?? {}).some(receipt => receipt.selection);
        finish(state, run, "DONE", followedHandler ?
          "The workflow followed an explicitly selected error handler. Failed ERP reads remain recorded as failures; only validated handler or Return values were used. Operation acceptance is not recipient-delivery proof." : plan.ir.flow ? selectedEffect
          ? "All selected steps have acknowledged results; unselected branches were not executed. Operation acceptance does not prove recipient delivery."
          : "The selected decision path completed. Unselected branches were not executed; no ERP write or notification was performed."
          : plan.ir.root.nodes.some(node => node.kind === "action" && node.effectClass !== "read")
          ? "All steps have acknowledged results. Operation evidence follows each reviewed result contract; this is not independent recipient-delivery verification."
          : "All read and model nodes have acknowledged results. No ERP write or notification was part of this run.");
      });
    } catch (operationError) {
      try { await repository.mutateExecution(id, state => {
        const run = state.executions[id];
        if (!run || run.operationSecret?.lease?.id !== control.leaseId || run.status !== "RUNNING") return;
        // A fresh authoritative reload can win the mutex before this old
        // worker's catch. Storage fencing is not a new business/preflight
        // failure: retain exact confirmed checkpoints or explicit uncertainty.
        // This queue remains stalled; only a fresh worker can acquire a claim.
        if (this.#stalled) { recover(state, run, "OPERATION_STORAGE_FENCED"); return; }
        if (knownReadFailure) {
          const failure = knownReadFailure, attempt = run.readProgress!.attempts[failure.nodeId], intent = run.operationSecret.intents[failure.intentKey];
          if (!attempt || attempt.status !== "DISPATCH_INTENT" || !intent || intent.id !== failure.intentId || intent.nodeId !== failure.nodeId ||
              intent.argumentHash !== failure.argumentHash || intent.state !== "DISPATCH_INTENT")
            throw new Error("Acknowledged read failure no longer owns the current intent");
          const completedAt = new Date().toISOString(); intent.state = "ACKNOWLEDGED"; intent.completedAt = completedAt; intent.evidenceMeaning = "read-tool-error";
          if (failure.businessFailure) intent.readBusinessFailure = structuredClone(failure.businessFailure);
          attempt.status = "FAILED"; attempt.completedAt = completedAt;
          const entry = state.timelines[id]!.find(value => value.attemptId === attempt.id)!;
          Object.assign(entry, { status: "FAILED", phase: "COMPLETE", outcome: "MCP_READ_TOOL_ERROR", completedAt,
            durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(attempt.startedAt)), output: withoutSecretFields(failure.output) });
          appendExecutionEvent(state, run, "node.read_tool_failed", { intentId: intent.id, outcome: "MCP_READ_TOOL_ERROR",
            ...(failure.businessFailure ? { businessErrorCode: failure.businessFailure.code } : {}) }, failure.nodeId, attempt.id);
          run.failure = { failureCategory: "MCP_READ_TOOL_ERROR", failedStepId: failure.nodeId,
            reason: failure.businessFailure ? "The reviewed ERP read returned a resource-not-found error. This does not prove the record is absent." : "The governed ERP read returned an acknowledged tool-error response.",
            ...(failure.businessFailure ? { businessErrorCode: failure.businessFailure.code } : {}) };
          if (failure.businessFailure && executingPlan?.ir.schemaVersion === "workflow-operation-ir/v8" && executingEpoch !== undefined) {
            const owner = { leaseId: control.leaseId, epoch: executingEpoch };
            let eligible = false;
            // Pure preflight: current revocation/policy denial must not roll
            // back the genuine failed-read receipt or stall the whole queue.
            try { eligible = Boolean(prepareProtectedSelection(state, run, executingPlan, owner, failure.nodeId, failure.intentKey)); } catch { /* Known failure stays terminal. */ }
            if (eligible) {
              const group = checkpointProtectedSelection(state, run, executingPlan, owner, failure.nodeId, failure.intentKey)!;
              queueProtectedHandler(state, run, executingPlan, owner, group);
              audit(state, run, "operation.protected_handler_queued"); return;
            }
          }
          // Error receipts are not successful data bindings or complete reports.
          // No matching explicitly authored, qualified handler means terminal failure.
          finish(state, run, "FAILED", "The ERP read returned a tool error. Its failure receipt is saved; no later node, approval or effect was dispatched.");
          audit(state, run, "operation.read_tool_failed"); return;
        }
        if (knownAgentFailure) {
          const failure = knownAgentFailure, attempt = run.readProgress!.attempts[failure.nodeId];
          if (!attempt || attempt.status !== "PREPARING") throw new Error("Known runtime-agent failure no longer owns the current node");
          const completedAt = new Date().toISOString(); attempt.status = "FAILED"; attempt.completedAt = completedAt;
          const entry = state.timelines[id]!.find(value => value.attemptId === attempt.id)!;
          Object.assign(entry, { status: "FAILED", phase: "COMPLETE", outcome: failure.code, completedAt,
            durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(attempt.startedAt)) });
          appendExecutionEvent(state, run, "node.agent_failed", { outcome: failure.code }, failure.nodeId, attempt.id);
          run.failure = { failureCategory: failure.code, failedStepId: failure.nodeId, reason: failure.message };
          finish(state, run, "FAILED", "The bounded runtime agent stopped without satisfying its reviewed completion contract. No later effect was dispatched.");
          return;
        }
        if (knownAnalysisFailure) {
          const failure = knownAnalysisFailure, attempt = run.readProgress!.attempts[failure.nodeId], intent = run.operationSecret.intents[failure.nodeId];
          if (!attempt || attempt.status !== "DISPATCH_INTENT" || !intent || intent.id !== failure.intentId || intent.state !== "DISPATCH_INTENT")
            throw new Error("Known analysis failure no longer owns the current intent");
          const completedAt = new Date().toISOString(); intent.state = "ACKNOWLEDGED"; intent.completedAt = completedAt;
          attempt.status = "FAILED"; attempt.completedAt = completedAt; run.tokens.input += failure.inputTokens; run.tokens.output += failure.outputTokens;
          run.tokens.total = run.tokens.input + run.tokens.output;
          const entry = state.timelines[id]!.find(value => value.attemptId === attempt.id)!;
          Object.assign(entry, { status: "FAILED", phase: "COMPLETE", outcome: "ANALYSIS_OUTPUT_INVALID", completedAt,
            durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(attempt.startedAt)) });
          appendExecutionEvent(state, run, "node.analysis_output_invalid", { intentId: intent.id, outcome: "ANALYSIS_OUTPUT_INVALID" }, failure.nodeId, attempt.id);
          run.failure = { failureCategory: "ANALYSIS_OUTPUT_INVALID", failedStepId: failure.nodeId, reason: failure.message };
          finish(state, run, "FAILED", "The model returned a response, but it did not match the reviewed structured output contract. No later effect was dispatched.");
          return;
        }
        if (knownCoverageFailure) {
          const failure = knownCoverageFailure, attempt = run.readProgress!.attempts[failure.nodeId], intent = run.operationSecret.intents[failure.intentKey];
          if (!attempt || attempt.status !== "DISPATCH_INTENT" || !intent || intent.id !== failure.intentId || intent.state !== "DISPATCH_INTENT")
            throw new Error("Known report coverage failure no longer owns the current intent");
          const completedAt = new Date().toISOString(); intent.state = "ACKNOWLEDGED"; intent.completedAt = completedAt;
          attempt.status = "FAILED"; attempt.completedAt = completedAt; run.stepOutputs![failure.nodeId] = structuredClone(failure.output);
          const entry = state.timelines[id]!.find(value => value.attemptId === attempt.id)!;
          Object.assign(entry, { status: "FAILED", outcome: "REPORT_COVERAGE_UNCONFIRMED", completedAt,
            durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(attempt.startedAt)), output: withoutSecretFields(failure.output) });
          appendExecutionEvent(state, run, "node.report_coverage_unconfirmed", { intentId: intent.id, outcome: "REPORT_COVERAGE_UNCONFIRMED" }, failure.nodeId, attempt.id);
          run.failure = { failureCategory: "REPORT_COVERAGE_UNCONFIRMED", failedStepId: failure.nodeId, reason: failure.message };
          finish(state, run, "FAILED", "The ERP read returned, but it did not prove complete coverage of the exact scheduled report window. No approval was requested and no effect was dispatched.");
          return;
        }
        const attempt = Object.values(run.readProgress!.attempts).findLast(item => ["PREPARING", "DISPATCH_INTENT"].includes(item.status));
        if (attempt?.status === "DISPATCH_INTENT") recover(state, run, "OPERATION_DISPATCH_OR_RESULT_UNCONFIRMED");
        else if (run.readProgress!.cancellation) finish(state, run, "CANCELLED", "Cancelled before a new dispatch. Previous acknowledged results remain saved.");
        else if (operationError instanceof OperationPolicyBlocked) {
          run.failure = { failureCategory: "OPTIONAL_POLICY_BLOCKED", failedStepId: attempt?.nodeId ?? "preflight", reason: operationError.message };
          finish(state, run, "FAILED", `${operationError.message} No new ERP change was dispatched; correct the fields or policy and start a reviewed new run.`);
        } else { run.failure = { failureCategory: "OPERATION_BLOCKED_BEFORE_DISPATCH", failedStepId: attempt?.nodeId ?? "preflight" }; finish(state, run, "FAILED", "Current operation verification or authority failed before a new dispatch. Previous acknowledged results remain saved."); }
      }); } catch { this.#stalled = true; }
    }
  }
  async stop() {
    if (this.#closed) return; this.#closed = true; if (this.#waitTimer) clearTimeout(this.#waitTimer);
    const active = [...this.#active.values()]; for (const control of active) { control.valid = false; control.controller.abort(); if (control.timer) clearInterval(control.timer); }
    await Promise.allSettled(active.map(control => this.services.repository.mutateExecution(control.id, state => recover(state, state.executions[control.id]!, "OPERATION_WORKER_SHUTDOWN"))));
    await Promise.allSettled(active.flatMap(control => control.task ? [control.task] : [])); this.#unsubscribe();
  }
}
export function confirmedOperationResult(tool: ToolDefinition, output: Record<string, unknown>, args?: Record<string, unknown>): boolean {
  const contract = tool.operation_contract; if (!contract || output.isError === true) return false;
  if (contract.receipt_profile) {
    if (!args) return false;
    try { assertErpnextWriteReceipt(tool, args, output.structuredContent); } catch { return false; }
  }
  let value: unknown = contract.confirmation.source === "mcp-envelope" ? output : output.structuredContent;
  for (const key of contract.confirmation.path) {
    if (!value || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, key)) return false;
    value = (value as Record<string, unknown>)[key];
  }
  return value === contract.confirmation.expected;
}
