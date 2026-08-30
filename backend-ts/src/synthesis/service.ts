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

  async synthesize(input: { prompt: string; userRole: string; user?: GovernanceUser; model?: string; priorMessages?: string[]; caseContext?: Record<string, unknown>; signal?: AbortSignal; traceId?: string; sessionId?: string; messageId?: string; liveTools?: readonly ToolDefinition[] }): Promise<SynthesisResult> {
    const prompt = assembleCandidatePrompt(input.prompt, input.userRole, this.registries, input.priorMessages ?? [], input.liveTools);
    let generated;
    try { generated = await this.providers.generateCandidate(prompt, CANDIDATE_PROMPT_VERSION, (response) => { parseWorkflowYAMLStrict(response.text.trim()); }, input.signal, {
      ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      ...(input.messageId === undefined ? {} : { messageId: input.messageId }),
      candidateId: "candidate_1",
      ...(input.user === undefined ? {} : { actor: { id: input.user.id, role: input.user.role } }),
    }); }
    catch (error) { throw new SynthesisFailure(`Candidate generation failed: ${errorText(error)}`); }
    // Self-review pass: ask the LLM to verify its own tool names against the live registry.
    // This catches mismatches (e.g. send_email vs send-email) before governance runs.
    const initialYaml = generated.text.trim();
    const yaml = await selfReviewYaml(initialYaml, input.liveTools ?? [], this.providers, input.signal);
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
      blocking_errors: canExecute ? [] : [...gate.result.errors],
      next_action: canExecute ? "execute" : "escalate",
    };
  }
}

async function selfReviewYaml(
  yaml: string,
  liveTools: readonly ToolDefinition[],
  providers: ProviderRuntime,
  signal?: AbortSignal,
): Promise<string> {
  if (liveTools.length === 0) return yaml;
  const toolNames = liveTools.map((t) => t.name);
  const reviewPrompt = [
    "You generated the following workflow YAML. Your task is to validate and fix ONLY the tool names.",
    "",
    "INSTRUCTIONS:",
    "1. Read every 'action:' field in the YAML.",
    "2. Check if it EXACTLY matches a name in AVAILABLE_TOOL_NAMES (character for character, hyphens and underscores matter).",
    "3. If a name does not match exactly:",
    "   a. Strip any leading prefix like 'dynamic_', 'static_', 'auto_' — e.g. 'dynamic_send-email' → 'send-email'.",
    "   b. Try swapping hyphens for underscores or vice-versa — e.g. 'send_email' → 'send-email'.",
    "   c. Replace the action with the corrected name if found in AVAILABLE_TOOL_NAMES.",
    "4. If no match exists even after prefix stripping and hyphen/underscore swapping, remove that step entirely.",
    "5. Do NOT change anything else — keep all other fields, parameters, descriptions, and structure identical.",
    "6. Return ONLY the corrected YAML. No commentary, no markdown fence.",
    "",
    "AVAILABLE_TOOL_NAMES:",
    JSON.stringify(toolNames),
    "",
    "WORKFLOW YAML TO REVIEW:",
    yaml,
  ].join("\n");

  try {
    const reviewed = await providers.generateCandidate(
      reviewPrompt,
      CANDIDATE_PROMPT_VERSION,
      (r) => { parseWorkflowYAMLStrict(r.text.trim()); },
      signal,
      { candidateId: "self_review" },
    );
    return reviewed.text.trim();
  } catch {
    return yaml;
  }
}

export async function correctToolNamesInYaml(
  yaml: string,
  liveTools: readonly ToolDefinition[],
  providers: ProviderRuntime,
  signal?: AbortSignal,
): Promise<{ yaml: string; corrected: boolean; stillInvalid: string[] }> {
  const liveNames = liveTools.map((t) => t.name);
  const liveSet = new Set(liveNames);
  let parsed;
  try { parsed = parseWorkflowYAMLStrict(yaml); } catch { return { yaml, corrected: false, stillInvalid: [] }; }

  const invalid = parsed.steps
    .map((s) => s.action)
    .filter((a): a is string => typeof a === "string" && !liveSet.has(a));
  if (invalid.length === 0) return { yaml, corrected: false, stillInvalid: [] };

  const correctionPrompt = [
    "SYSTEM",
    "You are a YAML correction assistant. Fix ONLY the tool names listed in INVALID_TOOL_NAMES so they match an entry in VALID_TOOL_NAMES exactly. Return the corrected YAML only — no Markdown fence, no commentary. If no valid replacement exists, remove that step.",
    "",
    "INVALID_TOOL_NAMES",
    JSON.stringify(invalid),
    "",
    "VALID_TOOL_NAMES",
    JSON.stringify(liveNames),
    "",
    "ORIGINAL_YAML",
    yaml,
  ].join("\n");

  try {
    const generated = await providers.generateCandidate(
      correctionPrompt,
      CANDIDATE_PROMPT_VERSION,
      (r) => { parseWorkflowYAMLStrict(r.text.trim()); },
      signal,
      { candidateId: "correction_pass" },
    );
    const correctedYaml = generated.text.trim();
    const reparsed = parseWorkflowYAMLStrict(correctedYaml);
    const stillInvalid = reparsed.steps
      .map((s) => s.action)
      .filter((a): a is string => typeof a === "string" && !liveSet.has(a));
    return { yaml: correctedYaml, corrected: true, stillInvalid };
  } catch {
    return { yaml, corrected: false, stillInvalid: invalid };
  }
}

