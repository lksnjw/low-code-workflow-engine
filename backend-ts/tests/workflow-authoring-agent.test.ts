import { systemInstructionsFor } from "../src/prompts/contracts.js";
import { expect, test, vi } from "vitest";
import { runWorkflowAuthoringAgent } from "../src/agent/workflow-authoring-agent.js";
import type { AnalysisResponse } from "../src/analysisprovider/types.js";

const result: AnalysisResponse = { text: "name: Reusable customer\nsteps: []", model: "selected-model", provider: "configured-provider", inputTokens: 17, outputTokens: 11, measured: true };
test("Pi owns one bounded authoring turn while preserving the exact provider output and full catalog prompt", async () => {
  const prompt = JSON.stringify({ USER_REQUEST: "Create a reusable customer workflow", TOOL_REGISTRY_JSON: [{ name: "get_customer_group" }, { name: "get_territory" }, { name: "create_customer" }] });
  const invoke = vi.fn(async signal => { expect(signal).toBeInstanceOf(AbortSignal); expect(signal.aborted).toBe(false); return result; });
  expect(await runWorkflowAuthoringAgent({ prompt, version: "prompt/candidate/v24" }, invoke)).toBe(result);
  expect(invoke).toHaveBeenCalledOnce();
});
test("provider failure is propagated without replaying authoring or inventing a saved workflow", async () => {
  const failure = new Error("Original provider acknowledgement unknown"), invoke = vi.fn(async () => { throw failure; });
  await expect(runWorkflowAuthoringAgent({ prompt: "draft", version: "prompt/workflow-modifier/v5" }, invoke)).rejects.toBe(failure);
  expect(invoke).toHaveBeenCalledOnce();
});
test("cancellation reaches the original inference and prevents returning a late draft", async () => {
  const controller = new AbortController();
  const invoke = vi.fn(async signal => { controller.abort(); expect(signal.aborted).toBe(true); return result; });
  await expect(runWorkflowAuthoringAgent({ prompt: "draft", version: "prompt/candidate/v24", signal: controller.signal }, invoke)).rejects.toThrow();
  expect(invoke).toHaveBeenCalledOnce();
});
test("pre-cancelled or unrelated prompt contracts cannot enter the authoring provider", async () => {
  const invoke = vi.fn(async () => result), signal = AbortSignal.abort();
  await expect(runWorkflowAuthoringAgent({ prompt: "draft", version: "prompt/candidate/v24", signal }, invoke)).rejects.toThrow();
  await expect(runWorkflowAuthoringAgent({ prompt: "draft", version: "prompt/action/v2" }, invoke)).rejects.toThrow("Unsupported workflow authoring");
  expect(invoke).not.toHaveBeenCalled();
});


test("active authoring prompt uses exact output bindings and treats Start preparation as backend work", async () => {
  const { systemInstructionsFor } = await import("../src/prompts/contracts.js");
  const { CANDIDATE_PROMPT_VERSION } = await import("../src/providers/runtime.js");
  const prompt = systemInstructionsFor(CANDIDATE_PROMPT_VERSION);
  expect(prompt).toContain("SINGLE START AND REQUIRED INPUTS");
  expect(prompt).toContain("RUNTIME_SAFEGUARDS_JSON.auditJournalActions");
  expect(prompt).not.toContain("Tool output references must include structuredContent;");
  expect(prompt).not.toContain("Tool/model output references include structuredContent and select a declared compatible field.");
});


test("current generation binds exposed schemas and delegates saved execution without treating draft notes as authority", async () => {
  const { CANDIDATE_PROMPT_VERSION } = await import("../src/providers/runtime.js");
  const prompt = systemInstructionsFor(CANDIDATE_PROMPT_VERSION);
  expect(prompt).toContain("EXPOSED TOOLS AND AGENT EXECUTION");
  expect(prompt).toContain("never create a tool");
  expect(prompt).toContain("Pi owns the saved workflow execution turn");
  expect(prompt).toContain("not a blanket execution prohibition");
  expect(prompt).toContain("human approval checkpoints remain observable and authoritative");
  expect(systemInstructionsFor("prompt/candidate/v27")).not.toContain("EXPOSED TOOLS AND AGENT EXECUTION");
});
