import { useQuery } from "@tanstack/react-query";
import { workflowService } from "../services/workflow.service";

export function useWorkflows(params = {}) {
  const query = useQuery({
    queryKey: ["workflows", params],
    queryFn: () => workflowService.list(params),
  });
  const workflows = query.data || [];
  return {
    workflows,
    activeWorkflows: workflows.filter((workflow) => !workflow.archived),
    loading: query.isLoading,
    error: query.error,
    reload: query.refetch,
  };
}

export function useWorkflow(workflowId) {
  return useQuery({
    queryKey: ["workflow", workflowId],
    queryFn: () => workflowService.getById(workflowId),
    enabled: Boolean(workflowId),
  });
}

export default useWorkflows;
