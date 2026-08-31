import { createHash } from "node:crypto";
import { z } from "zod";

import { jsonValueSchema } from "../models/schemas.js";
import type { RuleDefinition } from "../registry/schemas.js";
import { hasDeterministicRuleEvaluator } from "../validator/registry-validator.js";

const governanceConditionSchema = z.object({
  field: z.string().min(1),
  operator: z.string().min(1),
  value: jsonValueSchema,
}).strict();

const governanceRuleSchema = z.object({
  id: z.string().min(1),
  family: z.string().min(1),
  condition: governanceConditionSchema,
  effect: z.string().min(1),
  enabled: z.boolean().optional(),
  name: z.string().optional(),
  domain: z.string().optional(),
  description: z.string().optional(),
  appliesToTools: z.array(z.string()).optional(),
  appliesToRoles: z.array(z.string()).optional(),
  severity: z.string().optional(),
  validatorMessage: z.string().optional(),
  promptInstruction: z.string().optional(),
  healingGuidance: z.string().optional(),
  bpiAlignment: z.array(z.string()).optional(),
  auditFieldsRequired: z.array(z.string()).optional(),
  conditionType: z.string().optional(),
}).strict();

const governanceResponseSchema = z.object({
  policyVersion: z.string().min(1),
  rules: z.array(governanceRuleSchema),
  evidenceIds: z.array(z.string()).optional(),
  recommended_decision: z.string().optional(),
}).strict();

export type GovernanceRequest = {
  requestId: string;
  user: { id: string; role: string; department: string | null };
  intent: string;
  proposedActions: string[];
  caseContext: Record<string, unknown>;
};

export type GovernanceSource = "primary" | "secondary";

export type GovernancePolicySet = {
  policyVersion: string;
  rules: RuleDefinition[];
  evidenceIds: string[];
  ruleVersion: string;
  source: GovernanceSource;
};

export type GovernanceFailureKind = "timeout" | "unreachable" | "parse";

export class GovernanceAdapterError extends Error {
  /*******************************************************************************
   * Function: constructor
   *
   * Initializes a GovernanceAdapterError instance with its required state.
   ******************************************************************************/
  constructor(message: string, readonly kind: GovernanceFailureKind) {
    super(message);
    this.name = "GovernanceAdapterError";
  }
}

export type GovernanceAdapterConfiguration = {
  url: string;
  apiKey: string;
  timeoutMs: number;
  source: GovernanceSource;
  fetchImplementation?: typeof fetch;
};

export class GovernanceAdapter {
  readonly #url: string;
  readonly #apiKey: string;
  readonly #timeoutMs: number;
  readonly #source: GovernanceSource;
  readonly #fetch: typeof fetch;

  /*******************************************************************************
   * Function: constructor
   *
   * Initializes a GovernanceAdapter instance with its required state.
   ******************************************************************************/
  constructor(configuration: GovernanceAdapterConfiguration) {
    this.#url = configuration.url.trim();
    this.#apiKey = configuration.apiKey.trim();
    this.#timeoutMs = configuration.timeoutMs;
    this.#source = configuration.source;
    this.#fetch = configuration.fetchImplementation ?? fetch;
    if (this.#url === "") throw new Error("governance URL is required");
    if (this.#apiKey === "") throw new Error("governance API key is required");
    if (!Number.isInteger(this.#timeoutMs) || this.#timeoutMs <= 0) throw new Error("governance timeout must be a positive integer");
  }

  /*******************************************************************************
   * Function: fetchPolicy
   *
   * Requests and validates a policy snapshot from the governance service.
   ******************************************************************************/
  async fetchPolicy(request: GovernanceRequest, signal?: AbortSignal): Promise<GovernancePolicySet> {
    const timeoutSignal = AbortSignal.timeout(this.#timeoutMs);
    const combinedSignal = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);
    let response: Response;
    try {
      response = await this.#fetch(this.#url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(request),
        signal: combinedSignal,
      });
    } catch {
      if (timeoutSignal.aborted) throw new GovernanceAdapterError("governance request timed out", "timeout");
      throw new GovernanceAdapterError("governance endpoint is unreachable", "unreachable");
    }
    if (!response.ok) throw new GovernanceAdapterError(`governance endpoint returned HTTP ${response.status}`, "unreachable");
    let decoded: unknown;
    try {
      decoded = await response.json();
    } catch {
      throw new GovernanceAdapterError("governance response was not valid JSON", "parse");
    }
    const parsed = governanceResponseSchema.safeParse(decoded);
    if (!parsed.success) throw new GovernanceAdapterError(`governance response did not match the typed contract: ${parsed.error.issues.map((issue) => issue.path.join(".") || "response").join(", ")}`, "parse");
    const unsupported = parsed.data.rules
      .filter((rule) => !hasDeterministicRuleEvaluator(rule.family))
      .map((rule) => ({ id: rule.id, family: rule.family }));
    if (unsupported.length > 0) {
      throw new GovernanceAdapterError(
        `governance policy contains rules without deterministic evaluators: ${unsupported.map((rule) => `${rule.id} (${rule.family})`).join(", ")}`,
        "parse",
      );
    }
    const rules = parsed.data.rules.map(mapRule);
    const ruleVersion = `sha256:${createHash("sha256").update(JSON.stringify(rules)).digest("hex").slice(0, 16)}`;
    return {
      policyVersion: parsed.data.policyVersion,
      rules,
      evidenceIds: parsed.data.evidenceIds ?? [],
      ruleVersion,
      source: this.#source,
    };
  }
}

/*******************************************************************************
 * Function: mapRule
 *
 * Converts an external governance rule into a registry rule definition.
 ******************************************************************************/
function mapRule(rule: z.infer<typeof governanceRuleSchema>): RuleDefinition {
  return {
    rule_id: rule.id,
    rule_name: rule.name ?? rule.id,
    rule_type: rule.family,
    domain: rule.domain ?? "global",
    description: rule.description ?? "",
    applies_to_tools: rule.appliesToTools ?? [],
    applies_to_roles: rule.appliesToRoles ?? [],
    condition: {
      type: rule.conditionType ?? "",
      parameter: rule.condition.field,
      operator: rule.condition.operator,
      value: rule.condition.value,
    },
    enforcement_action: rule.effect,
    severity: rule.severity ?? "",
    validator_message: rule.validatorMessage ?? rule.description ?? "",
    llm_prompt_instruction: rule.promptInstruction ?? "",
    healing_guidance: rule.healingGuidance ?? "",
    bpi_alignment: rule.bpiAlignment ?? [],
    audit_fields_required: rule.auditFieldsRequired ?? [],
    enabled: rule.enabled ?? true,
  };
}
