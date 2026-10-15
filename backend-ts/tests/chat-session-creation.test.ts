import { describe, expect, test } from "vitest";
import type { FastifyReply, FastifyRequest } from "fastify";
import { createChat, deleteChat } from "../src/http/handlers/chat-sessions.js";
import { Repository, restoreState } from "../src/repository/store.js";
import { splitFirestoreState, assembleFirestoreState } from "../src/storage/firestore-record-layout.js";
import type { CurrentUser, HandlerServices } from "../src/http/handlers/common.js";

const actor = { id: "owner", role: "Client", permissions: ["chat:use", "workflow:read_own", "workflow:run_own", "execution:read_own"] } as CurrentUser;
function context(repository = new Repository(null)) {
  const services = { repository } as HandlerServices;
  const create = async (body: unknown, user = actor) => {
    let status = 200;
    const reply = { status(code: number) { status = code; return this; }, send(value: unknown) { return { status, body: value }; } } as unknown as FastifyReply;
    return await createChat({ body } as FastifyRequest, reply, user, services) as { status: number; body: { data: { id: string; title: string } } };
  };
  return { repository, services, create };
}
const key = "creation-request-000001";
describe("durable chat creation identity", () => {
  test("concurrent duplicates recover one session; a replay preserves a renamed conversation", async () => {
    const fixture = context();
    const [first, duplicate] = await Promise.all([fixture.create({ title: "Edit: Report", idempotencyKey: key }), fixture.create({ title: "Edit: Report", idempotencyKey: key })]);
    expect(first.status).toBe(201); expect(duplicate.status).toBe(200);
    expect(duplicate.body.data.id).toBe(first.body.data.id);
    await fixture.repository.mutate(state => { state.chats[first.body.data.id]!.title = "Renamed"; });
    const replay = await fixture.create({ title: "Edit: Report", idempotencyKey: key });
    expect(replay.body.data.title).toBe("Renamed");
    expect(Object.keys((await fixture.repository.snapshot()).chats)).toHaveLength(1);
  });
  test("a committed request whose response is lost recovers after state reload without exposing the receipt", async () => {
    const fixture = context();
    const first = await fixture.create({ title: "Report", idempotencyKey: key });
    const state = await fixture.repository.snapshot();
    expect(assembleFirestoreState(splitFirestoreState(state))).toEqual(state);
    const stored = restoreState(Buffer.from(JSON.stringify(state)));
    const reopened = context();
    await reopened.repository.mutate(state => { Object.assign(state, stored); });
    const replay = await reopened.create({ title: "Report", idempotencyKey: key });
    expect(replay.body.data.id).toBe(first.body.data.id);
    expect(JSON.stringify(replay)).not.toContain(key);
    expect(Object.keys((await reopened.repository.snapshot()).chats)).toHaveLength(1);
  });
  test("the same actor cannot change a creation request, but another actor has a separate scope", async () => {
    const fixture = context();
    const first = await fixture.create({ title: "Report", idempotencyKey: key });
    await expect(fixture.create({ title: "Different", idempotencyKey: key })).rejects.toMatchObject({ status: 409 });
    const other = await fixture.create({ title: "Different", idempotencyKey: key }, { ...actor, id: "other" });
    expect(other.body.data.id).not.toBe(first.body.data.id);
  });
  test("deleting a conversation does not let a delayed duplicate resurrect it", async () => {
    const fixture = context();
    await fixture.repository.mutate(state => { state.users.owner = { id: "owner", roleId: "role_client", name: "Owner", email: "owner@example.test", status: "Active", permissionOverrides: [], initials: "O", departmentId: null, lastLoginAt: null, createdAt: new Date().toISOString() }; });
    const first = await fixture.create({ title: "Report", idempotencyKey: key });
    await deleteChat({ params: { id: first.body.data.id } } as unknown as FastifyRequest, { send: (value: unknown) => value } as FastifyReply, actor, fixture.services);
    await expect(fixture.create({ title: "Report", idempotencyKey: key })).rejects.toMatchObject({ status: 410 });
    expect(Object.keys((await fixture.repository.snapshot()).chats)).toHaveLength(0);
  });
  test.each([null, 42, "", "short", "a".repeat(129), "invalid key with spaces"])("rejects malformed creation identity %j before mutating", async idempotencyKey => {
    const fixture = context();
    await expect(fixture.create({ idempotencyKey })).rejects.toMatchObject({ status: 400 });
    expect(Object.keys((await fixture.repository.snapshot()).chats)).toHaveLength(0);
  });
  test.each([42, null, [], {}, "x".repeat(201)])("rejects malformed or oversized chat title %j before mutating", async title => {
    const fixture = context();
    await expect(fixture.create({ title })).rejects.toMatchObject({ status: 400 });
    expect(Object.keys((await fixture.repository.snapshot()).chats)).toHaveLength(0);
  });
  test.each([undefined, "", "   "])("normalizes an omitted or blank title %j to the friendly default", async title => {
    const fixture = context();
    const body = title === undefined ? {} : { title };
    expect((await fixture.create(body)).body.data.title).toBe("New conversation");
  });
  test("legacy requests without an identity remain supported", async () => {
    const fixture = context();
    const first = await fixture.create({ title: "Legacy" });
    const second = await fixture.create({ title: "Legacy" });
    expect(first.status).toBe(201); expect(second.body.data.id).not.toBe(first.body.data.id);
  });
  test("older snapshots initialize receipts, but present damaged receipts fail closed", () => {
    const fixture = context();
    return fixture.repository.snapshot().then(state => {
      const { chatCreationReceipts: _receipts, ...legacy } = state;
      expect(restoreState(Buffer.from(JSON.stringify(legacy))).chatCreationReceipts).toEqual({});
      for (const value of [null, [], { invalid: { profile: "wrong" } }]) {
        expect(() => restoreState(Buffer.from(JSON.stringify({ ...state, chatCreationReceipts: value })))).toThrow("Invalid chat creation receipt");
      }
    });
  });
});
