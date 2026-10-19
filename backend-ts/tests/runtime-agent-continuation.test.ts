import { expect, test, vi } from "vitest";
import { runRuntimeAgent, type RuntimeAgentHooks } from "../src/runner/runtime-agent.js";
import { OpenAICompatibleClient } from "../src/providers/openai-compatible.js";
import type { ProviderRuntime } from "../src/providers/runtime.js";
import type { OperationAgentNode } from "../src/workflows/compiled-read.js";
import { protectedSimulationRead as read } from "./fixtures/protected-simulation.js";
import { exactBridgeName } from "../src/tools/erpbridge-contract.js";
import { capabilityContractHash } from "../src/registry/capability-admission.js";

function recoveryNode(): OperationAgentNode {
  const contractHash = capabilityContractHash(read);
  return { id: "agent", kind: "agent", instruction: "Verify the supplied record and return complete", input: { kind: "ref", source: "workflowInput", path: [] },
    allowedCapabilities: [{ toolId: read.tool_id, action: read.name, remoteName: exactBridgeName(read), contractHash,
      admission: { connectionId: "fixture", capabilityId: "capability", revisionId: "revision", admissionVersion: 1, contractHash } }],
    outputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
    completionPredicate: { path: ["text"], equals: "complete" }, model: "fixture-model", dataClass: "restricted", maxInputChars: 20000,
    maxInputItems: 200, maxOutputTokens: 1024, maxTotalTokens: 4096, maxRounds: 4, maxToolCalls: 4, maxWallTimeMs: 30000 };
}
const turn = (args?: Record<string, unknown>, id = "call") => ({ text: args ? "" : '{"text":"complete"}', stopReason: args ? "tool_calls" : "stop",
  toolCalls: args ? [{ id, name: exactBridgeName(read), arguments: args }] : [], measured: true, inputTokens: 10, outputTokens: 10, model: "fixture" });

test("runtime Pi corrects an invalid argument before dispatch using the same reviewed tool and input", async () => {
  const queryWithTools = vi.fn().mockResolvedValueOnce(turn({})).mockResolvedValueOnce(turn({ id: "A" }, "corrected")).mockResolvedValueOnce(turn());
  const callTool = vi.fn<RuntimeAgentHooks["callTool"]>(async () => ({ content: [], structuredContent: { text: "Verified A" } }));
  const result = await runRuntimeAgent({ node: recoveryNode(), taskInput: { id: "A" }, runtime: { queryWithTools } as unknown as ProviderRuntime, tools: [read],
    workflowId: "flow", executionId: "run", actor: { id: "owner", role: "admin" },
    hooks: { beforeModel: async () => {}, afterModel: async () => {}, callTool, afterTool: async () => {} } });
  expect(result).toMatchObject({ output: { text: "complete" }, rounds: 3, toolCalls: 1 });
  expect(callTool).toHaveBeenCalledTimes(1); expect(callTool.mock.calls[0]?.[2]).toMatchObject({ arguments: { id: "A" } });
  expect(JSON.stringify(queryWithTools.mock.calls[1]?.[0])).toContain("INPUT_INVALID_NOT_DISPATCHED");
});

test.each(["repeated invalid", "remote outcome unknown"])("runtime correction cannot replay %s", async scenario => {
  const queryWithTools = vi.fn().mockResolvedValueOnce(turn(scenario === "repeated invalid" ? {} : { id: "A" }))
    .mockResolvedValueOnce(turn({}, "again"));
  const callTool = vi.fn(async () => { throw new Error("Remote outcome unknown"); });
  await expect(runRuntimeAgent({ node: recoveryNode(), taskInput: { id: "A" }, runtime: { queryWithTools } as unknown as ProviderRuntime, tools: [read],
    workflowId: "flow", executionId: "run", actor: { id: "owner", role: "admin" },
    hooks: { beforeModel: async () => {}, afterModel: async () => {}, callTool, afterTool: async () => {} } })).rejects.toThrow();
  expect(callTool).toHaveBeenCalledTimes(scenario === "repeated invalid" ? 0 : 1);
  expect(queryWithTools).toHaveBeenCalledTimes(scenario === "repeated invalid" ? 2 : 1);
});

test("ordinary runtime agent echoes private continuation in the next model round but not its public answer/hooks events", async () => {
  const contractHash = capabilityContractHash(read), details = [{ type: "reasoning.encrypted", data: "private-agent-marker==", signature: "opaque==" }];
  const node: OperationAgentNode = { id: "agent", kind: "agent", instruction: "Read once and return complete", input: { kind: "ref", source: "workflowInput", path: [] },
    allowedCapabilities: [{ toolId: read.tool_id, action: read.name, remoteName: exactBridgeName(read), contractHash,
      admission: { connectionId: "fixture", capabilityId: "capability", revisionId: "revision", admissionVersion: 1, contractHash } }],
    outputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
    completionPredicate: { path: ["text"], equals: "complete" }, model: "fixture-model", dataClass: "restricted", maxInputChars: 20000,
    maxInputItems: 200, maxOutputTokens: 1024, maxTotalTokens: 4096, maxRounds: 4, maxToolCalls: 4, maxWallTimeMs: 30000 };
  const send = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ choices: [{ finish_reason: "tool_calls", message: { content: null,
    reasoning_details: details, tool_calls: [{ id: "call-A", type: "function", function: { name: exactBridgeName(read), arguments: '{"id":"A"}' } }] } }], usage: { prompt_tokens: 11, completion_tokens: 7 } }))
    .mockResolvedValueOnce(Response.json({ choices: [{ finish_reason: "stop", message: { content: '{"text":"complete"}' } }], usage: { prompt_tokens: 5, completion_tokens: 3 } }));
  const client = new OpenAICompatibleClient({ baseURL: "https://model.example.invalid/v1", model: node.model!, apiKey: "fixture-only", fetchImplementation: send });
  const callTool = vi.fn(async () => ({ content: [], structuredContent: { text: "Verified A" } }));
  const afterTool = vi.fn(async () => {}), afterModel = vi.fn(async () => {});
  const result = await runRuntimeAgent({ node, taskInput: {}, runtime: { queryWithTools: client.queryWithTools.bind(client) } as unknown as ProviderRuntime,
    tools: [structuredClone(read)], workflowId: "flow", executionId: "run", actor: { id: "owner", role: "admin" },
    hooks: { beforeModel: async () => {}, afterModel, callTool, afterTool } });
  expect(result.output).toEqual({ text: "complete" }); expect(callTool).toHaveBeenCalledTimes(1);
  const wire = JSON.parse(String(send.mock.calls[1]![1]!.body));
  expect(wire.messages[2].reasoning_details).toEqual(details); expect(wire.messages[3].tool_call_id).toBe("call-A");
  expect(JSON.stringify(result)).not.toMatch(/private-agent-marker|providerContinuationSecret|reasoning_details/);
  expect(JSON.stringify(afterTool.mock.calls)).not.toContain("private-agent-marker");
  // The internal afterModel hook receives the turn; production hooks must not
  // publish that private object. Public operation events are tested separately.
  expect(afterModel).toHaveBeenCalledTimes(2);
});
