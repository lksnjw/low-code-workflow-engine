import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  canonicalJSONBytes,
  resolvedParameterHash,
  resolvedParameterHashBytes,
} from "../core/canonical-json.js";
import {
  parseWorkflowYAMLStrict,
  workflowContentHash,
} from "../parser/workflow.js";
import { sensitiveFieldNames } from "../redact/secrets.js";
import type { RegistryService } from "../registry/service.js";
import type { RuleDefinition, ToolDefinition } from "../registry/schemas.js";
import type {
  DeferredCheck,
  PublicValidationToken,
  WorkflowBlueprint,
} from "../models/schemas.js";
import { effectiveStepKind } from "../models/schemas.js";
import type { Repository } from "../repository/store.js";
import type { DispatchIdentity } from "../tools/registry.js";

export type CandidateValidationResult = {
  candidate_id: string;
  passed: boolean;
  score: number;
  schema_ok: boolean;
  tool_validity_ok: boolean;
  parameters_ok: boolean;
  rbac_ok: boolean;
  policy_ok: boolean;
  process_order_ok: boolean;
  risk_ok: boolean;
  errors: string[];
  warnings: string[];
  failed_rules: string[];
  registry_versions: { tools: string; rules: string };
  estimated_risk_level: string;
  step_count: number;
  tool_risks: Record<string, string>;
  metadata: Record<string, unknown>;
  deferred_checks: DeferredCheck[];
};

export type ResolvedPolicyViolation = {
  ruleId: string;
  paramKey: string;
  reason: string;
  redactedValue: string;
};

export type ValidationToken = Readonly<PublicValidationToken>;
export type DispatchCapability = Readonly<object>;

type CapabilityPayload = Readonly<{
  workflowContentHash: string;
  registryHash: string;
  stepIndex: number;
  action: string;
  resolvedParameterHash: string;
  dispatchIdentity: DispatchIdentity;
  expiresAt: number;
  proof: Buffer;
}>;

const tokenProofs = new WeakMap<object, Buffer>();
const mintedCapabilities = new WeakSet<object>();
const consumedCapabilities = new WeakSet<object>();
const capabilityPayloads = new WeakMap<object, CapabilityPayload>();
const processSigningKey = randomBytes(32);

const evaluatedFamilies = new Set([
  "rbac",
  "parameter_required",
  "amount_threshold",
  "quantity_threshold",
  "process_order",
  "separation_of_duties",
  "risk_escalation",
  "audit",
  "data_confidentiality",
]);
const knownNoEvaluatorFamilies = new Set([
  "capability_gap",
  "cache_safety",
  "execution_safety",
]);
const riskRank: Record<string, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export function hasDeterministicRuleEvaluator(family: string): boolean {
  return evaluatedFamilies.has(normalize(family));
}

export class RegistryValidator {
  constructor(
    readonly registries: RegistryService,
    readonly repository: Repository,
    readonly capabilityTTLms = 30_000,
  ) {
    if (
      registries === null ||
      registries === undefined ||
      typeof registries.hash !== "function" ||
      typeof registries.snapshot !== "function"
    )
      throw new Error("registry validator requires a runtime registry service");
    if (
      repository === null ||
      repository === undefined ||
      typeof repository.mutate !== "function"
    )
      throw new Error("registry validator requires a repository");
  }

  async validateAndIssueToken(
    action: string,
    rawYAML: string,
    userRole: string,
  ): Promise<{
    token: ValidationToken | null;
    result: CandidateValidationResult;
  }> {
    const result = this.validatePlan(action, rawYAML, userRole);
    let token: ValidationToken | null = null;
    if (result.passed)
      token = mintValidationToken(
        rawYAML,
        this.registries.hash(),
        result.deferred_checks,
      );
    await this.audit(
      `validation.gate.${action}`,
      workflowContentHash(rawYAML),
      { path_action: action, passed: result.passed, rule_results: result },
    );
    return { token, result };
  }

