import { createHash } from "node:crypto";
import type { AnalysisProvider } from "../analysisprovider/types.js";
import type { Workflow } from "../models/schemas.js";
import { effectiveStepKind } from "../models/schemas.js";
import { parseWorkflowYAMLStrict, resolveVariables, workflowContentHash } from "../parser/workflow.js";
import { withoutSecretFields } from "../redact/secrets.js";
import { validateValue } from "../structured-output/validate.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { RegistryValidator, ResolvedPolicyViolation, ValidationToken } from "../validator/registry-validator.js";

export class DispatchPolicyError extends Error {
  constructor(readonly violation: ResolvedPolicyViolation) { super(violation.reason); this.name = "DispatchPolicyError"; }
}

export class DataEgressError extends Error {
  constructor(readonly reason: string) { super(reason); this.name = "DataEgressError"; }
}

export type RunnerTimelineEntry = {
  id: string;
  nodeId: string;
  label: string;
  status: "DONE" | "FAILED";
  startedAt: string;
  completedAt: string;
  durationMs: number;
  sideEffect?: boolean;
  output?: unknown;
};

export type RunnerLog = {
  timestamp: string;
  level: "info" | "error";
  nodeId: string;
  message: string;
  metadata: Record<string, unknown> | null;
};

export type RunnerResult = {
  state: Record<string, unknown>;
  logs: RunnerLog[];
  timeline: RunnerTimelineEntry[];
  tokens: { input: number; output: number; total: number };
};

export class Executor {
  #analysisProvider: AnalysisProvider | null = null;
  #analysisModel = "";

  constructor(readonly tools: ToolRegistry, readonly validator: RegistryValidator) {
    if (tools === null || tools === undefined) throw new Error("runner requires a tool registry");
    if (validator === null || validator === undefined) throw new Error("runner requires a registry validator");
  }

  setAnalysisProvider(provider: AnalysisProvider, model = ""): void {
    if (provider === null || provider === undefined || typeof provider.generate !== "function") throw new Error("analysis provider must implement generate");
    this.#analysisProvider = provider;
    this.#analysisModel = model;
  }

  async run(executionID: string, workflow: Workflow, input: Record<string, unknown>, token: ValidationToken | null, signal?: AbortSignal): Promise<RunnerResult> {
    if (token === null) throw new Error("validated execution token is required");
    if (!this.validator.verifyToken(token)) throw new Error("validated execution token is invalid");
    if (token.workflow_content_hash !== workflowContentHash(workflow.yaml)) throw new Error("validated workflow content hash does not match execution content");
    if (token.registry_hash !== this.validator.registries.hash()) throw new Error("validated registry hash does not match the active registry");
    const blueprint = parseWorkflowYAMLStrict(workflow.yaml);
    const state: Record<string, unknown> = { input };
    const result: RunnerResult = { state, logs: [], timeline: [], tokens: { input: 0, output: 0, total: 0 } };
    const analysisCache = new Map<string, unknown>();

    for (const [index, step] of blueprint.steps.entries()) {
      const started = new Date();
      const description = step.description?.trim();
      const label = description === undefined || description === "" ? (effectiveStepKind(step) === "analysis" ? `analysis: ${step.id}` : step.action ?? "") : description;
      if (effectiveStepKind(step) === "analysis") {
        try {
          const analysis = await this.executeAnalysis(step, state, analysisCache, signal);
          state[step.id] = { output: analysis.output };
          result.tokens.input += analysis.inputTokens;
          result.tokens.output += analysis.outputTokens;
          result.tokens.total = result.tokens.input + result.tokens.output;
          result.timeline.push(completeTimeline(index, step.id, label, started, "DONE", false, analysis.output));
          result.logs.push({ timestamp: new Date().toISOString(), level: "info", nodeId: step.id, message: "Analysis step completed", metadata: { kind: "analysis", sideEffect: false, cached: analysis.cached, inputTokens: analysis.inputTokens, outputTokens: analysis.outputTokens } });
        } catch (error) {
          result.timeline.push(completeTimeline(index, step.id, label, started, "FAILED", false));
          result.logs.push({ timestamp: new Date().toISOString(), level: "error", nodeId: step.id, message: errorText(error), metadata: { kind: "analysis", sideEffect: false } });
          throw attachPartial(error, result);
        }
        continue;
      }

      const parameters = resolveVariables(step.parameters ?? {}, state);
      parameters._action = step.action ?? "";
      const gate = await this.validator.evaluateResolvedStep(`dispatch.${executionID}`, workflow.yaml, index, parameters, token);
      if (gate.violation !== null || gate.capability === null) {
        const violation = gate.violation ?? { ruleId: "POLICY_VIOLATION", paramKey: "", reason: "dispatch policy rejected the step", redactedValue: "" };
        const error = new DispatchPolicyError(violation);
        result.timeline.push(completeTimeline(index, step.id, label, started, "FAILED"));
        result.logs.push({ timestamp: new Date().toISOString(), level: "error", nodeId: step.id, message: error.message, metadata: { action: step.action ?? "", rule_id: violation.ruleId, param_key: violation.paramKey } });
        throw attachPartial(error, result);
      }
      const tool = this.tools.get(step.action ?? "");
      if (tool === null) throw attachPartial(new Error(`tool ${JSON.stringify(step.action ?? "")} is not registered`), result);
      try {
        const output = await tool.execute(gate.capability, parameters, signal);
        state[step.id] = output;
        result.timeline.push(completeTimeline(index, step.id, label, started, "DONE", undefined, withoutSecretFields(output)));
        result.logs.push({ timestamp: new Date().toISOString(), level: "info", nodeId: step.id, message: "Step completed", metadata: withoutSecretFields(output) as Record<string, unknown> });
      } catch (error) {
        result.timeline.push(completeTimeline(index, step.id, label, started, "FAILED"));
        result.logs.push({ timestamp: new Date().toISOString(), level: "error", nodeId: step.id, message: errorText(error), metadata: { action: step.action ?? "" } });
        throw attachPartial(new Error(`step ${step.id} failed: ${errorText(error)}`, { cause: error }), result);
      }
    }
    return result;
  }

