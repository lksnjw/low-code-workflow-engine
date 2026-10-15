import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { GovernanceRequest } from "./adapter.js";

const roleAccessSchema = z.object({
  allowed_domains: z.array(z.string()),
  blocked_tools: z.array(z.string()),
  allowed_tools: z.array(z.string().min(1)).optional(),
  max_risk_level: z.enum(["low", "medium", "high"]),
  allow_write_operations: z.boolean(),
  notes: z.string().optional(),
});

export const fallbackPolicySchema = z.object({
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
  readonly #policyPath: string;
  #cachedPolicy: FallbackPolicy | null = null;

  /*******************************************************************************
   * Function: constructor
   *
   * Initializes a LlmPolicyFallback instance with its required state.
   ******************************************************************************/
  constructor(config: LlmFallbackConfig) {
    // Legacy model/key options remain accepted for configuration compatibility,
    // but a model is never consulted for an authorization decision.
    this.#policyPath = config.policyPath;
  }

  /*******************************************************************************
   * Function: evaluate
   *
   * Applies read-only static fallback policy. LLMs cannot override denial.
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

    if (signal?.aborted) return { allowed: false, reason: "Policy evaluation was cancelled", source: "static_policy" };
    return this.#evaluateStatically(request, readOnly, policy);
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

    // Offline policy never authorizes business effects, even for admins.
    if (!readOnly) {
      return {
        allowed: false,
        reason: "Side-effecting workflows require fresh policy and verified runtime approval; offline fallback cannot authorize writes",
        source: "static_policy",
      };
    }

    // Global block check
    for (const action of request.proposedActions) {
      if (policy.tools_requiring_human_review.includes(action)) return {
        allowed: false, reason: `Tool "${action}" requires human review; offline fallback cannot grant approval`, source: "static_policy",
      };
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
      if (rolePolicy.allowed_tools && !rolePolicy.allowed_tools.includes(action)) return {
        allowed: false, reason: `Tool "${action}" is outside the reviewed offline allowance for role "${role}"`, source: "static_policy",
      };
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
