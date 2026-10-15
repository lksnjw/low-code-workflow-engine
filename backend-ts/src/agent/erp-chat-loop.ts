import { Agent, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import { Type, createAssistantMessageEventStream, type AssistantMessage, type Message } from "@earendil-works/pi-ai";
import type { QueryProvider, QueryToolDefinition } from "../analysisprovider/query-types.js";
import type { ProviderContinuationSecret } from "../analysisprovider/provider-continuation.js";
import type { ErpbridgeMcpSdkTool } from "../tools/erpbridge-mcp-client.js";
import { validateToolInput, validateToolSchemaProfile } from "../tools/tool-input-schema.js";
import { BACKEND_SKILLED_ERP_CHAT_SYSTEM_PROMPT, promptData } from "../prompts/contracts.js";
import { combinedAgentSignal, piBridgeAssistantMessage, piBridgeModel, piJsonObject, piTranscriptMessages } from "./pi-provider-bridge.js";
import { mcpResultForModel } from "../tools/mcp-result.js";
import { erpChatInputIssues } from "../tools/erp-chat-input.js";
import { erpChatPresentation } from "./erp-chat-presentation.js";
import { erpBusinessActionLabel, matchingErpCatalog } from "./erp-business-language.js";
import { formatEmailArguments } from "../delivery/branded-email.js";

const model = piBridgeModel("erp-interactive-chat", "ERP interactive assistant", 6000);
const definitions: QueryToolDefinition[] = [
  { type: "function", function: { name: "erp_tool_catalog", description: "Choose the document or ERP skill and search its tool catalog; returns names and effects, not permission to execute.",
    parameters: { type: "object", properties: { search: { type: "string" }, offset: { type: "integer" }, skill: { type: "string", enum: ["documents", "erp"], description: "Use documents for the backend document library without waiting for ERPBridge; erp discovers ERP business tools." } }, required: ["search"], additionalProperties: false } } },
  { type: "function", function: { name: "erp_tool_schema", description: "Read the exact current tool contract, including all required inputs, enums and response schema. Required before invocation.",
    parameters: { type: "object", properties: { toolName: { type: "string" } }, required: ["toolName"], additionalProperties: false } } },
  { type: "function", function: { name: "erp_invoke", description: "Invoke a discovered read or prepare an exact ERP change for the user's confirmation in chat. Never generates a workflow. Arguments must match the fetched schema.",
    parameters: { type: "object", properties: { toolName: { type: "string" }, arguments: { type: "object", additionalProperties: true } }, required: ["toolName", "arguments"], additionalProperties: false } } },
];
export type ErpChatLoopInput = {
  content: string; history: string[]; actorId: string; role: string; sessionId: string; traceId: string; signal?: AbortSignal | undefined;
  onTurn?: (() => Promise<void>) | undefined; context?: string | undefined;
  catalog: readonly ErpbridgeMcpSdkTool[];
  loadErpCatalog?: (() => Promise<readonly ErpbridgeMcpSdkTool[]>) | undefined;
  read(tool: ErpbridgeMcpSdkTool, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  propose(tool: ErpbridgeMcpSdkTool, args: Record<string, unknown>): Promise<Record<string, unknown>>;
};

/** Pi owns sequencing and continuation. These three small tools progressively
 * disclose live contracts instead of sending the entire remote schema set per turn.
 * The server, not the model, validates every proposed argument before effects. */
export async function runErpChatLoop(input: ErpChatLoopInput, runtime: QueryProvider) {
  const provider = runtime.snapshot?.() ?? runtime;
  const deadline = Date.now() + 120_000, continuation = new Map<string, ProviderContinuationSecret>();
  const seen = new Set<string>(), called = new Set<string>();
  const steps: Array<Record<string, unknown>> = [], proposals: Array<Record<string, unknown>> = [];
  const usage = { inputTokens: 0, outputTokens: 0, measured: true };
  let turns = 0, validations = 0, stopped = false, failure = false, lastText = "";
  let catalog = [...input.catalog], loaded = !input.loadErpCatalog;
  const loadErp = async () => {
    if (loaded) return;
    const remote = await input.loadErpCatalog!();
    const names = new Set(catalog.map(tool => tool.name));
    catalog.push(...remote.filter(tool => !names.has(tool.name)));
    loaded = true;
  };
  const reply = (value: unknown) => ({ content: [{ type: "text" as const, text: promptData(value) }], details: {} });
  const tools: AgentTool[] = definitions.map(definition => ({
    name: definition.function.name, label: definition.function.name, description: definition.function.description,
    parameters: Type.Object({}, { additionalProperties: true }), executionMode: "sequential", replay: "never",
    execute: async (id, value) => {
      if (stopped || called.has(id) || input.signal?.aborted) return { ...reply({ status: "STOPPED", message: "No further calls may run" }), terminate: true };
      called.add(id);
      const args = value as Record<string, unknown>;
      if (validateToolInput(definition.function.parameters, args).length) return reply({ status: "NOT_DISPATCHED", message: "Use the wrapper's declared inputs" });
      if (definition.function.name === "erp_tool_catalog") {
        if (args.skill !== "documents") await loadErp();
        const source = args.skill === "documents" ? catalog.filter(tool => tool.name.startsWith("pipeline-library-")) : catalog;
        const matches = matchingErpCatalog(source, String(args.search));
        const offset = Math.max(0, Math.min(10_000, Number(args.offset) || 0));
        return reply({ source: "untrusted_tool_metadata", total: matches.length, matchedCount: matches.length, catalogTotal: source.length,
          scope: args.skill === "documents" ? "document-library" : "available-agent-catalog", search: String(args.search),
          countMeaning: "total is the keyword match count, not the complete ERPBridge tool count; catalogTotal is this scope's unfiltered size",
          nextOffset: offset + 25 < matches.length ? offset + 25 : null,
          tools: matches.slice(offset, offset + 25).map(tool => ({ name: tool.name, effect: tool.annotations?.readOnlyHint === true ? "READ" : "CHANGE_REQUIRES_CONFIRMATION", description: tool.description?.slice(0, 260) })) });
      }
      if (!catalog.some(tool => tool.name === args.toolName)) await loadErp();
      const matches = catalog.filter(tool => tool.name === args.toolName);
      const tool = matches.length === 1 ? matches[0] : undefined;
      if (!tool || validateToolSchemaProfile(tool.inputSchema).length) return reply({ status: "NOT_DISPATCHED", message: "No unique supported live contract exists for that exact tool name. Search the catalog; do not invent another name." });
      if (definition.function.name === "erp_tool_schema") {
        seen.add(tool.name);
        return reply({ source: "untrusted_tool_contract", name: tool.name, description: tool.description, inputSchema: tool.inputSchema,
          outputSchema: tool.outputSchema ?? null, effect: tool.annotations?.readOnlyHint === true ? "READ" : "CHANGE_REQUIRES_CONFIRMATION" });
      }
      if (!seen.has(tool.name)) return reply({ status: "NOT_DISPATCHED", message: "Fetch erp_tool_schema for this exact name first. Required fields must be checked, not guessed." });
      const businessArgs = formatEmailArguments(tool, args.arguments as Record<string, unknown>);
      const issues = erpChatInputIssues(tool, businessArgs);
      if (issues.length) {
        validations++;
        if (validations >= 3) { stopped = true; lastText = "Some required details are still missing or invalid. Please check the supplied values. No change was made."; }
        return reply({ status: "NOT_DISPATCHED", issues: issues.slice(0, 12), inputSchema: tool.inputSchema,
          message: "Preserve confirmed values. Correct only the declared input shape; ask the user for missing mandatory values. Never invent identifiers, enums or business data. A JSON-string field needs JSON text, not an array/object; an array field stays an array." });
      }
      if (tool.annotations?.readOnlyHint !== true) {
        try {
          const proposal = await input.propose(tool, businessArgs);
          proposals.push(proposal); stopped = true;
          lastText = `Please review “${erpBusinessActionLabel(tool.name, businessArgs)}” below, then confirm if it is correct. No ERP change has been made and no workflow was generated.`;
          return { ...reply({ status: "AWAITING_USER_CONFIRMATION", proposal }), terminate: true };
        } catch {
          stopped = true; failure = true;
          lastText = "This change could not be prepared. Check your access, required details and any earlier unresolved action before continuing. No new ERP change was dispatched.";
          return { ...reply({ status: "NOT_DISPATCHED", message: lastText }), terminate: true };
        }
      }
      try {
        const result = await input.read(tool, businessArgs);
        const notFound = result.isError === true && result.readBusinessOutcome === "NOT_FOUND";
        const failed = result.isError === true && !notFound;
        const status = notFound ? "NOT_FOUND" : failed ? "FAILED" : "SUCCEEDED";
        steps.push({ toolName: tool.name, arguments: businessArgs, result, status, isReadOnly: true });
        if (failed) { stopped = true; failure = true; lastText = "The ERP system returned an error for this lookup. The saved response needs review; it was not automatically retried."; }
        return { ...reply({ source: "untrusted_tool_result", status, toolName: tool.name, data: mcpResultForModel(result) }), ...(failed ? { terminate: true } : {}) };
      } catch {
        stopped = true; failure = true; lastText = "The requested lookup could not be confirmed. No new result is available; no write was performed by this request.";
        steps.push({ toolName: tool.name, arguments: businessArgs, status: "UNCONFIRMED", isReadOnly: true });
        return { ...reply({ status: "UNCONFIRMED", message: lastText }), terminate: true };
      }
    },
  }));
  const streamFn: StreamFn = (_model, context, options) => {
    const stream = createAssistantMessageEventStream();
    void (async () => {
      try {
        if (turns++ >= 14 || usage.outputTokens >= 6000 || Date.now() >= deadline || stopped) throw new Error("ERP chat limit");
        await input.onTurn?.();
        const turn = await provider.queryWithTools(piTranscriptMessages(context, continuation), definitions, { allowFallback: true,
          maxOutputTokens: Math.max(1, Math.min(2000, 6000 - usage.outputTokens)), promptTemplateVersion: "prompt/erp-chat/v4",
          context: { sessionId: input.sessionId, traceId: input.traceId, actor: { id: input.actorId, role: input.role }, egress: { purpose: "interactive", dataClass: "restricted" } },
          signal: combinedAgentSignal(input.signal, options?.signal, deadline) });
        usage.inputTokens += turn.inputTokens; usage.outputTokens += turn.outputTokens; usage.measured &&= turn.measured === true;
        const toolTurn = turn.stopReason === "tool_calls" && turn.toolCalls.length > 0 && turn.toolCalls.length <= 8;
        if (!toolTurn && (turn.stopReason !== "stop" || turn.completionConfirmed !== true)) throw new Error("Unconfirmed assistant completion");
        lastText = turn.text;
        if (turn.providerContinuationSecret) for (const call of turn.toolCalls) continuation.set(call.id, turn.providerContinuationSecret);
        const content: AssistantMessage["content"] = [...(turn.text ? [{ type: "text" as const, text: turn.text }] : []),
          ...(toolTurn ? turn.toolCalls.map(call => ({ type: "toolCall" as const, id: call.id, name: call.name, arguments: piJsonObject(call.arguments) })) : [])];
        stream.push({ type: "done", reason: toolTurn ? "toolUse" : "stop", message: piBridgeAssistantMessage(model, content, toolTurn ? "toolUse" : "stop", turns,
          { input: turn.inputTokens, output: turn.outputTokens }, turn.model, turn.provider) });
      } catch {
        failure = true; stopped = true;
        lastText = "The assistant could not complete this request. Check the saved tool responses before continuing. No unconfirmed ERP change was retried.";
        stream.push({ type: "error", reason: "error", error: { ...piBridgeAssistantMessage(model, [], "error", turns, { input: 0, output: 0 }), errorMessage: lastText } });
      }
    })();
    return stream;
  };
  const history: Message[] = input.history.slice(-10).map((text, index) => ({ role: "user", content: promptData({ source: "untrusted_chat_history", text }), timestamp: Date.now() + index }));
  const agent = new Agent({ initialState: { model, systemPrompt: BACKEND_SKILLED_ERP_CHAT_SYSTEM_PROMPT, tools, messages: history }, streamFn,
    sessionId: input.sessionId, toolExecution: "sequential", beforeToolCall: async () => {
      if (stopped || input.signal?.aborted || Date.now() >= deadline) return { block: true, reason: "Request stopped", terminate: true };
    }, finishTurn: async () => stopped ? { action: "end" } : undefined });
  const abort = () => agent.abort(); input.signal?.addEventListener("abort", abort, { once: true });
  try { await agent.prompt({ role: "user", content: promptData({ CURRENT_REQUEST: input.content, ...(input.context ? { REVIEWED_DOCUMENT_DATA: input.context } : {}) }), timestamp: Date.now() }); }
  finally { input.signal?.removeEventListener("abort", abort); }
  return { ...erpChatPresentation(lastText, steps.some(step => step.status === "SUCCEEDED"), failure, proposals.length > 0), toolSteps: steps, erpActionProposals: proposals, blocked: failure, usage };
}
