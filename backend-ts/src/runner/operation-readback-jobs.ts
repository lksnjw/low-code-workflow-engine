import { toolRoleAllowed } from "../governance/tool-access.js";
import { randomBytes } from "node:crypto";
import { captureUserMcpBinding, withUserMcpBinding } from "../tools/user-mcp-credentials.js";
import { stringify } from "yaml";
import { canonicalJSONBytes, resolvedParameterHashBytes } from "../core/canonical-json.js";
import { boundedOperation } from "../core/bounded-operation.js";
import { canReadExecution } from "../http/execution-scope.js";
import { HandlerFailure, validateWorkflow, type CurrentUser, type HandlerServices } from "../http/handlers/common.js";
import type { Repository, RepositoryState } from "../repository/store.js";
import { capabilityContractHash, captureReadAdmissionPin } from "../registry/capability-admission.js";
import { withoutSecretFields } from "../redact/secrets.js";
import { dispatchReadTool } from "../tools/read-tool-broker.js";
import { evaluateOperationReadback, resolveOperationReadbackArguments } from "../tools/operation-readback-contract.js";
import { appendExecutionEvent } from "./read-checkpoints.js";
import { operationCaseEvidence, operationReconciliationView } from "./operation-reconciliation.js";
import { validateHistoricalOperationReadback } from "./operation-readback-evidence.js";
import { operationReadbackCommandSchema, operationReadbackJobSchema, readbackEvaluationSchema, type OperationReadbackJob } from "./operation-readback-state.js";
import { supportsOperationJobs } from "./operation-jobs.js";
import { boundMcpConnection } from "../tools/mcp-dispatch-context.js";
import { bindExecutionHost, residentExecutionAllowed, requireResidentExecution } from "./execution-host.js";
import { assertReadbackTaskOutbox, newReadbackTaskOutbox, requireReadbackTaskAdmission, readbackTaskAdmissionAvailable,
  dispatchReadbackTaskOutbox, readbackTaskCommandSchema, type ReadbackTaskCommand } from "./readback-task-outbox.js";

const digest = (value: unknown) => resolvedParameterHashBytes(canonicalJSONBytes(value));
const same = (a: unknown, b: unknown) => canonicalJSONBytes(a).equals(canonicalJSONBytes(b));
const queues = new WeakMap<Repository, OperationReadbackQueue>();
const pending = (job: OperationReadbackJob) => ["QUEUED", "RUNNING"].includes(job.state);
function deny(message: string, status = 409): never { throw new HandlerFailure(status, message, { code: "OPERATION_READBACK_DENIED" }); }
function queryActor(state: Readonly<RepositoryState>, executionId: string, actorId: string): CurrentUser {
  const execution = state.executions[executionId], actor = state.users[actorId], role = actor && state.roles[actor.roleId];
  const permissions = actor && role ? [...role.permissions, ...actor.permissionOverrides] : [];
  if (!execution || !actor || !role || actor.status.toLowerCase() !== "active" || !permissions.some(key => ["workflow:read", "execution:read_own"].includes(key)) ||
      !canReadExecution({ id: actorId, permissions }, execution)) deny("Status query source not found", 404);
  const workflow = state.workflows[execution.workflowId];
  if (!workflow || workflow.archived || !permissions.includes("workflow:run") && (!permissions.includes("workflow:run_own") ||
      workflow.owner.id !== actorId && !(workflow.assignedUserIds ?? []).includes(actorId))) deny("Current scoped read/run authority is required for a status query", 403);
  return { ...actor, role: role.name, permissions };
}
function allJobs(state: Readonly<RepositoryState>) {
  return Object.values(state.executions).flatMap(execution => journal(state, execution.id));
}
function journal(state: Readonly<RepositoryState>, executionId: string): OperationReadbackJob[] {
  const raw = state.executions[executionId]?.operationSecret?.readbacks ?? {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length > 100) deny("Stored status query journal is malformed");
  return Object.entries(raw).map(([key, value]) => {
    const parsed = operationReadbackJobSchema.safeParse(value);
    if (!parsed.success || key !== parsed.data.id || parsed.data.executionId !== executionId || canonicalJSONBytes(parsed.data).length > 150_000) deny("Stored status query record is malformed");
    return parsed.data;
  });
}
/** Historical result proof does not require a currently connected or admitted
 * endpoint. It still requires exact immutable original and target revisions. */
