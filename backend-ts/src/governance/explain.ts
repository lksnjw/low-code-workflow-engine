import type { RegistryService } from "../registry/service.js";

export type GateExplanationEntry = {
  ruleId: string;
  ruleFamily: string;
  condition: string;
  message: string;
};

export type GateExplanation = {
  explanations: GateExplanationEntry[];
  policyVersion: string;
  registryHash: string;
};

const RULE_TYPE_FAMILY: Record<string, string> = {
  separation_of_duties: "Separation of Duties",
  sod: "Separation of Duties",
  approval_threshold: "Approval Threshold",
  threshold: "Approval Threshold",
  rbac: "Role-Based Access",
  role_check: "Role-Based Access",
  role_restriction: "Role-Based Access",
  audit: "Audit Requirement",
  audit_requirement: "Audit Requirement",
  field_validation: "Field Validation",
  budget_control: "Budget Control",
  dual_control: "Dual Control",
  compliance: "Compliance",
};

const GOVERNANCE_RULE_FAMILIES: Record<string, string> = {
  "GOVERNANCE-HUMAN-REVIEW": "Human Review Required",
  "GOVERNANCE-UNAVAILABLE": "Governance Service Unavailable",
};

export function projectGateExplanation(
  failedRuleIds: readonly string[],
  registries: RegistryService,
  policyVersion = "1.0",
): GateExplanation {
  const registryHash = registries.hash().slice(0, 15); // short form: "sha256:abc12345"
  const explanations: GateExplanationEntry[] = [];

  for (const ruleId of failedRuleIds) {
    const governance = GOVERNANCE_RULE_FAMILIES[ruleId];
    if (governance !== undefined) {
      explanations.push({
        ruleId,
        ruleFamily: governance,
        condition: governanceCondition(ruleId),
        message: governanceMessage(ruleId),
      });
      continue;
    }

    const rule = registries.findRule(ruleId);
    if (rule === undefined) {
      explanations.push({
        ruleId,
        ruleFamily: "Validation Rule",
        condition: "This rule was triggered but its definition is not available.",
        message: `Rule ${ruleId} blocked this action.`,
      });
      continue;
    }

    const ruleFamily = resolveFamily(rule.rule_type, ruleId);
    const condition = buildConditionText(rule);
    const message = rule.validator_message.trim() !== "" ? rule.validator_message : `Rule ${ruleId}: ${rule.description}`;

    explanations.push({ ruleId, ruleFamily, condition, message });
  }

  return { explanations, policyVersion, registryHash };
}

function resolveFamily(ruleType: string, ruleId: string): string {
  const normalized = ruleType.trim().toLowerCase().replace(/[- ]/g, "_");
  const fromType = RULE_TYPE_FAMILY[normalized];
  if (fromType !== undefined) return fromType;

  // Infer from rule ID prefix (e.g., "RULE_SOD_001" → Separation of Duties)
  const idUpper = ruleId.toUpperCase();
  if (idUpper.includes("SOD")) return "Separation of Duties";
  if (idUpper.includes("THRESHOLD") || idUpper.includes("AMOUNT")) return "Approval Threshold";
  if (idUpper.includes("RBAC") || idUpper.includes("ROLE")) return "Role-Based Access";
  if (idUpper.includes("AUDIT")) return "Audit Requirement";
  if (idUpper.includes("BUDGET")) return "Budget Control";

  return ruleType.trim() !== "" ? ruleType : "Validation Rule";
}

function buildConditionText(rule: { condition: { type: string; parameter: string; operator: string; value: unknown }; description: string }): string {
  const { type, parameter, operator, value } = rule.condition;
  if (type.trim() === "" && parameter.trim() === "") {
    return rule.description.trim() !== "" ? rule.description : "A policy condition was not met.";
  }
  const opLabel = operatorLabel(operator);
  const valueStr = value !== null && value !== undefined ? String(value) : "";
  if (parameter.trim() !== "" && opLabel !== "" && valueStr !== "") {
    return `${humanizeParameter(parameter)} ${opLabel} ${valueStr}`;
  }
  return rule.description.trim() !== "" ? rule.description : "A policy condition was not met.";
}

function operatorLabel(op: string): string {
  const map: Record<string, string> = {
    eq: "must equal", "=": "must equal",
    neq: "must not equal", "!=": "must not equal",
    lt: "must be less than", lte: "must be at most",
    gt: "must be greater than", gte: "must be at least",
    not_same_as: "must be different from",
    same_as: "must be the same as",
  };
  return map[op.toLowerCase()] ?? op;
}

function humanizeParameter(param: string): string {
  return param
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function governanceCondition(ruleId: string): string {
  if (ruleId === "GOVERNANCE-HUMAN-REVIEW") {
    return "The governance system requires a human reviewer to approve this action before it can proceed.";
  }
  if (ruleId === "GOVERNANCE-UNAVAILABLE") {
    return "The governance service could not be reached. No action may proceed without governance confirmation.";
  }
  return "A governance check is required.";
}

function governanceMessage(ruleId: string): string {
  if (ruleId === "GOVERNANCE-HUMAN-REVIEW") {
    return "This workflow requires manual approval. Contact your administrator or approver to proceed.";
  }
  if (ruleId === "GOVERNANCE-UNAVAILABLE") {
    return "Governance service is temporarily unavailable. Please try again later or contact your system administrator.";
  }
  return "Governance approval is required.";
}
