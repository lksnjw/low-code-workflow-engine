import { Icon } from "@iconify/react";
import { useMemo, useState } from "react";
import Button from "../../components/shared/ui/Button";
import WorkflowCard from "../../components/workflows/WorkflowCard";
import WorkflowFilters from "../../components/workflows/WorkflowFilters";
import WorkflowTable from "../../components/workflows/WorkflowTable";
import { EmptyState, ErrorState, LoadingState } from "../../components/shared/ResourceState";
import { useRoute } from "../../context/RouteContext";
import { useWorkflows } from "../../hooks/useWorkflows";
import { useDebounce } from "../../hooks/useDebounce";
import usePermissions from "../../hooks/usePermissions";

function WorkflowListPage() {
  const { navigateTo, openWorkflow } = useRoute();
  const { has, roleId } = usePermissions();
	const canWrite = has("workflow:write");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const debouncedQuery = useDebounce(query);
  const params = useMemo(() => ({ q: debouncedQuery || undefined, status: status || undefined }), [debouncedQuery, status]);
  const { workflows, loading, error, reload } = useWorkflows(params);

  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
        <div>
          <h1 className="page-heading text-gray-950 dark:text-white">{roleId === "role_client" ? "My Workflows" : "Workflow Blueprints"}</h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-gray-500 dark:text-gray-400">
            {roleId === "role_client" ? "Run workflows assigned to you and review their execution status." : "Manage YAML-backed workflow definitions, ownership, triggers, and execution health."}
          </p>
        </div>
        {canWrite ? <Button onClick={() => navigateTo("workflows", "builder")}><Icon icon="mdi:plus" className="h-5 w-5" />New Workflow</Button> : null}
      </div>
      <WorkflowFilters query={query} status={status} onQueryChange={setQuery} onStatusChange={setStatus} />
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
    </div>
  );
}

export default WorkflowListPage;
