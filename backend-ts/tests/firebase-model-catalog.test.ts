import { beforeEach, expect, test, vi } from "vitest";
import jwt from "jsonwebtoken";
import { loadConfig } from "../src/config/config.js";
import { handleFunctionHttp } from "../src/firebase/http.js";
import { isFunctionProgressRequest } from "../src/firebase/progress-http.js";
import { initialState, Repository } from "../src/repository/store.js";
import { ProviderRuntime } from "../src/providers/runtime.js";
import type { Executor } from "../src/runner/executor.js";
import { staticProviderConfiguration } from "../src/providers/static-configuration.js";

const readers = vi.hoisted(() => ({ open: vi.fn(), snapshot: vi.fn(), close: vi.fn(), invoke: vi.fn() }));
vi.mock("../src/storage/firestore-progress-reader.js", () => ({ openFirestoreProgressReader: readers.open }));
vi.mock("../src/firebase/progress-reader-pool.js", () => ({ borrowProgressReader: readers.open }));
vi.mock("../src/firebase/invocation.js", () => ({ withFunctionRuntime: readers.invoke }));
beforeEach(() => vi.resetAllMocks());
function setup() {
  const config = { ...loadConfig({ APP_ENV: "test", MCP_MODE: "mock", JWT_SECRET: "catalog-secret-at-least-thirty-two-bytes" }), storageDriver: "firestore-records" as const };
  const state = initialState();
  state.users.owner = { id: "owner", name: "Owner", email: "owner@example.test", roleId: "role_admin", permissionOverrides: [], status: "Active",
    initials: "O", departmentId: null, lastLoginAt: null, createdAt: new Date().toISOString() };
  readers.snapshot.mockImplementation(async () => structuredClone(state));
  readers.close.mockResolvedValue(undefined); readers.open.mockReturnValue({ snapshot: readers.snapshot, close: readers.close });
  readers.invoke.mockRejectedValue(new Error("Catalog must not acquire writer/MCP/provider runtime"));
  const headers = { authorization: `Bearer ${jwt.sign({}, config.jwtSecret, { subject: "owner", expiresIn: 3600 })}` };
  const transport = { timeoutMs: 1000, enqueue: vi.fn() }, input = { config, root: process.cwd(), transport };
  const get = (url = "/api/chat/models", extra = {}) => handleFunctionHttp(input, { method: "GET", url, headers, ...extra });
  const provider = { id: "saved", name: "Saved", type: "openai_compatible", baseUrl: "https://provider.example.test/v1", apiKey: "private-provider-key",
    model: "model-a", fallbackModel: "model-c", additionalModels: ["model-b", " model-a "], active: true, temperature: 0, revision: 1 };
  return { config, state, headers, transport, input, get, provider };
}

test("model catalog is an authenticated nonwriter snapshot, even when opening the full runtime is refused", async () => {
  const f = setup(), result = await f.get();
  expect(result.statusCode, result.body.toString()).toBe(200);
  expect(JSON.parse(result.body.toString()).data).toEqual({ configured: false, binding: null, models: [] });
  expect(result.headers["cache-control"]).toBe("no-store"); expect(result.headers["x-trace-id"]).toBeTruthy();
  expect(readers.invoke).not.toHaveBeenCalled(); expect(f.transport.enqueue).not.toHaveBeenCalled(); expect(readers.close).toHaveBeenCalledOnce();
});

test("saved catalog matches actual runtime choices without inventing an activated runtime epoch or leaking credentials", async () => {
  const f = setup(); f.state.providers.saved = f.provider; f.state.providers.inactive = { ...f.provider, id: "inactive", model: "hidden-model", active: false };
  const repository = new Repository(null, f.state), runtime = new ProviderRuntime(repository, { setAnalysisProvider: vi.fn() } as unknown as Executor);
  await runtime.activateStoredOrStatic(null);
  const result = await f.get(), body = JSON.parse(result.body.toString()), actual = runtime.catalog();
  expect(result.statusCode).toBe(200); expect(body.data).toEqual({ ...actual, binding: { ...actual.binding, configurationRevision: null } });
  expect(body.meta).toMatchObject({ source: "committed-configuration", runtimeActivationConfirmed: false });
  expect(result.body.toString()).not.toMatch(/private-provider-key|provider\.example|hidden-model/);
  expect(readers.invoke).not.toHaveBeenCalled(); expect(f.transport.enqueue).not.toHaveBeenCalled(); await repository.close();
});

