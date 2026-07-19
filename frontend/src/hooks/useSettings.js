import { useQuery } from "@tanstack/react-query";
import { settingsService } from "../services/settings.service";

export function useSettings() {
  const query = useQuery({ queryKey: ["settings"], queryFn: settingsService.load });
  return { data: query.data || null, loading: query.isLoading, error: query.error, reload: query.refetch };
}

export default useSettings;