function historicalQuery(state: Readonly<RepositoryState>, job: OperationReadbackJob) {
  const source = operationCaseEvidence(state, job.executionId);
  try { return { source, target: validateHistoricalOperationReadback(state, job, source).target }; }
  catch (error) { deny(error instanceof Error ? error.message : "Original operation or reviewed query evidence changed"); }
}
function currentQuery(state: Readonly<RepositoryState>, services: HandlerServices, job: OperationReadbackJob) {
  const { source, target } = historicalQuery(state, job), actor = queryActor(state, job.executionId, job.actorId), session = boundMcpConnection(services, job.admission.connectionId).session;
  if (source.resolved || source.version !== job.baseVersion || source.factsHash !== job.factsHash || actor.roleId !== job.roleId || actor.role !== job.admittedRole || !toolRoleAllowed(target.allowed_roles, actor.role))
    deny("Current query case or actor authority changed");
  if (!session?.requiresReviewedRevision || session.dispatchBoundary !== "sdk-entry/v1" || session.available === false || session.admissionBinding !== job.connectionBinding)
    deny("The exact reviewed ERPBridge connection is unavailable", 503);
  const matches = services.registries.snapshot().tools.filter(tool => tool.tool_id === job.targetId);
  if (matches.length !== 1 || capabilityContractHash(matches[0]!) !== job.targetHash) deny("Status query target changed");
  try { captureReadAdmissionPin(state, services.registries, matches[0]!, session.admissionBinding, job.admission, job.admission.connectionId); }
  catch { deny("The exact reviewed status admission changed"); }
  return { source, target: matches[0]!, actor, session };
}
function publicJob(job: OperationReadbackJob) {
  return { id: job.id, executionId: job.executionId, intentId: job.intentId, nodeId: job.nodeId, state: job.state, createdAt: job.createdAt, startedAt: job.startedAt ?? null, completedAt: job.completedAt ?? null, actorId: job.actorId,
    basis: "queried-operation-state", dispatchIntentRecorded: !!job.dispatchIntentAt,
    queryOutcome: job.state === "ANSWERED" ? "ANSWER_CONFIRMED" : job.failure === "READBACK_RESULT_UNQUALIFIED" ? "UNQUALIFIED_RESULT" : job.dispatchIntentAt ? "UNKNOWN" : "NOT_DISPATCHED",
    observation: job.evaluation ?? null, failure: job.failure ?? null, cancellationRequested: !!job.cancellation,
    canResolve: false, canResume: false, noReplay: true, deliveryVerified: false };
}
function event(state: RepositoryState, job: OperationReadbackJob, type: string) {
  const execution = state.executions[job.executionId]!;
  appendExecutionEvent(state, execution, `operation.readback_${type}`, { queryId: job.id, state: job.state, noReplay: true }, job.nodeId, job.id);
  const actor = state.users[job.actorId];
  state.auditLogs.push({ id: `readback-audit-${randomBytes(12).toString("hex")}`, source: "operation-readback-job/v1", actor: { id: job.actorId, name: actor?.name ?? job.actorId },
    action: `operation.readback_${type}`, resource: { type: "execution", id: job.executionId }, after: { queryId: job.id, intentId: job.intentId, state: job.state }, createdAt: new Date().toISOString() });
}
function finish(state: RepositoryState, job: OperationReadbackJob, status: OperationReadbackJob["state"], failure?: OperationReadbackJob["failure"]) {
  job.state = status; job.completedAt = new Date().toISOString(); delete job.lease; if (failure) job.failure = failure;
  operationReadbackJobSchema.parse(job); event(state, job, status.toLowerCase());
}
function immutable(job: OperationReadbackJob) {
  const { state: _state, epoch: _epoch, lease: _lease, startedAt: _start, completedAt: _end, dispatchIntentAt: _intent, cancellation: _cancel,
    result: _result, evaluation: _evaluation, failure: _failure, taskDispatchSecret: _outbox, ...fixed } = job;
  return digest(fixed);
}
export function operationReadbackHistory(state: Readonly<RepositoryState>, services: HandlerServices, executionId: string, actorId: string) {
  // The existing minimum case view establishes fresh source access; this does
  // not grant full run access or expose private query arguments/results.
  const review = operationReconciliationView(state, executionId, actorId);
  const source = operationCaseEvidence(state, executionId), jobs = journal(state, executionId);
  for (const job of jobs) historicalQuery(state, job);
  let controller: CurrentUser | undefined;
  try { controller = queryActor(state, executionId, actorId); } catch { /* Minimum history access is not query control authority. */ }
  let canQuery = false;
  try {
    const actor = queryActor(state, executionId, actorId), binding = source.node.readback, session = binding ? boundMcpConnection(services, binding.admission.connectionId).session : undefined;
    const target = binding && services.registries.snapshot().tools.filter(tool => tool.tool_id === binding.toolId);
    if (!source.resolved && binding && session?.available !== false && session?.requiresReviewedRevision && session.dispatchBoundary === "sdk-entry/v1" && session.admissionBinding === source.connectionBinding &&
        target?.length === 1 && toolRoleAllowed(target[0]!.allowed_roles, actor.role)) {
      resolveOperationReadbackArguments(source.tool, target[0]!, source.args);
      captureReadAdmissionPin(state, services.registries, target[0]!, session.admissionBinding, binding.admission, binding.admission.connectionId);
      canQuery = readbackTaskAdmissionAvailable(services.repository) && supportsOperationJobs(services) && jobs.length < 100 && !jobs.some(pending);
    }
  } catch { /* Historical evidence remains inspectable; no query authority. */ }
  return { profile: "operation-readback-history/v1", executionId, intentId: source.intent.id, nodeId: source.intent.nodeId, baseVersion: source.version, factsHash: source.factsHash,
    canQuery, memoryOnly: services.repository.persistence === null, jobs: jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).map(job => ({ ...publicJob(job),
      canCancel: !!controller && pending(job) && (job.actorId === controller.id || controller.permissions.includes("workflow:run")),
      canResolve: review.operationReconciliation.canRecord === true && job.state === "ANSWERED" && job.evaluation?.settled === true && job.evaluation.outcome !== "UNRESOLVED" })),
    canResume: false, noReplay: true, deliveryVerified: false,
    explanation: "A status query checks the reviewed operation-state condition. It does not prove unique send attribution or recipient delivery, close this case, resend the original action or resume later nodes." };
}
export function operationReadbackQueue(services: HandlerServices) {
  let queue = queues.get(services.repository);
  if (!queue || queue.closed) { queue = new OperationReadbackQueue(services); queues.set(services.repository, queue); }
  return queue;
}
type Active = { executionId: string; id: string; actorId: string; leaseId: string; epoch: number; fixed: string; valid: boolean; expiresAt: number;
  controller: AbortController; timer?: NodeJS.Timeout; task?: Promise<void>; connectionId: string; roleMapHash: string; governanceHash?: string;
  taskCommand?: ReadbackTaskCommand; deadlineAt?: number };
