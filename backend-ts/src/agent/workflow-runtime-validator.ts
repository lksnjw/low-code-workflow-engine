import type { ToolDefinition } from "../registry/schemas.js";
import type { ProviderRuntime } from "../providers/runtime.js";

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
    if (step.kind === "approval") continue;
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
export function validateToolArguments(
  toolName: string,
  args: Record<string, unknown>,
  toolDef: ToolDefinition | undefined,
): RuntimeArgIssue {
  if (toolDef === undefined) return { toolName, missing: [], invalid: [`Tool "${toolName}" not found in registry`] };

  const schema = toolDef.input_schema as
    | { required?: string[]; properties?: Record<string, unknown> }
    | undefined;
  if (schema === undefined) return { toolName, missing: [], invalid: [] };

  const required = (schema.required ?? []) as string[];
  const missing = required.filter((r) => !(r in args));

  // Detect placeholder values — LLM sometimes passes these instead of real values
  const PLACEHOLDER_RE = /^\s*(\[.*\]|<.*>|\{.*\}|xxx|none|null|undefined|todo|placeholder|example|your_.+|insert_here)\s*$/i;
  const invalid = Object.entries(args)
    .filter(([, v]) => typeof v === "string" && PLACEHOLDER_RE.test(v))
    .map(([k]) => `"${k}" contains a placeholder value — must be a real value from prior step results`);

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

  const resMap = new Map(toolResolutions.map((r) => [r.stepId, r]));

  const stepDescriptions = steps
    .map((s, i) => {
      if (s.kind === "approval") {
        return (
          `Step ${i + 1} [${s.id}]\n` +
          `  Tool: (none — human approval checkpoint)\n` +
          `  Goal: ${s.description ?? "Human sign-off required before continuing"}`
        );
      }
      const r = resMap.get(s.id);
      const toolDesc = r?.tool.description ?? "unknown tool";
      const schema = r?.tool.input_schema as { required?: string[] } | undefined;
      const required = (schema?.required ?? []).join(", ") || "none";
      const params =
        s.parameters && Object.keys(s.parameters).length > 0
          ? JSON.stringify(s.parameters)
          : "(to be inferred from prior step output)";
      return (
        `Step ${i + 1} [${s.id}]\n` +
        `  Tool: ${r?.resolvedAction ?? s.action}\n` +
        `  Goal: ${s.description ?? s.action}\n` +
        `  Tool description: ${toolDesc}\n` +
        `  Required inputs: ${required}\n` +
        `  Configured params: ${params}`
      );
    })
    .join("\n\n");

  const prompt = [
    "You are a workflow execution planner. Analyze the inter-step data flow for this workflow.",
    "",
    "WORKFLOW STEPS:",
    stepDescriptions,
    "",
    "For each step transition, describe:",
    "1. What fields/values Step N will return in its result",
    "2. Exactly which fields the executor must extract and pass into Step N+1",
    "3. Any data transformation needed (e.g. format a list as email body text)",
    "",
    "Output a concise numbered execution plan — one paragraph per step. Max 300 words.",
    "Write it as instructions FOR the executor, not an analysis. Use imperative language.",
    "Example: 'Step 1: Call list_leave_applications. Extract the array of records. Step 2: Format the records as a readable list and pass as the email body parameter.'",
  ].join("\n");

  try {
    const result = await providerRuntime.generateCandidate(
      prompt,
      "data-flow-v1",
      () => { /* no YAML validation needed */ },
      signal,
      { candidateId: "data_flow_plan" },
    );
    return result.text.trim();
  } catch {
    return "";
  }
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