  validatePlan(
    candidateID: string,
    rawYAML: string,
    userRole: string,
  ): CandidateValidationResult {
    const snapshot = this.registries.snapshot();
    const result = initialResult(candidateID, snapshot.versions);
    let workflow: WorkflowBlueprint;
    try {
      workflow = parseWorkflowYAMLStrict(rawYAML);
    } catch (error) {
      result.schema_ok = false;
      result.errors.push(`YAML_PARSE_ERROR: ${errorText(error)}`);
      finish(result);
      return result;
    }
    result.step_count = workflow.steps.length;
    if (
      workflow.name.trim() === "" ||
      workflow.trigger.type.trim() === "" ||
      workflow.steps.length < 1
    ) {
      result.schema_ok = false;
      result.errors.push("SCHEMA_INVALID: YAML failed schema validation");
    }
    if ((workflow.description ?? "").trim() === "") {
      result.schema_ok = false;
      result.errors.push(
        "SCHEMA_DESCRIPTION_REQUIRED: generated workflow candidates require a non-empty description",
      );
    }

    const usedTools: ToolDefinition[] = [];
    const actions: string[] = [];
    workflow.steps.forEach((step, stepIndex) => {
      const kind = effectiveStepKind(step);
      if (step.id.trim() === "") {
        result.schema_ok = false;
        result.errors.push(`SCHEMA_INVALID: step ${stepIndex + 1} requires id`);
      }
      if (kind === "analysis") {
        this.validateAnalysisStructure(workflow, stepIndex, result);
        return;
      }
      if (kind === "approval") {
        // A human sign-off checkpoint — no tool to resolve, no dispatch policy
        // applies. Only requires the id (checked above) and a description.
        if ((step.description ?? "").trim() === "") {
          result.schema_ok = false;
          result.errors.push(
            `SCHEMA_INVALID: approval step ${step.id} requires a description stating what is being authorized`,
          );
        }
        return;
      }
      if (kind !== "tool") {
        result.schema_ok = false;
        result.errors.push(
          `STEP_KIND_INVALID: step ${step.id} has unsupported kind ${kind}`,
        );
        return;
      }
      const action = (step.action ?? "").trim();
      actions.push(action);
      const tool = this.registries.findTool(action);
      if (tool === undefined) {
        const rule001 = snapshot.rules.find((r) => r.rule_id === "GLOBAL-SAFETY-001");
        const rule001Enabled = rule001 === undefined || rule001.enabled !== false;
        if (rule001Enabled) {
          result.tool_validity_ok = false;
          failRule(
            result,
            "GLOBAL-SAFETY-001",
            `Unknown or hallucinated tool ${JSON.stringify(action)} in step ${step.id}`,
          );
        } else {
          result.warnings.push(
            `GLOBAL-SAFETY-001 (rule disabled): tool ${JSON.stringify(action)} in step ${step.id} is not in the registry — step may fail at runtime`,
          );
        }
        return;
      }
      usedTools.push(tool);
      result.tool_risks[action] = tool.risk_level;
      if (
        (riskRank[normalize(tool.risk_level)] ?? 0) >
        (riskRank[normalize(result.estimated_risk_level)] ?? 0)
      )
        result.estimated_risk_level = normalize(tool.risk_level);
      if (tool.status !== "" && tool.status !== "active_mcp_schema_present") {
        result.tool_validity_ok = false;
        failRule(
          result,
          "CAP-GAP-001",
          `Tool ${action} is unavailable with status ${tool.status}`,
        );
      }
      const parameters = step.parameters ?? {};
      for (const key of tool.required_parameters) {
        if (isEmptyParameter(parameters[key])) {
          result.parameters_ok = false;
          failRule(
            result,
            "MISSING_PARAMETER",
            `Required parameter ${key} is missing for ${action}`,
          );
        }
      }
      if (!roleAllowed(userRole, tool.allowed_roles)) {
        result.rbac_ok = false;
        result.errors.push(
          `RBAC_DENIED: Role ${JSON.stringify(userRole)} is not allowed to execute ${action} in step ${step.id}`,
        );
      }
      const sensitive = findSensitiveKey(parameters);
      if (sensitive !== null) {
        result.policy_ok = false;
        failRule(
          result,
          "GLOBAL-SAFETY-002",
          `Step ${step.id} contains sensitive credential-like parameter`,
        );
      }
    });

    // Skip rule evaluation when the YAML/schema is fundamentally invalid — the errors are already recorded.
    if (!result.schema_ok) {
      finish(result);
      return result;
    }

    for (const rule of this.registries.enabledRules()) {
      const family = normalize(rule.rule_type);
      // Families that intentionally have no deterministic evaluator — skip silently.
      if (knownNoEvaluatorFamilies.has(family)) continue;
      if (!evaluatedFamilies.has(family)) {
        result.policy_ok = false;
        failRule(
          result,
          rule.rule_id,
          `NO_EVALUATOR: enabled rule ${rule.rule_id} in family ${family} has no deterministic evaluator`,
        );
        continue;
      }
      if (!ruleApplies(rule, usedTools, userRole, result.estimated_risk_level))
        continue;
      this.evaluatePlanRule(rule, workflow, actions, userRole, result);
    }
    finish(result);
    return result;
  }

