import { useMutation, useQuery } from "@tanstack/react-query";
import Card from "../shared/ui/Card";
import { ErrorState, LoadingState } from "../shared/ResourceState";
import { useNotifications } from "../../context/NotificationContext";
import { apiErrorMessage } from "../../services/api";
import { userService } from "../../services/user.service";
import { workflowService } from "../../services/workflow.service";

/*******************************************************************************
 * Function: WorkflowAssignments
 *
 * Performs the Workflow Assignments operation on assignments for the WorkflowAssignments module.
 ******************************************************************************/
function WorkflowAssignments({ workflow, onChanged }) {
  const { notify } = useNotifications();
  const query = useQuery({ queryKey: ["assignable-workflow-users"], queryFn: userService.assignable });
  const assigned = new Set(workflow.assignedUserIds || []);
/*******************************************************************************
 * Function: mutation
 *
 * Performs the mutation operation on the application for the WorkflowAssignments module.
 ******************************************************************************/
  const mutation = useMutation({
    mutationFn: ({ userId, isAssigned }) =>
      isAssigned
        ? workflowService.unassignUser(workflow.id, userId)
        : workflowService.assignUser(workflow.id, userId),
    onSuccess: async () => {
      notify("Workflow assignments updated.", "success");
      await onChanged?.();
    },
    onError: (error) => notify(apiErrorMessage(error, "Could not update workflow assignments."), "error"),
  });

  return (
    <Card>
      <div>
        <h2 className="section-title">Assigned users</h2>
        <p className="mt-2 text-sm text-gray-500">Assigned clients can view and run this workflow. The owner always retains access.</p>
      </div>
      {query.isLoading ? <div className="mt-4"><LoadingState label="Loading assignable users…" /></div> : null}
      {query.error ? <div className="mt-4"><ErrorState error={query.error} onRetry={query.refetch} /></div> : null}
      {query.data ? (
        <div className="mt-5 divide-y divide-gray-100 dark:divide-gray-800">
          {query.data.map((user) => {
            const isOwner = workflow.ownerRecord?.id === user.id;
            const isAssigned = assigned.has(user.id);
            return (
              <label key={user.id} className="flex items-center justify-between gap-4 py-3 text-sm">
                <span><span className="block font-semibold text-gray-900 dark:text-white">{user.name}</span><span className="block text-xs text-gray-500">{user.email} · {user.role}</span></span>
                <input
                  type="checkbox"
                  checked={isOwner || isAssigned}
                  disabled={isOwner || mutation.isPending}
                  onChange={() => mutation.mutate({ userId: user.id, isAssigned })}
                  className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
                />
              </label>
            );
          })}
        </div>
      ) : null}
    </Card>
  );
}

export default WorkflowAssignments;
