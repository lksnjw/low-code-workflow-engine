import { useQuery } from "@tanstack/react-query";
import { dashboardService } from "../services/dashboard.service";

export function useDashboard() {
  const query = useQuery({ queryKey: ["dashboard"], queryFn: dashboardService.load, refetchInterval: 30_000 });
  return { data: query.data || null, loading: query.isLoading, error: query.error, reload: query.refetch };
}

export default useDashboard;
