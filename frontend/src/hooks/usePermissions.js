import { useMemo } from "react";
import { useAuthContext } from "../context/AuthContext";
import { hasAnyPermission, hasPermission } from "../utils/permission.utils";

export function usePermissions() {
  const { user } = useAuthContext();

  return useMemo(
    () => ({
      has: (permission) => hasPermission(user, permission),
      hasAny: (permissions) => hasAnyPermission(user, permissions),
      role: user?.role ?? "",
      roleId: user?.roleId ?? "",
    }),
    [user]
  );
}

export default usePermissions;
