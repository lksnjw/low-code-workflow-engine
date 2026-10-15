import { randomBytes } from "node:crypto";
import { AsyncMutex } from "./async-mutex.js";
import { executionTransaction, applyExecutionCheckpoint, type ExecutionCheckpoint } from "./execution-transaction.js";
import type { Principal, Workflow } from "../models/schemas.js";
import type { ReadCompilationReceipt } from "../workflows/compiled-read.js";
import { assertProtectedContinuation, type ProtectedContinuation } from "./protected-continuation-record.js";
import { assertProtectedInvocationExecution, type ProtectedInvocationLedgerSnapshot } from "./protected-invocation-records.js";
import { assertReadTaskOutbox, type ReadTaskOutbox } from "../runner/read-task-outbox.js";
import { refreshChatReadSummaries } from "../storage/chat-read-summary.js";

export type Role = { id: string; name: string; description: string; permissions: string[]; createdAt: string };
export type User = {
  id: string;
  name: string;
  email: string;
  roleId: string;
  permissionOverrides: string[];
  status: string;
  initials: string;
  timezone?: string;
  departmentId: string | null;
  /** Optional authoritative reporting-line relationship used for safe
   * recipient resolution. It is never inferred from role names. */
  managerId?: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  twoFactorEnabled?: boolean;
  emailVerified?: boolean;
};

export type Execution = {
  erpCredentialSecret?: import("../tools/user-mcp-credentials.js").UserCredentialBinding;
  id: string;
  workflowId: string;
  workflowName: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  durationMs: number;
  tokens: { input: number; output: number; total: number };
  costUsd: number;
  startedBy: Principal;
  failure?: Record<string, unknown>;
  stepOutputs?: Record<string, unknown>;
  finalOutput?: unknown;
  // The executing agent's own final narration for this run (e.g. explaining
  // it stopped at a human approval checkpoint) — distinct from finalOutput,
  // which may just be the last tool result.
  agentSummary?: string;
  // Set while status is AWAITING_APPROVAL — the human-in-the-loop checkpoint
  // execution is currently paused at.
  pendingApproval?: { stepId: string; description: string; requestedAt: string; invocationId?: string;
    iterations?: Array<{ loopId: string; index: number }> };
  // Every approval granted so far on this execution, oldest first — so a
  // resumed run (and the agent) knows what's already been authorized.
  approvals?: Array<{ stepId: string; approvedBy: { id: string; name: string }; approvedAt: string; note?: string }>;
  chatSessionId?: string;
  traceId?: string;
  workflowSnapshot?: { version: number; contentHash: string; registryHash: string; yaml: string; input: Record<string, unknown>; executionProfile: "sequential-read-v1" | "conditional-read-v1" | "structured-read-v1" | "collection-read-v1" | "sequential-operation-v1" | "protected-operation-v1"; compilation?: ReadCompilationReceipt;
    operationCompilation?: import("../workflows/compiled-read.js").OperationCompilationReceipt;
    protectedCompilation?: import("../workflows/protected-operation-publication.js").ProtectedOperationPublicationReceipt };
  valueOutputs?: Record<string, { value: unknown }>;
  readProgress?: ReadRunProgress;
  iterationProgress?: import("../runner/read-iteration-checkpoints.js").ReadIterationLedger;
  // Protected transaction payload/journal, excluded by every common secret
  // projection. Only the minimal, current-authority review endpoint exposes it.
  runtimeApprovalSecret?: import("../runner/runtime-approvals.js").RuntimeApprovalLedger;
  protectedApprovalSecret?: import("./protected-approval-records.js").ProtectedApprovalRecords;
  operationSecret?: import("../runner/operation-state.js").OperationJournal;
  /** Separate invocation-based private DATA, never a v8 node-key journal.
   * Future collection worker/admission must establish its authority. */
  protectedInvocationSecret?: ProtectedInvocationLedgerSnapshot;
  protectedJobSecret?: import("./protected-job-record.js").ProtectedOperationJob;
  /** Versioned private agent dialogue DATA; never a broker or model permit. */
  protectedAgentSecret?: import("./protected-agent-records.js").ProtectedAgentRecords;
  recoverySource?: { profile: "operation-recovery-source/v1"; sourceExecutionId: string; artifactId: string; artifactHash: string };
  retrySource?: { profile: "execution-retry-source/v1"; sourceExecutionId: string; sourceVersion: number; sourceHash: string; acknowledgedUnconfirmedReads: boolean };
  emailDeliverySource?: { profile: "email-delivery-source/v1"; admissionId: string; sessionId: string; draftId: string; draftVersion: number; draftHash: string };
  scheduleSource?: { profile: "workflow-schedule-source/v1"; scheduleId: string; scheduleRevision: number; occurrenceId: string; scheduledFor: string;
    scheduleHash: string; reportWindow: ReportWindow; reportWindowBinding: ReportWindowInputBinding; inputHash: string };
  /** A bounded current-state read, not evidence of complete date-range coverage. */
  snapshotScheduleSource?: { profile: "workflow-snapshot-schedule-source/v1"; scheduleId: string; scheduleRevision: number; occurrenceId: string;
    scheduledFor: string; scheduleHash: string; inputHash: string };
  /** Connector-attested complete coverage for the immutable schedule window.
   * This is evidence, not permission to dispatch the later effect. */
  reportCoverage?: import("../tools/report-coverage-contract.js").ReportCoverageReceipt;
  /** Every schedule-qualified report read, keyed by immutable node ID. The
   * singular field remains the primary/legacy projection for compatibility. */
  reportCoverages?: Record<string, import("../tools/report-coverage-contract.js").ReportCoverageReceipt>;
  /** Private durable page accumulator, normalized separately while a bounded
   * server-owned report pagination node is in progress. */
  reportPageSecret?: Record<string, import("../tools/report-coverage-contract.js").ReportPaginationProgress>;
};

