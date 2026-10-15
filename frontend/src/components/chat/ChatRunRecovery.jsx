import { useState } from "react";
import { usePermissions } from "../../hooks/usePermissions";
import { executionService } from "../../services/execution.service";
import ExecutionRetryAction from "../executions/ExecutionRetryAction";

const safeId = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
function SavedRunRecovery({ workflowId, run, canControl }) {
  const [execution, setExecution] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const review = async () => {
    if (busy) return; setBusy(true); setError("");
    try {
      const current = await executionService.get(run.id);
      if (current.id !== run.id || current.workflowId !== workflowId) throw new Error("Saved execution identity could not be verified.");
      setExecution(current);
    } catch (cause) { setError(cause?.response?.data?.message || cause?.message || "Current run evidence is unavailable; no retry was submitted."); }
    finally { setBusy(false); }
  };
  return <section aria-label="Saved run recovery" className="mt-3 space-y-2 border-t border-gray-200 pt-3 text-xs dark:border-gray-700">
    <p className="font-semibold">Saved run · {execution?.status || run.status}</p>
    {run.failure && <p>Recorded failure: {run.failure.category}{run.failure.nodeId ? ` · ${run.failure.nodeId}` : ""}</p>}
    <a className="break-all text-primary" href={`/executions/${encodeURIComponent(run.id)}`}>View execution {run.id}</a>
    <p className="text-gray-500">The assistant's explanation is advisory. Only the system can admit a new run; your confirmation is required.</p>
    {canControl && !execution && run.retryReview?.allowed === true && <button disabled={busy} onClick={review} className="min-h-9 rounded-md border border-gray-300 px-3 disabled:opacity-50 dark:border-gray-700">{busy ? "Checking saved run…" : "Review retry in chat"}</button>}
    {canControl && execution && <ExecutionRetryAction key={execution.id} execution={execution} />}
    {run.retryReview?.allowed === false && <p className="text-gray-500">Retry unavailable: {run.retryReview.reason}</p>}
    {error && <p role="alert" className="text-amber-700 dark:text-amber-300">{error}</p>}
  </section>;
}

/** IDs/actions come from the backend's saved-state artifact, not model prose.
 * Each explicit review fetches current evidence; the shared admission service
 * supplies the same immutable-input, idempotent retry used by the canvas. */
export default function ChatRunRecovery({ status, selectedExecutionId }) {
  const { actorId, hasAny } = usePermissions();
  if (status?.profile !== "chat-workspace-status/v1" || !Array.isArray(status.workflows)) return null;
  const workflows = status.workflows.slice(0, 5).filter(workflow => safeId(workflow.id) && safeId(workflow.latestRun?.id) && (!selectedExecutionId || workflow.latestRun.id === selectedExecutionId) && ["FAILED", "CANCELLED", "RECOVERY_REQUIRED", "RECONCILIATION_REQUIRED", "RECONCILED"].includes(workflow.latestRun.status));
  return workflows.map(workflow => <SavedRunRecovery key={`${actorId}:${workflow.id}:${workflow.latestRun.id}`} workflowId={workflow.id} run={workflow.latestRun} canControl={hasAny(["workflow:run", "workflow:run_own"])} />);
}
