import { Agent, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import { Type, createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { QueryMessage, QueryToolCall, QueryToolDefinition, QueryTurnResult } from "../analysisprovider/query-types.js";
import { assistantToolCallMessage, type ProviderContinuationSecret } from "../analysisprovider/provider-continuation.js";
import { combinedAgentSignal, piBridgeAssistantMessage, piBridgeModel, piJsonObject, piTranscriptMessages } from "../agent/pi-provider-bridge.js";
import { canonicalJSONBytes } from "../core/canonical-json.js";
import { withoutSecretFields } from "../redact/secrets.js";
import type { ToolDefinition } from "../registry/schemas.js";
import { mcpResultForModel } from "../tools/mcp-result.js";
import { hasReservedBridgeRole } from "../tools/erpbridge-contract.js";
import { validateToolInput } from "../tools/tool-input-schema.js";
import { validateValue } from "../structured-output/validate.js";
import { validateToolArguments } from "../agent/workflow-runtime-validator.js";
import { promptData, RUNTIME_AGENT_SYSTEM_PROMPT, RUNTIME_AGENT_RECOVERY_SYSTEM_PROMPT } from "../prompts/contracts.js";
import type { ProviderRuntime } from "../providers/runtime.js";
import type { OperationAgentCapability, OperationAgentNode } from "../workflows/compiled-read.js";

export const RUNTIME_AGENT_PROMPT_VERSION = "prompt/runtime-agent/v2";

export type RuntimeAgentFailureCode =
  | "AGENT_BUDGET_EXHAUSTED"
  | "AGENT_COMPLETION_UNMET"
  | "AGENT_OUTPUT_INVALID"
  | "AGENT_TOOL_DENIED"
  | "AGENT_USAGE_UNMEASURED";

export class RuntimeAgentKnownFailure extends Error {
  constructor(readonly code: RuntimeAgentFailureCode, message: string) { super(message); this.name = "RuntimeAgentKnownFailure"; }
}

export type RuntimeAgentHooks = {
  beforeModel(round: number, messages: readonly QueryMessage[]): Promise<void>;
  afterModel(round: number, turn: QueryTurnResult): Promise<void>;
  callTool(capability: OperationAgentCapability, tool: ToolDefinition, call: QueryToolCall, round: number, callIndex: number, signal: AbortSignal): Promise<Record<string, unknown>>;
  afterTool(capability: OperationAgentCapability, call: QueryToolCall, output: Record<string, unknown>, round: number, callIndex: number): Promise<void>;
};

export type RuntimeAgentResult = {
  output: Record<string, unknown>;
  rounds: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
};

/** Runs one reviewed runtime-agent node. It has no direct connector access:
 * every proposed call is handed to the caller's governed read gateway hook. */
export async function runRuntimeAgent(input: {
  node: OperationAgentNode;
  taskInput: unknown;
  runtime: ProviderRuntime;
  tools: readonly ToolDefinition[];
  hooks: RuntimeAgentHooks;
  workflowId: string;
  executionId: string;
  actor: { id: string; role: string };
  traceId?: string;
  signal?: AbortSignal;
}): Promise<RuntimeAgentResult> {
  const runtime = (process.env.LCWE_AGENT_RUNTIME ?? "pi").trim().toLowerCase();
  if (runtime === "legacy") return runLegacyRuntimeAgent(input);
  if (runtime !== "pi") throw new Error("LCWE_AGENT_RUNTIME must be pi or legacy");
  return runPiRuntimeAgent(input);
}

async function runPiRuntimeAgent(input: {
  node: OperationAgentNode;
  taskInput: unknown;
  runtime: ProviderRuntime;
  tools: readonly ToolDefinition[];
  hooks: RuntimeAgentHooks;
  workflowId: string;
  executionId: string;
  actor: { id: string; role: string };
  traceId?: string;
  signal?: AbortSignal;
}): Promise<RuntimeAgentResult> {
  const { node } = input, started = performance.now(), deadline = Date.now() + node.maxWallTimeMs;
  const timeoutSignal = AbortSignal.timeout(node.maxWallTimeMs);
  const signal = input.signal ? AbortSignal.any([input.signal, timeoutSignal]) : timeoutSignal;
  const provider = input.runtime.snapshot?.() ?? input.runtime;
  const bridgeModel = piBridgeModel("lcwe-governed-runtime", "LCWE governed runtime provider", node.maxOutputTokens);
  const offered = node.allowedCapabilities.map(capability => {
    const matches = input.tools.filter(tool => tool.tool_id === capability.toolId && tool.is_read_only &&
      (tool.name === capability.action || tool.mcp_tool_name === capability.remoteName));
    if (matches.length !== 1) throw new RuntimeAgentKnownFailure("AGENT_TOOL_DENIED", `Allowed capability ${capability.action} is unavailable`);
    return { capability, tool: matches[0]! };
  });
  const definitions: QueryToolDefinition[] = offered.map(({ capability, tool }) => ({ type: "function", function: {
    name: capability.remoteName, description: tool.description, parameters: structuredClone(tool.input_schema),
  } }));
  const continuationByCall = new Map<string, ProviderContinuationSecret>(), seen = new Set<string>();
  const callIndexes = new Map<number, number>();
  let attempts = 0, totalInput = 0, totalOutput = 0, toolCalls = 0, lastTurn: QueryTurnResult | undefined, fatal: unknown;
  const assertBudget = () => {
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Runtime agent cancelled");
    if (Date.now() >= deadline) throw new RuntimeAgentKnownFailure("AGENT_BUDGET_EXHAUSTED", "Runtime agent wall-time budget was exhausted");
    if (totalInput + totalOutput >= node.maxTotalTokens) throw new RuntimeAgentKnownFailure("AGENT_BUDGET_EXHAUSTED", "Runtime agent token budget was exhausted");
  };

  const piTools: AgentTool[] = [...new Set(definitions.map(definition => definition.function.name))].map(name => ({
    name,
    label: name,
    description: definitions.find(definition => definition.function.name === name)?.function.description ?? name,
    parameters: Type.Object({}, { additionalProperties: true }),
    executionMode: "sequential",
    replay: "never",
    execute: async (toolCallId, params, toolSignal) => {
      if (fatal) return { content: [{ type: "text", text: "Runtime agent already stopped" }], details: { status: "BLOCKED" }, isError: true, terminate: true };
      try {
        assertBudget();
        const round = Math.max(0, attempts - 1), callIndex = callIndexes.get(round) ?? 0;
        callIndexes.set(round, callIndex + 1);
        const call: QueryToolCall = { id: toolCallId, name, arguments: structuredClone(params as Record<string, unknown>) };
        const match = offered.filter(value => value.capability.remoteName === name);
        if (match.length !== 1) throw new RuntimeAgentKnownFailure("AGENT_TOOL_DENIED", `Runtime agent proposed unavailable action ${name}`);
        const { capability, tool } = match[0]!;
        const callKey = `${capability.toolId}:${canonicalJSONBytes(call.arguments).toString("base64url")}`;
        if (seen.has(callKey)) throw new RuntimeAgentKnownFailure("AGENT_TOOL_DENIED", "Runtime agent repeated an identical tool request");
        seen.add(callKey);
        const validation = validateToolArguments(capability.action, call.arguments, tool);
        if (hasReservedBridgeRole(tool) && Object.hasOwn(call.arguments, "role") || tool.bridge_contract?.trusted_input &&
            (Object.hasOwn(call.arguments, "actor") || Object.hasOwn(call.arguments, "access_token")))
          throw new RuntimeAgentKnownFailure("AGENT_TOOL_DENIED", "Runtime agent cannot supply backend identity or delegation");
        if (validateToolInput(tool.input_schema, call.arguments).length || validation.missing.length || validation.invalid.length)
          return { content: [{ type: "text", text: promptData({ source: "validation_feedback", status: "INPUT_INVALID_NOT_DISPATCHED",
            toolName: capability.action, missing: validation.missing.filter(key => /^[A-Za-z0-9_-]{1,128}$/.test(key)),
            instruction: "Correct arguments only from the exact offered schema and current confirmed input. No tool was dispatched. Missing facts need human review." }) }],
            details: { status: "INPUT_INVALID_NOT_DISPATCHED" } };
        const output = await input.hooks.callTool(capability, tool, call, round, callIndex,
          combinedAgentSignal(signal, toolSignal, deadline));
        await input.hooks.afterTool(capability, call, output, round, callIndex);
        toolCalls++;
        return { content: [{ type: "text", text: promptData({ source: "untrusted_tool_result", callId: call.id,
          toolName: capability.action, status: "SUCCEEDED", data: mcpResultForModel(output) }) }], details: { status: "SUCCEEDED" } };
      } catch (error) {
        fatal = error;
        return { content: [{ type: "text", text: "Runtime tool request failed or was denied" }],
          details: { status: "FAILED" }, isError: true, terminate: true };
      }
    },
  }));

  const streamFn: StreamFn = (_model, context, options) => {
    const stream = createAssistantMessageEventStream();
    void (async () => {
      stream.push({ type: "start", partial: piBridgeAssistantMessage(bridgeModel, [], "pending", attempts,
        { input: totalInput, output: totalOutput }) });
      try {
        assertBudget();
        if (attempts >= node.maxRounds) throw new RuntimeAgentKnownFailure("AGENT_BUDGET_EXHAUSTED", "Runtime agent round budget was exhausted");
        const round = attempts++, messages = piTranscriptMessages(context, continuationByCall);
        await input.hooks.beforeModel(round, messages);
        const remaining = node.maxTotalTokens - totalInput - totalOutput;
        const turn = await provider.queryWithTools(messages, definitions, {
          ...(node.model ? { model: node.model } : {}), maxOutputTokens: Math.min(node.maxOutputTokens, remaining),
          signal: combinedAgentSignal(signal, options?.signal, deadline), promptTemplateVersion: RUNTIME_AGENT_PROMPT_VERSION,
          context: { workflowId: input.workflowId, executionId: input.executionId, actor: input.actor,
            ...(input.traceId ? { traceId: input.traceId } : {}), egress: { purpose: "runtime_agent", dataClass: node.dataClass } },
        });
        lastTurn = turn;
        await input.hooks.afterModel(round, turn);
        if (turn.measured !== true) throw new RuntimeAgentKnownFailure("AGENT_USAGE_UNMEASURED", "Runtime agent provider did not return measurable token usage");
        totalInput += turn.inputTokens; totalOutput += turn.outputTokens;
        if (totalInput + totalOutput > node.maxTotalTokens)
          throw new RuntimeAgentKnownFailure("AGENT_BUDGET_EXHAUSTED", "Runtime agent token budget was exceeded");
        const validToolTurn = turn.stopReason === "tool_calls" && turn.toolCalls.length > 0;
        if (validToolTurn && toolCalls + turn.toolCalls.length > node.maxToolCalls)
          throw new RuntimeAgentKnownFailure("AGENT_BUDGET_EXHAUSTED", "Runtime agent tool-call budget was exhausted");
        if (validToolTurn && turn.providerContinuationSecret)
          for (const call of turn.toolCalls) continuationByCall.set(call.id, turn.providerContinuationSecret);
        const content: AssistantMessage["content"] = [
          ...(turn.text ? [{ type: "text" as const, text: turn.text }] : []),
          ...(validToolTurn ? turn.toolCalls.map(call => ({ type: "toolCall" as const, id: call.id, name: call.name,
            arguments: piJsonObject(call.arguments) })) : []),
        ];
        const stopReason = validToolTurn ? "toolUse" : turn.stopReason === "length" ? "length" : "stop";
        stream.push({ type: "done", reason: stopReason, message: piBridgeAssistantMessage(bridgeModel, content, stopReason, round,
          { input: turn.inputTokens, output: turn.outputTokens }, turn.model, turn.provider) });
      } catch (error) {
        fatal = error;
        const reason = signal.aborted ? "aborted" : "error";
        stream.push({ type: "error", reason, error: { ...piBridgeAssistantMessage(bridgeModel, [], reason,
          Math.max(0, attempts - 1), { input: totalInput, output: totalOutput }), errorMessage: "Runtime agent request did not complete" } });
      }
    })();
    return stream;
  };

  const agent = new Agent({
    initialState: { model: bridgeModel, systemPrompt: RUNTIME_AGENT_RECOVERY_SYSTEM_PROMPT, tools: piTools },
    streamFn,
    toolExecution: "sequential",
    sessionId: `${input.workflowId}:${input.executionId}`,
    beforeToolCall: async () => {
      if (fatal) return { block: true, reason: "Runtime agent already stopped", terminate: true };
      try { assertBudget(); }
      catch (error) { fatal = error; return { block: true, reason: "Runtime agent budget was exhausted", terminate: true }; }
    },
    finishTurn: async ({ message, toolResults }) => {
      if (!fatal && toolResults.some(result => result.isError))
        fatal = new RuntimeAgentKnownFailure("AGENT_TOOL_DENIED", "Runtime agent proposed an unavailable or invalid tool request");
      if (fatal) return { action: "end" };
      if (message.content.some(content => content.type === "toolCall") && attempts >= node.maxRounds) {
        fatal = new RuntimeAgentKnownFailure("AGENT_BUDGET_EXHAUSTED", "Runtime agent round budget was exhausted");
        return { action: "end" };
      }
    },
  });
  const abort = () => agent.abort();
  signal.addEventListener("abort", abort, { once: true });
  try {
    await agent.prompt({ role: "user", content: promptData({ TASK: node.instruction, INPUT: input.taskInput,
      OUTPUT_SCHEMA: node.outputSchema, COMPLETION_PREDICATE: node.completionPredicate }), timestamp: Date.now() });
  } finally {
    signal.removeEventListener("abort", abort);
  }
  if (fatal) throw fatal;
  if (!lastTurn || lastTurn.toolCalls.length > 0)
    throw new RuntimeAgentKnownFailure("AGENT_BUDGET_EXHAUSTED", "Runtime agent round budget was exhausted");
  const output = validateRuntimeCompletion(node, lastTurn);
  return { output, rounds: attempts, toolCalls, inputTokens: totalInput, outputTokens: totalOutput,
    latencyMs: Math.max(0, Math.round(performance.now() - started)) };
}

async function runLegacyRuntimeAgent(input: {
  node: OperationAgentNode;
  taskInput: unknown;
  runtime: ProviderRuntime;
  tools: readonly ToolDefinition[];
  hooks: RuntimeAgentHooks;
  workflowId: string;
  executionId: string;
  actor: { id: string; role: string };
  traceId?: string;
  signal?: AbortSignal;
}): Promise<RuntimeAgentResult> {
  const { node } = input, started = performance.now(), deadline = Date.now() + node.maxWallTimeMs;
  const timeoutSignal = AbortSignal.timeout(node.maxWallTimeMs), signal = input.signal ? AbortSignal.any([input.signal, timeoutSignal]) : timeoutSignal;
  const offered = node.allowedCapabilities.map(capability => {
    const matches = input.tools.filter(tool => tool.tool_id === capability.toolId && tool.is_read_only &&
      (tool.name === capability.action || tool.mcp_tool_name === capability.remoteName));
    if (matches.length !== 1) throw new RuntimeAgentKnownFailure("AGENT_TOOL_DENIED", `Allowed capability ${capability.action} is unavailable`);
    return { capability, tool: matches[0]! };
  });
  const definitions: QueryToolDefinition[] = offered.map(({ capability, tool }) => ({ type: "function", function: {
    name: capability.remoteName, description: tool.description, parameters: structuredClone(tool.input_schema),
  } }));
  const messages: QueryMessage[] = [
    { role: "system", content: RUNTIME_AGENT_SYSTEM_PROMPT },
    { role: "user", content: promptData({ TASK: node.instruction, INPUT: input.taskInput, OUTPUT_SCHEMA: node.outputSchema, COMPLETION_PREDICATE: node.completionPredicate }) },
  ];
  const seen = new Set<string>();
  let totalInput = 0, totalOutput = 0, toolCalls = 0;
  const assertBudget = () => {
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Runtime agent cancelled");
    if (Date.now() >= deadline) throw new RuntimeAgentKnownFailure("AGENT_BUDGET_EXHAUSTED", "Runtime agent wall-time budget was exhausted");
    if (totalInput + totalOutput >= node.maxTotalTokens) throw new RuntimeAgentKnownFailure("AGENT_BUDGET_EXHAUSTED", "Runtime agent token budget was exhausted");
  };
  for (let round = 0; round < node.maxRounds; round++) {
    assertBudget();
    await input.hooks.beforeModel(round, messages);
    const remaining = node.maxTotalTokens - totalInput - totalOutput;
    const turn = await input.runtime.queryWithTools(messages, definitions, {
      ...(node.model ? { model: node.model } : {}), maxOutputTokens: Math.min(node.maxOutputTokens, remaining), signal,
      promptTemplateVersion: "prompt/runtime-agent/v1",
      context: { workflowId: input.workflowId, executionId: input.executionId, actor: input.actor,
        ...(input.traceId ? { traceId: input.traceId } : {}), egress: { purpose: "runtime_agent", dataClass: node.dataClass } },
    });
    await input.hooks.afterModel(round, turn);
    if (turn.measured !== true) throw new RuntimeAgentKnownFailure("AGENT_USAGE_UNMEASURED", "Runtime agent provider did not return measurable token usage");
    totalInput += turn.inputTokens; totalOutput += turn.outputTokens;
    if (totalInput + totalOutput > node.maxTotalTokens) throw new RuntimeAgentKnownFailure("AGENT_BUDGET_EXHAUSTED", "Runtime agent token budget was exceeded");
    if (turn.toolCalls.length === 0) {
      if (turn.stopReason !== "stop" || !turn.text.trim()) throw new RuntimeAgentKnownFailure("AGENT_OUTPUT_INVALID", "Runtime agent did not return a complete structured response");
      let decoded: unknown;
      try { decoded = JSON.parse(turn.text); } catch { throw new RuntimeAgentKnownFailure("AGENT_OUTPUT_INVALID", "Runtime agent output was not valid JSON"); }
      const safe = withoutSecretFields(decoded), errors = validateValue(node.outputSchema, safe);
      if (errors.length || !safe || typeof safe !== "object" || Array.isArray(safe) || canonicalJSONBytes(safe).length > 1_000_000)
        throw new RuntimeAgentKnownFailure("AGENT_OUTPUT_INVALID", errors.join("; ") || "Runtime agent output exceeded supported bounds");
      let selected: unknown = safe;
      for (const part of node.completionPredicate.path) {
        if (!selected || typeof selected !== "object" || Array.isArray(selected) || !Object.hasOwn(selected, part))
          throw new RuntimeAgentKnownFailure("AGENT_COMPLETION_UNMET", "Runtime agent output did not satisfy its reviewed completion predicate");
        selected = (selected as Record<string, unknown>)[part];
      }
      if (!Object.is(selected, node.completionPredicate.equals))
        throw new RuntimeAgentKnownFailure("AGENT_COMPLETION_UNMET", "Runtime agent output did not satisfy its reviewed completion predicate");
      return { output: safe as Record<string, unknown>, rounds: round + 1, toolCalls, inputTokens: totalInput, outputTokens: totalOutput,
        latencyMs: Math.max(0, Math.round(performance.now() - started)) };
    }
    if (turn.stopReason !== "tool_calls") throw new RuntimeAgentKnownFailure("AGENT_OUTPUT_INVALID", "Runtime agent returned tool calls with an invalid stop reason");
    if (toolCalls + turn.toolCalls.length > node.maxToolCalls) throw new RuntimeAgentKnownFailure("AGENT_BUDGET_EXHAUSTED", "Runtime agent tool-call budget was exhausted");
    messages.push(assistantToolCallMessage(turn));
    for (const [callIndex, call] of turn.toolCalls.entries()) {
      assertBudget();
      const match = offered.filter(value => value.capability.remoteName === call.name);
      if (match.length !== 1) throw new RuntimeAgentKnownFailure("AGENT_TOOL_DENIED", `Runtime agent proposed unavailable action ${call.name}`);
      const { capability, tool } = match[0]!, callKey = `${capability.toolId}:${canonicalJSONBytes(call.arguments).toString("base64url")}`;
      if (seen.has(callKey)) throw new RuntimeAgentKnownFailure("AGENT_TOOL_DENIED", "Runtime agent repeated an identical tool request");
      seen.add(callKey);
      const validation = validateToolArguments(capability.action, call.arguments, tool);
      if (validateToolInput(tool.input_schema, call.arguments).length || validation.missing.length || validation.invalid.length || hasReservedBridgeRole(tool) && Object.hasOwn(call.arguments, "role"))
        throw new RuntimeAgentKnownFailure("AGENT_TOOL_DENIED", `Runtime agent proposed invalid arguments for ${capability.action}`);
      const output = await input.hooks.callTool(capability, tool, call, round, callIndex, signal);
      await input.hooks.afterTool(capability, call, output, round, callIndex);
      toolCalls++;
      messages.push({ role: "tool", tool_call_id: call.id, content: promptData({ source: "untrusted_tool_result", callId: call.id, toolName: capability.action,
        status: "SUCCEEDED", data: mcpResultForModel(output) }) });
    }
  }
  throw new RuntimeAgentKnownFailure("AGENT_BUDGET_EXHAUSTED", "Runtime agent round budget was exhausted");
}

function validateRuntimeCompletion(node: OperationAgentNode, turn: QueryTurnResult): Record<string, unknown> {
  if (turn.stopReason !== "stop" || !turn.text.trim())
    throw new RuntimeAgentKnownFailure("AGENT_OUTPUT_INVALID", "Runtime agent did not return a complete structured response");
  let decoded: unknown;
  try { decoded = JSON.parse(turn.text); }
  catch { throw new RuntimeAgentKnownFailure("AGENT_OUTPUT_INVALID", "Runtime agent output was not valid JSON"); }
  const safe = withoutSecretFields(decoded), errors = validateValue(node.outputSchema, safe);
  if (errors.length || !safe || typeof safe !== "object" || Array.isArray(safe) || canonicalJSONBytes(safe).length > 1_000_000)
    throw new RuntimeAgentKnownFailure("AGENT_OUTPUT_INVALID", errors.join("; ") || "Runtime agent output exceeded supported bounds");
  let selected: unknown = safe;
  for (const part of node.completionPredicate.path) {
    if (!selected || typeof selected !== "object" || Array.isArray(selected) || !Object.hasOwn(selected, part))
      throw new RuntimeAgentKnownFailure("AGENT_COMPLETION_UNMET", "Runtime agent output did not satisfy its reviewed completion predicate");
    selected = (selected as Record<string, unknown>)[part];
  }
  if (!Object.is(selected, node.completionPredicate.equals))
    throw new RuntimeAgentKnownFailure("AGENT_COMPLETION_UNMET", "Runtime agent output did not satisfy its reviewed completion predicate");
  return safe as Record<string, unknown>;
}
