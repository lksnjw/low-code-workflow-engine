/*******************************************************************************
 * Function: hasPermission
 *
 * Determines whether permission for the permission utils module.
 ******************************************************************************/
export function hasPermission(user, permission) {
  if (!user || !permission) return false;
  return Array.isArray(user.permissions) && user.permissions.includes(permission);
}

/*******************************************************************************
 * Function: hasAnyPermission
 *
 * Determines whether any permission for the permission utils module.
 ******************************************************************************/
export function hasAnyPermission(user, permissions = []) {
  if (permissions.length === 0) return true;
  return permissions.some((permission) => hasPermission(user, permission));
}

/*******************************************************************************
 * Function: resolveRouteComponent
 *
 * Resolves route component for the permission utils module.
 ******************************************************************************/
export function resolveRouteComponent(route, hasAny, AccessDeniedPage) {
  if (!route) return null;
  return route.requiredAny?.length > 0 && !hasAny(route.requiredAny)
    ? AccessDeniedPage
    : route.Component;
}
