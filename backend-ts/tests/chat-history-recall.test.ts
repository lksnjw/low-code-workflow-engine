import { expect, test } from "vitest";
import { recallConversationHistory } from "../src/agent/chat-history-recall.js";

function fixture() {
  const user: any = { id: "owner", role: "Reader", permissions: ["chat:use"] };
  const state: any = { users: { owner: { id: "owner", roleId: "reader", status: "Active", permissionOverrides: [] } }, roles: { reader: { name: "Reader", permissions: user.permissions } },
    chats: { chat: { id: "chat", ownerId: "owner", messages: [
      { id: "first", role: "user", text: "First greeting" }, { id: "reply", role: "assistant", text: "Hello" },
      { id: "invoice", role: "user", text: "What is an invoice?" },
      ...Array.from({ length: 30 }, (_, index) => ({ id: `later-${index}`, role: index % 2 ? "assistant" : "user", text: `Unrelated later text ${index}`, artifacts: { privateCiphertext: "MUST-NOT-LEAVE" } })),
      { id: "current", role: "user", text: "What was my first question?" }, { id: "future", role: "user", text: "FUTURE-MUST-NOT-LEAVE" } ] },
      other: { id: "other", ownerId: "another", messages: [{ id: "private", role: "user", text: "OTHER-CHAT-MUST-NOT-LEAVE" }] } } };
  return { state, user };
}
test("start recall reaches beyond the recent window, stays before the current request and excludes artifacts/other chats", () => {
  const { state, user } = fixture(), before = JSON.stringify(state);
  const value = recallConversationHistory(state, user, "chat", { mode: "start" }, "current");
  expect(value.messages.map(item => item.id)).toContain("invoice"); expect(value.messages).toHaveLength(8);
  expect(value).toMatchObject({ historicalContextOnly: true, freshBusinessEvidence: false, executionAuthority: false, limitedSelection: true });
  expect(value).toMatchObject({ selectedMessageCount: 8, startsAtFirstStoredMessage: true });
  expect(value.messages.map(message => message.ordinal)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  expect(JSON.stringify(value)).not.toMatch(/MUST-NOT-LEAVE|privateCiphertext|current/);
  expect(JSON.stringify(state)).toBe(before);
});
test("search recall ranks matching same-chat text and returns no invented result for a miss", () => {
  const { state, user } = fixture();
  expect(recallConversationHistory(state, user, "chat", { mode: "search", query: "invoice" }, "current").messages[0]!.id).toBe("invoice");
  expect(recallConversationHistory(state, user, "chat", { mode: "search", query: "zzzzunmatched" }, "current").messages).toEqual([]);
});
test("recall redacts credential-shaped text and bounds every message", () => {
  const { state, user } = fixture(); state.chats.chat.messages[0].text = `api_key=private123 sk-or-v1-${"a".repeat(64)} ${"x".repeat(2000)}`;
  const value = recallConversationHistory(state, user, "chat", { mode: "start" }, "current");
  expect(value.messages[0]!.text.length).toBeLessThanOrEqual(1600); expect(value.messages[0]!.textTruncated).toBe(true);
  expect(value.messages[0]!.text).not.toContain("private123"); expect(value.messages[0]!.text).not.toContain("sk-or-v1-");
});
test.each([{ mode: "search" }, { mode: "start", sessionId: "other" }, { mode: "everything" }, { mode: "search", query: "x".repeat(301) }])("recall selector cannot broaden scope or exceed its budget: %s", plan => {
  const { state, user } = fixture(); expect(() => recallConversationHistory(state, user, "chat", plan, "current")).toThrow();
});
test("chat authorization and exact current message fence remain required", () => {
  const { state, user } = fixture();
  expect(() => recallConversationHistory(state, user, "other", { mode: "start" }, "private")).toThrow("Chat session not found");
  expect(() => recallConversationHistory(state, user, "chat", { mode: "start" }, "missing")).toThrow(/reference changed/);
  state.users.owner.status = "Suspended";
  expect(() => recallConversationHistory(state, user, "chat", { mode: "start" }, "current")).toThrow(/authority changed/);
});
