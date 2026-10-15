import { afterEach, expect, test, vi } from "vitest";
import { loadConfig } from "../src/config/config.js";
import { Repository } from "../src/repository/store.js";
import type { HandlerServices } from "../src/http/handlers/common.js";
import { directLibraryCatalog, dispatchDirectLibraryRead } from "../src/documents/direct-library.js";
import { processStoredChat } from "../src/http/handlers/chat.js";
import { ASSISTANT_SKILLS } from "../src/agent/assistant-skills.js";
import type { QueryTurnResult } from "../src/analysisprovider/query-types.js";
import type { FastifyRequest } from "fastify";
import { validateToolSchemaProfile } from "../src/tools/tool-input-schema.js";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function fixture(role = "role_admin") {
  const repository = new Repository();
  await repository.mutate(state => {
    state.settings.rbac = { enabled: false, localPolicyAgentEnabled: false };
    state.roles.manager = { ...state.roles.role_admin!, id: "manager", name: "Manager", permissions: ["chat:use"] };
    state.users.owner = { id: "owner", name: "Owner", email: "owner@example.test", roleId: role, permissionOverrides: [], status: "Active", initials: "O", departmentId: null, lastLoginAt: null, createdAt: "" };
    state.chats.chat = { id: "chat", ownerId: "owner", title: "Documents", createdAt: "", updatedAt: "", messageCount: 1, messages: [{ id: "message", role: "user", text: "Show the saved registration", createdAt: "" }] };
    state.chats.other = { ...state.chats.chat, id: "other", ownerId: "another" };
  });
  const config = loadConfig({ APP_ENV: "test", CHAT_INTENT_ROUTING: "agent", PIPELINE_API_BASE_URL: "https://pipeline.example.test", PIPELINE_API_KEY: "test-service-key", PIPELINE_WORKSPACE_ID: "qa-direct" });
  return { services: { config, repository } as HandlerServices, user: (await repository.effectiveUser("owner"))! };
}
test("backend skills contain intake, retrieval, policy, ERP and workflow guidance", () => {
  expect(ASSISTANT_SKILLS.map(value => value.id)).toEqual(["document-intake", "document-retrieval", "policy-checking", "erp-record-actions", "workflow-automation"]);
});
test("model catalog is code-owned and contains no service token or storage authority", async () => {
  const { services } = await fixture();
  expect(directLibraryCatalog(services)).toHaveLength(3);
  for (const tool of directLibraryCatalog(services)) expect(validateToolSchemaProfile(tool.inputSchema)).toEqual([]);
  expect(JSON.stringify(directLibraryCatalog(services))).not.toMatch(/test-service-key|access_token|workspaceId|actorId/);
  expect(directLibraryCatalog({ config: { ...services.config, pipelineAPIKey: "" } })).toEqual([]);
});
test.each(["role_admin", "manager"])("%s retrieves through the backend without any ERPBridge session", async role => {
  const { services, user } = await fixture(role), checkpoint = vi.fn(async () => {});
  const transport = vi.fn<typeof fetch>(async () => Response.json({ document_id: "doc-1", form_fields: { customer_name: "Sample Customer" } })); vi.stubGlobal("fetch", transport);
  const result = await dispatchDirectLibraryRead(services, user, "chat", "pipeline-library-resolve", { document_id: "doc-1" }, { beforeDispatch: checkpoint });
  expect(result.structuredContent).toMatchObject({ document_id: "doc-1" }); expect(checkpoint).toHaveBeenCalledOnce();
  const [url, init] = transport.mock.calls[0]!;
  expect(String(url)).toBe("https://pipeline.example.test/v1/library/resolve");
  expect(JSON.parse(String(init!.body))).toEqual({ document_id: "doc-1" });
  const headers = init!.headers as Record<string, string>, scope = JSON.parse(Buffer.from(headers["X-Library-Scope"]!.split(".")[0]!, "base64url").toString());
  expect(scope).toMatchObject({ actorId: "owner", role: user.role, workspaceId: "qa-direct", readOnly: true, canUpload: false, canManage: false });
  expect(headers["X-API-Key"]).toBe("test-service-key");
  expect(JSON.stringify(result)).not.toContain("test-service-key");
});
test.each([{ access_token: "spoof" }, { actorId: "another" }, { collection: "all" }, { url: "https://attacker.test" }])("model cannot add private authority: %j", async extra => {
  const { services, user } = await fixture(), transport = vi.fn(); vi.stubGlobal("fetch", transport);
  await expect(dispatchDirectLibraryRead(services, user, "chat", "pipeline-library-search", { query: "person", ...extra })).rejects.toMatchObject({ status: 422 });
  expect(transport).not.toHaveBeenCalled();
});
test.each([0, 21, 1.5])("search limit %s is rejected before HTTP", async limit => {
  const { services, user } = await fixture(), transport = vi.fn(); vi.stubGlobal("fetch", transport);
  await expect(dispatchDirectLibraryRead(services, user, "chat", "pipeline-library-search", { query: "person", limit })).rejects.toMatchObject({ status: 422 }); expect(transport).not.toHaveBeenCalled();
});
test("another chat, suspended actor and a revoked chat grant do not dispatch", async () => {
  const { services, user } = await fixture("manager"), transport = vi.fn(); vi.stubGlobal("fetch", transport);
  await expect(dispatchDirectLibraryRead(services, user, "other", "pipeline-library-discover", {})).rejects.toMatchObject({ status: 404 });
  await services.repository.mutate(state => { state.roles.manager!.permissions = []; });
  await expect(dispatchDirectLibraryRead(services, user, "chat", "pipeline-library-discover", {})).rejects.toMatchObject({ status: 403 });
  await services.repository.mutate(state => { state.users.owner!.status = "Suspended"; });
  await expect(dispatchDirectLibraryRead(services, user, "chat", "pipeline-library-discover", {})).rejects.toMatchObject({ status: 403 }); expect(transport).not.toHaveBeenCalled();
});
test("a changed actor while HTTP is pending prevents returning private content", async () => {
  const { services, user } = await fixture();
  vi.stubGlobal("fetch", vi.fn(async () => { await services.repository.mutate(state => { state.users.owner!.status = "Suspended"; }); return Response.json({ document_id: "doc-1", text: "private" }); }));
  await expect(dispatchDirectLibraryRead(services, user, "chat", "pipeline-library-resolve", { document_id: "doc-1" })).rejects.toMatchObject({ status: 403 });
});
test("pipeline denial, bad identity and cancellation never trigger retries", async () => {
  const { services, user } = await fixture();
  const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ error: { code: "LIBRARY_NOT_FOUND", message: "No permitted document" } }, { status: 404 }))
    .mockResolvedValueOnce(Response.json({ document_id: "other", text: "wrong document" })); vi.stubGlobal("fetch", transport);
  await expect(dispatchDirectLibraryRead(services, user, "chat", "pipeline-library-resolve", { document_id: "doc-1" })).rejects.toMatchObject({ status: 404 });
  await expect(dispatchDirectLibraryRead(services, user, "chat", "pipeline-library-resolve", { document_id: "doc-1" })).rejects.toMatchObject({ status: 502 });
  const controller = new AbortController(); controller.abort();
  await expect(dispatchDirectLibraryRead(services, user, "chat", "pipeline-library-discover", {}, { signal: controller.signal })).rejects.toMatchObject({ status: 409 }); expect(transport).toHaveBeenCalledTimes(2);
});
test("normal chat agent chooses search and resolve with bridge offline and does not create a workflow", async () => {
  const { services, user } = await fixture("manager");
  const bridgeDiscovery = vi.fn(async () => { throw new Error("Bridge must not be contacted for document retrieval"); });
  services.erpbridgeSession = { listTools: bridgeDiscovery } as unknown as NonNullable<HandlerServices["erpbridgeSession"]>;
  const turn = (tool: string, args: Record<string, unknown>): QueryTurnResult => ({ text: "", toolCalls: [{ id: `call-${Math.random()}`, name: tool, arguments: args }], stopReason: "tool_calls", inputTokens: 1, outputTokens: 1, measured: true });
  const turns: QueryTurnResult[] = [{ text: '{"intent":"QUERY","needsClarification":false}', toolCalls: [], stopReason: "stop", completionConfirmed: true, inputTokens: 1, outputTokens: 1, measured: true }, turn("erp_tool_schema", { toolName: "pipeline-library-search" }), turn("erp_invoke", { toolName: "pipeline-library-search", arguments: { query: "Sample Customer" } }),
    turn("erp_tool_schema", { toolName: "pipeline-library-resolve" }), turn("erp_invoke", { toolName: "pipeline-library-resolve", arguments: { document_id: "doc-1" } }),
    { text: "The saved form is for Sample Customer, reference REG-1.", toolCalls: [], stopReason: "stop", completionConfirmed: true, inputTokens: 1, outputTokens: 1, measured: true }];
  services.providerRuntime = { configured: true, binding: { model: "test" }, queryWithTools: vi.fn(async () => turns.shift()!) } as unknown as NonNullable<HandlerServices["providerRuntime"]>;
  const transport = vi.fn<typeof fetch>(async url => Response.json(String(url).endsWith("search") ? { items: [{ document_id: "doc-1" }], count: 1 } : { document_id: "doc-1", form_fields: { customer_name: "Sample Customer", registration_ref: "REG-1" } })); vi.stubGlobal("fetch", transport);
  const stored = { session: { id: "chat" }, userMessage: { id: "message", role: "user", text: "Show the saved registration" }, priorMessages: [] };
  const result = await processStoredChat({ services, user, sessionId: "chat", traceId: "qa", body: {}, content: "Show the saved registration", stored, request: {} as FastifyRequest });
  expect(JSON.stringify(result)).toContain("Sample Customer"); expect(transport).toHaveBeenCalledTimes(2);
  expect(bridgeDiscovery).not.toHaveBeenCalled();
  const state = await services.repository.snapshot(); expect(Object.keys(state.workflows)).toHaveLength(0);
  expect(state.chats.chat!.messages.at(-1)!.artifacts).toMatchObject({ workflowGenerated: false, blocked: false });
});
