import WorkflowActions from "../../components/workflows/WorkflowActions";
import Card from "../../components/shared/ui/Card";
import WorkflowBadge from "../../components/workflows/WorkflowBadge";
import { EmptyState, ErrorState, LoadingState } from "../../components/shared/ResourceState";
import { useRoute } from "../../context/RouteContext";
import { useWorkflow } from "../../hooks/useWorkflows";
import usePermissions from "../../hooks/usePermissions";
import WorkflowAssignments from "../../components/workflows/WorkflowAssignments";

function WorkflowDetailPage() {
  const { selectedWorkflowId, navigateTo } = useRoute();
  const { has } = usePermissions();
  const { data: workflow, isLoading, error, refetch } = useWorkflow(selectedWorkflowId);
  if (!selectedWorkflowId) return <EmptyState title="No workflow selected" description="Choose a workflow from the workflow list." />;
  if (isLoading) return <LoadingState label="Loading workflow…" />;
  if (error) return <ErrorState error={error} onRetry={refetch} />;
  if (!workflow) return <EmptyState title="Workflow not found" />;

  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
        <div>
          <button type="button" onClick={() => navigateTo("workflows", "list")} className="mb-3 text-sm font-semibold text-primary">← All workflows</button>
          <h1 className="page-heading text-gray-950 dark:text-white">{workflow.name}</h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-gray-500 dark:text-gray-400">{workflow.description}</p>
        </div>
        <WorkflowActions workflow={workflow} onChanged={refetch} />
      </div>
      <Card>
        <div className="grid gap-4 md:grid-cols-4">
          <div><p className="text-xs font-bold uppercase text-gray-500">Owner</p><p className="mt-2 font-semibold text-gray-950 dark:text-white">{workflow.owner}</p></div>
          <div><p className="text-xs font-bold uppercase text-gray-500">Status</p><div className="mt-2"><WorkflowBadge status={workflow.status} /></div></div>
          <div><p className="text-xs font-bold uppercase text-gray-500">Steps</p><p className="mt-2 font-semibold text-gray-950 dark:text-white">{workflow.steps}</p></div>
          <div><p className="text-xs font-bold uppercase text-gray-500">Success Rate</p><p className="mt-2 font-semibold text-gray-950 dark:text-white">{workflow.successRate}</p></div>
        </div>
      </Card>
      {has("workflow:write") ? <WorkflowAssignments workflow={workflow} onChanged={refetch} /> : null}
    </div>
  );
}

export default WorkflowDetailPage;
