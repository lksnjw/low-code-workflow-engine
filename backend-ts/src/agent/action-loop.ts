import { Agent, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import { libraryModelInputSchema } from "../documents/library-client.js";
import { Type, createAssistantMessageEventStream, type AssistantMessage, type Message } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "../registry/schemas.js";
import type { ProviderRuntime } from "../providers/runtime.js";
import type { QueryMessage, QueryModelRouting, QueryToolDefinition } from "../analysisprovider/query-types.js";
import { assistantToolCallMessage, type ProviderContinuationSecret } from "../analysisprovider/provider-continuation.js";
import type { GovernanceUser } from "../governance/gate.js";
import { validateToolArguments } from "./workflow-runtime-validator.js";
import { ERP_ACTION_SYSTEM_PROMPT, promptData } from "../prompts/contracts.js";
import type { ChatWorkspaceStatus } from "./chat-workspace-status.js";
import { validateToolInput } from "../tools/tool-input-schema.js";
import { hasReservedBridgeRole } from "../tools/erpbridge-contract.js";
import { mcpResultForModel } from "../tools/mcp-result.js";
import { acknowledgedReadToolFailure } from "../tools/read-tool-broker.js";
import { combinedAgentSignal, piBridgeAssistantMessage, piBridgeModel, piJsonObject, piTranscriptMessages } from "./pi-provider-bridge.js";
import { ToolProposalCorrector, type ToolProposalCorrection } from "./tool-proposal-correction.js";

export type GovernanceCheck = (
  toolName: string,
  toolDef: ToolDefinition,
  args: Record<string, unknown>,
  user: GovernanceUser,
  context: { traceId?: string; sessionId?: string },
) => Promise<{ allowed: boolean; reason?: string }>;

export type ActionStep = {
  toolName: string;
  displayName: string;
  arguments: Record<string, unknown>;
  result: unknown;
  isReadOnly: boolean;
  governanceStatus: "allowed" | "blocked" | "skipped";
  governanceReason?: string;
  error?: string;
  startedAt: string;
  completedAt: string;
};

export type ActionLoopInput = {
  userMessage: string;
  chatHistory: Array<{ role: string; text: string }>;
  sessionId: string;
  actorId: string;
  actorRole: string;
  workspaceStatus?: ChatWorkspaceStatus;
  user: GovernanceUser;
  signal?: AbortSignal;
  traceId?: string;
  onTurn?: (iteration: number) => Promise<void>;
};

export type ActionLoopResult = {
  text: string;
  steps: ActionStep[];
  blocked: boolean;
  workflowYaml: string;
  totalTokens: { input: number; output: number; measured?: boolean };
  latencyMs: number;
  modelRouting?: QueryModelRouting;
  proposalCorrections?: ToolProposalCorrection[];
};

const MAX_ITERATIONS = parseInt(process.env.ACTION_AGENT_MAX_ITERATIONS ?? "12", 10);
const TIMEOUT_MS = parseInt(process.env.ACTION_AGENT_TIMEOUT_MS ?? "120000", 10);
const TOKEN_BUDGET = parseInt(process.env.ACTION_AGENT_TOKEN_BUDGET ?? "16000", 10);
const PI_ACTION_MODEL = piBridgeModel("lcwe-governed-action", "LCWE governed action provider", TOKEN_BUDGET);

const SYSTEM_PROMPT = ERP_ACTION_SYSTEM_PROMPT;

/*******************************************************************************
 * Function: runActionLoop
 *
 * Runs the chat action loop and records tool steps and governance outcomes.
 ******************************************************************************/
export async function runActionLoop(
  input: ActionLoopInput,
  allTools: readonly ToolDefinition[],
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>,
  checkGovernance: GovernanceCheck,
  providerRuntime: ProviderRuntime,
): Promise<ActionLoopResult> {
  const runtime = (process.env.LCWE_AGENT_RUNTIME ?? "pi").trim().toLowerCase();
  if (runtime === "legacy") return runLegacyActionLoop(input, allTools, callTool, checkGovernance, providerRuntime);
  if (runtime !== "pi") throw new Error("LCWE_AGENT_RUNTIME must be pi or legacy");
  return runPiActionLoop(input, allTools, callTool, providerRuntime);
}

/** Pi owns turn scheduling and tool-result continuation; LCWE remains the
 * authority for provider routing, admission, validation and dispatch. */
async function runPiActionLoop(
  input: ActionLoopInput,
  allTools: readonly ToolDefinition[],
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>,
  providerRuntime: ProviderRuntime,
): Promise<ActionLoopResult> {
  const started = performance.now();
  const provider = providerRuntime.snapshot?.() ?? providerRuntime;
  const admitted = allTools.filter(tool => tool.is_read_only);
  const definitions: QueryToolDefinition[] = admitted.map(tool => ({ type: "function", function: {
    name: tool.mcp_tool_name.trim() || tool.name,
    description: `[READ] ${tool.description}`,
    parameters: libraryModelInputSchema(tool),
  } }));
  const steps: ActionStep[] = [];
  const corrector = new ToolProposalCorrector(admitted);
  const handledCallIds = new Set<string>();
  const continuationByCall = new Map<string, ProviderContinuationSecret>();
  const totalTokens = { input: 0, output: 0, measured: true };
  const deadline = Date.now() + TIMEOUT_MS;
  let attempts = 0, lastText = "", blocked = false, modelRouting: QueryModelRouting | undefined;
  let halt: "CANCELLED" | "PROVIDER_FAILED" | "LIMIT_REACHED" | "TOOL_FAILED" | undefined;

  const stopWithoutDispatch = (toolCallId: string) => {
    handledCallIds.add(toolCallId);
    return { content: [{ type: "text" as const, text: "Read operation already stopped" }], details: { status: "BLOCKED" }, isError: true, terminate: true };
  };
  const piTools: AgentTool[] = [...new Set(definitions.map(definition => definition.function.name))].map(name => ({
    name,
    label: name,
    description: definitions.find(definition => definition.function.name === name)?.function.description ?? name,
    parameters: Type.Object({}, { additionalProperties: true }),
    executionMode: "sequential",
    replay: "never",
    execute: async (toolCallId, params) => {
      if (halt || blocked) return stopWithoutDispatch(toolCallId);
      handledCallIds.add(toolCallId);
      const args = structuredClone(params as Record<string, unknown>), stepStartedAt = new Date().toISOString();
      const matches = allTools.filter(tool => (tool.mcp_tool_name.trim() || tool.name) === name);
      const toolDef = matches.length === 1 ? matches[0] : undefined;
      const isReadOnly = toolDef?.is_read_only === true;
      const displayName = toolDef?.display_name ?? humanizeName(name);
      const validation = validateToolArguments(name, args, toolDef);
      if (!toolDef || validation.missing.length || validation.invalid.length || validateToolInput(toolDef.input_schema, args).length ||
          hasReservedBridgeRole(toolDef) && Object.hasOwn(args, "role") || !isReadOnly) {
        const reason = toolDef && !isReadOnly
          ? "Live ERP writes are blocked until transaction approval, idempotency and recovery are enforced"
          : toolDef ? "Tool arguments failed runtime validation" : "Tool is not admitted";
        steps.push({ toolName: name, displayName, arguments: redactCredentials(args), result: null, isReadOnly,
          governanceStatus: "blocked", governanceReason: reason, error: reason, startedAt: stepStartedAt, completedAt: new Date().toISOString() });
        blocked = true; halt = "TOOL_FAILED"; lastText = reason;
        return { content: [{ type: "text" as const, text: reason }], details: { status: "BLOCKED" }, isError: true, terminate: true };
      }
      try {
        const raw = await callTool(name, args);
        steps.push({ toolName: name, displayName, arguments: redactCredentials(args), result: raw, isReadOnly: true,
          governanceStatus: "skipped", startedAt: stepStartedAt, completedAt: new Date().toISOString() });
        if (input.signal?.aborted) { blocked = true; halt = "CANCELLED"; lastText = "Read operation cancelled. No new ERP change was performed."; }
        return { content: [{ type: "text" as const, text: promptData({ source: "untrusted_tool_result", callId: toolCallId,
          toolName: name, status: "SUCCEEDED", data: mcpResultForModel(raw) }) }], details: { status: "SUCCEEDED" } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        steps.push({ toolName: name, displayName, arguments: redactCredentials(args), result: acknowledgedReadToolFailure(error)?.result ?? null,
          isReadOnly: true, governanceStatus: "skipped", error: message, startedAt: stepStartedAt, completedAt: new Date().toISOString() });
        blocked = true; halt = "TOOL_FAILED"; lastText = "Tool operation failed; review is required";
        return { content: [{ type: "text" as const, text: promptData({ source: "untrusted_tool_result", callId: toolCallId,
          toolName: name, status: "FAILED", error: message }) }], details: { status: "FAILED" }, isError: true, terminate: true };
      }
    },
  }));

  const streamFn: StreamFn = (_model, context, options) => {
    const stream = createAssistantMessageEventStream();
    void (async () => {
      stream.push({ type: "start", partial: piBridgeAssistantMessage(PI_ACTION_MODEL, [], "pending", attempts, totalTokens) });
      try {
        let messages = piTranscriptMessages(context, continuationByCall);
        for (;;) {
        if (input.signal?.aborted) { halt = "CANCELLED"; blocked = true; throw new Error("cancelled"); }
        if (attempts >= MAX_ITERATIONS || Date.now() > deadline || totalTokens.output >= TOKEN_BUDGET) {
          halt = "LIMIT_REACHED"; blocked = true; throw new Error("limit reached");
        }
        const iteration = attempts++;
        await input.onTurn?.(iteration);
        const turn = await provider.queryWithTools(messages, definitions, {
          allowFallback: true,
          maxOutputTokens: Math.max(1, TOKEN_BUDGET - totalTokens.output),
          promptTemplateVersion: "prompt/action/v5",
          context: { sessionId: input.sessionId, actor: { id: input.actorId, role: input.actorRole }, ...(input.traceId ? { traceId: input.traceId } : {}),
            egress: { purpose: "interactive", dataClass: "restricted" } },
          signal: combinedAgentSignal(input.signal, options?.signal, deadline),
        });
        lastText = turn.text; modelRouting = turn.modelRouting ?? modelRouting;
        totalTokens.input += turn.inputTokens; totalTokens.output += turn.outputTokens;
        totalTokens.measured = totalTokens.measured && turn.measured === true;
        if (input.signal?.aborted) { halt = "CANCELLED"; blocked = true; }
        // A known write is not a misspelled read proposal and must still stop.
        const requestsWrite = turn.toolCalls.some(call => allTools.some(tool => !tool.is_read_only && (tool.mcp_tool_name.trim() || tool.name) === call.name));
        const feedback = !halt && !requestsWrite ? corrector.feedback(turn, Date.now() <= deadline && totalTokens.output < TOKEN_BUDGET && attempts < MAX_ITERATIONS) : undefined;
        if (corrector.blocked) { halt = "TOOL_FAILED"; blocked = true; lastText = "Input correction changed concrete values or scope. Review is required; no corrected call was dispatched."; throw new Error("Proposal scope changed"); }
        if (feedback) { messages = [...messages, ...feedback]; continue; }
        const validToolTurn = !halt && turn.stopReason === "tool_calls" && turn.toolCalls.length > 0;
        if (validToolTurn && turn.providerContinuationSecret)
          for (const call of turn.toolCalls) continuationByCall.set(call.id, turn.providerContinuationSecret);
        const content: AssistantMessage["content"] = [
          ...(turn.text ? [{ type: "text" as const, text: turn.text }] : []),
          ...(validToolTurn ? turn.toolCalls.map(call => ({ type: "toolCall" as const, id: call.id, name: call.name, arguments: piJsonObject(call.arguments) })) : []),
        ];
        const stopReason = validToolTurn ? "toolUse" : turn.stopReason === "length" ? "length" : "stop";
        stream.push({ type: "done", reason: stopReason, message: piBridgeAssistantMessage(PI_ACTION_MODEL, content, stopReason, iteration,
          { input: turn.inputTokens, output: turn.outputTokens }, turn.model, turn.provider) });
        break;
        }
      } catch {
        if (!halt) halt = input.signal?.aborted ? "CANCELLED" : "PROVIDER_FAILED";
        if (halt === "CANCELLED") blocked = true;
        totalTokens.measured = halt === "LIMIT_REACHED" ? totalTokens.measured : false;
        const reason = halt === "CANCELLED" ? "aborted" : "error";
        stream.push({ type: "error", reason, error: { ...piBridgeAssistantMessage(PI_ACTION_MODEL, [], reason,
          Math.max(0, attempts - 1), totalTokens), errorMessage: "Action agent request did not complete" } });
      }
    })();
    return stream;
  };

  const history: Message[] = input.chatHistory.slice(-10).map((message, index) => message.role === "assistant"
    ? piBridgeAssistantMessage(PI_ACTION_MODEL, [{ type: "text", text: promptData({ source: "untrusted_history", text: message.text }) }],
      "stop", index, { input: 0, output: 0 }, "history", "lcwe")
    : { role: "user", content: promptData({ source: "untrusted_history", text: message.text }), timestamp: Date.now() + index });
  const agent = new Agent({
    initialState: { model: PI_ACTION_MODEL, systemPrompt: SYSTEM_PROMPT, tools: piTools, messages: history },
    streamFn,
    toolExecution: "sequential",
    sessionId: input.sessionId,
    beforeToolCall: async () => {
      if (halt || blocked) return { block: true, reason: "Read operation already stopped", terminate: true };
      if (input.signal?.aborted) { halt = "CANCELLED"; blocked = true; return { block: true, reason: "Read operation cancelled", terminate: true }; }
      if (Date.now() > deadline || totalTokens.output >= TOKEN_BUDGET) {
        halt = "LIMIT_REACHED"; blocked = true; return { block: true, reason: "Read operation reached its configured limit", terminate: true };
      }
    },
    finishTurn: async ({ message, toolResults }) => {
      const failed = toolResults.find(result => result.isError);
      if (failed && !blocked) {
        const call = message.content.find(content => content.type === "toolCall" && content.id === failed.toolCallId);
        if (call?.type === "toolCall" && !handledCallIds.has(call.id)) {
          handledCallIds.add(call.id);
          const matches = allTools.filter(tool => (tool.mcp_tool_name.trim() || tool.name) === call.name);
          const toolDef = matches.length === 1 ? matches[0] : undefined;
          const isReadOnly = toolDef?.is_read_only === true;
          const reason = toolDef && !isReadOnly
            ? "Live ERP writes are blocked until transaction approval, idempotency and recovery are enforced"
            : "Tool is not admitted";
          const timestamp = new Date().toISOString();
          steps.push({ toolName: call.name, displayName: toolDef?.display_name ?? humanizeName(call.name),
            arguments: redactCredentials(call.arguments as Record<string, unknown>), result: null, isReadOnly,
            governanceStatus: "blocked", governanceReason: reason, error: reason, startedAt: timestamp, completedAt: timestamp });
          lastText = reason;
        }
        blocked = true; halt = "TOOL_FAILED";
      }
      if (halt || blocked) return { action: "end" };
      if (message.content.some(content => content.type === "toolCall") && attempts >= MAX_ITERATIONS) {
        halt = "LIMIT_REACHED"; blocked = true; return { action: "end" };
      }
    },
  });
  const abort = () => agent.abort();
  input.signal?.addEventListener("abort", abort, { once: true });
  try {
    if (input.signal?.aborted) { blocked = true; halt = "CANCELLED"; }
    else await agent.prompt({ role: "user", content: promptData({ USER_REQUEST: input.userMessage,
      ...(input.workspaceStatus ? { CURRENT_WORKSPACE_STATUS_JSON: input.workspaceStatus } : {}) }), timestamp: Date.now() });
  } catch (error) {
    throw attachPartialSteps(error, steps);
  } finally {
    input.signal?.removeEventListener("abort", abort);
  }
  if (halt === "PROVIDER_FAILED") throw attachPartialSteps(new Error("Action agent provider request failed"), steps);
  if (halt === "CANCELLED") lastText = "Read operation cancelled. No new ERP change was performed.";
  if (halt === "LIMIT_REACHED") lastText = "Read operation stopped at cancellation or a configured limit.";
  return { text: lastText, steps, blocked, workflowYaml: buildWorkflowYaml(steps, input.userMessage), totalTokens,
    ...(corrector.events.length ? { proposalCorrections: corrector.events } : {}),
    latencyMs: Math.max(0, Math.round(performance.now() - started)), ...(modelRouting ? { modelRouting } : {}) };
}

async function runLegacyActionLoop(
  input: ActionLoopInput,
  allTools: readonly ToolDefinition[],
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>,
  _checkGovernance: GovernanceCheck,
  providerRuntime: ProviderRuntime,
): Promise<ActionLoopResult> {
  const started = performance.now();
  const provider = providerRuntime.snapshot?.() ?? providerRuntime;
  let modelRouting: QueryModelRouting | undefined;

  const agentTools: QueryToolDefinition[] = allTools.filter((tool) => tool.is_read_only).map((tool) => ({
    type: "function",
    function: {
      name: tool.mcp_tool_name.trim() || tool.name,
      description: `[${tool.is_read_only ? "READ" : "WRITE"}] ${tool.description}`,
      parameters: libraryModelInputSchema(tool),
    },
  }));

  const messages: QueryMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...input.chatHistory.slice(-10).map((m) => ({
      role: (m.role === "user" || m.role === "assistant" ? m.role : "user") as QueryMessage["role"],
      content: promptData({ source: "untrusted_history", text: m.text }),
    })),
    { role: "user", content: promptData({ USER_REQUEST: input.userMessage, ...(input.workspaceStatus ? { CURRENT_WORKSPACE_STATUS_JSON: input.workspaceStatus } : {}) }) },
  ];

  const steps: ActionStep[] = [];
  const totalTokens = { input: 0, output: 0, measured: true };
  let lastText = "";
  let blocked = false;
  const deadline = Date.now() + TIMEOUT_MS;

  try {
  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    if (input.signal?.aborted) { blocked = true; lastText = "Read operation cancelled. No new ERP change was performed."; break; }
    if (Date.now() > deadline || totalTokens.output >= TOKEN_BUDGET) break;

    await input.onTurn?.(iteration);
    const turn = await provider.queryWithTools(messages, agentTools, {
      allowFallback: true,
      maxOutputTokens: TOKEN_BUDGET - totalTokens.output,
      promptTemplateVersion: "prompt/action/v5",
      context: { sessionId: input.sessionId, actor: { id: input.actorId, role: input.actorRole }, ...(input.traceId ? { traceId: input.traceId } : {}),
        egress: { purpose: "interactive", dataClass: "restricted" } },
      signal: input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(Math.max(1, deadline - Date.now()))]) : AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    });

    modelRouting = turn.modelRouting ?? modelRouting;
    totalTokens.input += turn.inputTokens;
    totalTokens.output += turn.outputTokens;
    totalTokens.measured = totalTokens.measured && turn.measured === true;
    lastText = turn.text;
    if (input.signal?.aborted) { blocked = true; lastText = "Read operation cancelled. No new ERP change was performed."; break; }

    if (turn.toolCalls.length === 0 || turn.stopReason !== "tool_calls") break;

    messages.push(assistantToolCallMessage(turn));

    for (const call of turn.toolCalls) {
      if (blocked) break;
      if (input.signal?.aborted || Date.now() > deadline || totalTokens.output >= TOKEN_BUDGET) {
        blocked = true; lastText = "Read operation stopped at cancellation or a configured limit."; break;
      }

      const stepStartedAt = new Date().toISOString();
      const matches = allTools.filter((t) => (t.mcp_tool_name.trim() || t.name) === call.name);
      const toolDef = matches.length === 1 ? matches[0] : undefined;
      const isReadOnly = toolDef?.is_read_only === true;
      const displayName = toolDef?.display_name ?? humanizeName(call.name);

      // No guessed names or silent argument coercion. Invalid proposals are
      // rejected before governance or the dispatch callback is reached.
      const normalizedArguments = structuredClone(call.arguments);
      const argIssues = validateToolArguments(call.name, normalizedArguments, toolDef);
      if (toolDef === undefined || argIssues.missing.length > 0 || argIssues.invalid.length > 0 ||
          validateToolInput(toolDef.input_schema, normalizedArguments).length > 0 || (hasReservedBridgeRole(toolDef) && Object.hasOwn(normalizedArguments, "role"))) {
        const reason = toolDef === undefined ? "Tool is not admitted" : "Tool arguments failed runtime validation";
        steps.push({ toolName: call.name, displayName, arguments: redactCredentials(normalizedArguments), result: null,
          isReadOnly, governanceStatus: "blocked", governanceReason: reason, error: reason,
          startedAt: stepStartedAt, completedAt: new Date().toISOString() });
        blocked = true;
        lastText = reason;
        break;
      }

      // This chat execution profile is read-only regardless of model prose
      // or a permissive policy callback. Effects require the future transaction gateway.
      if (!isReadOnly) {
        const reason = "Live ERP writes are blocked until transaction approval, idempotency and recovery are enforced";
        steps.push({ toolName: call.name, displayName, arguments: redactCredentials(normalizedArguments), result: null,
          isReadOnly: false, governanceStatus: "blocked", governanceReason: reason,
          startedAt: stepStartedAt, completedAt: new Date().toISOString() });
        blocked = true; lastText = reason; break;
      }

      let rawResult: unknown = null;
      try {
        rawResult = await callTool(call.name, normalizedArguments);

        steps.push({
          toolName: call.name,
          displayName,
          arguments: redactCredentials(normalizedArguments),
          result: rawResult,
          isReadOnly,
          governanceStatus: isReadOnly ? "skipped" : "allowed",
          startedAt: stepStartedAt,
          completedAt: new Date().toISOString(),
        });
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: promptData({ source: "untrusted_tool_result", callId: call.id, toolName: call.name, status: "SUCCEEDED", data: mcpResultForModel(rawResult) }),
        });
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);

        steps.push({
          toolName: call.name,
          displayName,
          arguments: redactCredentials(normalizedArguments),
          result: acknowledgedReadToolFailure(error)?.result ?? null,
          isReadOnly,
          governanceStatus: isReadOnly ? "skipped" : "allowed",
          error: errMsg,
          startedAt: stepStartedAt,
          completedAt: new Date().toISOString(),
        });
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: promptData({ source: "untrusted_tool_result", callId: call.id, toolName: call.name, status: "FAILED", error: errMsg }),
        });
        // A failed callback is not permission to retry or continue. Recovery
        // requires a separately verified operation, not model self-correction.
        blocked = true;
        lastText = "Tool operation failed; review is required";
        break;
      }
    }
    if (blocked) break;
  }
  } catch (error) {
    throw attachPartialSteps(error, steps);
  }

  return {
    text: lastText,
    steps,
    blocked,
    workflowYaml: buildWorkflowYaml(steps, input.userMessage),
    totalTokens,
    latencyMs: Math.max(0, Math.round(performance.now() - started)),
    ...(modelRouting ? { modelRouting } : {}),
  };
}

