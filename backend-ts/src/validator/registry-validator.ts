import { validateRequirementNotes } from "./requirement-notes.js";
import { allRolesToolAccess, toolRoleAllowed } from "../governance/tool-access.js";
import {
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
  WorkflowBlueprint,
} from "../models/schemas.js";
import { effectiveStepKind } from "../models/schemas.js";
import { supportedOperation } from "../registry/capability-admission.js";
import type { Repository } from "../repository/store.js";
import type { DispatchIdentity } from "../tools/registry.js";
import { definedTraceAuditMetadata, type TraceAuditMetadata } from "../trace/audit-trace.js";
import {
  consumeDispatchCapability,
  mintDispatchCapability,
  mintValidationToken,
  validDispatchIdentity,
  verifyValidationToken,
  type DispatchCapability,
  type ValidationToken,
} from "./capability-authority.js";
import {
  validateAgentStepStructure,
  validateAnalysisStepStructure,
} from "./step-structure.js";
export type { DispatchCapability, ValidationToken } from "./capability-authority.js";
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

/*******************************************************************************
 * Function: hasDeterministicRuleEvaluator
 *
 * Checks whether a rule family has a deterministic evaluator.
 ******************************************************************************/
export function hasDeterministicRuleEvaluator(family: string): boolean {
  return evaluatedFamilies.has(normalize(family));
}

export class RegistryValidator {
  /*******************************************************************************
   * Function: constructor
   *
   * Initializes a RegistryValidator instance with its required state.
   ******************************************************************************/
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

