import { randomUUID } from "node:crypto";
import { expect, test, vi } from "vitest";
import { loadConfig } from "../src/config/config.js";
import { Repository } from "../src/repository/store.js";
import { executeAdministratorChatAction, getAdministratorChatAction, proposeAdministratorChatAction } from "../src/tools/admin-erp-actions.js";
import { renderBrandedEmail } from "../src/delivery/branded-email.js";
const tool = { name: "create_item", annotations: { readOnlyHint: false }, inputSchema: { type: "object", properties: { item_code: { type: "string" } }, required: ["item_code"], additionalProperties: false } };
async function setup() {
  const repository = new Repository(null);
  await repository.mutate(state => {
    state.users.admin = { id: "admin", roleId: "role_admin", permissionOverrides: [], status: "Active", name: "Admin", email: "admin@example.test", departmentId: null, initials: "AD", createdAt: new Date().toISOString(), lastLoginAt: null };
    state.chats.chat = { id: "chat", ownerId: "admin", title: "QA", messages: [{ id: "request", role: "user", text: "Create QA-1" }], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messageCount: 1 };
  });
  const user = (await repository.effectiveUser("admin"))!;
  const executeAdministratorTool = vi.fn(async (_tool, _args, _actor, checkpoint) => { await checkpoint(); return { content: [], structuredContent: { name: "QA-1", doctype: "Item" } }; });
  const services: any = { config: { ...loadConfig({ APP_ENV: "test" }), erpbridgeAdminChatActions: true }, repository,
    erpbridgeSession: { admissionBinding: "connection-v1", executeAdministratorTool } };
  const propose = (args = { item_code: "QA-1" }) => proposeAdministratorChatAction(services, user, "chat", "request", "Create QA-1", tool, args);
  const confirm = (action: any, extra = {}) => executeAdministratorChatAction(services, user, "chat", action.id, { reviewHash: action.reviewHash, decisionKey: randomUUID(), ...extra });
  return { services, repository, user, executeAdministratorTool, propose, confirm };
}
test("an exact administrator chat proposal saves no workflow and invokes no ERP tool", async () => {
  const s = await setup(), p = await s.propose(); expect(p.status).toBe("PENDING"); expect(s.executeAdministratorTool).not.toHaveBeenCalled();
  const state = await s.repository.snapshot(); expect(Object.keys(state.workflows)).toHaveLength(0); expect(p).not.toHaveProperty("erpCredentialSecret");
});

test("branded HTML is frozen BEFORE exact review; confirmation sends the same text and HTML once", async () => {
  const s = await setup();
  const emailTool = { name: "resend-email-send", annotations: { readOnlyHint: false }, inputSchema: { type: "object", additionalProperties: false,
    properties: { from: { type: "string" }, to: { type: "array", items: { type: "string" } }, subject: { type: "string" }, text: { type: "string" }, html: { type: "string" }, idempotency_key: { type: "string" } },
    required: ["from", "to", "subject", "text", "idempotency_key"] } };
  const args = { from: "sender@example.test", to: ["recipient@example.test"], subject: "Order report", text: "## Sales orders\n| Order | Total |\n|---|---|\n| SO-1 | 12,000 |\n\nOne record retrieved.", idempotency_key: "fixed-confirmed-email-key" };
  const proposal = await proposeAdministratorChatAction(s.services, s.user, "chat", "request", "Email the orders", emailTool, args);
  expect(proposal.arguments).toEqual({ ...args, html: renderBrandedEmail(args.subject, args.text) });
  expect(s.executeAdministratorTool).not.toHaveBeenCalled();
  const fresh = await getAdministratorChatAction(s.services, s.user, "chat", proposal.id);
  expect(fresh.reviewHash).toBe(proposal.reviewHash); expect(fresh.arguments).toEqual(proposal.arguments);
  await s.confirm(proposal); await s.confirm(proposal);
  expect(s.executeAdministratorTool).toHaveBeenCalledOnce();
  expect(s.executeAdministratorTool.mock.calls[0]![1]).toEqual(fresh.arguments);
});

