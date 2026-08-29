import { createHash } from "node:crypto";
import { parseWorkflowYAMLStrict } from "../parser/workflow.js";
import { CANDIDATE_PROMPT_VERSION, type ProviderRuntime } from "../providers/runtime.js";
import type { RegistryService } from "../registry/service.js";
import type { ToolDefinition } from "../registry/schemas.js";
import type { CandidateValidationResult, RegistryValidator } from "../validator/registry-validator.js";
import type { GovernanceUser, ValidationGate } from "../governance/gate.js";
import { attachValidationAuditTrace } from "../trace/audit-trace.js";

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

  async synthesize(input: { prompt: string; userRole: string; user?: GovernanceUser; model?: string; priorMessages?: string[]; caseContext?: Record<string, unknown>; signal?: AbortSignal; traceId?: string; sessionId?: string; messageId?: string }): Promise<SynthesisResult> {
    const prompt = assembleCandidatePrompt(input.prompt, input.userRole, this.registries, input.priorMessages ?? []);
    let generated;
    try { generated = await this.providers.generateCandidate(prompt, CANDIDATE_PROMPT_VERSION, (response) => { parseWorkflowYAMLStrict(response.text.trim()); }, input.signal, {
      ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      ...(input.messageId === undefined ? {} : { messageId: input.messageId }),
      candidateId: "candidate_1",
      ...(input.user === undefined ? {} : { actor: { id: input.user.id, role: input.user.role } }),
    }); }
    catch (error) { throw new SynthesisFailure(`Candidate generation failed: ${errorText(error)}`); }
    const yaml = generated.text.trim();
    const candidateID = "candidate_1";
    let gate;
    if (this.validationGate === undefined) {
      gate = await this.validator.validateAndIssueToken(candidateID, yaml, input.userRole);
      await attachValidationAuditTrace(this.validator.repository, candidateID, yaml, {
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
  const relevantTools = selectRelevantToolsForSynthesis(userText, snapshot.tools, 20);
  return [
    "SYSTEM",
    "Generate exactly one workflow as strict YAML. Return YAML only — no Markdown fence, no commentary.",
    "",
    "REQUIRED WORKFLOW STRUCTURE (all fields are exact key names — do not rename them):",
    "  name: <string>           # workflow name",
    "  description: <string>    # non-empty description",
    "  trigger:",
    "    type: <string>         # e.g. manual, schedule, event",
    "  steps:                   # at least one step",
    "    - id: <string>         # REQUIRED — unique snake_case id, e.g. step_1",
    "      description: <string> # REQUIRED — short plain-English label, e.g. 'Fetch all warehouses from ERP'",
    "      action: <tool_name>  # must be an exact tool name from TOOL_REGISTRY_JSON below",
    "      parameters:          # key/value pairs matching the tool's input schema",
    "        key: value",
    "",
    "STRICT RULES:",
    "- Every step MUST have an id field (string, unique within the workflow).",
    "- Every step MUST have a description field — a short plain-English phrase describing what the step does (e.g. 'Fetch all warehouses from ERP'). Never leave description empty or use a tool name as the description.",
    "- Every step MUST have action set to an EXACT tool name from TOOL_REGISTRY_JSON below. NO EXCEPTIONS.",
    "- DO NOT use kind: approval, kind: condition, kind: http, or any kind other than tool. The ONLY valid step type is action-based (kind: tool).",
    "- ONLY use tools that appear in TOOL_REGISTRY_JSON. Never add tools based on rule instructions — APPLICABLE_RULES_JSON is for reference only, not a source of tool names.",
    "- If a rule mentions a tool (e.g. audit.write_audit_log) that is NOT in TOOL_REGISTRY_JSON, IGNORE that rule completely.",
    "- Generate the MINIMUM number of steps needed to fulfill the user's request. Do NOT add extra steps for audit, notification, or echo unless the user explicitly asked for them.",
    "- No extra top-level keys beyond name, description, trigger, steps, metadata.",
    "",
    "USER_ROLE",
    userRole,
    "PRIOR_MESSAGES_JSON",
    history,
    "USER_REQUEST",
    userText,
    "TOOL_REGISTRY_JSON",
    JSON.stringify(relevantTools),
    "APPLICABLE_RULES_JSON",
    JSON.stringify(applicableRules),
  ].join("\n");
}

function selectRelevantToolsForSynthesis(query: string, tools: readonly ToolDefinition[], limit: number): readonly ToolDefinition[] {
  const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
  if (words.length === 0) return tools.slice(0, limit);
  const scored = tools.map((tool) => {
    const text = `${tool.name} ${tool.description} ${tool.display_name ?? ""}`.toLowerCase();
    const score = words.reduce((acc, w) => acc + (text.includes(w) ? 1 : 0), 0);
    return { tool, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.tool);
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
