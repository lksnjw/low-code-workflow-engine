import { Agent, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import {
  Type,
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Message,
} from "@earendil-works/pi-ai";
import type { ToolDefinition } from "../registry/schemas.js";
import type { QueryMessage, QueryModelRouting, QueryToolDefinition, QueryProvider } from "../analysisprovider/query-types.js";
import { assistantToolCallMessage, type ProviderContinuationSecret } from "../analysisprovider/provider-continuation.js";
import { ERP_QUERY_SYSTEM_PROMPT, promptData } from "../prompts/contracts.js";
import { parseQueryRecoveryGuidance, recoveryGuidanceText, type QueryRecoveryGuidance } from "./query-recovery-guidance.js";
import type { ChatWorkspaceStatus } from "./chat-workspace-status.js";
import { validateToolInput } from "../tools/tool-input-schema.js";
import { hasReservedBridgeRole } from "../tools/erpbridge-contract.js";
import { mcpResultForModel } from "../tools/mcp-result.js";
import { acknowledgedReadToolFailure } from "../tools/read-tool-broker.js";
import { combinedAgentSignal, piBridgeAssistantMessage, piBridgeModel, piJsonObject, piTranscriptMessages } from "./pi-provider-bridge.js";
import { z } from "zod";
import { libraryModelInputSchema } from "../documents/library-client.js";
import { ToolProposalCorrector, type ToolProposalCorrection } from "./tool-proposal-correction.js";
import { userMcpFailureCode, userMcpFailureNotice, type UserMcpFailureCode } from "../tools/user-mcp-failure.js";

export type VisualisationSpec = {
  type: "bar" | "line" | "table" | "pie";
  title: string;
  data: Array<{ label: string; value: number }>;
};

export type ToolCallLogEntry = {
  name: string;
  arguments: Record<string, unknown>;
  iterationIndex: number;
};

export type ToolStep = {
  toolName: string;
  arguments: Record<string, unknown>;
  result: unknown;
  status?: "SUCCEEDED" | "FAILED";
  credentialFailure?: UserMcpFailureCode;
};

export type QueryLoopInput = {
  userMessage: string;
  chatHistory: Array<{ role: string; text: string }>;
  sessionId: string;
  actorId: string;
  actorRole: string;
  workspaceStatus?: ChatWorkspaceStatus;
  signal?: AbortSignal;
  traceId?: string;
  onTurn?: (iteration: number) => Promise<void>;
};

export type QueryLoopResult = {
  text: string;
  toolCallLog: ToolCallLogEntry[];
  toolSteps: ToolStep[];
  iterationsUsed: number;
  boundHit: boolean;
  visualisation?: VisualisationSpec;
  totalTokens: { input: number; output: number; measured?: boolean };
  latencyMs: number;
  narrativeRejected?: boolean;
  readOutcome?: "NO_CONFIRMED_READ" | "PARTIAL_READ" | "READS_COMPLETED";
  stopReason?: "COMPLETED" | "LIMIT_REACHED" | "PROVIDER_FAILED" | "CANCELLED";
  modelRouting?: QueryModelRouting;
  clarification?: ValidatedQueryClarification;
  recoveryGuidance?: QueryRecoveryGuidance;
  proposalCorrections?: ToolProposalCorrection[];
};

type ValidatedQueryClarification = { kind: "clarification"; questions: string[] };
const clarificationSchema = z.object({ kind: z.literal("clarification"), questions: z.array(z.string().min(1).max(240).refine(value => value === value.trim())).min(1).max(3) }).strict();

const MAX_ITERATIONS = parseInt(process.env.QUERY_AGENT_MAX_ITERATIONS ?? "5", 10);
const TIMEOUT_MS = parseInt(process.env.QUERY_AGENT_TIMEOUT_MS ?? "30000", 10);
const TOKEN_BUDGET = parseInt(process.env.QUERY_AGENT_TOKEN_BUDGET ?? "4000", 10);
const PI_QUERY_MODEL = piBridgeModel("lcwe-governed-query", "LCWE governed query provider", TOKEN_BUDGET);

const SYSTEM_PROMPT = ERP_QUERY_SYSTEM_PROMPT;

/*******************************************************************************
 * Function: runQueryLoop
 *
 * Runs the query agent with mandatory read-only contract enforcement.
 ******************************************************************************/
export async function runQueryLoop(
  input: QueryLoopInput,
  readOnlyTools: readonly ToolDefinition[],
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>,
  providerRuntime: QueryProvider,
  _policyCheckerEnabled = false,
): Promise<QueryLoopResult> {
  const runtime = (process.env.LCWE_AGENT_RUNTIME ?? "pi").trim().toLowerCase();
  if (runtime === "legacy") return runLegacyQueryLoop(input, readOnlyTools, callTool, providerRuntime, _policyCheckerEnabled);
  if (runtime !== "pi") throw new Error("LCWE_AGENT_RUNTIME must be pi or legacy");
  return runPiQueryLoop(input, readOnlyTools, callTool, providerRuntime);
}

/** Runs the interactive read agent through Pi Agent Core while the application
 * remains authoritative for provider selection, tool admission and dispatch. */
async function runPiQueryLoop(
  input: QueryLoopInput,
  readOnlyTools: readonly ToolDefinition[],
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>,
  providerRuntime: QueryProvider,
): Promise<QueryLoopResult> {
  const started = performance.now();
  const provider = providerRuntime.snapshot?.() ?? providerRuntime;
  assertAllReadOnly(readOnlyTools);
  if (input.signal?.aborted) return buildResult("Read preparation cancelled.", [], [], 0, true, { input: 0, output: 0, measured: true }, started, "CANCELLED");

  const definitions: QueryToolDefinition[] = readOnlyTools.map(tool => ({ type: "function", function: {
    name: tool.mcp_tool_name.trim() || tool.name,
    description: tool.description,
    parameters: libraryModelInputSchema(tool),
  } }));
  const toolCallLog: ToolCallLogEntry[] = [], toolSteps: ToolStep[] = [];
  const corrector = new ToolProposalCorrector(readOnlyTools);
  const seen = new Set<string>(), handledCallIds = new Set<string>(), continuationByCall = new Map<string, ProviderContinuationSecret>();
  const totalTokens = { input: 0, output: 0, measured: true };
  const deadline = Date.now() + TIMEOUT_MS;
  let attempts = 0, lastText = "", lastTurn: Awaited<ReturnType<QueryProvider["queryWithTools"]>> | undefined;
  let modelRouting: QueryModelRouting | undefined;
  let halt: "CANCELLED" | "PROVIDER_FAILED" | "LIMIT_REACHED" | "TOOL_FAILED" | "REPEATED" | undefined;

  const piTools: AgentTool[] = [...new Set(definitions.map(definition => definition.function.name))].map(name => ({
    name,
    label: name,
    description: definitions.find(definition => definition.function.name === name)?.function.description ?? name,
    // Exact validation remains in the existing registry validator below. The
    // permissive Pi schema prevents model arguments from being silently coerced
    // before that application-owned authority check.
    parameters: Type.Object({}, { additionalProperties: true }),
    executionMode: "sequential",
    replay: "never",
    execute: async (toolCallId, params) => {
      if (halt) return { content: [{ type: "text" as const, text: "Read preparation already stopped" }],
        details: { status: "BLOCKED" }, isError: true, terminate: true };
      handledCallIds.add(toolCallId);
      const args = params as Record<string, unknown>;
      const matches = readOnlyTools.filter(tool => (tool.mcp_tool_name.trim() || tool.name) === name);
      try {
        toolCallLog.push({ name, arguments: redactCredentials(args), iterationIndex: Math.max(0, attempts - 1) });
        if (matches.length !== 1 || validateToolInput(matches[0]!.input_schema, args).length > 0 ||
            (hasReservedBridgeRole(matches[0]!) && Object.hasOwn(args, "role")))
          throw new Error("Read proposal does not match an offered tool and valid arguments");
        const raw = await callTool(name, args);
        toolSteps.push({ toolName: name, arguments: redactCredentials(args), result: raw, status: "SUCCEEDED" });
        return { content: [{ type: "text", text: promptData({ source: "untrusted_tool_result", callId: toolCallId, toolName: name,
          status: "SUCCEEDED", data: mcpResultForModel(raw) }) }], details: { status: "SUCCEEDED" } };
      } catch (error) {
        const credentialFailure = userMcpFailureCode(error);
        const result = acknowledgedReadToolFailure(error)?.result ?? { error: errorText(error) };
        toolSteps.push({ toolName: name, arguments: redactCredentials(args), result, status: "FAILED", ...(credentialFailure ? { credentialFailure } : {}) });
        halt = "TOOL_FAILED";
        return { content: [{ type: "text", text: promptData({ source: "untrusted_tool_result", callId: toolCallId, toolName: name,
          status: "FAILED", error: "Read request failed or was denied" }) }], details: { status: "FAILED" }, isError: true, terminate: true };
      }
    },
  }));

  const streamFn: StreamFn = (_model, context, options) => {
    const stream = createAssistantMessageEventStream();
    void (async () => {
      const pending = piBridgeAssistantMessage(PI_QUERY_MODEL, [], "pending", attempts, totalTokens);
      stream.push({ type: "start", partial: pending });
      try {
        let messages = piTranscriptMessages(context, continuationByCall);
        for (;;) {
        if (input.signal?.aborted) { halt = "CANCELLED"; throw new Error("cancelled"); }
        if (attempts >= MAX_ITERATIONS || Date.now() > deadline || totalTokens.output >= TOKEN_BUDGET) {
          halt = "LIMIT_REACHED"; throw new Error("limit reached");
        }
        const iteration = attempts++;
        await input.onTurn?.(iteration);
        const signal = combinedAgentSignal(input.signal, options?.signal, deadline);
        const turn = await provider.queryWithTools(messages, definitions, {
          allowFallback: true,
          maxOutputTokens: Math.max(1, TOKEN_BUDGET - totalTokens.output),
          promptTemplateVersion: "prompt/query/v6",
          context: { sessionId: input.sessionId, actor: { id: input.actorId, role: input.actorRole }, ...(input.traceId ? { traceId: input.traceId } : {}),
            egress: { purpose: "interactive", dataClass: "restricted" } },
          signal,
        });
        lastTurn = turn; lastText = turn.text; modelRouting = turn.modelRouting ?? modelRouting;
        totalTokens.input += turn.inputTokens; totalTokens.output += turn.outputTokens;
        totalTokens.measured = totalTokens.measured && turn.measured === true;
        if (input.signal?.aborted) halt = "CANCELLED";
        const feedback = !halt ? corrector.feedback(turn, Date.now() <= deadline && totalTokens.output < TOKEN_BUDGET && attempts < MAX_ITERATIONS) : undefined;
        if (corrector.blocked) { halt = "TOOL_FAILED"; throw new Error("Proposal correction changed concrete values or scope"); }
        if (feedback) { messages = [...messages, ...feedback]; continue; }
        const validToolTurn = !halt && turn.stopReason === "tool_calls" && turn.toolCalls.length > 0;
        if (validToolTurn && turn.providerContinuationSecret)
          for (const call of turn.toolCalls) continuationByCall.set(call.id, turn.providerContinuationSecret);
        const content: AssistantMessage["content"] = [
          ...(turn.text ? [{ type: "text" as const, text: turn.text }] : []),
          ...(validToolTurn ? turn.toolCalls.map(call => ({ type: "toolCall" as const, id: call.id, name: call.name, arguments: piJsonObject(call.arguments) })) : []),
        ];
        const stopReason = validToolTurn ? "toolUse" : turn.stopReason === "length" ? "length" : "stop";
        const message = piBridgeAssistantMessage(PI_QUERY_MODEL, content, stopReason, iteration,
          { input: turn.inputTokens, output: turn.outputTokens }, turn.model, turn.provider);
        stream.push({ type: "done", reason: stopReason, message });
        break;
        }
      } catch {
        if (!halt) halt = input.signal?.aborted ? "CANCELLED" : "PROVIDER_FAILED";
        totalTokens.measured = halt === "LIMIT_REACHED" ? totalTokens.measured : false;
        const reason = halt === "CANCELLED" ? "aborted" : "error";
        const error = { ...piBridgeAssistantMessage(PI_QUERY_MODEL, [], reason, Math.max(0, attempts - 1), totalTokens), errorMessage: "Agent request did not complete" };
        stream.push({ type: "error", reason, error });
      }
    })();
    return stream;
  };

  const history: Message[] = input.chatHistory.slice(-10).map((message, index) => message.role === "assistant"
    ? piBridgeAssistantMessage(PI_QUERY_MODEL, [{ type: "text", text: promptData({ source: "untrusted_history", text: message.text }) }], "stop", index, { input: 0, output: 0 }, "history", "lcwe")
    : { role: "user", content: promptData({ source: "untrusted_history", text: message.text }), timestamp: Date.now() + index });
  const agent = new Agent({
    initialState: { model: PI_QUERY_MODEL, systemPrompt: SYSTEM_PROMPT, tools: piTools, messages: history },
    streamFn,
    toolExecution: "sequential",
    sessionId: input.sessionId,
    beforeToolCall: async ({ toolCall }) => {
      if (halt) return { block: true, reason: "Read preparation already stopped", terminate: true };
      if (input.signal?.aborted) { halt = "CANCELLED"; return { block: true, reason: "Read preparation cancelled", terminate: true }; }
      if (Date.now() > deadline || totalTokens.output >= TOKEN_BUDGET) {
        halt = "LIMIT_REACHED"; return { block: true, reason: "Read preparation reached its configured limit", terminate: true };
      }
      const args = toolCall.arguments as Record<string, unknown>, callHash = `${toolCall.name}:${stableHash(args)}`;
      if (seen.has(callHash)) { halt = "REPEATED"; return { block: true, reason: "Repeated tool call refused", terminate: true }; }
      seen.add(callHash);
    },
    finishTurn: async ({ message, toolResults }) => {
      const failed = toolResults.find(result => result.isError);
      if (!halt && failed) {
        const call = message.content.find(content => content.type === "toolCall" && content.id === failed.toolCallId);
        if (call?.type === "toolCall" && !handledCallIds.has(call.id)) {
          const args = call.arguments as Record<string, unknown>;
          toolCallLog.push({ name: call.name, arguments: redactCredentials(args), iterationIndex: Math.max(0, attempts - 1) });
          toolSteps.push({ toolName: call.name, arguments: redactCredentials(args),
            result: { error: "Read request failed or was denied" }, status: "FAILED" });
        }
        halt = "TOOL_FAILED";
      }
      if (halt) return { action: "end" };
      if (message.content.some(content => content.type === "toolCall") && attempts >= MAX_ITERATIONS) {
        halt = "LIMIT_REACHED"; return { action: "end" };
      }
    },
  });
  const abort = () => agent.abort();
  input.signal?.addEventListener("abort", abort, { once: true });
  try {
    await agent.prompt({ role: "user", content: promptData({ USER_REQUEST: input.userMessage,
      ...(input.workspaceStatus ? { CURRENT_WORKSPACE_STATUS_JSON: input.workspaceStatus } : {}) }), timestamp: Date.now() });
  } finally {
    input.signal?.removeEventListener("abort", abort);
  }

  const finish = (...args: Parameters<typeof buildResult>): QueryLoopResult => ({ ...buildResult(...args), ...(modelRouting ? { modelRouting } : {}),
    ...(corrector.events.length ? { proposalCorrections: corrector.events } : {}) });
  if (halt === "CANCELLED") return finish("Read preparation cancelled.", toolCallLog, toolSteps, attempts, true, totalTokens, started, "CANCELLED");
  if (halt === "PROVIDER_FAILED") return finish("Report preparation stopped before a complete answer was produced.", toolCallLog, toolSteps, attempts, true, totalTokens, started, "PROVIDER_FAILED");
  if (halt === "TOOL_FAILED") return finish("Read preparation stopped after a failed or denied tool request.", toolCallLog, toolSteps, attempts, true, totalTokens, started);
  if (halt === "REPEATED") return finish(lastText || "(Note: search ended — repeated tool call detected.)", toolCallLog, toolSteps, attempts, true, totalTokens, started);
  if (halt === "LIMIT_REACHED" || (lastTurn?.stopReason === "tool_calls" && lastTurn.toolCalls.length > 0)) {
    const notice = lastText.trim() !== "" && !isClarificationEnvelope(lastText)
      ? `${lastText}\n\n*(Note: search incomplete — maximum iterations reached)*`
      : "*(Note: search incomplete — maximum iterations reached)*";
    return finish(notice, toolCallLog, toolSteps, attempts, true, totalTokens, started);
  }
  const complete = lastTurn?.stopReason === "stop" && lastTurn.toolCalls.length === 0 && Date.now() <= deadline;
  const clarificationTokenLimit = totalTokens.output >= TOKEN_BUDGET && isClarificationEnvelope(lastText);
  const clarification = complete && lastTurn?.completionConfirmed === true && !input.signal?.aborted && totalTokens.output < TOKEN_BUDGET &&
    toolCallLog.length === 0 && toolSteps.length === 0 ? parseClarification(lastText) : undefined;
  const recovery = complete && lastTurn?.completionConfirmed === true && !input.signal?.aborted && totalTokens.output < TOKEN_BUDGET && toolCallLog.length === 0 && toolSteps.length === 0 ? parseQueryRecoveryGuidance(lastText, input.workspaceStatus) : undefined;
  return finish(lastText, toolCallLog, toolSteps, attempts, !complete || clarificationTokenLimit, totalTokens, started, undefined, clarification, recovery);
}

async function runLegacyQueryLoop(
  input: QueryLoopInput,
  readOnlyTools: readonly ToolDefinition[],
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>,
  providerRuntime: QueryProvider,
  _policyCheckerEnabled = false,
): Promise<QueryLoopResult> {
  const started = performance.now();
  const provider = providerRuntime.snapshot?.() ?? providerRuntime;
  let modelRouting: QueryModelRouting | undefined;
  const finish = (...args: Parameters<typeof buildResult>): QueryLoopResult => ({ ...buildResult(...args), ...(modelRouting ? { modelRouting } : {}) });

  // Mandatory scope, independent of the optional advisory-policy setting.
  assertAllReadOnly(readOnlyTools);
  const agentTools: QueryToolDefinition[] = readOnlyTools.map((tool) => ({
    type: "function",
    function: {
      name: tool.mcp_tool_name.trim() || tool.name,
      description: tool.description,
      parameters: libraryModelInputSchema(tool),
    },
  }));

  // Build initial messages
  const messages: QueryMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...input.chatHistory.slice(-10).map((m) => ({
      role: (m.role === "user" || m.role === "assistant" ? m.role : "user") as QueryMessage["role"],
      content: promptData({ source: "untrusted_history", text: m.text }),
    })),
    { role: "user", content: promptData({ USER_REQUEST: input.userMessage, ...(input.workspaceStatus ? { CURRENT_WORKSPACE_STATUS_JSON: input.workspaceStatus } : {}) }) },
  ];

  const toolCallLog: ToolCallLogEntry[] = [];
  const toolSteps: ToolStep[] = [];
  const seenCallHashes = new Set<string>();
  const totalTokens = { input: 0, output: 0, measured: true };
  let lastText = "";
  let boundHit = false;

  const deadline = Date.now() + TIMEOUT_MS;

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    if (input.signal?.aborted) return finish("Read preparation cancelled.", toolCallLog, toolSteps, iteration, true, totalTokens, started, "CANCELLED");
    if (Date.now() > deadline) {
      boundHit = true;
      break;
    }
    if (totalTokens.output >= TOKEN_BUDGET) {
      boundHit = true;
      break;
    }

    let turn;
    try {
      await input.onTurn?.(iteration);
      turn = await provider.queryWithTools(messages, agentTools, {
        allowFallback: true,
        maxOutputTokens: TOKEN_BUDGET - totalTokens.output,
        promptTemplateVersion: "prompt/query/v6",
        context: { sessionId: input.sessionId, actor: { id: input.actorId, role: input.actorRole }, ...(input.traceId ? { traceId: input.traceId } : {}),
          egress: { purpose: "interactive", dataClass: "restricted" } },
        signal: input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(Math.max(1, deadline - Date.now()))]) : AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      });
    } catch {
      totalTokens.measured = false;
      // Preserve acknowledged read evidence even if the summarising provider
      // fails later. Never expose an arbitrary provider exception as content.
      return finish("Report preparation stopped before a complete answer was produced.", toolCallLog, toolSteps, iteration + 1, true, totalTokens, started, input.signal?.aborted ? "CANCELLED" : "PROVIDER_FAILED");
    }

    modelRouting = turn.modelRouting ?? modelRouting;
    totalTokens.input += turn.inputTokens;
    totalTokens.output += turn.outputTokens;
    totalTokens.measured = totalTokens.measured && turn.measured === true;
    if (input.signal?.aborted) return finish("Read preparation cancelled.", toolCallLog, toolSteps, iteration + 1, true, totalTokens, started, "CANCELLED");
    lastText = turn.text;

    if (turn.toolCalls.length === 0 || turn.stopReason !== "tool_calls") {
      // Truncation/filtering is not a completed report, even after real reads.
      const complete = turn.stopReason === "stop" && turn.toolCalls.length === 0 && Date.now() <= deadline;
      const clarificationTokenLimit = totalTokens.output >= TOKEN_BUDGET && isClarificationEnvelope(lastText);
      const clarification = complete && turn.completionConfirmed === true && !input.signal?.aborted && totalTokens.output < TOKEN_BUDGET &&
        toolCallLog.length === 0 && toolSteps.length === 0 ? parseClarification(lastText) : undefined;
      const recovery = complete && turn.completionConfirmed === true && !input.signal?.aborted && totalTokens.output < TOKEN_BUDGET && toolCallLog.length === 0 && toolSteps.length === 0 ? parseQueryRecoveryGuidance(lastText, input.workspaceStatus) : undefined;
      return finish(lastText, toolCallLog, toolSteps, iteration + 1, !complete || clarificationTokenLimit, totalTokens, started, undefined, clarification, recovery);
    }

    // Append assistant message with tool calls
    messages.push(assistantToolCallMessage(turn));

    // Process each tool call
    for (const call of turn.toolCalls) {
      if (input.signal?.aborted) return finish("Read preparation cancelled.", toolCallLog, toolSteps, iteration + 1, true, totalTokens, started, "CANCELLED");
      if (Date.now() > deadline || totalTokens.output >= TOKEN_BUDGET) return finish("Read preparation reached its limit.", toolCallLog, toolSteps, iteration + 1, true, totalTokens, started);
      const callHash = `${call.name}:${stableHash(call.arguments)}`;
      if (seenCallHashes.has(callHash)) {
        boundHit = true;
        return finish(
          lastText || "(Note: search ended — repeated tool call detected.)",
          toolCallLog,
          toolSteps,
          iteration + 1,
          true,
          totalTokens,
          started,
        );
      }
      seenCallHashes.add(callHash);

      toolCallLog.push({ name: call.name, arguments: redactCredentials(call.arguments), iterationIndex: iteration });

      let toolResultContent: string;
      try {
        const matches = readOnlyTools.filter((tool) => (tool.mcp_tool_name.trim() || tool.name) === call.name);
        if (matches.length !== 1 || validateToolInput(matches[0]!.input_schema, call.arguments).length > 0 || (hasReservedBridgeRole(matches[0]!) && Object.hasOwn(call.arguments, "role")))
          throw new Error("Read proposal does not match an offered tool and valid arguments");
        const raw = await callTool(call.name, call.arguments);
        toolSteps.push({ toolName: call.name, arguments: redactCredentials(call.arguments), result: raw, status: "SUCCEEDED" });
        toolResultContent = promptData({ source: "untrusted_tool_result", callId: call.id, toolName: call.name, status: "SUCCEEDED", data: mcpResultForModel(raw) });
      } catch (error) {
        const credentialFailure = userMcpFailureCode(error);
        toolSteps.push({ toolName: call.name, arguments: redactCredentials(call.arguments), result: acknowledgedReadToolFailure(error)?.result ?? { error: errorText(error) }, status: "FAILED", ...(credentialFailure ? { credentialFailure } : {}) });
        // A denial/failure is not permission to try another tool or argument.
        return finish("Read preparation stopped after a failed or denied tool request.", toolCallLog, toolSteps, iteration + 1, true, totalTokens, started);
      }

      messages.push({ role: "tool", tool_call_id: call.id, content: toolResultContent });
    }
  }

  // Exhausted iterations
  boundHit = true;
  const notice = lastText.trim() !== "" && !isClarificationEnvelope(lastText)
    ? `${lastText}\n\n*(Note: search incomplete — maximum iterations reached)*`
    : "*(Note: search incomplete — maximum iterations reached)*";
  return finish(notice, toolCallLog, toolSteps, MAX_ITERATIONS, true, totalTokens, started);
}

