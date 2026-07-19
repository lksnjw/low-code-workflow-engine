import { useQuery } from "@tanstack/react-query";
import { semanticService } from "../services/semantic.service";

export function useSemanticStatus() {
  return useQuery({ queryKey: ["semantic-index"], queryFn: semanticService.status, refetchInterval: 30_000 });
}

export default useSemanticStatus;
