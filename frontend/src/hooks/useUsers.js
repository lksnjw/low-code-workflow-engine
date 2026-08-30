import { useQuery } from "@tanstack/react-query";
import { userService } from "../services/user.service";

/*******************************************************************************
 * Function: useUsers
 *
 * Provides users for the useUsers module.
 ******************************************************************************/
export function useUsers() {
  const query = useQuery({ queryKey: ["user-administration"], queryFn: userService.loadAdministration });
  return { data: query.data || null, loading: query.isLoading, error: query.error, reload: query.refetch };
}

export default useUsers;