/*******************************************************************************
 * Function: buildResult
 *
 * Assembles the query response, tool history, usage, and timing.
 ******************************************************************************/
function buildResult(
  text: string,
  toolCallLog: ToolCallLogEntry[],
  toolSteps: ToolStep[],
  iterationsUsed: number,
  boundHit: boolean,
  totalTokens: { input: number; output: number; measured?: boolean },
  started: number,
  stopReason: QueryLoopResult["stopReason"] = boundHit ? "LIMIT_REACHED" : "COMPLETED",
  clarification?: ValidatedQueryClarification,
  recoveryGuidance?: QueryRecoveryGuidance,
): QueryLoopResult {
  const latencyMs = Math.max(0, Math.round(performance.now() - started));
  const successful = toolSteps.filter((step) => step.status === "SUCCEEDED").length;
  // No-read model prose is not evidence of ERP data or completed actions. A
  // read response can never acknowledge a new email, write or schedule.
  const completionClaims = /\b(?:(?:i|we|i've|we've|i have|we have)\s+(?:successfully\s+)?(?:sent|emailed|forwarded|delivered|scheduled|paid|created|updated|deleted|approved|submitted))\b|\b(?:email|e-mail|message|report)\s+(?:(?:has been|was|is|successfully)\s+)*(?:sent|emailed|delivered|scheduled)\b/gi;
  // "No email was sent" is an explicit denial, not a delivery claim. Check
  // each match separately so a denial cannot hide a later positive claim.
  // Only the noun form may use this exception; model-only data remains denied.
  const clarificationText = clarification?.questions.join("\n");
  const claimText = clarificationText ?? text;
  const completionClaim = Array.from(claimText.matchAll(completionClaims)).some(match =>
    !/^(?:email|e-mail|message|report)\b/i.test(match[0]) || !/\bno\s+$/i.test(claimText.slice(0, match.index)));
  const acceptedClarification = clarification && !completionClaim ? clarification : undefined;
  const acceptedRecovery = recoveryGuidance && successful === 0 && toolSteps.length === 0 && !boundHit && !completionClaim ? recoveryGuidance : undefined;
  const malformedClarification = !acceptedClarification && isClarificationEnvelope(text);
  const narrativeRejected = acceptedClarification || acceptedRecovery ? false : successful === 0 || completionClaim || malformedClarification;
  if (acceptedRecovery) text = recoveryGuidanceText(acceptedRecovery);
  else if (acceptedClarification) text = acceptedClarification.questions.join("\n");
  else if (malformedClarification) text = successful === 0 ? "No confirmed ERP data was retrieved. No email was sent, schedule activated or ERP change made." : "The assistant did not produce a complete report. Confirmed read results are available, but no email was sent, schedule activated or ERP change made.";
  else if (narrativeRejected) text = successful === 0 ? "No confirmed ERP data was retrieved. No email was sent, schedule activated or ERP change made." : "The assistant returned an unsupported action-completion claim. Confirmed read results are available, but no email was sent, schedule activated or ERP change made.";
  const credentialFailure = toolSteps.find(step => step.status === "FAILED" && step.credentialFailure)?.credentialFailure;
  if (credentialFailure) text = `${userMcpFailureNotice(credentialFailure)} ${successful === 0 ? "No ERP data was retrieved." : "Earlier confirmed read results are retained."} No email was sent, schedule activated or ERP change made.`;
  const vis = acceptedClarification || acceptedRecovery ? undefined : extractVisualisation(text);
  return {
    text: extractText(text),
    toolCallLog,
    toolSteps,
    iterationsUsed,
    boundHit,
    ...(vis !== undefined ? { visualisation: vis } : {}),
    totalTokens,
    latencyMs,
    narrativeRejected, ...(acceptedClarification ? { clarification: acceptedClarification } : {}), readOutcome: successful === 0 ? "NO_CONFIRMED_READ" : successful !== toolSteps.length || boundHit ? "PARTIAL_READ" : "READS_COMPLETED",
    ...(acceptedRecovery ? { recoveryGuidance: acceptedRecovery } : {}),
    stopReason,
  };
}

