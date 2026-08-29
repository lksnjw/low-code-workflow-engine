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

  constructor(config: LlmFallbackConfig) {
    this.#apiKey = config.openrouterApiKey.trim();
    this.#model = config.model.trim();
    this.#policyPath = config.policyPath;
    this.#timeoutMs = config.timeoutMs;
  }

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

    // Try LLM evaluation if a key is configured
    if (this.#apiKey !== "" && this.#model !== "") {
      try {
        return await this.#evaluateWithLlm(request, readOnly, policy, signal);
      } catch {
        // LLM unavailable — fall through to static evaluation
      }
    }

    return this.#evaluateStatically(request, readOnly, policy);
  }

  async #loadPolicy(): Promise<FallbackPolicy> {
    if (this.#cachedPolicy !== null) return this.#cachedPolicy;
    const raw = await readFile(this.#policyPath, "utf8");
    const parsed = fallbackPolicySchema.parse(JSON.parse(raw));
    this.#cachedPolicy = parsed;
    return parsed;
  }

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

function buildPrompt(
  request: GovernanceRequest,
  readOnly: boolean,
  policy: FallbackPolicy,
): string {
  return [
    "You are a governance policy evaluator operating in OFFLINE mode.",
    "The external governance service is unavailable. Use ONLY the policy below to decide.",
    "",
    "OFFLINE GOVERNANCE POLICY:",
    JSON.stringify(policy, null, 2),
    "",
    "WORKFLOW REQUEST TO EVALUATE:",
    JSON.stringify(
      {
        user_role: request.user.role,
        intent: request.intent,
        proposed_actions: request.proposedActions,
        is_read_only: readOnly,
        context: request.caseContext,
      },
      null,
      2,
    ),
    "",
    "DECISION RULES:",
    "1. If user role is not in role_access and there is no 'default' entry → BLOCK",
    "2. If any proposed action is in globally_blocked_tools → BLOCK",
    "3. If is_read_only=false and role's allow_write_operations=false → BLOCK",
    "4. If any proposed action is in the role's blocked_tools → BLOCK",
    "5. If blocked_tools contains '*' → BLOCK all tools for that role",
    "6. Otherwise → ALLOW",
    "",
    "Return ONLY this exact JSON (no other text, no markdown fence):",
    '{ "decision": "allow", "reason": "..." }',
    "OR",
    '{ "decision": "block", "reason": "..." }',
  ].join("\n");
}
