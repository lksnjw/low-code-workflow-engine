import { randomUUID } from "node:crypto";
import { expect, test, vi } from "vitest";
import { loadConfig } from "../src/config/config.js";
import { Repository } from "../src/repository/store.js";
import { processStoredChat } from "../src/http/handlers/chat.js";
import { executeAdministratorChatAction } from "../src/tools/admin-erp-actions.js";
import type { QueryTurnResult } from "../src/analysisprovider/query-types.js";
import { workflowContentHash } from "../src/parser/workflow.js";

const orders = { name: "list_sales_orders", annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties: { limit_page_length: { type: "integer" } }, required: ["limit_page_length"], additionalProperties: false } };
const senders = { name: "list_senders", annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties: {}, additionalProperties: false } };
const email = { name: "send_email", annotations: { readOnlyHint: false }, inputSchema: { type: "object", properties: {
  to: { type: "array", items: { type: "string" } }, sender: { type: "string" }, subject: { type: "string" }, body: { type: "string" },
}, required: ["to", "sender", "subject", "body"], additionalProperties: false } };
const invoke = (name: string, args: Record<string, unknown>): QueryTurnResult => ({ text: "", toolCalls: [{ id: randomUUID(), name, arguments: args }], stopReason: "tool_calls", inputTokens: 1, outputTokens: 1, measured: true });
const text = (value: string): QueryTurnResult => ({ text: value, toolCalls: [], stopReason: "stop", completionConfirmed: true, inputTokens: 1, outputTokens: 1, measured: true });
const fields = { to: ["recipient@example.test"], sender: "accounts@example.test", subject: "Sales orders", body: "Sales order SO-1001, total 125.00. First two records only; not an all-orders report." };
async function fixture(turns: QueryTurnResult[]) {
  const repository = new Repository(null);
  await repository.mutate(state => {
    state.users.admin = { id: "admin", name: "Admin", email: "admin@example.test", roleId: "role_admin", status: "Active", permissionOverrides: [], initials: "AD", departmentId: null, createdAt: "", lastLoginAt: null };
    state.chats.chat = { id: "chat", ownerId: "admin", title: "Orders email", messages: [{ id: "request", role: "user", text: "get the orders and send an email to recipient@example.test" }], messageCount: 1, createdAt: "", updatedAt: "" };
  });
  const user = (await repository.effectiveUser("admin"))!;
  const queryWithTools = vi.fn(async () => { const next = turns.shift(); if (!next) throw new Error("Unexpected model turn"); return next; });
  const executeAdministratorTool = vi.fn(async (tool, _args, _actor, checkpoint) => {
    await checkpoint();
    return { content: [], structuredContent: tool.name === orders.name ? [{ name: "SO-1001", grand_total: 125 }] : tool.name === senders.name ? [{ email: "accounts@example.test" }] : { accepted: true } };
  });
  const services: any = { repository, config: { ...loadConfig({ APP_ENV: "test" }), erpbridgeAdminChatActions: true },
    registries: { hash: () => "fixture", snapshot: () => ({ tools: [] }) }, providerRuntime: { configured: true, queryWithTools, binding: { model: "fixture" } },
    erpbridgeSession: { available: true, admissionBinding: "email-connection", listTools: vi.fn(async () => [orders, senders, email]), executeAdministratorTool } };
  const input: any = { services, user, sessionId: "chat", traceId: "email-routing", content: "get the orders and send an email to recipient@example.test", body: {},
    stored: { session: { id: "chat" }, userMessage: { id: "request" }, priorMessages: [] } };
  return { repository, user, services, input, executeAdministratorTool, queryWithTools };
}

