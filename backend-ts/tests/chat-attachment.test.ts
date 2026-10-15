import { afterEach, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { loadConfig } from "../src/config/config.js";
import { Repository } from "../src/repository/store.js";
import { prepareChatAttachment, readAttachmentTicket, attachmentTicket, attachmentChatContext, readChatAttachmentUpload, type ChatAttachmentData } from "../src/documents/chat-attachment.js";
import { processStoredChat } from "../src/http/handlers/chat.js";
import type { HandlerServices } from "../src/http/handlers/common.js";
import type { FastifyRequest } from "fastify";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const observed = { documentType: "registration_form", summary: "Customer registration", fields: { customer_name: "Client A" }, missingInformation: [], warnings: [] };
const source = { filename: "customer.txt", bytes: Buffer.from("customer_name: Client A") };
const body = { instruction: "Read this customer form", idempotency_key: "stable-attachment-request-001", model: "selected-model" };
async function fixture(pipeline = false) {
  const repository = new Repository();
  await repository.mutate(state => {
    state.users.owner = { id: "owner", name: "Owner", email: "owner@example.test", roleId: "role_admin", permissionOverrides: [], status: "Active", initials: "O", departmentId: null, createdAt: "", lastLoginAt: null };
    state.chats.chat = { id: "chat", ownerId: "owner", title: "Attachment", createdAt: "", updatedAt: "", messageCount: 1, messages: [{ id: "request", role: "user", text: body.instruction }] };
  });
  const config = loadConfig({ APP_ENV: "test", JWT_SECRET: "isolated-message-attachment-key", ...(pipeline ? { PIPELINE_API_BASE_URL: "http://pipeline.test", PIPELINE_API_KEY: "isolated-key", PIPELINE_WORKSPACE_ID: "isolated" } : {}) });
  const generate = vi.fn(async () => ({ text: JSON.stringify(observed), model: "selected-model" }));
  const queryWithTools = vi.fn(async (messages: unknown) => { expect(JSON.stringify(messages)).toContain("Client A"); return { text: "The form identifies Client A. Storage is not confirmed.", toolCalls: [], stopReason: "stop", completionConfirmed: true, inputTokens: 1, outputTokens: 1, measured: true }; });
  const provider: any = { configured: true, binding: { model: "selected-model" }, configuration: { baseURL: "https://openrouter.ai/api/v1" }, generate, queryWithTools, assertEgress: vi.fn() };
  provider.snapshot = vi.fn(() => provider);
  const services = { config, repository, providerRuntime: provider, registries: { snapshot: () => ({ tools: [] }) } } as unknown as HandlerServices;
  const user = (await repository.effectiveUser("owner"))!;
  return { services, user, provider, generate };
}
test("pipeline outage still interprets the file using the selected model without claiming vector storage", async () => {
  const f = await fixture(), fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  const result = await prepareChatAttachment(f.services, f.user, "chat", source, body);
  expect(result.attachment).toMatchObject({ filename: "customer.txt", storage: "UNAVAILABLE", reviewAvailable: false, fields: { customer_name: "Client A" } });
  expect(result.vectorIndexConfirmed).toBe(false); expect(fetch).not.toHaveBeenCalled();
  expect(readAttachmentTicket(f.services, f.user, "chat", result.attachmentTicket)).toEqual(result.attachment);
  expect(f.provider.snapshot).toHaveBeenCalledWith("selected-model");
});
test("the preparation ticket is actor, role, conversation, permission and content bound", async () => {
  const f = await fixture(), result = await prepareChatAttachment(f.services, f.user, "chat", source, body);
  for (const [user, session, ticket] of [[{ ...f.user, id: "other" }, "chat", result.attachmentTicket], [f.user, "another-chat", result.attachmentTicket], [{ ...f.user, role: "Manager" }, "chat", result.attachmentTicket], [f.user, "chat", result.attachmentTicket + "changed"]] as const)
    expect(() => readAttachmentTicket(f.services, user, session, ticket)).toThrow();
  expect(() => readAttachmentTicket(f.services, { ...f.user, permissions: [] }, "chat", result.attachmentTicket)).toThrow(/access/);
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31 * 60_000);
  expect(() => readAttachmentTicket(f.services, f.user, "chat", result.attachmentTicket)).toThrow(/expired/);
});
test("pipeline timeout reads the original upload identity, never submits another file", async () => {
  const f = await fixture(true), hash = createHash("sha256").update(source.bytes).digest("hex");
  const id = `upload_${createHash("sha256").update(`isolated:owner:${body.idempotency_key}`).digest("hex").slice(0, 40)}`;
  const fetch = vi.fn(async (url: URL, init?: RequestInit) => {
    if (init?.method === "POST") throw new Error("upload acknowledgement lost");
    return Response.json(url.pathname.endsWith("catalog") ? { entities: [] } : { id, content_hash: hash, session_id: "chat", status: "REVIEW", revision: 1 });
  }); vi.stubGlobal("fetch", fetch);
  const result = await prepareChatAttachment(f.services, f.user, "chat", source, body);
  expect(result.attachment).toMatchObject({ storage: "STAGED", uploadId: id, reviewAvailable: false });
  expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  expect(fetch.mock.calls.some(([url]) => url.pathname.endsWith(id))).toBe(true);
  expect(result.vectorIndexConfirmed).toBe(false);
});
test("a rejected or unauthorized upload cannot be disguised as a successful model fallback", async () => {
  const f = await fixture(true);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { message: "Denied" } }, { status: 403 })));
  await expect(prepareChatAttachment(f.services, f.user, "chat", source, body)).rejects.toMatchObject({ status: 403 });
  expect(f.generate).not.toHaveBeenCalled();
});
test("schema analysis saves a review proposal only; no automatic confirm, ERP call or vector save", async () => {
  const f = await fixture(true), hash = createHash("sha256").update(source.bytes).digest("hex");
  const id = `upload_${createHash("sha256").update(`isolated:owner:${body.idempotency_key}`).digest("hex").slice(0, 40)}`;
  const upload = { id, content_hash: hash, session_id: "chat", status: "REVIEW", revision: 1, extracted_text: "customer_name: Client A" };
  const schema = { id: "customer", revision: 1, source_system_id: "erp", source_entity: "Customer", fields: [{ name: "customer_name", type: "string", required: true }], document_types: ["registration_form"] };
  f.generate.mockResolvedValueOnce({ text: JSON.stringify({ schemaId: schema.id, documentType: "registration_form", fields: observed.fields, summary: "Client A" }), model: "selected-model" });
  const fetch = vi.fn(async (url: URL) => Response.json(url.pathname.endsWith("catalog") ? { entities: [schema] } : url.pathname.endsWith("proposal") ? { ...upload, proposal: {} } : upload));
  vi.stubGlobal("fetch", fetch);
  const result = await prepareChatAttachment(f.services, f.user, "chat", source, body);
  expect(result.attachment.reviewAvailable).toBe(true); expect(f.generate).toHaveBeenCalledOnce();
  expect(fetch.mock.calls.every(([url]) => !url.pathname.endsWith("confirm"))).toBe(true);
  expect(result.vectorIndexConfirmed).toBe(false);
});
test("normal attachment chat supplies the observations, persists the inline card, and does not force a workflow", async () => {
  const f = await fixture();
  const data: ChatAttachmentData = { filename: source.filename, sourceHash: "a".repeat(64), storage: "UNAVAILABLE", summary: "Client A", fields: observed.fields, warnings: [], model: "selected-model", reviewAvailable: false };
  const result: any = await processStoredChat({ services: f.services, user: f.user, sessionId: "chat", traceId: "fixture", content: "Hello, explain this form", body: { attachmentTicket: attachmentTicket(f.services, f.user, "chat", data) },
    stored: { session: { id: "chat" }, userMessage: { id: "request" }, priorMessages: [] } });
  expect(result.data.assistantMessage.artifacts.chatAttachment).toMatchObject({ filename: source.filename, fields: observed.fields, storage: "UNAVAILABLE" });
  expect(Object.keys((await f.services.repository.snapshot()).workflows)).toHaveLength(0);
  expect(attachmentChatContext(data)).toContain("UNREVIEWED BUSINESS INPUTS");
});
test("multipart rejects duplicate fields and extra file parts before processing", async () => {
  const request = { isMultipart: () => true, async *parts() { yield { type: "field", fieldname: "instruction", value: "Read" }; yield { type: "field", fieldname: "instruction", value: "Another" }; } } as unknown as FastifyRequest;
  await expect(readChatAttachmentUpload(request)).rejects.toMatchObject({ status: 422 });
});
