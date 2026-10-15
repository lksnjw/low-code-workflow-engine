import { Agent, type StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { z } from "zod";
import type { QueryProvider, QueryTurnResult } from "../analysisprovider/query-types.js";
import { OPERATOR_INTENT_ROUTING_SYSTEM_PROMPT, promptData } from "../prompts/contracts.js";
import { combinedAgentSignal, piBridgeAssistantMessage, piBridgeModel, piTranscriptMessages } from "./pi-provider-bridge.js";
import { HandlerFailure } from "../http/handlers/common.js";
import { withoutSecretFields } from "../redact/secrets.js";
import { historyRecallSchema } from "./chat-history-recall.js";
import { OpenAICompatibleError } from "../providers/openai-compatible.js";

const decisionSchema = z.object({
  intent: z.enum(["CONVERSATION", "WORKFLOW_DISCUSSION", "QUERY", "AUDIT", "CAPABILITIES", "ACTION", "WORKFLOW_MODIFY", "WORKFLOW_CONTROL", "EMAIL_DELIVERY", "TOOL_CALL"]),
  needsClarification: z.boolean(), clarification: z.string().trim().min(1).max(500).optional(),
  historyRecall: historyRecallSchema.optional(),
  workflowControl: z.enum(["review", "publish", "run", "schedule", "pause"]).optional(),
  scheduleSuggestion: z.object({
    cadence: z.enum(["daily", "weekly", "monthly"]).optional(),
    localTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).optional(),
    timezone: z.string().min(1).max(64).refine(value => { try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; } }).optional(),
    dayOfWeek: z.number().int().min(1).max(7).optional(),
    dayOfMonth: z.number().int().min(1).max(28).optional(),
  }).strict().refine(value => Object.keys(value).length > 0 &&
    (value.dayOfWeek === undefined || value.cadence === "weekly") && (value.dayOfMonth === undefined || value.cadence === "monthly")).optional(),
}).strict().refine(value => (value.needsClarification ? value.clarification !== undefined : value.clarification === undefined) &&
  (!value.historyRecall || value.intent === "CONVERSATION" && !value.needsClarification) &&
  (value.intent === "WORKFLOW_CONTROL" ? value.workflowControl !== undefined && !value.needsClarification : value.workflowControl === undefined) &&
  (value.scheduleSuggestion === undefined || value.intent === "WORKFLOW_CONTROL" && value.workflowControl === "schedule"));
export type IntentRouting = z.infer<typeof decisionSchema> & { source: "agent" | "unavailable"; toolsDispatched: false; failureCode?: string; diagnostics?: { stopReason?: string; completionConfirmed?: boolean; proposedIntent?: string; keys?: string[] } };

/** A bounded, tool-less semantic decision. It selects an existing governed
 * handler; it cannot validate payloads, authorize execution or approve writes. */