test("one-off read-and-email uses live agent contracts, fills the body and stops at exact inline confirmation", async () => {
  const f = await fixture([
    invoke("erp_tool_schema", { toolName: orders.name }), invoke("erp_invoke", { toolName: orders.name, arguments: { limit_page_length: 2 } }),
    invoke("erp_tool_schema", { toolName: senders.name }), invoke("erp_invoke", { toolName: senders.name, arguments: {} }),
    invoke("erp_tool_schema", { toolName: email.name }), invoke("erp_invoke", { toolName: email.name, arguments: fields }),
  ]);
  const response: any = await processStoredChat(f.input), artifacts = response.data.assistantMessage.artifacts;
  expect(artifacts.intent).toBe("EMAIL_DELIVERY"); expect(artifacts).not.toHaveProperty("emailDraft");
  expect(artifacts.toolSteps.map((step: any) => step.toolName)).toEqual([orders.name, senders.name]);
  expect(artifacts.erpActionProposals).toHaveLength(1);
  const action = artifacts.erpActionProposals[0];
  expect(action).toMatchObject({ toolName: email.name, arguments: fields, status: "PENDING" });
  expect(f.executeAdministratorTool.mock.calls.map(call => call[0].name)).toEqual([orders.name, senders.name]);
  expect(response.data.answer).toContain("confirm"); expect(response.data.answer).not.toContain("Email draft saved");
  expect(Object.keys((await f.repository.snapshot()).workflows)).toHaveLength(0);
  const confirmed = await executeAdministratorChatAction(f.services, f.user, "chat", action.id, { reviewHash: action.reviewHash, decisionKey: randomUUID() });
  expect(confirmed.status).toBe("SUCCEEDED"); expect(confirmed.receipt).toMatchObject({ structuredContent: { accepted: true } });
  await executeAdministratorChatAction(f.services, f.user, "chat", action.id, { reviewHash: action.reviewHash, decisionKey: randomUUID() });
  expect(f.executeAdministratorTool.mock.calls.map(call => call[0].name)).toEqual([orders.name, senders.name, email.name]);
  expect((await f.repository.snapshot()).chats.chat!.messages.at(-1)!.text).not.toMatch(/delivered|successfully sent/i);
});

test("an ambiguous order request asks its business question instead of showing an empty email form", async () => {
  const f = await fixture([text("Do you mean sales orders or purchase orders?")]);
  const response: any = await processStoredChat(f.input);
  expect(response.data.answer).toBe("Do you mean sales orders or purchase orders?");
  expect(response.data.assistantMessage.artifacts).not.toHaveProperty("emailDraft");
  expect(f.executeAdministratorTool).not.toHaveBeenCalled();
});

test("a selected canvas node does not role-block an administrator's ERP lookup", async () => {
  const f = await fixture([
    invoke("erp_tool_schema", { toolName: orders.name }), invoke("erp_invoke", { toolName: orders.name, arguments: { limit_page_length: 2 } }),
    text("The ERP returned sales order SO-1001."),
  ]);
  f.input.content = "What are the sales orders?";
  const yaml = 'name: Reference\ntrigger:\n  type: manual\nsteps:\n  - id: reference\n    action: list_sales_orders\n    parameters: {}';
  await f.repository.mutate(state => { state.workflows.reference = { id: "reference", owner: { id: "admin", name: "Admin" }, assignedUserIds: [], draftVersion: 1, yaml, archived: false } as any; });
  f.input.body.nodeContext = { workflowId: "reference", nodeId: "reference", baseVersion: 1, baseHash: workflowContentHash(yaml) };
  const response: any = await processStoredChat(f.input);
  expect(response.data.assistantMessage.artifacts.toolSteps.map((step: any) => step.toolName)).toEqual([orders.name]);
  expect(f.executeAdministratorTool).toHaveBeenCalledOnce();
  expect(response.data.answer).not.toContain("No currently approved ERP read tool");
  expect((await f.repository.snapshot()).workflows.reference!.yaml).toBe(yaml);
});

test("non-administrators cannot acquire the native email path just because the token exposes it", async () => {
  const f = await fixture([]);
  await f.repository.mutate(state => {
    state.roles.manager = { id: "manager", name: "Manager", description: "fixture", permissions: ["chat:use"], createdAt: "" };
    state.users.admin!.roleId = "manager";
  });
  f.input.user = (await f.repository.effectiveUser("admin"))!;
  const response: any = await processStoredChat(f.input);
  expect(response.data.assistantMessage.artifacts.reportReason).toBe("NO_ADMITTED_READ_TOOLS");
  expect(f.executeAdministratorTool).not.toHaveBeenCalled(); expect(f.queryWithTools).not.toHaveBeenCalled();
});

test("server-disabled administrator mode retains the reviewed connector route", async () => {
  const f = await fixture([]); f.services.config.erpbridgeAdminChatActions = false;
  const response: any = await processStoredChat(f.input);
  expect(response.data.assistantMessage.artifacts.reportReason).toBe("NO_ADMITTED_READ_TOOLS");
  expect(f.executeAdministratorTool).not.toHaveBeenCalled();
});
