import { useQuery } from "@tanstack/react-query";
import { executionService } from "../services/execution.service";

export function useLiveLog(executionId) {
  const query = useQuery({
    queryKey: ["live-log", executionId],
    queryFn: () => executionService.getLogs(executionId),
    enabled: Boolean(executionId),
    refetchInterval: executionId ? 2_000 : false,
  });
  return { logs: query.data || [], isConnected: Boolean(executionId) && !query.error, loading: query.isLoading, error: query.error };
}

export default useLiveLog;
