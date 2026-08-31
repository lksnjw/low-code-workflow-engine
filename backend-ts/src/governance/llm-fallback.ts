import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { GovernanceRequest } from "./adapter.js";

const roleAccessSchema = z.object({
  allowed_domains: z.array(z.string()),
  blocked_tools: z.array(z.string()),
  max_risk_level: z.enum(["low", "medium", "high"]),
  allow_write_operations: z.boolean(),
  notes: z.string().optional(),
});

const fallbackPolicySchema = z.object({
  version: z.string(),
  effective_date: z.string(),
  globally_blocked_tools: z.array(z.string()),
  tools_requiring_human_review: z.array(z.string()),
  role_access: z.record(z.string(), roleAccessSchema),
});

type FallbackPolicy = z.infer<typeof fallbackPolicySchema>;

export type LlmFallbackResult = {
  allowed: boolean;
  reason: string;
  source: "llm" | "static_policy" | "static_policy_error";
};

export type LlmFallbackConfig = {
  openrouterApiKey: string;
  model: string;
  policyPath: string;
  timeoutMs: number;
};

export class LlmPolicyFallback {
  readonly #apiKey: string;
  readonly #model: string;
  readonly #policyPath: string;
  readonly #timeoutMs: number;
  #cachedPolicy: FallbackPolicy | null = null;

  /*******************************************************************************
   * Function: constructor
   *
   * Initializes a LlmPolicyFallback instance with its required state.
   ******************************************************************************/
  constructor(config: LlmFallbackConfig) {
    this.#apiKey = config.openrouterApiKey.trim();
    this.#model = config.model.trim();
    this.#policyPath = config.policyPath;
    this.#timeoutMs = config.timeoutMs;
  }

