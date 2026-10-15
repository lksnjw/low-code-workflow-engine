import { useState } from "react";
import { executionService } from "../../services/execution.service";
import { executionEventLabel } from "../../utils/executionEvents";
import ExecutionStatus from "./ExecutionStatus";
import { iterationPositionLabel } from "../../utils/iterationEvidence";
import ExecutionRetryAction from "./ExecutionRetryAction";

export default function ExecutionRunControls({ execution, canControl = false, monitor, onChanged, onRetried, onReviewApproval }) {
  const [requesting, setRequesting] = useState(false), [acknowledged, setAcknowledged] = useState(false), [error, setError] = useState("");
  if (!execution) return monitor?.error ? <div role="alert" className="text-xs text-amber-700">{monitor.error}{monitor.reconnecting && " Reconnecting updates automatically."}<button className="ml-2 text-primary" onClick={monitor.refresh}>Refresh run</button></div> : null;
  const operation = execution.workflowSnapshot?.executionProfile === "sequential-operation-v1";
  const running = execution.status === "RUNNING" || execution.status === "PENDING" || operation && execution.status === "AWAITING_APPROVAL";
  const pending = running && (acknowledged || Boolean(execution.readProgress?.cancellation));
  const recovery = ["RECOVERY_REQUIRED", "RECONCILIATION_REQUIRED"].includes(execution.status);
  const requestCancel = async () => {
    setRequesting(true); setError("");
    try {
      await executionService.cancel(execution.id);
      setAcknowledged(true); monitor?.refresh(); onChanged?.();
    } catch (cause) {
      setError(cause?.response?.data?.message || "Cancellation was not confirmed. Refresh this run before trying again.");
      monitor?.refresh();
    } finally { setRequesting(false); }
  };
  return <section aria-label="Execution controls" className="space-y-3 border-y border-gray-200 py-3 text-xs dark:border-gray-700">
    <div className="flex flex-wrap items-center gap-2"><span className="font-semibold text-gray-900 dark:text-white">Live run</span><ExecutionStatus status={execution.status} failure={execution.failure} />
      {monitor && <button onClick={monitor.refresh} className="ml-auto min-h-8 px-2 text-primary">Refresh run</button>}
      {canControl && running && execution.readProgress?.profile === "read-progress-v1" && <button disabled={requesting || pending || monitor?.denied} onClick={requestCancel} className="min-h-8 rounded-md border border-gray-300 px-3 disabled:opacity-50 dark:border-gray-700">{pending ? "Cancellation requested" : requesting ? "Requesting…" : "Request cancellation"}</button>}
    </div>
    {pending && <p role="status" className="text-amber-700 dark:text-amber-300">{operation ? "Cancellation is pending. An in-flight ERP operation may already have taken effect; reconcile an unconfirmed outcome before retrying." : "Cancellation is pending. An in-flight read may finish; its saved answer is retained. Further calls stop when the request is observed."}</p>}
    {operation && execution.status === "AWAITING_APPROVAL" && <aside aria-label="Approval required" role="alert" aria-live="assertive" className="workspace-reveal rounded-xl border-2 border-amber-400 bg-amber-50 p-4 shadow-sm dark:border-amber-700 dark:bg-amber-950/30">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-amber-900 dark:text-amber-200"><span aria-hidden="true" className="flex h-7 w-7 items-center justify-center rounded-full bg-amber-200 text-base dark:bg-amber-900">!</span>Approval needed to continue</h3>
      <p className="mt-1 leading-5 text-amber-900 dark:text-amber-200">Waiting for exact transaction approval. This run is paused before the action, not stuck. The current approval policy determines who can decide.</p>
      <p className="mt-1 leading-5 text-gray-600 dark:text-gray-300">Reviewers can open the request from the notification bell or Approval inbox. An approved operation is queued automatically for fresh authorization; previous saved results are retained.</p>
      {onReviewApproval ? <button type="button" className="mt-2 inline-flex min-h-8 items-center font-semibold text-primary dark:text-fuchsia-300" onClick={onReviewApproval}>Review approval here</button> : <a className="mt-2 inline-flex min-h-8 items-center font-semibold text-primary dark:text-fuchsia-300" href={`/executions/${encodeURIComponent(execution.id)}`}>View approval status</a>}
    </aside>}
    {recovery && <p role="status" className="text-amber-700 dark:text-amber-300">Recovery review required. Saved answers are retained; an unconfirmed call may have reached ERP. No automatic retry or replay was performed.</p>}
    {canControl && <ExecutionRetryAction key={execution.id} execution={execution} denied={monitor?.denied} onRetried={onRetried} />}
    {operation && execution.hasOperationReconciliation === true && ["RECONCILIATION_REQUIRED", "RECONCILED"].includes(execution.status) && <a className="inline-block min-h-8 py-1 text-primary dark:text-violet-300" href={`/executions/${encodeURIComponent(execution.id)}?view=reconciliation`}>Review external outcome evidence</a>}
    {operation && execution.hasReportPageResolution === true && <a className="inline-block min-h-8 py-1 text-primary dark:text-violet-300" href={`/executions/${encodeURIComponent(execution.id)}?view=report-page`}>Review uncertain report page</a>}
    {execution.status === "RECONCILED" && <p role="status" className="text-gray-500">Closed by operator evidence, not completed successfully. No action or later node was resumed. The original SDK outcome remains unacknowledged.</p>}
    {execution.status === "CANCELLED" && <p className="text-gray-500">{operation ? "No further operations will start. Previously acknowledged results remain saved; cancellation does not roll back ERP effects." : "No further reads will start. Confirmed saved answers remain available; remote processing is not confirmed stopped."}</p>}
    {execution.readProgress?.persistence === "memory-only" && <p className="text-gray-500">Memory-only run · checkpoints will not survive server restart.</p>}
    {(error || monitor?.error) && <p role="alert" className="text-amber-700 dark:text-amber-300">{error || monitor.error}{!monitor?.denied && " Displayed answers are the last confirmed snapshot, not fresh status."}</p>}
    {monitor?.reconnecting && <p role="status" className="text-gray-500">Reconnecting run updates automatically. No business operation is being replayed.</p>}
    {!!monitor?.events?.length && <details><summary className="cursor-pointer text-gray-500">Technical run details · {monitor.cursor} updates</summary><p className="mt-2 break-all font-mono text-[10px] text-gray-500">Run {execution.id}</p><ol className="mt-2 max-h-56 space-y-2 overflow-auto border-l border-gray-200 pl-3 dark:border-gray-700">{monitor.events.slice(-200).map((event) => <li key={event.sequence}><span className="mr-2 font-mono text-[10px] text-gray-400">{event.sequence}</span>{executionEventLabel(event)}{event.nodeId && <span className="ml-2 font-mono text-[10px]">{event.nodeId}</span>}{event.payload?.iterations && <span className="ml-2 text-[10px]">{iterationPositionLabel(event.payload.iterations)}</span>}<time className="ml-2 text-[10px] text-gray-400" dateTime={event.timestamp}>{new Date(event.timestamp).toLocaleTimeString()}</time></li>)}</ol>{monitor.events.length > 200 && <p className="mt-2 text-gray-500">Showing the latest 200 saved events.</p>}{monitor.cursor > monitor.events.length && <p className="mt-2 text-gray-500">Earlier events remain saved on the server; this display retains the latest 2,000 without replaying business operations.</p>}</details>}
  </section>;
}