  private async executeAnalysis(
    step: ReturnType<typeof parseWorkflowYAMLStrict>["steps"][number],
    state: Record<string, unknown>,
    cache: Map<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ output: unknown; inputTokens: number; outputTokens: number; cached: boolean }> {
    const resolved = resolveVariables({ input: step.input ?? "" }, state).input;
    if (containsBraces(resolved)) throw new Error("analysis input contains unresolved template variables");
    const inputJSON = JSON.stringify(resolved);
    const maxItems = step.max_input_items === undefined || step.max_input_items === 0 ? 200 : step.max_input_items;
    const maxChars = step.max_input_chars === undefined || step.max_input_chars === 0 ? 20_000 : step.max_input_chars;
    const itemCount = Array.isArray(resolved) ? resolved.length : isRecord(resolved) ? Object.keys(resolved).length : 1;
    if (itemCount > maxItems) throw new Error(`analysis input exceeds max_input_items ${maxItems}`);
    if ([...inputJSON].length > maxChars) throw new Error(`analysis input exceeds max_input_chars ${maxChars}`);
    if (this.#analysisProvider === null) throw new Error("analysis provider is not configured");
    const schema = step.output_schema ?? {};
    const schemaJSON = JSON.stringify(schema);
    const model = this.#analysisModel;
    const key = createHash("sha256").update(`${step.instruction ?? ""}\0${inputJSON}\0${schemaJSON}\0${model}`).digest("hex");
    if (cache.has(key)) return { output: structuredClone(cache.get(key)), inputTokens: 0, outputTokens: 0, cached: true };
    const basePrompt = `SYSTEM\nReturn exactly one JSON value matching OUTPUT_SCHEMA.\nINSTRUCTION\n${step.instruction ?? ""}\nOUTPUT_SCHEMA\n${schemaJSON}\nINPUT\n${inputJSON}`;
    let inputTokens = 0;
    let outputTokens = 0;
    let correction = "";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await this.#analysisProvider.generate(correction === "" ? basePrompt : `${basePrompt}\nCORRECTION\n${correction}`, model, signal, { promptTemplateVersion: "prompt/analysis/v1" });
      if (response.measured) { inputTokens += response.inputTokens; outputTokens += response.outputTokens; }
      try {
        const decoded: unknown = JSON.parse(response.text);
        const errors = validateValue(schema, decoded);
        if (errors.length > 0) throw new Error(errors.join("; "));
        cache.set(key, structuredClone(decoded));
        return { output: decoded, inputTokens, outputTokens, cached: false };
      } catch (error) {
        if (attempt === 1) throw new Error(`analysis output failed schema validation after one retry: ${errorText(error)}`);
        correction = `The previous output was invalid: ${errorText(error)}. Return corrected JSON only.`;
      }
    }
    throw new Error("analysis output failed schema validation after one retry");
  }
}

function completeTimeline(index: number, nodeId: string, label: string, started: Date, status: "DONE" | "FAILED", sideEffect?: boolean, output?: unknown): RunnerTimelineEntry {
  const completed = new Date();
  const entry: RunnerTimelineEntry = { id: `step_${String(index + 1).padStart(3, "0")}`, nodeId, label, status, startedAt: started.toISOString(), completedAt: completed.toISOString(), durationMs: Math.trunc(completed.getTime() - started.getTime()) };
  if (sideEffect !== undefined) entry.sideEffect = sideEffect;
  if (output !== undefined) entry.output = output;
  return entry;
}

function attachPartial(error: unknown, result: RunnerResult): Error {
  const normalized = error instanceof Error ? error : new Error(String(error));
  Object.defineProperty(normalized, "runnerResult", { value: result, enumerable: false });
  return normalized;
}

export function partialResult(error: unknown): RunnerResult | null {
  if (!(error instanceof Error)) return null;
  return (error as Error & { runnerResult?: RunnerResult }).runnerResult ?? null;
}

function containsBraces(value: unknown): boolean { if (typeof value === "string") return value.includes("{{") && value.includes("}}"); if (Array.isArray(value)) return value.some(containsBraces); if (isRecord(value)) return Object.values(value).some(containsBraces); return false; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
