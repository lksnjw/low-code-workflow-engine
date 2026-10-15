import { parseWorkflowYAMLStrict } from "../parser/workflow.js";
import { CANDIDATE_PROMPT_VERSION, type ProviderRuntime } from "../providers/runtime.js";
import { promptData, generationPromptHash } from "../prompts/contracts.js";
import type { RegistryService } from "../registry/service.js";
import type { ToolDefinition } from "../registry/schemas.js";
import type { CandidateValidationResult, RegistryValidator } from "../validator/registry-validator.js";
import type { GovernanceUser, ValidationGate } from "../governance/gate.js";
import { inspectWorkflowDraft } from "../workflows/compiled-read.js";
import { withWorkspaceCompilationIssues } from "../workflows/draft-validation.js";
import type { ReviewedModelSourceContext } from "./reviewed-model-sources.js";
import { generatedReturnCoverageIssues } from "./return-coverage.js";
import type { AnalysisResponse } from "../analysisprovider/types.js";
import { reviewedReadOutputKey } from "../tools/mcp-result.js";

export type SynthesisInput = { prompt: string; userRole: string; user?: GovernanceUser; model?: string; providerRuntime?: ProviderRuntime; priorMessages?: string[]; caseContext?: Record<string, unknown>; candidateContext?: Record<string, unknown>; modelSourceContext?: ReviewedModelSourceContext; candidateValidator?: (yaml: string) => void; signal?: AbortSignal; traceId?: string; sessionId?: string; messageId?: string; liveTools?: readonly ToolDefinition[] };
export type PreparedCandidate = { prompt: string; liveTools: readonly ToolDefinition[]; candidateId: "candidate_1" };

export type SynthesisResult = {
  candidate: CandidateReport;
  validation: CandidateValidationResult;
  canExecute: boolean;
  yaml: string;
  retrieval: Record<string, unknown>;
  candidates: CandidateReport[];
  selected_candidate_id: string | null;
  selected_workflow_yaml: string;
  can_execute: boolean;
  validation_summary: { passed_candidates: number; blocked_candidates: number; best_score: number };
  blocking_errors: string[];
  execution_profile_issues: string[];
  next_action: "execute" | "escalate";
};

export type CandidateReport = {
  id: string;
  candidate_id: string;
  yaml: string;
  status: "PASS" | "BLOCKED";
  score: number;
  generation_metadata: {
    promptTemplateVersion: string;
    promptSha256: string;
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    measured: boolean;
    temperature: number;
  };
  validation: CandidateValidationResult;
};

export class SynthesisFailure extends Error {
  /*******************************************************************************
   * Function: constructor
   *
   * Initializes a SynthesisFailure instance with its required state.
   ******************************************************************************/
  constructor(message: string, readonly status = 502) { super(message); this.name = "SynthesisFailure"; }
}

export class SynthesisService {
  /*******************************************************************************
   * Function: constructor
   *
   * Initializes a SynthesisService instance with its required state.
   ******************************************************************************/
  constructor(readonly providers: ProviderRuntime, readonly registries: RegistryService, readonly validator: RegistryValidator, readonly validationGate?: ValidationGate) {}

  prepareCandidate(input: SynthesisInput): PreparedCandidate {
    const liveTools = structuredClone(input.liveTools ?? this.registries.snapshot().tools);
    const prompt = assembleCandidatePrompt(input.prompt, input.userRole, this.registries, input.priorMessages ?? [], liveTools, input.candidateContext, input.modelSourceContext);
    return { prompt, liveTools, candidateId: "candidate_1" };
  }

  validateCandidateOutput(input: SynthesisInput, generated: AnalysisResponse): void {
    const yaml = generated.text.trim();
    parseWorkflowYAMLStrict(yaml);
    input.candidateValidator?.(yaml);
  }