test("changing the reviewed email HTML cannot bypass the original review hash", async () => {
  const s = await setup();
  const emailTool = { name: "send_email", annotations: { readOnlyHint: false }, inputSchema: { type: "object", properties: {
    to: { type: "array", items: { type: "string" } }, subject: { type: "string" }, text: { type: "string" }, html: { type: "string" } } } };
  const proposal = await proposeAdministratorChatAction(s.services, s.user, "chat", "request", "Send a message", emailTool, { to: ["recipient@example.test"], subject: "Details", text: "Reviewed details" });
  await s.repository.mutate(state => { (state.settings.erpChatActions as any)[proposal.id].arguments.html = "Different message"; });
  await expect(s.confirm(proposal)).rejects.toMatchObject({ status: 409 });
  expect(s.executeAdministratorTool).not.toHaveBeenCalled();
});
test("administrator self-confirmation dispatches once, saves the real response, and duplicates never replay", async () => {
  const s = await setup(), p = await s.propose(); const result = await s.confirm(p);
  expect(result.status).toBe("SUCCEEDED"); expect(result.receipt).toMatchObject({ structuredContent: { name: "QA-1" } });
  expect((await s.confirm(p)).status).toBe("SUCCEEDED"); expect(s.executeAdministratorTool).toHaveBeenCalledOnce();
  expect((await s.repository.snapshot()).chats.chat!.messages.at(-1)!.text).toContain("No workflow was generated");
});
test("an entered write timeout becomes unknown, and cannot be replayed with a new decision key", async () => {
  const s = await setup(), p = await s.propose();
  s.executeAdministratorTool.mockImplementationOnce(async (_tool, _args, _actor, checkpoint) => { await checkpoint(); throw new Error("lost response"); });
  expect((await s.confirm(p)).status).toBe("OUTCOME_UNKNOWN"); expect((await s.confirm(p)).status).toBe("OUTCOME_UNKNOWN"); expect(s.executeAdministratorTool).toHaveBeenCalledOnce();
  await s.repository.mutate(state => { state.chats.chat!.messages.push({ id: "new-request", role: "user", text: "Try again" }); });
  await expect(proposeAdministratorChatAction(s.services, s.user, "chat", "new-request", "Try again", tool, { item_code: "QA-1" })).rejects.toMatchObject({ status: 409 });
});
test("an acknowledged remote failure remains a failure, not a successful create", async () => {
  const s = await setup(), p = await s.propose();
  s.executeAdministratorTool.mockImplementationOnce(async (_tool, _args, _actor, checkpoint) => { await checkpoint(); return { content: [], isError: true } as any; });
  expect((await s.confirm(p)).status).toBe("FAILED"); expect((await s.confirm(p)).status).toBe("FAILED"); expect(s.executeAdministratorTool).toHaveBeenCalledOnce();
});
test("schema/required fields and credential arguments are checked before a proposal", async () => {
  const s = await setup(); await expect(s.propose({} as any)).rejects.toMatchObject({ status: 422 });
  await expect(s.propose({ item_code: ["QA-1"] } as any)).rejects.toMatchObject({ status: 422 });
  expect(s.executeAdministratorTool).not.toHaveBeenCalled();
});
test("a server-disabled mode, forged role name and a foreign owner grant no administrator action access", async () => {
  const s = await setup(), p = await s.propose();
  await expect(getAdministratorChatAction(s.services, { ...s.user, roleId: "role_builder" }, "chat", p.id)).rejects.toMatchObject({ status: 403 });
  await expect(getAdministratorChatAction(s.services, { ...s.user, id: "other" }, "chat", p.id)).rejects.toBeDefined();
  s.services.config.erpbridgeAdminChatActions = false; await expect(s.confirm(p)).rejects.toMatchObject({ status: 403 });
  expect(s.executeAdministratorTool).not.toHaveBeenCalled();
});
test.each(["arguments", "connection", "hash", "expired"])("%s changes block confirmation before ERP entry", async kind => {
  const s = await setup(), p = await s.propose();
  if (kind === "connection") s.services.erpbridgeSession.admissionBinding = "different";
  if (kind === "arguments" || kind === "expired") await s.repository.mutate(state => { const a = (state.settings.erpChatActions as any)[p.id]; if (kind === "arguments") a.arguments.item_code = "OTHER"; else a.expiresAt = "2000-01-01T00:00:00.000Z"; });
  await expect(s.confirm(p, kind === "hash" ? { reviewHash: "a".repeat(64) } : {})).rejects.toMatchObject({ status: 409 }); expect(s.executeAdministratorTool).not.toHaveBeenCalled();
});
test("concurrent confirmations serialize at the durable intent rather than producing two writes", async () => {
  const s = await setup(), p = await s.propose(); let dispatches = 0;
  s.executeAdministratorTool.mockImplementation(async (_tool, _args, _actor, checkpoint) => { await checkpoint(); dispatches++; return { content: [], structuredContent: { name: "QA-1", doctype: "Item" } }; });
  await Promise.allSettled([s.confirm(p), s.confirm(p)]); expect(dispatches).toBe(1);
});
