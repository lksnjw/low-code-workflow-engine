import type { RecurringAutomationComposition, RecurringDeliveryRequest } from "../../delivery/recurring-automation.js";
import type { ToolDefinition } from "../../registry/schemas.js";
import type { SynthesisResult } from "../../synthesis/service.js";
import { isRecord } from "./common.js";

/*******************************************************************************
 * Function: compactWorkflowArtifacts
 *
 * Selects workflow result details to store with a chat message.
 ******************************************************************************/
export function compactWorkflowArtifacts(
  result: SynthesisResult,
  chatSessionId: string,
  chatMessageId: string,
  traceId: string,
  workflowId: string | null = null,
  missingTools: string[] = [],
  pendingGenerationApproval: { steps: Array<{ stepId: string; description: string }>; requestedAt: string } | null = null,
  automationRequest: RecurringDeliveryRequest | null = null,
  automationComposition: RecurringAutomationComposition | null = null,
): Record<string, unknown> {
  const retrieval = result.retrieval as {
    tools?: unknown[];
    rules?: unknown[];
    global_rules?: unknown[];
    examples?: unknown[];
  };
  return {
    intent: "WORKFLOW",
    chatSessionId,
    chatMessageId,
    traceId,
    validation: result.validation,
    can_execute: false,
    validation_passed: result.validation.passed,
    selected_candidate_id: result.selected_candidate_id,
    selected_workflow_yaml: result.selected_workflow_yaml,
    ...(result.can_execute ? {} : { yaml: result.yaml }),
    validation_summary: result.validation_summary,
    blocking_errors: [...new Set([...result.blocking_errors, ...(automationComposition?.remainingRequirements ?? [])])],
    next_action: "REVIEW_DRAFT",
    candidates: result.candidates.map((candidate) => ({
      id: candidate.id,
      candidate_id: candidate.candidate_id,
      status: candidate.status,
      score: candidate.score,
    })),
    ...(workflowId !== null ? { workflowId } : {}),
    ...(missingTools.length > 0 ? { missing_tools: missingTools } : {}),
    ...(pendingGenerationApproval !== null ? { generationApproval: { workflowId, ...pendingGenerationApproval } } : {}),
    ...(automationRequest !== null ? { automationRequest } : {}),
    ...(automationComposition !== null ? { automationComposition } : {}),
    retrieval: {
      tools: pickArtifactRecords(retrieval.tools, [
        "tool_id", "name", "display_name", "description", "endpoint",
        "http_method", "risk_level", "erp_system", "bpi_process_alignment",
        "score", "current_gaps", "allowed_roles", "required_parameters",
      ]),
      rules: pickArtifactRecords(retrieval.rules, [
        "rule_id", "rule_name", "rule_type", "description", "enforcement_action",
        "severity", "score",
      ]),
      global_rules: pickArtifactRecords(retrieval.global_rules, [
        "rule_id", "rule_name", "rule_type", "description", "enforcement_action",
        "severity", "score",
      ]),
      examples: pickArtifactRecords(retrieval.examples, [
        "scenario_id", "user_request", "user_role", "risk_level",
        "expected_decision", "expected_domain",
      ]),
    },
  };
}

/*******************************************************************************
 * Function: pickArtifactRecords
 *
 * Selects requested fields from object entries in an artifact collection.
 ******************************************************************************/
function pickArtifactRecords(values: unknown[] | undefined, keys: readonly string[]): Record<string, unknown>[] {
  if (!Array.isArray(values)) return [];
  return values.flatMap((value) => {
    if (!isRecord(value)) return [];
    const record: Record<string, unknown> = {};
    for (const key of keys) if (value[key] !== undefined) record[key] = structuredClone(value[key]);
    return [record];
  });
}


/*******************************************************************************
 * Function: errorText
 *
 * Converts an error or other thrown value into a message string.
 ******************************************************************************/
export function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }

// Builds a plain-English summary of what the user can do in the ERP, grouped by module.
/*******************************************************************************
 * Function: buildCapabilitiesResponse
 *
 * Summarizes available ERP tools by module for a chat response.
 ******************************************************************************/
export function buildCapabilitiesResponse(tools: readonly ToolDefinition[]): string {
  if (tools.length === 0)
    return "No ERP tools are currently available for your role. An administrator can review the bridge connection and tool permissions.";

  const groups = new Map<string, string[]>();
  for (const tool of tools) {
    const mod = (tool.module ?? "General").trim() || "General";
    if (!groups.has(mod)) groups.set(mod, []);
    const display = (tool.display_name ?? tool.name)
      .replace(/_/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .slice(0, 80);
    groups.get(mod)!.push(display);
  }

  const lines: string[] = [`Here are the **${tools.length} ERP tools** available:\n`];
  for (const [mod, names] of groups.entries()) {
    lines.push(`## ${mod} (${names.length} tools)`);
    names.sort().forEach((n) => lines.push(`- ${n}`));
    lines.push("");
  }
  lines.push(tools.every(tool => tool.is_read_only)
    ? "These reviewed tools are read-only. Ask for information supported by one of the listed tools. No ERP changes, approvals or email delivery are available through this tool set."
    : "Ask for an outcome supported by the listed tools. Availability is not execution permission: current role checks, validation and any required human approval still apply.");
  return lines.join("\n");
}
