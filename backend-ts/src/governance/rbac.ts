// ════════════════════════════════════════════════════════════════════════════
//  POLICY CHECKER TOGGLE
//  Optional advisory checks are a runtime setting stored in the
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
/** Reads the optional advisory policy setting. This setting never disables
 * mandatory route authorization or required execution policy decisions. */
export async function isPolicyCheckerEnabled(repository: Repository): Promise<boolean> {
  return repository.read((state) => {
    const rbac = state.settings.rbac;
    return typeof rbac === "object" && rbac !== null && (rbac as Record<string, unknown>).enabled === true;
  });
}

// ── ERP Bridge policy tools ───────────────────────────────────────────────
// Deployment-specific policy tools; not guaranteed ERPBridge built-ins.
// Required decisions remain mandatory regardless of the advisory toggle.

/** Evaluates a finance request against policy before write operations (TOOL_CALL). */
export const ERP_POLICY_EVALUATE_TOOL = "policy-gate-evaluate";

/** Plans read-only finance lookup tool calls (QUERY path planner). */
export const ERP_POLICY_ASSIST_TOOL = "policy-gate-assist";

// ── Types ─────────────────────────────────────────────────────────────────

export type ErpBridgeSession = {
  callToolDirect: (name: string, args: Record<string, unknown>) => Promise<unknown>;
};

export type ErpPolicyResult = { allowed: boolean; decision: "allow" | "deny" | "review"; reason?: string };

// ── policy-gate-evaluate call ─────────────────────────────────────────────
// Used for required TOOL_CALL policy decisions, independently of the toggle.
//
// actor  – RAG identity from the authenticated session (user_id + role)
// prompt – natural-language description of the action being attempted
// context – ERP facts known at call time (tool name, arguments, etc.)
//
// Returns { allowed, reason? }. Required decisions fail closed.

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
  if (bridgeSession === undefined) return { allowed: false, decision: "deny", reason: "ERP policy service is not connected" };

  const actor = { user_id: params.userId, role: params.userRole };
  const prompt = params.prompt ?? `Execute operation: ${params.action}`;

  try {
    const raw = await bridgeSession.callToolDirect(ERP_POLICY_EVALUATE_TOOL, {
      actor,
      prompt,
      ...(params.context !== undefined ? { context: params.context } : {}),
    });

    return interpretPolicyResponse(raw);
  } catch {
    return { allowed: false, decision: "deny", reason: "ERP policy decision is unavailable; execution is blocked" };
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
export function interpretPolicyResponse(raw: unknown): ErpPolicyResult {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return invalidPolicyResponse();
  const r = raw as Record<string, unknown>;
  if (r.isError === true || ("isError" in r && typeof r.isError !== "boolean")) return invalidPolicyResponse();
  if (!("content" in r) && !("structuredContent" in r)) return interpretDecision(r);
  // Never accept decision fields outside a protocol envelope's payload.
  if (["allowed", "decision", "result"].some((key) => key in r)) return invalidPolicyResponse();
  if (!Array.isArray(r.content) || r.content.length > 1) return invalidPolicyResponse();
  let textPayload: unknown;
  if (r.content.length === 1) {
    const block = r.content[0];
    if (block === null || typeof block !== "object" || block.type !== "text" || typeof block.text !== "string") return invalidPolicyResponse();
    try { textPayload = JSON.parse(block.text); } catch { /* Structured payload may have a human-readable summary. */ }
  }
  if ("structuredContent" in r) {
    const structured = interpretDecision(r.structuredContent);
    // A second machine-readable payload must not contradict the authority.
    if (textPayload !== undefined && interpretDecision(textPayload).decision !== structured.decision) return invalidPolicyResponse();
    return structured;
  }
  return interpretDecision(textPayload);
}

function interpretDecision(raw: unknown): ErpPolicyResult {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return invalidPolicyResponse();
  const r = raw as Record<string, unknown>;
  const decisions: ErpPolicyResult["decision"][] = [];
  if ("content" in r || "structuredContent" in r || "isError" in r) return invalidPolicyResponse();
  if ("allowed" in r) {
    if (typeof r.allowed !== "boolean") return invalidPolicyResponse();
    decisions.push(r.allowed ? "allow" : "deny");
  }
  for (const key of ["decision", "result"]) {
    if (!(key in r)) continue;
    if (typeof r[key] !== "string") return invalidPolicyResponse();
    const value = r[key].toLowerCase();
    if (["allow", "approved", "permitted"].includes(value)) decisions.push("allow");
    else if (["deny", "denied", "blocked", "answer"].includes(value)) decisions.push("deny");
    else if (["review", "conditional", "allow_with_conditions"].includes(value)) decisions.push("review");
    else return invalidPolicyResponse();
  }
  if (decisions.length === 0 || decisions.some((value) => value !== decisions[0])) return invalidPolicyResponse();
  if ("conditions" in r && !Array.isArray(r.conditions)) return invalidPolicyResponse();
  // A policy answer, data request or unrecognised request type is never an
  // executable authorization. Legacy explicit decisions may omit request_type.
  if ("request_type" in r && r.request_type !== "action")
    return { allowed: false, decision: "deny", reason: "ERP policy response is not an action authorization" };
  const conditional = Array.isArray(r.conditions) && r.conditions.length > 0;
  const decision = decisions[0] === "allow" && conditional ? "review" : decisions[0]!;
  // Conditions require separate system enforcement, even when the external
  // service marks them satisfied. This adapter never promotes review to allow.
  return { allowed: decision === "allow", decision, ...(typeof r.reason === "string" ? { reason: r.reason } :
    conditional ? { reason: "ERP policy requires unresolved conditions" } : {}) };
}

function invalidPolicyResponse(): ErpPolicyResult {
  return { allowed: false, decision: "deny", reason: "ERP policy returned no valid authorization decision" };
}