  verifyToken(token: ValidationToken | null): boolean {
    if (token === null || typeof token !== "object") return false;
    const proof = tokenProofs.get(token);
    if (proof === undefined) return false;
    const expected = tokenProof(token);
    return (
      proof.byteLength === expected.byteLength &&
      timingSafeEqual(proof, expected)
    );
  }

  async evaluateResolvedStep(
    action: string,
    rawYAML: string,
    stepIndex: number,
    params: Record<string, unknown>,
    token: ValidationToken | null,
    dispatchIdentity: DispatchIdentity,
  ): Promise<{
    capability: DispatchCapability | null;
    violation: ResolvedPolicyViolation | null;
  }> {
    const workflowHash = workflowContentHash(rawYAML);
    if (token === null || !this.verifyToken(token))
      return this.dispatchFailure(
        action,
        workflowHash,
        stepIndex,
        "VALIDATION_TOKEN_INVALID",
        "",
        "validation token is missing or invalid",
        params,
      );
    if (token.workflow_content_hash !== workflowHash)
      return this.dispatchFailure(
        action,
        workflowHash,
        stepIndex,
        "WORKFLOW_CONTENT_MISMATCH",
        "",
        "workflow content changed after validation",
        params,
      );
    if (token.registry_hash !== this.registries.hash())
      return this.dispatchFailure(
        action,
        workflowHash,
        stepIndex,
        "REGISTRY_MISMATCH",
        "",
        "registry changed after validation",
        params,
      );
    if (!validDispatchIdentity(dispatchIdentity))
      return this.dispatchFailure(
        action,
        workflowHash,
        stepIndex,
        "DISPATCH_IDENTITY_INVALID",
        "",
        "dispatch identity is invalid",
        params,
      );
    const workflow = parseWorkflowYAMLStrict(rawYAML);
    const step = workflow.steps[stepIndex];
    if (step === undefined || effectiveStepKind(step) !== "tool")
      return this.dispatchFailure(
        action,
        workflowHash,
        stepIndex,
        "STEP_INDEX_INVALID",
        "",
        "validated tool step does not exist",
        params,
      );
    const stepAction = (step.action ?? "").trim();
    const sensitive = findSensitiveKey(params);
    if (sensitive !== null)
      return this.dispatchFailure(
        action,
        workflowHash,
        stepIndex,
        "GLOBAL-SAFETY-002",
        sensitive,
        "credential-shaped resolved parameter is not allowed",
        params,
      );
    for (const check of token.deferred_checks ?? []) {
      if (check.step_index !== stepIndex) continue;
      for (const ruleID of check.rule_ids) {
        const rule = this.registries.findRule(ruleID);
        if (rule === undefined || !rule.enabled)
          return this.dispatchFailure(
            action,
            workflowHash,
            stepIndex,
            ruleID,
            check.param_key,
            "deferred rule is missing or disabled",
            params,
          );
        const violation = evaluateDeferredRule(rule, check.param_key, params);
        if (violation !== null)
          return this.dispatchFailure(
            action,
            workflowHash,
            stepIndex,
            ruleID,
            check.param_key,
            violation,
            params,
          );
      }
    }
    const capability = mintCapability({
      workflowContentHash: workflowHash,
      registryHash: this.registries.hash(),
      stepIndex,
      action: stepAction,
      resolvedParameterHash: resolvedParameterHash(params),
      dispatchIdentity,
      expiresAt: Date.now() + this.capabilityTTLms,
    });
    await this.audit(action, workflowHash, {
      passed: true,
      step_index: stepIndex,
      checked_rule_ids: (token.deferred_checks ?? [])
        .filter((item) => item.step_index === stepIndex)
        .flatMap((item) => item.rule_ids),
    });
    return { capability, violation: null };
  }

