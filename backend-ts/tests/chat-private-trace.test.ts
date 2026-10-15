import { expect, test } from "vitest";
import { Repository } from "../src/repository/store.js";
import { buildTraceChain } from "../src/http/trace-chain.js";
import { recallConversationHistory } from "../src/agent/chat-history-recall.js";
import type { CurrentUser } from "../src/http/handlers/common.js";

test("global workflow readers cannot recover another owner's chat through a trace or recall selector", async () => {
  const repository = new Repository(null);
  await repository.mutate(state => {
    state.chats.private = { id: "private", ownerId: "owner", title: "Private", createdAt: "2026-10-16T00:00:00Z", updatedAt: "2026-10-16T00:00:00Z", messageCount: 1,
      messages: [{ id: "secret", role: "user", text: "Private history", traceId: "trace-one", createdAt: "2026-10-16T00:00:00Z" }] };
    state.users.builder = { id: "builder", name: "Builder", roleId: "role_builder", email: "builder@example.test", status: "Active", permissionOverrides: [], initials: "B", departmentId: null, lastLoginAt: null, createdAt: "2026-10-16T00:00:00Z" };
  });
  const state = await repository.snapshot();
  const builder = { id: "builder", role: "Workflow Builder", permissions: state.roles.role_builder!.permissions } as CurrentUser;
  expect(buildTraceChain(state, builder, "trace-one")).toEqual([]);
  expect(buildTraceChain(state, { ...builder, id: "owner" }, "trace-one")).toHaveLength(1);
  expect(buildTraceChain(state, { ...builder, role: "Platform Admin" }, "trace-one")).toHaveLength(1);
  expect(() => recallConversationHistory(state, builder, "private", { mode: "start" }, "secret")).toThrow("Chat session not found");
});
