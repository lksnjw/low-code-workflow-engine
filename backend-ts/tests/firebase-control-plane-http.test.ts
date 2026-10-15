import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { handleFunctionHttp } from "../src/firebase/http.js";
import { boundedReadFixture, TaskRecords } from "./fixtures/bounded-read-task.js";
import { Repository } from "../src/repository/store.js";
import { hashPassword } from "../src/authn/password.js";
import jwt from "jsonwebtoken";
import { isFunctionControlPlaneRequest } from "../src/firebase/control-plane-http.js";
import { testProviderConnection, providerConfigurationFromRecord, ProviderRuntime } from "../src/providers/runtime.js";
import { SAFETY_CONTRACT } from "../src/prompts/contracts.js";

const fixtures = vi.hoisted(() => ({ open: vi.fn(), construct: vi.fn(), progress: vi.fn() }));
vi.mock("../src/entrypoints/application-runtime.js", () => ({ openApplicationResources: fixtures.open, constructApplicationRuntime: fixtures.construct }));
vi.mock("../src/storage/firestore-progress-reader.js", () => ({ openFirestoreProgressReader: fixtures.progress }));
vi.mock("../src/firebase/progress-reader-pool.js", () => ({ borrowProgressReader: fixtures.progress }));
const closers: (() => Promise<unknown>)[] = [];
beforeEach(() => { vi.resetAllMocks(); fixtures.construct.mockRejectedValue(new Error("Broken active provider prevents full runtime construction")); });
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(closers.splice(0).map(close => close())); });
async function setup(multiple = false) {
  const storage = new TaskRecords(), f = await boundedReadFixture({ storage, configure: false }); closers.push(f.close);
  const config = { ...f.services.config, storageDriver: "firestore-records" as const };
  const passwordHash = await hashPassword("synthetic-control-password");
  await f.repository.mutate(state => {
    state.passwordHashes.owner = passwordHash;
    state.providers.legacy = { id: "legacy", name: "Legacy", active: true, type: "unsupported", apiKey: "synthetic-private-key", baseUrl: "https://legacy.example.test/v1", model: "legacy-model" };
    state.providers.replacement = { id: "replacement", name: "Replacement", active: multiple, type: "openai_compatible", apiKey: "synthetic-private-key", baseUrl: "https://replacement.example.test/v1", model: "pinned-model" };
  });
  const close = vi.fn(async () => {}), opened: Repository[] = [];
  fixtures.progress.mockImplementation(() => ({ snapshot: async () => JSON.parse(storage.bytes!.toString()), close: async () => {} }));
  fixtures.open.mockImplementation(async () => {
    const repository = await Repository.open(storage);
    opened.push(repository);
    return { config, repository, registries: f.services.registries, close: async () => { try { await close(); } finally { await repository.close(); } } };
  });
  const input = { config, root: process.cwd(), transport: { timeoutMs: 1000, enqueue: f.enqueue } };
  const request = (method: string, url: string, body?: unknown, headers: Record<string, string> = f.headers) => handleFunctionHttp(input, {
    method, url, headers: { ...headers, "content-type": "application/json" }, ...(body === undefined ? {} : { rawBody: Buffer.from(JSON.stringify(body)) }),
  });
  return { ...f, config, storage, close, input, request, opened, snapshot: () => JSON.parse(storage.bytes!.toString()) };
}

test.each([false, true])("login, refresh, me and provider repair survive broken active records (multiple=%s)", async multiple => {
  const f = await setup(multiple), fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
  const login = await f.request("POST", "/api/auth/login", { email: "owner@example.test", password: "synthetic-control-password" });
  expect(login.statusCode).toBe(200);
  const session = JSON.parse(login.body.toString()).data;
  expect((await f.request("POST", "/api/auth/refresh", { refreshToken: session.refreshToken })).statusCode).toBe(200);
  expect((await f.request("GET", "/api/auth/me")).statusCode).toBe(200);
  const list = await f.request("GET", "/api/providers"); expect(list.statusCode).toBe(200); expect(list.body.toString()).not.toContain("synthetic-private-key");
  const selected = await f.request("POST", "/api/providers/replacement/activate"); expect(selected.statusCode).toBe(200);
  expect(JSON.parse(selected.body.toString()).meta).toMatchObject({ activationScope: "stored-configuration", runtimeActivationConfirmed: false, remoteCompatibilityConfirmed: false });
  expect(Object.values(f.snapshot().providers).filter((value: any) => value.active)).toHaveLength(1);
  expect(fixtures.construct).not.toHaveBeenCalled(); expect(fetchMock).not.toHaveBeenCalled(); expect(f.sdk.callTool).not.toHaveBeenCalled(); expect(f.enqueue).not.toHaveBeenCalled();
});