  verifyAndConsumeCapability(
    capability: DispatchCapability,
    action: string,
    exactParameterBytes: Uint8Array,
    dispatchIdentity: DispatchIdentity,
  ): void {
    if (
      typeof capability !== "object" ||
      capability === null ||
      !mintedCapabilities.has(capability)
    )
      throw new Error("dispatch capability was not minted by the validator");
    const payload = capabilityPayloads.get(capability);
    if (payload === undefined)
      throw new Error("dispatch capability payload is unavailable");
    const expectedProof = capabilityProof(payload);
    if (
      payload.proof.byteLength !== expectedProof.byteLength ||
      !timingSafeEqual(payload.proof, expectedProof)
    )
      throw new Error("dispatch capability HMAC is invalid");
    if (Date.now() > payload.expiresAt)
      throw new Error("dispatch capability has expired");
    if (consumedCapabilities.has(capability))
      throw new Error("dispatch capability has already been consumed");
    if (
      resolvedParameterHashBytes(exactParameterBytes) !==
      payload.resolvedParameterHash
    )
      throw new Error("dispatch capability parameter hash mismatch");
    if (payload.action !== action)
      throw new Error("dispatch capability action mismatch");
    if (
      !validDispatchIdentity(dispatchIdentity) ||
      !sameDispatchIdentity(payload.dispatchIdentity, dispatchIdentity)
    )
      throw new Error("dispatch capability identity mismatch");
    consumedCapabilities.add(capability);
  }

  enabledRulesWithoutEvaluator(): { ruleId: string; family: string }[] {
    return this.registries
      .enabledRules()
      .filter((rule) => !evaluatedFamilies.has(normalize(rule.rule_type)))
      .map((rule) => ({
        ruleId: rule.rule_id,
        family: normalize(rule.rule_type),
      }))
      .sort(
        (a, b) =>
          a.family.localeCompare(b.family) || a.ruleId.localeCompare(b.ruleId),
      );
  }

  private validateAnalysisStructure(
    workflow: WorkflowBlueprint,
    stepIndex: number,
    result: CandidateValidationResult,
  ): void {
    const step = workflow.steps[stepIndex];
    if (step === undefined) return;
    if ((step.instruction ?? "").trim() === "") {
      result.schema_ok = false;
      result.errors.push(
        `ANALYSIS_INSTRUCTION_REQUIRED: step ${step.id} requires instruction`,
      );
    }
    if ((step.max_input_items ?? 0) < 0 || (step.max_input_chars ?? 0) < 0) {
      result.schema_ok = false;
      result.errors.push(
        `ANALYSIS_INPUT_LIMIT_INVALID: step ${step.id} has a negative input limit`,
      );
    }
    const match =
      /^\{\{\s*([a-zA-Z0-9_-]+)\.output(?:\.[a-zA-Z0-9_.-]+)?\s*\}\}$/.exec(
        (step.input ?? "").trim(),
      );
    if (match?.[1] === undefined) {
      result.schema_ok = false;
      result.errors.push(
        `ANALYSIS_INPUT_INVALID: step ${step.id} input must reference prior output`,
      );
      return;
    }
    if (
      !workflow.steps.slice(0, stepIndex).some((prior) => prior.id === match[1])
    ) {
      result.schema_ok = false;
      result.errors.push(
        `ANALYSIS_INPUT_SOURCE_UNDECLARED: step ${step.id} references ${match[1]}`,
      );
    }
  }

