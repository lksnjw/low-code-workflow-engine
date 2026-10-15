import { z } from "zod";
import type { RepositoryState } from "../repository/store.js";
import { assertChatAuthority } from "../http/handlers/model-selection.js";
import { HandlerFailure, stringValue, type CurrentUser } from "../http/handlers/common.js";

export const historyRecallSchema = z.object({ mode: z.enum(["start", "search"]), query: z.string().trim().min(1).max(300).optional() }).strict()
  .refine(value => value.mode !== "search" || Boolean(value.query));
export type HistoryRecallRequest = z.infer<typeof historyRecallSchema>;
const textOnly = (text: string) => text.replace(/\b(?:sk-or-v1-|sk-)[A-Za-z0-9_-]{16,}\b|\berpbt_[a-f0-9]{16,}\b|\bBearer\s+\S+/gi, "[credential redacted]")
  .replace(/((?:password|api[_ ]?key|access[_ ]?token|secret)\s*[=:]\s*)[^\s,;]+/gi, "$1[redacted]");

/** Same-chat text recall, never cross-chat search or a fresh ERP receipt.
 * The model chooses the need/mode; current server authority scopes the data. */
export function recallConversationHistory(state: Readonly<RepositoryState>, user: CurrentUser, sessionId: string, raw: unknown, beforeMessageId: string) {
  const plan = historyRecallSchema.parse(raw), chat = assertChatAuthority(state, user, sessionId);
  const end = chat.messages.findIndex(message => message.id === beforeMessageId);
  if (end < 0) throw new HandlerFailure(409, "The saved conversation reference changed. Reload before recalling history.");
  const messages = chat.messages.slice(0, end);
  let indexes: number[];
  if (plan.mode === "start") indexes = messages.slice(0, 8).map((_message, index) => index);
  else {
    const words = [...new Set(plan.query!.normalize("NFKC").toLowerCase().match(/[\p{L}\p{M}\p{N}_-]+/gu) ?? [])].filter(word => word.length > 1).slice(0, 20);
    const ranked = messages.map((message, index) => { const text = stringValue(message.text).normalize("NFKC").toLowerCase();
      return { index, score: words.reduce((sum, word) => sum + (text.includes(word) ? 1 : 0), 0) }; })
      .filter(item => item.score > 0).sort((a, b) => b.score - a.score || b.index - a.index).slice(0, 4);
    indexes = [...new Set(ranked.flatMap(item => [item.index, ...(item.index + 1 < messages.length ? [item.index + 1] : [])]))].sort((a, b) => a - b).slice(0, 8);
  }
  return { profile: "chat-history-recall/v1" as const, sessionId, mode: plan.mode, totalEarlierMessages: messages.length,
    selectedMessageCount: indexes.length, startsAtFirstStoredMessage: indexes[0] === 0,
    historicalContextOnly: true, freshBusinessEvidence: false, executionAuthority: false, limitedSelection: indexes.length < messages.length,
    messages: indexes.map(index => { const message = messages[index]!, text = textOnly(stringValue(message.text));
      return { id: stringValue(message.id), ordinal: index + 1, role: stringValue(message.role), text: text.slice(0, 1600), textTruncated: text.length > 1600,
        createdAt: message.createdAt ?? null, revisedRequest: message.requestRevision !== undefined }; }) };
}
export type ConversationHistoryRecall = ReturnType<typeof recallConversationHistory>;
