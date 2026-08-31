import { createHash, randomUUID } from "node:crypto";

import { effectiveStepKind } from "../models/schemas.js";
import { parseWorkflowYAMLStrict } from "../parser/workflow.js";
import type { RegistryService } from "../registry/service.js";
import type { Repository } from "../repository/store.js";
import type { CandidateValidationResult, RegistryValidator, ValidationToken } from "../validator/registry-validator.js";
import type { GovernanceRequest } from "./adapter.js";
import { GovernanceService, type GovernanceDecision } from "./service.js";
import { attachValidationAuditTrace } from "../trace/audit-trace.js";
import { PolicyGateClient, type PolicyGateOutcome } from "./policy-gate-client.js";

export type GovernanceUser = { id: string; role: string; department: string | null };

export type GovernedValidationContext = {
  intent?: string;
  caseContext?: Record<string, unknown>;
  signal?: AbortSignal;
  traceId?: string | undefined;
  sessionId?: string | undefined;
  messageId?: string | undefined;
  candidateId?: string | undefined;
  workflowId?: string | undefined;
  executionId?: string | undefined;
};

export type ValidationGateResult = { token: ValidationToken | null; result: CandidateValidationResult };

export interface ValidationGate {
  validateAndIssueToken(
    action: string,
    rawYAML: string,
    user: GovernanceUser,
    context?: GovernedValidationContext,
  ): Promise<ValidationGateResult>;
}

export class GovernedValidationGate implements ValidationGate {
  /*******************************************************************************
   * Function: constructor
   *
   * Initializes a GovernedValidationGate instance with its required state.
   ******************************************************************************/
  constructor(
    readonly governance: GovernanceService,
    readonly validator: RegistryValidator,
    readonly registries: RegistryService,
    readonly repository: Repository,
    readonly policyGate: PolicyGateClient | null = null,
  ) {}

  /*******************************************************************************
   * Function: validateAndIssueToken
   *
   * Applies governance and deterministic validation before issuing a token.
   ******************************************************************************/
  async validateAndIssueToken(action: string, rawYAML: string, user: GovernanceUser, context: GovernedValidationContext = {}): Promise<ValidationGateResult> {
    const proposal = classifyProposal(rawYAML, this.registries);
    const request: GovernanceRequest = {
      requestId: randomUUID(),
      user: { ...user },
      intent: context.intent ?? action,
      proposedActions: proposal.actions,
      caseContext: context.caseContext ?? {},
    };

    // Tier 0: Hansaja policy gate — if configured and reachable, its decision is final.
    // On any network failure the outcome is "fallback" and we drop through to tier 1.
    if (this.policyGate !== null) {
      const pg = await this.policyGate.evaluate(request, context.signal);
      if (pg.outcome !== "fallback") {
        return this.#resolveFromPolicyGate(pg, action, rawYAML, user, proposal, request, context);
      }
    }

    // Tier 1+: existing governance chain (LLM fallback → static JSON).
    const outcome = await this.governance.govern(
      request,
      proposal.readOnly,
      () => this.validator.validateAndIssueToken(action, rawYAML, user.role),
      context.signal,
    );
    let gate: ValidationGateResult;
    if (outcome.allowed) {
      gate = outcome.value;
      attachDecision(gate.result, outcome.decision);
      if (outcome.decision.warning !== null) gate.result.warnings.push(`GOVERNANCE_WARNING: ${outcome.decision.warning}`);
    } else {
      const result = this.validator.validatePlan(action, rawYAML, user.role);
      result.passed = false;
      result.policy_ok = false;
      result.score = 0;
      const ruleID = outcome.decision.status === "HUMAN_REVIEW" ? "GOVERNANCE-HUMAN-REVIEW" : "GOVERNANCE-UNAVAILABLE";
      if (!result.failed_rules.includes(ruleID)) result.failed_rules.push(ruleID);
      const rawReason = outcome.decision.reason ?? "governance policy could not be established";
      const cleanReason = rawReason.replace(/^GOVERNANCE-UNAVAILABLE:\s*/i, "").replace(/^GOVERNANCE-HUMAN-REVIEW:\s*/i, "");
      result.errors.push(`${ruleID}: ${cleanReason}`);
      attachDecision(result, outcome.decision);
      gate = { token: null, result };
    }
    if (outcome.allowed) {
      await attachValidationAuditTrace(this.repository, action, rawYAML, {
        ...context,
        actor: { id: user.id, role: user.role },
      });
    }
    await this.recordDecision(action, rawYAML, proposal.readOnly, outcome.decision, gate.result.passed, request, context);
    return gate;
  }

