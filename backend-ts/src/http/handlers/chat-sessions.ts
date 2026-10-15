import type { FastifyReply, FastifyRequest } from "fastify";
import type { ChatSessionRecord, RepositoryState, StoredRecord } from "../../repository/store.js";
import { ChatCreationFailure, createSavedChat } from "../../repository/chat-creation.js";
import { activeChatStatus } from "../../agent/chat-jobs.js";
import { chatRequestSourceHash } from "../../agent/chat-request-revisions.js";
import { ok } from "../../models/schemas.js";
import { chatWorkflowCatalog } from "../../agent/chat-workflow-catalog.js";
import { canReviewChat, chatAccess } from "../chat-scope.js";
import { chatTitle } from "./chat-session-input.js";
import { assertChatAuthority, requestedModel, selectProvider } from "./model-selection.js";
import { bodyRecord, HandlerFailure, type CurrentUser, type HandlerServices, isRecord, now, numberValue, paginate, queryRecord, requestParam, stringValue } from "./common.js";

/*******************************************************************************
 * Function: chatSummary
 *
 * Returns chat metadata without the messages array.
 ******************************************************************************/
export function chatSummary(chat: { messages: unknown[] } & Record<string, unknown>): Record<string, unknown> {
  const { messages: _messages, readSummary, ...summary } = chat;
  return { ...summary, ...(isRecord(readSummary) && typeof readSummary.preview === "string" ? { summary: readSummary.preview } : {}) };
}
// The frontend only ever reads `artifacts.retrieval` off the LAST message
// that has one (see useChat.js: `[...messages].reverse().find(...)`) — so
// carrying the full tool/rule/example retrieval payload (up to ~100 tool
// records) on every older workflow-generation message in a session is pure
// waste. A chat with several such messages balloons past what Azure's
// ingress will reliably relay in one response (silent truncation ->
// net::ERR_HTTP2_PROTOCOL_ERROR client-side). Strip it from everything but
// the newest occurrence before returning the full session.
/*******************************************************************************
 * Function: trimRedundantRetrieval
 *
 * Removes retrieval entries already represented by validation artifacts.
 ******************************************************************************/
function trimRedundantRetrieval(messages: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  let lastRetrievalIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const artifacts = messages[i]!.artifacts;
    if (isRecord(artifacts) && artifacts.retrieval !== undefined) { lastRetrievalIndex = i; break; }
  }
  return messages.map((message, index) => {
    const artifacts = message.artifacts;
    if (!isRecord(artifacts) || artifacts.retrieval === undefined || index === lastRetrievalIndex) return message;
    const { retrieval: _retrieval, ...rest } = artifacts;
    return { ...message, artifacts: rest };
  });
}
/*******************************************************************************
 * Function: listChats
 *
 * Returns chat sessions visible to the current user.
 ******************************************************************************/
