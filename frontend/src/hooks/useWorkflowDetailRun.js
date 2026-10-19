import { useRef, useState } from "react";
import { workflowService } from "../services/workflow.service";
import { executionService } from "../services/execution.service";
import { useRunAdmissionRecovery } from "./useRunAdmissionRecovery";

const empty = { loading: false, result: null, error: null, unconfirmed: false };
export const canDismissRecordedRun = status => ["DONE", "FAILED", "CANCELLED"].includes(status);

/** One explicit admission, then read-only monitoring. Keep known or uncertain
 * runs locked until review; refetch errors cannot erase a successful receipt. */
export function useWorkflowDetailRun(workflowId, onChanged, actorId) {
  const recovery = useRunAdmissionRecovery(workflowId, actorId);
  const scope = `${actorId || ""}:${workflowId || ""}`;
  const [frames, setFrames] = useState(() => new Map());
  const locks = useRef(new Set());
  const local = frames.get(scope) || empty;
  const state = { ...local, result: recovery.denied ? null : recovery.run || (recovery.pending ? null : local.result), loading: local.loading || recovery.checking,
    error: recovery.error || (recovery.run ? null : local.error), unconfirmed: recovery.pending && !recovery.run || local.unconfirmed && !recovery.run };
  const save = frame => setFrames(previous => new Map(previous).set(scope, frame));
  const run = async (input = {}, options = {}) => {
    if (!workflowId || recovery.pending || recovery.checking || locks.current.has(scope)) return;
    locks.current.add(scope); save({ ...empty, loading: true });
    let sent = false;
    try {
      const readiness = await workflowService.readiness(workflowId);
      const mode = readiness.operation_job_admission === "operation-job/v1" ? "async-operation" : readiness.read_job_admission === "read-job-v1" ? "async-read" : null;
      if (!mode) throw new Error("Queued execution is unavailable. Open the canvas to inspect supported run options.");
      const idempotencyKey = crypto.randomUUID();
      sent = true;
      const result = await executionService.run(workflowId, input, { mode, idempotencyKey, ...(options.startRevision ? { startRevision: options.startRevision } : readiness.start_revision ? { startRevision: readiness.start_revision } : {}), ...(actorId ? { expectedActorId: actorId } : {}) });
      if (typeof result?.id !== "string" || !result.id.trim()) throw new Error("The run receipt has no execution ID.");
      save({ ...empty, result });
      void Promise.resolve().then(() => onChanged?.()).catch(() => {});
      return result;
    } catch (cause) {
      const executionId = cause?.response?.data?.meta?.executionId;
      if (sent && executionId) {
        try { const result = await executionService.get(executionId); if (result?.id !== executionId) throw new Error("Wrong receipt"); save({ ...empty, result }); return result; }
        catch { /* Retain uncertainty; never repeat admission. */ }
      }
      const unconfirmed = cause?.runAdmissionUnconfirmed ?? (sent && (!cause?.response || Boolean(executionId) || cause.response.status >= 500));
      if (!unconfirmed) locks.current.delete(scope);
      save({ ...empty, unconfirmed, error: unconfirmed ? "The run outcome is unconfirmed. Review Execution History before another run; nothing was retried." : cause?.response?.data?.message || cause?.message || "Run was not admitted." });
      return null;
    }
  };
  const dismiss = snapshot => {
    if (!snapshot || !state.result || snapshot.id !== state.result.id || !canDismissRecordedRun(snapshot.status)) return;
    if (actorId) { void recovery.release(snapshot).then(released => { if (released) { locks.current.delete(scope); save(empty); } }); }
    else { locks.current.delete(scope); save(empty); }
  };
  return { state, run, dismiss, recovery };
}