export type EmailDeliveryAdmission = {
  profile: "email-delivery-admission-private/v1";
  id: string;
  sessionId: string;
  draftId: string;
  draftVersion: number;
  draftHash: string;
  actorId: string;
  toolId: string;
  contractHash: string;
  keyHash: string;
  requestFingerprint: string;
  workflowId: string;
  executionId: string;
  createdAt: string;
};

export type ReadRunAttempt = { id: string; nodeId: string; stepIndex: number; status: "PREPARING" | "DISPATCH_INTENT" | "DONE" | "FAILED" | "UNKNOWN" | "CANCELLED" | "SKIPPED";
  invocationId?: string; iterations?: import("../workflows/read-interpreter.js").ReadVisit["iterations"];
  startedAt: string; dispatchIntentAt?: string; completedAt?: string };
export type ReadRunProgress = { profile: "read-progress-v1"; epoch: number; nextStepIndex: number; lastSequence: number;
  persistence: "durable" | "memory-only"; attempts: Record<string, ReadRunAttempt>;
  decisions?: Record<string, { status: "DONE" | "FAILED"; selected?: "then" | "else"; evaluatedAt: string; stepIndex: number }>;
  values?: Record<string, import("../workflows/read-control-flow.js").ReadValueReceipt>;
  cancellation?: { requestedAt: string; requestedBy: Principal }; recoveryReason?: string };
export type ExecutionEvent = { version: 1; executionId: string; workflowId: string; sequence: number; timestamp: string; type: string;
  traceId?: string; nodeId?: string; attemptId?: string; payload: Record<string, unknown> };
// Worker inputs never enter public executions; native mode seals only credentials.
export type ReadJob = { version: 1; executionId: string; actorId: string; admittedRole: string; state: "QUEUED" | "CLAIMED" | "FINISHED" | "RECOVERY_REQUIRED";
  /** Private queue dispatch DATA, not a lease or permission to call ERP. */
  taskDispatchSecret?: ReadTaskOutbox;
  inputCiphertext?: string; inputFields?: {version:1;executionId:string;input:Record<string,unknown>}; requestFingerprint: string; idempotencyScope: string; connectionFingerprint: string; createdAt: string; queueSequence?: number; claimedAt?: string; finishedAt?: string; workerId?: string;
  lease?: import("../runner/read-worker-lease.js").ReadWorkerLease };

export type Permission = { key: string; name: string; description: string; group: string };
export type ChatAttempt = { id: string; toolName: string; argumentHash: string; status: "PREPARING" | "DISPATCH_INTENT" | "DONE" | "FAILED" | "UNKNOWN"; startedAt: string; completedAt?: string; output?: Record<string, unknown> };
/** Model receipts stay outside public DTOs; native mode does not encrypt normal response text. */
export type ChatModelAttempt = { id: string; taskId: string; workerId: string; epoch: number; expiresAt: string;
  ordinal: number; requestHash: string; configurationFingerprint: string; configurationRevision: string;
  model: string; promptTemplateVersion: string; egress: import("../providers/egress-policy.js").ModelEgressDeclaration;
  status: "DISPATCH_INTENT" | "DONE" | "FAILED" | "UNKNOWN"; startedAt: string; completedAt?: string;
  resultCiphertext?: string; resultFields?: Record<string,unknown>; provenanceId: string; purpose?: "QUERY" | "SYNTHESIS" | "NODE_PROPOSAL" | "POLICY_PREFLIGHT" };