  async validateGeneratedCandidate(input: SynthesisInput, prepared: PreparedCandidate, generated: AnalysisResponse): Promise<SynthesisResult> {
    const providers = input.providerRuntime ?? this.providers;
    const yaml = generated.text.trim();
    const candidateID = prepared.candidateId;
    let gate;
    if (this.validationGate === undefined) {
      gate = await this.validator.validateAndIssueToken(candidateID, yaml, input.userRole, {
        traceId: input.traceId,
        sessionId: input.sessionId,
        messageId: input.messageId,
        candidateId: candidateID,
        actor: input.user === undefined ? undefined : { id: input.user.id, role: input.user.role },
      });
    } else {
      gate = await this.validationGate.validateAndIssueToken(candidateID, yaml, input.user ?? { id: "anonymous", role: input.userRole, department: null }, {
          intent: input.prompt,
          caseContext: input.caseContext ?? { priorMessageCount: input.priorMessages?.length ?? 0 },
          traceId: input.traceId,
          sessionId: input.sessionId,
          messageId: input.messageId,
          candidateId: candidateID,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
    }
    const blueprint = parseWorkflowYAMLStrict(yaml);
    const executionIssues = [
      ...(blueprint.metadata?.controlFlow !== undefined || blueprint.steps.some(step => ["analysis", "agent"].includes(step.kind ?? "")) ?
        inspectWorkflowDraft(blueprint, prepared.liveTools, input.userRole).issues : []),
      ...generatedReturnCoverageIssues(blueprint),
    ];
    if (executionIssues.length) withWorkspaceCompilationIssues(gate.result, executionIssues);
    const canExecute = gate.result.passed && gate.token !== null && executionIssues.length === 0;
    const temperature = providers.configuration?.temperature ?? 0;
    const candidate: CandidateReport = {
      id: candidateID,
      candidate_id: candidateID,
      yaml,
      status: canExecute ? "PASS" : "BLOCKED",
      score: gate.result.score,
      generation_metadata: {
        promptTemplateVersion: CANDIDATE_PROMPT_VERSION,
        promptSha256: generationPromptHash(prepared.prompt, CANDIDATE_PROMPT_VERSION),
        provider: generated.provider,
        model: generated.model,
        inputTokens: generated.inputTokens,
        outputTokens: generated.outputTokens,
        measured: generated.measured,
        temperature,
      },
      validation: gate.result,
    };
    const retrieval = directRegistryContext(input.prompt, this.registries, input.userRole);
    return {
      candidate,
      validation: gate.result,
      canExecute,
      yaml,
      retrieval,
      candidates: [candidate],
      selected_candidate_id: candidateID,
      selected_workflow_yaml: yaml,
      can_execute: canExecute,
      validation_summary: { passed_candidates: canExecute ? 1 : 0, blocked_candidates: canExecute ? 0 : 1, best_score: gate.result.score },
      blocking_errors: canExecute ? [] : [...gate.result.errors, ...executionIssues],
      execution_profile_issues: executionIssues,
      next_action: canExecute ? "execute" : "escalate",
    };
  }

  /*******************************************************************************
   * Function: synthesize
   *
   * Generates a workflow candidate and evaluates its validation outcome.
   ******************************************************************************/
  async synthesize(input: SynthesisInput): Promise<SynthesisResult> {
    const baseProvider = input.providerRuntime ?? this.providers;
    const providers = baseProvider.snapshot?.(input.model) ?? baseProvider;
    const prepared = this.prepareCandidate(input);
    let generated;
    try { generated = await providers.generateCandidate(prepared.prompt, CANDIDATE_PROMPT_VERSION, (response) => {
      this.validateCandidateOutput(input, response);
    }, input.signal, {
      ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      ...(input.messageId === undefined ? {} : { messageId: input.messageId }),
      candidateId: "candidate_1",
      ...(input.user === undefined ? {} : { actor: { id: input.user.id, role: input.user.role } }),
      egress: { purpose: "interactive", dataClass: "restricted" },
    }); }
    catch (error) { throw new SynthesisFailure(`Candidate generation failed: ${errorText(error)}`); }
    // Preserve the exact proposal: deterministic verification reports unknown
    // actions. Renaming/removing steps requires a separate reviewed revision.
    return this.validateGeneratedCandidate(input, prepared, generated);
  }
}


/*******************************************************************************
 * Function: assembleCandidatePrompt
 *
 * Builds a synthesis prompt using the request, conversation, tools, and
 * rules.
 ******************************************************************************/
export function assembleCandidatePrompt(userText: string, userRole: string, registries: RegistryService, priorMessages: string[] = [], liveTools?: readonly ToolDefinition[], candidateContext?: Record<string, unknown>, modelSourceContext?: ReviewedModelSourceContext): string {
  const snapshot = registries.snapshot();
  const applicableRules = snapshot.rules.filter((rule) => rule.enabled && (rule.applies_to_roles.length === 0 || rule.applies_to_roles.some((role) => normalizeRole(role) === normalizeRole(userRole))));
  // An explicitly empty live catalog is unavailable, not a reason to fall
  // back to registered tools that this connection did not advertise.
  return promptData({ USER_ROLE: userRole, PRIOR_MESSAGES_JSON: priorMessages, USER_REQUEST: userText,
    TOOL_REGISTRY_JSON: liveTools ?? snapshot.tools, APPLICABLE_RULES_JSON: applicableRules,
    TOOL_RESULT_BINDINGS_JSON: (liveTools ?? snapshot.tools).filter(tool => tool.bridge_contract?.output_schema).map(tool => ({
      action: tool.name, remoteName: tool.mcp_tool_name, path: [reviewedReadOutputKey(tool)], schema: tool.bridge_contract!.output_schema,
    })),
    ...(candidateContext === undefined ? {} : { SERVER_DERIVED_CONTEXT_JSON: candidateContext }),
    ...(modelSourceContext === undefined ? {} : { MODEL_SOURCE_HINTS_JSON: modelSourceContext }) });
}

/*******************************************************************************
 * Function: directRegistryContext
 *
 * Builds role-filtered retrieval context directly from the registry.
 ******************************************************************************/
function directRegistryContext(query: string, registries: RegistryService, userRole: string): Record<string, unknown> {
  const snapshot = registries.snapshot();
  const tools = snapshot.tools.map((tool) => ({ ...tool, score: 1, match_reason: "direct registry inclusion" }));
  const rules = snapshot.rules.filter((rule) => rule.enabled && !isGlobalRule(rule)).filter((rule) => rule.applies_to_roles.length === 0 || rule.applies_to_roles.some((role) => normalizeRole(role) === normalizeRole(userRole))).map((rule) => ({ ...rule, score: 1, match_reason: "direct registry inclusion" }));
  const globalRules = snapshot.rules.filter((rule) => rule.enabled && isGlobalRule(rule)).map((rule) => ({ ...rule, score: 1, match_reason: "direct registry inclusion" }));
  return { tools, rules, global_rules: globalRules, templates: [], examples: [], query, user_role: userRole, method: "direct_registry", retrieval_method: "direct_registry" };
}

/*******************************************************************************
 * Function: isGlobalRule
 *
 * Checks whether a rule belongs to the global policy scope.
 ******************************************************************************/
function isGlobalRule(rule: { domain: string; rule_id: string }): boolean { return rule.domain.trim().toLowerCase() === "global" || rule.rule_id.startsWith("GLOBAL-"); }
/*******************************************************************************
 * Function: normalizeRole
 *
 * Normalizes a role name for comparison in this module.
 ******************************************************************************/
function normalizeRole(value: string): string { return value.trim().toLowerCase().replace(/[ -]/g, "_").replace(/^platform_admin$/, "admin"); }
/*******************************************************************************
 * Function: errorText
 *
 * Converts an error or other thrown value into a message string.
 ******************************************************************************/
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