// Mirrors runner/executor.ts's attachPartial/partialResult pattern: when the loop
// throws (e.g. a provider outage mid-run), the steps completed so far are attached
// to the error so callers can still show real diagnostic info instead of nothing.
/*******************************************************************************
 * Function: attachPartialSteps
 *
 * Attaches completed action steps to an error for later recovery.
 ******************************************************************************/
function attachPartialSteps(error: unknown, steps: ActionStep[]): Error {
  const normalized = error instanceof Error ? error : new Error(String(error));
  Object.defineProperty(normalized, "actionLoopSteps", { value: steps, enumerable: false });
  return normalized;
}

/*******************************************************************************
 * Function: partialActionSteps
 *
 * Retrieves action steps preserved on an action-loop error.
 ******************************************************************************/
export function partialActionSteps(error: unknown): ActionStep[] | null {
  if (!(error instanceof Error)) return null;
  return (error as Error & { actionLoopSteps?: ActionStep[] }).actionLoopSteps ?? null;
}

/*******************************************************************************
 * Function: buildWorkflowYaml
 *
 * Builds workflow YAML from action steps that were not blocked.
 ******************************************************************************/
function buildWorkflowYaml(steps: ActionStep[], prompt: string): string {
  const name = prompt.trim().slice(0, 60).replace(/[^a-zA-Z0-9 ]/g, "").trim() || "Agent Workflow";
  const runnable = steps.filter((s) => s.governanceStatus !== "blocked");
  if (runnable.length === 0) return `name: "${name}"\ndescription: "Generated from chat agent"\nsteps: []`;
  const stepsYaml = runnable.map((step, i) => {
    const paramLines =
      Object.keys(step.arguments).length > 0
        ? "\n    parameters:\n" +
          Object.entries(step.arguments)
            .map(([k, v]) => `      ${k}: ${JSON.stringify(v)}`)
            .join("\n")
        : "";
    return `  - id: step_${i + 1}\n    action: ${step.toolName}\n    description: "${step.displayName}"${paramLines}`;
  }).join("\n");
  return `name: "${name}"\ndescription: "Generated from chat agent"\nsteps:\n${stepsYaml}`;
}

/*******************************************************************************
 * Function: humanizeName
 *
 * Converts an underscored name into a readable title.
 ******************************************************************************/
function humanizeName(name: string): string {
  return name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}



/*******************************************************************************
 * Function: redactCredentials
 *
 * Replaces values under credential-like keys with redaction markers.
 ******************************************************************************/
function redactCredentials(args: Record<string, unknown>): Record<string, unknown> {
  const cred = /(?:password|secret|token|key|credential|auth)/i;
  return Object.fromEntries(Object.entries(args).map(([k, v]) => [k, cred.test(k) ? "[REDACTED]" : v]));
}