export type ChatOperation = { version: 1; id: string; sessionId: string; actorId: string; userMessageId: string; assistantMessageId?: string;
  erpCredentialSecret?: import("../tools/user-mcp-credentials.js").UserCredentialBinding;
  status: "QUEUED" | "RUNNING" | "ANSWERED" | "FAILED" | "CANCELLED" | "RECOVERY_REQUIRED"; stage: string; epoch: number; lastSequence: number;
  createdAt: string; updatedAt: string; finishedAt?: string; traceId: string; persistence: "memory-only" | "durable";
  inputCiphertext?: string; idempotencyScope: string; requestFingerprint: string; connectionFingerprint: string; contractFingerprint: string; authorityFingerprint: string;
  modelBinding: { providerId: string; providerName: string; model: string; configurationRevision: string } | null;
  workerId?: string; cancellationRequested?: boolean; reason?: string; attempts: ChatAttempt[];
  nodeContext?: { workflowId: string; nodeId: string; baseVersion: number; baseHash: string };
  requestRevision?: import("../agent/chat-request-revisions.js").ChatRequestRevision;
  revisionContextCiphertext?: string;
  // Native business inputs stay readable; credential members are sealed by the
  // record codec. These private inputs never enter public operation DTOs.
  inputFields?: Record<string, unknown>;
  revisionContextFields?: Record<string, unknown>;
  contentStorageProfile?: "native-business-content/v1";
  modelAttemptsSecret?: ChatModelAttempt[];
  taskDispatchSecret?: import("../agent/chat-task-outbox.js").ChatTaskOutbox;
  taskLeaseSecret?: { profile: "chat-task-lease/v1"; workerId: string; epoch: number; claimedAt: string; expiresAt: string };
  artifactRefs?: Array<{ type: "workflow-draft" | "node-proposal" | "workflow-proposal"; id: string }> };
export type ChatOperationEvent = { version: 1; operationId: string; sessionId: string; sequence: number; timestamp: string; stage: string; type: string; attemptId?: string; status?: string };
export type StoredRecord = Record<string, unknown>;
export type ChatSessionRecord = {
  id: string;
  ownerId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  selectedModel?: string;
  messages: StoredRecord[];
  readSummary?: import("../storage/chat-read-summary.js").ChatReadSummary;
};

export type WorkflowSchedule = {
  profile: "workflow-daily-schedule/v1" | "workflow-calendar-schedule/v2" | "workflow-snapshot-schedule/v1";
  id: string;
  workflowId: string;
  workflowVersion: number;
  workflowHash: string;
  state: "ACTIVE" | "PAUSED" | "BLOCKED";
  revision: number;
  timezone: string;
  localTime: string;
  /** Missing only on legacy daily v1 records. */
  cadence?: "daily" | "weekly" | "monthly";
  /** ISO weekday (Monday=1 ... Sunday=7), present for weekly v2 records. */
  dayOfWeek?: number;
  /** Restricted to 1..28 so every calendar month has an occurrence. */
  dayOfMonth?: number;
  reportingPeriod: "previous-calendar-day" | "previous-calendar-week" | "previous-calendar-month" | "snapshot";
  misfirePolicy: "SKIP" | "FIRE_ONCE";
  misfireGraceSeconds: number;
  servicePrincipalId: string;
  input: Record<string, unknown>;
  /** Missing only on legacy records. Such a record cannot admit a new run. */
  reportWindowBinding?: ReportWindowInputBinding;
  nextRunAt: string | null;
  lastOccurrenceAt?: string;
  lastError?: string;
  createdBy: Principal;
  createdAt: string;
  updatedAt: string;
  scheduleHash: string;
};
export type ReportWindow = {
  profile: "workflow-report-window/v1";
  reportingPeriod: "previous-calendar-day" | "previous-calendar-week" | "previous-calendar-month";
  timezone: string;
  /** Inclusive first local date covered by the half-open UTC interval. */
  localDate: string;
  /** Inclusive final local date for multi-day periods; absent for legacy/day windows. */
  localEndDate?: string;
  startAt: string;
  endAt: string;
};
export type ReportWindowInputBinding = {
  profile: "workflow-report-window-input-binding/v1";
  startAtInput: string;
  endAtInput: string;
};
export type ScheduleOccurrence = {
  profile: "workflow-schedule-occurrence/v1";
  id: string;
  scheduleId: string;
  scheduleRevision: number;
  workflowId: string;
  workflowVersion: number;
  workflowHash: string;
  scheduledFor: string;
  localDate: string;
  timezone: string;
  reportWindow?: ReportWindow;
  servicePrincipalId: string;
  state: "ADMITTING" | "ADMITTED" | "SKIPPED" | "BLOCKED";
  idempotencyKey: string;
  createdAt: string;
  executionId?: string;
  admittedAt?: string;
  reason?: string;
};