  /*******************************************************************************
   * Function: evaluate
   *
   * Applies static fallback policy and optional LLM evaluation.
   ******************************************************************************/
  async evaluate(
    request: GovernanceRequest,
    readOnly: boolean,
    signal?: AbortSignal,
  ): Promise<LlmFallbackResult> {
    let policy: FallbackPolicy;
    try {
      policy = await this.#loadPolicy();
    } catch (error) {
      return {
        allowed: false,
        reason: `Governance fallback policy could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
        source: "static_policy_error",
      };
    }

    // Static policy is the authoritative ground truth.
    // If static allows → return immediately; the LLM never gets the chance to block it.
    // If static blocks → optionally ask the LLM (it may loosen the block based on context).
    const staticResult = this.#evaluateStatically(request, readOnly, policy);
    if (staticResult.allowed) return staticResult;

    // Static blocked — try LLM only as a potential override toward allow.
    if (this.#apiKey !== "" && this.#model !== "") {
      try {
        const llmResult = await this.#evaluateWithLlm(request, readOnly, policy, signal);
        if (llmResult.allowed) return llmResult;
      } catch {
        // LLM unavailable — keep static block
      }
    }

    return staticResult;
  }

  /*******************************************************************************
   * Function: #loadPolicy
   *
   * Loads and caches the validated fallback policy file.
   ******************************************************************************/
  async #loadPolicy(): Promise<FallbackPolicy> {
    if (this.#cachedPolicy !== null) return this.#cachedPolicy;
    const raw = await readFile(this.#policyPath, "utf8");
    const parsed = fallbackPolicySchema.parse(JSON.parse(raw));
    this.#cachedPolicy = parsed;
    return parsed;
  }

  /*******************************************************************************
   * Function: #evaluateWithLlm
   *
   * Requests an access decision from the configured fallback model.
   ******************************************************************************/
  async #evaluateWithLlm(
    request: GovernanceRequest,
    readOnly: boolean,
    policy: FallbackPolicy,
    signal?: AbortSignal,
  ): Promise<LlmFallbackResult> {
    const prompt = buildPrompt(request, readOnly, policy);
    const timeoutSignal = AbortSignal.timeout(this.#timeoutMs);
    const combined = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.#apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://workflow-engine.local",
        "X-Title": "Workflow Engine Governance Fallback",
      },
      body: JSON.stringify({
        model: this.#model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0,
        max_tokens: 300,
        response_format: { type: "json_object" },
      }),
      signal: combined,
    });

    if (!response.ok) {
      throw new Error(`OpenRouter returned HTTP ${response.status}`);
    }

    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content ?? "";
    if (content.trim() === "") throw new Error("empty LLM response");

    const parsed = JSON.parse(content) as { decision?: string; reason?: string };
    const allowed = parsed.decision?.toLowerCase() === "allow";
    return {
      allowed,
      reason: parsed.reason ?? "governance decision by offline LLM policy evaluation",
      source: "llm",
    };
  }

  /*******************************************************************************
   * Function: #evaluateStatically
   *
   * Evaluates the request against the local fallback role and action rules.
   ******************************************************************************/
  #evaluateStatically(
    request: GovernanceRequest,
    readOnly: boolean,
    policy: FallbackPolicy,
  ): LlmFallbackResult {
    const role = request.user.role;
    const rolePolicy = policy.role_access[role] ?? policy.role_access["default"] ?? null;

    if (rolePolicy === null) {
      return {
        allowed: false,
        reason: `Role "${role}" has no offline fallback policy and no default entry exists`,
        source: "static_policy",
      };
    }

    // Write operation check
    if (!readOnly && !rolePolicy.allow_write_operations) {
      return {
        allowed: false,
        reason: `Role "${role}" is not permitted to run write workflows in offline governance mode`,
        source: "static_policy",
      };
    }

    // Global block check
    for (const action of request.proposedActions) {
      if (policy.globally_blocked_tools.includes(action)) {
        return {
          allowed: false,
          reason: `Tool "${action}" is globally blocked by the offline fallback policy`,
          source: "static_policy",
        };
      }
    }

    // Role-level tool block check
    if (rolePolicy.blocked_tools.includes("*")) {
      return {
        allowed: false,
        reason: `Role "${role}" has all tools blocked in offline governance mode`,
        source: "static_policy",
      };
    }
    for (const action of request.proposedActions) {
      if (rolePolicy.blocked_tools.includes(action)) {
        return {
          allowed: false,
          reason: `Tool "${action}" is blocked for role "${role}" by the offline fallback policy`,
          source: "static_policy",
        };
      }
    }

    return {
      allowed: true,
      reason: `Permitted by offline fallback policy for role "${role}"`,
      source: "static_policy",
    };
  }
}

/*******************************************************************************
 * Function: buildPrompt
 *
 * Builds a fallback evaluation prompt from the policy and proposed request.
 ******************************************************************************/
function buildPrompt(
  request: GovernanceRequest,
  readOnly: boolean,
  policy: FallbackPolicy,
): string {
  return [
    "You are a workflow access control evaluator. Decide whether this workflow request should be allowed or blocked.",
    "Use ONLY the policy rules below. Do not invent reasons. Do not reference governance systems or error formats.",
    "",
    "POLICY:",
    JSON.stringify(policy, null, 2),
    "",
    "REQUEST:",
    `user_role: ${request.user.role}`,
    `proposed_actions: ${JSON.stringify(request.proposedActions)}`,
    `is_read_only: ${readOnly}`,
    "",
    "RULES (apply in order, stop at first match):",
    "1. If user_role is not in policy.role_access AND there is no 'default' key → BLOCK",
    "2. If any proposed_action is in policy.globally_blocked_tools → BLOCK",
    "3. If is_read_only is false AND the role's allow_write_operations is false → BLOCK",
    "4. If any proposed_action is in the role's blocked_tools list → BLOCK",
    "5. If the role's blocked_tools contains '*' → BLOCK",
    "6. Otherwise → ALLOW",
    "",
    'Respond with ONLY this JSON — no extra text, no markdown:',
    '{"decision":"allow","reason":"brief plain-English explanation"}',
    "or",
    '{"decision":"block","reason":"brief plain-English explanation"}',
  ].join("\n");
}
