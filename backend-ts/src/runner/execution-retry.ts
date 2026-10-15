import type { Workflow } from "../models/schemas.js";
import type { Execution, RepositoryState } from "../repository/store.js";
import { canonicalJSONBytes } from "../core/canonical-json.js";
import { workflowContentHash } from "../parser/workflow.js";
import { HandlerFailure, type CurrentUser } from "../http/handlers/common.js";
import { assertCurrentRunController } from "./read-checkpoints.js";
import type { StoredOperationCompilation } from "../workflows/operation-compilation-lifecycle.js";

export type ExecutionRetryRequest = { sourceExecutionId: string; acknowledgeUnconfirmed: boolean };
function deny(reason: string): never { throw new HandlerFailure(409, reason, { code: "EXECUTION_RETRY_BLOCKED" }); }

/** A restart is a new run, never continuation or replay of an old intent.
 * A whole-workflow restart is unsafe after ANY potentially entered effect,
 * including an acknowledged effect before a later read/model failure. */
function inspect(state: Readonly<RepositoryState>, workflow: Workflow, user: CurrentUser, sourceId: string, reviewHistoricalPublication = false) {
  const source = state.executions[sourceId];
  if (!source || source.workflowId !== workflow.id) deny("Original execution is unavailable for this workflow");
  try { assertCurrentRunController(state as RepositoryState, source, user.id, user.role); }
  catch { deny("Current account cannot restart this execution"); }
  if (!["FAILED", "CANCELLED", "RECOVERY_REQUIRED"].includes(source.status)) deny("Only stopped failed, cancelled or read/model-uncertain runs can be restarted");
  if (source.readProgress?.profile !== "read-progress-v1" || source.protectedJobSecret || source.protectedInvocationSecret || source.emailDeliverySource || source.scheduleSource || source.snapshotScheduleSource || source.recoverySource)
    deny("This execution needs its dedicated recovery process, not a whole-workflow retry");
  const snapshot = source.workflowSnapshot;
  if (!snapshot || !snapshot.input || typeof snapshot.input !== "object" || Array.isArray(snapshot.input) ||
      workflow.archived || snapshot.contentHash !== workflowContentHash(snapshot.yaml) || !reviewHistoricalPublication && (workflow.publishedVersion !== snapshot.version || workflow.yaml !== snapshot.yaml))
    deny("The workflow publication changed or original inputs are unavailable; review and run the current workflow explicitly");
  const publication = state.versions[workflow.id]?.findLast(value => value.version === snapshot.version && value.artifactState === "PUBLISHED");
  if (publication?.yaml !== snapshot.yaml) deny("The immutable original publication is unavailable");
  if (snapshot.executionProfile === "sequential-operation-v1") {
    const stored = publication.compiledOperation as StoredOperationCompilation | undefined;
    if (!source.operationSecret || !stored?.plan?.ir?.root?.nodes || !snapshot.operationCompilation ||
        !canonicalJSONBytes(stored.receipt).equals(canonicalJSONBytes(snapshot.operationCompilation))) deny("Original operation classification cannot be verified");
    for (const intent of Object.values(source.operationSecret.intents)) {
      const node = stored.plan.ir.root.nodes.find(value => value.id === intent.nodeId);
      // Historical analysis intents did not persist dispatchKind. Classify
      // those by the immutable compiled node, never by failure-message text.
      const safe = node && (node.kind === "analysis" ? intent.dispatchKind === undefined || intent.dispatchKind === "analysis" :
        node.kind === "agent" ? ["agent-model", "agent-tool"].includes(intent.dispatchKind ?? "") :
        node.kind === "action" && node.effectClass === "read" && [undefined, "tool"].includes(intent.dispatchKind));
      if (!safe) deny("An ERP write may already have happened; reconcile its outcome instead of restarting the workflow");
    }
    if (Object.values(source.runtimeApprovalSecret?.records ?? {}).some(record => record.state === "CONSUMED"))
      deny("A transaction approval was consumed; inspect external outcome evidence before any new business operation");
  } else {
    const compiled = publication.compiledRead as { receipt?: unknown } | undefined;
    if (!["sequential-read-v1", "conditional-read-v1", "structured-read-v1", "collection-read-v1"].includes(snapshot.executionProfile) || source.operationSecret ||
        !snapshot.compilation || !compiled?.receipt || !canonicalJSONBytes(compiled.receipt).equals(canonicalJSONBytes(snapshot.compilation)))
      deny("This legacy execution has no qualified retry boundary");
  }
  if ((state.timelines[source.id] ?? []).some(entry => entry.sideEffect === true && (String(entry.phase ?? "").includes("DISPATCH") || ["DONE", "UNKNOWN"].includes(String(entry.status)) || entry.output !== undefined)))
    deny("An effect has dispatch evidence; whole-workflow retry could duplicate it");
  const requiresUncertaintyAcknowledgement = source.status === "RECOVERY_REQUIRED" || Object.values(source.readProgress.attempts).some(attempt => attempt.status === "UNKNOWN");
  return { source, requiresUncertaintyAcknowledgement };
}

