import type { ChatSessionRecord, StoredRecord } from "../repository/store.js";

export type ChatReadSummary = {
  profile: "chat-read-summary/v1";
  messageCount: number;
  lastMessageId: string | null;
  preview: string;
  latestRetrievalId: string | null;
  emailDraftMessages: Record<string, string>;
  workflows: Array<{ workflowId: string; lastMessageIndex: number }>;
  operationIds: string[];
};
const object = (value: unknown): value is StoredRecord => value !== null && typeof value === "object" && !Array.isArray(value);

/** Deterministic display/index data, not model memory or execution authority.
 * No model call, tool result bodies, credentials or inferred facts are stored. */
export function summarizeChatForReads(chat: ChatSessionRecord): ChatReadSummary {
  const workflows = new Map<string, number>(), operations = new Set<string>(), emailDraftMessages: Record<string, string> = Object.create(null);
  let latestRetrievalId: string | null = null;
  chat.messages.forEach((message, index) => {
    if(typeof message.operationId==="string")operations.add(message.operationId);
    const artifacts = message.artifacts;
    if (!object(artifacts)) return;
    if (artifacts.retrieval !== undefined && typeof message.id === "string") latestRetrievalId = message.id;
    if (object(artifacts.emailDraft) && typeof artifacts.emailDraft.id === "string" && typeof message.id === "string")
      emailDraftMessages[artifacts.emailDraft.id] = message.id;
    for (const id of [artifacts.workflowId, object(artifacts.proposal) ? artifacts.proposal.workflowId : undefined])
      if (typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id)) workflows.set(id, index);
  });
  const last = chat.messages.at(-1);
  return { profile: "chat-read-summary/v1", messageCount: chat.messages.length,
    lastMessageId: typeof last?.id === "string" ? last.id : null,
    preview: typeof last?.text === "string" ? last.text.replace(/\b(?:sk-or-v1-|sk-)[A-Za-z0-9_-]{16,}\b|\berpbt_[a-f0-9]{16,}\b|\bBearer\s+\S+/gi,"[credential redacted]")
      .replace(/((?:password|api[_ ]?key|access[_ ]?token|secret)\s*[=:]\s*)[^\s,;]+/gi,"$1[redacted]").replace(/\s+/g, " ").trim().slice(0, 240) : "",
    latestRetrievalId, emailDraftMessages, workflows: [...workflows].map(([workflowId, lastMessageIndex]) => ({workflowId,lastMessageIndex})), operationIds:[...operations] };
}

export function refreshChatReadSummaries(before: Record<string, ChatSessionRecord>, after: Record<string, ChatSessionRecord>) {
  for (const chat of Object.values(after)) {
    const prior = before[chat.id];
    if (!chat.readSummary || !prior || prior.updatedAt !== chat.updatedAt || prior.messages.length !== chat.messages.length ||
        prior.messages.at(-1)?.id !== chat.messages.at(-1)?.id || JSON.stringify(prior.messages.at(-1)) !== JSON.stringify(chat.messages.at(-1)))
      chat.readSummary = summarizeChatForReads(chat);
  }
}
