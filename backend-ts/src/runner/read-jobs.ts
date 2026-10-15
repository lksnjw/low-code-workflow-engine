import { createHmac, randomBytes } from "node:crypto";
import { captureUserMcpBinding, withUserMcpBinding } from "../tools/user-mcp-credentials.js";
import type { Execution, Repository, RepositoryState } from "../repository/store.js";
import type { Workflow } from "../models/schemas.js";
import { AESGCMCodec, decodeEncryptionKey } from "../storage/aes-gcm.js";
import { HandlerFailure, validateWorkflow, type CurrentUser, type HandlerServices } from "../http/handlers/common.js";
import { completeCheckpointedRead } from "./checkpointed-read.js";
import { appendExecutionEvent, assertCurrentRunController, reconcileInterruptedExecutions, reconcileReadExecution } from "./read-checkpoints.js";
import { readJobHasInput, assertReadWorkerLease, issueReadWorkerLease, renewReadWorkerLease, nextFairReadJob, ReadWorkerLeaseFailure, type ReadWorkerLease, type ReadWorkerContext } from "./read-worker-lease.js";
import { workflowContentHash, parseWorkflowYAMLStrict } from "../parser/workflow.js";
import { inspectReadWorkflow } from "./read-workflow.js";
import { discoverTools } from "../agent/tool-discovery.js";
import { prepareCompiledExecution } from "../workflows/read-compilation-lifecycle.js";
import { supportsCollectionReads, readIterationBindingKey } from "./read-collection-admission.js";
import { completeCheckpointedCollectionRead } from "./checkpointed-collection-read.js";
import { boundMcpConnection, selectedMcpConnectionId } from "../tools/mcp-dispatch-context.js";
import { bindExecutionHost, residentExecutionAllowed, requireResidentExecution } from "./execution-host.js";
import { newReadTaskOutbox, assertReadTaskOutbox, readTaskCommandSchema, requireReadTaskAdmission, type ReadTaskCommand } from "./read-task-outbox.js";
import type { ExecutionRetryRequest } from "./execution-retry.js";
import { withoutSecretFields } from "../redact/secrets.js";

type Admission = { input: Record<string, unknown>; actorId: string; admittedRole: string; scope: string; fingerprint: string; connectionFingerprint: string;
  snapshotScheduleSource?: Execution["snapshotScheduleSource"] };
const queues = new WeakMap<Repository, ReadJobQueue>();
const memoryKeys = new WeakMap<Repository, string>();
type ActiveRead = { id: string; actorId: string; controller: AbortController; lease?: ReadWorkerLease; failure?: ReadWorkerLeaseFailure;
  controllerAllowed: boolean; timer?: NodeJS.Timeout; task?: Promise<void>; taskCommand?: ReadTaskCommand; deadlineAt?: number };
export function supportsReadJobs(services: HandlerServices): boolean {
  return services.repository.persistence === null || services.repository.persistence.readQueueDurability === "encrypted-single-writer";
}
export function readJobQueue(services: HandlerServices): ReadJobQueue {
  let queue = queues.get(services.repository);
  if (!queue || queue.closed) { queue = new ReadJobQueue(services); queues.set(services.repository, queue); }
  return queue;
}

/** Fair bounded workers inside the exclusively owned repository. Authenticated
 * renewable leases fence SDK entry, not distributed failover or replay.
 * Claimed/interrupted work is never automatically claimed by another worker. */
