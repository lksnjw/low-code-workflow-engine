import { useQuery } from "@tanstack/react-query";
import { executionService } from "../services/execution.service";

export function useExecution(executionId, params = {}) {
  const listQuery = useQuery({ queryKey: ["executions", params], queryFn: () => executionService.list(params) });
  const executions = listQuery.data || [];
  const selectedId = executionId || executions[0]?.id;
  const logsQuery = useQuery({
    queryKey: ["execution-logs", selectedId],
    queryFn: () => executionService.getLogs(selectedId),
    enabled: Boolean(selectedId),
  });
  const timelineQuery = useQuery({
    queryKey: ["execution-timeline", selectedId],
    queryFn: () => executionService.getTimeline(selectedId),
    enabled: Boolean(selectedId),
  });
  const healingQuery = useQuery({
    queryKey: ["execution-healing", selectedId],
    queryFn: () => executionService.getHealingReport(selectedId),
    enabled: Boolean(selectedId),
  });
  return {
    executions,
    selectedId,
    logs: logsQuery.data || [],
    timeline: timelineQuery.data || [],
    healingReport: healingQuery.data || null,
    loading: listQuery.isLoading,
    error: listQuery.error,
    reload: listQuery.refetch,
  };
}

export default useExecution;
