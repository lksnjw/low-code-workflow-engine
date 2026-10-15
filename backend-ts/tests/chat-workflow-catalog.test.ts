import { expect, test } from "vitest";
import type { FastifyRequest, FastifyReply } from "fastify";
import { getChat } from "../src/http/handlers/chat-sessions.js";
import { Repository } from "../src/repository/store.js";
import type { Workflow } from "../src/models/schemas.js";
import type { CurrentUser } from "../src/http/handlers/common.js";

const owner = { id: "owner", permissions: ["chat:use"] } as CurrentUser;
const workflow = (id: string, overrides: Partial<Workflow> = {}) => ({ id, name: `Saved ${id}`, owner: { id: "owner", name: "Owner" }, archived: false, assignedUserIds: [],
  yaml: "private source must not enter the catalog", canvas: { private: "layout" }, ...overrides } as unknown as Workflow);
async function setup() {
  const repository = new Repository(null);
  await repository.mutate(state => {
    const messages = [{ id: "old-a", role: "assistant", text: "Saved A", artifacts: { workflowId: "a" } },
      { id: "old-b", role: "assistant", text: "Saved B", artifacts: { workflowId: "b" } },
      { id: "old-patch", role: "assistant", text: "A proposal", artifacts: { proposal: { workflowId: "a", nodeId: "read" } } },
      ...Array.from({ length: 35 }, (_, index) => ({ id: `later-${index}`, role: "assistant", text: "Later ordinary answer", artifacts: { intent: "QUERY" } }))];
    state.chats.session = { id: "session", ownerId: owner.id, title: "Long chat", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messageCount: messages.length, messages };
    state.workflows.a = workflow("a", { chatSessionId: "session" }); state.workflows.b = workflow("b", { chatSessionId: "session" });
  });
  const get = async (query: Record<string, string> = {}, actor = owner) => getChat({ params: { id: "session" }, query } as unknown as FastifyRequest,
    { send(value: unknown) { return value; } } as FastifyReply, actor, { repository }) as Promise<{ data: { messages: Array<{ id: string }>; totalMessageCount: number; workflowCatalog: Array<{ workflowId: string; name: string; lastMessageIndex: number }> } }>;
  return { repository, get };
}

test("workflow identities are independent of the latest 20-message page and repeat proposals are deduplicated", async () => {
  const { repository, get } = await setup(), before = await repository.snapshot(), { data } = await get();
  expect(data.messages).toHaveLength(20); expect(data.messages.some(message => message.id.startsWith("old-"))).toBe(false);
  expect(data.totalMessageCount).toBe(38);
  expect(data.workflowCatalog).toEqual([{ workflowId: "a", name: "Saved a", lastMessageIndex: 2 }, { workflowId: "b", name: "Saved b", lastMessageIndex: 1 }]);
  expect(JSON.stringify(data.workflowCatalog)).not.toMatch(/private source|private|canvas|nodeId/);
  expect((await get({ before: "later-5" })).data.workflowCatalog).toEqual(data.workflowCatalog);
  expect(await repository.snapshot()).toEqual(before);
});

test.each(["unknown-message", "", " ", "x".repeat(129), ["later-1", "later-2"]])("invalid history cursor is rejected instead of repeating the latest page: %s", async before => {
  const { get, repository } = await setup(), snapshot = await repository.snapshot();
  await expect(get({ before } as unknown as Record<string, string>)).rejects.toMatchObject({ status: 400, meta: { code: "CHAT_HISTORY_CURSOR_INVALID" } });
  expect(await repository.snapshot()).toEqual(snapshot);
});

test("oldest valid cursor gives an empty end page without cycling back to recent messages", async () => {
  const { get } = await setup();
  const response = await get({ before: "old-a", limit: "2" });
  expect(response.data.messages).toEqual([]);
  expect(response.data).toMatchObject({ hasMoreMessages: false, totalMessageCount: 38 });
});

test("the catalog excludes absent, archived and unauthorized workflows even if old artifacts reference them", async () => {
  const { repository, get } = await setup();
  await repository.mutate(state => {
    state.workflows.b!.owner = { id: "other", name: "Other" };
    state.workflows.archived = workflow("archived", { archived: true, chatSessionId: "session" });
    state.workflows.linked = workflow("linked", { chatSessionId: "session" });
    state.chats.session!.messages.push({ id: "missing", role: "assistant", text: "Missing", artifacts: { workflowId: "does-not-exist" } });
  });
  expect((await get()).data.workflowCatalog.map(item => item.workflowId)).toEqual(["a", "linked"]);
});

test("another chat-only account cannot read the catalog or its messages", async () => {
  const { get } = await setup(); await expect(get({}, { id: "other", permissions: ["chat:use"] } as CurrentUser)).rejects.toMatchObject({ status: 404 });
});

test.each(["Workflow Builder", "Viewer"])("%s cannot read another owner's messages even with global workflow permissions", async role => {
  const { get } = await setup();
  await expect(get({}, { id: "reviewer", role, permissions: ["workflow:read", "workflow:write", "chat:use"] } as CurrentUser)).rejects.toMatchObject({ status: 404 });
});

test("Platform Admin review still excludes another owner's immutable email workflow identity", async () => {
  const { repository, get } = await setup();
  await repository.mutate(state => { state.workflows.b = workflow("b", { owner: { id: "other", name: "Other" }, emailDeliverySource: { profile: "email-delivery-source/v1", admissionId: "admission", sessionId: "session", draftId: "draft", draftVersion: 1, draftHash: `sha256:${"a".repeat(64)}` } }); });
  const response = await get({}, { ...owner, id: "reviewer", role: "Platform Admin", permissions: ["workflow:read"] });
  expect(response.data.workflowCatalog.map(item => item.workflowId)).toEqual(["a"]);
  expect(response.data).toMatchObject({ access: { canReply: false, canManage: false, reviewOnly: true } });
});