  /*******************************************************************************
   * Function: validateAndIssueToken
   *
   * Validates a workflow plan, records the result, and issues a token on
   * success.
   ******************************************************************************/
  async validateAndIssueToken(
    action: string,
    rawYAML: string,
    userRole: string,
    auditMetadata: TraceAuditMetadata = {},
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
      auditMetadata,
    );
    return { token, result };
  }

  /*******************************************************************************
   * Function: validatePlan
   *
   * Checks workflow structure, tools, parameters, roles, and registry rules.
   ******************************************************************************/
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
    validateRequirementNotes(candidateID, workflow.metadata?.unresolved_requirements, result);
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
        validateAnalysisStepStructure(workflow, stepIndex, result);
        return;
      }
      if (kind === "agent") {
        validateAgentStepStructure(workflow, stepIndex, result);
        for (const action of step.allowed_actions ?? []) {
          actions.push(action);
          const tool = this.registries.findTool(action);
          if (!tool || !tool.is_read_only) {
            result.tool_validity_ok = false;
            failRule(result, "GLOBAL-SAFETY-001", `Runtime agent action ${JSON.stringify(action)} in step ${step.id} is not one exact read-only tool`);
            continue;
          }
          usedTools.push(tool);
          result.tool_risks[action] = tool.risk_level;
          if (!roleAllowed(userRole, tool.allowed_roles)) {
            result.rbac_ok = false;
            result.errors.push(`RBAC_DENIED: Role ${JSON.stringify(userRole)} is not allowed to offer ${action} to agent step ${step.id}`);
          }
        }
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
        // Tool existence is a mandatory execution invariant, not an optional
        // research/policy rule that can authorize hallucinated tools.
        result.tool_validity_ok = false;
        failRule(result, "GLOBAL-SAFETY-001", `Unknown or hallucinated tool ${JSON.stringify(action)} in step ${step.id}`);
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

  /*******************************************************************************
   * Function: verifyToken
   *
   * Verifies a validation token against its process-local proof.
   ******************************************************************************/
  verifyToken(token: ValidationToken | null): boolean {
    return verifyValidationToken(token);
  }

  /*******************************************************************************
   * Function: evaluateResolvedStep
   *
   * Validates resolved step parameters and issues dispatch authority on
   * success.
   ******************************************************************************/
  async evaluateResolvedStep(
    action: string,
    rawYAML: string,
    stepIndex: number,
    params: Record<string, unknown>,
    token: ValidationToken | null,
    dispatchIdentity: DispatchIdentity,
    auditMetadata: TraceAuditMetadata = {},
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
        auditMetadata,
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
        auditMetadata,
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
        auditMetadata,
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
        auditMetadata,
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
        auditMetadata,
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
        auditMetadata,
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
            auditMetadata,
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
            auditMetadata,
          );
      }
    }
    const capability = mintDispatchCapability({
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
    }, auditMetadata);
    return { capability, violation: null };
  }

  /*******************************************************************************
   * Function: verifyAndConsumeCapability
   *
   * Verifies a dispatch capability and consumes it to prevent reuse.
   ******************************************************************************/
  verifyAndConsumeCapability(
    capability: DispatchCapability,
    action: string,
    exactParameterBytes: Uint8Array,
    dispatchIdentity: DispatchIdentity,
  ): void {
    consumeDispatchCapability(
      capability,
      action,
      exactParameterBytes,
      dispatchIdentity,
    );
  }

  /*******************************************************************************
   * Function: enabledRulesWithoutEvaluator
   *
   * Lists enabled registry rules without a deterministic evaluator.
   ******************************************************************************/
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

  /*******************************************************************************
   * Function: evaluatePlanRule
   *
   * Evaluates a registry rule against the workflow plan.
   ******************************************************************************/
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
      // Engine-owned ERPNext operations cannot enter the SDK without a
      // one-use consumed-approval permit. Its producer acknowledges the
      // immutable dispatch intent and audit in the same repository checkpoint;
      // results are journaled as well. Do not require an invented remote audit
      // tool for that exact profile, or generalize this to arbitrary writes.
      const effectTools = workflow.steps.map(step => this.registries.findTool(step.action ?? ""))
        .filter((tool): tool is ToolDefinition => Boolean(tool && (!tool.is_read_only || (riskRank[normalize(tool.risk_level)] ?? 0) >= 3)));
      const engineJournal = effectTools.length > 0 && effectTools.every(tool => {
        if (tool.is_read_only) return false;
        // The protected compiler uses this same qualification for both exact
        // ERPNext receipts and generic MCP acknowledgements. Both dispatch
        // through the consumed-approval journal; neither needs a remote audit tool.
        try { supportedOperation(tool); return true; } catch { return false; }
      });
      if (engineJournal) result.metadata.auditMechanism = "operation-job/v1:consumed-approval-and-dispatch-journal";
      if (
        hasWriteOrRisk &&
        !engineJournal &&
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

  /*******************************************************************************
   * Function: dispatchFailure
   *
   * Records a failed dispatch check and returns its violation details.
   ******************************************************************************/
  private async dispatchFailure(
    action: string,
    workflowHash: string,
    stepIndex: number,
    ruleId: string,
    paramKey: string,
    reason: string,
    params: Record<string, unknown>,
    auditMetadata: TraceAuditMetadata,
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
    }, auditMetadata);
    return { capability: null, violation };
  }

  /*******************************************************************************
   * Function: audit
   *
   * Appends a deterministic validation or dispatch audit entry.
   ******************************************************************************/
  private async audit(
    action: string,
    resourceID: string,
    after: Record<string, unknown>,
    metadata: TraceAuditMetadata = {},
  ): Promise<void> {
    const append = (state: import("../repository/store.js").RepositoryState) => {
      state.auditLogs.push({
        id: `audit_${state.auditLogs.length + 1}`,
        action,
        resource: { type: "workflow_validation", id: resourceID },
        before: null,
        after,
        createdAt: new Date().toISOString(),
        source: "deterministic-validation-gate-ts",
        ...definedTraceAuditMetadata(metadata),
      });
    };
    if (metadata.executionId !== undefined)
      await this.repository.mutateExecution(metadata.executionId, append);
    else await this.repository.mutate(append);
  }
}

/*******************************************************************************
 * Function: initialResult
 *
 * Initializes a candidate validation result and its registry metadata.
 ******************************************************************************/
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

/*******************************************************************************
 * Function: finish
 *
 * Finalizes validation scoring, failed rules, and overall pass status.
 ******************************************************************************/
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

/*******************************************************************************
 * Function: failRule
 *
 * Adds a failed rule identifier and message to the validation result.
 ******************************************************************************/
function failRule(
  result: CandidateValidationResult,
  ruleID: string,
  message: string,
): void {
  result.failed_rules.push(ruleID);
  result.errors.push(message);
}
/*******************************************************************************
 * Function: ruleMessage
 *
 * Returns a rule's configured validator message or the supplied fallback.
 ******************************************************************************/