test("invalid selection preserves provider state while an active legacy record can be corrected", async () => {
  const f = await setup(), before = f.snapshot().providers;
  expect((await f.request("POST", "/api/providers/legacy/activate")).statusCode).toBe(422);
  expect(f.snapshot().providers).toEqual(before);
  const updated = await f.request("PUT", "/api/providers/legacy", { name: "Legacy", type: "openai_compatible", model: "corrected-model", baseUrl: "https://legacy.example.test/v1" });
  expect(updated.statusCode).toBe(200); expect(f.snapshot().providers.legacy.active).toBe(true); expect(fixtures.construct).not.toHaveBeenCalled();
});

test.each(["missing", "invalid", "expired", "deleted", "suspended", "revoked", "wrong-role"])("provider administration retains current %s denial", async scenario => {
  const f = await setup(); let headers: Record<string, string> = { ...f.headers };
  if (scenario === "missing") headers = {};
  if (scenario === "invalid") headers.authorization = "Bearer invalid";
  if (scenario === "expired") headers.authorization = `Bearer ${jwt.sign({}, f.config.jwtSecret, { subject: "owner", expiresIn: -1 })}`;
  if (["deleted", "suspended", "revoked", "wrong-role"].includes(scenario)) await f.repository.mutate(state => {
    if (scenario === "deleted") delete state.users.owner;
    if (scenario === "suspended") state.users.owner!.status = "Suspended";
    if (scenario === "revoked") state.roles.role_admin!.permissions = [];
    if (scenario === "wrong-role") state.roles.role_admin!.name = "Other Admin";
  });
  const before = f.snapshot();
  const result = await f.request("POST", "/api/providers/replacement/activate", undefined, headers);
  expect(result.statusCode).toBe(["missing", "invalid", "expired", "deleted"].includes(scenario) ? 401 : 403);
  expect(f.snapshot()).toEqual(before); expect(fixtures.construct).not.toHaveBeenCalled();
});

test.each(["POST /api/providers", "PUT /api/providers/replacement", "POST /api/providers/replacement/activate"])("actor is rechecked inside %s mutation", async target => {
  const f = await setup(), original = fixtures.open.getMockImplementation()!;
  fixtures.open.mockImplementation(async (...args) => {
    const resources = await original(...args), mutate = resources.repository.mutate.bind(resources.repository);
    vi.spyOn(resources.repository, "mutate").mockImplementation((work: any) => mutate((state: any) => { state.users.owner.status = "Suspended"; return work(state); }));
    return resources;
  });
  const before = f.snapshot(), [method, url] = target.split(" ");
  const result = await f.request(method!, url!, { name: "New provider", type: "openai_compatible", model: "fixed", baseUrl: "https://provider.example.test/v1", apiKey: "synthetic-secret" });
  expect(result.statusCode).toBe(403); expect(f.snapshot()).toEqual(before);
});

test("CRUD and logout preserve existing semantics, redact secrets and perform no external work", async () => {
  const f = await setup(), send = vi.fn(); vi.stubGlobal("fetch", send);
  const created = await f.request("POST", "/api/providers", { name: "Created", type: "openai_compatible", baseUrl: "https://created.example.test/v1", model: "fixed", apiKey: "new-secret" });
  expect(created.statusCode).toBe(201); expect(created.body.toString()).not.toContain("new-secret");
  const id = JSON.parse(created.body.toString()).data.id;
  expect(f.snapshot().providers[id].active).toBe(false);
  expect((await f.request("POST", "/api/auth/logout", {})).statusCode).toBe(200);
  expect((await f.request("POST", "/api/auth/register", { name: "New", email: "new@example.test", password: "synthetic-password" })).statusCode).toBe(403);
  expect(send).not.toHaveBeenCalled(); expect(f.enqueue).not.toHaveBeenCalled(); expect(f.sdk.callTool).not.toHaveBeenCalled(); expect(fixtures.construct).not.toHaveBeenCalled();
});

