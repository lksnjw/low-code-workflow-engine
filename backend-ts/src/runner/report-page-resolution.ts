import { randomBytes } from "node:crypto";
import { z } from "zod";
import { canonicalJSONBytes, resolvedParameterHashBytes } from "../core/canonical-json.js";
import { HandlerFailure, type CurrentUser } from "../http/handlers/common.js";
import { requireResidentExecution } from "./execution-host.js";
import { canReadExecution } from "../http/execution-scope.js";
import { jsonObjectSchema } from "../models/schemas.js";
import { workflowContentHash } from "../parser/workflow.js";
import { capabilityContractHash } from "../registry/capability-admission.js";
import { toolSchema } from "../registry/schemas.js";
import type { Execution, Repository, RepositoryState } from "../repository/store.js";
import { withoutSecretFields } from "../redact/secrets.js";
import { exactBridgeName } from "../tools/erpbridge-contract.js";
import { safeMcpToolResult } from "../tools/mcp-result.js";
import {
  assertReportCursorProgress,
  assertReportPageProgress,
  assertReportRelatedKeyProgress,
  completeCursorPaginatedReport,
  completePaginatedReport,
  confirmScheduledReportCoverage,
  confirmScheduledReportCursor,
  confirmScheduledReportPage,
  reportPagination,
  type ReportCursorEvidence,
  type ReportPageEvidence,
  type ReportPaginationProgress,
} from "../tools/report-coverage-contract.js";
import { resolveReadBinding } from "../workflows/compiled-read.js";
import type { StoredOperationCompilation } from "../workflows/operation-compilation-lifecycle.js";
import { appendExecutionEvent } from "./read-checkpoints.js";

const digest = (value: unknown) => resolvedParameterHashBytes(canonicalJSONBytes(value));
const id = z.string().min(1).max(256), hash = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const evidenceSchema = z.object({ reference: z.string().trim().min(1).max(500), note: z.string().trim().min(1).max(2000),
  observedAt: z.string().datetime() }).strict();
const baseCommand = z.object({ profile: z.literal("report-page-resolution-command/v1"), intentId: id, baseVersion: z.literal(1), factsHash: hash,
  decisionKey: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/), evidence: evidenceSchema });
const confirmCommand = baseCommand.extend({ outcome: z.literal("PAGE_CONFIRMED"), output: jsonObjectSchema }).strict();
const abandonCommand = baseCommand.extend({ outcome: z.literal("ABANDONED") }).strict();
export const reportPageResolutionCommandSchema = z.union([confirmCommand, abandonCommand]);

const resolutionMarkerSchema = z.object({ profile: z.literal("report-page-operator-evidence/v1"), recordId: id, actorId: id,
  referenceHash: hash, observedAt: z.string().datetime(), recordedAt: z.string().datetime() }).strict();
const recordSchema = z.object({ id, profile: z.literal("report-page-resolution/v1"), intentId: id, nodeId: id, invocationId: id,
  continuationProfile: z.enum(["page-number/v1", "opaque-cursor/v1"]), pointer: z.number().int().positive(), cursorHash: hash.optional(),
  argumentHash: hash, outputHash: hash.optional(), factsHash: hash, commandHash: hash, keyHash: hash, outcome: z.enum(["PAGE_CONFIRMED", "ABANDONED"]),
  evidence: evidenceSchema, actorId: id, roleId: id, toolName: z.string().min(1).max(500), remoteToolName: z.string().min(1).max(500),
  arguments: z.record(z.string(), z.unknown()), confirmedPagesBefore: z.number().int().nonnegative(), confirmedItemsBefore: z.number().int().nonnegative(),
  recordedAt: z.string().datetime() }).strict();
export type ReportPageResolutionRecord = z.infer<typeof recordSchema>;