  private evaluatePlanRule(
    rule: RuleDefinition,
    workflow: WorkflowBlueprint,
    actions: string[],
    userRole: string,
    result: CandidateValidationResult,
  ): void {
    const family = normalize(rule.rule_type);
    if (family === "rbac") {
      const roleMatches =
        rule.applies_to_roles.length > 0 &&
        rule.applies_to_roles.some(
          (role) => normalizeRole(role) === normalizeRole(userRole),
        );
      if (!roleMatches) return;
      if (
        rule.enforcement_action === "block" &&
        actions.some((action) => matchesTool(rule, action))
      ) {
        result.rbac_ok = false;
        failRule(
          result,
          rule.rule_id,
          ruleMessage(rule, "Role is blocked from this tool"),
        );
      }
      return;
    }
    if (family === "process_order") {
      const pair = asStringList(rule.condition.value);
      if (pair.length >= 2) {
        const before = actions.indexOf(pair[0] ?? "");
        const after = actions.lastIndexOf(pair[1] ?? "");
        if (after >= 0 && (before < 0 || before > after)) {
          result.process_order_ok = false;
          failRule(
            result,
            rule.rule_id,
            ruleMessage(rule, "Workflow process order is invalid"),
          );
        }
      }
      return;
    }
    if (family === "separation_of_duties") {
      for (const step of workflow.steps) {
        const requester = String(step.parameters?.requester_id ?? "");
        const approver = String(step.parameters?.approver_id ?? "");
        if (
          requester !== "" &&
          requester !== "<nil>" &&
          requester === approver
        ) {
          result.policy_ok = false;
          failRule(
            result,
            rule.rule_id,
            ruleMessage(rule, "Requester and approver must differ"),
          );
          return;
        }
      }
      return;
    }
    if (family === "risk_escalation") {
      if (
        (riskRank[normalize(result.estimated_risk_level)] ?? 0) >= 3 &&
        !hasApproval(actions)
      ) {
        result.risk_ok = false;
        failRule(
          result,
          rule.rule_id,
          ruleMessage(
            rule,
            "High-risk workflow requires approval.request_human_approval.",
          ),
        );
      }
      return;
    }
    if (family === "audit") {
      const hasWriteOrRisk = workflow.steps.some((step) => {
        const tool = this.registries.findTool(step.action ?? "");
        return (
          tool !== undefined &&
          (!tool.is_read_only ||
            (riskRank[normalize(tool.risk_level)] ?? 0) >= 3)
        );
      });
      if (
        hasWriteOrRisk &&
        !actions.some((item) => normalize(item) === "audit.write_audit_log")
      ) {
        result.policy_ok = false;
        failRule(
          result,
          rule.rule_id,
          ruleMessage(rule, "Workflow requires an audit log step"),
        );
      }
      return;
    }
    if (family === "parameter_required") {
      for (const step of workflow.steps) {
        if (!matchesTool(rule, step.action ?? "")) continue;
        for (const key of asStringList(rule.condition.value)) {
          const value = step.parameters?.[key];
          if (containsTemplate(value))
            addDeferred(
              result,
              workflow.steps.indexOf(step),
              key,
              rule.rule_id,
            );
          else if (isEmptyParameter(value)) {
            result.parameters_ok = false;
            failRule(
              result,
              rule.rule_id,
              ruleMessage(rule, `Required parameter ${key} is missing`),
            );
          }
        }
      }
      return;
    }
    if (family === "amount_threshold" || family === "quantity_threshold") {
      const threshold = asNumber(rule.condition.value);
      const key = rule.condition.parameter.trim();
      if (threshold === null || key === "") return;
      workflow.steps.forEach((step, index) => {
        if (!matchesTool(rule, step.action ?? "")) return;
        const value = step.parameters?.[key];
        if (containsTemplate(value)) {
          addDeferred(result, index, key, rule.rule_id);
          return;
        }
        const numeric = asNumber(value);
        if (
          numeric === null ||
          !compare(numeric, threshold, rule.condition.operator)
        )
          return;
        const enforced =
          rule.enforcement_action === "block" ||
          (rule.enforcement_action === "require_human_approval" &&
            !hasApproval(actions));
        if (enforced) {
          result.policy_ok = false;
          result.risk_ok = false;
          failRule(
            result,
            rule.rule_id,
            ruleMessage(rule, `${key} exceeds policy threshold`),
          );
        }
      });
    }
  }