function parseClarification(text: string): ValidatedQueryClarification | undefined {
  if (Buffer.byteLength(text, "utf8") > 2048) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    const result = clarificationSchema.safeParse(parsed);
    if (!result.success || !result.data.questions.every(isQuestionOnly)) return undefined;
    return result.data;
  } catch { return undefined; }
}

function isClarificationEnvelope(text: string): boolean {
  // Also recognize malformed or oversized envelopes so their raw JSON never
  // becomes a report after a real read.
  if (/"kind"\s*:\s*"clarification"/.test(text)) return true;
  if (Buffer.byteLength(text, "utf8") > 2048) return false;
  try { const parsed: unknown = JSON.parse(text); return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) && "kind" in parsed && parsed.kind === "clarification"; }
  catch { return false; }
}

function isQuestionOnly(question: string): boolean {
  if (!question.endsWith("?") || /[`*_#<>]|<\/?vis\s*>|(?:\b(?:i|we)\s+(?:have\s+)?(?:sent|emailed|forwarded|delivered|scheduled|paid|created|updated|deleted|approved|submitted)\b|\b(?:email|message|report)\s+(?:was|has been|is|successfully)\s+(?:sent|delivered|scheduled)\b|\b(?:authorize|permission|approval|allow me to)\b|\b(?:may|can|could|should)\s+i\s+(?:send|email|forward|schedule|pay|create|update|delete|approve|submit)\b)/i.test(question)) return false;
  if (/\b(?:invoice|customer|order|payment|balance|total|record|report|account)\s+(?:is|was|shows|has|contains|equals)\b|\b\d+(?:\.\d+)?\s*(?:USD|EUR|GBP|LKR|dollars?)\b|\b(?:confirmed|retrieved|found)\s+(?:invoice|customer|order|payment|record|data)\b/i.test(question)) return false;
  return true;
}

/*******************************************************************************
 * Function: extractText
 *
 * Removes embedded visualisation blocks from response text.
 ******************************************************************************/
function extractText(text: string): string {
  return text.replace(/<vis>[\s\S]*?<\/vis>/g, "").trim();
}

/*******************************************************************************
 * Function: extractVisualisation
 *
 * Parses and checks an embedded visualisation specification.
 ******************************************************************************/
function extractVisualisation(text: string): VisualisationSpec | undefined {
  const match = /<vis>([\s\S]*?)<\/vis>/i.exec(text);
  const raw = match?.[1];
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw.trim());
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed.type === "bar" || parsed.type === "line" || parsed.type === "table" || parsed.type === "pie") &&
      typeof parsed.title === "string" &&
      Array.isArray(parsed.data)
    ) {
      return parsed as VisualisationSpec;
    }
  } catch { /* not parseable — ignore */ }
  return undefined;
}

/*******************************************************************************
 * Function: assertAllReadOnly
 *
 * Rejects tools that are not explicitly marked as read-only.
 ******************************************************************************/
function assertAllReadOnly(tools: readonly ToolDefinition[]): void {
  for (const tool of tools) {
    if (tool.is_read_only !== true) {
      throw new Error(
        `Query loop startup failed: tool "${tool.name}" is not marked is_read_only. ` +
        "Only read-only tools may be offered to the query agent.",
      );
    }
  }
}

/*******************************************************************************
 * Function: stableHash
 *
 * Serializes sorted top-level keys for a stable tool-argument comparison.
 ******************************************************************************/
function stableHash(obj: Record<string, unknown>): string {
  return JSON.stringify(Object.keys(obj).sort().reduce<Record<string, unknown>>((acc, k) => { acc[k] = obj[k]; return acc; }, {}));
}

/*******************************************************************************
 * Function: redactCredentials
 *
 * Replaces values under credential-like keys with redaction markers.
 ******************************************************************************/
function redactCredentials(args: Record<string, unknown>): Record<string, unknown> {
  const credentialKeys = /(?:password|secret|token|key|credential|auth)/i;
  return Object.fromEntries(
    Object.entries(args).map(([k, v]) => [k, credentialKeys.test(k) ? "[REDACTED]" : v]),
  );
}



/*******************************************************************************
 * Function: errorText
 *
 * Converts an error or other thrown value into a message string.
 ******************************************************************************/
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