function deny(message: string, status = 409): never {
  throw new HandlerFailure(status, message, { code: "REPORT_PAGE_RESOLUTION_DENIED" });
}
function requireStorage(repository: Repository) {
  const storage = repository.persistence;
  if (storage && (storage.readQueueDurability !== "encrypted-single-writer" || storage.executionCheckpointDurability !== "encrypted-record-transactions/v1" || !storage.saveExecutionCheckpoint))
    deny("Report-page resolution requires qualified encrypted scoped checkpoints", 503);
  repository.assertAuthority();
}
function currentActor(state: Readonly<RepositoryState>, actorId: string) {
  const actor = state.users[actorId], role = actor && state.roles[actor.roleId];
  if (!actor || actor.status.toLowerCase() !== "active" || !role) deny("Current report-page review access is unavailable", 404);
  return { actor, role, permissions: [...role.permissions, ...actor.permissionOverrides] };
}
function canResolve(state: Readonly<RepositoryState>, execution: Execution, actorId: string) {
  const current = currentActor(state, actorId);
  return current.permissions.includes("execution:reconcile") && current.actor.id !== execution.startedBy.id;
}
function records(execution: Execution): ReportPageResolutionRecord[] {
  const raw = execution.operationSecret?.reportPageResolutions ?? {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length > 1000) deny("Stored report-page resolution history is malformed");
  return Object.entries(raw).map(([key, value]) => {
    const parsed = recordSchema.safeParse(value);
    if (!parsed.success || parsed.data.id !== key) deny("Stored report-page resolution evidence is malformed");
    return parsed.data;
  }).sort((a, b) => a.recordedAt.localeCompare(b.recordedAt) || a.id.localeCompare(b.id));
}
const publicRecord = (record: ReportPageResolutionRecord) => ({ id: record.id, intentId: record.intentId, nodeId: record.nodeId,
  continuationProfile: record.continuationProfile, pointer: record.pointer, ...(record.cursorHash ? { cursorHash: record.cursorHash } : {}),
  outcome: record.outcome, evidence: record.evidence, outputHash: record.outputHash ?? null, actorId: record.actorId, recordedAt: record.recordedAt });

