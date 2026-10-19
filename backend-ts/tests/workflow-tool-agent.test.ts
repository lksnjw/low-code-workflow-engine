import { expect, test, vi } from "vitest";
import { runWorkflowToolAgent } from "../src/agent/workflow-tool-agent.js";

test("Pi schedules and awaits one exact registered invocation without a new model plan", async () => {
  const events: string[] = [], receipt = { structuredContent: { id: "actual-customer" } };
  const dispatch = vi.fn(async signal => { expect(signal).toBeInstanceOf(AbortSignal); return receipt; });
  expect(await runWorkflowToolAgent({ toolName: "create_customer", onEvent: type => events.push(type) }, dispatch)).toBe(receipt);
  expect(dispatch).toHaveBeenCalledOnce();
  expect(events).toContain("agent_start"); expect(events).toContain("tool_execution_start"); expect(events).toContain("tool_execution_end"); expect(events).toContain("agent_end");
});

test("original ERP errors propagate unchanged and are never replayed by Pi", async () => {
  const error = new Error("private remote diagnostic"), dispatch = vi.fn(async () => { throw error; });
  await expect(runWorkflowToolAgent({ toolName: "get_customer" }, dispatch)).rejects.toBe(error);
  expect(dispatch).toHaveBeenCalledOnce();
});

test("cancellation before Start prevents tool entry", async () => {
  const controller = new AbortController(); controller.abort(new Error("User cancelled"));
  const dispatch = vi.fn(async () => ({}));
  await expect(runWorkflowToolAgent({ toolName: "get_customer", signal: controller.signal }, dispatch)).rejects.toThrow("User cancelled");
  expect(dispatch).not.toHaveBeenCalled();
});

test("Pi forwards cancellation to the governed invocation and preserves its exact error", async () => {
  const controller = new AbortController(), failure = new Error("Original outcome unconfirmed");
  const dispatch = vi.fn(async (signal: AbortSignal) => {
    controller.abort(failure); expect(signal.aborted).toBe(true); throw failure;
  });
  await expect(runWorkflowToolAgent({ toolName: "create_customer", signal: controller.signal }, dispatch)).rejects.toBe(failure);
  expect(dispatch).toHaveBeenCalledOnce();
});

test("an acknowledged completion racing with cancellation remains the original receipt", async () => {
  const controller = new AbortController(), receipt = { acknowledged: true };
  const dispatch = vi.fn(async () => { controller.abort(); return receipt; });
  expect(await runWorkflowToolAgent({ toolName: "create_customer", signal: controller.signal }, dispatch)).toBe(receipt);
  expect(dispatch).toHaveBeenCalledOnce();
});
