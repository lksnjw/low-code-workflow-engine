import { Agent, type StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type Message } from "@earendil-works/pi-ai";
import { z } from "zod";
import type { QueryProvider, QueryTurnResult } from "../analysisprovider/query-types.js";
import type { RepositoryState } from "../repository/store.js";
import type { RegistrySnapshot } from "../registry/service.js";
import { HandlerFailure, isRecord, type CurrentUser } from "../http/handlers/common.js";
import { assertChatAuthority } from "../http/handlers/model-selection.js";
import { permittedWorkflow } from "../workflows/commands.js";
import { parseWorkflowYAMLStrict, workflowContentHash } from "../parser/workflow.js";
import { canReadExecution } from "../http/execution-scope.js";
import { withoutSecretFields } from "../redact/secrets.js";
import { chatWorkflowCatalog } from "./chat-workflow-catalog.js";
import { CONVERSATION_SYSTEM_PROMPT, WORKFLOW_DISCUSSION_SYSTEM_PROMPT, promptData } from "../prompts/contracts.js";
import { combinedAgentSignal, piBridgeAssistantMessage, piBridgeModel, piTranscriptMessages } from "./pi-provider-bridge.js";
import type { ConversationHistoryRecall } from "./chat-history-recall.js";

const referenceSchema = z.object({ workflowId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  baseVersion: z.number().int().positive().optional(), baseHash: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
}).strict().refine(value => (value.baseVersion === undefined) === (value.baseHash === undefined), "Supply both revision fields or neither");

/** Identity is a selector, not authority. Never use client YAML/name as saved
 * facts, and never select an arbitrary workflow when a chat has several. */
export function selectedDiscussionWorkflow(state: Readonly<RepositoryState>, user: CurrentUser, sessionId: string, raw?: unknown) {
  const chat = assertChatAuthority(state, user, sessionId);
  let reference;
  if (isRecord(raw) && Object.hasOwn(raw, "workflowId")) {
    const parsed = referenceSchema.safeParse(raw);
    if (!parsed.success) throw new HandlerFailure(400, "Invalid selected workflow reference");
    reference = parsed.data;
  } else {
    const catalog = chatWorkflowCatalog(state, chat, user);
    if (catalog.length !== 1) return null;
    reference = { workflowId: catalog[0]!.workflowId };
  }
  const workflow = state.workflows[reference.workflowId];
  if (!workflow || !permittedWorkflow(workflow, user, false)) throw new HandlerFailure(404, "Selected workflow not found");
  const hash = workflowContentHash(workflow.yaml);
  if (reference.baseVersion !== undefined && (reference.baseVersion !== workflow.draftVersion || reference.baseHash !== hash))
    throw new HandlerFailure(409, "The selected workflow changed. Reload the canvas before asking about this revision.");
  return { workflow, hash };
}

export function workflowDiscussionSnapshot(state: Readonly<RepositoryState>, user: CurrentUser, sessionId: string, raw: unknown, tools: RegistrySnapshot["tools"]) {
  const selected = selectedDiscussionWorkflow(state, user, sessionId, raw);
  if (!selected) return null;
  const { workflow, hash } = selected, blueprint = parseWorkflowYAMLStrict(workflow.yaml);
  const latest = Object.values(state.executions).filter(run => run.workflowId === workflow.id && canReadExecution(user, run))
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0];
  const schedule = state.schedules[`schedule-${workflow.id}`];
  const snapshot = { profile: "workflow-discussion/v1" as const, workflowId: workflow.id, name: blueprint.name,
    description: blueprint.description, draftVersion: workflow.draftVersion, contentHash: hash, publishedVersion: workflow.publishedVersion,
    trigger: blueprint.trigger.type, nodeCount: blueprint.steps.length,
    steps: blueprint.steps.map((step, index) => {
      const tool = tools.find(tool => tool.name === step.action || tool.mcp_tool_name === step.action);
      return { number: index + 1, id: step.id, kind: step.kind ?? "tool", label: step.description ?? step.id,
        action: step.action, parameters: withoutSecretFields(step.parameters ?? {}),
        ...(tool ? { toolDescription: tool.description, reviewedReadOnly: tool.is_read_only,
          inputSchema: withoutSecretFields(tool.input_schema) } : {}) };
    }),
    ...(blueprint.metadata?.controlFlow ? { controlFlow: blueprint.metadata.controlFlow } : {}),
    latestRun: latest ? { id: latest.id, status: latest.status, publishedVersion: latest.workflowSnapshot?.version ?? null } : null,
    schedule: schedule ? { state: schedule.state, cadence: schedule.cadence ?? "daily", timezone: schedule.timezone, nextRunAt: schedule.nextRunAt } : null,
    sampledAt: new Date().toISOString(), noOperationPerformedByThisMessage: true };
  if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > 100_000) throw new HandlerFailure(422, "This workflow is too large for a whole-workflow explanation. Ask about one selected node.");
  return snapshot;
}
export type WorkflowDiscussionSnapshot = NonNullable<ReturnType<typeof workflowDiscussionSnapshot>>;

