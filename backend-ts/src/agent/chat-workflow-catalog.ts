import type { ChatSessionRecord, RepositoryState } from "../repository/store.js";
import { isRecord, type CurrentUser } from "../http/handlers/common.js";
import { canViewWorkflow } from "../workflows/commands.js";

/** Identity-only projection for an already-authorized chat. Message paging
 * must not remove saved workflows, and an entry grants no edit/run authority. */
export function chatWorkflowCatalog(state: Readonly<RepositoryState>, chat: ChatSessionRecord, user: Pick<CurrentUser, "id" | "permissions">) {
  const catalog = new Map<string, { workflowId: string; name: string; lastMessageIndex: number }>();
  const include = (id: unknown, lastMessageIndex: number) => {
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) return;
    const workflow = state.workflows[id];
    if (!workflow || workflow.archived || !canViewWorkflow(workflow, user)) return;
    const existing = catalog.get(id);
    catalog.set(id, { workflowId: id, name: workflow.name, lastMessageIndex: Math.max(existing?.lastMessageIndex ?? -1, lastMessageIndex) });
  };
  for (const workflow of Object.values(state.workflows)) if (workflow.chatSessionId === chat.id) include(workflow.id, -1);
  for (const entry of chat.readSummary?.workflows ?? []) include(entry.workflowId, entry.lastMessageIndex);
  chat.messages.forEach((message, index) => {
    if (!isRecord(message.artifacts)) return;
    include(message.artifacts.workflowId, index);
    if (isRecord(message.artifacts.proposal)) include(message.artifacts.proposal.workflowId, index);
  });
  return [...catalog.values()];
}
