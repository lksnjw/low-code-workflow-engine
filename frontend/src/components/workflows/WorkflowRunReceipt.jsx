import { Link } from "react-router-dom";
import { useExecutionMonitor } from "../../hooks/useExecutionMonitor";
import { projectExecutionIterationEvidence } from "../../utils/iterationEvidence";
import ExecutionStatus from "../executions/ExecutionStatus";
import ExecutionOutputPanel from "../executions/ExecutionOutputPanel";
import RecordedModelUsage from "../executions/RecordedModelUsage";
import { canDismissRecordedRun } from "../../hooks/useWorkflowDetailRun";

/** Follow the admitted ID with read-only monitoring. Dismissal never cancels or
 * repeats execution. A transport failure is not a failed ERP operation. */
export default function WorkflowRunReceipt({ initialExecution, onDismiss, externalMonitor }) {
  const ownMonitor = useExecutionMonitor(initialExecution.id, { enabled: !externalMonitor });
  const monitor = externalMonitor || ownMonitor;
  if (monitor.denied) return <section aria-label="Workflow run" className="rounded-xl border p-4">
    <p role="alert">This run is no longer available to this account. Saved answers are hidden.</p>
  </section>;
  const execution = monitor.execution || initialExecution;
  const iterationModel = projectExecutionIterationEvidence(execution, monitor.timeline || []);
  return <section aria-label="Workflow run" className="space-y-3 rounded-xl border border-gray-200 p-4 dark:border-slate-700">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <ExecutionStatus status={execution.status} failure={execution.failure} />
      <Link className="text-sm font-semibold text-primary" to={`/executions/${encodeURIComponent(execution.id)}`}>Open run details and controls</Link>
      {onDismiss && <button type="button" className="text-xs text-gray-500 disabled:opacity-50" disabled={!canDismissRecordedRun(execution.status)}
        title="Only a confirmed Done, Failed or Cancelled run can be dismissed here. Review uncertain outcomes in run details."
        onClick={() => onDismiss(execution)}>Dismiss run summary</button>}
    </div>
    <p className="break-all font-mono text-xs text-gray-500">{execution.id}</p>
    {monitor.error && <p role="status" className="text-sm text-amber-700">{monitor.error} Saved evidence may be stale; no run was restarted.</p>}
    {execution.agentSummary && <p className="text-sm text-gray-700 dark:text-gray-300">{execution.agentSummary}</p>}
    <RecordedModelUsage counts={execution.recordedUsage} />
    <ExecutionOutputPanel execution={execution} iterationModel={iterationModel} />
  </section>;
}
