import { createHash } from "node:crypto";
import type { ChatOperation, RepositoryState } from "../repository/store.js";
import { canonicalJSONBytes } from "../core/canonical-json.js";
import { HandlerFailure, type CurrentUser } from "../http/handlers/common.js";
import { assertActorAuthority, assertChatAuthority } from "../http/handlers/model-selection.js";
import { canReviewChat } from "../http/chat-scope.js";
import { assertCurrentWorkflowEditor } from "../workflows/commands.js";

export function authorityFingerprint(user: CurrentUser) {
  return createHash("sha256").update(canonicalJSONBytes([user.role, [...new Set(user.permissions)].sort()])).digest("hex");
}
export function authorizeChatOperation(state: Readonly<RepositoryState>, op: ChatOperation | undefined, user: CurrentUser): ChatOperation {
  if (!op || op.actorId !== user.id) throw new HandlerFailure(404, "Chat operation not found");
  if (assertChatAuthority(state, user, op.sessionId).ownerId !== user.id) throw new HandlerFailure(404, "Chat operation not found");
  if (op.authorityFingerprint !== authorityFingerprint(user)) throw new HandlerFailure(403, "Chat operation authority changed", { code: "CHAT_AUTHORITY_CHANGED" });
  if (op.nodeContext) {
    const workflow = state.workflows[op.nodeContext.workflowId];
    if (!workflow) throw new HandlerFailure(404, "Workflow not found");
    assertCurrentWorkflowEditor(state, workflow, user);
  }
  return op;
}
export function publicChatOperation(op: ChatOperation) {
  return { id: op.id, sessionId: op.sessionId, userMessageId: op.userMessageId, assistantMessageId: op.assistantMessageId ?? null,
    status: op.status, stage: op.stage, epoch: op.epoch, lastSequence: op.lastSequence, createdAt: op.createdAt, updatedAt: op.updatedAt,
    finishedAt: op.finishedAt ?? null, traceId: op.traceId, persistence: op.persistence, modelBinding: op.modelBinding,
    cancellationRequested: op.cancellationRequested === true, reason: op.reason ?? null, nodeContext: op.nodeContext ?? null, requestRevision: op.requestRevision ?? null, artifactRefs: op.artifactRefs ?? [], attempts: op.attempts.map(a => ({ id: a.id, toolName: a.toolName, status: a.status, startedAt: a.startedAt, completedAt: a.completedAt ?? null,
      ...(["DONE", "FAILED"].includes(a.status) && a.output !== undefined ? { output: a.output } : {}) })) };
}

/** Same owner/scope/journal checks for resident HTTP and nonwriter Functions. */
export function projectChatProgress(state: Readonly<RepositoryState>, user: CurrentUser, id: string, after: unknown) {
  if (typeof after !== "string" || !/^\d{1,16}$/.test(after) || !Number.isSafeInteger(Number(after))) throw new HandlerFailure(400, "Invalid chat event cursor");
  const op = authorizeChatOperation(state, state.chatOperations[id], user);
  const cursor = Number(after), entries = state.chatOperationEvents[op.id] ?? [];
  if (cursor > op.lastSequence || entries.some((event, index) => event.sequence !== index + 1 || event.version !== 1 || event.operationId !== op.id || event.sessionId !== op.sessionId || !Number.isFinite(Date.parse(event.timestamp)) || typeof event.stage !== "string" || typeof event.type !== "string") || entries.length !== op.lastSequence)
    throw new HandlerFailure(409, "Chat event sequence gap; reload from zero", { code: "CHAT_EVENT_GAP" });
  const events = entries.filter(entry => entry.sequence > cursor).slice(0, 100);
  const nextCursor = events.at(-1)?.sequence ?? cursor;
  return { operation: publicChatOperation(op), events, nextCursor, hasMore: nextCursor < op.lastSequence };
}
export function projectSessionOperations(state: Readonly<RepositoryState>, user: CurrentUser, id: string) {
  // Administrative message review must not impersonate the operation actor or
  // expose private worker journals/cancellation identities.
  assertActorAuthority(state, user);
  const chat = state.chats[id];
  if (!chat || !canReviewChat(user, chat)) throw new HandlerFailure(404, "Chat session not found");
  if (chat.ownerId !== user.id) return [];
  assertChatAuthority(state, user, id);
  return Object.values(state.chatOperations).filter(op => op.sessionId === id && op.actorId === user.id).sort((a,b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 20)
    .filter(op => { try { authorizeChatOperation(state, op, user); return true; } catch { return false; } })
    .map(op => { const value = publicChatOperation(op); return { ...value, attempts: value.attempts.map(({ output: _output, ...attempt }) => attempt) }; });
}
