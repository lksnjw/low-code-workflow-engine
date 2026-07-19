export function hasPermission(user, permission) {
  if (!user || !permission) return false;
  return Array.isArray(user.permissions) && user.permissions.includes(permission);
}

export function hasAnyPermission(user, permissions = []) {
  if (permissions.length === 0) return true;
  return permissions.some((permission) => hasPermission(user, permission));
}

export function resolveRouteComponent(route, hasAny, AccessDeniedPage) {
  if (!route) return null;
  return route.requiredAny?.length > 0 && !hasAny(route.requiredAny)
    ? AccessDeniedPage
    : route.Component;
}
