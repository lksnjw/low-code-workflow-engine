import type { ToolDefinition } from "../registry/schemas.js";
import type { ProviderRuntime } from "../providers/runtime.js";
import { promptData } from "../prompts/contracts.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type ValidationIssue = {
  stepId: string;
  action: string;
  severity: "error" | "warning";
  code: "TOOL_NOT_FOUND" | "MISSING_REQUIRED_PARAM" | "SCHEMA_MISMATCH" | "DATA_GAP";
  message: string;
  suggestion?: string | undefined;
};

export type ToolResolution = {
  stepId: string;
  originalAction: string;
  resolvedAction: string;
  tool: ToolDefinition;
};

export type WorkflowPreRunValidation = {
  valid: boolean;
  issues: ValidationIssue[];
  toolResolutions: ToolResolution[];
  dataFlowPlan: string;
};

export type RuntimeArgIssue = {
  toolName: string;
  missing: string[];
  invalid: string[];
};

// ── Static validation (no LLM) ───────────────────────────────────────────────

/*******************************************************************************
 * Function: validateWorkflowStatically
 *
 * Checks workflow steps against available tools and their required
 * arguments.
 ******************************************************************************/
export function validateWorkflowStatically(
  steps: Array<{ id: string; kind?: string; action?: string; parameters?: Record<string, unknown>; description?: string }>,
  liveTools: readonly ToolDefinition[],
): Omit<WorkflowPreRunValidation, "dataFlowPlan"> {
  const byName = new Map(liveTools.map((t) => [t.name, t]));
  const byMcp = new Map(liveTools.map((t) => [t.mcp_tool_name, t]));
  const issues: ValidationIssue[] = [];
  const toolResolutions: ToolResolution[] = [];

  for (const step of steps) {
    // Approval steps are a human sign-off checkpoint, not a dispatchable tool
    // call — they have no action and must not be treated as TOOL_NOT_FOUND.
    if (step.kind === "approval" || step.kind === "analysis" || step.kind === "agent") continue;
    const action = step.action ?? "";
    const resolved = resolveToolName(action, byName, byMcp);

    if (resolved === null) {
      issues.push({
        stepId: step.id,
        action,
        severity: "error",
        code: "TOOL_NOT_FOUND",
        message: `Tool "${action}" is not available in the live ERP Bridge.`,
        suggestion: findClosestTool(action, liveTools),
      });
      continue;
    }

    toolResolutions.push({
      stepId: step.id,
      originalAction: action,
      resolvedAction: resolved.name,
      tool: resolved,
    });

    // Warn about missing required parameters (LLM may fill from context)
    const schema = resolved.input_schema as { required?: string[]; properties?: Record<string, unknown> } | undefined;
    const required = (schema?.required ?? []) as string[];
    const provided = Object.keys(step.parameters ?? {});
    const missing = required.filter((r) => !provided.includes(r));
    if (missing.length > 0) {
      issues.push({
        stepId: step.id,
        action: resolved.name,
        severity: "warning",
        code: "MISSING_REQUIRED_PARAM",
        message: `Step "${step.id}" is missing required parameter(s): [${missing.join(", ")}]. The LLM will infer them from context or prior step results.`,
      });
    }
  }

  return {
    valid: !issues.some((i) => i.severity === "error"),
    issues,
    toolResolutions,
  };
}

// ── Per-call argument validation (used inside action-loop) ───────────────────

/*******************************************************************************
 * Function: validateToolArguments
 *
 * Reports missing or invalid arguments for a registered tool.
 ******************************************************************************/
type ToolInputSchema = { required?: string[]; properties?: Record<string, { type?: string }> };

const TYPE_CHECKERS: Record<string, (v: unknown) => boolean> = {
  string: (v) => typeof v === "string",
  number: (v) => typeof v === "number",
  integer: (v) => typeof v === "number" && Number.isInteger(v),
  boolean: (v) => typeof v === "boolean",
  array: (v) => Array.isArray(v),
  object: (v) => typeof v === "object" && v !== null && !Array.isArray(v),
};

function describeType(value: unknown): string {
  if (Array.isArray(value)) return "an array";
  if (value === null) return "null";
  return typeof value;
}

/*******************************************************************************
 * Function: normalizeToolArguments
 *
 * Legacy authoring helper: unwrap only a single primitive whose type exactly
 * matches an explicitly declared scalar field. Unknown fields/schemas and
 * genuine arrays remain unchanged. Interactive execution instead asks the
 * model for a corrected proposal and validates it before dispatch.
 ******************************************************************************/
export function normalizeToolArguments(
  args: Record<string, unknown>,
  toolDef: ToolDefinition | undefined,
): { args: Record<string, unknown>; corrections: string[] } {
  const schema = toolDef?.input_schema as ToolInputSchema | undefined;
  const properties = schema?.properties ?? {};

  const corrections: string[] = [];
  const normalized: Record<string, unknown> = { ...args };
  for (const [key, value] of Object.entries(args)) {
    if (!Array.isArray(value) || value.length !== 1) continue;
    const [only] = value;
    if (typeof only !== "string" && typeof only !== "number" && typeof only !== "boolean") continue;
    const expected = properties[key]?.type;
    if (!expected || !["string", "number", "integer", "boolean"].includes(expected) || !TYPE_CHECKERS[expected]?.(only)) continue;
    normalized[key] = only;
    corrections.push(`"${key}": unwrapped a single-element array — the tool expects a plain ${typeof only}, not a list`);
  }
  return { args: normalized, corrections };
}

