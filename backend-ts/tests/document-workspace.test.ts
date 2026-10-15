import type { FastifyReply, FastifyRequest } from "fastify";
import { afterEach, expect, test, vi } from "vitest";
import { createHmac } from "node:crypto";
import { loadConfig } from "../src/config/config.js";
import { Repository } from "../src/repository/store.js";
import { handleChatDocumentRoute } from "../src/http/handlers/chat-documents.js";
import { routeTable } from "../src/http/generated-routes.js";
import { libraryScope, publicAttachment, bindLibraryReadDelegation, consumeLibraryReadDelegation, libraryModelInputSchema, LIBRARY_READ_TOOLS } from "../src/documents/library-client.js";
import type { ToolDefinition } from "../src/registry/schemas.js";
import { analyseAttachment, recordsInResult } from "../src/documents/attachment-analysis.js";
import { OpenAICompatibleError } from "../src/providers/openai-compatible.js";
import type { ProviderRuntime } from "../src/providers/runtime.js";
import { reviewedDocumentChatContext, documentProposalFailure } from "../src/documents/chat-document-context.js";
import type { HandlerServices } from "../src/http/handlers/common.js";

afterEach(() => vi.unstubAllGlobals());

test("collection migration requires explicit review and rejects browser collection authority", async () => {
  const { user, services } = await fixture();
  const migration = routeTable.find(item => item.method === "POST" && item.path === "/api/pipeline/v1/library/migrate")!;
  const fetch = vi.fn(async (_url: URL, _init?: RequestInit) => response({ status: "MIGRATED", version: 1, deleted_vectors: 0 })); vi.stubGlobal("fetch", fetch);
  await expect(handleChatDocumentRoute(migration, request({ document_id: "doc", expected_revision: 2, review_confirmed: true, collection: "arbitrary" }), reply(), user, services)).rejects.toMatchObject({ status: 422 });
  expect(fetch).not.toHaveBeenCalled();
  const result = await handleChatDocumentRoute(migration, request({ document_id: "doc", expected_revision: 2, review_confirmed: true }), reply(), user, services);
  expect(result).toMatchObject({ status: "MIGRATED", deleted_vectors: 0 });
  expect(String(fetch.mock.calls[0]![0])).toBe("http://pipeline.test/v1/library/migrate");
});

test("collection migration is denied when schema management permission is revoked", async () => {
  const { user, services } = await fixture();
  await services.repository.mutate(state => { state.roles.role_admin!.permissions = state.roles.role_admin!.permissions.filter(permission => permission !== "registry:write"); });
  const current = (await services.repository.effectiveUser(user.id))!;
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  const migration = routeTable.find(item => item.method === "POST" && item.path === "/api/pipeline/v1/library/migrate")!;
  await expect(handleChatDocumentRoute(migration, request({ document_id: "doc", expected_revision: 1, review_confirmed: true }), reply(), current, services)).rejects.toMatchObject({ status: 403 });
  expect(fetch).not.toHaveBeenCalled();
});

test("model-facing private-library schemas exclude server credentials without changing reviewed contracts", () => {
  expect(libraryModelInputSchema({ mcp_tool_name: "legacy-empty-schema" } as ToolDefinition)).toEqual({ type: "object", properties: {} });
  for (const name of LIBRARY_READ_TOOLS) {
    const tool = { mcp_tool_name: name, input_schema: { type: "object", properties: { document_id: { type: "string" }, access_token: { type: "string" } }, required: ["document_id", "access_token"] } } as unknown as ToolDefinition;
    expect(libraryModelInputSchema(tool)).toEqual({ type: "object", properties: { document_id: { type: "string" } }, required: ["document_id"] });
    expect(tool.input_schema.properties).toHaveProperty("access_token");
    expect(tool.input_schema.required).toContain("access_token");
    expect(libraryModelInputSchema({ ...tool, mcp_tool_name: "another-reviewed-tool" })).toEqual(tool.input_schema);
  }
});

