import { createHash } from "node:crypto";
import { parseWorkflowYAMLStrict } from "../parser/workflow.js";
import { CANDIDATE_PROMPT_VERSION, type ProviderRuntime } from "../providers/runtime.js";
import type { RegistryService } from "../registry/service.js";
import type { CandidateValidationResult, RegistryValidator } from "../validator/registry-validator.js";
import type { GovernanceUser, ValidationGate } from "../governance/gate.js";

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
  constructor(message: string, readonly status = 502) { super(message); this.name = "SynthesisFailure"; }
}

export class SynthesisService {
  constructor(readonly providers: ProviderRuntime, readonly registries: RegistryService, readonly validator: RegistryValidator, readonly validationGate?: ValidationGate) {}

  async synthesize(input: { prompt: string; userRole: string; user?: GovernanceUser; model?: string; priorMessages?: string[]; caseContext?: Record<string, unknown>; signal?: AbortSignal }): Promise<SynthesisResult> {
    const prompt = assembleCandidatePrompt(input.prompt, input.userRole, this.registries, input.priorMessages ?? []);
    let generated;
    try { generated = await this.providers.generateCandidate(prompt, CANDIDATE_PROMPT_VERSION, (response) => { parseWorkflowYAMLStrict(response.text.trim()); }, input.signal); }
    catch (error) { throw new SynthesisFailure(`Candidate generation failed: ${errorText(error)}`); }
    const yaml = generated.text.trim();
    const candidateID = "candidate_1";
    const gate = this.validationGate === undefined
      ? await this.validator.validateAndIssueToken(candidateID, yaml, input.userRole)
      : await this.validationGate.validateAndIssueToken(candidateID, yaml, input.user ?? { id: "anonymous", role: input.userRole, department: null }, {
        intent: input.prompt,
        caseContext: input.caseContext ?? { priorMessageCount: input.priorMessages?.length ?? 0 },
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    const canExecute = gate.result.passed && gate.token !== null;
    const temperature = this.providers.configuration?.temperature ?? 0;
    const candidate: CandidateReport = {
      id: candidateID,
      candidate_id: candidateID,
      yaml,
      status: canExecute ? "PASS" : "BLOCKED",
      score: gate.result.score,
      generation_metadata: {
        promptTemplateVersion: CANDIDATE_PROMPT_VERSION,
        promptSha256: `sha256:${createHash("sha256").update(prompt).digest("hex")}`,
        provider: generated.provider,
        model: generated.model,
        inputTokens: generated.inputTokens,
        outputTokens: generated.outputTokens,
        measured: generated.measured,
        temperature,
      },
      validation: gate.result,
    };
    const retrieval = directRegistryContext(this.registries, input.userRole);
    return {
      candidate,
      validation: gate.result,
      canExecute,
      yaml,
      retrieval,
      candidates: [candidate],
      selected_candidate_id: canExecute ? candidateID : null,
      selected_workflow_yaml: canExecute ? yaml : "",
      can_execute: canExecute,
      validation_summary: { passed_candidates: canExecute ? 1 : 0, blocked_candidates: canExecute ? 0 : 1, best_score: gate.result.score },
      blocking_errors: canExecute ? [] : [...gate.result.errors],
      next_action: canExecute ? "execute" : "escalate",
    };
  }
}

export function assembleCandidatePrompt(userText: string, userRole: string, registries: RegistryService, priorMessages: string[] = []): string {
  const snapshot = registries.snapshot();
  const applicableRules = snapshot.rules.filter((rule) => rule.enabled && (rule.applies_to_roles.length === 0 || rule.applies_to_roles.some((role) => normalizeRole(role) === normalizeRole(userRole))));
  const history = priorMessages.length === 0 ? "[]" : JSON.stringify(priorMessages);
  return [
    "SYSTEM",
    "Generate exactly one workflow as strict YAML. Return YAML only: no Markdown fence, commentary, confidence, cost, or alternatives.",
    "The workflow must contain name, a non-empty description, trigger.type, and at least one step.",
    "Use only tool names and parameters defined in TOOL_REGISTRY. Obey every APPLICABLE_RULE.",
    "USER_ROLE",
    userRole,
    "PRIOR_MESSAGES_JSON",
    history,
    "USER_REQUEST",
    userText,
    "TOOL_REGISTRY_JSON",
    JSON.stringify(snapshot.tools),
    "APPLICABLE_RULES_JSON",
    JSON.stringify(applicableRules),
  ].join("\n");
}

function directRegistryContext(registries: RegistryService, userRole: string): Record<string, unknown> {
  const snapshot = registries.snapshot();
  const tools = snapshot.tools.map((tool) => ({ ...tool, score: 1, match_reason: "direct registry inclusion" }));
  const rules = snapshot.rules.filter((rule) => rule.enabled && !isGlobalRule(rule)).filter((rule) => rule.applies_to_roles.length === 0 || rule.applies_to_roles.some((role) => normalizeRole(role) === normalizeRole(userRole))).map((rule) => ({ ...rule, score: 1, match_reason: "direct registry inclusion" }));
  const globalRules = snapshot.rules.filter((rule) => rule.enabled && isGlobalRule(rule)).map((rule) => ({ ...rule, score: 1, match_reason: "direct registry inclusion" }));
  return { tools, rules, global_rules: globalRules, templates: [], examples: [], query: "", user_role: userRole, method: "direct_registry", retrieval_method: "direct_registry" };
}

function isGlobalRule(rule: { domain: string; rule_id: string }): boolean { return rule.domain.trim().toLowerCase() === "global" || rule.rule_id.startsWith("GLOBAL-"); }
function normalizeRole(value: string): string { return value.trim().toLowerCase().replace(/[ -]/g, "_").replace(/^platform_admin$/, "admin"); }
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
