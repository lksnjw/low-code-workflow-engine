import { useQuery } from "@tanstack/react-query";
import { workflowService } from "../services/workflow.service";
import { useAuthContext } from "../context/AuthContext";
import { authorityScope, captureAuthority, isAuthorityCurrent, staleAuthorityError } from "../utils/authAuthority";

/*******************************************************************************
 * Function: useWorkflows
 *
 * Provides workflows for the useWorkflows module.
 ******************************************************************************/
export function useWorkflows(params = {}) {
  const { user } = useAuthContext();
  const scope = authorityScope(user);
/*******************************************************************************
 * Function: query
 *
 * Performs the query operation on the application for the useWorkflows module.
 ******************************************************************************/
  const query = useQuery({
    queryKey: ["workflows", scope, params],
    enabled: Boolean(user && scope),
    queryFn: async ({ signal }) => {
      const capture = captureAuthority(user);
      const page = await workflowService.listPage(params, signal);
      if (!isAuthorityCurrent(capture)) throw staleAuthorityError();
      return page;
    },
  });
  const workflows = query.isError ? [] : query.data?.items || [];
  return {
    workflows,
    activeWorkflows: workflows.filter((workflow) => !workflow.archived),
    loading: query.isLoading,
    error: query.error,
    reload: query.refetch,
    meta: query.data?.meta,
    refreshing: query.isFetching && !query.isPending,
  };
}

/*******************************************************************************
 * Function: useWorkflow
 *
 * Provides workflow for the useWorkflows module.
 ******************************************************************************/
export function useWorkflow(workflowId) {
  return useQuery({
    queryKey: ["workflow", workflowId],
    queryFn: () => workflowService.getById(workflowId),
    enabled: Boolean(workflowId),
  });
}

export default useWorkflows;