  private async dispatchFailure(
    action: string,
    workflowHash: string,
    stepIndex: number,
    ruleId: string,
    paramKey: string,
    reason: string,
    params: Record<string, unknown>,
  ): Promise<{ capability: null; violation: ResolvedPolicyViolation }> {
    const violation = {
      ruleId,
      paramKey,
      reason,
      redactedValue: boundedValue(paramKey === "" ? "" : params[paramKey]),
    };
    await this.audit(action, workflowHash, {
      passed: false,
      step_index: stepIndex,
      failed_rule_id: ruleId,
      failed_param_key: paramKey,
      reason,
    });
    return { capability: null, violation };
  }

  private async audit(
    action: string,
    resourceID: string,
    after: Record<string, unknown>,
  ): Promise<void> {
    await this.repository.mutate((state) => {
      state.auditLogs.push({
        id: `audit_${state.auditLogs.length + 1}`,
        action,
        resource: { type: "workflow_validation", id: resourceID },
        before: null,
        after,
        createdAt: new Date().toISOString(),
        source: "deterministic-validation-gate-ts",
      });
    });
  }
}

function mintValidationToken(
  rawYAML: string,
  registryHash: string,
  deferredChecks: DeferredCheck[],
): ValidationToken {
  const token = Object.freeze({
    workflow_content_hash: workflowContentHash(rawYAML),
    registry_hash: registryHash,
    passed_at: new Date().toISOString(),
    deferred_checks: structuredClone(deferredChecks),
  });
  tokenProofs.set(token, tokenProof(token));
  return token;
}

function tokenProof(token: ValidationToken): Buffer {
  return createHmac("sha256", processSigningKey)
    .update(canonicalJSONBytes(token))
    .digest();
}

function mintCapability(
  input: Omit<CapabilityPayload, "proof">,
): DispatchCapability {
  const proof = capabilityProof(input);
  const capability = Object.freeze({
    workflowContentHash: input.workflowContentHash,
    registryHash: input.registryHash,
    stepIndex: input.stepIndex,
    action: input.action,
    resolvedParameterHash: input.resolvedParameterHash,
    dispatchIdentity: Object.freeze({ ...input.dispatchIdentity }),
    expiresAt: input.expiresAt,
    proof: proof.toString("hex"),
  });
  const payload = Object.freeze({ ...input, proof: Buffer.from(proof) });
  mintedCapabilities.add(capability);
  capabilityPayloads.set(capability, payload);
  return capability;
}

function capabilityProof(
  input: Omit<CapabilityPayload, "proof"> | CapabilityPayload,
): Buffer {
  return createHmac("sha256", processSigningKey)
    .update(
      canonicalJSONBytes({
        workflowContentHash: input.workflowContentHash,
        registryHash: input.registryHash,
        stepIndex: input.stepIndex,
        action: input.action,
        resolvedParameterHash: input.resolvedParameterHash,
        dispatchIdentity: input.dispatchIdentity,
        expiresAt: input.expiresAt,
      }),
    )
    .digest();
}