async function fixture() {
  const repository = new Repository();
  await repository.mutate(state => {
    state.users.owner = { id: "owner", name: "Owner", email: "owner@example.test", roleId: "role_admin", permissionOverrides: [], status: "Active", initials: "O", departmentId: null, lastLoginAt: null, createdAt: new Date().toISOString() };
    state.chats.chat = { id: "chat", ownerId: "owner", title: "Private forms", createdAt: "", updatedAt: "", messageCount: 0, messages: [] };
    state.chats.other = { ...state.chats.chat, id: "other", ownerId: "another-owner" };
  });
  const user = (await repository.effectiveUser("owner"))!;
  const config = loadConfig({ APP_ENV: "test", PIPELINE_API_BASE_URL: "http://pipeline.test", PIPELINE_API_KEY: "isolated-library-test-key", PIPELINE_WORKSPACE_ID: "test-workspace" });
  return { user, services: { repository, config } as HandlerServices };
}
function route(method: string, suffix: string) { return routeTable.find(route => route.method === method && route.path === `/api/chat/sessions/:id/attachments${suffix}`)!; }
function request(body: unknown = {}, id = "chat") { return { params: { id, uploadId: "upload-one" }, body, headers: {}, ip: "127.0.0.1" } as FastifyRequest; }
function reply() { return { send: (value: unknown) => value, status() { return this; } } as unknown as FastifyReply; }
const schema = { id: "schema-one", revision: 1, primary_key: "member_id", fields: [{ name: "name", type: "string" }], document_types: ["registration_form"] };
const response = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });

test("a reviewed fictional-source declaration is forwarded without granting storage or collection authority", async () => {
  const { user, services } = await fixture();
  const fetch = vi.fn(async (url: URL, init?: RequestInit) => {
    if (url.pathname.endsWith("catalog")) return response({ entities: [schema] });
    if (url.pathname.endsWith("confirm")) {
      const body = JSON.parse(String(init?.body));
      expect(body.synthetic_source_confirmed).toBe(true);
      expect(body).not.toHaveProperty("workspaceId"); expect(body).not.toHaveProperty("vector_collection");
      return response({ id: "upload-one", status: "READY" });
    }
    return response({ id: "upload-one", session_id: "chat", revision: 1, status: "REVIEW" });
  }); vi.stubGlobal("fetch", fetch);
  const body = { expected_revision: 1, schema_id: schema.id, schema_revision: 1, document_type: "registration_form", create_record: true, review_confirmed: true, synthetic_source_confirmed: true, form_fields: { name: "Fictional person" } };
  await expect(handleChatDocumentRoute(route("POST", "/:uploadId/confirm"), request(body), reply(), user, services)).resolves.toMatchObject({ status: "READY" });
  await expect(handleChatDocumentRoute(route("POST", "/:uploadId/confirm"), request({ ...body, synthetic_source_confirmed: "true" }), reply(), user, services)).rejects.toMatchObject({ status: 422 });
});