  /*******************************************************************************
   * Function: #resolveFromPolicyGate
   *
   * Converts a policy-gate response into a recorded validation outcome.
   ******************************************************************************/
  async #resolveFromPolicyGate(
    pg: Exclude<PolicyGateOutcome, { outcome: "fallback" }>,
    action: string,
    rawYAML: string,
    user: GovernanceUser,
    proposal: { actions: string[]; readOnly: boolean },
    request: GovernanceRequest,
    context: GovernedValidationContext,
  ): Promise<ValidationGateResult> {
    const decision: GovernanceDecision = {
      status: pg.outcome === "review" ? "HUMAN_REVIEW" : pg.outcome === "allow" ? "FRESH" : "BLOCKED",
      policyVersion: "policy-gate",
      registryHash: this.registries.hash(),
      source: "primary",
      evidenceIds: [],
      warning: pg.outcome === "allow" && pg.conditions.length > 0
        ? `Policy gate conditions: ${pg.conditions.join("; ")}`
        : null,
      reason: pg.outcome !== "allow" ? pg.reason : null,
    };

    let gate: ValidationGateResult;
    if (pg.outcome === "allow") {
      gate = await this.validator.validateAndIssueToken(action, rawYAML, user.role);
      attachDecision(gate.result, decision);
      if (decision.warning !== null) gate.result.warnings.push(`GOVERNANCE_WARNING: ${decision.warning}`);
    } else {
      const result = this.validator.validatePlan(action, rawYAML, user.role);
      result.passed = false;
      result.policy_ok = false;
      result.score = 0;
      const ruleID = pg.outcome === "review" ? "GOVERNANCE-HUMAN-REVIEW" : "GOVERNANCE-UNAVAILABLE";
      if (!result.failed_rules.includes(ruleID)) result.failed_rules.push(ruleID);
      const cleanPgReason = (pg.reason ?? "").replace(/^GOVERNANCE-UNAVAILABLE:\s*/i, "").replace(/^GOVERNANCE-HUMAN-REVIEW:\s*/i, "");
      result.errors.push(`${ruleID}: ${cleanPgReason}`);
      attachDecision(result, decision);
      gate = { token: null, result };
    }

    if (pg.outcome === "allow") {
      await attachValidationAuditTrace(this.repository, action, rawYAML, {
        ...context,
        actor: { id: user.id, role: user.role },
      });
    }
    await this.recordDecision(action, rawYAML, proposal.readOnly, decision, gate.result.passed, request, context);
    return gate;
  }

  /*******************************************************************************
   * Function: recordDecision
   *
   * Records a governance gate decision and its trace metadata in the audit
   * log.
   ******************************************************************************/
  private async recordDecision(action: string, rawYAML: string, readOnly: boolean, decision: GovernanceDecision, passed: boolean, request: GovernanceRequest, context: GovernedValidationContext): Promise<void> {
    await this.repository.mutate((state) => {
      state.auditLogs.push({
        id: `audit_${state.auditLogs.length + 1}`,
        action: `governance.gate.${action}`,
        resource: { type: "workflow_governance", id: `sha256:${createHash("sha256").update(rawYAML).digest("hex")}` },
        before: null,
        after: { passed, readOnly, ...decision },
        createdAt: new Date().toISOString(),
        source: "governance-gate-ts",
        governanceRequestId: request.requestId,
        actor: { id: request.user.id, role: request.user.role },
        ...traceMetadata(context),
      });
    });
  }
}

/*******************************************************************************
 * Function: traceMetadata
 *
 * Collects defined trace identifiers from validation context.
 ******************************************************************************/
function traceMetadata(
  context: GovernedValidationContext,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries({
      traceId: context.traceId,
      sessionId: context.sessionId,
      messageId: context.messageId,
      candidateId: context.candidateId,
      workflowId: context.workflowId,
      executionId: context.executionId,
    }).filter(([, value]) => value !== undefined),
  );
}

/*******************************************************************************
 * Function: classifyProposal
 *
 * Extracts proposed tool actions and their read-only status from workflow
 * YAML.
 ******************************************************************************/
function classifyProposal(rawYAML: string, registries: RegistryService): { actions: string[]; readOnly: boolean } {
  try {
    const workflow = parseWorkflowYAMLStrict(rawYAML);
    const actions = workflow.steps
      .filter((step) => effectiveStepKind(step) === "tool")
      .map((step) => (step.action ?? "").trim())
      .filter((action) => action !== "");
    const readOnly = actions.every((action) => {
      // Normalize hyphens↔underscores when looking up in the static registry
      return (
        registries.findTool(action)?.is_read_only === true ||
        registries.findTool(action.replace(/_/g, "-"))?.is_read_only === true ||
        registries.findTool(action.replace(/-/g, "_"))?.is_read_only === true
      );
    });
    return { actions, readOnly };
  } catch {
    return { actions: [], readOnly: false };
  }
}

/*******************************************************************************
 * Function: attachDecision
 *
 * Adds a copy of the governance decision to validation metadata.
 ******************************************************************************/
function attachDecision(result: CandidateValidationResult, decision: GovernanceDecision): void {
  result.metadata.governance = structuredClone(decision);
}