test("only the explicit selected test sends the fixed public literal and records measured provenance without changing selection", async () => {
  const f = await setup(true), before = f.snapshot().providers;
  const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }], usage: { prompt_tokens: 4, completion_tokens: 1 } }), { status: 200 })); vi.stubGlobal("fetch", send);
  const result = await f.request("POST", "/api/providers/replacement/test");
  expect(result.statusCode).toBe(200); expect(JSON.parse(result.body.toString()).data).toMatchObject({ ok: true, providerId: "replacement", model: "pinned-model", measured: true, inputTokens: 4, outputTokens: 1 });
  expect(send).toHaveBeenCalledOnce(); expect(send.mock.calls[0]![0]).toBe("https://replacement.example.test/v1/chat/completions");
  const payload = JSON.parse(String(send.mock.calls[0]![1]!.body));
  expect(payload.model).toBe("pinned-model"); expect(payload.messages).toEqual([{ role: "system", content: SAFETY_CONTRACT }, { role: "user", content: "Reply with exactly OK." }]);
  expect(f.snapshot().providers).toEqual(before);
  expect(Object.values(f.snapshot().invocationProvenance)).toEqual([expect.objectContaining({ providerId: "replacement", model: "pinned-model", promptTemplateVersion: "prompt/provider-test/v1", measured: true, inputTokens: 4, outputTokens: 1, status: "SUCCEEDED", fallbackUsed: false })]);
  expect(f.sdk.callTool).not.toHaveBeenCalled(); expect(f.enqueue).not.toHaveBeenCalled(); expect(fixtures.construct).not.toHaveBeenCalled();
});

test("normal probe failure records one failure without fallback, while lost provenance ACK stays sanitized 503", async () => {
  const f = await setup(), send = vi.fn<typeof fetch>().mockResolvedValue(new Response("private remote body", { status: 503 })); vi.stubGlobal("fetch", send);
  const failed = await f.request("POST", "/api/providers/replacement/test");
  expect(failed.statusCode).toBe(200); expect(JSON.parse(failed.body.toString()).data.ok).toBe(false); expect(failed.body.toString()).not.toContain("private remote");
  expect(send).toHaveBeenCalledOnce(); expect(Object.values(f.snapshot().invocationProvenance)).toEqual([expect.objectContaining({ status: "FAILED", model: "pinned-model", measured: false })]);
  send.mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), { status: 200 }));
  f.storage.commitBeforeFailure = true; f.storage.failWhen = state => Object.values(state.invocationProvenance).some(item => item.status === "SUCCEEDED");
  const unknown = await f.request("POST", "/api/providers/replacement/test"); expect(unknown.statusCode).toBe(503);
  expect(unknown.body.toString()).not.toContain("acknowledgement"); expect(JSON.parse(unknown.body.toString()).meta.code).toBe("FUNCTIONS_INVOCATION_UNCONFIRMED"); expect(send).toHaveBeenCalledTimes(2);
});

test("lost repository authority prevents probe fetch", async () => {
  const f = await setup(), repository = await Repository.open(f.storage), send = vi.fn<typeof fetch>();
  await repository.close();
  await expect(testProviderConnection(repository, providerConfigurationFromRecord(f.snapshot().providers.replacement, 1000), undefined, send)).rejects.toThrow();
  expect(send).not.toHaveBeenCalled();
});

test("selected probe is bounded even if the provider ignores cancellation and never falls back", async () => {
  const f = await setup(), send = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {})); vi.stubGlobal("fetch", send);
  f.config.generationTimeoutMs = 10;
  const result = await f.request("POST", "/api/providers/replacement/test");
  expect(result.statusCode).toBe(200); expect(JSON.parse(result.body.toString()).data).toMatchObject({ ok: false, message: "OpenAI-compatible request timed out" });
  expect(send).toHaveBeenCalledOnce(); expect(send.mock.calls[0]![1]!.signal!.aborted).toBe(true);
  expect(Object.values(f.snapshot().invocationProvenance)).toEqual([expect.objectContaining({ status: "FAILED", model: "pinned-model" })]);
});

