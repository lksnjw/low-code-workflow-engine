import type { RouteDefinition } from "./generated-routes.js";

export type RoutePolicy = Readonly<{ required: string[]; any: boolean }>;

/** Mandatory HTTP authorization policy. Unknown protected routes fail closed. */
export function routePolicy(route: RouteDefinition): RoutePolicy | null {
  const path = route.path;
  if (path === "/api/dashboard/tasks" && route.method === "GET") return { required: ["workflow:read", "workflow:read_own", "execution:read_own"], any: true };
  if (path === "/api/workflows/:id/run-receipts/:key") return { required: ["workflow:read", "execution:read_own"], any: true };
  if (path.startsWith("/api/import")) return { required: ["registry:write"], any: false };
  if (["/api/pipeline/v1/library/delegation", "/api/pipeline/v1/library/search", "/api/pipeline/v1/library/resolve"].includes(path)) return { required: ["chat:use", "workflow:write"], any: true };
  if (path.startsWith("/api/pipeline/")) return { required: ["pipeline:upload"], any: false };
  if (path.includes("/attachments")) return { required: ["pipeline:upload"], any: false };
  // Must precede the general profile self-service exemption.
  if (path.startsWith("/api/profile/api-keys")) return { required: ["settings:manage"], any: false };
  if (path.startsWith("/ws/") || path.startsWith("/api/auth/") || path.startsWith("/api/company") ||
      path.startsWith("/api/profile") || path.startsWith("/api/notifications")) return null;
  if (path.startsWith("/api/users") || path.startsWith("/api/roles") || path.startsWith("/api/permissions"))
    return { required: ["user:manage"], any: false };
  if (path.startsWith("/api/audit")) return { required: ["audit:read"], any: false };
  if (path.startsWith("/api/registry")) return { required: [route.method === "GET" ? "registry:read" : "registry:write"], any: false };
  if (path.startsWith("/api/settings") || path.startsWith("/api/integrations") || path.includes("/api-keys"))
    return { required: ["settings:manage"], any: false };
  if (path.startsWith("/api/providers")) return { required: ["provider:manage"], any: false };
  if (path === "/api/execution-reviews" && route.method === "GET")
    return { required: ["execution:approve", "execution:reconcile"], any: true };
  if (path.startsWith("/api/executions")) {
    if (path === "/api/executions/:id/report-page-resolutions") return route.method === "GET"
      ? { required: ["workflow:read", "execution:read_own", "execution:reconcile"], any: true }
      : { required: ["execution:reconcile"], any: false };
    if (path === "/api/executions/:id/readbacks" && route.method === "GET")
      return { required: ["workflow:read", "execution:read_own", "execution:reconcile"], any: true };
    if (path === "/api/executions/:id/recovery-artifacts") return route.method === "GET"
      ? { required: ["workflow:read", "execution:read_own", "workflow:run", "workflow:run_own", "execution:reconcile"], any: true }
      : { required: ["workflow:run", "workflow:run_own"], any: true };
    if (path === "/api/executions/:id/reconcile" && route.method === "POST")
      return { required: ["execution:reconcile"], any: false };
    if (path === "/api/executions/:id" && route.method === "GET" || /\/executions\/:id\/(approve|reject)$/.test(path))
      return { required: route.method === "GET" ? ["workflow:read", "execution:read_own", "execution:approve", "execution:reconcile"] : ["workflow:run", "workflow:run_own", "execution:approve"], any: true };
    return route.method === "GET"
      ? { required: ["workflow:read", "execution:read_own"], any: true }
      : { required: ["workflow:run", "workflow:run_own"], any: true };
  }
  if (path.startsWith("/api/chat")) return {
    required: route.method === "GET" ? ["workflow:read", "chat:use"] : ["workflow:write", "chat:use"], any: true,
  };
  if (path.startsWith("/api/workflows") && path.endsWith("/run"))
    return { required: ["workflow:run", "workflow:run_own"], any: true };
  if (path.startsWith("/api/workflows") || path.startsWith("/api/synthesis") || path.startsWith("/api/tools") ||
      path.startsWith("/api/rules") || path.startsWith("/api/semantic") || path.startsWith("/api/canvas") ||
      path.startsWith("/api/dashboard") || path.startsWith("/api/analytics") || path.startsWith("/api/upload"))
    return route.method === "GET"
      ? { required: ["workflow:read", "workflow:read_own"], any: true }
      : { required: ["workflow:write"], any: false };
  return { required: [], any: true };
}
