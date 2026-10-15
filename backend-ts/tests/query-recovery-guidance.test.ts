import { expect, test, vi } from "vitest";
import { runQueryLoop } from "../src/agent/query-loop.js";
import { parseQueryRecoveryGuidance } from "../src/agent/query-recovery-guidance.js";
import { queryChatPresentation } from "../src/agent/query-chat-presentation.js";
import type { ChatWorkspaceStatus } from "../src/agent/chat-workspace-status.js";
const status: ChatWorkspaceStatus = { profile: "chat-workspace-status/v1", sampledAt: "2026-10-14T08:00:00Z", workflows: [{ id: "wf", draftVersion: 1, publishedVersion: 1,
  latestRun: { id: "failed", status: "FAILED", publishedVersion: 1, failure: { category: "ERP_TOOL_ERROR", nodeId: "lookup" }, retryReview: { profile: "execution-retry-admission/v1", allowed: true, canReviewForNewRun: false, requiresUncertaintyAcknowledgement: false, reason: "Explicit confirmation required" } } }] };
const guidance = { kind: "workflow-recovery", executionId: "failed", failureCategory: "ERP_TOOL_ERROR", nodeId: "lookup", nextAction: "REVIEW_RETRY" };
test("real orchestration accepts only a completed model selection of current saved facts and offers review, never an ERP read or run", async () => {
  const queryWithTools = vi.fn(async () => ({ text: JSON.stringify(guidance), toolCalls: [], inputTokens: 10, outputTokens: 20, measured: true, stopReason: "stop", completionConfirmed: true })), dispatch = vi.fn();
  const result = await runQueryLoop({ userMessage: "Why did this workflow fail? Can I retry?", chatHistory: [], sessionId: "chat", actorId: "owner", actorRole: "Platform Admin", workspaceStatus: status }, [], dispatch, { queryWithTools });
  expect(dispatch).not.toHaveBeenCalled(); expect(result).toMatchObject({ readOutcome: "NO_CONFIRMED_READ", narrativeRejected: false, recoveryGuidance: guidance });
  expect(result.text).toContain("acknowledged error"); expect(result.text).toContain("explicitly confirm"); expect(result.text).toContain("Nothing was restarted");
  expect(queryChatPresentation("AUDIT", "Why failed", null, result).workflowDraft).toBeUndefined();
  expect(queryWithTools.mock.calls).toHaveLength(1);
});
test.each([{ executionId: "invented" }, { nodeId: "other" }, { failureCategory: "INVENTED_CAUSE" }, { nextAction: "EXECUTE" }, { summary: "I restarted it" }])("forged model guidance fails closed: %j", patch => {
  expect(parseQueryRecoveryGuidance(JSON.stringify({ ...guidance, ...patch }), status)).toBeUndefined();
});
test("a blocked retry or absent current snapshot cannot be promoted by model prose", () => {
  const blocked = structuredClone(status); blocked.workflows[0]!.latestRun!.retryReview!.allowed = false;
  expect(parseQueryRecoveryGuidance(JSON.stringify(guidance), blocked)).toBeUndefined();
  expect(parseQueryRecoveryGuidance(JSON.stringify(guidance))).toBeUndefined();
});
