import { afterEach, expect, test, vi } from "vitest";
import { resolve } from "node:path";
import jwt from "jsonwebtoken";
import { previewDocument } from "../src/documents/model-preview.js";
import { loadConfig } from "../src/config/config.js";
import { Repository } from "../src/repository/store.js";
import { RegistryService } from "../src/registry/service.js";
import { RegistryValidator } from "../src/validator/registry-validator.js";
import { Executor } from "../src/runner/executor.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { buildApp } from "../src/http/app.js";
import type { ApplicationServices } from "../src/http/application-services.js";
import { systemInstructionsFor, toolQuerySystemInstructionsFor, DOCUMENT_AWARE_ERP_CHAT_SYSTEM_PROMPT, ERP_CHAT_SYSTEM_PROMPT } from "../src/prompts/contracts.js";
import { OpenAICompatibleError, generationRequestBody } from "../src/providers/openai-compatible.js";
import { libraryRequest } from "../src/documents/library-client.js";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const observed = { documentType: "registration", summary: "Two proposed customers", fields: {}, rows: [{ customer_name: "Client A" }, { customer_name: "Client B" }], missingInformation: ["ERP required fields are not yet known"], warnings: [] };
async function setup() {
  const repository = new Repository();
  await repository.mutate(state => {
    state.users.owner = { id: "owner", name: "Owner", email: "owner@example.test", roleId: "role_admin", permissionOverrides: [], status: "Active", initials: "O", departmentId: null, lastLoginAt: null, createdAt: "" };
    state.chats.chat = { id: "chat", ownerId: "owner", title: "Forms", createdAt: "", updatedAt: "", messageCount: 0, messages: [] };
  });
  const config = loadConfig({ APP_ENV: "test", STORAGE_DRIVER: "memory", MCP_MODE: "mock", JWT_SECRET: "isolated-document-preview-jwt-secret", TOOL_REGISTRY_PATH: resolve("tests/fixtures/tools.json"), RULE_REGISTRY_PATH: resolve("tests/fixtures/rules.json") });
  const generate = vi.fn(async (..._args: unknown[]) => ({ text: JSON.stringify(observed), model: "selected-vision", provider: "isolated", inputTokens: 1, outputTokens: 1, measured: true }));
  const assertEgress = vi.fn();
  const provider = { configured: true, configuration: { baseURL: "https://openrouter.ai/api/v1" }, generate, assertEgress, snapshot: vi.fn() };
  provider.snapshot.mockReturnValue(provider);
  const services = { config, repository, providerRuntime: provider } as unknown as ApplicationServices;
  const user = (await repository.effectiveUser("owner"))!;
  return { services, user, provider, generate, assertEgress };
}
const source = { filename: "clients.pdf", bytes: Buffer.from("%PDF-1.7 synthetic fixture") };
function multipart() {
  const boundary = "lcwe-preview-fixture";
  return { boundary, payload: Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nselected-vision\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="clients.pdf"\r\nContent-Type: application/pdf\r\n\r\n${source.bytes.toString()}\r\n--${boundary}--\r\n`) };
}

test("model-only preview does not access an unconfigured pipeline or create business records", async () => {
  const s = await setup(), fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  const before = await s.services.repository.snapshot();
  const result = await previewDocument(s.services, s.user, "chat", source, { model: "selected-vision" });
  expect(result).toMatchObject({ status: "MODEL_PREVIEW", rows: observed.rows, pipelineStorageConfirmed: false, vectorIndexConfirmed: false, ocrConfirmed: false, erpChanged: false });
  expect(fetch).not.toHaveBeenCalled(); expect(await s.services.repository.snapshot()).toEqual(before);
  expect(s.provider.snapshot).toHaveBeenCalledWith("selected-vision");
  expect(s.assertEgress).toHaveBeenCalledWith({ purpose: "interactive", dataClass: "restricted" });
  const context = s.generate.mock.calls[0]![4] as Parameters<typeof generationRequestBody>[4];
  const wire = generationRequestBody("https://openrouter.ai/api/v1", "selected-vision", 0, "Preview", { ...context, promptTemplateVersion: "prompt/document-preview/v1" });
  expect(wire).not.toHaveProperty("tools"); expect(JSON.stringify(wire.messages)).toContain("data:application/pdf;base64,");
});

test("preview egress denial prevents provider entry", async () => {
  const s = await setup(); s.assertEgress.mockImplementation(() => { throw new Error("Egress not approved"); });
  await expect(previewDocument(s.services, s.user, "chat", source, {})).rejects.toThrow("Egress not approved");
  expect(s.generate).not.toHaveBeenCalled();
});

test.each([
  { filename: "fake.pdf", bytes: Buffer.from("not a pdf") },
  { filename: "clients.xlsx", bytes: Buffer.from("zip") },
  { filename: "empty.txt", bytes: Buffer.from("  ") },
  { filename: "binary.txt", bytes: Buffer.from([255, 0]) },
  { filename: "big.pdf", bytes: Buffer.alloc(4 * 1024 * 1024 + 1) },
])("invalid, unsupported or oversized sources are rejected before model inference: $filename", async input => {
  const s = await setup(); await expect(previewDocument(s.services, s.user, "chat", input, {})).rejects.toHaveProperty("status"); expect(s.generate).not.toHaveBeenCalled();
});

test("partial UTF-8 text is labelled, not represented as a complete import", async () => {
  const s = await setup();
  const result = await previewDocument(s.services, s.user, "chat", { filename: "clients.csv", bytes: Buffer.from("a".repeat(25000)) }, {});
  expect(result.warnings.join(" ")).toContain("first 24000");
  expect(s.generate.mock.calls[0]![0]).not.toContain("a".repeat(24001));
});

test("model output cannot manufacture a storage receipt or an unbounded batch", async () => {
  const s = await setup();
  for (const output of [{ ...observed, pipelineStorageConfirmed: true }, { ...observed, rows: Array.from({ length: 51 }, () => ({ name: "x" })) }, { ...observed, fields: { name: "x".repeat(1001) } }]) {
    s.generate.mockResolvedValueOnce({ text: JSON.stringify(output), model: "selected-vision", provider: "isolated", inputTokens: 1, outputTokens: 1, measured: true });
    await expect(previewDocument(s.services, s.user, "chat", source, {})).rejects.toMatchObject({ status: 422, meta: { code: "DOCUMENT_PREVIEW_INVALID" } });
  }
});

test("an incompatible selected model is reported without an implicit provider/model switch", async () => {
  const s = await setup(); s.generate.mockRejectedValueOnce(new OpenAICompatibleError("unsupported", "client", 400));
  await expect(previewDocument(s.services, s.user, "chat", source, {})).rejects.toMatchObject({ status: 422, meta: { code: "DOCUMENT_PREVIEW_UNSUPPORTED" } });
  expect(s.generate).toHaveBeenCalledOnce();
});

test("versioned prompts distinguish a model preview from OCR, storage and ERP authority", () => {
  expect(toolQuerySystemInstructionsFor("prompt/erp-chat/v2")).toBe(DOCUMENT_AWARE_ERP_CHAT_SYSTEM_PROMPT);
  expect(systemInstructionsFor("prompt/erp-chat/v1")).toBe(ERP_CHAT_SYSTEM_PROMPT);
  expect(DOCUMENT_AWARE_ERP_CHAT_SYSTEM_PROMPT).toContain("user-supplied business inputs");
  expect(DOCUMENT_AWARE_ERP_CHAT_SYSTEM_PROMPT).toContain("fully offline pipeline cannot extract or store");
  expect(systemInstructionsFor("prompt/document-preview/v1")).toContain("not a completion SLA");
});

test("an upload acknowledgement timeout stays an unknown storage outcome and is never automatically replayed", async () => {
  const s = await setup(); s.services.config.pipelineAPIBaseURL = "http://pipeline.test"; s.services.config.pipelineAPIKey = "isolated-key";
  const fetch = vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("deadline")), { once: true });
  })); vi.stubGlobal("fetch", fetch);
  await expect(libraryRequest(s.services, s.user, "/uploads", { method: "POST", form: new FormData(), timeoutMs: 20 }))
    .rejects.toMatchObject({ status: 504, meta: { code: "PIPELINE_HANDOFF_TIMEOUT" }, message: expect.stringContaining("may still exist") });
  expect(fetch).toHaveBeenCalledOnce();
});

test("real HTTP preview and chat do not wait behind a blocked pipeline upload; ownership is still enforced", async () => {
  const s = await setup();
  s.services.config.pipelineAPIBaseURL = "http://pipeline.test"; s.services.config.pipelineAPIKey = "isolated-pipeline-key";
  const registries = await RegistryService.load(resolve("tests/fixtures/tools.json"), resolve("tests/fixtures/rules.json"));
  const validator = new RegistryValidator(registries, s.services.repository);
  const services = { ...s.services, registries, validator, executor: new Executor(new ToolRegistry(), validator) };
  let release!: (value: Response) => void, entered!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  vi.stubGlobal("fetch", vi.fn(() => { entered(); return new Promise<Response>(resolve => { release = resolve; }); }));
  const app = await buildApp(services);
  const deadlines = vi.spyOn(AbortSignal, "timeout");
  const auth = `Bearer ${jwt.sign({}, services.config.jwtSecret, { subject: "owner", expiresIn: 3600 })}`;
  const uploadPayload = multipart();
  const staged = uploadPayload.payload.toString().replace('name="model"', 'name="idempotency_key"').replace("selected-vision", "stable-upload-fixture-key");
  let upload: Promise<unknown> | undefined;
  try {
    upload = app.inject({ method: "POST", url: "/api/chat/sessions/chat/attachments", headers: { authorization: auth, "content-type": `multipart/form-data; boundary=${uploadPayload.boundary}` }, payload: staged });
    await reached;
    expect(deadlines).toHaveBeenCalledWith(5000);
    const preview = await app.inject({ method: "POST", url: "/api/chat/sessions/chat/attachments/preview", headers: { authorization: auth, "content-type": `multipart/form-data; boundary=${uploadPayload.boundary}` }, payload: uploadPayload.payload });
    expect(preview.statusCode).toBe(200); expect(preview.headers["cache-control"]).toBe("no-store"); expect(preview.json()).toMatchObject({ status: "MODEL_PREVIEW" });
    const renamed = await app.inject({ method: "PATCH", url: "/api/chat/sessions/chat", headers: { authorization: auth }, payload: { title: "Chat still responds" } });
    expect(renamed.statusCode).toBe(200);
    const rejected = await app.inject({ method: "POST", url: "/api/chat/sessions/not-owned/attachments/preview", headers: { authorization: auth, "content-type": `multipart/form-data; boundary=${uploadPayload.boundary}` }, payload: uploadPayload.payload });
    expect(rejected.statusCode).toBe(404); expect(s.generate).toHaveBeenCalledOnce();
    await services.repository.mutate(state => { state.roles.role_admin!.permissions = state.roles.role_admin!.permissions.filter(permission => permission !== "pipeline:upload"); });
    const denied = await app.inject({ method: "POST", url: "/api/chat/sessions/chat/attachments/preview", headers: { authorization: auth, "content-type": `multipart/form-data; boundary=${uploadPayload.boundary}` }, payload: uploadPayload.payload });
    expect(denied.statusCode).toBe(403); expect(s.generate).toHaveBeenCalledOnce();
  } finally {
    release?.(Response.json({ id: "upload", session_id: "chat", status: "EXTRACTING", revision: 1 }));
    await upload; await app.close();
  }
}, 15000);