test("environment fallback and stored-provider precedence remain consistent across fresh reads", async () => {
  const f = setup(); Object.assign(f.config, { generationBaseURL: "https://static.example.test/v1", generationAPIKey: "private-static-key",
    generationModelPrimary: "static-a", generationModelFallback: "static-b", generationTemperature: 0, generationTimeoutMs: 1000 });
  const initial = await f.get(); expect(JSON.parse(initial.body.toString()).data).toMatchObject({ configured: true, binding: { providerId: "provider_static", model: "static-a", configurationRevision: null }, models: ["static-a", "static-b"] });
  const repository = new Repository(null, f.state), runtime = new ProviderRuntime(repository, { setAnalysisProvider: vi.fn() } as unknown as Executor);
  await runtime.activateStoredOrStatic(staticProviderConfiguration(f.config), f.config.generationTimeoutMs);
  const actual = runtime.catalog(); expect(JSON.parse(initial.body.toString()).data).toEqual({ ...actual, binding: { ...actual.binding, configurationRevision: null } });
  await repository.close();
  f.state.providers.saved = f.provider;
  const stored = await f.get(); expect(JSON.parse(stored.body.toString()).data.models).toEqual(["model-a", "model-c", "model-b"]);
  expect(stored.body.toString()).not.toMatch(/private-static-key|static\.example/); expect(readers.snapshot).toHaveBeenCalledTimes(2);
});

test("environment Qwen choices match execution and nonwriter catalog without replacing selected models or saved providers", async () => {
  const f = setup(); Object.assign(f.config, { generationBaseURL: "https://openrouter.ai/api/v1", generationAPIKey: "private-static-key",
    generationModelPrimary: "deepseek/deepseek-v4.1-flash", generationModelFallback: "owner-backup",
    generationAdditionalModels: ["qwen/qwen3.7-plus", "qwen/qwen3.8-flash"] });
  const configuration = staticProviderConfiguration(f.config)!;
  expect(configuration.model).toBe("deepseek/deepseek-v4.1-flash"); expect(configuration.fallbackModel).toBe("owner-backup");
  const repository = new Repository(null, f.state), runtime = new ProviderRuntime(repository, { setAnalysisProvider: vi.fn() } as unknown as Executor);
  await runtime.activateStoredOrStatic(configuration);
  const result = await f.get(), data = JSON.parse(result.body.toString()).data;
  expect(data.models).toEqual(["deepseek/deepseek-v4.1-flash", "owner-backup", "qwen/qwen3.7-plus", "qwen/qwen3.8-flash"]);
  expect(data.models).toEqual(runtime.catalog().models); expect(result.body.toString()).not.toContain("private-static-key");
  f.state.providers.saved = f.provider;
  expect(JSON.parse((await f.get()).body.toString()).data.models).toEqual(["model-a", "model-c", "model-b"]);
  expect(configuration.additionalModels).toEqual(["qwen/qwen3.7-plus", "qwen/qwen3.8-flash"]);
  expect(readers.invoke).not.toHaveBeenCalled(); await repository.close();
});

test.each(["multiple-active", "unsupported", "unpinned", "no-key", "changed-origin"])("invalid %s provider configuration fails closed without an empty-success or writer fallback", async damage => {
  const f = setup(); f.state.providers.saved = f.provider;
  if (damage === "multiple-active") f.state.providers.second = { ...f.provider, id: "second" };
  if (damage === "unsupported") f.provider.type = "unsupported-private-detail";
  if (damage === "unpinned") f.provider.model = "model:latest";
  if (damage === "no-key") f.provider.apiKey = "";
  if (damage === "changed-origin") f.state.providers.saved.egressPolicy = { profile: "model-egress-policy/v1", approvedOrigin: "https://wrong.example.test", runtimeAnalysisDataClasses: [] };
  const result = await f.get(); expect(result.statusCode).toBe(503);
  expect(result.body.toString()).not.toMatch(/private-provider-key|unsupported-private-detail|wrong\.example|model:latest/);
  expect(readers.invoke).not.toHaveBeenCalled(); expect(f.transport.enqueue).not.toHaveBeenCalled();
});

