// ════════════════════════════════════════════════════════════════════════════
//  POLICY CHECKER TOGGLE
//  Whether policy / role checks run at all is a runtime setting stored in the
//  database (state.settings.rbac.enabled), controlled from Settings > Policy
//  Checker in the UI — not a hardcoded constant. Callers resolve the current
//  value with isPolicyCheckerEnabled(repository) rather than importing a flag.
// ════════════════════════════════════════════════════════════════════════════

import type { Repository } from "../repository/store.js";

/*******************************************************************************
 * Function: isPolicyCheckerEnabled
 *
 * Reads whether the policy checker is enabled in repository settings.
 ******************************************************************************/
/** Reads the current policy-checker setting from the database. Defaults to
 *  off (fail-open) until an admin explicitly turns it on in Settings. */
export async function isPolicyCheckerEnabled(repository: Repository): Promise<boolean> {
  return repository.read((state) => {
    const rbac = state.settings.rbac;
    return typeof rbac === "object" && rbac !== null && (rbac as Record<string, unknown>).enabled === true;
  });
}

// ── ERP Bridge policy tools ───────────────────────────────────────────────
// These are the live ERP Bridge MCP tools used when RBAC is enabled.
// No env vars or config files — policy lives entirely in the ERP Bridge.

/** Evaluates a finance request against policy before write operations (TOOL_CALL). */
export const ERP_POLICY_EVALUATE_TOOL = "policy-gate-evaluate";

/** Plans read-only finance lookup tool calls (QUERY path planner). */
export const ERP_POLICY_ASSIST_TOOL = "policy-gate-assist";

// ── Types ─────────────────────────────────────────────────────────────────

export type ErpBridgeSession = {
  callToolDirect: (name: string, args: Record<string, unknown>) => Promise<unknown>;
};

export type ErpPolicyResult = { allowed: boolean; reason?: string };

// ── policy-gate-evaluate call ─────────────────────────────────────────────
// Called before every TOOL_CALL (write) operation when RBAC is enabled.
//
// actor  – identity from the authenticated session (id + role)
// prompt – natural-language description of the action being attempted
// context – ERP facts known at call time (tool name, arguments, etc.)
//
// Returns { allowed, reason? }. Fails-open if the tool errors or is missing.

/*******************************************************************************
 * Function: checkErpPolicy
 *
 * Evaluates an operation through the ERPBridge policy tool when available.
 ******************************************************************************/
export async function checkErpPolicy(
  bridgeSession: ErpBridgeSession | undefined,
  params: {
    userId: string;
    userRole: string;
    action: string;                          // tool name / operation
    prompt?: string;                         // human-readable description
    context?: Record<string, unknown>;       // ERP facts (args, amount, etc.)
  },
): Promise<ErpPolicyResult> {
  if (bridgeSession === undefined) return { allowed: true };

  const actor = { id: params.userId, role: params.userRole };
  const prompt = params.prompt ?? `Execute operation: ${params.action}`;

  try {
    const raw = await bridgeSession.callToolDirect(ERP_POLICY_EVALUATE_TOOL, {
      actor,
      prompt,
      ...(params.context !== undefined ? { context: params.context } : {}),
    });

    return interpretPolicyResponse(raw);
  } catch {
    // Tool not found or network error → fail-open so ERP outages don't lock users out.
    return { allowed: true };
  }
}

// ── policy-gate-assist call ───────────────────────────────────────────────
// Used in the QUERY path to plan which read-only tools to call.
// Returns the raw tool response (a plan / tool-call list) — callers decide
// what to do with it.

/*******************************************************************************
 * Function: assistQueryPlan
 *
 * Requests query-planning assistance from the ERPBridge policy tool.
 ******************************************************************************/
export async function assistQueryPlan(
  bridgeSession: ErpBridgeSession | undefined,
  params: {
    userId: string;
    userRole: string;
    prompt: string;
    tools?: unknown[];
    context?: Record<string, unknown>;
    history?: unknown[];
  },
): Promise<unknown | null> {
  if (bridgeSession === undefined) return null;

  const actor = { id: params.userId, role: params.userRole };

  try {
    return await bridgeSession.callToolDirect(ERP_POLICY_ASSIST_TOOL, {
      actor,
      prompt: params.prompt,
      ...(params.tools !== undefined ? { tools: params.tools } : {}),
      ...(params.context !== undefined ? { context: params.context } : {}),
      ...(params.history !== undefined ? { history: params.history } : {}),
    });
  } catch {
    return null; // fail-open
  }
}

// ── Response interpreter ──────────────────────────────────────────────────
// Handles multiple response shapes the ERP Bridge might return.

/*******************************************************************************
 * Function: interpretPolicyResponse
 *
 * Normalizes supported ERP policy response shapes into an access decision.
 ******************************************************************************/
function interpretPolicyResponse(raw: unknown): ErpPolicyResult {
  if (raw === null || typeof raw !== "object") return { allowed: true };

  const r = raw as Record<string, unknown>;

  // Shape: { allowed: boolean, reason?: string }
  if ("allowed" in r) {
    return {
      allowed: Boolean(r.allowed),
      ...(typeof r.reason === "string" ? { reason: r.reason } : {}),
    };
  }

  // Shape: { decision: "approved" | "denied" | "conditional", reason?: string }
  if ("decision" in r) {
    const decision = String(r.decision).toLowerCase();
    const allowed = decision === "approved" || decision === "allow" || decision === "permitted";
    const reason =
      typeof r.reason === "string"
        ? r.reason
        : Array.isArray(r.conditions)
          ? (r.conditions as string[]).join("; ")
          : undefined;
    return { allowed, ...(reason !== undefined ? { reason } : {}) };
  }

  // Shape: { result: "allow" | "deny" }
  if ("result" in r) {
    const allowed = String(r.result).toLowerCase() !== "deny" && String(r.result).toLowerCase() !== "denied";
    return { allowed };
  }

  return { allowed: true }; // unknown shape → fail-open
}