export async function listChats(request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: { repository: Pick<HandlerServices["repository"], "read"> }): Promise<unknown> { const chats = await services.repository.read((state) => Object.values(state.chats).filter((item) => canReviewChat(user, item)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((item) => ({ ...chatSummary(item), access: chatAccess(user, item) }))); const page = paginate(chats, request); return reply.send(ok(page.items, "OK", page.meta)); }
/*******************************************************************************
 * Function: createChat
 *
 * Creates a chat session owned by the current user.
 ******************************************************************************/
export async function createChat(request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: Pick<HandlerServices, "repository">): Promise<unknown> {
  const body = request.body === undefined ? {} : bodyRecord(request);
  if (body === null) throw new HandlerFailure(400, "Invalid request body");
  const key = body.idempotencyKey;
  if (Object.hasOwn(body, "idempotencyKey") && (typeof key !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(key))) throw new HandlerFailure(400, "Invalid chat creation identity");
  const title = chatTitle(body);
  try {
    const result = await createSavedChat(services.repository, user.id, title, typeof key === "string" ? key : undefined);
    return reply.status(result.created ? 201 : 200).send(ok(chatSummary(result.chat), result.created ? "Chat session created" : "Chat session recovered", null));
  } catch (error) {
    if (error instanceof ChatCreationFailure) throw new HandlerFailure(error.status, error.message);
    throw error;
  }
}
/*******************************************************************************
 * Function: getChat
 *
 * Returns a chat session when it is visible to the current user. Messages
 * are paginated — without a real limit, a long conversation's full history
 * (with all its workflow-generation artifacts) can push a single response
 * past platform-level proxy buffer limits and get silently truncated in
 * transit. Defaults to the most recent `limit` messages; pass `before=<id>`
 * to page further back in history.
 ******************************************************************************/
export async function getChat(request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: { repository: Pick<HandlerServices["repository"], "read"> }): Promise<unknown> {
  const query = queryRecord(request);
  const limit = Math.max(1, Math.min(200, Math.trunc(numberValue(query.limit, 20))));
  if (query.before !== undefined && (typeof query.before !== "string" || !query.before.trim() || query.before.length > 128))
    throw new HandlerFailure(400, "Invalid earlier-message cursor. Reload this conversation before loading older messages.", { code: "CHAT_HISTORY_CURSOR_INVALID" });
  const beforeId = typeof query.before === "string" ? query.before : "";
  const chat = await services.repository.read((state) => {
    const value = state.chats[requestParam(request, "id")];
    if (value === undefined || !canReviewChat(user, value)) return null;
    let endIndex = value.messages.length;
    if (beforeId) {
      endIndex = value.messages.findIndex(message => message.id === beforeId);
      if (endIndex < 0) throw new HandlerFailure(400, "The earlier-message cursor is not in this conversation. Reload before loading older messages.", { code: "CHAT_HISTORY_CURSOR_INVALID" });
    }
    const startIndex = Math.max(0, endIndex - limit);
    // Page BEFORE cloning/converting large artifacts. Scan only metadata to
    // retain older-workflow choices and global supersession semantics.
    return projectChatMessagePage(state, value, user, value.messages.slice(startIndex,endIndex), startIndex, value.messages.length);
  });
  if (chat === null) throw new HandlerFailure(404, "Chat session not found");
  return reply.send(ok(chat, "OK", null));
}

/** Shared public projection for both aggregate compatibility and true scoped
 * message reads. Stored summary metadata preserves workflows/supersession
 * without loading historical message bodies on every page. */
export function projectChatMessagePage(state: Readonly<RepositoryState>, value: ChatSessionRecord, user: CurrentUser,
  messages: StoredRecord[], startIndex: number, totalMessageCount: number) {
    const copy = { ...structuredClone(chatSummary(value)), messages: structuredClone(messages) };
    const workflowCatalog = chatWorkflowCatalog(state, value, user);
    let lastRetrievalId: unknown = value.readSummary?.latestRetrievalId;
    const latestEmailDraftMessages = new Map<string, unknown>(Object.entries(value.readSummary?.emailDraftMessages ?? {}));
    for (const message of value.readSummary ? [] : value.messages) if (isRecord(message.artifacts)) {
      if (message.artifacts.retrieval !== undefined) lastRetrievalId = message.id;
      if (isRecord(message.artifacts.emailDraft)) latestEmailDraftMessages.set(stringValue(message.artifacts.emailDraft.id), message.id);
    }
    copy.messages = copy.messages.map(message => {
      if (isRecord(message.artifacts)) {
        let artifacts: Record<string, unknown> = message.artifacts;
        if (artifacts.retrieval !== undefined && message.id !== lastRetrievalId) {
          const { retrieval: _retrieval, ...rest } = artifacts; artifacts = rest;
        }
        if (isRecord(artifacts.emailDraft)) artifacts = { ...artifacts,
          emailDraftSuperseded: latestEmailDraftMessages.get(stringValue(artifacts.emailDraft.id)) !== message.id };
        message.artifacts = artifacts;
      }
      const operation = state.chatOperations[stringValue(message.operationId)];
      return message.role === "user" && value.ownerId === user.id && operation?.actorId === user.id && operation.sessionId === value.id && operation.userMessageId === message.id && (operation.revisionContextCiphertext || operation.revisionContextFields)
        ? { ...message, revisionSource: { messageId: message.id, sourceHash: chatRequestSourceHash(message), nodeContext: operation.nodeContext ?? null } }
        : message;
    });
    for (const message of copy.messages) {
      if (!isRecord(message.artifacts) || !isRecord(message.artifacts.emailDelivery)) continue;
      const executionId = stringValue(message.artifacts.emailDelivery.executionId), execution = state.executions[executionId];
      if (execution) message.artifacts.emailDelivery = { ...message.artifacts.emailDelivery, status: execution.status,
        bridgeDispatched: Object.values(execution.operationSecret?.intents ?? {}).some(intent => ["DISPATCH_INTENT", "ACKNOWLEDGED", "UNKNOWN"].includes(intent.state)),
        deliveryVerified: false };
    }
    return { ...copy, workflowCatalog, access: chatAccess(user, value), hasMoreMessages: startIndex > 0, totalMessageCount };
}
/*******************************************************************************
 * Function: updateChat
 *
 * Updates a visible chat session from the request body.
 ******************************************************************************/
export async function updateChat(request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown> {
  const body = bodyRecord(request);
  if (body === null) throw new HandlerFailure(400, "Invalid request body");
  const title = Object.hasOwn(body, "title") ? chatTitle(body) : undefined;
  const provider = Object.hasOwn(body, "selectedModel") ? selectProvider(services, requestedModel(body.selectedModel)) : undefined;
  const chat = await services.repository.mutate((state) => {
    const value = assertChatAuthority(state, user, requestParam(request, "id"));
    if (title !== undefined) value.title = title;
    if (provider?.binding) value.selectedModel = provider.binding.model;
    value.updatedAt = now(); return structuredClone(value);
  });
  return reply.send(ok(chatSummary(chat), "Chat session updated", null));
}
/*******************************************************************************
 * Function: deleteChat
 *
 * Deletes a chat session after checking the user's authority.
 ******************************************************************************/
export async function deleteChat(request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown> { await services.repository.mutate((state) => { const value = assertChatAuthority(state, user, requestParam(request, "id"));
  if (Object.values(state.chatOperations).some(op => op.sessionId === value.id && activeChatStatus(op.status))) throw new HandlerFailure(409, "Cancel or wait for the active chat operation before deleting this conversation", { code: "CHAT_OPERATION_ACTIVE" });
  if (Object.values(state.emailDeliveryAdmissions).some(admission => admission.sessionId === value.id)) throw new HandlerFailure(409, "A conversation linked to an immutable email approval execution cannot be deleted", { code: "EMAIL_DELIVERY_CHAT_IMMUTABLE" });
  delete state.chats[value.id]; }); return reply.send(ok({ deleted: true }, "Chat session deleted", null)); }
