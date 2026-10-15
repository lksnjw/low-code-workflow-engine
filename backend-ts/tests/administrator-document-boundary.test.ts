import { afterEach, expect, test, vi } from "vitest";
import { Repository } from "../src/repository/store.js";
import { loadConfig } from "../src/config/config.js";
import { processAdministratorErpChat } from "../src/http/handlers/chat-erp-actions.js";
import { ReadAdmissionUnavailableError } from "../src/tools/read-tool-broker.js";

const calls = vi.hoisted(() => ({ read: vi.fn(), loop: vi.fn() }));
vi.mock("../src/tools/read-tool-broker.js", async importOriginal => ({ ...await importOriginal<typeof import("../src/tools/read-tool-broker.js")>(), dispatchReadTool: calls.read }));
vi.mock("../src/agent/erp-chat-loop.js", () => ({ runErpChatLoop: calls.loop }));
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

async function setup(readOnlyHint = true) {
  const repository = new Repository(null);
  await repository.mutate(state => {
    state.users.owner = { id: "owner", name: "Owner", email: "owner@example.test", roleId: "role_admin", permissionOverrides: [], status: "Active", initials: "O", departmentId: null, lastLoginAt: null, createdAt: "" };
    state.chats.chat = { id: "chat", ownerId: "owner", title: "Registration", createdAt: "", updatedAt: "", messageCount: 1, messages: [{ id: "request", role: "user", text: "Find my registration form", createdAt: "" }] };
  });
  const user = (await repository.effectiveUser("owner"))!;
  const rawTool = { name: "pipeline-library-resolve", inputSchema: { type: "object", properties: { document_id: { type: "string" }, access_token: { type: "string" } }, required: ["document_id", "access_token"], additionalProperties: false }, annotations: { readOnlyHint } };
  const executeAdministratorTool = vi.fn();
  const services: any = { repository, config: { ...loadConfig({ APP_ENV: "test" }), erpbridgeAdminChatActions: true }, providerRuntime: { configured: true, binding: { model: "fixture" } }, erpbridgeSession: { admissionBinding: "fixture", listTools: vi.fn(async () => [rawTool]), executeAdministratorTool } };
  const input: any = { services, user, sessionId: "chat", stored: { session: { id: "chat" }, userMessage: { id: "request" }, priorMessages: [] }, content: "Find my registration form", traceId: "private-library" };
  calls.read.mockResolvedValue({ structuredContent: { document_id: "doc", form_fields: { customer_name: "Synthetic Customer" } } });
  calls.loop.mockImplementation(async value => { if (value.catalog.length) await value.read(value.catalog[0], { document_id: "doc" }); return { text: "Read boundary checked", toolSteps: [], erpActionProposals: [], blocked: false }; });
  return { rawTool, input, executeAdministratorTool, repository };
}

test("administrator document chat hides transport scope inputs and routes through the reviewed, owner-bound read broker", async () => {
  const s = await setup(); await processAdministratorErpChat(s.input, "QUERY", work => s.repository.mutate(work));
  const tool = calls.loop.mock.calls[0]![0].catalog[0]; expect(tool.inputSchema.required).toEqual(["document_id"]); expect(tool.inputSchema.properties).not.toHaveProperty("access_token");
  expect(s.rawTool.inputSchema.required).toContain("access_token");
  expect(calls.read).toHaveBeenCalledWith(s.input.services, "owner", "pipeline-library-resolve", { document_id: "doc" }, expect.objectContaining({ sessionId: "chat", beforeDispatch: expect.any(Function) }));
  expect(s.executeAdministratorTool).not.toHaveBeenCalled();
});

test("an unavailable private-document contract cannot fall back to raw administrator dispatch", async () => {
  const s = await setup(); calls.read.mockRejectedValueOnce(new ReadAdmissionUnavailableError());
  await expect(processAdministratorErpChat(s.input, "QUERY", work => s.repository.mutate(work))).rejects.toBeInstanceOf(ReadAdmissionUnavailableError);
  expect(s.executeAdministratorTool).not.toHaveBeenCalled();
});

test("a library tool without the read-only declaration is not offered as a raw administrator change", async () => {
  const s = await setup(false); await processAdministratorErpChat(s.input, "QUERY", work => s.repository.mutate(work));
  expect(calls.loop.mock.calls[0]![0].catalog).toEqual([]); expect(calls.read).not.toHaveBeenCalled(); expect(s.executeAdministratorTool).not.toHaveBeenCalled();
});

test.each(["allow", "deny"])("administrator ERP lookups send the exact read flag and preserve RAG %s", async decision => {
  const s = await setup();
  const tool = { name: "list_customers", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } };
  s.input.services.erpbridgeSession.listTools.mockResolvedValue([tool]);
  Object.assign(s.input.services.config, { ragPolicyAPIBaseURL: "https://rag.example.test", ragPolicyAPIKey: "fixture-key" });
  await s.repository.mutate(state => { state.settings.rbac = { enabled: true, localPolicyAgentEnabled: false }; });
  const transport = vi.fn<typeof fetch>(async () => Response.json({ decision, scope: "caller_scoped_customer_reference_read", execution_authorized: false, execution_performed: false, reason: "Exact caller-scoped read check" }));
  vi.stubGlobal("fetch", transport);
  const result = processAdministratorErpChat(s.input, "TOOL_CALL", work => s.repository.mutate(work));
  if (decision === "deny") await expect(result).rejects.toMatchObject({ status: 409 });
  else await result;
  expect(transport).toHaveBeenCalledOnce();
  expect(transport.mock.calls[0]![0]).toBe("https://rag.example.test/api/policy/preflight");
  expect(JSON.parse(String(transport.mock.calls[0]![1]!.body))).toMatchObject({ actor: { user_id: "owner", role: "Platform Admin" }, context: { action: "list_customers", readOnly: true } });
  expect(s.executeAdministratorTool).toHaveBeenCalledTimes(decision === "allow" ? 1 : 0);
  expect((await s.repository.snapshot()).settings.erpChatActions).toBeUndefined();
});

test.each([false, undefined, "true"])("a non-read declaration %s cannot acquire the administrator RAG read scope", async readOnlyHint => {
  const s = await setup();
  s.input.services.erpbridgeSession.listTools.mockResolvedValue([{ name: "create_customer", inputSchema: { type: "object" }, annotations: { readOnlyHint } }]);
  const transport = vi.fn(); vi.stubGlobal("fetch", transport);
  await expect(processAdministratorErpChat(s.input, "TOOL_CALL", work => s.repository.mutate(work))).rejects.toMatchObject({ status: 403 });
  expect(transport).not.toHaveBeenCalled(); expect(s.executeAdministratorTool).not.toHaveBeenCalled();
});
