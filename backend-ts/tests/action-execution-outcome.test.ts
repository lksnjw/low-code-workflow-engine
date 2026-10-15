import { expect, test, vi } from "vitest";
import { runActionLoop, type ActionLoopResult, type ActionStep } from "../src/agent/action-loop.js";
import { projectActionOutcome } from "../src/agent/execution-outcome.js";
import { toolSchema } from "../src/registry/schemas.js";
import type { ProviderRuntime } from "../src/providers/runtime.js";

const tool = toolSchema.parse({ tool_id: "READ-1", name: "finance.read", mcp_tool_name: "finance.read", display_name: "Read invoice", is_read_only: true,
  allowed_roles: ["Workflow Builder"], input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } });
const step: ActionStep = { toolName: "finance.read", displayName: "Read invoice", arguments: { id: "x" }, result: { id: "x" }, isReadOnly: true,
  governanceStatus: "skipped", startedAt: "2026-10-04T10:00:00.000Z", completedAt: "2026-10-04T10:00:00.125Z" };
const result = (steps: ActionStep[], blocked = false): ActionLoopResult => ({ text: "Everything succeeded", steps, blocked, workflowYaml: "", totalTokens: { input: 2, output: 3 }, latencyMs: 1 });
const expected = [{ id: "invoice", names: ["finance.read"] }];

test("outcome uses real timestamps, stable authored node id and tool evidence", () => {
  const outcome = projectActionOutcome(result([step]), expected);
  expect(outcome.failed).toBe(false);
  expect(outcome.result.timeline[0]).toMatchObject({ nodeId: "invoice", status: "DONE", durationMs: 125, startedAt: step.startedAt, completedAt: step.completedAt });
  expect(outcome.result.tokens.total).toBe(5);
});

test.each([result([], false), result([step], true), result([{ ...step, error: "ERP unavailable", result: null }]),
  result([{ ...step, governanceStatus: "blocked", governanceReason: "No grant" }]), result([{ ...step, toolName: "wrong.tool" }]), result([step, step])])("model success prose cannot override failed/incomplete evidence", (input) => {
  expect(projectActionOutcome(input, expected).failed).toBe(true);
});

test("blocked or failed attempts are not successful outputs", () => {
  const outcome = projectActionOutcome(result([{ ...step, governanceStatus: "blocked", governanceReason: "No grant" }], true), expected);
  expect(outcome.result.state).toEqual({});
  expect(outcome.result.timeline[0]).toMatchObject({ status: "FAILED", output: "No grant" });
  expect(outcome.result.logs[0]?.level).toBe("error");
});

test.each(["unknown", "missing", "wrong-type", "array-coercion"])("%s repeated invalid proposal stops after one bounded correction and never reaches governance or dispatch", async (scenario) => {
  const queryWithTools = vi.fn(async () => ({ text: "I will do it", toolCalls: [{ id: "call1", name: scenario === "unknown" ? "unknown" : "finance.read",
    arguments: scenario === "missing" ? {} : { id: scenario === "wrong-type" ? 1 : scenario === "array-coercion" ? ["x"] : "x" } }], stopReason: "tool_calls", inputTokens: 1, outputTokens: 1 }));
  const dispatch = vi.fn(), policy = vi.fn();
  const output = await runActionLoop({ userMessage: "read", chatHistory: [], sessionId: "s", actorId: "u", actorRole: "Workflow Builder", user: { id: "u", role: "Workflow Builder", department: null } },
    [tool], dispatch, policy, { queryWithTools } as unknown as ProviderRuntime);
  expect(output.blocked).toBe(true);
  expect(dispatch).not.toHaveBeenCalled();
  expect(policy).not.toHaveBeenCalled();
  expect(queryWithTools).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(queryWithTools.mock.calls)).toContain("NOT_DISPATCHED");
});

test("callback failure halts automatic model retry and following calls", async () => {
  const queryWithTools = vi.fn(async () => ({ text: "go", toolCalls: [{ id: "1", name: "finance.read", arguments: { id: "x" } }, { id: "2", name: "finance.read", arguments: { id: "y" } }], stopReason: "tool_calls", inputTokens: 1, outputTokens: 1 }));
  const dispatch = vi.fn(async () => { throw new Error("ERP failed"); });
  const output = await runActionLoop({ userMessage: "read", chatHistory: [], sessionId: "s", actorId: "u", actorRole: "Workflow Builder", user: { id: "u", role: "Workflow Builder", department: null } },
    [tool], dispatch, async () => ({ allowed: true }), { queryWithTools } as unknown as ProviderRuntime);
  expect(output.blocked).toBe(true);
  expect(output.steps[0]?.error).toBe("ERP failed");
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(queryWithTools).toHaveBeenCalledTimes(1);
});