function ruleMessage(rule: RuleDefinition, fallback: string): string {
  return rule.validator_message.trim() === ""
    ? fallback
    : rule.validator_message;
}
/*******************************************************************************
 * Function: normalizeRole
 *
 * Normalizes a role name for comparison in this module.
 ******************************************************************************/
function normalizeRole(value: string): string {
  const normalized = normalize(value).replace(/[ -]/g, "_");
  return normalized === "platform_admin" ? "admin" : normalized;
}
/*******************************************************************************
 * Function: roleAllowed
 *
 * Checks registry role access, including the module's administrator
 * allowance.
 ******************************************************************************/
function roleAllowed(role: string, allowed: string[]): boolean {
  if (allRolesToolAccess()) return toolRoleAllowed(allowed, role);
  if (allowed.length === 0 || normalizeRole(role) === "admin") return true;
  return allowed.some((item) => normalizeRole(item) === normalizeRole(role));
}
/*******************************************************************************
 * Function: normalize
 *
 * Trims and lowercases text for comparison.
 ******************************************************************************/
function normalize(value: string): string {
  return value.trim().toLowerCase();
}
/*******************************************************************************
 * Function: isEmptyParameter
 *
 * Detects absent parameters and supported empty-value markers.
 ******************************************************************************/
function isEmptyParameter(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === "string" &&
      ["", "<nil>", "null"].includes(normalize(value)))
  );
}
/*******************************************************************************
 * Function: containsTemplate
 *
 * Detects unresolved template expressions within nested parameters.
 ******************************************************************************/
function containsTemplate(value: unknown): boolean {
  if (typeof value === "string")
    return value.includes("{{") && value.includes("}}");
  if (Array.isArray(value)) return value.some(containsTemplate);
  if (typeof value === "object" && value !== null)
    return Object.values(value).some(containsTemplate);
  return false;
}
/*******************************************************************************
 * Function: findSensitiveKey
 *
 * Finds the first sensitive field path in a nested value.
 ******************************************************************************/
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
/*******************************************************************************
 * Function: ruleApplies
 *
 * Checks whether a rule applies to the role and tools in a workflow.
 ******************************************************************************/
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
/*******************************************************************************
 * Function: matchesTool
 *
 * Checks whether a rule applies to a tool action.
 ******************************************************************************/
function matchesTool(rule: RuleDefinition, action: string): boolean {
  return (
    rule.applies_to_tools.length === 0 ||
    rule.applies_to_tools.some((item) => normalize(item) === normalize(action))
  );
}
/*******************************************************************************
 * Function: asStringList
 *
 * Converts a string or array into a string list.
 ******************************************************************************/
function asStringList(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.map(String);
  return [];
}
/*******************************************************************************
 * Function: asNumber
 *
 * Converts a resolved finite numeric value or returns null.
 ******************************************************************************/
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
/*******************************************************************************
 * Function: compare
 *
 * Evaluates the requested comparison between two numbers.
 ******************************************************************************/
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
/*******************************************************************************
 * Function: hasApproval
 *
 * Detects an approval-related action in an action list.
 ******************************************************************************/
function hasApproval(actions: string[]): boolean {
  return actions.some(
    (item) =>
      normalize(item) === "approval.request_human_approval" ||
      normalize(item).includes("approve") ||
      normalize(item).includes("approval"),
  );
}
/*******************************************************************************
 * Function: addDeferred
 *
 * Records a parameter rule that must be checked after variable resolution.
 ******************************************************************************/
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
/*******************************************************************************
 * Function: evaluateDeferredRule
 *
 * Checks a deferred rule against resolved step parameters.
 ******************************************************************************/
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
/*******************************************************************************
 * Function: boundedValue
 *
 * Limits a diagnostic value to a short prefix.
 ******************************************************************************/
function boundedValue(value: unknown): string {
  const text = String(value ?? "").trim();
  return [...text].length <= 4 ? text : [...text].slice(0, 4).join("") + "…";
}
/*******************************************************************************
 * Function: errorText
 *
 * Converts an error or other thrown value into a message string.
 ******************************************************************************/
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export { resolvedParameterHash, resolvedParameterHashBytes };
