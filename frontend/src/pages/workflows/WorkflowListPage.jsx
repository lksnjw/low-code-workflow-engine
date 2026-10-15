import { Icon } from "@iconify/react";
import { useMemo, useState } from "react";
import Button from "../../components/shared/ui/Button";
import Tabs from "../../components/shared/ui/Tabs";
import WorkflowCard from "../../components/workflows/WorkflowCard";
import WorkflowFilters from "../../components/workflows/WorkflowFilters";
import WorkflowTable from "../../components/workflows/WorkflowTable";
import { EmptyState, ErrorState, LoadingState } from "../../components/shared/ResourceState";
import { useRoute } from "../../context/RouteContext";
import { useWorkflows } from "../../hooks/useWorkflows";
import { useDebounce } from "../../hooks/useDebounce";
import usePermissions from "../../hooks/usePermissions";

/*******************************************************************************
 * Function: WorkflowListPage
 *
 * Performs the Workflow List Page operation on list page for the WorkflowListPage module.
 ******************************************************************************/
function WorkflowListPage() {
  const { openWorkflow, startWorkflow } = useRoute();
  const { has, roleId } = usePermissions();
	const canWrite = has("workflow:write");
  const canViewAll = has("workflow:read");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [relevance, setRelevance] = useState("relevant");
  const [page, setPage] = useState(1);
  const debouncedQuery = useDebounce(query);
/*******************************************************************************
 * Function: params
 *
 * Performs the params operation on the application for the WorkflowListPage module.
 ******************************************************************************/
  const params = useMemo(() => ({ q: debouncedQuery || undefined, status: status || undefined, relevance, page, limit: 20 }), [debouncedQuery, status, relevance, page]);
  const { workflows, loading, error, reload, meta, refreshing } = useWorkflows(params);

  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
        <div>
          <h1 className="page-heading text-gray-950 dark:text-white">{roleId === "role_client" ? "My Workflows" : "Workflow Blueprints"}</h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-gray-500 dark:text-gray-400">
            {roleId === "role_client" ? "Run workflows assigned to you and review their execution status." : "Manage YAML-backed workflow definitions, ownership, triggers, and execution health."}
          </p>
        </div>
        {canWrite ? <Button onClick={startWorkflow}><Icon icon="mdi:plus" className="h-5 w-5" />New Workflow</Button> : null}
      </div>
      <Tabs
        tabs={[
          { id: "relevant", label: "Relevant to me" },
          ...(canViewAll ? [{ id: "all", label: "All" }] : []),
        ]}
        active={relevance}
        onChange={value => { setPage(1); setRelevance(value); }}
      />
      <WorkflowFilters query={query} status={status} onQueryChange={value => { setPage(1); setQuery(value); }} onStatusChange={value => { setPage(1); setStatus(value); }} />
      {loading ? <LoadingState label="Loading workflows…" /> : null}
      {error ? <ErrorState error={error} onRetry={reload} /> : null}
      {!loading && !error && workflows.length === 0 ? (
        <EmptyState title={query || status ? "No matching workflows" : "No workflows yet"} description={query || status ? "Try changing the search or status filter." : "Create a blank workflow or generate one in the chat workspace."} />
      ) : null}
      {workflows.length > 0 ? (
        <>
          <section className="grid gap-4 lg:grid-cols-2 xl:grid-cols-4">
            {workflows.map((workflow) => <WorkflowCard key={workflow.id} workflow={workflow} onOpen={() => openWorkflow(workflow.id)} />)}
          </section>
          <WorkflowTable workflows={workflows} onOpen={openWorkflow} />
        </>
      ) : null}
      {meta?.total > 0 && <nav aria-label="Workflow pages" className="flex items-center justify-between gap-3 text-sm">
        <p role="status">Page {meta.page} of {meta.totalPages} · {meta.total} workflows{refreshing ? " · Refreshing…" : ""}</p>
        <div className="flex gap-2"><Button disabled={loading || refreshing || page <= 1} onClick={() => setPage(value => Math.max(1, value - 1))}>Previous</Button><Button disabled={loading || refreshing || page >= meta.totalPages} onClick={() => setPage(value => value + 1)}>Next</Button></div>
      </nav>}
    </div>
  );
}

export default WorkflowListPage;