function openCase(state: Readonly<RepositoryState>, executionId: string) {
  const execution = state.executions[executionId], job = execution?.operationSecret, snapshot = execution?.workflowSnapshot;
  if (!execution || !job || job.profile !== "operation-job/v1" || snapshot?.executionProfile !== "sequential-operation-v1" || !execution.scheduleSource)
    deny("Uncertain report-page resolution not found", 404);
  if (execution.status !== "RECONCILIATION_REQUIRED" || execution.completedAt === null || job.state !== "RECOVERY_REQUIRED" || job.lease)
    deny("Only a fenced uncertain report page can be resolved");
  const unknown = Object.entries(job.intents).filter(([, value]) => value.state === "UNKNOWN");
  if (unknown.length !== 1) deny("This run does not have one exact uncertain report page");
  const [intentKey, intent] = unknown[0]!, attempt = execution.readProgress?.attempts[intent.nodeId], progress = execution.reportPageSecret?.[intent.nodeId];
  if (!attempt || attempt.status !== "UNKNOWN" || intent.approvalId || !progress || !attempt.dispatchIntentAt || !attempt.completedAt ||
      execution.readProgress!.nextStepIndex !== attempt.stepIndex || intent.preparedAt !== attempt.dispatchIntentAt)
    deny("Uncertain report-page checkpoint evidence is incomplete");
  const publication = state.versions[execution.workflowId]?.findLast(item => item.version === snapshot.version && item.artifactState === "PUBLISHED");
  const compiled = publication?.compiledOperation as StoredOperationCompilation | undefined, receipt = snapshot.operationCompilation;
  const node = compiled?.plan?.ir?.root?.nodes?.[attempt.stepIndex];
  if (!node || node.kind !== "action") deny("Uncertain model calls cannot use report-page resolution");
  const pin = node.capability.admission;
  if (!publication || publication.yaml !== snapshot.yaml || snapshot.contentHash !== workflowContentHash(snapshot.yaml) || !compiled || !receipt ||
      compiled.plan.sourceHash !== snapshot.contentHash || !canonicalJSONBytes(compiled.receipt).equals(canonicalJSONBytes(receipt)) ||
      node.id !== intent.nodeId || node.effectClass !== "read" || !pin || pin.contractHash !== node.capability.contractHash)
    deny("Historical report publication or compilation evidence changed");
  const revision = state.capabilityRevisions[pin.revisionId] as Record<string, unknown> | undefined, tool = toolSchema.safeParse(revision?.definition);
  if (!tool.success || tool.data.tool_id !== node.capability.toolId || capabilityContractHash(tool.data) !== node.capability.contractHash ||
      revision?.capabilityId !== pin.capabilityId || revision.connectionId !== pin.connectionId || revision.contractHash !== pin.contractHash)
    deny("Historical reviewed report capability evidence changed");
  const pagination = reportPagination(tool.data), source = execution.scheduleSource;
  if (!pagination || progress.nodeId !== node.id || progress.toolId !== tool.data.tool_id || progress.contractHash !== node.capability.contractHash ||
      progress.startAt !== source.reportWindow.startAt || progress.endAt !== source.reportWindow.endAt || progress.maxPages !== pagination.max_pages)
    deny("Stored report continuation no longer matches the reviewed schedule");
  if (progress.profile === "schedule-report-pages/v1") assertReportPageProgress(tool.data, progress); else assertReportCursorProgress(tool.data, progress);
  const base = resolveReadBinding(node.inputs, { input: snapshot.input, ...execution.stepOutputs });
  if (!base || typeof base !== "object" || Array.isArray(base)) deny("Exact historical report arguments are unavailable");
  const baseArgs = base as Record<string, unknown>;
  let pointer: number, exactArgs: Record<string, unknown>, publicArgs: Record<string, unknown>, cursorHash: string | undefined;
  if (pagination.profile === "page-number/v1" && progress.profile === "schedule-report-pages/v1") {
    pointer = progress.nextPage; exactArgs = { ...structuredClone(baseArgs), [pagination.page_parameter]: pointer }; publicArgs = structuredClone(exactArgs);
    if (intentKey !== `${node.id}:page:${pointer}` || intent.invocationId !== `${attempt.id}:page:${pointer}`) deny("Uncertain numeric report page identity changed");
  } else if (pagination.profile === "opaque-cursor/v1" && progress.profile === "schedule-report-cursors/v1") {
    pointer = progress.pages.length + 1; exactArgs = { ...structuredClone(baseArgs), [pagination.cursor_parameter]: progress.nextCursor };
    cursorHash = digest(progress.nextCursor); publicArgs = { ...structuredClone(baseArgs), [pagination.cursor_parameter]: "[protected cursor]" };
    if (intentKey !== `${node.id}:cursor:${pointer}` || intent.invocationId !== `${attempt.id}:cursor:${pointer}`) deny("Uncertain report cursor identity changed");
  } else deny("Stored report continuation profile changed");
  if (digest(exactArgs) !== intent.argumentHash || canonicalJSONBytes(exactArgs).length > 256_000) deny("Exact historical report arguments changed");
  const facts = { executionId, workflowId: execution.workflowId, snapshotHash: snapshot.contentHash, compilation: receipt, scheduleSource: source,
    attempt, intentKey, intent, progress, argumentHash: intent.argumentHash };
  return { execution, job, snapshot, attempt, intentKey, intent, node, tool: tool.data, pagination, progress, baseArgs, exactArgs,
    publicArgs: withoutSecretFields(publicArgs) as Record<string, unknown>, pointer, cursorHash, factsHash: digest(facts) };
}

export function hasReportPageResolution(execution: Execution): boolean {
  return Object.values(execution.operationSecret?.intents ?? {}).some(intent => intent.state === "UNKNOWN" && !intent.approvalId && /:(?:page|cursor):\d+$/.test(intent.operationKey)) ||
    Object.keys(execution.operationSecret?.reportPageResolutions ?? {}).length > 0;
}

