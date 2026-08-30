import type { ToolDefinition } from "../registry/schemas.js";
import type { ErpbridgeMcpSession } from "../tools/erpbridge-mcp-client.js";
import type { RegistryService } from "../registry/service.js";

const CACHE_TTL_MS = 60_000;

let cachedTools: readonly ToolDefinition[] | null = null;
let cacheExpiresAt = 0;

export async function discoverTools(
  session: ErpbridgeMcpSession | null,
  registries: RegistryService,
): Promise<readonly ToolDefinition[]> {
  const now = Date.now();
  if (cachedTools !== null && now < cacheExpiresAt) return cachedTools;

  const byMcpName = new Map(registries.snapshot().tools.map((t) => [t.mcp_tool_name, t]));

  if (session === null) {
    cachedTools = Object.freeze([]);
    cacheExpiresAt = now + CACHE_TTL_MS;
    return cachedTools;
  }

  try {
    const liveMcpTools = await session.listTools();
    const merged: ToolDefinition[] = [];

    for (const liveT of liveMcpTools) {
      const existing = byMcpName.get(liveT.name);
      if (existing !== undefined) {
        merged.push(existing);
      } else {
        merged.push({
          tool_id: `dynamic_${liveT.name}`,
          name: liveT.name,
          mcp_tool_name: liveT.name,
          display_name: humanizeName(liveT.name),
          description: (liveT as unknown as { description?: string }).description ?? "",
          is_read_only: false,
          allowed_roles: [],
          input_schema: (liveT as unknown as { inputSchema?: unknown }).inputSchema ?? { type: "object", properties: {} },
          module: "dynamic",
          risk_level: "medium",
          erp_system: "erpbridge",
        } as unknown as ToolDefinition);
      }
    }

    cachedTools = Object.freeze(merged);
    cacheExpiresAt = now + CACHE_TTL_MS;
    return cachedTools;
  } catch {
    cachedTools = Object.freeze([]);
    cacheExpiresAt = now + CACHE_TTL_MS;
    return cachedTools;
  }
}

export function invalidateToolDiscoveryCache(): void {
  cachedTools = null;
  cacheExpiresAt = 0;
}

function humanizeName(name: string): string {
  return name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
