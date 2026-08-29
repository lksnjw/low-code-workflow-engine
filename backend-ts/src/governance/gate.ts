import { createHash, randomUUID } from "node:crypto";

import { effectiveStepKind } from "../models/schemas.js";
import { parseWorkflowYAMLStrict } from "../parser/workflow.js";
import type { RegistryService } from "../registry/service.js";
import type { Repository } from "../repository/store.js";
import type { CandidateValidationResult, RegistryValidator, ValidationToken } from "../validator/registry-validator.js";
import type { GovernanceRequest } from "./adapter.js";
import { GovernanceService, type GovernanceDecision } from "./service.js";
import { attachValidationAuditTrace } from "../trace/audit-trace.js";

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
  constructor(
    readonly governance: GovernanceService,
    readonly validator: RegistryValidator,
    readonly registries: RegistryService,
    readonly repository: Repository,
  ) {}

  async validateAndIssueToken(action: string, rawYAML: string, user: GovernanceUser, context: GovernedValidationContext = {}): Promise<ValidationGateResult> {
    const proposal = classifyProposal(rawYAML, this.registries);
    const request: GovernanceRequest = {
      requestId: randomUUID(),
      user: { ...user },
      intent: context.intent ?? action,
      proposedActions: proposal.actions,
      caseContext: context.caseContext ?? {},
    };
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
      result.errors.push(`${ruleID}: ${outcome.decision.reason ?? "governance policy could not be established"}`);
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

function classifyProposal(rawYAML: string, registries: RegistryService): { actions: string[]; readOnly: boolean } {
  try {
    const workflow = parseWorkflowYAMLStrict(rawYAML);
    const actions = workflow.steps
      .filter((step) => effectiveStepKind(step) === "tool")
      .map((step) => (step.action ?? "").trim())
      .filter((action) => action !== "");
    const readOnly = actions.every((action) => registries.findTool(action)?.is_read_only === true);
    return { actions, readOnly };
  } catch {
    return { actions: [], readOnly: false };
  }
}

function attachDecision(result: CandidateValidationResult, decision: GovernanceDecision): void {
  result.metadata.governance = structuredClone(decision);
}
