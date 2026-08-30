import { Link, useParams } from "react-router-dom";
import ExecutionStatus from "../../components/executions/ExecutionStatus";
import PendingApprovalCard from "../../components/executions/PendingApprovalCard";
import ExecutionOutputPanel from "../../components/executions/ExecutionOutputPanel";
import ExecutionTimeline from "../../components/executions/ExecutionTimeline";
import GovernanceBlockPanel from "../../components/executions/GovernanceBlockPanel";
import HealingReport from "../../components/executions/HealingReport";
import LiveLogStream from "../../components/executions/LiveLogStream";
import { EmptyState, ErrorState, LoadingState } from "../../components/shared/ResourceState";
import Card from "../../components/shared/ui/Card";
import { useExecution } from "../../hooks/useExecution";
import TraceIdentifier from "../../components/shared/TraceIdentifier";

/*******************************************************************************
 * Function: ExecutionDetailPage
 *
 * Performs the Execution Detail Page operation on detail page for the ExecutionDetailPage module.
 ******************************************************************************/
function ExecutionDetailPage() {
  const { executionId } = useParams();
  const { execution, logs, timeline, healingReport, loading, error, reload } = useExecution(executionId);

  if (loading) return <LoadingState label={`Loading execution ${executionId}…`} />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!execution) {
    return <EmptyState title="Execution not found" description="The requested execution is unavailable to this account." />;
  }

  return (
    <div className="space-y-6">
      <section className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
        <div>
          <Link to="/executions" className="text-sm font-semibold text-primary">← All executions</Link>
          <h1 className="page-heading mt-3 text-gray-950 dark:text-white">{execution.workflowName || execution.workflow}</h1>
          <p className="mt-2 font-mono text-xs text-gray-500">{execution.id}</p>
          <TraceIdentifier traceId={execution.traceId} />
        </div>
        <ExecutionStatus status={execution.status} failure={execution.failure} />
      </section>
      {execution.status === "AWAITING_APPROVAL" ? (
        <PendingApprovalCard execution={execution} onChanged={reload} />
      ) : null}
      {execution.failure ? <GovernanceBlockPanel failure={execution.failure} /> : null}
      <Card>
        <dl className="grid gap-4 md:grid-cols-4">
          <Metric label="Started" value={execution.started} />
          <Metric label="Duration" value={execution.duration} />
          <Metric label="Tokens" value={execution.tokens} />
          <Metric label="Cost" value={execution.cost} />
        </dl>
      </Card>
      <ExecutionOutputPanel execution={execution} />
      <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
        <LiveLogStream logs={logs} executionId={execution.id} />
        <div className="space-y-4">
          <HealingReport report={healingReport} />
          <Card>
            <h2 className="section-title mb-4">Step Timeline</h2>
            {timeline.length === 0 ? (
              <EmptyState title="No step evidence" description="No step timeline was recorded for this execution." />
            ) : (
              <ExecutionTimeline timeline={timeline} />
            )}
          </Card>
        </div>
      </section>
    </div>
  );
}

/*******************************************************************************
 * Function: Metric
 *
 * Performs the Metric operation on the application for the ExecutionDetailPage module.
 ******************************************************************************/
function Metric({ label, value }) {
  return (
    <div>
      <dt className="text-xs font-bold uppercase tracking-wide text-gray-500">{label}</dt>
      <dd className="mt-2 font-semibold text-gray-950 dark:text-white">{value || "—"}</dd>
    </div>
  );
}

export default ExecutionDetailPage;
