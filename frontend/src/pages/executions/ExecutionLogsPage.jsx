import Card from "../../components/shared/ui/Card";
import ExecutionTimeline from "../../components/executions/ExecutionTimeline";
import LiveLogStream from "../../components/executions/LiveLogStream";
import HealingReport from "../../components/executions/HealingReport";
import { EmptyState, ErrorState, LoadingState } from "../../components/shared/ResourceState";
import { useExecution } from "../../hooks/useExecution";

function ExecutionLogsPage({ view = "logs" }) {
  const { executions, selectedId, logs, timeline, healingReport, loading, error, reload } = useExecution();
  if (loading) return <LoadingState label="Loading execution evidence…" />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!selectedId || executions.length === 0) return <EmptyState title="No execution selected" description="Run a workflow first." />;
  if (view === "healing") {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="page-heading text-gray-950 dark:text-white">Healing Events</h1>
          <p className="mt-3 text-sm text-gray-500">Recovery evidence for the most recent visible execution.</p>
        </div>
        <HealingReport report={healingReport} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="page-heading text-gray-950 dark:text-white">Recorded Execution Logs</h1>
        <p className="mt-3 text-sm text-gray-500">
          Persisted log evidence for the most recent visible execution. This view does not claim live streaming.
        </p>
      </div>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
        <LiveLogStream logs={logs} executionId={selectedId} />
        <Card><h2 className="section-title mb-4">Step Timeline</h2><ExecutionTimeline timeline={timeline} /></Card>
      </div>
    </div>
  );
}

export default ExecutionLogsPage;
