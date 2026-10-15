import { expect, test } from "vitest";
import type { FastifyReply, FastifyRequest } from "fastify";
import { handleNotificationRoute } from "../src/http/handlers/notifications.js";
import { Repository } from "../src/repository/store.js";
import type { CurrentUser, HandlerServices } from "../src/http/handlers/common.js";
import type { RouteDefinition } from "../src/http/generated-routes.js";

async function fixture() {
  const repository = new Repository(null);
  await repository.mutate(state => { state.notifications = {
    own: { id: "own", recipientId: "one", message: "One private update", createdAt: "2026-10-15T02:00:00Z" },
    read: { id: "read", ownerId: "one", read: true, createdAt: "2026-10-15T01:00:00Z" },
    other: { id: "other", userId: "two", message: "Two private update" },
    legacy: { id: "legacy", message: "No confirmed recipient" },
    conflict: { id: "conflict", recipientId: "one", ownerId: "two" },
  }; });
  const call = async (method: string, suffix = "", id = "", query: unknown = {}) => {
    let status = 200;
    const reply = { status(code: number) { status = code; return this; }, send(body: unknown) { return { status, body }; } } as unknown as FastifyReply;
    return await handleNotificationRoute({ method, path: `/api/notifications${suffix}` } as RouteDefinition, { params: { id }, query } as FastifyRequest, reply, { id: "one", permissions: ["workflow:read"] } as CurrentUser, { repository, config: { apiBasePath: "/api" } } as HandlerServices) as { status: number; body: { data: Array<{ id: string }> & { markedRead: number; deleted: boolean }; meta: { total: number } } };
  };
  return { repository, call };
}

test("notification listing enforces recipient scope, unread filtering and pagination", async () => {
  const { call } = await fixture();
  const page = await call("GET", "", "", { unreadOnly: "true", limit: 1 });
  expect(page.body.data.map(item => item.id)).toEqual(["own"]);
  expect(page.body.meta.total).toBe(1);
  expect((await call("GET")).body.data.map(item => item.id)).toEqual(["own", "read"]);
});
test.each(["other", "legacy", "conflict"])("%s cannot be acknowledged or deleted by another user", async id => {
  const { call, repository } = await fixture();
  expect((await call("PATCH", "/:id/read", id)).status).toBe(404);
  expect((await call("DELETE", "/:id", id)).body.data.deleted).toBe(false);
  expect((await repository.snapshot()).notifications[id]).toBeDefined();
});
test("mark-all acknowledges only the current user's confirmed notifications", async () => {
  const { call, repository } = await fixture();
  expect((await call("PATCH", "/read-all")).body.data.markedRead).toBe(1);
  const saved = (await repository.snapshot()).notifications;
  expect(saved.own?.read).toBe(true); expect(saved.other?.read).toBeUndefined(); expect(saved.legacy?.read).toBeUndefined();
});