test.each([false, true])("execution provider startup still fails closed with broken stored state (multiple=%s)", async multiple => {
  const f = await setup(multiple), setProvider = vi.spyOn(f.services.executor, "setAnalysisProvider"), send = vi.fn<typeof fetch>();
  const runtime = new ProviderRuntime(f.repository, f.services.executor, send);
  const fallback = providerConfigurationFromRecord(f.snapshot().providers.replacement, 1000);
  await expect(runtime.activateStoredOrStatic(fallback)).rejects.toThrow(multiple ? /Multiple active/ : /Unsupported configured provider/);
  expect(runtime.configured).toBe(false); expect(runtime.configuration).toBeNull(); expect(setProvider).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
});

test("an incoming invocation cancellation reaches the selected probe and records no successful inference", async () => {
  const f = await setup(), abort = new AbortController();
  const send = vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  })); vi.stubGlobal("fetch", send);
  const pending = handleFunctionHttp(f.input, { method: "POST", url: "/api/providers/replacement/test", headers: f.headers, signal: abort.signal });
  await vi.waitFor(() => expect(send).toHaveBeenCalledOnce()); abort.abort();
  const result = await pending; expect(result.statusCode).toBe(200); expect(JSON.parse(result.body.toString()).data.ok).toBe(false);
  expect(send.mock.calls[0]![1]!.signal!.aborted).toBe(true); expect(Object.values(f.snapshot().invocationProvenance)).toEqual([expect.objectContaining({ status: "FAILED" })]);
});

test("success awaits cleanup and cleanup/commit acknowledgement failure never automatically replays selection", async () => {
  const f = await setup(); let finish!: () => void, settled = false;
  f.close.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  const pending = f.request("POST", "/api/providers/replacement/activate").then(value => { settled = true; return value; });
  await vi.waitFor(() => expect(f.close).toHaveBeenCalledOnce()); expect(settled).toBe(false); finish(); expect((await pending).statusCode).toBe(200);
  f.close.mockRejectedValueOnce(new Error("private cleanup details"));
  const failed = await f.request("GET", "/api/providers"); expect(failed.statusCode).toBe(503); expect(failed.body.toString()).not.toContain("private cleanup");
  f.storage.commitBeforeFailure = true; f.storage.failWhen = state => state.auditLogs.filter(item => item.action === "provider.activated").length === 2;
  expect((await f.request("POST", "/api/providers/replacement/activate")).statusCode).toBe(503);
  expect(fixtures.open).toHaveBeenCalledTimes(3); expect(f.snapshot().auditLogs.filter((item: any) => item.action === "provider.activated")).toHaveLength(2);
});

test("HEAD and OPTIONS retain CORS, trace, no-store and body behavior; preflight never opens storage", async () => {
  const f = await setup();
  for (const url of ["/api/auth/me", "/api/providers"]) {
    const head = await f.request("HEAD", url); expect(head.statusCode).toBe(200); expect(head.body.length).toBe(0); expect(head.headers["x-trace-id"]).toBeTruthy(); expect(head.headers["cache-control"]).toBe("no-store");
  }
  fixtures.open.mockClear();
  for (const url of ["/api/auth/login", "/api/providers/replacement/activate", "/api/providers/replacement/test"]) {
    const headers = { origin: f.config.corsOrigins[0]!, "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type" };
    const full = await f.app.inject({ method: "OPTIONS", url, headers }), thin = await handleFunctionHttp(f.input, { method: "OPTIONS", url, headers });
    expect(thin.statusCode).toBe(full.statusCode); expect(thin.headers["access-control-allow-origin"]).toBe(full.headers["access-control-allow-origin"]); expect(thin.headers["cache-control"]).toBe("no-store"); expect(thin.headers["x-trace-id"]).toBeTruthy();
  }
  expect(fixtures.open).not.toHaveBeenCalled(); expect(fixtures.construct).not.toHaveBeenCalled();
});