export async function identifyChatIntent(input: { content: string; history: string[]; workspace?: Record<string, unknown>;
  actorId: string; role: string; sessionId: string; traceId: string; signal?: AbortSignal; onTurn?: () => Promise<void> }, runtime: QueryProvider): Promise<IntentRouting> {
  const provider = runtime.snapshot?.() ?? runtime, model = piBridgeModel("intent-routing", "Conversation intent", 900);
  const deadline = Date.now() + 20_000;
  let turn: QueryTurnResult | undefined, decision: z.infer<typeof decisionSchema> | undefined, failed = false, failureCode = "PROVIDER_FAILED";
  let diagnostics: IntentRouting["diagnostics"];
  const streamFn: StreamFn = (_model, context, options) => {
    const stream = createAssistantMessageEventStream();
    void (async () => {
      try {
        if (turn || input.signal?.aborted) throw new Error("Intent routing stopped");
        await input.onTurn?.();
        turn = await provider.queryWithTools(piTranscriptMessages(context, new Map()), [], { allowFallback: true, maxOutputTokens: 900,
          promptTemplateVersion: "prompt/intent-routing/v4", signal: combinedAgentSignal(input.signal, options?.signal, deadline),
          context: { sessionId: input.sessionId, traceId: input.traceId, actor: { id: input.actorId, role: input.role }, egress: { purpose: "interactive", dataClass: "restricted" } } });
        diagnostics = { stopReason: ["stop", "length", "tool_calls", "content_filter"].includes(turn.stopReason) ? turn.stopReason : "other", completionConfirmed: turn.completionConfirmed === true };
        failureCode = "UNCONFIRMED_COMPLETION";
        if (turn.toolCalls.length || turn.stopReason !== "stop" || turn.completionConfirmed !== true || turn.text.length > 4000)
          throw new Error("Intent routing response was not confirmed");
        failureCode = "INVALID_JSON";
        const decoded = JSON.parse(turn.text);
        if (decoded && typeof decoded === "object" && !Array.isArray(decoded)) diagnostics = { ...diagnostics,
          ...(/^[A-Z_]{1,40}$/.test(decoded.intent) ? { proposedIntent: decoded.intent } : {}),
          keys: Object.keys(decoded).filter(key => ["intent", "needsClarification", "clarification", "historyRecall", "workflowControl", "scheduleSuggestion"].includes(key)) };
        failureCode = "ROUTE_SCHEMA_INVALID";
        decision = decisionSchema.parse(decoded);
        // Clarification is always a tool-less conversational reply, even when
        // the model also labels the underlying unresolved business intention.
        // It never grants the proposed route permission to run.
        if (decision.needsClarification) decision = { ...decision, intent: "CONVERSATION" };
        stream.push({ type: "done", reason: "stop", message: piBridgeAssistantMessage(model, [{ type: "text", text: turn.text }], "stop", 0,
          { input: turn.inputTokens, output: turn.outputTokens }, turn.model, turn.provider) });
      } catch (error) {
        if (error instanceof OpenAICompatibleError && [401, 403].includes(error.statusCode ?? 0)) failureCode = "PROVIDER_AUTHENTICATION_FAILED";
        failed = true;
        stream.push({ type: "error", reason: "error", error: { ...piBridgeAssistantMessage(model, [], "error", 0, { input: 0, output: 0 }), errorMessage: "Intent routing unavailable" } });
      }
    })();
    return stream;
  };
  const agent = new Agent({ initialState: { model, tools: [], systemPrompt: OPERATOR_INTENT_ROUTING_SYSTEM_PROMPT }, streamFn });
  const abort = () => agent.abort(); input.signal?.addEventListener("abort", abort, { once: true });
  try { await agent.prompt({ role: "user", content: promptData(withoutSecretFields({ CURRENT_REQUEST: input.content,
    HISTORY: input.history.slice(-6).map(text => text.slice(0, 2500)), WORKSPACE_CONTEXT: input.workspace ?? {} })), timestamp: Date.now() }); }
  finally { input.signal?.removeEventListener("abort", abort); }
  if (input.signal?.aborted) throw new HandlerFailure(409, "Conversation intent routing was cancelled");
  if (failed || !decision) return { intent: "CONVERSATION", needsClarification: true, source: "unavailable", toolsDispatched: false, failureCode, ...(diagnostics ? { diagnostics } : {}),
    clarification: failureCode === "PROVIDER_AUTHENTICATION_FAILED"
      ? "The configured model provider rejected its credential. Update the provider in Models and test its connection, then send a new request. No ERP tool was called or record changed."
      : failureCode === "PROVIDER_FAILED" ? "The model provider is unavailable, so I could not process this request. Check the provider connection in Models before trying again. No ERP tool was called or record changed."
      : failureCode === "UNCONFIRMED_COMPLETION" ? "The model returned an incomplete reply, so I stopped without calling ERP tools or changing records. Check the configured model or send a new, shorter request. Your instruction was not executed."
      : "I couldn't reliably identify your request. Please say whether you want an explanation, an ERP lookup, or a workflow change. No tools were called." };
  return { ...decision, source: "agent", toolsDispatched: false };
}
