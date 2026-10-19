import { readFailureDiagnostic } from "./read-failure-reason.js";
import type { HandlerServices } from "../http/handlers/common.js";
import type { Execution } from "../repository/store.js";
import type { ValidationToken } from "../validator/registry-validator.js";
import { executeReadWorkflow } from "./read-workflow.js";
import { ReadCheckpoints, ReadCheckpointFailure, ReadRunCancelled, reconcileInterruptedExecutions, type ReadExecutionHooks } from "./read-checkpoints.js";
import type { CompiledReadPlan } from "../workflows/compiled-read.js";
import { ReadWorkerLeaseFailure, type ReadWorkerContext } from "./read-worker-lease.js";

/** Shared synchronous/queued runner. Completion requires committed node
 * evidence; uncertain persistence never authorizes replay or another call. */
export async function completeCheckpointedRead(services: HandlerServices, initial: Execution, input: Record<string, unknown>, token: ValidationToken, signal?: AbortSignal, assertDispatchBinding?: () => void, compiledPlan?: CompiledReadPlan, worker?: ReadWorkerContext): Promise<Execution> {
  const executionId = initial.id, yaml = initial.workflowSnapshot!.yaml;
  const checkpoints = new ReadCheckpoints(services.repository, executionId, initial.readProgress!.epoch, yaml, signal, initial.workflowSnapshot?.compilation?.semanticHash, compiledPlan);
  const assertActive = worker?.assertActive.bind(worker), assertWorkerDispatch = worker?.assertDispatch.bind(worker);
  const boundary = async <T>(operation: () => Promise<T>): Promise<T> => {
    assertActive?.(); const result = await operation(); assertActive?.(); return result;
  };
  const hooks: ReadExecutionHooks = {
    preparing: (...args) => boundary(() => checkpoints.preparing(...args)),
    // Preserve already confirmed in-flight evidence in the same epoch even if
    // current dispatch authority was revoked. The next boundary is denied.
    completed: checkpoints.completed.bind(checkpoints), failed: checkpoints.failed.bind(checkpoints),
    condition: (...args) => boundary(() => checkpoints.condition(...args)), skipped: (...args) => boundary(() => checkpoints.skipped(...args)),
    value: (...args) => boundary(() => checkpoints.value(...args)), terminated: (...args) => boundary(() => checkpoints.terminated(...args)),
    dispatchIntent: (...args) => boundary(async () => { assertDispatchBinding?.(); await checkpoints.dispatchIntent(...args); }),
  };
  let failed = false;
  let failureDiagnostic: ReturnType<typeof readFailureDiagnostic> | undefined;
  try { await executeReadWorkflow(services, initial.startedBy.id, yaml, input, token, { traceId: initial.traceId, sessionId: initial.chatSessionId, workflowId: initial.workflowId, executionId, signal,
    assertDispatch: () => { assertDispatchBinding?.(); assertWorkerDispatch?.(); } }, hooks, compiledPlan); }
  catch (error) {
    if (error instanceof ReadCheckpointFailure || error instanceof ReadWorkerLeaseFailure || signal?.reason instanceof ReadWorkerLeaseFailure) {
      await checkpointFailure(error instanceof ReadWorkerLeaseFailure || signal?.reason instanceof ReadWorkerLeaseFailure ? "READ_WORKER_LEASE_LOST" : "CHECKPOINT_NOT_COMMITTED"); throw error;
    }
    failed = !(error instanceof ReadRunCancelled);
    if (failed) failureDiagnostic = readFailureDiagnostic(error);
  }
  try { assertActive?.(); return await checkpoints.finish(failed, failureDiagnostic); }
  catch (error) { await checkpointFailure(error instanceof ReadWorkerLeaseFailure ? "READ_WORKER_LEASE_LOST" : "CHECKPOINT_NOT_COMMITTED"); throw error; }

  async function checkpointFailure(reason = "CHECKPOINT_NOT_COMMITTED"): Promise<void> {
    // Never promote uncommitted in-memory results to DONE, or start another call.
    // Best-effort recovery marking has no dispatch/replay authority.
    try {
      await services.repository.recoverPersistenceState();
      await reconcileInterruptedExecutions(services.repository, reason, executionId, initial.readProgress!.epoch);
    } catch { /* storage remains unavailable and writes stay fenced; startup will reconcile */ }
  }
}