test("delegation is signed, workspace/actor bound, short-lived and read-only", async () => {
  const { user, services } = await fixture();
  const [raw, signature] = libraryScope(services.config, user, true).split(".");
  expect(signature).toBe(createHmac("sha256", services.config.pipelineAPIKey!).update(raw!).digest("base64url"));
  const scope = JSON.parse(Buffer.from(raw!, "base64url").toString());
  expect(scope).toMatchObject({ workspaceId: "test-workspace", actorId: "owner", readOnly: true, canManage: false, canUpload: false });
  expect(scope.exp - scope.iat).toBe(120);
});
test("public attachments exclude extracted content and server-owned lookup receipts", () => {
  expect(JSON.stringify(publicAttachment({ id: "one", extracted_text: "private text", file_base64: "private bytes", proposal: { choices: [{ id: "choice", readReceipt: { secret: "private receipt" } }] } }))).not.toContain("private");
});
test("only structured acknowledged records, not model narrative or failed envelopes, supply IDs", () => {
  expect(recordsInResult({ content: [{ type: "text", text: JSON.stringify({ data: [{ member_id: "A", name: "Example" }] }) }] }, "member_id")).toHaveLength(1);
  expect(recordsInResult("Member A is probably the owner", "member_id")).toEqual([]);
  expect(recordsInResult({ isError: true, data: { member_id: "A" } }, "member_id")).toEqual([]);
});
test("another chat's attachments are denied before pipeline access", async () => {
  const { user, services } = await fixture(); const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  await expect(handleChatDocumentRoute(route("GET", ""), request({}, "other"), reply(), user, services)).rejects.toMatchObject({ status: 404 });
  expect(fetch).not.toHaveBeenCalled();
});
test("revoked pipeline permission cannot mutate attachments", async () => {
  const { user, services } = await fixture();
  await services.repository.mutate(state => { state.roles.role_admin!.permissions = state.roles.role_admin!.permissions.filter(permission => permission !== "pipeline:upload"); });
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  await expect(handleChatDocumentRoute(route("POST", "/:uploadId/confirm"), request(), reply(), user, services)).rejects.toMatchObject({ status: 403 });
  expect(fetch).not.toHaveBeenCalled();
});
test("browser-supplied verified ERP targets cannot bypass lookup evidence", async () => {
  const { user, services } = await fixture();
  vi.stubGlobal("fetch", vi.fn(async (url: URL) => response(url.pathname.endsWith("catalog") ? { entities: [schema] } : { id: "upload-one", session_id: "chat", status: "REVIEW", revision: 1 })));
  await expect(handleChatDocumentRoute(route("POST", "/:uploadId/confirm"), request({ expected_revision: 1, schema_id: schema.id, schema_revision: 1, document_type: "registration_form", create_record: false, review_confirmed: true,
    target: { kind: "verified_erp_record", business_key_name: "member_id", business_key_value: "forged" } }), reply(), user, services)).rejects.toMatchObject({ status: 422 });
});
test("reviewed member batches are forwarded to pipeline, never an ERP write endpoint", async () => {
  const { user, services } = await fixture();
  const fetch = vi.fn(async (url: URL, init?: RequestInit) => {
    if (url.pathname.endsWith("catalog")) return response({ entities: [schema] });
    if (url.pathname.endsWith("confirm")) { expect(JSON.parse(String(init?.body)).form_rows).toHaveLength(2); return response({ id: "upload-one", status: "READY", pipeline_record_ids: ["a", "b"] }); }
    return response({ id: "upload-one", session_id: "chat", status: "REVIEW", revision: 1 });
  }); vi.stubGlobal("fetch", fetch);
  const result = await handleChatDocumentRoute(route("POST", "/:uploadId/confirm"), request({ expected_revision: 1, schema_id: schema.id, schema_revision: 1, document_type: "registration_form", create_record: true, review_confirmed: true,
    form_rows: [{ name: "A" }, { name: "B" }] }), reply(), user, services);
  expect(result).toMatchObject({ status: "READY" });
  expect(fetch.mock.calls.every(([url]) => String(url).startsWith("http://pipeline.test/v1/library/"))).toBe(true);
});
test("ERP proposals retrieve current reviewed fields through the bridge reader", async () => {
  const { user, services } = await fixture();
  vi.stubGlobal("fetch", vi.fn(async () => response({ session_id: "chat", status: "READY", document_id: "doc-one", version: 2 })));
  const read = vi.fn(async () => ({ structuredContent: { document_id: "doc-one", upload_id: "upload-one", version: 2, form_fields: { name: "Reviewed Example" } } }));
  const context = await reviewedDocumentChatContext(services, user, "chat", { uploadId: "upload-one", documentId: "doc-one", version: 2, purpose: "erp_record_proposal" }, read);
  expect(read).toHaveBeenCalledWith("pipeline-library-resolve", { document_id: "doc-one" });
  expect(context).toContain("Reviewed Example"); expect(context).toContain("Include human approval before each write");
});
test("stale document versions and injected identity fields block ERP proposals", async () => {
  const { user, services } = await fixture(); const read = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async () => response({ session_id: "chat", status: "READY", document_id: "doc-one", version: 3 })));
  const context = { uploadId: "upload-one", documentId: "doc-one", version: 2, purpose: "erp_record_proposal" };
  await expect(reviewedDocumentChatContext(services, user, "chat", context, read)).rejects.toMatchObject({ status: 409 });
  await expect(reviewedDocumentChatContext(services, user, "chat", { ...context, ownerId: "forged" }, read)).rejects.toMatchObject({ status: 422 });
  expect(read).not.toHaveBeenCalled();
});