export function reportPageResolutionView(state: Readonly<RepositoryState>, executionId: string, actorId: string, resolvedIntentId?: string) {
  const execution = state.executions[executionId], current = currentActor(state, actorId);
  if (!execution || !(current.permissions.includes("execution:reconcile") || current.permissions.some(key => ["workflow:read", "execution:read_own"].includes(key)) &&
      canReadExecution({ id: actorId, permissions: current.permissions }, execution))) deny("Uncertain report-page resolution not found", 404);
  const history = records(execution), currentOpen = execution.status === "RECONCILIATION_REQUIRED" && Object.values(execution.operationSecret?.intents ?? {})
    .some(intent => intent.state === "UNKNOWN" && !intent.approvalId && /:(?:page|cursor):\d+$/.test(intent.operationKey));
  if (!resolvedIntentId && currentOpen) {
    const value = openCase(state, executionId);
    return { id: executionId, workflowId: execution.workflowId, workflowName: execution.workflowName, status: execution.status, reportPageResolution: {
      profile: "report-page-resolution-case/v1", state: "OPEN", intentId: value.intent.id, nodeId: value.node.id, invocationId: value.intent.invocationId,
      continuationProfile: value.pagination.profile, pointer: value.pointer, ...(value.cursorHash ? { cursorHash: value.cursorHash } : {}),
      preparedAt: value.intent.preparedAt, requesterId: execution.startedBy.id, toolName: value.tool.name, remoteToolName: exactBridgeName(value.tool),
      arguments: value.publicArgs, outputSchema: structuredClone(value.tool.bridge_contract!.output_schema), confirmedPages: value.progress.pages.length,
      confirmedItems: value.progress.items.length, version: 1, factsHash: value.factsHash, canRecord: canResolve(state, execution, actorId), canResume: true,
      noReplay: true, history: history.map(publicRecord), explanation: "Supply independently captured output for this exact page to validate and continue from the next continuation, or abandon the occurrence. The uncertain page is never called again." } };
  }
  const latest = resolvedIntentId ? history.findLast(record => record.intentId === resolvedIntentId) : history.at(-1);
  if (!latest) deny("Uncertain report-page resolution not found", 404);
  return { id: executionId, workflowId: execution.workflowId, workflowName: execution.workflowName, status: execution.status, reportPageResolution: {
    profile: "report-page-resolution-case/v1", state: "RESOLVED", intentId: latest.intentId, nodeId: latest.nodeId, invocationId: latest.invocationId,
    continuationProfile: latest.continuationProfile, pointer: latest.pointer, ...(latest.cursorHash ? { cursorHash: latest.cursorHash } : {}),
    preparedAt: null, requesterId: execution.startedBy.id, toolName: latest.toolName, remoteToolName: latest.remoteToolName, arguments: latest.arguments,
    outputSchema: null, confirmedPages: latest.confirmedPagesBefore, confirmedItems: latest.confirmedItemsBefore, version: 2, factsHash: latest.factsHash,
    canRecord: false, canResume: latest.outcome === "PAGE_CONFIRMED", noReplay: true, history: history.map(publicRecord),
    explanation: latest.outcome === "PAGE_CONFIRMED" ? "The captured page was validated and checkpointed. Continuation was queued without replaying that page." : "The occurrence was abandoned and closed without replaying the uncertain page or dispatching the effect." } };
}