/** UI lock-release evidence only, never retry/admission authority. A reviewed
 * new publication can be run explicitly after a proven pre-dispatch stop.
 * Unknown reads/models, consumed approvals and ANY effect intent stay locked. */
export function canReviewStoppedRunForNewRun(state: Readonly<RepositoryState>, user: CurrentUser, execution: Execution): boolean {
  try {
    if (execution.status !== "RECOVERY_REQUIRED" || !execution.completedAt) return false;
    const workflow = state.workflows[execution.workflowId]; if (!workflow) return false;
    inspect(state, workflow, user, execution.id, true);
    if (Object.values(execution.readProgress?.attempts ?? {}).some(attempt => ["UNKNOWN", "DISPATCH_INTENT", "PREPARING"].includes(attempt.status))) return false;
    if (Object.values(execution.operationSecret?.intents ?? {}).some(intent => intent.state !== "ACKNOWLEDGED")) return false;
    return true;
  } catch { return false; }
}

export function executionRetryView(state: Readonly<RepositoryState>, user: CurrentUser, execution: Execution) {
  const canReviewForNewRun = canReviewStoppedRunForNewRun(state, user, execution);
  try {
    const workflow = state.workflows[execution.workflowId];
    if (!workflow) deny("Workflow unavailable");
    const result = inspect(state, workflow, user, execution.id);
    return { profile: "execution-retry-admission/v1", allowed: true, canReviewForNewRun, requiresUncertaintyAcknowledgement: result.requiresUncertaintyAcknowledgement,
      reason: "Starts from the first step with original inputs and current validation. Original evidence is retained; writes require fresh independent approval." };
  } catch (error) {
    return { profile: "execution-retry-admission/v1", allowed: false, canReviewForNewRun, requiresUncertaintyAcknowledgement: false,
      reason: error instanceof HandlerFailure ? error.message : "Original retry safety evidence is unavailable" };
  }
}

/** Re-run inside the SAME mutation that creates a new execution, after any
 * asynchronous preflight. Returned original inputs never come from the UI. */
export function assertExecutionRetry(state: Readonly<RepositoryState>, workflow: Workflow, user: CurrentUser, request: ExecutionRetryRequest,
  expectedInput?: Record<string, unknown>) {
  const { source, requiresUncertaintyAcknowledgement } = inspect(state, workflow, user, request.sourceExecutionId);
  if (requiresUncertaintyAcknowledgement && !request.acknowledgeUnconfirmed) deny("Confirm that the old read/model result is unknown and another call may incur cost; no write was dispatched");
  if (expectedInput && !canonicalJSONBytes(expectedInput).equals(canonicalJSONBytes(source.workflowSnapshot!.input))) deny("Retry inputs must match the immutable original run");
  // Scoped execution transactions expose the old run through read-only proxies.
  // Copy authenticated JSON without structuredClone's proxy rejection and
  // without relaxing the transaction's original-run immutability boundary.
  return { input: JSON.parse(canonicalJSONBytes(source.workflowSnapshot!.input).toString("utf8")) as Record<string, unknown>, mode: source.workflowSnapshot!.executionProfile === "sequential-operation-v1" ? "async-operation" : "async-read", link: { profile: "execution-retry-source/v1" as const,
    sourceExecutionId: source.id, sourceVersion: source.workflowSnapshot!.version, sourceHash: source.workflowSnapshot!.contentHash,
    acknowledgedUnconfirmedReads: request.acknowledgeUnconfirmed } };
}
