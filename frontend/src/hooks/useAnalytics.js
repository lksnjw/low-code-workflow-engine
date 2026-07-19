import { useQuery } from "@tanstack/react-query";
import { analyticsService } from "../services/analytics.service";

export function useAnalytics() {
  const query = useQuery({ queryKey: ["analytics"], queryFn: analyticsService.load });
  return { data: query.data || null, loading: query.isLoading, error: query.error, reload: query.refetch };
}

export default useAnalytics;