export type InvocationProvenanceRecord = {
  id: string;
  inferenceProfile?: "openrouter-deepseek-interactive-fast/v1" | "openrouter-qwen-interactive-fast/v1" | "openrouter-gemini-bounded-low/v1";
  promptTemplateVersion: string;
  promptSha256: string;
  provider: string;
  providerId?: string;
  configurationRevision?: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  measured: boolean;
  latencyMs: number;
  temperature: number;
  fallbackUsed: boolean;
  status: "SUCCEEDED" | "FAILED";
  createdAt: string;
  traceId?: string;
  sessionId?: string;
  messageId?: string;
  candidateId?: string;
  workflowId?: string;
  executionId?: string;
  actor?: { id: string; role: string };
  egress?: { purpose: "interactive" | "runtime_analysis" | "runtime_agent"; dataClass: "public" | "internal" | "confidential" | "restricted" };
};

// Private interpreter/evidence state; never part of public execution payloads.
export type ReadContinuation = { profile: "read-continuation/v1"; executionId: string; ciphertext: string };
export function assertReadContinuation(value: unknown, id: string): asserts value is ReadContinuation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid private read continuation");
  const record = value as ReadContinuation;
  if (record.profile !== "read-continuation/v1" || record.executionId !== id || typeof record.ciphertext !== "string" || !record.ciphertext.length || record.ciphertext.length > 5_400_000 || Object.keys(record).some(key => !["profile", "executionId", "ciphertext"].includes(key))) throw new Error("Invalid private read continuation identity or bounds");
}
export type RepositoryState = {
  version: 1;
  counter: number;
  users: Record<string, User>;
  passwordHashes: Record<string, string>;
  roles: Record<string, Role>;
  permissions: Permission[];
  workflows: Record<string, Workflow>;
  versions: Record<string, StoredRecord[]>;
  templates: Record<string, StoredRecord>;
  executions: Record<string, Execution>;
  executionLogs: Record<string, StoredRecord[]>;
  executionEvents: Record<string, ExecutionEvent[]>;
  readJobs: Record<string, ReadJob>;
  readContinuations: Record<string, ReadContinuation>;
  /** Separate private profile; never an execution answer or a legacy cursor. */
  protectedContinuations: Record<string, ProtectedContinuation>;
  chatOperations: Record<string, ChatOperation>;
  chatOperationEvents: Record<string, ChatOperationEvent[]>;
  schedules: Record<string, WorkflowSchedule>;
  scheduleOccurrences: Record<string, ScheduleOccurrence>;
  emailDeliveryAdmissions: Record<string, EmailDeliveryAdmission>;
  timelines: Record<string, StoredRecord[]>;
  healing: Record<string, StoredRecord>;
  chats: Record<string, ChatSessionRecord>;
  /** Private creation receipts survive deletion, so late retries cannot resurrect a chat. */
  chatCreationReceipts: Record<string, { profile: "chat-creation/v1"; ownerId: string; sessionId: string; requestHash: string }>;
  invocationProvenance: Record<string, InvocationProvenanceRecord>;
  governancePolicy: StoredRecord | null;
  company: StoredRecord | null;
  providers: Record<string, StoredRecord>;
  integrations: Record<string, StoredRecord>;
  capabilityObservations: Record<string, StoredRecord>;
  capabilityRevisions: Record<string, StoredRecord>;
  capabilityAdmissions: Record<string, StoredRecord>;
  mcpConnections: Record<string, StoredRecord>;
  mcpConnectionOperations: Record<string, StoredRecord>;
  userMcpCredentials: Record<string, StoredRecord>;
  webhooks: Record<string, StoredRecord>;
  refreshSessions: Record<string, { userId: string; expiresAt: string }>;
  auditLogs: Record<string, unknown>[];
  settings: Record<string, unknown>;
  notifications: Record<string, StoredRecord>;
  notificationPreferences: Record<string, StoredRecord>;
  apiKeys: Record<string, StoredRecord>;
  uploads: Record<string, StoredRecord>;
  uploadContents: Record<string, string>;
  importHistory: StoredRecord[];
  registryContextHistory: StoredRecord[];
};

export interface PersistenceBackend {
  /** Trusted server-only synchronous final-entry check and denial signal.
   * Neither may perform I/O or grant authority from a pending renewal. */
  assertAuthority?(): void;
  observeUnavailable?(observer: () => void): () => void;
  // Capability of the actual storage implementation, not a config assertion.
  readonly readQueueDurability?: "encrypted-single-writer";
  readonly executionCheckpointDurability?: "encrypted-record-transactions/v1";
  saveExecutionCheckpoint?(checkpoint: ExecutionCheckpoint): Promise<void>;
  load(): Promise<Uint8Array | null>;
  save(payload: Uint8Array): Promise<void>;
  probe(): Promise<void>;
  close(): Promise<void>;
}

