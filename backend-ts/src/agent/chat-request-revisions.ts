import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJSONBytes } from "../core/canonical-json.js";
import type { ChatSessionRecord, RepositoryState, StoredRecord } from "../repository/store.js";
import { HandlerFailure, stringValue, type CurrentUser } from "../http/handlers/common.js";
import { assertChatAuthority } from "../http/handlers/model-selection.js";

export const chatRequestRevisionSchema = z.object({ messageId: z.string().min(1).max(128), sourceHash: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).strict();
export type ChatRequestRevision = z.infer<typeof chatRequestRevisionSchema>;
export function chatRequestSourceHash(message: StoredRecord) {
  return `sha256:${createHash("sha256").update(canonicalJSONBytes(message)).digest("hex")}`;
}
export function assertChatRevisionSource(state: Readonly<RepositoryState>, user: CurrentUser, sessionId: string, revision: ChatRequestRevision) {
  const chat = assertChatAuthority(state, user, sessionId);
  if (chat.ownerId !== user.id) throw new HandlerFailure(404, "Chat session not found");
  const sources = chat.messages.filter(message => message.id === revision.messageId), source = sources[0];
  if (sources.length !== 1 || !source || source.role !== "user") throw new HandlerFailure(404, "Saved request not found");
  if (chatRequestSourceHash(source) !== revision.sourceHash) throw new HandlerFailure(409, "Saved request changed. Reload before revising", { code: "CHAT_REVISION_SOURCE_CHANGED" });
  const operation = state.chatOperations[stringValue(source.operationId)];
  if (!operation || operation.actorId !== user.id || operation.sessionId !== chat.id || operation.userMessageId !== source.id || !(operation.revisionContextCiphertext || operation.revisionContextFields))
    throw new HandlerFailure(409, "This historical request has no authentic saved context. Send a new request instead", { code: "CHAT_REVISION_CONTEXT_UNAVAILABLE" });
  return { chat, source, operation };
}

/** Choose conversational context, not execution state. An explicit revision
 * returns to the context before its source; old answers remain saved evidence.
 * Store only ten-message tails per source to bound history traversal memory. */
export function effectiveChatContext(messages: readonly StoredRecord[]): StoredRecord[] {
  let active: StoredRecord[] = [];
  const before = new Map<string, { context: StoredRecord[]; source: StoredRecord }>();
  for (const message of messages) {
    const revision = chatRequestRevisionSchema.safeParse(message.requestRevision);
    if (message.requestRevision !== undefined && !revision.success) throw new HandlerFailure(409, "Saved conversation revision context needs repair", { code: "CHAT_REVISION_HISTORY_INVALID" });
    if (revision.success) {
      const prior = before.get(revision.data.messageId);
      if (!prior || message.role !== "user" || chatRequestSourceHash(prior.source) !== revision.data.sourceHash) throw new HandlerFailure(409, "Saved conversation revision context needs repair", { code: "CHAT_REVISION_HISTORY_INVALID" });
      active = [...prior.context];
    }
    if (message.role === "user") before.set(stringValue(message.id), { context: [...active], source: message });
    active = [...active, message].slice(-10);
  }
  return active;
}
export function revisionPriorContext(chat: ChatSessionRecord, revision?: ChatRequestRevision) {
  const sourceIndex = revision ? chat.messages.findIndex(message => message.id === revision.messageId) : chat.messages.length;
  if (sourceIndex < 0) throw new HandlerFailure(409, "Saved revision source is missing", { code: "CHAT_REVISION_HISTORY_INVALID" });
  return effectiveChatContext(chat.messages.slice(0, sourceIndex)).map(message => `${stringValue(message.role)}: ${stringValue(message.text)}`);
}