export function assembleCandidatePrompt(userText: string, userRole: string, registries: RegistryService, priorMessages: string[] = [], liveTools?: readonly ToolDefinition[]): string {
  const snapshot = registries.snapshot();
  const applicableRules = snapshot.rules.filter((rule) => rule.enabled && (rule.applies_to_roles.length === 0 || rule.applies_to_roles.some((role) => normalizeRole(role) === normalizeRole(userRole))));
  const history = priorMessages.length === 0 ? "[]" : JSON.stringify(priorMessages);
  const toolPool = liveTools !== undefined && liveTools.length > 0 ? liveTools : snapshot.tools;
  const relevantTools = selectRelevantToolsForSynthesis(userText, toolPool, 20);
  return [
    "SYSTEM",
    "Generate exactly one workflow as strict YAML. Return YAML only — no Markdown fence, no commentary.",
    "",
    "REQUIRED WORKFLOW STRUCTURE (all fields are exact key names — do not rename them):",
    "  name: <string>           # workflow name",
    "  description: <string>    # non-empty description",
    "  trigger:",
    "    type: <string>         # manual | schedule | event",
    "    config:                # REQUIRED for schedule trigger only",
    "      cron: <string>       # 5-field UTC cron, e.g. '0 9 * * *' = 9 AM daily",
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
    "- COPY THE TOOL NAME CHARACTER-FOR-CHARACTER from TOOL_REGISTRY_JSON — including any hyphens. For example, if the registry lists 'send-email', you MUST write action: send-email (with hyphen), NOT send_email (with underscore). Tool names are case-sensitive and hyphen/underscore differences matter.",
    "- DO NOT use kind: approval, kind: condition, kind: http, or any kind other than tool. The ONLY valid step type is action-based (kind: tool).",
    "- ONLY use tools that appear in TOOL_REGISTRY_JSON. Never add tools based on rule instructions — APPLICABLE_RULES_JSON is for reference only, not a source of tool names.",
    "- If a rule mentions a tool (e.g. audit.write_audit_log) that is NOT in TOOL_REGISTRY_JSON, IGNORE that rule completely.",
    "- CRITICAL — DO NOT INVENT TOOL NAMES: If the user requests a capability (e.g. 'send email', 'send SMS', 'notify', 'post to Slack') and NO matching tool exists in TOOL_REGISTRY_JSON, you MUST omit that step entirely. Never create a tool name that is not in TOOL_REGISTRY_JSON. NEVER add prefixes like 'dynamic_', 'static_', or 'auto_' to any tool name — e.g. do NOT write 'dynamic_send-email', write 'send-email' directly. A workflow with fewer steps using real tools is always better than one with invented names.",
    "- If the user mentions a schedule (e.g. 'every day', 'daily at 9am', 'every hour', 'every Monday'), set trigger.type to 'schedule' and trigger.config.cron to the correct 5-field UTC cron expression. Otherwise use trigger.type: manual.",
    "- Generate the MINIMUM number of steps needed to fulfill the user's request. Do NOT add extra steps for audit, notification, or echo unless the user explicitly asked for them AND the tool exists in TOOL_REGISTRY_JSON.",
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

function directRegistryContext(query: string, registries: RegistryService, userRole: string): Record<string, unknown> {
  const snapshot = registries.snapshot();
  const tools = selectRelevantToolsForSynthesis(query, snapshot.tools, 20).map((tool) => ({ ...tool, score: 1, match_reason: "direct registry inclusion" }));
  const rules = snapshot.rules.filter((rule) => rule.enabled && !isGlobalRule(rule)).filter((rule) => rule.applies_to_roles.length === 0 || rule.applies_to_roles.some((role) => normalizeRole(role) === normalizeRole(userRole))).map((rule) => ({ ...rule, score: 1, match_reason: "direct registry inclusion" }));
  const globalRules = snapshot.rules.filter((rule) => rule.enabled && isGlobalRule(rule)).map((rule) => ({ ...rule, score: 1, match_reason: "direct registry inclusion" }));
  return { tools, rules, global_rules: globalRules, templates: [], examples: [], query, user_role: userRole, method: "direct_registry", retrieval_method: "direct_registry" };
}

function isGlobalRule(rule: { domain: string; rule_id: string }): boolean { return rule.domain.trim().toLowerCase() === "global" || rule.rule_id.startsWith("GLOBAL-"); }
function normalizeRole(value: string): string { return value.trim().toLowerCase().replace(/[ -]/g, "_").replace(/^platform_admin$/, "admin"); }
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