function marker(record: ReportPageResolutionRecord) {
  return resolutionMarkerSchema.parse({ profile: "report-page-operator-evidence/v1", recordId: record.id, actorId: record.actorId,
    referenceHash: digest(record.evidence.reference), observedAt: record.evidence.observedAt, recordedAt: record.recordedAt });
}
function addResolution<T extends ReportPageEvidence | ReportCursorEvidence>(evidence: T, record: ReportPageResolutionRecord): T {
  return { ...evidence, resolution: marker(record) } as T;
}
function reopen(execution: Execution) {
  execution.status = "PENDING"; execution.completedAt = null; execution.durationMs = 0; delete execution.failure;
  execution.operationSecret!.state = "QUEUED"; delete execution.operationSecret!.lease;
}
function acceptPage(state: RepositoryState, value: ReturnType<typeof openCase>, output: Record<string, unknown>, record: ReportPageResolutionRecord) {
  const { execution, progress, pagination, tool, pointer, exactArgs, baseArgs, node, attempt, intent } = value;
  const confirmed = pagination.profile === "page-number/v1" && progress.profile === "schedule-report-pages/v1" ?
    confirmScheduledReportPage({ tool, args: exactArgs, output, startAt: progress.startAt, endAt: progress.endAt, page: pointer, confirmedAt: record.recordedAt }) :
    pagination.profile === "opaque-cursor/v1" && progress.profile === "schedule-report-cursors/v1" ?
      confirmScheduledReportCursor({ tool, args: exactArgs, output, startAt: progress.startAt, endAt: progress.endAt,
        cursor: progress.nextCursor, ordinal: pointer, confirmedAt: record.recordedAt }) : deny("Report continuation profile changed");
  const candidateItems = [...progress.items, ...confirmed.items];
  assertReportRelatedKeyProgress(tool, exactArgs, candidateItems, confirmed.hasMore);
  if (progress.snapshotValue !== undefined && progress.snapshotValue !== confirmed.snapshotValue) deny("Captured page changed the stable report snapshot", 422);
  if (progress.totalCount !== undefined && progress.totalCount !== confirmed.totalCount) deny("Captured page changed the declared report total", 422);
  if ("nextCursor" in confirmed && confirmed.hasMore && (progress as Extract<ReportPaginationProgress, { profile: "schedule-report-cursors/v1" }>).pages
      .map(page => page.cursorHash).concat(confirmed.evidence.cursorHash).includes(confirmed.evidence.nextCursorHash)) deny("Captured page repeats a consumed report cursor", 422);
  if (confirmed.hasMore ? candidateItems.length >= confirmed.totalCount : candidateItems.length !== confirmed.totalCount)
    deny("Captured page exhaustion does not match the declared report total", 422);
  if (candidateItems.length > pagination.max_items || canonicalJSONBytes(candidateItems).length > 2_000_000 ||
      confirmed.hasMore && progress.pages.length + 1 >= pagination.max_pages) deny("Captured page exceeds the reviewed report bounds", 422);
  intent.state = "ACKNOWLEDGED"; intent.completedAt = record.recordedAt; intent.reportResolutionId = record.id;
  progress.pages.push(addResolution(confirmed.evidence, record) as never); progress.snapshotValue ??= confirmed.snapshotValue;
  progress.totalCount ??= confirmed.totalCount; progress.items.push(...structuredClone(confirmed.items)); progress.lastOutput = structuredClone(output);
  if (progress.profile === "schedule-report-pages/v1") progress.nextPage++;
  else if ("nextCursor" in confirmed) progress.nextCursor = confirmed.nextCursor;
  else deny("Captured page result does not match its cursor continuation", 422);
  const entry = state.timelines[execution.id]?.find(item => item.attemptId === attempt.id);
  appendExecutionEvent(state, execution, "node.report_page_operator_resolved", { recordId: record.id, intentId: intent.id, page: pointer,
    continuationProfile: pagination.profile, itemCount: confirmed.items.length, hasMore: confirmed.hasMore, noReplay: true }, node.id, attempt.id);
  if (confirmed.hasMore) {
    attempt.status = "PREPARING"; delete attempt.completedAt; if (entry) Object.assign(entry, { status: "RUNNING", outcome: undefined,
      phase: progress.profile === "schedule-report-pages/v1" ? `PAGE_${progress.nextPage}_PREPARING` : `CURSOR_PAGE_${progress.pages.length + 1}_PREPARING`, completedAt: undefined });
    reopen(execution); execution.agentSummary = "An independent reviewer supplied the captured uncertain report page. It was validated and checkpointed; the next continuation is queued without replaying that page.";
    return;
  }
  const completed = progress.profile === "schedule-report-pages/v1" ? completePaginatedReport(tool, progress) : completeCursorPaginatedReport(tool, progress);
  const receipt = confirmScheduledReportCoverage({ tool, nodeId: node.id, contractHash: node.capability.contractHash, args: baseArgs,
    output: completed.output, startAt: progress.startAt, endAt: progress.endAt, pagination: completed.receiptPagination, confirmedAt: record.recordedAt });
  attempt.status = "DONE"; attempt.completedAt = record.recordedAt; execution.stepOutputs![node.id] = completed.output;
  (execution.reportCoverages ??= {})[node.id] = structuredClone(receipt); execution.reportCoverage ??= structuredClone(receipt);
  execution.readProgress!.nextStepIndex++; delete execution.reportPageSecret![node.id]; if (!Object.keys(execution.reportPageSecret!).length) delete execution.reportPageSecret;
  if (entry) Object.assign(entry, { status: "DONE", phase: "COMPLETE", outcome: "REPORT_COVERAGE_CONFIRMED_WITH_OPERATOR_EVIDENCE", completedAt: record.recordedAt,
    durationMs: Math.max(0, Date.parse(record.recordedAt) - Date.parse(attempt.startedAt)), output: withoutSecretFields(completed.output) });
  appendExecutionEvent(state, execution, "node.completed", { recordId: record.id, intentId: intent.id, outcome: "REPORT_COVERAGE_CONFIRMED_WITH_OPERATOR_EVIDENCE",
    pageCount: receipt.pagination!.pageCount, continuationProfile: pagination.profile, noReplay: true }, node.id, attempt.id);
  reopen(execution); execution.agentSummary = "An independent reviewer supplied the captured final report page. Exact coverage was validated; the next workflow step is queued without replaying that page.";
}

