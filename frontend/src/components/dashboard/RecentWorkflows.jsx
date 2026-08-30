import Card from "../shared/ui/Card";
import WorkflowBadge from "../workflows/WorkflowBadge";
import { EmptyState } from "../shared/ResourceState";

/*******************************************************************************
 * Function: RecentWorkflows
 *
 * Performs the Recent Workflows operation on workflows for the RecentWorkflows module.
 ******************************************************************************/
function RecentWorkflows({ workflows = [] }) {
  return (
    <Card className="lg:col-span-2">
      <div className="mb-5 flex items-center justify-between">
        <div>
          <h2 className="section-title">Recent Workflows</h2>
          <p className="section-subtitle mt-1">Blueprints with fresh execution activity.</p>
        </div>
        <span className="text-xs font-bold text-gray-500 dark:text-gray-400">
          {workflows.length} tracked
        </span>
      </div>

      <div className="overflow-hidden rounded-2xl border border-gray-200 dark:border-gray-800">
        {workflows.length === 0 ? (
          <EmptyState title="No workflows yet" description="Create a workflow or generate one from chat." />
        ) : workflows.slice(0, 4).map((workflow) => (
          <div
            key={workflow.id}
            className="grid gap-3 border-b border-gray-100 p-4 last:border-0 dark:border-gray-800 md:grid-cols-[1.5fr_0.7fr_0.7fr_auto]"
          >
            <div>
              <p className="text-sm font-bold text-gray-950 dark:text-white">{workflow.name}</p>
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                {workflow.trigger}
              </p>
            </div>
            <div className="text-sm text-gray-600 dark:text-gray-300">{workflow.owner}</div>
            <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              {workflow.successRate}
            </div>
            <WorkflowBadge status={workflow.status} />
          </div>
        ))}
      </div>
    </Card>
  );
}

export default RecentWorkflows;