test("original-byte limits remain outside recovery and malformed JSON retains existing handler semantics", async () => {
  const f = await setup();
  expect((await handleFunctionHttp(f.input, { method: "POST", url: "/api/auth/login", headers: {}, body: {} })).statusCode).toBe(400);
  expect((await handleFunctionHttp(f.input, { method: "POST", url: "/api/auth/login", headers: {}, rawBody: Buffer.alloc(10 * 1024 * 1024 + 1) })).statusCode).toBe(413);
  expect(fixtures.open).not.toHaveBeenCalled();
  for (const url of ["/api/auth/login", "/api/auth/refresh", "/api/providers", "/api/providers/replacement"]) {
    const method = url === "/api/providers/replacement" ? "PUT" : "POST", headers = { ...f.headers, "content-type": "application/json" };
    const full = await f.app.inject({ method, url, headers, payload: "{" });
    const thin = await handleFunctionHttp(f.input, { method, url, headers, rawBody: Buffer.from("{"), body: { name: "middleware must not repair bytes" } });
    expect(thin.statusCode).toBe(400); expect(JSON.parse(thin.body.toString())).toEqual(full.json());
  }
});

test.each(["activate", "test"])("provider %s requires original bytes; real empty-object bytes preserve mandatory auth and action semantics", async action => {
  const f = await setup(), url = `/api/providers/replacement/${action}`;
  const headers = { ...f.headers, "content-type": "application/json" };
  const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }], usage: { prompt_tokens: 4, completion_tokens: 1 } }), { status: 200 })); vi.stubGlobal("fetch", send);
  const rejected = await handleFunctionHttp(f.input, { method: "POST", url, headers, body: {} });
  expect(rejected.statusCode).toBe(400); expect(JSON.parse(rejected.body.toString()).meta.code).toBe("FUNCTIONS_RAW_BODY_REQUIRED");
  expect(fixtures.open).not.toHaveBeenCalled(); expect(fixtures.construct).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  const rawBody = Buffer.from("{}", "utf8");
  expect((await handleFunctionHttp(f.input, { method: "POST", url, headers: { "content-type": "application/json" }, body: {}, rawBody })).statusCode).toBe(401);
  expect(send).not.toHaveBeenCalled();
  const allowed = await handleFunctionHttp(f.input, { method: "POST", url, headers, body: {}, rawBody });
  expect(allowed.statusCode).toBe(200);
  if (action === "activate") {
    expect(JSON.parse(allowed.body.toString()).meta).toMatchObject({ activationScope: "stored-configuration", runtimeActivationConfirmed: false, remoteCompatibilityConfirmed: false });
    expect(f.snapshot().providers.replacement.active).toBe(true); expect(send).not.toHaveBeenCalled();
  } else {
    expect(JSON.parse(allowed.body.toString()).data).toMatchObject({ ok: true, providerId: "replacement", model: "pinned-model", measured: true });
    expect(send).toHaveBeenCalledOnce(); expect(f.snapshot().providers.replacement.active).toBe(false);
  }
  expect(f.sdk.callTool).not.toHaveBeenCalled(); expect(f.enqueue).not.toHaveBeenCalled(); expect(fixtures.construct).not.toHaveBeenCalled();
});

test("exact negative selectors keep arbitrary auth/provider paths, methods and hosts on the full runtime", async () => {
  const f = await setup();
  for (const [method, url] of [ ["GET", "/api/auth/login"], ["POST", "/api/auth/me"], ["GET", "/api/auth/oauth/x/callback"], ["PATCH", "/api/providers/replacement"], ["DELETE", "/api/providers/replacement"], ["GET", "/api/providers/replacement/test"], ["POST", "/api/providers/replacement/test/more"], ["GET", "/api/providers/"], ["GET", "/api/providers%2f"], ["POST", "/api/providers/x%2fy/test"], ["HEAD", "/api/auth/login"] ]) {
    const request = { method: method!, url: url!, headers: f.headers };
    expect(isFunctionControlPlaneRequest(f.config, request)).toBe(false);
    expect((await handleFunctionHttp(f.input, request)).statusCode).toBe(503);
  }
  const request = { method: "GET", url: "/api/providers", headers: f.headers };
  expect(isFunctionControlPlaneRequest({ ...f.config, storageDriver: "memory" }, request)).toBe(false);
  expect(isFunctionControlPlaneRequest({ ...f.config, apiBasePath: "/other" }, request)).toBe(false);
  expect(isFunctionControlPlaneRequest(f.config, { ...request, url: "/api/providers?source=repair" })).toBe(true);
  expect(fixtures.construct).toHaveBeenCalledTimes(11);
});