function initialResult(
  candidateID: string,
  versions: { tools: string; rules: string },
): CandidateValidationResult {
  return {
    candidate_id: candidateID,
    passed: false,
    score: 0,
    schema_ok: true,
    tool_validity_ok: true,
    parameters_ok: true,
    rbac_ok: true,
    policy_ok: true,
    process_order_ok: true,
    risk_ok: true,
    errors: [],
    warnings: [],
    failed_rules: [],
    registry_versions: { ...versions },
    estimated_risk_level: "low",
    step_count: 0,
    tool_risks: {},
    metadata: {},
    deferred_checks: [],
  };
}

function finish(result: CandidateValidationResult): void {
  result.failed_rules = [...new Set(result.failed_rules)].sort();
  result.score =
    Math.round(
      (Number(result.schema_ok) * 0.2 +
        Number(result.tool_validity_ok) * 0.2 +
        Number(result.parameters_ok) * 0.2 +
        Number(result.rbac_ok) * 0.15 +
        Number(result.policy_ok) * 0.15 +
        Number(result.process_order_ok) * 0.05 +
        Number(result.risk_ok) * 0.05) *
        100,
    ) / 100;
  result.passed =
    result.schema_ok &&
    result.tool_validity_ok &&
    result.parameters_ok &&
    result.rbac_ok &&
    result.policy_ok &&
    result.process_order_ok &&
    result.risk_ok &&
    result.errors.length === 0;
}

function failRule(
  result: CandidateValidationResult,
  ruleID: string,
  message: string,
): void {
  result.failed_rules.push(ruleID);
  result.errors.push(message);
}
function ruleMessage(rule: RuleDefinition, fallback: string): string {
  return rule.validator_message.trim() === ""
    ? fallback
    : rule.validator_message;
}
function normalizeRole(value: string): string {
  const normalized = normalize(value).replace(/[ -]/g, "_");
  return normalized === "platform_admin" ? "admin" : normalized;
}
function roleAllowed(role: string, allowed: string[]): boolean {
  if (allowed.length === 0 || normalizeRole(role) === "admin") return true;
  return allowed.some((item) => normalizeRole(item) === normalizeRole(role));
}
function normalize(value: string): string {
  return value.trim().toLowerCase();
}
function isEmptyParameter(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === "string" &&
      ["", "<nil>", "null"].includes(normalize(value)))
  );
}
function containsTemplate(value: unknown): boolean {
  if (typeof value === "string")
    return value.includes("{{") && value.includes("}}");
  if (Array.isArray(value)) return value.some(containsTemplate);
  if (typeof value === "object" && value !== null)
    return Object.values(value).some(containsTemplate);
  return false;
}
function findSensitiveKey(value: unknown, path = ""): string | null {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findSensitiveKey(item, `${path}[${index}]`);
      if (found !== null) return found;
    }
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  for (const [key, item] of Object.entries(value)) {
    const next = path === "" ? key : `${path}.${key}`;
    if (
      sensitiveFieldNames().some((fragment) =>
        normalize(key).includes(fragment),
      )
    )
      return next;
    const found = findSensitiveKey(item, next);
    if (found !== null) return found;
  }
  return null;
}
function ruleApplies(
  rule: RuleDefinition,
  tools: ToolDefinition[],
  role: string,
  risk: string,
): boolean {
  if (
    rule.applies_to_roles.length > 0 &&
    !rule.applies_to_roles.some(
      (item) => normalizeRole(item) === normalizeRole(role),
    )
  )
    return false;
  if (rule.applies_to_tools.length > 0)
    return tools.some((tool) =>
      rule.applies_to_tools.some((item) =>
        [tool.name, tool.tool_id, tool.mcp_tool_name].some(
          (identity) => normalize(identity) === normalize(item),
        ),
      ),
    );
  if (normalize(rule.domain) === "global" || rule.rule_id.startsWith("GLOBAL-"))
    return true;
  if (normalize(rule.rule_type) === "risk_escalation")
    return (
      (riskRank[normalize(risk)] ?? 0) >=
      (riskRank[normalize(String(rule.condition.value ?? "high"))] ?? 3)
    );
  return tools.some(
    (tool) =>
      normalize(tool.module) === normalize(rule.domain) ||
      normalize(tool.erp_system ?? "").includes(normalize(rule.domain)),
  );
}
function matchesTool(rule: RuleDefinition, action: string): boolean {
  return (
    rule.applies_to_tools.length === 0 ||
    rule.applies_to_tools.some((item) => normalize(item) === normalize(action))
  );
}
function asStringList(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.map(String);
  return [];
}
function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (
    typeof value === "string" &&
    value.trim() !== "" &&
    !value.trim().startsWith("{{")
  ) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