test("failed ERP proposal preserves reviewed source identity without claiming a draft or ERP write", () => {
  const context = { uploadId: "upload-one", documentId: "doc-one", version: 2, purpose: "erp_record_proposal" };
  const recovery = documentProposalFailure(context);
  expect(recovery.artifacts).toMatchObject({ code: "DOCUMENT_ERP_PROPOSAL_UNAVAILABLE", can_execute: false, documentContext: context });
  expect(recovery.text).toContain("No workflow was saved, published or executed");
  expect(recovery.text).toContain("doc-one · version 2");
  expect(recovery.text).toContain("human approval is still required");
  expect(recovery.artifacts).not.toHaveProperty("workflowId");
});

test("transport delegation is exact, private, one-use and absent from business arguments", async () => {
  const { user, services } = await fixture();
  const tool = { tool_id: "lib-one", name: "private-document", mcp_tool_name: "pipeline-library-resolve", is_read_only: true,
    bridge_contract: { profile: "toolplane-v1", resource_version: "1.0.0", resource_digest: "a".repeat(64), remote_roles: [] } } as unknown as ToolDefinition;
  const args = { document_id: "one" }, identity = { userId: user.id, localRole: user.role, erpbridgeRole: "platform_admin" };
  const ticket = bindLibraryReadDelegation(services.config, user, tool, args);
  expect(args).toEqual({ document_id: "one" });
  expect(() => consumeLibraryReadDelegation(JSON.parse(JSON.stringify(ticket)), tool, args, identity)).toThrow(/not authentic/);
  const token = consumeLibraryReadDelegation(ticket, tool, args, identity);
  expect(JSON.parse(Buffer.from(token.split(".")[0]!, "base64url").toString()).readOnly).toBe(true);
  expect(() => consumeLibraryReadDelegation(ticket, tool, args, identity)).toThrow(/not authentic/);
  for (const changed of [ { document_id: "another" }, { document_id: "one", access_token: "forged" } ]) {
    const proof = bindLibraryReadDelegation(services.config, user, tool, args);
    expect(() => consumeLibraryReadDelegation(proof, tool, changed, identity)).toThrow(/not authentic/);
  }
  expect(() => bindLibraryReadDelegation(services.config, user, { ...tool, is_read_only: false }, args)).toThrow();
});

test.each(["success", "unsupported", "text-fallback", "egress-denied"])("source-bound selected-model review while OCR runs: %s", async kind => {
  const { user, services } = await fixture();
  const bytes = Buffer.from("%PDF-1.7 synthetic form");
  const { createHash } = await import("node:crypto");
  const content_hash = createHash("sha256").update(bytes).digest("hex");
  const generate = vi.fn(async () => ({ text: JSON.stringify({ schemaId: schema.id, documentType: "registration_form", fields: { name: "Proposed Name" }, summary: "Human review required" }), model: "chosen-model" }));
  if (["unsupported", "text-fallback"].includes(kind)) generate.mockRejectedValueOnce(new OpenAICompatibleError("HTTP 400", "client", 400));
  const provider = { configured: true, configuration: { baseURL: "https://openrouter.ai/api/v1" }, generate,
    assertEgress: vi.fn(() => { if (kind === "egress-denied") throw new Error("restricted egress not approved"); }) };
  const snapshot = vi.fn(() => provider);
  services.providerRuntime = { configured: true, snapshot } as unknown as ProviderRuntime;
  const fetch = vi.fn(async () => response({ filename: "form.pdf", content_type: "application/pdf", content_hash, data_base64: bytes.toString("base64") }));
  vi.stubGlobal("fetch", fetch);
  const pending = analyseAttachment(services, user, "chat", [schema as never], {
    id: "upload-one", filename: "form.pdf", content_hash, size_bytes: bytes.length, model_source_available: true, status: kind === "text-fallback" ? "REVIEW" : "EXTRACTING",
    extracted_text: kind === "text-fallback" ? "Name: Proposed Name" : "",
  }, { model: "chosen-model", instruction: "Extract this form", createRecord: true });
  if (kind === "egress-denied") { await expect(pending).rejects.toThrow(/not approved/); expect(fetch).not.toHaveBeenCalled(); expect(generate).not.toHaveBeenCalled(); }
  else if (kind === "unsupported") await expect(pending).rejects.toMatchObject({ status: 409, meta: { code: "ATTACHMENT_PROCESSING" } });
  else {
    const result = await pending;
    expect(result).toMatchObject({ requiresHumanReview: true, sourceContentHash: content_hash, sourceMethod: kind === "text-fallback" ? "extracted_text" : "model_document" });
    expect(JSON.stringify(result)).not.toContain(bytes.toString("base64"));
    expect(snapshot).toHaveBeenCalledWith("chosen-model");
    expect(generate).toHaveBeenCalledTimes(kind === "text-fallback" ? 2 : 1);
  }
});

