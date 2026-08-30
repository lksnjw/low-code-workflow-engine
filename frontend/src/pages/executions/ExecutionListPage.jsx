import Card from "../../components/shared/ui/Card";
import { useMemo, useState } from "react";
import ExecutionFilters from "../../components/executions/ExecutionFilters";
import ExecutionTable from "../../components/executions/ExecutionTable";
import HealingReport from "../../components/executions/HealingReport";
import { EmptyState, ErrorState, LoadingState } from "../../components/shared/ResourceState";
import { useExecution } from "../../hooks/useExecution";
import { useDebounce } from "../../hooks/useDebounce";
import usePermissions from "../../hooks/usePermissions";

/*******************************************************************************
 * Function: ExecutionListPage
 *
 * Performs the Execution List Page operation on list page for the ExecutionListPage module.
 ******************************************************************************/
function ExecutionListPage() {
  const { has, roleId } = usePermissions();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [range, setRange] = useState("");
  const debouncedQuery = useDebounce(query);
/*******************************************************************************
 * Function: params
 *
 * Performs the params operation on the application for the ExecutionListPage module.
 ******************************************************************************/
  const params = useMemo(() => ({ q: debouncedQuery || undefined, status: status || undefined, range: range || undefined }), [debouncedQuery, status, range]);
  const { executions, healingReport, loading, error, reload } = useExecution(undefined, params);
  return (
    <div className="space-y-6">
      <div><h1 className="page-heading text-gray-950 dark:text-white">{roleId === "role_client" ? "My Executions" : "Execution History"}</h1><p className="mt-3 text-sm leading-6 text-gray-500 dark:text-gray-400">{has("workflow:read") ? "Track real run status, token usage, latency, and recovery evidence." : "Review the runs and results created by your account."}</p></div>
      <ExecutionFilters query={query} status={status} range={range} onQueryChange={setQuery} onStatusChange={setStatus} onRangeChange={setRange} />
      {loading ? <LoadingState label="Loading executions…" /> : null}
      {error ? <ErrorState error={error} onRetry={reload} /> : null}
      {!loading && !error && executions.length === 0 ? <EmptyState title={query || status || range ? "No matching executions" : "No executions yet"} description={query || status || range ? "Try changing the search, status, or time range." : "Run a validated workflow to create execution evidence."} /> : null}
      {executions.length > 0 ? <ExecutionTable executions={executions} /> : null}
      {healingReport && healingReport.status !== "NO_HEALING_REQUIRED" ? <Card><h2 className="section-title mb-4">Latest Recovery</h2><HealingReport report={healingReport} embedded /></Card> : null}
    </div>
  );
}

export default ExecutionListPage;