function receipt(execution: Execution, record: ReportPageResolutionRecord, replayed: boolean) {
  return { executionId: execution.id, intentId: record.intentId, recordId: record.id, outcome: record.outcome, version: 2,
    state: record.outcome === "PAGE_CONFIRMED" ? "RESUMED" : "FAILED", resumeQueued: record.outcome === "PAGE_CONFIRMED",
    pageAccepted: record.outcome === "PAGE_CONFIRMED", replayed, noReplay: true, toolWasCalled: false };
}

export async function resolveReportPage(repository: Repository, executionId: string, user: CurrentUser, raw: unknown) {
  if (raw && typeof raw === "object" && "outcome" in raw && raw.outcome === "PAGE_CONFIRMED") requireResidentExecution(repository);
  requireStorage(repository);
  const parsed = reportPageResolutionCommandSchema.safeParse(raw);
  if (!parsed.success || canonicalJSONBytes(raw).length > 600_000) deny("Resolution requires one exact case revision, bounded evidence and either a captured page result or abandonment", 422);
  const command = parsed.data, keyHash = digest([executionId, user.id, command.intentId, command.decisionKey]), commandHash = digest(command);
  try {
    return await repository.mutateExecution(executionId, state => {
      const execution = state.executions[executionId], current = currentActor(state, user.id);
      if (!execution || !canResolve(state, execution, user.id) || current.role.name !== user.role || !user.permissions.includes("execution:reconcile"))
        deny("Current independent execution:reconcile authority is required", 403);
      const previous = records(execution).find(item => item.keyHash === keyHash);
      if (previous) { if (previous.commandHash !== commandHash) deny("Resolution key already belongs to different evidence"); return receipt(execution, previous, true); }
      const value = openCase(state, executionId);
      if (command.intentId !== value.intent.id || command.baseVersion !== 1 || command.factsHash !== value.factsHash)
        deny("Report-page case changed; reload exact evidence before resolving");
      const now = new Date().toISOString();
      if (Date.parse(command.evidence.observedAt) < Date.parse(value.intent.preparedAt) || Date.parse(command.evidence.observedAt) > Date.parse(now) + 30_000)
        deny("Evidence must have been observed after this page intent and not in the future", 422);
      let output: Record<string, unknown> | undefined, outputHash: string | undefined;
      if (command.outcome === "PAGE_CONFIRMED") {
        try { output = safeMcpToolResult(command.output, value.tool); }
        catch (error) { deny(error instanceof Error ? error.message : "Captured report output is malformed", 422); }
        outputHash = digest(output);
      }
      const record = recordSchema.parse({ id: `report-resolution-${randomBytes(16).toString("hex")}`, profile: "report-page-resolution/v1",
        intentId: value.intent.id, nodeId: value.node.id, invocationId: value.intent.invocationId, continuationProfile: value.pagination.profile,
        pointer: value.pointer, ...(value.cursorHash ? { cursorHash: value.cursorHash } : {}), argumentHash: value.intent.argumentHash,
        ...(outputHash ? { outputHash } : {}), factsHash: value.factsHash, commandHash, keyHash, outcome: command.outcome, evidence: command.evidence,
        actorId: user.id, roleId: current.role.id, toolName: value.tool.name, remoteToolName: exactBridgeName(value.tool), arguments: value.publicArgs,
        confirmedPagesBefore: value.progress.pages.length, confirmedItemsBefore: value.progress.items.length, recordedAt: now });
      (execution.operationSecret!.reportPageResolutions ??= {})[record.id] = record;
      if (record.outcome === "PAGE_CONFIRMED") acceptPage(state, value, output!, record);
      else {
        value.intent.reportResolutionId = record.id; value.attempt.status = "FAILED"; value.attempt.completedAt = now;
        execution.status = "FAILED"; execution.completedAt = now; execution.durationMs = Math.max(0, Date.parse(now) - Date.parse(execution.startedAt));
        execution.operationSecret!.state = "FINISHED"; delete execution.operationSecret!.lease;
        execution.failure = { failureCategory: "REPORT_PAGE_ABANDONED", failedStepId: value.node.id, reason: "An independent reviewer abandoned the uncertain report page; no effect was dispatched" };
        delete execution.reportPageSecret![value.node.id]; if (!Object.keys(execution.reportPageSecret!).length) delete execution.reportPageSecret;
        const entry = state.timelines[executionId]?.find(item => item.attemptId === value.attempt.id);
        if (entry) Object.assign(entry, { status: "FAILED", phase: "RESOLUTION_ABANDONED", outcome: "REPORT_PAGE_ABANDONED", completedAt: now });
        execution.agentSummary = "The uncertain report page was abandoned by an independent reviewer. The occurrence is closed; no page was replayed, no approval was requested and no effect was dispatched.";
        appendExecutionEvent(state, execution, "node.report_page_abandoned", { recordId: record.id, intentId: value.intent.id, page: value.pointer,
          continuationProfile: value.pagination.profile, noReplay: true }, value.node.id, value.attempt.id);
      }
      state.auditLogs.push({ id: `report-resolution-audit-${randomBytes(12).toString("hex")}`, actor: { id: current.actor.id, name: current.actor.name },
        action: "operation.report_page_resolved", resource: { type: "execution", id: executionId }, after: { recordId: record.id, intentId: record.intentId,
          outcome: record.outcome, continuationProfile: record.continuationProfile, pointer: record.pointer, factsHash: record.factsHash, noReplay: true }, createdAt: now });
      return receipt(execution, record, false);
    });
  } catch (error) {
    if (error instanceof HandlerFailure) throw error;
    throw new HandlerFailure(503, "Report-page resolution acknowledgement is unconfirmed. Reload authoritative state before another decision; the uncertain page was not replayed.",
      { code: "REPORT_PAGE_RESOLUTION_UNCONFIRMED" });
  }
}