export class Repository {
  readonly #mutex = new AsyncMutex();
  #state: RepositoryState;
  #healthy = true;
  #writeUncertain = false;
  #closed = false;
  #unsubscribeAuthority: (() => void) | undefined;
  readonly #commitObservers = new Set<{ committed(state: Readonly<RepositoryState>): void; unavailable(): void }>();

  /** Server-only denial signals, synchronously delivered after acknowledged
   * commits/reloads and before uncertain-write failures are exposed. They grant
   * no dispatch authority and may never perform I/O or repository mutations. */
  observeCommits(observer: { committed(state: Readonly<RepositoryState>): void; unavailable(): void }): () => void {
    this.#commitObservers.add(observer); return () => { this.#commitObservers.delete(observer); };
  }
  private notifyCommitObservers(available: boolean): void {
    for (const observer of this.#commitObservers) {
      try { if (available) observer.committed(this.#state); else observer.unavailable(); }
      catch { try { observer.unavailable(); } catch { /* Observer cannot change an acknowledged persistence outcome. */ } }
    }
  }

  /*******************************************************************************
   * Function: constructor
   *
   * Initializes a Repository instance with its required state.
   ******************************************************************************/
  constructor(readonly persistence: PersistenceBackend | null = null, initial = initialState()) {
    this.#state = structuredClone(initial);
    this.#unsubscribeAuthority = persistence?.observeUnavailable?.(() => this.storageUnavailable());
  }
  private storageUnavailable(): void {
    if (!this.#healthy) return;
    this.#healthy = false; this.notifyCommitObservers(false);
  }
  private assertPersistenceAuthority(): void {
    if (this.#closed) throw new Error("Authoritative storage is closed; dispatch is fenced");
    try { this.persistence?.assertAuthority?.(); }
    catch { this.storageUnavailable(); throw new Error("Authoritative storage ownership is unavailable; dispatch is fenced"); }
  }
  /** Synchronous guard for SDK entry after final awaited work.
   * Cached identities/worker leases cannot outlive persistence authority. */
  assertAuthority(): void {
    this.assertPersistenceAuthority();
    if (this.#writeUncertain || !this.#healthy) throw new Error("Authoritative storage is unavailable; dispatch is fenced");
  }

  /*******************************************************************************
   * Function: open
   *
   * Opens the repository and restores persisted state when available.
   ******************************************************************************/
  static async open(persistence: PersistenceBackend | null): Promise<Repository> {
    if (persistence === null) return new Repository(null);
    let repository: Repository | undefined;
    try {
      const payload = await persistence.load();
      persistence.assertAuthority?.();
      const restored = payload === null ? initialState() : restoreState(payload);
      repository = new Repository(persistence, restored);
      // Write back only on first boot or an actual schema normalization.
      const serialized = Buffer.from(JSON.stringify(restored), "utf8");
      if (payload === null || !Buffer.from(payload).equals(serialized)) await persistence.save(serialized);
      repository.assertAuthority(); return repository;
    } catch (error) {
      // Authority-owning adapters must not survive failed initialization.
      // Legacy adapters retain their explicit caller-owned migration lifecycle.
      if (persistence.assertAuthority) try { if (repository) await repository.close(); else await persistence.close(); } catch { /* preserve original failure; never publish late authority */ }
      throw error;
    }
  }

  /*******************************************************************************
   * Function: snapshot
   *
   * Returns a copy of the current repository state.
   ******************************************************************************/
  async snapshot(): Promise<RepositoryState> {
    return this.#mutex.runExclusive(() => {
      if (this.persistence?.assertAuthority) this.assertPersistenceAuthority();
      return structuredClone(this.#state);
    });
  }

  /*******************************************************************************
   * Function: read
   *
   * Runs a read operation against the repository state.
   ******************************************************************************/
  async read<T>(reader: (state: Readonly<RepositoryState>) => T): Promise<T> {
    return this.#mutex.runExclusive(async () => {
      if (this.persistence?.assertAuthority) this.assertPersistenceAuthority();
      const result = await reader(this.#state);
      if (this.persistence?.assertAuthority) this.assertPersistenceAuthority();
      return result;
    });
  }

  /** Security decisions must not use the rolled-back local image after an
   * uncertain durable save (for example, a remotely committed revocation). */
  async readAuthoritative<T>(reader: (state: Readonly<RepositoryState>) => T): Promise<T> {
    return this.#mutex.runExclusive(async () => {
      this.assertAuthority(); const result = await reader(this.#state); this.assertAuthority(); return result;
    });
  }

  /*******************************************************************************
   * Function: mutate
   *
   * Applies a serialized repository mutation and persists the updated state.
   ******************************************************************************/
  async mutate<T>(mutation: (state: RepositoryState) => Promise<T> | T): Promise<T> {
    return this.#mutex.runExclusive(async () => {
      if (this.#writeUncertain) throw new Error("Persistence outcome is uncertain; reload authoritative storage before further mutations");
      this.assertPersistenceAuthority();
      const before = structuredClone(this.#state);
      let persistenceAttempted = false;
      try {
        const result = await mutation(this.#state);
        refreshChatReadSummaries(before.chats, this.#state.chats);
        this.assertPersistenceAuthority();
        if (this.persistence !== null) {
          const bytes = Buffer.from(JSON.stringify(this.#state), "utf8");
          persistenceAttempted = true;
          await this.persistence.save(bytes);
        }
        this.assertPersistenceAuthority();
        this.#healthy = true;
        this.notifyCommitObservers(true);
        return result;
      } catch (error) {
        this.#state = before;
        if (persistenceAttempted) { this.#writeUncertain = true; this.storageUnavailable(); }
        throw error;
      }
    });
  }

  /** Scoped server checkpoint: current authority stays visible under the same
   * mutation lock, but unrelated objects cannot be written or deep-cloned.
   * Legacy durable stores explicitly retain aggregate serialization. */
  async mutateExecution<T>(executionId: string, mutation: (state: RepositoryState) => Promise<T> | T): Promise<T> {
    return this.#mutex.runExclusive(async () => {
      if (this.#writeUncertain || !this.#healthy) throw new Error("Authoritative storage is unavailable; execution checkpoint is fenced");
      this.assertPersistenceAuthority();
      const transaction = executionTransaction(this.#state, executionId);
      let persistenceAttempted = false;
      try {
        const result = structuredClone(await mutation(transaction.view)), checkpoint = transaction.checkpoint();
        this.assertPersistenceAuthority();
        const updated = applyExecutionCheckpoint(this.#state, checkpoint);
        if (this.persistence !== null) {
          persistenceAttempted = true;
          if (this.persistence.executionCheckpointDurability === "encrypted-record-transactions/v1" && this.persistence.saveExecutionCheckpoint)
            await this.persistence.saveExecutionCheckpoint(checkpoint);
          else await this.persistence.save(Buffer.from(JSON.stringify(updated), "utf8"));
        }
        this.assertPersistenceAuthority();
        this.#state = updated; this.#healthy = true;
        this.notifyCommitObservers(true);
        return result;
      } catch (error) {
        if (persistenceAttempted) { this.#writeUncertain = true; this.storageUnavailable(); }
        throw error;
      }
    });
  }

  /** A save can commit remotely before its acknowledgement fails. Never write
   * a rolled-back aggregate over that state. Only a successful authoritative
   * reload clears the write fence; an ordinary health probe cannot do so. */
  async recoverPersistenceState(): Promise<void> {
    await this.#mutex.runExclusive(async () => {
      if (!this.#writeUncertain) return;
      if (this.persistence === null) throw new Error("Uncertain persistence has no durable backend");
      const payload = await this.persistence.load();
      if (payload === null) throw new Error("Authoritative repository state is unavailable");
      const restored = restoreState(payload);
      this.assertPersistenceAuthority();
      this.#state = restored;
      this.#writeUncertain = false; this.#healthy = true;
      this.notifyCommitObservers(true);
    });
  }

  /*******************************************************************************
   * Function: persistenceStatus
   *
   * Probes persistence and reports durability and health.
   ******************************************************************************/
  async persistenceStatus(): Promise<{ durable: boolean; healthy: boolean }> {
    if (this.persistence === null) return { durable: false, healthy: true };
    try {
      this.assertPersistenceAuthority();
      await this.persistence.probe();
      this.assertPersistenceAuthority();
      this.#healthy = true;
    } catch {
      this.storageUnavailable();
    }
    return { durable: true, healthy: this.#healthy && !this.#writeUncertain };
  }

  /*******************************************************************************
   * Function: nextID
   *
   * Allocates a unique prefixed identifier through a repository mutation.
   ******************************************************************************/
  async nextID(prefix: string): Promise<string> {
    return this.mutate((state) => {
      state.counter += 1;
      return `${prefix}_${state.counter}_${randomBytes(4).toString("hex")}`;
    });
  }

  /*******************************************************************************
   * Function: close
   *
   * Closes the repository's persistence backend when configured.
   ******************************************************************************/
  async close(): Promise<void> {
    if (this.#closed) return; this.#closed = true;
    this.storageUnavailable(); this.#unsubscribeAuthority?.();
    await this.persistence?.close();
  }

  /*******************************************************************************
   * Function: effectiveUser
   *
   * Returns a user with the permissions granted by its role and overrides.
   ******************************************************************************/
  async effectiveUser(userId: string): Promise<(User & { role: string; permissions: string[] }) | null> {
    return this.read((state) => effectiveUserFromState(state, userId));
  }
}

/** Pure current-state identity projection. Token roles/permissions are not
 * authority, and a snapshot reader is not a writable Repository. */
export function effectiveUserFromState(state: Readonly<RepositoryState>, userId: string): (User & { role: string; permissions: string[] }) | null {
  const user = state.users[userId];
  if (user === undefined) return null;
  const role = state.roles[user.roleId];
  const permissions = [...new Set([...(role?.permissions ?? []), ...user.permissionOverrides].filter((item) => item !== ""))];
  return { ...structuredClone(user), role: role?.name ?? "", permissions };
}

/*******************************************************************************
 * Function: restoreState
 *
 * Validates and restores a serialized repository state.
 ******************************************************************************/
export function restoreState(payload: Uint8Array): RepositoryState {
  const decoded: unknown = JSON.parse(Buffer.from(payload).toString("utf8"));
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) throw new Error("stored repository state must be a JSON object");
  const source = decoded as Partial<RepositoryState>;
  if (source.version !== 1) throw new Error(`unsupported stored repository version ${String(source.version)}`);
  const defaults = initialState();
  const restored: RepositoryState = { ...defaults, ...source } as RepositoryState;
  if (!restored.chatCreationReceipts || typeof restored.chatCreationReceipts !== "object" || Array.isArray(restored.chatCreationReceipts)) throw new Error("Invalid chat creation receipts");
  for (const [key, receipt] of Object.entries(restored.chatCreationReceipts)) {
    if (!/^[a-f0-9]{64}$/.test(key) || !receipt || receipt.profile !== "chat-creation/v1" || typeof receipt.ownerId !== "string" || !receipt.ownerId || typeof receipt.sessionId !== "string" || !receipt.sessionId || !/^[a-f0-9]{64}$/.test(receipt.requestHash)) throw new Error("Invalid chat creation receipt");
  }
  for (const key of ["users", "passwordHashes", "roles", "workflows", "versions", "templates", "executions", "executionLogs", "executionEvents", "readJobs", "chatOperations", "chatOperationEvents", "schedules", "scheduleOccurrences", "emailDeliveryAdmissions", "timelines", "healing", "chats", "invocationProvenance", "providers", "integrations", "webhooks", "refreshSessions", "notifications", "notificationPreferences", "apiKeys", "uploads", "uploadContents"] as const) {
    if (typeof restored[key] !== "object" || restored[key] === null || Array.isArray(restored[key])) restored[key] = defaults[key] as never;
  }
  if (restored.governancePolicy !== null && (typeof restored.governancePolicy !== "object" || Array.isArray(restored.governancePolicy))) restored.governancePolicy = null;
  for (const key of ["capabilityObservations", "capabilityRevisions", "capabilityAdmissions", "mcpConnections", "mcpConnectionOperations", "userMcpCredentials"] as const)
    if (typeof restored[key] !== "object" || restored[key] === null || Array.isArray(restored[key])) throw new Error(`Invalid stored ${key}; admission recovery requires repair`);
  if (!restored.readContinuations || typeof restored.readContinuations !== "object" || Array.isArray(restored.readContinuations)) throw new Error("Invalid private read continuation map");
  for (const [id, record] of Object.entries(restored.readContinuations)) { assertReadContinuation(record, id); if (!Object.hasOwn(restored.executions, id)) throw new Error("Orphan private read continuation"); }
  if (!restored.protectedContinuations || typeof restored.protectedContinuations !== "object" || Array.isArray(restored.protectedContinuations)) throw new Error("Invalid private protected continuation map");
  for (const [id, record] of Object.entries(restored.protectedContinuations)) {
    assertProtectedContinuation(record, id);
    if (!Object.hasOwn(restored.executions, id)) throw new Error("Orphan private protected continuation");
    if (Object.hasOwn(restored.readContinuations, id)) throw new Error("Conflicting private continuation profiles");
  }
  for (const run of Object.values(restored.executions)) assertProtectedInvocationExecution(run);
  for (const [id, job] of Object.entries(restored.readJobs)) if (Object.hasOwn(job, "taskDispatchSecret")) {
    if (job.executionId !== id || !Object.hasOwn(restored.executions, id)) throw new Error("Orphan read task outbox");
    assertReadTaskOutbox(job);
  }
  for (const role of Object.values(defaults.roles)) if (restored.roles[role.id] === undefined) restored.roles[role.id] = role;
  const knownPermissions = new Set(restored.permissions.map((item) => item.key));
  for (const permission of defaults.permissions) if (!knownPermissions.has(permission.key)) restored.permissions.push(permission);
  const defaultAdmin = defaults.roles.role_admin;
  const restoredAdmin = restored.roles.role_admin;
  // Grant only when introducing the permission to a legacy snapshot. Once the
  // permission exists, an administrator's explicit revocation must survive reload.
  if (!knownPermissions.has("pipeline:upload") && defaultAdmin?.permissions.includes("pipeline:upload") && restoredAdmin && !restoredAdmin.permissions.includes("pipeline:upload"))
    restoredAdmin.permissions = [...restoredAdmin.permissions, "pipeline:upload"];
  restored.counter = Math.max(0, Number.isInteger(restored.counter) ? restored.counter : 0);
  return restored;
}

/*******************************************************************************
 * Function: initialState
 *
 * Builds the initial repository state with default roles and permissions.
 ******************************************************************************/
export function initialState(): RepositoryState {
  const createdAt = new Date().toISOString();
  const permissionKeys = ["workflow:read", "workflow:write", "workflow:run", "workflow:read_own", "workflow:run_own", "execution:read_own", "execution:approve", "execution:reconcile", "workflow_view_all", "chat:use", "pipeline:upload", "registry:read", "registry:write", "settings:manage", "provider:manage", "user:manage", "audit:read"];
  const permissions = permissionKeys.map((key) => ({ key, name: permissionName(key), description: permissionDescription(key), group: permissionGroup(key) }));
  return {
    version: 1,
    counter: 0,
    users: {},
    passwordHashes: {},
    refreshSessions: {},
    workflows: {},
    versions: {},
    templates: {},
    executions: {},
    executionLogs: {},
    executionEvents: {},
    readJobs: {},
    readContinuations: {},
    protectedContinuations: {},
    chatOperations: {},
    chatOperationEvents: {},
    schedules: {},
    scheduleOccurrences: {},
    emailDeliveryAdmissions: {},
    timelines: {},
    healing: {},
    chats: {},
    chatCreationReceipts: {},
    invocationProvenance: {},
    governancePolicy: null,
    company: null,
    providers: {},
    integrations: {},
    capabilityObservations: {},
    capabilityRevisions: {},
    capabilityAdmissions: {},
    mcpConnections: {},
    mcpConnectionOperations: {},
    userMcpCredentials: {},
    webhooks: {},
    auditLogs: [],
    settings: { general: {}, llm: {}, rbac: {} },
    notifications: {},
    notificationPreferences: {},
    apiKeys: {},
    uploads: {},
    uploadContents: {},
    importHistory: [],
    registryContextHistory: [],
    permissions,
    roles: {
      role_admin: { id: "role_admin", name: "Platform Admin", description: "Full platform access", permissions: permissionKeys, createdAt },
      role_system_admin: { id: "role_system_admin", name: "System Admin", description: "System administration", permissions: ["user:manage", "registry:read", "audit:read"], createdAt },
      role_builder: { id: "role_builder", name: "Workflow Builder", description: "Workflow creation", permissions: ["workflow:read", "workflow:write", "workflow:run", "workflow_view_all", "chat:use", "registry:read"], createdAt },
      role_client: { id: "role_client", name: "Client", description: "Assigned workflow access", permissions: ["chat:use", "workflow:read_own", "workflow:run_own", "execution:read_own"], createdAt },
    },
  };
}

/*******************************************************************************
 * Function: permissionName
 *
 * Formats a permission key as a readable name.
 ******************************************************************************/
function permissionName(key: string): string {
  return key.split(/[._:]/).map((part) => part.length === 0 ? part : `${part[0]!.toUpperCase()}${part.slice(1)}`).join(" ");
}

/*******************************************************************************
 * Function: permissionGroup
 *
 * Assigns a permission key to its display group.
 ******************************************************************************/
function permissionGroup(key: string): string {
  if (key.startsWith("workflow") || key.startsWith("execution") || key.startsWith("chat")) return "Workflow";
  if (key.startsWith("registry")) return "Registry";
  if (key.startsWith("pipeline")) return "Data Pipeline";
  if (key.startsWith("user") || key.startsWith("audit")) return "Administration";
  return "Settings";
}

/*******************************************************************************
 * Function: permissionDescription
 *
 * Returns a description for a permission key.
 ******************************************************************************/
function permissionDescription(key: string): string {
  const descriptions: Record<string, string> = {
    "workflow:run": "Start, cancel, and retry workflow executions",
    "workflow:read": "Read all workflows",
    "workflow:write": "Create and update workflows",
    "pipeline:upload": "Upload and index files for governed ERP-agent retrieval",
    "user:manage": "Manage users and roles",
    "audit:read": "Read the audit log",
  };
  return descriptions[key] ?? permissionName(key);
}
