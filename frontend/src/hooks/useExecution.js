import { useQuery } from "@tanstack/react-query";
import { executionService } from "../services/execution.service";

/*******************************************************************************
 * Function: useExecution
 *
 * Provides execution for the useExecution module.
 ******************************************************************************/
export function useExecution(executionId, params = {}) {
/*******************************************************************************
 * Function: listQuery
 *
 * Lists query for the useExecution module.
 ******************************************************************************/
  const listQuery = useQuery({
    queryKey: ["executions", params],
    queryFn: () => executionService.list(params),
    enabled: !executionId,
  });
/*******************************************************************************
 * Function: detailQuery
 *
 * Performs the detail Query operation on query for the useExecution module.
 ******************************************************************************/
  const detailQuery = useQuery({
    queryKey: ["execution", executionId],
    queryFn: () => executionService.get(executionId),
    enabled: Boolean(executionId),
  });
  const executions = listQuery.data || [];
  const selectedId = executionId || executions[0]?.id;
/*******************************************************************************
 * Function: logsQuery
 *
 * Performs the logs Query operation on query for the useExecution module.
 ******************************************************************************/
  const logsQuery = useQuery({
    queryKey: ["execution-logs", selectedId],
    queryFn: () => executionService.getLogs(selectedId),
    enabled: Boolean(selectedId),
  });
/*******************************************************************************
 * Function: timelineQuery
 *
 * Performs the timeline Query operation on query for the useExecution module.
 ******************************************************************************/
  const timelineQuery = useQuery({
    queryKey: ["execution-timeline", selectedId],
    queryFn: () => executionService.getTimeline(selectedId),
    enabled: Boolean(selectedId),
  });
/*******************************************************************************
 * Function: healingQuery
 *
 * Performs the healing Query operation on query for the useExecution module.
 ******************************************************************************/
  const healingQuery = useQuery({
    queryKey: ["execution-healing", selectedId],
    queryFn: () => executionService.getHealingReport(selectedId),
    enabled: Boolean(selectedId),
  });
  return {
    executions,
    execution: detailQuery.data || null,
    selectedId,
    logs: logsQuery.data || [],
    timeline: timelineQuery.data || [],
    healingReport: healingQuery.data || null,
    loading: executionId
      ? detailQuery.isLoading || logsQuery.isLoading || timelineQuery.isLoading || healingQuery.isLoading
      : listQuery.isLoading,
    error: executionId
      ? detailQuery.error || logsQuery.error || timelineQuery.error || healingQuery.error
      : listQuery.error,
    reload: () =>
      executionId
        ? Promise.all([detailQuery.refetch(), logsQuery.refetch(), timelineQuery.refetch(), healingQuery.refetch()])
        : listQuery.refetch(),
  };
}

export default useExecution;
