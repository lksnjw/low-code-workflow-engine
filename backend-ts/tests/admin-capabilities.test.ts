import { expect, test, vi } from "vitest";
import { Repository } from "../src/repository/store.js";
import { loadConfig } from "../src/config/config.js";
import { processStoredChat } from "../src/http/handlers/chat.js";
import { processAdministratorCapabilities } from "../src/http/handlers/chat-erp-actions.js";
import { classifyIntent } from "../src/agent/intent-classifier.js";
import { workflowContentHash } from "../src/parser/workflow.js";

async function setup(selected = false) {
  const repository = new Repository(null);
  const yaml = 'name: Reference\ntrigger:\n  type: manual\nsteps:\n  - id: reference\n    action: list_items\n    parameters: {}';
  await repository.mutate(state => {
    state.users.admin = { id: "admin", name: "Admin", email: "admin@example.test", roleId: "role_admin", status: "Active",
      permissionOverrides: [], departmentId: null, initials: "AD", createdAt: new Date().toISOString(), lastLoginAt: null };
    state.chats.chat = { id: "chat", ownerId: "admin", title: "Capabilities", messages: [{ id: "request", role: "user", text: "What can I do in ERP?" }],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messageCount: 1 };
    if (selected) state.workflows.reference = { id: "reference", owner: { id: "admin", name: "Admin" }, assignedUserIds: [], draftVersion: 1, yaml, archived: false } as any;
  });
  const user = (await repository.effectiveUser("admin"))!;
  const listTools = vi.fn(async () => [
    { name: "list_items", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
    { name: "create_customer", inputSchema: { type: "object" }, annotations: { readOnlyHint: false } },
  ]);
  const executeAdministratorTool = vi.fn(), queryWithTools = vi.fn();
  const services: any = { repository, config: { ...loadConfig({ APP_ENV: "test" }), erpbridgeAdminChatActions: true },
    registries: { snapshot: () => ({ tools: [] }) },
    providerRuntime: { configured: false, queryWithTools }, erpbridgeSession: { available: true, listTools, executeAdministratorTool } };
  const input: any = { services, user, sessionId: "chat", traceId: "admin-capabilities", content: "What can I do in ERP?", body: {},
    stored: { session: { id: "chat" }, userMessage: { id: "request" }, priorMessages: [] } };
  if (selected) input.body.nodeContext = { workflowId: "reference", nodeId: "reference", baseVersion: 1, baseHash: workflowContentHash(yaml) };
  return { repository, input, services, user, listTools, executeAdministratorTool, queryWithTools };
}

test("the real chat capability route shows the admin token catalog without model inference or per-role read reviews", async () => {
  const f = await setup(), result: any = await processStoredChat(f.input);
  expect(result.data.assistantMessage.artifacts.capabilities).toMatchObject({ offeredCount: 2, readOnlyCount: 1, changeCount: 1, accessMode: "administrator-token" });
  expect(result.data.answer).toContain("Super Admin"); expect(result.data.answer).toContain("`create_customer`");
  expect(result.data.answer).toContain("Review and confirm"); expect(result.data.answer).not.toContain("No ERP tools are currently available for your role");
  expect(f.listTools).toHaveBeenCalledOnce(); expect(f.queryWithTools).not.toHaveBeenCalled(); expect(f.executeAdministratorTool).not.toHaveBeenCalled();
  expect(Object.keys((await f.repository.snapshot()).workflows)).toHaveLength(0);
});

test.each(["how many tools are there in the erp bridge", "list all tools", "What tools are available in ERP?"])("catalog request uses complete live metadata, not model search: %s", async content => {
  const f = await setup(true);
  f.input.content = content;
  f.services.config.chatIntentRouting = "agent";
  f.services.config.pipelineAPIBaseURL = "https://pipeline.example.test";
  f.services.config.pipelineAPIKey = "fixture-only";
  f.services.providerRuntime.configured = true;
  const tools = Array.from({ length: 163 }, (_, index) => ({ name: `remote_${index}`, inputSchema: { type: "object" }, annotations: { readOnlyHint: index < 139 } }));
  f.listTools.mockResolvedValueOnce(tools);
  expect(classifyIntent(content, { workflowContext: true, nodeContext: true })).toBe("CAPABILITIES");
  const result: any = await processStoredChat(f.input);
  expect(result.data.assistantMessage.artifacts.capabilities).toMatchObject({ offeredCount: 163, readOnlyCount: 139, changeCount: 24 });
  expect(result.data.assistantMessage.artifacts.capabilities.tools.map((tool: any) => tool.name)).toEqual(tools.map(tool => tool.name));
  expect(result.data.answer).toContain("`remote_162`");
  expect(f.queryWithTools).not.toHaveBeenCalled(); expect(f.executeAdministratorTool).not.toHaveBeenCalled();
});

test("the catalog size follows changed remote discovery, not a fixed expected count", async () => {
  const f = await setup();
  f.listTools.mockResolvedValueOnce([{ name: "new_remote_tool", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }]);
  const result: any = await processStoredChat(f.input);
  expect(result.data.assistantMessage.artifacts.capabilities.offeredCount).toBe(1);
  expect(result.data.answer).toContain("`new_remote_tool`"); expect(result.data.answer).not.toContain("163");
});

test.each(["missing", "unavailable", "discovery-failure"])("an admin %s connection is not misreported as an absent role grant", async kind => {
  const f = await setup();
  if (kind === "missing") f.services.erpbridgeSession = undefined;
  if (kind === "unavailable") f.services.erpbridgeSession.available = false;
  if (kind === "discovery-failure") f.listTools.mockRejectedValueOnce(new Error("private upstream credential"));
  const result: any = await processStoredChat(f.input);
  expect(result.data.answer).toContain("connection problem, not a missing role permission");
  expect(result.data.assistantMessage.artifacts.code).toMatch(/^ERPBRIDGE_/);
  expect(JSON.stringify(result)).not.toContain("private upstream"); expect(f.executeAdministratorTool).not.toHaveBeenCalled();
});

test("the empty token catalog does not invent capabilities or relax upstream token permissions", async () => {
  const f = await setup(); f.listTools.mockResolvedValueOnce([]);
  const result: any = await processStoredChat(f.input);
  expect(result.data.answer).toContain("token currently exposes no tools");
  expect(result.data.assistantMessage.artifacts.capabilities.offeredCount).toBe(0); expect(f.executeAdministratorTool).not.toHaveBeenCalled();
});

test("a forged admin role or committed revocation cannot acquire this catalog access", async () => {
  const f = await setup();
  await expect(processAdministratorCapabilities({ ...f.input, user: { ...f.user, roleId: "role_manager" } }, f.repository.mutate.bind(f.repository))).rejects.toMatchObject({ status: 403 });
  expect(f.listTools).not.toHaveBeenCalled();
  f.listTools.mockImplementationOnce(async () => {
    await f.repository.mutate(state => { state.users.admin!.status = "Suspended"; });
    return [];
  });
  await expect(processStoredChat(f.input)).rejects.toMatchObject({ status: 403 });
  expect((await f.repository.snapshot()).chats.chat!.messages).toHaveLength(1);
});