test("saving a model proposal uses the post-OCR revision without replacing a competing proposal", async () => {
  const { user, services } = await fixture();
  const generate = vi.fn(async () => ({ text: JSON.stringify({ schemaId: schema.id, documentType: "registration_form", fields: { name: "Proposed" }, summary: "Review" }), model: "selected-model" }));
  services.providerRuntime = { configured: true, snapshot: () => ({ configured: true, assertEgress: vi.fn(), generate }) } as unknown as ProviderRuntime;
  let compete = false;
  const fetch = vi.fn(async (url: URL, init?: RequestInit) => {
    if (url.pathname.endsWith("/catalog")) return response({ entities: [schema] });
    if (url.pathname.endsWith("/proposal")) {
      expect(JSON.parse(String(init?.body)).expected_revision).toBe(3);
      return response({ id: "upload-one", status: "REVIEW", revision: 4 });
    }
    if (url.searchParams.has("include_text")) return response({ id: "upload-one", content_hash: "same-source", filename: "form.txt", session_id: "chat", status: "REVIEW", revision: 1, extracted_text: "Name: Proposed" });
    return response({ id: "upload-one", content_hash: "same-source", session_id: "chat", status: "REVIEW", revision: 3, ...(compete ? { proposal: { summary: "Another reviewer changed it" } } : {}) });
  });
  vi.stubGlobal("fetch", fetch);
  const body = { instruction: "Extract for review", createRecord: true, model: "selected-model" };
  await expect(handleChatDocumentRoute(route("POST", "/:uploadId/analyse"), request(body), reply(), user, services)).resolves.toMatchObject({ revision: 4 });
  compete = true; fetch.mockClear();
  await expect(handleChatDocumentRoute(route("POST", "/:uploadId/analyse"), request(body), reply(), user, services)).rejects.toMatchObject({ status: 409 });
  expect(fetch.mock.calls.some(([url]) => url.pathname.endsWith("/proposal"))).toBe(false);
});

test("older pipeline receipts use extracted text without requiring the new source endpoint", async () => {
  const { user, services } = await fixture();
  const generate = vi.fn(async () => ({ text: JSON.stringify({ schemaId: schema.id, documentType: "registration_form", fields: {}, summary: "Review source" }), model: "selected-model" }));
  services.providerRuntime = { configured: true, snapshot: () => ({ configured: true, assertEgress: vi.fn(), generate }) } as unknown as ProviderRuntime;
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  const upload = { id: "legacy", filename: "form.png", size_bytes: 50, status: "REVIEW", extracted_text: "Reviewed synthetic text" };
  await expect(analyseAttachment(services, user, "chat", [schema as never], upload, { instruction: "Extract", createRecord: true })).resolves.toMatchObject({ sourceMethod: "extracted_text" });
  expect(fetch).not.toHaveBeenCalled();
  await expect(analyseAttachment(services, user, "chat", [schema as never], { ...upload, extracted_text: "" }, { instruction: "Extract", createRecord: true })).rejects.toMatchObject({ status: 422, meta: { code: "ATTACHMENT_NO_READABLE_SOURCE" } });
  expect(generate).toHaveBeenCalledTimes(1);
});