export function workflowDiscussionStateNote(snapshot: WorkflowDiscussionSnapshot): string {
  return `Saved workflow: **${snapshot.name}** · ${snapshot.nodeCount} nodes · draft v${snapshot.draftVersion} · ${snapshot.publishedVersion ? `published v${snapshot.publishedVersion}` : "not published"}.` +
    (snapshot.latestRun ? ` Latest recorded run: **${snapshot.latestRun.status}**${snapshot.latestRun.publishedVersion ? ` (published v${snapshot.latestRun.publishedVersion})` : ""}.` : " No recorded run.") +
    (snapshot.schedule ? ` Schedule: ${snapshot.schedule.state}.` : " No active schedule is recorded.") +
    " This answer explains saved configuration; it did not run ERP tools, change the workflow, send email or activate a schedule.";
}

/** A distinct tool-less Pi conversation. The ERP read loop's no-evidence
 * rejection remains unchanged; this path explains an authorized saved plan. */
export async function runAssistantConversation(input: { content: string; history: string[]; snapshot?: WorkflowDiscussionSnapshot; historyRecall?: ConversationHistoryRecall; kind: "WORKFLOW_DISCUSSION" | "CONVERSATION";
  actorId: string; role: string; sessionId: string; traceId: string; signal?: AbortSignal; onTurn?: () => Promise<void> }, runtime: QueryProvider) {
  const provider = runtime.snapshot?.() ?? runtime, model = piBridgeModel("workflow-discussion", "Workflow discussion", 1800);
  const deadline = Date.now() + 30_000;
  let turn: QueryTurnResult | undefined, failed = false;
  const streamFn: StreamFn = (_model, context, options) => {
    const stream = createAssistantMessageEventStream();
    void (async () => {
      try {
        if (turn || input.signal?.aborted) throw new Error("Conversation stopped");
        await input.onTurn?.();
        turn = await provider.queryWithTools(piTranscriptMessages(context, new Map()), [], { allowFallback: true, maxOutputTokens: 1800,
          promptTemplateVersion: input.kind === "CONVERSATION" ? "prompt/conversation/v1" : "prompt/workflow-discussion/v1", signal: combinedAgentSignal(input.signal, options?.signal, deadline),
          context: { sessionId: input.sessionId, traceId: input.traceId, actor: { id: input.actorId, role: input.role }, egress: { purpose: "interactive", dataClass: "restricted" } } });
        if (turn.toolCalls.length || turn.stopReason !== "stop" || turn.completionConfirmed !== true || !turn.text.trim() || turn.text.length > 16_000 ||
            /\b(?:i|we|i've|we've|i have|we have)\s+(?:successfully\s+)?(?:sent|emailed|scheduled|updated|deleted|approved|published|executed|ran|retrieved|fetched|queried)\b/i.test(turn.text))
          throw new Error("Unsupported workflow explanation");
        const message = piBridgeAssistantMessage(model, [{ type: "text", text: turn.text }], "stop", 0, { input: turn.inputTokens, output: turn.outputTokens }, turn.model, turn.provider);
        stream.push({ type: "done", reason: "stop", message });
      } catch {
        failed = true;
        stream.push({ type: "error", reason: "error", error: { ...piBridgeAssistantMessage(model, [], "error", 0, { input: 0, output: 0 }), errorMessage: "Workflow explanation did not complete" } });
      }
    })();
    return stream;
  };
  const history: Message[] = input.history.slice(-8).map(text => ({ role: "user", content: promptData({ source: "untrusted_history", text: text.slice(0, 4000) }), timestamp: Date.now() }));
  const agent = new Agent({ initialState: { model, tools: [], systemPrompt: input.kind === "CONVERSATION" ? CONVERSATION_SYSTEM_PROMPT : WORKFLOW_DISCUSSION_SYSTEM_PROMPT, messages: history }, streamFn });
  const abort = () => agent.abort(); input.signal?.addEventListener("abort", abort, { once: true });
  try { await agent.prompt({ role: "user", content: promptData({ USER_REQUEST: input.content, ...(input.snapshot ? { CURRENT_WORKFLOW_JSON: input.snapshot } : {}),
    ...(input.historyRecall ? { HISTORY_REFERENCE_JSON: input.historyRecall } : {}) }), timestamp: Date.now() }); }
  finally { input.signal?.removeEventListener("abort", abort); }
  if (input.signal?.aborted) throw new HandlerFailure(409, "Workflow discussion was cancelled");
  return { text: failed || !turn ? input.kind === "WORKFLOW_DISCUSSION" ? "The conversational explanation could not be completed. The verified saved-workflow details are shown below; nothing was executed." : "I couldn't complete the reply. Please try again; no tools were called." : turn.text,
    ...(turn?.modelRouting ? { modelRouting: turn.modelRouting } : {}), explanationAvailable: !failed && Boolean(turn),
    usage: { inputTokens: turn?.inputTokens ?? 0, outputTokens: turn?.outputTokens ?? 0, measured: turn?.measured === true } };
}
