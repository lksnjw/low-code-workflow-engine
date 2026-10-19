import { allRolesToolAccess, toolRoleAllowed } from "../../governance/tool-access.js";
import type { FastifyReply, FastifyRequest } from "fastify";
import { fail, ok } from "../../models/schemas.js";
import type { RouteDefinition } from "../generated-routes.js";
import { discoverTools } from "../../agent/tool-discovery.js";
import {
  HandlerFailure,
  type CurrentUser,
  type HandlerServices,
  queryRecord,
  stringValue,
} from "./common.js";
import {
  ANALYTICS_DASHBOARD_UNHANDLED,
  handleAnalyticsDashboardRoute,
} from "./analytics-dashboard.js";
import {
  handleSynthesisCanvasRoute,
  SYNTHESIS_CANVAS_UNHANDLED,
} from "./synthesis-canvas.js";
import { getPersonalDashboard } from "./personal-dashboard.js";
import { publicInputSchema } from "../../tools/public-input-schema.js";

export const ANALYTICS_UNHANDLED = Symbol("analytics-unhandled");

/*******************************************************************************
 * Function: handleAnalyticsCatalogRoute
 *
 * Dispatches analytics, dashboard, catalog, synthesis, and canvas requests.
 ******************************************************************************/
export async function handleAnalyticsCatalogRoute(
  route: RouteDefinition,
  request: FastifyRequest,
  reply: FastifyReply,
  user: CurrentUser,
  services: HandlerServices,
): Promise<unknown | typeof ANALYTICS_UNHANDLED> {
  const base = services.config.apiBasePath;
  try {
    if (route.path === `${base}/dashboard/tasks` && route.method === "GET") return await getPersonalDashboard(request, reply, user, services);
    const synthesisCanvasResponse = await handleSynthesisCanvasRoute(
      route,
      request,
      reply,
      user,
      services,
    );
    if (synthesisCanvasResponse !== SYNTHESIS_CANVAS_UNHANDLED)
      return synthesisCanvasResponse;
    const analyticsDashboardResponse = await handleAnalyticsDashboardRoute(
      route,
      request,
      reply,
      services,
    );
    if (analyticsDashboardResponse !== ANALYTICS_DASHBOARD_UNHANDLED)
      return analyticsDashboardResponse;
    if (route.path === `${base}/tools/catalog`)
      return toolsCatalog(request, reply, user, services);
    if (route.path === `${base}/rules/catalog`)
      return rulesCatalog(request, reply, services);
    if (route.path === `${base}/semantic-search`)
      throw new HandlerFailure(503, "semantic search is not configured");
    if (
      route.path === `${base}/semantic-index/health` ||
      route.path === `${base}/semantic-index/metadata`
    )
      throw new HandlerFailure(
        503,
        "semantic search service is not configured",
      );
    if (route.path === `${base}/semantic-index/rebuild`)
      throw new HandlerFailure(
        503,
        "semantic search service is not configured",
      );
  } catch (error) {
    if (error instanceof HandlerFailure)
      return reply.status(error.status).send(fail(error.message, error.meta));
    throw error;
  }
  return ANALYTICS_UNHANDLED;
}

/*******************************************************************************
 * Function: toolsCatalog
 *
 * Returns discovered tools filtered by module, role, and status.
 ******************************************************************************/
async function toolsCatalog(
  request: FastifyRequest,
  reply: FastifyReply,
  user: CurrentUser,
  services: HandlerServices,
): Promise<unknown> {
  const query = queryRecord(request);
  const moduleName = stringValue(query.module).toLowerCase();
  const role = stringValue(query.role).toLowerCase();
  const status = stringValue(query.status).toLowerCase();
  const liveTools = await discoverTools(services.erpbridgeSession ?? null, services.registries);
  const tools = liveTools.filter(
      (tool) =>
        toolRoleAllowed(tool.allowed_roles, user.role) &&
        (moduleName === "" || tool.module.toLowerCase() === moduleName) &&
        (status === "" || tool.status.toLowerCase() === status) &&
        (allRolesToolAccess() || role === "" ||
          tool.allowed_roles.length === 0 ||
          tool.allowed_roles.some((item) => item.toLowerCase() === role)),
    )
    .map((tool) => ({
      tool_id: tool.tool_id,
      name: tool.name,
      display_name: tool.display_name,
      module: tool.module,
      status: tool.status,
      risk_level: tool.risk_level,
      description: tool.description,
      allowed_roles: tool.allowed_roles,
      required_parameters: tool.required_parameters,
      optional_parameters: tool.optional_parameters,
      is_read_only: tool.is_read_only,
      input_schema: publicInputSchema(tool.input_schema),
    }));
  return reply.send(ok(tools, "Tool catalog loaded", { count: tools.length }));
}
/*******************************************************************************
 * Function: rulesCatalog
 *
 * Returns registry rules filtered by domain and enabled status.
 ******************************************************************************/
async function rulesCatalog(
  request: FastifyRequest,
  reply: FastifyReply,
  services: HandlerServices,
): Promise<unknown> {
  const query = queryRecord(request);
  const domain = stringValue(query.domain).toLowerCase();
  const enabled = stringValue(query.enabled).toLowerCase();
  const rules = services.registries
    .snapshot()
    .rules.filter(
      (rule) =>
        (domain === "" || rule.domain.toLowerCase() === domain) &&
        (enabled === "" || String(rule.enabled) === enabled),
    )
    .map((rule) => ({
      rule_id: rule.rule_id,
      rule_name: rule.rule_name,
      rule_type: rule.rule_type,
      domain: rule.domain,
      enabled: rule.enabled,
      severity: rule.severity,
      description: rule.description,
    }));
  return reply.send(ok(rules, "Rule catalog loaded", { count: rules.length }));
}