export class ReadJobQueue {
  readonly #codec: AESGCMCodec;
  readonly #fingerprintKey: string;
  readonly #workerId = `read-worker-${randomBytes(8).toString("hex")}`;
  #scheduled = false;
  #pumping = false;
  readonly #leaseKey: string;
  readonly #active = new Map<string, ActiveRead>();
  readonly #concurrency: number;
  readonly #perActor: number;
  readonly #leaseMs: number;
  readonly #unobserve: () => void;
  #actorRing: string[] = [];
  #repump = false;
  #stalled = false;
  #closed = false;
  #started = false;
  get closed(): boolean { return this.#closed; }
  constructor(readonly services: HandlerServices) {
    bindExecutionHost(services.repository);
    if (!supportsReadJobs(services)) throw new HandlerFailure(503, "This storage backend has no verified encrypted single-writer read queue", { code: "READ_QUEUE_STORAGE_UNSUPPORTED" });
    let key = services.config.storageEncryptionKey;
    if (services.repository.persistence === null) { key = memoryKeys.get(services.repository) ?? randomBytes(32).toString("base64"); memoryKeys.set(services.repository, key); }
    this.#codec = new AESGCMCodec(key);
    this.#fingerprintKey = createHmac("sha256", decodeEncryptionKey(key)).update("read-job-fingerprint-v1").digest("hex");
    this.#leaseKey = createHmac("sha256", decodeEncryptionKey(key)).update("read-worker-leases/v1").digest("hex");
    this.#concurrency = services.config.readWorkerConcurrency; this.#perActor = services.config.readWorkerPerActor; this.#leaseMs = services.config.readWorkerLeaseMs;
    if (!Number.isSafeInteger(this.#concurrency) || this.#concurrency < 1 || this.#concurrency > 8 || !Number.isSafeInteger(this.#perActor) || this.#perActor < 1 || this.#perActor > this.#concurrency || !Number.isSafeInteger(this.#leaseMs) || this.#leaseMs < 5000 || this.#leaseMs > 300_000) throw new Error("Invalid read worker limits");
    this.#unobserve = services.repository.observeCommits({ committed: state => this.observe(state), unavailable: () => {
      this.#stalled = true; for (const control of this.#active.values()) {
        control.failure ??= new ReadWorkerLeaseFailure("READ_WORKER_STORAGE_UNAVAILABLE"); control.controller.abort(control.failure);
      }
    } });
  }
  prepare(workflow: Workflow, input: Record<string, unknown>, user: CurrentUser, key: string, retry?: ExecutionRetryRequest, snapshotScheduleSource?: Execution["snapshotScheduleSource"]): Admission {
    if (this.#closed) throw new HandlerFailure(503, "Read queue is shutting down", { code: "READ_QUEUE_UNAVAILABLE" });
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) throw new HandlerFailure(400, "Async read admission requires a 16–128 character idempotency key", { code: "READ_JOB_KEY_REQUIRED" });
    const canonical = canonicalInput(input);
    if (Buffer.byteLength(canonical) > 64_000) throw new HandlerFailure(413, "Read job input exceeds 64 KB", { code: "READ_JOB_INPUT_LIMIT" });
    const scope = this.digest(JSON.stringify([user.id, workflow.id, key]));
    const identity = [workflow.publishedVersion, workflowContentHash(workflow.yaml), canonical];
    const fingerprint = this.digest(JSON.stringify(snapshotScheduleSource ? [...identity, { snapshotScheduleSource: canonicalInput(snapshotScheduleSource) }] : retry ? [...identity, retry] : identity));
    // An existing idempotent admission remains queryable while its connection
    // is degraded or fenced. A new admission still fails in store() because an
    // empty fingerprint cannot match a current connected context.
    let connectionFingerprint = "";
    try { connectionFingerprint = this.connectionFingerprint(workflow.yaml); } catch { /* resolved after existing-key lookup */ }
    return { input: structuredClone(input), actorId: user.id, admittedRole: user.role, scope, fingerprint, connectionFingerprint,
      ...(snapshotScheduleSource ? { snapshotScheduleSource: structuredClone(snapshotScheduleSource) } : {}) };
  }
  private digest(value: string): string { return createHmac("sha256", this.#fingerprintKey).update(value).digest("hex"); }
  private connectionFingerprint(yaml: string): string {
    const source = parseWorkflowYAMLStrict(yaml), ids = [...new Set(source.steps.map(step => selectedMcpConnectionId(this.services, step.connection_id)))].sort();
    return this.digest(canonicalInput(ids.map(id => { const bound = boundMcpConnection(this.services, id); return { id, binding: bound.session.admissionBinding ?? null, roleMap: bound.roleMap }; })));
  }
  /** Read-only identity lookup. Publication/input changes do not hide an
   * already admitted run; finding a receipt never grants replay authority. */
  findAdmission(state: Readonly<RepositoryState>, workflowId: string, actorId: string, key: string): Execution | null {
    const scope = this.digest(JSON.stringify([actorId, workflowId, key]));
    const jobs = Object.values(state.readJobs).filter(job => job.idempotencyScope === scope);
    if (!jobs.length) return null;
    const job = jobs[0]!, run = state.executions[job.executionId];
    if (jobs.length !== 1 || !run || job.actorId !== actorId || run.startedBy.id !== actorId || run.workflowId !== workflowId)
      throw new HandlerFailure(409, "Read admission identity is inconsistent");
    return run;
  }
  existing(state: Readonly<RepositoryState>, admission: Admission, user: CurrentUser): Execution | null {
    const job = Object.values(state.readJobs).find((item) => item.idempotencyScope === admission.scope);
    if (!job) return null;
    const item = state.executions[job.executionId];
    if (!item || job.actorId !== user.id) throw new HandlerFailure(409, "Read job identity is inconsistent", { code: "READ_JOB_IDENTITY_INVALID" });
    try { assertCurrentRunController(state as RepositoryState, item, user.id); }
    catch { throw new HandlerFailure(403, "Current user cannot control this read job", { code: "EXECUTION_AUTHORITY_CHANGED" }); }
    if (job.requestFingerprint !== admission.fingerprint) throw new HandlerFailure(409, "Idempotency key belongs to different inputs or a different publication", { code: "READ_JOB_KEY_CONFLICT" });
    return structuredClone(item);
  }
  assertCapacity(state: RepositoryState): void {
    requireReadTaskAdmission(this.services.repository);
    if (this.#closed || this.#stalled) throw new HandlerFailure(503, "Read workers are unavailable; inspect recovery state before admitting another run", { code: "READ_QUEUE_UNAVAILABLE" });
    if (Object.values(state.readJobs).filter((job) => ["QUEUED", "CLAIMED"].includes(job.state)).length >= 100)
      throw new HandlerFailure(429, "Read queue is full; no run was admitted", { code: "READ_QUEUE_FULL" });
  }
  store(state: RepositoryState, item: Execution, admission: Admission): void {
    if (canonicalInput(item.snapshotScheduleSource ?? null) !== canonicalInput(admission.snapshotScheduleSource ?? null))
      throw new Error("Read schedule source changed during admission");
    const credential = captureUserMcpBinding(this.services, state, admission.actorId);
    if (credential) item.erpCredentialSecret = credential;
    requireReadTaskAdmission(this.services.repository);
    if (this.#closed || this.#stalled) throw new HandlerFailure(503, "Read workers are unavailable", { code: "READ_QUEUE_UNAVAILABLE" });
    if (!item.workflowSnapshot?.yaml || this.connectionFingerprint(item.workflowSnapshot.yaml) !== admission.connectionFingerprint)
      throw new HandlerFailure(503, "Read connection identity is unavailable or changed during admission", { code: "READ_CONNECTION_BINDING_REQUIRED" });
    const capturedInput={version:1 as const,executionId:item.id,input:structuredClone(admission.input)};
    const inputStorage=this.services.config.firestoreContentFormat==="native-fields/v1"?{inputFields:capturedInput}:{inputCiphertext:this.#codec.encode(Buffer.from(JSON.stringify(capturedInput))).toString("base64")};
    const queueSequence = Object.values(state.readJobs).reduce((highest, job) => Math.max(highest, job.queueSequence ?? 0), 0) + 1;
    if (!Number.isSafeInteger(queueSequence) || queueSequence < 1) throw new Error("Read admission sequence is unavailable");
    state.readJobs[item.id] = { version: 1, executionId: item.id, actorId: admission.actorId, admittedRole: admission.admittedRole, state: "QUEUED", ...inputStorage,
      requestFingerprint: admission.fingerprint, idempotencyScope: admission.scope, connectionFingerprint: admission.connectionFingerprint, createdAt: item.startedAt, queueSequence };
    if (!residentExecutionAllowed(this.services.repository)) state.readJobs[item.id]!.taskDispatchSecret = newReadTaskOutbox(state.readJobs[item.id]!);
  }
  /** Internal task-handler API, never a browser route. The authenticated queue
   * envelope identifies work; original publication/RBAC/SDK checks still grant
   * dispatch authority. One awaited task, no resident pump or lease renewal. */
  async executeTask(raw: unknown, options: { timeoutMs: number; signal?: AbortSignal }): Promise<Execution> {
    if (residentExecutionAllowed(this.services.repository)) throw new Error("Read task execution requires a bounded invocation owner");
    if (this.#closed || this.#stalled) throw new Error("Read task owner is unavailable");
    const command = readTaskCommandSchema.parse(raw);
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 100 || options.timeoutMs > this.#leaseMs - 100)
      throw new Error("Read task deadline must fit inside its fixed original lease");
    const state = await this.services.repository.readAuthoritative(state => {
      const job = state.readJobs[command.executionId], run = state.executions[command.executionId];
      if (!job || !run || assertReadTaskOutbox(job).taskId !== command.taskId || job.taskDispatchSecret!.state === "PREPARED")
        throw new Error("Read task is not backed by an acknowledged enqueue intent");
      return { job: structuredClone(job), run: structuredClone(run) };
    });
    if (["FINISHED", "RECOVERY_REQUIRED"].includes(state.job.state)) return this.taskReceipt(command);
    if (state.job.state === "QUEUED" && state.run.status !== "PENDING")
      throw new Error("Queued read task has inconsistent execution state");
    if (state.job.state === "CLAIMED") {
      // A duplicate delivery cannot usurp a live original lease. Expired claims
      // are reconciled from the original journal, never replayed under a task.
      if (!state.job.lease || Date.now() < Date.parse(state.job.lease.expiresAt)) throw new Error("Read task has an unresolved existing claim; retry after authoritative recovery");
      await reconcileInterruptedExecutions(this.services.repository, "READ_TASK_INTERRUPTED", command.executionId);
      await this.services.repository.mutateExecution(command.executionId, current => {
        const job = current.readJobs[command.executionId], run = current.executions[command.executionId];
        if (job?.state !== "CLAIMED" || !run) return;
        job.state = ["DONE", "FAILED", "CANCELLED"].includes(run.status) ? "FINISHED" : "RECOVERY_REQUIRED";
        if (job.state === "FINISHED") { job.finishedAt = run.completedAt ?? new Date().toISOString(); delete job.inputCiphertext; delete job.inputFields; delete job.lease; }
      });
      return this.taskReceipt(command);
    }
    if (this.#active.size || options.signal?.aborted) throw new Error("Read task invocation is busy or cancelled before claim");
    const control: ActiveRead = { id: command.executionId, actorId: state.job.actorId, controller: new AbortController(), controllerAllowed: false,
      taskCommand: command, deadlineAt: Date.now() + options.timeoutMs };
    const expire = () => { control.failure ??= new ReadWorkerLeaseFailure("READ_TASK_DEADLINE_OR_CANCELLED"); control.controller.abort(control.failure); };
    options.signal?.addEventListener("abort", expire, { once: true });
    control.timer = setTimeout(expire, options.timeoutMs);
    this.#active.set(control.id, control);
    try {
      control.task = this.process(control);
      await control.task;
      return await this.taskReceipt(command);
    } finally {
      clearTimeout(control.timer); options.signal?.removeEventListener("abort", expire);
      this.#active.delete(control.id); control.controller.abort();
    }
  }
  /** A successful task response only acknowledges authoritative terminal work.
   * A racing delivery that lost the claim must retry, not strand a live run by
   * returning PENDING/RUNNING to the queue as a completed task invocation. */
  private taskReceipt(command: ReadTaskCommand): Promise<Execution> {
    return this.services.repository.readAuthoritative(current => {
      const job = current.readJobs[command.executionId], run = current.executions[command.executionId];
      if (!job || !run || assertReadTaskOutbox(job).taskId !== command.taskId ||
          job.state === "FINISHED" && !["DONE", "FAILED", "CANCELLED"].includes(run.status) ||
          job.state === "RECOVERY_REQUIRED" && run.status !== "RECOVERY_REQUIRED" ||
          !["FINISHED", "RECOVERY_REQUIRED"].includes(job.state))
        throw new Error("Read task has no confirmed terminal receipt; retry original delivery after authoritative recovery");
      return structuredClone(run);
    });
  }
  async start(): Promise<void> {
    requireResidentExecution(this.services.repository);
    if (this.#started) return;
    this.#started = true;
    const jobs = await this.services.repository.read(state => Object.values(state.readJobs).map(job => ({ state: job.state, id: job.executionId })));
    const interrupted = jobs.filter(job => job.state === "CLAIMED").map(job => job.id);
    for (const id of interrupted) {
      await reconcileInterruptedExecutions(this.services.repository, "READ_WORKER_RESTARTED", id);
      await this.services.repository.mutateExecution(id, (state) => {
        const job = state.readJobs[id], item = state.executions[id];
        if (job?.state !== "CLAIMED") return;
        job.state = item && ["DONE", "FAILED", "CANCELLED"].includes(item.status) ? "FINISHED" : "RECOVERY_REQUIRED";
        if (job.state === "FINISHED") { job.finishedAt = item!.completedAt ?? new Date().toISOString(); delete job.inputCiphertext; delete job.inputFields; delete job.lease; }
      });
    }
    if (jobs.some(job => job.state === "QUEUED")) this.kick();
  }
  kick(): void {
    if (!residentExecutionAllowed(this.services.repository) || this.#closed || this.#stalled || this.#scheduled) return;
    if (this.#pumping) { this.#repump = true; return; }
    this.#scheduled = true;
    setImmediate(() => { this.#scheduled = false; void this.pump(); });
  }
  private async pump(): Promise<void> {
    if (!residentExecutionAllowed(this.services.repository) || this.#closed || this.#pumping) return;
    this.#pumping = true;
    try {
      while (!this.#closed && !this.#stalled && this.#active.size < this.#concurrency) {
        const selected = await this.services.repository.readAuthoritative(state => {
          const actors = new Map<string, number>(); for (const control of this.#active.values()) actors.set(control.actorId, (actors.get(control.actorId) ?? 0) + 1);
          const pick = nextFairReadJob(Object.values(state.readJobs).filter(job => !job.taskDispatchSecret && !this.#active.has(job.executionId)), actors, this.#actorRing, this.#perActor);
          return { ...pick, actorId: pick.executionId ? state.readJobs[pick.executionId]!.actorId : undefined };
        });
        this.#actorRing = selected.ring; if (!selected.executionId || !selected.actorId || this.#closed || this.#stalled) break;
        const control: ActiveRead = { id: selected.executionId, actorId: selected.actorId, controller: new AbortController(), controllerAllowed: false };
        this.#active.set(control.id, control);
        control.task = this.process(control).catch(() => { this.#stalled = true; }).finally(() => {
          if (control.timer) clearTimeout(control.timer); this.#active.delete(control.id); this.kick();
        });
      }
    } catch { this.#stalled = true; /* Authoritative claim/selection failure never hot-loops or replays. */ }
    finally { this.#pumping = false; if (this.#repump) { this.#repump = false; this.kick(); } }
  }
  private observe(state: Readonly<RepositoryState>): void {
    for (const control of this.#active.values()) if (control.lease && !control.failure) {
      try {
        const item = state.executions[control.id];
        const lease = assertReadWorkerLease(this.#leaseKey, state.readJobs[control.id], item, control.lease, Date.now(), this.#leaseMs);
        control.lease = structuredClone(lease);
        try { assertCurrentRunController(state as RepositoryState, item!, control.actorId, state.readJobs[control.id]!.admittedRole); control.controllerAllowed = !item!.readProgress?.cancellation; }
        catch { control.controllerAllowed = false; }
      } catch (cause) { control.failure = cause instanceof ReadWorkerLeaseFailure ? cause : new ReadWorkerLeaseFailure(); }
    }
  }
  private workerContext(control: ActiveRead): ReadWorkerContext {
    const assertActive = () => {
      if (this.#closed || this.#stalled || control.failure || control.controller.signal.aborted || control.deadlineAt !== undefined && Date.now() >= control.deadlineAt || !control.lease || Date.now() < Date.parse(control.lease.renewedAt) || Date.now() >= Date.parse(control.lease.expiresAt)) {
        control.failure ??= new ReadWorkerLeaseFailure(); throw control.failure;
      }
    };
    return { assertActive, assertDispatch: () => { assertActive(); if (!control.controllerAllowed) throw new Error("Current queued controller is no longer authorized"); } };
  }
  private heartbeat(control: ActiveRead): void {
    if (control.taskCommand) return; // Fixed task lease; no renewal loop after handler return.
    if (this.#closed || !this.#active.has(control.id)) return;
    control.timer = setTimeout(() => { void (async () => {
      try {
        this.workerContext(control).assertActive();
        await this.services.repository.mutateExecution(control.id, state => {
          this.workerContext(control).assertActive(); const job = state.readJobs[control.id]!, item = state.executions[control.id]!;
          job.lease = renewReadWorkerLease(this.#leaseKey, job, item, control.lease!, Date.now(), this.#leaseMs);
        });
        this.workerContext(control).assertActive(); this.heartbeat(control);
      } catch { control.failure ??= new ReadWorkerLeaseFailure(); control.controller.abort(control.failure); await this.retire(control, "READ_WORKER_LEASE_LOST"); }
    })(); }, Math.floor(this.#leaseMs / 3)); control.timer.unref();
  }
  private async retire(control: ActiveRead, reason: string): Promise<void> {
    try { await this.services.repository.mutateExecution(control.id, state => {
      const job = state.readJobs[control.id], item = state.executions[control.id];
      if (!job || !item || job.workerId !== this.#workerId || job.state !== "CLAIMED" || !job.lease || control.lease && (job.lease.leaseId !== control.lease.leaseId || job.lease.epoch !== control.lease.epoch) || item.readProgress?.epoch !== job.lease.epoch) return;
      reconcileReadExecution(state, item, reason, new Date().toISOString());
      job.state = ["DONE", "FAILED", "CANCELLED"].includes(item.status) ? "FINISHED" : "RECOVERY_REQUIRED";
      if (job.state === "FINISHED") { delete job.inputCiphertext; delete job.inputFields; delete job.lease; }
    }); } catch { /* Persistence remains fenced; startup performs authoritative reconciliation. */ }
  }
  private async process(control: ActiveRead): Promise<void> {
    const expected = await this.services.repository.readAuthoritative(state => state.executions[control.id]?.erpCredentialSecret);
    return withUserMcpBinding(this.services, control.actorId, expected, () => this.processBound(control));
  }
  private async processBound(control: ActiveRead): Promise<void> {
    const id = control.id;
    let initial: Execution | null = null;
    let preparationStage = "CLAIM";
    try {
      const claimed = await this.services.repository.mutateExecution(id, (state) => {
        const job = state.readJobs[id], item = state.executions[id];
        if (job?.state !== "QUEUED") return null;
        if (control.failure || control.controller.signal.aborted) throw new Error("Read task cancelled before claim");
        if (control.taskCommand ? assertReadTaskOutbox(job).taskId !== control.taskCommand.taskId || job.taskDispatchSecret!.state === "PREPARED" : !!job.taskDispatchSecret)
          throw new Error("Read task ownership changed before claim");
        if (item?.status !== "PENDING" || !item.readProgress) throw new Error("Queued job has inconsistent execution state; refusing dispatch");
        job.state = "CLAIMED"; job.workerId = this.#workerId; job.claimedAt = new Date().toISOString();
        item.status = "RUNNING"; item.readProgress.epoch += 1;
        job.lease = issueReadWorkerLease(this.#leaseKey, job, item, this.#workerId, Date.now(), this.#leaseMs);
        appendExecutionEvent(state, item, "run.started", { profile: "read-job-v1", persistence: item.readProgress.persistence });
        appendJobAudit(state, item, "execution.worker_claimed", this.#workerId);
        return { item: structuredClone(item), job: structuredClone(job) };
      });
      if (!claimed) return;
      initial = claimed.item;
      preparationStage = "SOURCE";
      control.lease = claimed.job.lease!; control.controllerAllowed = true; this.heartbeat(control);
      const job = claimed.job, snapshot = initial.workflowSnapshot;
      if (this.#closed || control.controller.signal.aborted || job.version !== 1 || !snapshot || snapshot.contentHash !== workflowContentHash(snapshot.yaml) ||
          job.actorId !== initial.startedBy.id || !readJobHasInput(job)) throw new Error("Invalid queued job");
      if (this.services.config.mcpTransport === "erpbridge-mcp" && this.services.config.mcpMode === "remote" && !snapshot.compilation) throw new Error("Queued modern run has no compiled admission receipt");
      const actor = await this.services.repository.effectiveUser(job.actorId);
      preparationStage = "PUBLICATION";
      const compilation = await this.services.repository.readAuthoritative((state) => {
        assertCurrentRunController(state as RepositoryState, initial!, job.actorId, job.admittedRole);
        const publication = (state.versions[initial!.workflowId] ?? []).findLast((version) => version.version === snapshot.version && version.artifactState === "PUBLISHED");
        if (publication?.yaml !== snapshot.yaml) throw new Error("Pinned publication unavailable");
        return prepareCompiledExecution(state, this.services, publication, snapshot.yaml, job.admittedRole, snapshot.compilation);
      });
      preparationStage = "AUTHORITY_AND_CONNECTION";
      if (!actor || actor.role !== job.admittedRole || snapshot.registryHash !== this.services.registries.hash() ||
          job.connectionFingerprint !== this.connectionFingerprint(snapshot.yaml)) throw new Error("Queued authority, connection or registry changed");
      preparationStage = "PRIVATE_INPUT";
      const privateInput = job.inputFields??JSON.parse(this.#codec.decode(Buffer.from(job.inputCiphertext!, "base64")).toString("utf8")) as { version?: number; executionId?: string; input?: Record<string, unknown> };
      if (privateInput.version !== 1 || privateInput.executionId !== id || !privateInput.input || Array.isArray(privateInput.input) || typeof privateInput.input !== "object") throw new Error("Private job input is not authentic");
      if(canonicalInput(withoutSecretFields(privateInput.input))!==canonicalInput(snapshot.input))throw new Error("Queued input differs from its bound publication snapshot");
      if (initial.snapshotScheduleSource && job.requestFingerprint !== this.digest(JSON.stringify([
        snapshot.version, snapshot.contentHash, canonicalInput(privateInput.input), { snapshotScheduleSource: canonicalInput(initial.snapshotScheduleSource) }
      ]))) throw new Error("Queued snapshot schedule source changed");
      preparationStage = "GOVERNANCE_AND_VALIDATION";
      const gate = await validateWorkflow(this.services, "ReadJobWorker", snapshot.yaml, actor, { traceId: initial.traceId, workflowId: initial.workflowId, executionId: id, signal: control.controller.signal });
      if (!gate.result.passed || !gate.token || gate.token.registry_hash !== snapshot.registryHash) throw new Error("Queued verification failed");
      preparationStage = "LIVE_CONTRACTS";
      const pinnedIds = compilation.plan.ir.root.nodes.map(node => node.capability.admission?.connectionId).filter((value): value is string => !!value);
      const connectionIds = [...new Set(pinnedIds.length ? pinnedIds : parseWorkflowYAMLStrict(snapshot.yaml).steps.map(step => selectedMcpConnectionId(this.services, step.connection_id)))];
      const live = [...new Map((await Promise.all(connectionIds.map(async id => discoverTools(boundMcpConnection(this.services, id).session, this.services.registries))))
        .flatMap(tools => tools.map(tool => [tool.tool_id, tool] as const))).values()];
      if (inspectReadWorkflow(parseWorkflowYAMLStrict(snapshot.yaml), live, actor.role, supportsCollectionReads(this.services)).length) throw new Error("Queued contracts changed");
      preparationStage = "CHECKPOINT_ENTRY";
      this.workerContext(control).assertActive();
      const assertConnection = () => {
        if (job.connectionFingerprint !== this.connectionFingerprint(snapshot.yaml))
          throw new Error("Queued connection binding changed; refusing further dispatch");
      };
      if (compilation.plan.ir.schemaVersion === "workflow-read-ir/v4") await completeCheckpointedCollectionRead(this.services, initial, privateInput.input, gate.token,
        compilation.plan, readIterationBindingKey(this.services), control.controller.signal, assertConnection, this.workerContext(control));
      else await completeCheckpointedRead(this.services, initial, privateInput.input, gate.token, control.controller.signal, assertConnection, compilation.plan, this.workerContext(control));
    } catch (error) {
      // No confirmed claim means this job may still look QUEUED in rolled-back
      // memory. Propagate to stop the pump rather than repeatedly claiming it
      // (or starving the event loop) while storage is fenced.
      if (!initial) throw error;
      if (this.#closed || control.failure || error instanceof ReadWorkerLeaseFailure) { await this.retire(control, this.#closed ? "READ_WORKER_SHUTDOWN" : "READ_WORKER_LEASE_LOST"); return; }
      if (initial) {
        try { await this.services.repository.mutateExecution(id, (state) => {
          const item = state.executions[id];
          // Preparation errors imply no dispatch only when the journal confirms
          // no attempt existed. Other errors were reconciled by checkpoints.
          if (item?.status !== "RUNNING" || item.readProgress?.epoch !== initial!.readProgress!.epoch || Object.keys(item.readProgress.attempts).length) return;
          item.status = item.readProgress.cancellation ? "CANCELLED" : "FAILED"; item.completedAt = new Date().toISOString(); item.durationMs = Math.max(0, Date.parse(item.completedAt) - Date.parse(item.startedAt));
          // Fixed stage names help diagnose safe refusals without exposing raw
          // exception text, input data, connection addresses or credentials.
          item.failure = { failureCategory: "READ_JOB_PREPARATION_FAILED", failedStepId: "preflight", toolWasCalled: false, preparationStage };
          item.agentSummary = "Read job stopped before dispatch because its current authority, input, publication, connection or verification could not be confirmed. No replay was performed.";
          appendExecutionEvent(state, item, "run.completed", { status: item.status, phase: "preparation", outcome: "NOT_DISPATCHED" });
          appendJobAudit(state, item, "execution.completed", this.#workerId);
        }); } catch { /* storage stays fenced */ }
      }
    } finally {
      try { await this.services.repository.mutateExecution(id, (state) => {
        const job = state.readJobs[id], item = state.executions[id];
        if (!job || job.workerId !== this.#workerId || job.state !== "CLAIMED" || !item || job.lease?.leaseId !== control.lease?.leaseId || ["RUNNING", "PENDING"].includes(item.status)) return;
        job.state = item.status === "RECOVERY_REQUIRED" ? "RECOVERY_REQUIRED" : "FINISHED"; job.finishedAt = new Date().toISOString();
        if (job.state === "FINISHED") { delete job.inputCiphertext; delete job.inputFields; delete job.lease; }
      }); } catch { /* No replay/false completion on failed persistence. */ }
    }
  }
  async stop(): Promise<void> {
    this.#closed = true; this.#unobserve();
    const active = [...this.#active.values()]; for (const control of active) { if (control.timer) clearTimeout(control.timer); control.failure ??= new ReadWorkerLeaseFailure("READ_WORKER_SHUTDOWN"); control.controller.abort(control.failure); }
    await Promise.all(active.map(control => this.retire(control, "READ_WORKER_SHUTDOWN")));
    // Bounded invocation teardown must drain the owned task before storage/SDK
    // disposal. Resident workers retain their existing shutdown protocol.
    await Promise.allSettled(active.filter(control => control.taskCommand).map(control => control.task));
  }
}

function appendJobAudit(state: RepositoryState, item: Execution, action: string, workerId: string): void {
  state.auditLogs.push({ id: `audit-${randomBytes(8).toString("hex")}`, source: "read-job-worker", actor: item.startedBy, action,
    resource: { type: "execution", id: item.id }, before: null, after: { status: item.status, workflowId: item.workflowId, workerId },
    createdAt: new Date().toISOString(), ...(item.traceId === undefined ? {} : { traceId: item.traceId }) });
}

function canonicalInput(value: unknown, depth = 0): string {
  if (depth > 16) throw new HandlerFailure(400, "Read job input nesting exceeds supported limits");
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalInput(item, depth + 1)).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalInput((value as Record<string, unknown>)[key], depth + 1)}`).join(",")}}`;
  throw new HandlerFailure(400, "Read job input must be JSON data");
}