test("current account/permission revocation and invalid JWT remain authoritative", async () => {
  const f = setup(); expect((await f.get(undefined, { headers: {} })).statusCode).toBe(401); expect(readers.open).not.toHaveBeenCalled();
  f.state.roles.role_admin!.permissions = []; expect((await f.get()).statusCode).toBe(403);
  f.state.users.owner!.status = "Suspended"; expect((await f.get()).statusCode).toBe(403);
  expect(readers.invoke).not.toHaveBeenCalled();
});

test("chat-only users can read current model choices without receiving provider-administration rights", async () => {
  const f = setup(); f.state.providers.saved = f.provider;
  f.state.roles.role_admin!.permissions = ["chat:use"];
  expect((await f.get()).statusCode).toBe(200);
  f.provider.active = false; expect(JSON.parse((await f.get()).body.toString()).data.configured).toBe(false);
  f.state.roles.role_admin!.permissions = []; expect((await f.get()).statusCode).toBe(403);
  expect(readers.invoke).not.toHaveBeenCalled(); expect(f.transport.enqueue).not.toHaveBeenCalled();
});

test("an unavailable committed snapshot fails closed without provider activation or writer fallback", async () => {
  const f = setup(); readers.snapshot.mockRejectedValueOnce(new Error("private-storage-detail"));
  const result = await f.get(); expect(result.statusCode).toBe(503);
  const body = JSON.parse(result.body.toString()); expect(body.meta.code).toBe("FUNCTIONS_MODEL_CATALOG_UNAVAILABLE");
  expect(result.body.toString()).not.toContain("private-storage-detail");
  expect(readers.close).toHaveBeenCalledOnce(); expect(readers.invoke).not.toHaveBeenCalled();
});

test("only the exact catalog read is admitted; commands, extra queries and request bodies do not become nonwriter work", async () => {
  const f = setup();
  for (const method of ["GET", "HEAD", "OPTIONS"]) expect(isFunctionProgressRequest(f.config, { method, url: "/api/chat/models", headers: {} })).toBe(true);
  for (const method of ["POST", "PUT", "DELETE"]) expect(isFunctionProgressRequest(f.config, { method, url: "/api/chat/models", headers: {} })).toBe(false);
  for (const url of ["/api/providers", "/api/chat/models/activate", "/api/chat/models/extra"]) expect(isFunctionProgressRequest(f.config, { method: "GET", url, headers: {} })).toBe(false);
  expect((await f.get("/api/chat/models?model=arbitrary")).statusCode).toBe(400);
  expect((await f.get(undefined, { rawBody: Buffer.from("{}") })).statusCode).toBe(400);
  expect(readers.open).not.toHaveBeenCalled(); expect(readers.invoke).not.toHaveBeenCalled();
});

test("HEAD/preflight and reader cleanup retain their existing contracts", async () => {
  const f = setup();
  const options = await f.get(undefined, { method: "OPTIONS", headers: { origin: "http://localhost:5173", "access-control-request-method": "GET" } });
  expect(options.statusCode).toBe(204); expect(readers.open).not.toHaveBeenCalled();
  const head = await f.get(undefined, { method: "HEAD" }); expect(head.statusCode).toBe(200); expect(head.body.length).toBe(0);
  readers.close.mockRejectedValueOnce(new Error("private-cleanup-detail"));
  const failed = await f.get(); expect(failed.statusCode).toBe(503); expect(failed.body.toString()).not.toContain("private-cleanup-detail");
  expect(readers.invoke).not.toHaveBeenCalled();
});