/*******************************************************************************
 * Function: validateToolArguments
 *
 * Reports missing or invalid arguments for a registered tool — checked
 * against the tool's actual input schema (types included), not just its
 * description, so a shape mistake the LLM makes (e.g. an array where the
 * schema wants a plain string) gets caught before it's trusted as correct.
 ******************************************************************************/
export function validateToolArguments(
  toolName: string,
  args: Record<string, unknown>,
  toolDef: Pick<ToolDefinition, "input_schema"> | undefined,
): RuntimeArgIssue {
  if (toolDef === undefined) return { toolName, missing: [], invalid: [`Tool "${toolName}" not found in registry`] };

  const schema = toolDef.input_schema as ToolInputSchema | undefined;
  if (schema === undefined) return { toolName, missing: [], invalid: [] };

  const required = (schema.required ?? []) as string[];
  const missing = required.filter((r) => !(r in args));

  // Detect placeholder values — LLM sometimes passes these instead of real values
  const PLACEHOLDER_RE = /^\s*(\[.*\]|<.*>|\{.*\}|xxx|none|null|undefined|todo|placeholder|example|your_.+|insert_here)\s*$/i;
  const properties = schema.properties ?? {};
  const concreteJsonString = (value: string): boolean => {
    if (value.length > 64_000) return false;
    let parsed: unknown;
    try { parsed = JSON.parse(value); } catch { return false; }
    if (!parsed || typeof parsed !== "object") return false;
    let nodes = 0;
    const concrete = (item: unknown, depth: number): boolean => {
      if (++nodes > 4096 || depth > 16) return false;
      if (typeof item === "string") return !PLACEHOLDER_RE.test(item);
      if (item && typeof item === "object") return Object.entries(item).every(([key, child]) =>
        !["__proto__", "prototype", "constructor"].includes(key) && concrete(child, depth + 1));
      return true;
    };
    return concrete(parsed, 0);
  };
  const invalid = Object.entries(args)
    .filter(([key, value]) => typeof value === "string" && PLACEHOLDER_RE.test(value) &&
      !(properties[key]?.type === "string" && concreteJsonString(value)))
    .map(([k]) => `"${k}" contains a placeholder value — must be a real value from prior step results`);

  // Type mismatches against the tool's real schema.
  for (const [key, value] of Object.entries(args)) {
    const expectedType = properties[key]?.type;
    if (typeof expectedType !== "string") continue;
    const checker = TYPE_CHECKERS[expectedType];
    if (checker !== undefined && !checker(value)) {
      invalid.push(`"${key}" should be of type "${expectedType}" per the tool's schema, but got ${describeType(value)}`);
    }
  }

  return { toolName, missing, invalid };
}

// ── LLM data-flow analysis ───────────────────────────────────────────────────

/*******************************************************************************
 * Function: analyzeDataFlow
 *
 * Requests an analysis of how data passes between workflow steps.
 ******************************************************************************/
export async function analyzeDataFlow(
  steps: Array<{ id: string; kind?: string; action?: string; description?: string; parameters?: Record<string, unknown> }>,
  toolResolutions: ToolResolution[],
  providerRuntime: ProviderRuntime,
  signal?: AbortSignal,
): Promise<string> {
  if (steps.length <= 1) return "";
  const prompt = promptData({ steps, toolContracts: toolResolutions.map((resolution) => ({
    stepId: resolution.stepId, action: resolution.resolvedAction, inputSchema: resolution.tool.input_schema,
  })) });
  try {
    const result = await providerRuntime.generateCandidate(prompt, "prompt/data-flow/v2",
      () => { /* advisory text only; never a dispatch instruction */ }, signal,
      { candidateId: "data_flow_plan", egress: { purpose: "interactive", dataClass: "restricted" } });
    return result.text.trim();
  } catch { return ""; }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/*******************************************************************************
 * Function: resolveToolName
 *
 * Resolves a tool by its local or MCP name and supported name variations.
 ******************************************************************************/
function resolveToolName(
  action: string,
  byName: Map<string, ToolDefinition>,
  byMcp: Map<string, ToolDefinition>,
): ToolDefinition | null {
  if (byName.has(action)) return byName.get(action)!;
  if (byMcp.has(action)) return byMcp.get(action)!;

  const hyphenated = action.replace(/_/g, "-");
  if (byName.has(hyphenated)) return byName.get(hyphenated)!;
  if (byMcp.has(hyphenated)) return byMcp.get(hyphenated)!;

  const underscored = action.replace(/-/g, "_");
  if (byName.has(underscored)) return byName.get(underscored)!;
  if (byMcp.has(underscored)) return byMcp.get(underscored)!;

  // Strip LLM-hallucinated prefixes
  const stripped = action.replace(/^(dynamic_|static_|auto_)/, "");
  if (stripped !== action) {
    const r = resolveToolName(stripped, byName, byMcp);
    if (r !== null) return r;
  }

  return null;
}

/*******************************************************************************
 * Function: findClosestTool
 *
 * Suggests a tool using word overlap with its name and description.
 ******************************************************************************/
function findClosestTool(action: string, tools: readonly ToolDefinition[]): string | undefined {
  const words = action.toLowerCase().replace(/[_-]/g, " ").split(" ").filter((w) => w.length > 2);
  if (words.length === 0) return undefined;
  let best: { name: string; score: number } | null = null;
  for (const tool of tools) {
    const text = `${tool.name} ${tool.description ?? ""}`.toLowerCase();
    const score = words.reduce((acc, w) => acc + (text.includes(w) ? 1 : 0), 0);
    if (score > 0 && (best === null || score > best.score)) best = { name: tool.name, score };
  }
  return best !== null ? `Did you mean "${best.name}"?` : undefined;
}
