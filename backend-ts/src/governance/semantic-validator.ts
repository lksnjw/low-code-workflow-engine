import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { ErpbridgeMcpSession } from "../tools/erpbridge-mcp-client.js";

export type SemanticValidatorContext = {
  toolName: string;
  toolDisplayName: string;
  arguments: Record<string, unknown>;
  userRole: string;
  userId: string;
  sessionId?: string;
  traceId?: string;
};

export type SemanticValidationResult = {
  allowed: boolean;
  reason?: string;
  source: "env" | "policy_file" | "mcp_policy" | "default_allow";
};

type PolicyEntry = {
  tool?: string;
  tool_pattern?: string;
  denied_roles?: string[];
  allowed_roles?: string[];
  deny_reason?: string;
};

type PolicyFile = {
  version?: string;
  entries?: PolicyEntry[];
};

let _policyCache: PolicyEntry[] | null = null;
let _policyCachedAt = 0;
const POLICY_CACHE_TTL_MS = 30_000;

function loadPolicyFiles(): PolicyEntry[] {
  const now = Date.now();
  if (_policyCache !== null && now - _policyCachedAt < POLICY_CACHE_TTL_MS) return _policyCache;

  const policyDir = resolve(process.cwd(), "policy/semantic");
  let files: string[] = [];
  try { files = readdirSync(policyDir).filter((f) => f.endsWith(".json")); } catch { /* no policy dir */ }

  const entries: PolicyEntry[] = [];
  for (const file of files) {
    try {
      const content = JSON.parse(readFileSync(resolve(policyDir, file), "utf8")) as PolicyFile;
      if (Array.isArray(content.entries)) entries.push(...content.entries);
    } catch { /* skip malformed */ }
  }

  _policyCache = entries;
  _policyCachedAt = now;
  return entries;
}

function matchesToolName(entry: PolicyEntry, toolName: string): boolean {
  if (entry.tool !== undefined) return entry.tool === toolName;
  if (entry.tool_pattern !== undefined) {
    try { return new RegExp(entry.tool_pattern, "i").test(toolName); } catch { return false; }
  }
  return false;
}

// Source 1: env vars — POLICY_DENIED_TOOLS=tool_a,tool_b and POLICY_DENIED_ROLES=Manager:tool_a,Client:tool_b
function checkEnvPolicy(ctx: SemanticValidatorContext): SemanticValidationResult | null {
  const deniedTools = (process.env.POLICY_DENIED_TOOLS ?? "").split(",").map((t) => t.trim()).filter(Boolean);
  if (deniedTools.includes(ctx.toolName)) {
    return { allowed: false, reason: `Tool "${ctx.toolName}" is globally blocked by environment policy.`, source: "env" };
  }

  const deniedRoles = (process.env.POLICY_DENIED_ROLES ?? "").split(",").map((t) => t.trim()).filter(Boolean);
  for (const pair of deniedRoles) {
    const sep = pair.indexOf(":");
    if (sep < 0) continue;
    const role = pair.slice(0, sep).trim();
    const tool = pair.slice(sep + 1).trim();
    if (role.toLowerCase() === ctx.userRole.toLowerCase() && tool === ctx.toolName) {
      return { allowed: false, reason: `Role "${ctx.userRole}" is not permitted to call "${ctx.toolName}" (env policy).`, source: "env" };
    }
  }
  return null;
}

// Source 2: JSON policy files in policy/semantic/
function checkFilePolicy(ctx: SemanticValidatorContext): SemanticValidationResult | null {
  const entries = loadPolicyFiles();
  for (const entry of entries) {
    if (!matchesToolName(entry, ctx.toolName)) continue;

    if (Array.isArray(entry.denied_roles) && entry.denied_roles.some((r) => r.toLowerCase() === ctx.userRole.toLowerCase())) {
      return { allowed: false, reason: entry.deny_reason ?? `Role "${ctx.userRole}" is not allowed to call "${ctx.toolName}".`, source: "policy_file" };
    }

    if (Array.isArray(entry.allowed_roles)) {
      const permitted = entry.allowed_roles.some((r) => r.toLowerCase() === ctx.userRole.toLowerCase() || r === "*");
      if (!permitted) {
        return { allowed: false, reason: entry.deny_reason ?? `Role "${ctx.userRole}" is not in the allowed list for "${ctx.toolName}".`, source: "policy_file" };
      }
    }
  }
  return null;
}

// Source 3: MCP check_policy tool (optional — called if session exposes it)
async function checkMcpPolicy(ctx: SemanticValidatorContext, session: ErpbridgeMcpSession): Promise<SemanticValidationResult | null> {
  try {
    const tools = await session.listTools();
    const hasPolicyTool = tools.some((t) => t.name === "check_policy");
    if (!hasPolicyTool) return null;

    const raw = await session.callToolDirect("check_policy", {
      tool_name: ctx.toolName,
      user_role: ctx.userRole,
      user_id: ctx.userId,
      arguments: ctx.arguments,
    }) as unknown;

    if (raw !== null && typeof raw === "object") {
      const resp = raw as Record<string, unknown>;
      const allowed = resp.allowed !== false;
      if (!allowed) {
        const reason = typeof resp.reason === "string" ? resp.reason : undefined;
        return reason !== undefined ? { allowed: false, reason, source: "mcp_policy" } : { allowed: false, source: "mcp_policy" };
      }
    }
  } catch { /* MCP policy tool unavailable — fall through */ }
  return null;
}

export async function validateSemantics(
  ctx: SemanticValidatorContext,
  session: ErpbridgeMcpSession | null,
): Promise<SemanticValidationResult> {
  // 1. Env vars (fastest, synchronous)
  const envResult = checkEnvPolicy(ctx);
  if (envResult !== null) return envResult;

  // 2. Policy files (synchronous with cache)
  const fileResult = checkFilePolicy(ctx);
  if (fileResult !== null) return fileResult;

  // 3. MCP policy tool (async, optional)
  if (session !== null) {
    const mcpResult = await checkMcpPolicy(ctx, session);
    if (mcpResult !== null) return mcpResult;
  }

  return { allowed: true, source: "default_allow" };
}

export function invalidatePolicyCache(): void {
  _policyCache = null;
  _policyCachedAt = 0;
}