/** Separate read-only query jobs. Original run status, effect intents, SDK
 * answers, timeline and continuation pointer are never changed by this queue. */
export class OperationReadbackQueue {
  readonly #workerId = `readback-worker-${randomBytes(16).toString("hex")}`;
  readonly #active = new Map<string, Active>();
  readonly #unobserve: () => void;
  #closed = false; #started = false; #stalled = false; #pumping = false; #repump = false; #lastActor = "";
  get closed() { return this.#closed; }
  constructor(readonly services: HandlerServices) {
    bindExecutionHost(services.repository);
    if (!supportsOperationJobs(services)) deny("Status queries require qualified encrypted scoped persistence", 503);
    this.#unobserve = services.repository.observeCommits({ committed: state => {
      for (const control of this.#active.values()) {
        try { const job = journal(state, control.executionId).find(job => job.id === control.id);
          if (!job || job.state !== "RUNNING" || job.epoch !== control.epoch || immutable(job) !== control.fixed || job.lease?.id !== control.leaseId || job.lease.workerId !== this.#workerId || job.lease.expiresAt <= Date.now() || job.cancellation)
            throw new Error("Status query claim changed");
          if (control.taskCommand && (assertReadbackTaskOutbox(job).taskId !== control.taskCommand.taskId || job.taskDispatchSecret!.state === "PREPARED")) throw new Error("Task query identity changed");
          currentQuery(state, services, job);
          if (digest(boundMcpConnection(services, control.connectionId).roleMap) !== control.roleMapHash || control.governanceHash && digest(state.governancePolicy) !== control.governanceHash) throw new Error("Query policy or role map changed");
          control.expiresAt = job.lease.expiresAt;
        } catch { control.valid = false; control.controller.abort(); }
      }
      if (this.#started && Object.values(state.executions).some(execution => Object.values(execution.operationSecret?.readbacks ?? {}).some(job => job.state === "QUEUED"))) this.kick();
    }, unavailable: () => { this.#stalled = true; for (const control of this.#active.values()) { control.valid = false; control.controller.abort(); } } });
  }
  async admit(executionId: string, user: CurrentUser, raw: unknown) {
    requireReadbackTaskAdmission(this.services.repository);
    if (this.#closed || this.#stalled) deny("Status query worker is unavailable; authoritative recovery and restart are required", 503);
    const parsed = operationReadbackCommandSchema.safeParse(raw); if (!parsed.success) deny("Status query requires exact intent, case revision, facts hash and idempotency key", 422);
    const command = parsed.data, keyHash = digest(["operation-readback/v1", executionId, user.id, command.idempotencyKey]);
    const { idempotencyKey: _key, ...exact } = command, fingerprint = digest({ ...exact, executionId, actorId: user.id, keyHash });
    try {
      const receipt = await this.services.repository.mutateExecution(executionId, state => {
        const actor = queryActor(state, executionId, user.id); if (actor.role !== user.role) deny("Query actor changed", 403);
        const jobs = journal(state, executionId), previous = jobs.find(job => job.keyHash === keyHash);
        if (previous) { historicalQuery(state, previous); if (previous.requestFingerprint !== fingerprint) deny("Status query key belongs to different case evidence"); return { ...publicJob(previous), replayed: true }; }
        const source = operationCaseEvidence(state, executionId), binding = source.node.readback;
        if (!binding || source.resolved || source.intent.id !== command.intentId || source.version !== command.baseVersion || source.factsHash !== command.factsHash) deny("Query case is closed, changed or lacks a reviewed status contract");
        if (jobs.length >= 100 || jobs.some(pending) || allJobs(state).filter(pending).length >= 64) deny("A status query is already pending or its bounded quota is full", 429);
        const session = boundMcpConnection(this.services, binding.admission.connectionId).session, matches = this.services.registries.snapshot().tools.filter(tool => tool.tool_id === binding.toolId);
        if (!session?.admissionBinding || matches.length !== 1) deny("Reviewed status tool is unavailable", 503);
        const args = resolveOperationReadbackArguments(source.tool, matches[0]!, source.args);
        const job = operationReadbackJobSchema.parse({ profile: "operation-readback-job/v1", id: `readback-${randomBytes(16).toString("hex")}`, executionId, intentId: command.intentId, nodeId: source.intent.nodeId,
          ...(this.services.userMcpCredentials ? { erpCredentialSecret: captureUserMcpBinding(this.services, state, actor.id)! } : {}),
          baseVersion: command.baseVersion, factsHash: command.factsHash, actorId: actor.id, roleId: actor.roleId, admittedRole: actor.role, keyHash, requestFingerprint: fingerprint,
          targetId: binding.toolId, targetHash: binding.contractHash, admission: { ...binding.admission }, connectionBinding: source.connectionBinding,
          argumentHash: source.intent.argumentHash, arguments: args, createdAt: new Date().toISOString(), epoch: 1, state: "QUEUED" });
        currentQuery(state, this.services, job);
        if (!residentExecutionAllowed(this.services.repository)) job.taskDispatchSecret = newReadbackTaskOutbox(job);
        (state.executions[executionId]!.operationSecret!.readbacks ??= {})[job.id] = job; event(state, job, "queued");
        return { ...publicJob(job), replayed: false };
      });
      if (!residentExecutionAllowed(this.services.repository)) return { ...receipt,
        taskDispatch: await dispatchReadbackTaskOutbox(this.services.repository, executionId, receipt.id) };
      this.kick(); return receipt;
    } catch (error) {
      if (error instanceof HandlerFailure) throw error;
      throw new HandlerFailure(503, "Status query admission is unconfirmed. Reload authoritative history before submitting again; the original action was not replayed.", { code: "OPERATION_READBACK_UNCONFIRMED" });
    }
  }
  /** Private task entry. The envelope identifies one original read-only query;
   * it supplies no role, arguments, approval, permit or authority to resend. */
  async executeTask(raw: unknown, options: { timeoutMs: number; signal?: AbortSignal }) {
    const repository = this.services.repository, command = readbackTaskCommandSchema.parse(raw);
    if (residentExecutionAllowed(repository) || this.#closed || this.#stalled) throw new Error("Readback task requires an available bounded owner");
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 100 || options.timeoutMs > Math.min(240_000, this.services.config.readWorkerLeaseMs - 100))
      throw new Error("Readback task wait must fit inside its fixed lease");
    const initial = await repository.readAuthoritative(state => {
      const job = journal(state, command.executionId).find(job => job.id === command.queryId);
      if (!job || assertReadbackTaskOutbox(job).taskId !== command.taskId || job.taskDispatchSecret!.state === "PREPARED") throw new Error("Query has no acknowledged task intention");
      historicalQuery(state, job); return structuredClone(job);
    });
    if (!pending(initial)) return this.taskReceipt(command);
    if (initial.state === "RUNNING") {
      if (!initial.lease || Date.now() < initial.lease.expiresAt) throw new Error("Original query claim is live; retry original delivery after expiry");
      await repository.mutateExecution(command.executionId, state => {
        const job = journal(state, command.executionId).find(job => job.id === command.queryId);
        if (!job || job.state !== "RUNNING" || job.epoch !== initial.epoch || job.lease?.id !== initial.lease!.id || job.lease.workerId !== initial.lease!.workerId ||
            job.lease.expiresAt !== initial.lease!.expiresAt || Date.now() < job.lease.expiresAt || assertReadbackTaskOutbox(job).taskId !== command.taskId) throw new Error("Original query claim changed");
        // journal() validates and clones records; mutate the authoritative leaf.
        const stored = state.executions[command.executionId]!.operationSecret!.readbacks![command.queryId]!;
        stored.epoch++; finish(state, stored, stored.dispatchIntentAt ? "RECOVERY_REQUIRED" : "FAILED",
          stored.dispatchIntentAt ? "READBACK_INTERRUPTED" : "READBACK_BLOCKED_BEFORE_DISPATCH");
      });
      return this.taskReceipt(command);
    }
    if (this.#active.size || options.signal?.aborted) throw new Error("Readback task owner is busy or cancelled");
    const connection = boundMcpConnection(this.services, initial.admission.connectionId);
    const control: Active = { executionId: initial.executionId, id: initial.id, actorId: initial.actorId, epoch: initial.epoch, fixed: immutable(initial),
      leaseId: `readback-lease-${randomBytes(16).toString("hex")}`, valid: true, expiresAt: Date.now() + this.services.config.readWorkerLeaseMs,
      controller: new AbortController(), connectionId: initial.admission.connectionId, roleMapHash: digest(connection.roleMap), taskCommand: command,
      deadlineAt: Date.now() + options.timeoutMs };
    const expire = () => { control.valid = false; control.controller.abort(); };
    options.signal?.addEventListener("abort", expire, { once: true });
    this.#active.set(control.id, control);
    try {
      control.task = boundedOperation(() => this.work(control), { timeoutMs: options.timeoutMs, signal: control.controller.signal,
        label: "Readback task processing", onAbandon: expire });
      try { await control.task; } catch { expire(); await this.retire(control); }
      return await this.taskReceipt(command);
    } finally {
      options.signal?.removeEventListener("abort", expire); expire(); this.#active.delete(control.id);
    }
  }
  private taskReceipt(command: ReadbackTaskCommand) {
    return this.services.repository.readAuthoritative(state => {
      const job = journal(state, command.executionId).find(job => job.id === command.queryId);
      if (!job || pending(job) || job.lease || assertReadbackTaskOutbox(job).taskId !== command.taskId || job.taskDispatchSecret!.state === "PREPARED")
        throw new Error("Readback task has no acknowledged terminal receipt; retry original delivery");
      historicalQuery(state, job);
      const events = state.executionEvents[command.executionId] ?? [], progress = state.executions[command.executionId]?.readProgress;
      if (!progress || events.length !== progress.lastSequence || events.some((entry, index) => entry.sequence !== index + 1) ||
          !events.some(entry => entry.type === `operation.readback_${job.state.toLowerCase()}` && entry.attemptId === job.id))
        throw new Error("Readback task terminal journal is incomplete");
      return publicJob(job);
    });
  }
  async cancel(executionId: string, id: string, user: CurrentUser) {
    if (this.#closed || this.#stalled) deny("Status query worker is unavailable", 503);
    try { return await this.services.repository.mutateExecution(executionId, state => {
      const actor = queryActor(state, executionId, user.id); const job = state.executions[executionId]?.operationSecret?.readbacks?.[id];
      if (actor.role !== user.role || !job || job.actorId !== user.id && !actor.permissions.includes("workflow:run")) deny("Status query not controllable by this actor", 404);
      journal(state, executionId); historicalQuery(state, job);
      if (!pending(job)) return publicJob(job);
      job.cancellation ??= { actorId: user.id, requestedAt: new Date().toISOString() };
      if (job.state === "QUEUED") finish(state, job, "CANCELLED", "READBACK_CANCELLED"); else event(state, job, "cancel_requested");
      return publicJob(job);
    }); } catch (error) { if (error instanceof HandlerFailure) throw error;
      throw new HandlerFailure(503, "Query cancellation acknowledgement is unconfirmed; reload history. No original action was replayed.", { code: "OPERATION_READBACK_UNCONFIRMED" }); }
  }
  async start() {
    requireResidentExecution(this.services.repository);
    if (this.#started || this.#closed) return;
    // The repository was authoritatively opened before worker startup. Avoid
    // an empty background pump; every real claim/dispatch still rechecks it.
    const jobs = await this.services.repository.read(state => { this.services.repository.assertAuthority(); return allJobs(state); });
    this.services.repository.assertAuthority();
    for (const job of jobs.filter(job => job.state === "RUNNING" && !job.taskDispatchSecret)) await this.services.repository.mutateExecution(job.executionId, state => {
      const current = state.executions[job.executionId]!.operationSecret!.readbacks![job.id]!;
      if (current.state !== "RUNNING") return; current.epoch++;
      finish(state, current, current.dispatchIntentAt ? "RECOVERY_REQUIRED" : "FAILED", "READBACK_INTERRUPTED");
    });
    this.#started = true; if (jobs.some(job => job.state === "QUEUED")) this.kick();
  }
  kick() {
    if (!residentExecutionAllowed(this.services.repository) || !this.#started || this.#closed || this.#stalled) return;
    if (this.#pumping) { this.#repump = true; return; }
    this.#pumping = true;
    setImmediate(() => { void this.pump().catch(() => { this.#stalled = true; }).finally(() => { this.#pumping = false; if (this.#repump) { this.#repump = false; this.kick(); } }); });
  }
  private async pump() {
    if (!residentExecutionAllowed(this.services.repository)) return;
    while (!this.#closed && !this.#stalled && this.#active.size < this.services.config.readWorkerConcurrency) {
      const candidates = await this.services.repository.readAuthoritative(state => allJobs(state).filter(job => !job.taskDispatchSecret && job.state === "QUEUED" && !this.#active.has(job.id) &&
        [...this.#active.values()].filter(control => control.actorId === job.actorId).length < this.services.config.readWorkerPerActor).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)));
      const job = candidates.find(job => job.actorId !== this.#lastActor) ?? candidates[0]; if (!job) return;
      const connection = boundMcpConnection(this.services, job.admission.connectionId);
      const control: Active = { executionId: job.executionId, id: job.id, actorId: job.actorId, leaseId: `readback-lease-${randomBytes(16).toString("hex")}`, epoch: job.epoch,
        fixed: immutable(job), valid: true, expiresAt: Date.now() + this.services.config.readWorkerLeaseMs, controller: new AbortController(), connectionId: job.admission.connectionId, roleMapHash: digest(connection.roleMap) };
      this.#active.set(job.id, control); this.#lastActor = job.actorId;
      control.task = this.work(control).catch(() => { this.#stalled = true; }).finally(() => { if (control.timer) clearInterval(control.timer); this.#active.delete(job.id); this.kick(); });
    }
  }
  private assert(control: Active) {
    this.services.repository.assertAuthority();
    if (this.#closed || this.#stalled || !control.valid || control.controller.signal.aborted || Date.now() >= control.expiresAt ||
        control.deadlineAt !== undefined && Date.now() >= control.deadlineAt || digest(boundMcpConnection(this.services, control.connectionId).roleMap) !== control.roleMapHash)
      throw new Error("Status query worker is fenced");
  }
  private async retire(control: Active) {
    await this.services.repository.mutateExecution(control.executionId, state => {
      const job = state.executions[control.executionId]?.operationSecret?.readbacks?.[control.id];
      if (!job || job.epoch !== control.epoch || !pending(job) || job.state === "RUNNING" && job.lease?.id !== control.leaseId) return;
      if (control.taskCommand && (immutable(job) !== control.fixed || assertReadbackTaskOutbox(job).taskId !== control.taskCommand.taskId))
        throw new Error("Original task query changed; retirement cannot rewrite another identity");
      finish(state, job, job.dispatchIntentAt ? "RECOVERY_REQUIRED" : job.cancellation ? "CANCELLED" : "FAILED",
        job.dispatchIntentAt ? "READBACK_INTERRUPTED" : job.cancellation ? "READBACK_CANCELLED" : "READBACK_BLOCKED_BEFORE_DISPATCH");
    });
  }
  private async work(control: Active) {
    const original = await this.services.repository.readAuthoritative(state => state.executions[control.executionId]?.operationSecret?.readbacks?.[control.id]);
    return withUserMcpBinding(this.services, original?.actorId ?? "", original?.erpCredentialSecret, () => this.workBound(control));
  }
  private async workBound(control: Active) {
    const { services } = this, { repository } = services;
    try {
      const initial = await repository.mutateExecution(control.executionId, state => {
        this.assert(control); const job = state.executions[control.executionId]!.operationSecret!.readbacks![control.id]!;
        if (job.state !== "QUEUED" || job.epoch !== control.epoch || immutable(job) !== control.fixed) throw new Error("Query is not its exact queued record");
        if (control.taskCommand ? assertReadbackTaskOutbox(job).taskId !== control.taskCommand.taskId || job.taskDispatchSecret!.state === "PREPARED" : !!job.taskDispatchSecret)
          throw new Error("Query is not owned by this worker host");
        currentQuery(state, services, job); job.state = "RUNNING"; job.startedAt = new Date().toISOString();
        job.lease = { id: control.leaseId, workerId: this.#workerId,
          expiresAt: control.taskCommand ? control.expiresAt : Date.now() + services.config.readWorkerLeaseMs };
        event(state, job, "started"); return structuredClone(job);
      });
      this.assert(control);
      if (!control.taskCommand) { control.timer = setInterval(() => { void repository.mutateExecution(control.executionId, state => {
        this.assert(control); const job = state.executions[control.executionId]!.operationSecret!.readbacks![control.id]!;
        if (job.state !== "RUNNING" || job.lease?.id !== control.leaseId || job.epoch !== control.epoch) throw new Error("Query lease changed");
        currentQuery(state, services, job); job.lease.expiresAt = Date.now() + services.config.readWorkerLeaseMs;
      }).catch(() => { control.valid = false; control.controller.abort(); }); }, Math.max(1000, Math.floor(services.config.readWorkerLeaseMs / 3))); control.timer.unref(); }
      const verified = await repository.readAuthoritative(state => currentQuery(state, services, initial));
      const yaml = stringify({ name: "Exact operation status query", description: "Read-only query of one reviewed uncertain operation; no resend or resume", trigger: { type: "manual" },
        steps: [{ id: "query", action: verified.target.name, connection_id: initial.admission.connectionId, parameters: initial.arguments }] });
      const gate = await boundedOperation(() => validateWorkflow(services, "OperationReadbackQuery", yaml, verified.actor, { signal: control.controller.signal }),
        { timeoutMs: 120_000, signal: control.controller.signal, label: "Operation status query verification", onAbandon: () => { control.valid = false; control.controller.abort(); } });
      if (!gate.token || !gate.result.passed) throw new Error("Query verification failed");
      control.governanceHash = await repository.readAuthoritative(state => digest(state.governancePolicy)); this.assert(control);
      const result = await boundedOperation(() => dispatchReadTool(services, initial.actorId, verified.target.name, initial.arguments, {
        signal: control.controller.signal, workflowId: verified.source.execution.workflowId, assertDispatch: () => this.assert(control),
        plan: { yaml, stepIndex: 0, token: gate.token!, admissionPin: initial.admission, toolId: initial.targetId, contractHash: initial.targetHash },
        beforeDispatch: async () => { await repository.mutateExecution(control.executionId, state => {
          this.assert(control); const job = state.executions[control.executionId]!.operationSecret!.readbacks![control.id]!;
          currentQuery(state, services, job);
          if (job.state !== "RUNNING" || job.lease?.id !== control.leaseId || job.dispatchIntentAt || immutable(job) !== control.fixed || job.epoch !== control.epoch) throw new Error("Query intent is not exact");
          job.dispatchIntentAt = new Date().toISOString(); event(state, job, "dispatch_intent");
        }); },
      }), { timeoutMs: 120_000, signal: control.controller.signal, label: "Governed operation status query", onAbandon: () => { control.valid = false; control.controller.abort(); } });
      this.assert(control);
      let evaluation;
      try { evaluation = readbackEvaluationSchema.parse(evaluateOperationReadback(verified.source.tool, verified.target, verified.source.args, result, verified.source.intent.preparedAt)); }
      catch {
        await repository.mutateExecution(control.executionId, state => { this.assert(control); const job = state.executions[control.executionId]!.operationSecret!.readbacks![control.id]!;
          currentQuery(state, services, job); finish(state, job, "FAILED", "READBACK_RESULT_UNQUALIFIED"); }); return;
      }
      await repository.mutateExecution(control.executionId, state => {
        this.assert(control); const job = state.executions[control.executionId]!.operationSecret!.readbacks![control.id]!; currentQuery(state, services, job);
        if (job.state !== "RUNNING" || job.lease?.id !== control.leaseId || !job.dispatchIntentAt || immutable(job) !== control.fixed || job.epoch !== control.epoch) throw new Error("Query result has no exact intent");
        job.result = { structuredContent: withoutSecretFields(result.structuredContent) as Record<string, unknown> }; job.evaluation = evaluation;
        finish(state, job, "ANSWERED"); historicalQuery(state, job);
      });
    } catch { await this.retire(control); }
  }
  async stop() {
    if (this.#closed) return; this.#closed = true; this.#unobserve();
    const active = [...this.#active.values()]; for (const control of active) { control.valid = false; control.controller.abort(); if (control.timer) clearInterval(control.timer); }
    await Promise.allSettled(active.map(control => this.retire(control)));
    await Promise.allSettled(active.flatMap(control => control.task ? [control.task] : []));
  }
}
