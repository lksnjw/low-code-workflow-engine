import { z } from "zod";
import { HandlerFailure, type CurrentUser, type HandlerServices } from "../http/handlers/common.js";
import { assertActorAuthority } from "../http/handlers/model-selection.js";
import { DEFAULT_BRIDGE_CONNECTION } from "./capability-admission.js";
import { remoteCatalogHash } from "./discovered-contract.js";

const querySchema = z.object({ source: z.literal("erpbridge").optional(), connectionId: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/).optional(),
  offset: z.coerce.number().int().min(0).max(2048).default(0), limit: z.union([z.literal("all"), z.coerce.number().int().min(1).max(50)]).default(20),
  search: z.string().trim().max(160).default(""), toolName: z.string().min(1).max(256).optional() }).strict();

/** Inventory, not permission. Always fetch the connected bridge's latest full
 * inventory before projecting one small page. Never merge local/static tools,
 * persist reviews, enable capabilities, or dispatch a business operation. */
export async function liveErpTools(services: HandlerServices, user: CurrentUser, rawQuery: unknown, signal?: AbortSignal) {
  const parsed = querySchema.safeParse(rawQuery);
  if (!parsed.success) throw new HandlerFailure(400, "Invalid ERPBridge catalog query");
  const query = parsed.data, runtime = services.mcpConnectionRuntime;
  const primary = runtime?.primaryConnectionId ?? DEFAULT_BRIDGE_CONNECTION, id = query.connectionId ?? primary;
  if (runtime && !runtime.hasConnection(id) || !runtime && id !== primary) throw new HandlerFailure(404, "ERPBridge connection not found");
  const assertAccess = () => services.repository.readAuthoritative(state => {
    if (!assertActorAuthority(state, user).includes("registry:read")) throw new HandlerFailure(403, "Registry read access is required");
  });
  await assertAccess();
  await runtime?.ensureSession(id);
  const session = runtime?.sessionFor(id) ?? (id === primary ? services.erpbridgeSession : undefined);
  if (!session || session.available === false) throw new HandlerFailure(503, "ERPBridge is not connected. No saved or built-in tools are shown.");
  let tools;
  try { tools = await session.listTools(signal); }
  catch { throw new HandlerFailure(503, "The latest ERPBridge tool list could not be loaded. No saved or built-in tools are shown."); }
  await assertAccess();
  if (tools.length > 2048 || new Set(tools.map(tool => tool.name)).size !== tools.length) throw new HandlerFailure(503, "ERPBridge returned an incomplete or ambiguous tool inventory");
  const discoveredAt = new Date().toISOString();
  if (query.toolName !== undefined) {
    const tool = tools.find(tool => tool.name === query.toolName);
    if (!tool) throw new HandlerFailure(404, "This tool is no longer exposed by ERPBridge. Refresh the list.");
    return { source: "erpbridge" as const, connectionId: id, discoveredAt, tool: structuredClone(tool) };
  }
  const search = query.search.toLowerCase();
  const matches = tools.filter(tool => !search || `${tool.name} ${tool.description ?? ""}`.toLowerCase().includes(search))
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  const limit = query.limit === "all" ? Math.max(1, matches.length) : query.limit;
  const offset = query.limit === "all" ? 0 : matches.length ? Math.min(query.offset, Math.floor((matches.length - 1) / limit) * limit) : 0;
  return { source: "erpbridge" as const, connectionId: id, discoveredAt, catalogHash: remoteCatalogHash(tools),
    connections: runtime?.connectionCatalog() ?? [{ id, primary: true, dispatchSupported: true }],
    total: tools.length, matchedCount: matches.length, offset, limit,
    nextOffset: offset + limit < matches.length ? offset + limit : null,
    tools: matches.slice(offset, offset + limit).map(tool => ({ name: tool.name, description: tool.description?.slice(0, 300) ?? "",
      effect: tool.annotations?.readOnlyHint === true ? "READ" : "CHANGE_OR_OTHER" })) };
}
