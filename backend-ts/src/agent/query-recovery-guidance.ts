import { z } from "zod";
import type { ChatWorkspaceStatus } from "./chat-workspace-status.js";

const schema = z.object({ kind: z.literal("workflow-recovery"), executionId: z.string().min(1).max(128), failureCategory: z.string().max(64),
  nodeId: z.string().max(128).nullable(), nextAction: z.enum(["REVIEW_RETRY", "REVIEW_EXECUTION"]) }).strict();
export type QueryRecoveryGuidance = z.infer<typeof schema>;

/** A model selects only existing saved facts. No model-written failure reason,
 * invented root cause, new ERP facts, approval or execution claim is accepted. */
export function parseQueryRecoveryGuidance(text: string, status?: ChatWorkspaceStatus): QueryRecoveryGuidance | undefined {
  if (status?.profile !== "chat-workspace-status/v1") return undefined;
  let raw: unknown; try { raw = JSON.parse(text.trim()); } catch { return undefined; }
  const parsed = schema.safeParse(raw); if (!parsed.success) return undefined;
  const value = parsed.data, run = status.workflows.find(workflow => workflow.latestRun?.id === value.executionId)?.latestRun;
  if (!run?.failure || !["FAILED", "CANCELLED", "RECOVERY_REQUIRED", "RECONCILIATION_REQUIRED", "RECONCILED"].includes(run.status) ||
      run.failure.category !== value.failureCategory || run.failure.nodeId !== value.nodeId ||
      value.nextAction !== (run.retryReview?.allowed === true ? "REVIEW_RETRY" : "REVIEW_EXECUTION")) return undefined;
  return value;
}

export function recoveryGuidanceText(value: QueryRecoveryGuidance) {
  const reason = /OUTCOME_UNKNOWN/.test(value.failureCategory) ? "The earlier call's outcome is unconfirmed. Its exact low-level cause is not recorded here." :
    value.failureCategory === "ERP_TOOL_ERROR" ? "The ERP read returned an acknowledged error instead of a successful answer." :
      value.failureCategory === "AGENT_OUTPUT_INVALID" ? "The assistant output did not satisfy the workflow's required output schema." : "The saved execution records a failure; an exact low-level cause cannot be inferred from its category alone.";
  return `Workflow assistant guidance — saved evidence only\n\n${reason}\nRecorded category: ${value.failureCategory}${value.nodeId ? `; step: ${value.nodeId}` : ""}.\n\n${value.nextAction === "REVIEW_RETRY" ? "You can review Retry below and explicitly confirm a separate new execution. Current validation and fresh independent approvals still apply." : "Review the saved execution details. Whole-workflow retry is not authorized by this answer."}\nNothing was restarted, approved or changed by this explanation.`;
}