function compare(left: number, right: number, operator: string): boolean {
  switch (operator) {
    case ">":
      return left > right;
    case ">=":
      return left >= right;
    case "<":
      return left < right;
    case "<=":
      return left <= right;
    case "==":
      return left === right;
    case "!=":
      return left !== right;
    default:
      return false;
  }
}
function hasApproval(actions: string[]): boolean {
  return actions.some(
    (item) =>
      normalize(item) === "approval.request_human_approval" ||
      normalize(item).includes("approve") ||
      normalize(item).includes("approval"),
  );
}
function addDeferred(
  result: CandidateValidationResult,
  stepIndex: number,
  paramKey: string,
  ruleID: string,
): void {
  let check = result.deferred_checks.find(
    (item) => item.step_index === stepIndex && item.param_key === paramKey,
  );
  if (check === undefined) {
    check = { step_index: stepIndex, param_key: paramKey, rule_ids: [] };
    result.deferred_checks.push(check);
  }
  if (!check.rule_ids.includes(ruleID)) check.rule_ids.push(ruleID);
  check.rule_ids.sort();
}
function evaluateDeferredRule(
  rule: RuleDefinition,
  paramKey: string,
  params: Record<string, unknown>,
): string | null {
  const family = normalize(rule.rule_type);
  const value = params[paramKey];
  if (family === "parameter_required")
    return isEmptyParameter(value) || containsTemplate(value)
      ? "required resolved parameter is absent or unresolved"
      : null;
  if (family === "amount_threshold" || family === "quantity_threshold") {
    const numeric = asNumber(value);
    const threshold = asNumber(rule.condition.value);
    if (numeric === null || threshold === null)
      return "resolved threshold value is not numeric";
    return compare(numeric, threshold, rule.condition.operator) &&
      rule.enforcement_action === "block"
      ? ruleMessage(rule, `${paramKey} exceeds policy threshold`)
      : null;
  }
  if (family === "data_confidentiality")
    return findSensitiveKey(params) === null
      ? null
      : "resolved parameters contain credential-shaped data";
  if (!evaluatedFamilies.has(family) || knownNoEvaluatorFamilies.has(family))
    return `NO_EVALUATOR: enabled rule ${rule.rule_id} in family ${family} has no deterministic evaluator`;
  return null;
}
function boundedValue(value: unknown): string {
  const text = String(value ?? "").trim();
  return [...text].length <= 4 ? text : [...text].slice(0, 4).join("") + "…";
}
function validDispatchIdentity(
  identity: DispatchIdentity | null | undefined,
): identity is DispatchIdentity {
  return (
    identity !== null &&
    identity !== undefined &&
    identity.userId.trim() !== "" &&
    identity.localRole.trim() !== "" &&
    (identity.erpbridgeRole === null || identity.erpbridgeRole.trim() !== "")
  );
}

function sameDispatchIdentity(
  left: DispatchIdentity,
  right: DispatchIdentity,
): boolean {
  return (
    left.userId === right.userId &&
    left.localRole === right.localRole &&
    left.erpbridgeRole === right.erpbridgeRole
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export { resolvedParameterHash, resolvedParameterHashBytes };
