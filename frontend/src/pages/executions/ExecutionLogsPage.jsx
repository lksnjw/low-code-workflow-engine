import Card from "../../components/shared/ui/Card";
import ExecutionTimeline from "../../components/executions/ExecutionTimeline";
import LiveLogStream from "../../components/executions/LiveLogStream";
import HealingReport from "../../components/executions/HealingReport";
import { EmptyState, ErrorState, LoadingState } from "../../components/shared/ResourceState";
import { useExecution } from "../../hooks/useExecution";

function ExecutionLogsPage() {
  const { executions, selectedId, logs, timeline, healingReport, loading, error, reload } = useExecution();
  if (loading) return <LoadingState label="Loading execution evidence…" />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!selectedId || executions.length === 0) return <EmptyState title="No execution selected" description="Run a workflow first." />;
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
      <LiveLogStream logs={logs} executionId={selectedId} />
      <div className="space-y-4">
        <HealingReport report={healingReport} />
        <Card><h2 className="section-title mb-4">Step Timeline</h2><ExecutionTimeline timeline={timeline} /></Card>
      </div>
    </div>
  );
}

export default ExecutionLogsPage;
