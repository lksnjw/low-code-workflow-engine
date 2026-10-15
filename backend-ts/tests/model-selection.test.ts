import { resolve } from "node:path";
import jwt from "jsonwebtoken";
import { afterEach, expect, test, vi } from "vitest";
import { loadConfig } from "../src/config/config.js";
import { buildApp } from "../src/http/app.js";
import { ProviderRuntime, type RuntimeProviderConfiguration } from "../src/providers/runtime.js";
import { Repository } from "../src/repository/store.js";
import { RegistryService } from "../src/registry/service.js";
import { RegistryValidator } from "../src/validator/registry-validator.js";
import { Executor } from "../src/runner/executor.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { SynthesisService } from "../src/synthesis/service.js";
import { createErpbridgeMcpSession } from "../src/tools/erpbridge-mcp-client.js";
import { workflowContentHash } from "../src/parser/workflow.js";
import { runQueryLoop } from "../src/agent/query-loop.js";
import type { Workflow } from "../src/models/schemas.js";

const configuration: RuntimeProviderConfiguration = { id: "fixture", name: "Fixture provider", type: "openai_compatible",
  baseURL: "https://old-provider.example.invalid/v1", apiKey: "fixture-old-key", model: "model-a", additionalModels: ["model-b"],
  fallbackModel: "model-c", temperature: 0, timeoutMs: 1000, egressPolicy: { profile: "model-egress-policy/v1", approvedOrigin: "https://old-provider.example.invalid",
    runtimeAnalysisDataClasses: [], interactiveDataClasses: ["restricted"], reviewedAt: "2026-10-07T00:00:00.000Z", reviewedBy: { id: "admin", name: "admin" } } };
const yaml = 'name: Report\ndescription: Read report\ntrigger:\n  type: manual\nsteps:\n  - id: read\n    action: demo.echo\n    parameters:\n      value: fixture';
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

async function setup(timeoutMs = 30_000, deferredBridge = false) {
  const config = { ...loadConfig({ APP_ENV: "test", JWT_SECRET: "model-selection-secret-at-least-32-bytes", STORAGE_DRIVER: "memory", MCP_MODE: "mock" }), generationTimeoutMs: timeoutMs, erpbridgeRoleMap: { "Platform Admin": "admin" } };
  const repository = new Repository(), timestamp = new Date().toISOString();
  await repository.mutate((state) => {
    for (const [id, roleId] of [["admin", "role_admin"], ["client", "role_client"]]) state.users[id!] = {
      id: id!, name: id!, email: `${id}@example.test`, roleId: roleId!, permissionOverrides: [], status: "Active", initials: "U", departmentId: null, lastLoginAt: null, createdAt: timestamp,
    };
    state.workflows.report = { id: "report", name: "Report", description: "Read report", owner: { id: "admin", name: "Admin" }, assignedUserIds: [], status: "PENDING", trigger: { type: "manual" }, steps: 1, successRate: 0,
      lastRunAt: null, publishedVersion: 0, draftVersion: 1, tags: [], domainTags: [], canRun: false, createdAt: timestamp, updatedAt: timestamp, yaml, archived: false } satisfies Workflow;
  });
  const registries = await RegistryService.load(resolve("tests/fixtures/chat-read-tools.json"), resolve("tests/fixtures/rules.json"));
  const validator = new RegistryValidator(registries, repository), executor = new Executor(new ToolRegistry(), validator);
  const fetchImplementation = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const system = body.messages[0].content;
    let content = "Confirmed fixture read.", tool_calls;
    if (system.includes("WORKFLOW DRAFT SYNTHESIS")) content = yaml;
    else if (system.includes("ONE SELECTED NODE PATCH")) content = '{"description":"Reviewed"}';
    else if (system.includes("NATURAL SAVED-WORKFLOW EDIT")) content = JSON.stringify({ kind: "proposal", yaml: yaml.replace("name: Report", "name: Changed"), summary: "Renamed the saved workflow." });
    else if (!body.messages.some((message: { role: string }) => message.role === "tool")) {
      content = ""; tool_calls = [{ id: "read-one", type: "function", function: { name: "demo.echo", arguments: '{"value":"fixture"}' } }];
    }
    return Response.json({ choices: [{ finish_reason: tool_calls ? "tool_calls" : "stop", message: { content, ...(tool_calls ? { tool_calls } : {}) } }] });
  });
  const runtime = new ProviderRuntime(repository, executor, fetchImplementation); runtime.activate(configuration);
  const callTool = vi.fn(async () => ({ content: [], structuredContent: { value: "fixture" } }));
  const bridge = await createErpbridgeMcpSession({ baseURL: "https://bridge.example.invalid", token: "fixture", timeoutMs: 1000, validator,
    sdkClient: { connect: async () => {}, close: async () => {}, listTools: async () => registries.snapshot().tools.map((tool) => ({ name: tool.mcp_tool_name, inputSchema: tool.input_schema })), callTool } });
  let connected = !deferredBridge;
  const ensureSession = vi.fn(async () => { connected = true; });
  const app = await buildApp({ config, repository, registries, validator, executor, providerRuntime: runtime, synthesis: new SynthesisService(runtime, registries, validator),
    get erpbridgeSession() { return connected ? bridge : undefined; },
    ...(deferredBridge ? { mcpConnectionRuntime: { ensureSession, admissionConfigurationBinding: bridge.admissionBinding,
      primaryConnectionId: "erpbridge-default", hasConnection: (id: string) => id === "erpbridge-default",
      sessionFor: () => connected ? bridge : undefined, roleMapFor: () => config.erpbridgeRoleMap } as any } : {}) }); apps.push(app);
  const headers = (id = "admin") => ({ authorization: `Bearer ${jwt.sign({}, config.jwtSecret, { algorithm: "HS256", subject: id, expiresIn: 3600 })}` });
  const chat = await app.inject({ method: "POST", url: "/api/chat/sessions", headers: headers(), payload: { title: "Model check" } });
  const sessionId = chat.json().data.id;
  const send = (content: string, extra: Record<string, unknown> = {}) => app.inject({ method: "POST", url: `/api/chat/sessions/${sessionId}/messages`, headers: headers(), payload: { content, ...extra } });
  return { app, repository, registries, runtime, fetchImplementation, callTool, headers, sessionId, send, ensureSession };
}

test.each([false, true])("selected model preserves deferred ERP discovery for synchronous/queued authoring (queued=%s)", async queued => {
  const s = await setup(30000, true);
  const r = await s.send("Create a workflow to read invoices", { model: "model-b", ...(queued ? { delivery: "async-chat", idempotencyKey: "deferred-erp-workflow-regression-001" } : {}) });
  expect(r.statusCode, r.body).toBe(queued ? 202 : 200);
  if (queued) await vi.waitFor(async () => {
    const operations = Object.values((await s.repository.snapshot()).chatOperations);
    expect(operations).toHaveLength(1); expect(operations[0]?.status).toBe("ANSWERED");
  }, { timeout: 3500 });
  expect(s.ensureSession).toHaveBeenCalled();
  const synthesis = s.fetchImplementation.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))
    .find(wire => wire.messages[0].content.includes("WORKFLOW DRAFT SYNTHESIS"));
  expect(synthesis).toBeDefined();
  expect(JSON.parse(synthesis.messages[1].content).TOOL_REGISTRY_JSON.map((tool: { name: string }) => tool.name)).toContain("demo.echo");
  expect(s.callTool).not.toHaveBeenCalled();
});

test.each(["Show me invoices", "Execute the read operation", "Get invoice details and email them to manager@example.test", "Create a workflow to read invoices", "Modify the workflow name"])("selected model reaches the correct chat path: %s", async (content) => {
  const s = await setup();
  const result = await s.send(content, { model: "model-b", workflowContext: { workflowId: "report", baseVersion: 1, baseHash: workflowContentHash(yaml) } });
  expect(result.statusCode, result.body).toBe(200);
  expect(s.fetchImplementation.mock.calls.length).toBeGreaterThan(0);
  expect(s.fetchImplementation.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).model)).toEqual(s.fetchImplementation.mock.calls.map(() => "model-b"));
  expect(s.runtime.configuration?.model).toBe("model-a");
  expect((await s.repository.snapshot()).chats[s.sessionId]?.selectedModel).toBe("model-b");
  const provenance = Object.values((await s.repository.snapshot()).invocationProvenance);
  expect(provenance.every((entry) => entry.model === "model-b" && entry.configurationRevision && entry.providerId === "fixture")).toBe(true);
  if (result.json().data.usage) expect(result.json().data.usage.measured).toBe(false);
});

test("selected-node proposal uses and persists the same session selection without applying it", async () => {
  const s = await setup();
  const result = await s.app.inject({ method: "POST", url: "/api/workflows/report/node-proposals", headers: s.headers(),
    payload: { baseVersion: 1, baseHash: workflowContentHash(yaml), nodeId: "read", prompt: "Rename the description", sessionId: s.sessionId, model: "model-b" } });
  expect(result.statusCode, result.body).toBe(200);
  expect(result.json().data.modelBinding).toMatchObject({ model: "model-b", providerId: "fixture" });
  expect(JSON.parse(String(s.fetchImplementation.mock.calls[0]?.[1]?.body)).model).toBe("model-b");
  expect((await s.repository.snapshot()).workflows.report?.yaml).toBe(yaml);
  expect((await s.repository.snapshot()).chats[s.sessionId]?.selectedModel).toBe("model-b");
});

test("legacy client YAML is not an authoritative saved-workflow selector or permission to create an unrelated draft", async () => {
  const s = await setup(), before = await s.repository.snapshot();
  const result = await s.send("Modify the workflow name", { model: "model-b", workflowContext: { name: "Report", yaml } });
  expect(result.statusCode).toBe(200); expect(result.json().data.assistantMessage.artifacts).toMatchObject({ intent: "CONVERSATION", needsClarification: true, toolsDispatched: false });
  expect(s.fetchImplementation).not.toHaveBeenCalled(); expect(s.callTool).not.toHaveBeenCalled();
  expect((await s.repository.snapshot()).workflows).toEqual(before.workflows);
});

test("direct synthesis respects selection and invalid model fails before a provider call", async () => {
  const s = await setup();
  const result = await s.app.inject({ method: "POST", url: "/api/synthesis", headers: s.headers(), payload: { prompt: "Create report", model: "model-b" } });
  expect(result.statusCode, result.body).toBe(200);
  expect(result.json().data.candidate.generation_metadata.model).toBe("model-b");
  s.fetchImplementation.mockClear();
  const invalid = await s.app.inject({ method: "POST", url: "/api/synthesis", headers: s.headers(), payload: { prompt: "Create report", model: "unconfigured" } });
  expect(invalid.statusCode).toBe(422); expect(s.fetchImplementation).not.toHaveBeenCalled();
});

test("non-admin chat users receive only the active safe model catalog", async () => {
  const s = await setup();
  const result = await s.app.inject({ method: "GET", url: "/api/chat/models", headers: s.headers("client") });
  expect(result.statusCode).toBe(200); expect(result.json().data.models).toEqual(["model-a", "model-c", "model-b"]);
  expect(result.body).not.toContain("fixture-old-key"); expect(result.body).not.toContain("old-provider.example");
  expect((await s.app.inject({ method: "GET", url: "/api/providers", headers: s.headers("client") })).statusCode).toBe(403);
  expect((await s.app.inject({ method: "GET", url: "/api/chat/models" })).statusCode).toBe(401);
});

test.each(["unconfigured", 123, { model: "model-b" }])("invalid model %j cannot enter model or tool dispatch", async (model) => {
  const s = await setup(); const result = await s.send("Show me invoices", { model });
  expect(result.statusCode).toBe(422); expect(s.fetchImplementation).not.toHaveBeenCalled(); expect(s.callTool).not.toHaveBeenCalled();
  expect((await s.repository.snapshot()).chats[s.sessionId]?.messages).toHaveLength(0);
});

test("session selection survives save/reload and omitted model; removed choices fail rather than switch", async () => {
  const s = await setup();
  const patch = await s.app.inject({ method: "PATCH", url: `/api/chat/sessions/${s.sessionId}`, headers: s.headers(), payload: { selectedModel: "model-b" } });
  expect(patch.statusCode).toBe(200); expect(patch.json().data.title).toBe("Model check");
  const reopened = new Repository(null, await s.repository.snapshot());
  expect((await reopened.snapshot()).chats[s.sessionId]?.selectedModel).toBe("model-b");
  expect((await s.send("Show me invoices")).statusCode).toBe(200);
  expect(s.fetchImplementation.mock.calls.every(([, init]) => JSON.parse(String(init?.body)).model === "model-b")).toBe(true);
  s.runtime.activate({ ...configuration, additionalModels: [] }); s.fetchImplementation.mockClear();
  expect((await s.send("Show me invoices")).statusCode).toBe(422); expect(s.fetchImplementation).not.toHaveBeenCalled();
});

test("admin activation mid-query cannot change a later turn's endpoint, credential, model or revision", async () => {
  const s = await setup(), original = s.fetchImplementation.getMockImplementation()!;
  s.fetchImplementation.mockImplementation(async (...args) => {
    const response = await original(...args);
    if (s.fetchImplementation.mock.calls.length === 1) s.runtime.activate({ ...configuration, id: "new", apiKey: "new-key", baseURL: "https://new.example.invalid/v1", model: "model-d", temperature: 1,
      egressPolicy: { ...configuration.egressPolicy!, approvedOrigin: "https://new.example.invalid" } });
    return response;
  });
  const result = await s.send("Show me invoices", { model: "model-b" });
  expect(result.statusCode, result.body).toBe(200); expect(s.fetchImplementation).toHaveBeenCalledTimes(2);
  for (const [url, init] of s.fetchImplementation.mock.calls) {
    expect(url).toBe(configuration.baseURL + "/chat/completions");
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer fixture-old-key");
    expect(JSON.parse(String(init?.body))).toMatchObject({ model: "model-b", temperature: 0 });
  }
  const records = Object.values((await s.repository.snapshot()).invocationProvenance);
  expect(new Set(records.map((entry) => entry.configurationRevision)).size).toBe(1);
  expect(records.every((entry) => entry.measured === false)).toBe(true);
  expect(s.runtime.binding?.model).toBe("model-d");
});

test.each(["Show me invoices", "Execute the read operation", "Create a workflow to read invoices", "Modify the workflow name"])("revocation during final model work prevents persistence/delivery: %s", async (content) => {
  const s = await setup(), original = s.fetchImplementation.getMockImplementation()!;
  s.fetchImplementation.mockImplementation(async (...args) => {
    const response = await original(...args);
    const body = JSON.parse(String(args[1]?.body));
    if (body.messages.some((message: { role: string }) => message.role === "tool") || !body.tools) await s.repository.mutate((state) => { state.users.admin!.status = "Disabled"; });
    return response;
  });
  const result = await s.send(content, { model: "model-b", workflowContext: { workflowId: "report", baseVersion: 1, baseHash: workflowContentHash(yaml) } });
  expect(result.statusCode, result.body).toBe(403);
  expect((await s.repository.snapshot()).chats[s.sessionId]?.messages).toHaveLength(1);
  expect(Object.keys((await s.repository.snapshot()).workflows)).toEqual(["report"]);
});

test("generation fallback stays on its captured provider even when admin activation changes", async () => {
  const s = await setup(), original = s.fetchImplementation.getMockImplementation()!;
  s.fetchImplementation.mockImplementationOnce(async () => {
    s.runtime.activate({ ...configuration, baseURL: "https://new.example.invalid/v1", apiKey: "new-key", model: "model-d",
      egressPolicy: { ...configuration.egressPolicy!, approvedOrigin: "https://new.example.invalid" } });
    return new Response("", { status: 503 });
  }).mockImplementation(original);
  const result = await s.send("Create a workflow to read invoices", { model: "model-b" });
  expect(result.statusCode).toBe(200);
  expect(s.fetchImplementation.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).model)).toEqual(["model-b", "model-c"]);
  expect(s.fetchImplementation.mock.calls.every(([url]) => url === configuration.baseURL + "/chat/completions")).toBe(true);
  expect(Object.values((await s.repository.snapshot()).invocationProvenance).map((entry) => entry.fallbackUsed)).toEqual([false, true]);
});

test.each(["Show me invoices", "Execute the read operation"])("%s switches only model inference after a confirmed read, without replaying ERP", async content => {
  const s = await setup(), original = s.fetchImplementation.getMockImplementation()!;
  s.fetchImplementation.mockImplementation(async (...args) => {
    const body = JSON.parse(String(args[1]?.body));
    if (body.model === "model-b" && body.messages.some((message: any) => message.role === "tool")) return new Response("", { status: 503 });
    const response = await original(...args), decoded: any = await response.json();
    if (decoded.choices[0].finish_reason === "tool_calls") decoded.choices[0].message.reasoning_details = [{ type: "reasoning.encrypted", data: "private-continuation-marker", id: "signature-one" }];
    return Response.json(decoded);
  });
  const result = await s.send(content, { model: "model-b" }); expect(result.statusCode, result.body).toBe(200);
  expect(s.fetchImplementation.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).model)).toEqual(["model-b", "model-b", "model-c"]);
  expect(s.callTool).toHaveBeenCalledTimes(1);
  const selectedWire = JSON.parse(String(s.fetchImplementation.mock.calls[1]![1]?.body));
  expect(selectedWire.messages.find((message: any) => message.role === "assistant").reasoning_details[0].data).toBe("private-continuation-marker");
  const backupWire = JSON.parse(String(s.fetchImplementation.mock.calls[2]![1]?.body));
  expect(backupWire.messages.find((message: any) => message.role === "assistant")).not.toHaveProperty("reasoning_details");
  expect(backupWire.messages.some((message: any) => message.role === "tool")).toBe(true);
  expect(result.json().data.modelBinding).toMatchObject({ requestedModel: "model-b", model: "model-c", fallbackUsed: true });
  expect(result.json().data.assistantMessage.artifacts.modelRouting).toEqual({ requestedModel: "model-b", model: "model-c", fallbackUsed: true });
  const state = await s.repository.snapshot();
  expect(state.chats[s.sessionId]!.selectedModel).toBe("model-b"); expect(state.chats[s.sessionId]!.messages.at(-1)!.modelBinding).toMatchObject({ model: "model-c" });
  expect(JSON.stringify(state.chats)).not.toMatch(/private-continuation-marker|providerContinuationSecret/);
  expect(s.runtime.binding!.model).toBe("model-a");
});

test("initial failover stays with backup for subsequent rounds but not the next user request", async () => {
  const s = await setup(), original = s.fetchImplementation.getMockImplementation()!;
  s.fetchImplementation.mockResolvedValueOnce(new Response("", { status: 503 })).mockImplementation(original);
  const result = await s.send("Show me invoices", { model: "model-b" }); expect(result.statusCode, result.body).toBe(200);
  expect(s.fetchImplementation.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).model)).toEqual(["model-b", "model-c", "model-c"]);
  expect(s.callTool).toHaveBeenCalledTimes(1); expect(result.json().data.usage.measured).toBe(false);
  s.fetchImplementation.mockClear();
  expect((await s.send("Show me invoices")).statusCode).toBe(200);
  expect(s.fetchImplementation.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).model)).toEqual(["model-b", "model-b"]);
});

test("query fallback captures endpoint, credential and revision despite admin reactivation", async () => {
  const s = await setup(), original = s.fetchImplementation.getMockImplementation()!;
  s.fetchImplementation.mockImplementationOnce(async () => {
    s.runtime.activate({ ...configuration, baseURL: "https://new.example.invalid/v1", apiKey: "new-key", model: "model-d", fallbackModel: "model-e",
      egressPolicy: { ...configuration.egressPolicy!, approvedOrigin: "https://new.example.invalid" } });
    return new Response("", { status: 503 });
  }).mockImplementation(original);
  expect((await s.send("Show me invoices", { model: "model-b" })).statusCode).toBe(200);
  expect(s.fetchImplementation.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).model)).toEqual(["model-b", "model-c", "model-c"]);
  expect(s.fetchImplementation.mock.calls.every(([url, init]) => url === configuration.baseURL + "/chat/completions" && (init?.headers as any).authorization === "Bearer fixture-old-key")).toBe(true);
  expect(new Set(Object.values((await s.repository.snapshot()).invocationProvenance).map(row => row.configurationRevision)).size).toBe(1);
});

test("stored active config wins at restart, and snapshot does not mutate executor defaults", async () => {
  const s = await setup();
  await s.repository.mutate((state) => { state.providers.saved = { id: "saved", name: "Saved", type: "openai_compatible", baseUrl: configuration.baseURL, apiKey: "saved-key", model: "saved-model", additionalModels: ["saved-extra"], active: true }; });
  await s.runtime.activateStoredOrStatic(configuration);
  const spy = vi.spyOn(s.runtime.executor, "setAnalysisProvider");
  const scoped = s.runtime.snapshot("saved-extra");
  expect(scoped.binding?.model).toBe("saved-extra"); expect(s.runtime.binding?.model).toBe("saved-model"); expect(spy).not.toHaveBeenCalled();
});

test.each([30_000, 7123])("stored provider activation/restart preserve the exact configured %i ms timeout", async timeoutMs => {
  const s = await setup(timeoutMs);
  const created = await s.app.inject({ method: "POST", url: "/api/providers", headers: s.headers(), payload: {
    name: "Restart consistency", type: "openai_compatible", baseUrl: configuration.baseURL, apiKey: "synthetic-restart-key",
    model: "saved-model", additionalModels: ["saved-extra"], temperature: 0 } });
  expect(created.statusCode).toBe(201);
  const activated = await s.app.inject({ method: "POST", url: `/api/providers/${created.json().data.id}/activate`, headers: s.headers(), payload: {} });
  expect(activated.statusCode).toBe(200);
  const captured = s.runtime.configuration!, revision = s.runtime.binding!.configurationRevision;
  expect(captured.timeoutMs).toBe(timeoutMs);
  for (const fallback of [null, configuration]) {
    const restarted = new ProviderRuntime(s.repository, s.runtime.executor, s.fetchImplementation);
    await restarted.activateStoredOrStatic(fallback, timeoutMs);
    expect(restarted.configuration).toEqual(captured);
    expect(restarted.binding!.configurationRevision).not.toBe(revision);
  }
  expect(s.fetchImplementation).not.toHaveBeenCalled();
});

test("provider fallback and additional choices survive edit without exposing credentials", async () => {
  const s = await setup();
  const created = await s.app.inject({ method: "POST", url: "/api/providers", headers: s.headers(), payload: { name: "Saved", type: "openai_compatible", baseUrl: configuration.baseURL, apiKey: "saved-secret", model: "saved-model", fallbackModel: "saved-fallback", additionalModels: ["saved-extra"] } });
  expect(created.statusCode).toBe(201);
  const id = created.json().data.id;
  expect(created.body).not.toContain("saved-secret");
  expect(created.json().data.egressPolicy).toMatchObject({ profile: "model-egress-policy/v1", approvedOrigin: "https://old-provider.example.invalid",
    runtimeAnalysisDataClasses: [], reviewedAt: null, reviewedBy: null });
  expect((await s.app.inject({ method: "POST", url: `/api/providers/${id}/activate`, headers: s.headers() })).statusCode).toBe(200);
  const edited = await s.app.inject({ method: "PUT", url: `/api/providers/${id}`, headers: s.headers(), payload: { name: "Saved", type: "openai_compatible", baseUrl: configuration.baseURL, apiKey: "", model: "saved-model" } });
  expect(edited.statusCode).toBe(200); expect(edited.json().data.fallbackModel).toBe("saved-fallback");
  expect(s.runtime.catalog().models).toEqual(["saved-model", "saved-fallback", "saved-extra"]);
  expect((await s.repository.snapshot()).providers[id]?.apiKey).toBe("saved-secret");
});

test("runtime analysis egress requires exact-origin administrator confirmation and is revoked when the origin changes", async () => {
  const s = await setup(), payload = { name: "Runtime analysis", type: "openai_compatible", baseUrl: configuration.baseURL,
    apiKey: "saved-secret", model: "model-a", egressPolicy: { approvedOrigin: "https://old-provider.example.invalid", runtimeAnalysisDataClasses: ["internal"], interactiveDataClasses: ["restricted"] } };
  const unconfirmed = await s.app.inject({ method: "POST", url: "/api/providers", headers: s.headers(), payload });
  expect(unconfirmed.statusCode).toBe(422);
  const wrongOrigin = await s.app.inject({ method: "POST", url: "/api/providers", headers: s.headers(), payload: {
    ...payload, egressPolicy: { ...payload.egressPolicy, approvedOrigin: "https://other.example.invalid", confirmed: true } } });
  expect(wrongOrigin.statusCode).toBe(422);
  const created = await s.app.inject({ method: "POST", url: "/api/providers", headers: s.headers(), payload: {
    ...payload, egressPolicy: { ...payload.egressPolicy, confirmed: true } } });
  expect(created.statusCode, created.body).toBe(201);
  const id = created.json().data.id;
  expect(created.json().data.egressPolicy).toMatchObject({ approvedOrigin: "https://old-provider.example.invalid", runtimeAnalysisDataClasses: ["internal"], interactiveDataClasses: ["restricted"],
    reviewedBy: { id: "admin", name: "admin" } });
  expect(Number.isFinite(Date.parse(created.json().data.egressPolicy.reviewedAt))).toBe(true);
  expect(created.body).not.toContain("saved-secret");
  const changed = await s.app.inject({ method: "PUT", url: `/api/providers/${id}`, headers: s.headers(), payload: {
    name: "Runtime analysis", type: "openai_compatible", baseUrl: "https://new-provider.example.invalid/v1", apiKey: "", model: "model-a" } });
  expect(changed.statusCode, changed.body).toBe(200);
  expect(changed.json().data.egressPolicy).toMatchObject({ approvedOrigin: "https://new-provider.example.invalid", runtimeAnalysisDataClasses: [], interactiveDataClasses: [], reviewedAt: null, reviewedBy: null });
});

test("an unconfigured catalog is explicit and model selection cannot manufacture readiness", async () => {
  const repository = new Repository(), executor = { setAnalysisProvider() {} } as unknown as Executor;
  const runtime = new ProviderRuntime(repository, executor);
  expect(runtime.catalog()).toEqual({ configured: false, binding: null, models: [] });
  expect(() => runtime.snapshot("anything")).toThrow(/not configured/);
});

test("restart refuses ambiguous active provider records rather than picking the first", async () => {
  const s = await setup();
  await s.repository.mutate((state) => { for (const id of ["one", "two"]) state.providers[id] = { id, active: true }; });
  await expect(s.runtime.activateStoredOrStatic(configuration)).rejects.toThrow(/Multiple active/);
});

test.each([{ additionalModels: "model-b" }, { additionalModels: [123] }, { fallbackModel: 123 }, { fallbackModel: "model:latest" }, { type: "gemini" }])("unsupported provider configuration %j fails explicitly", async (extra) => {
  const s = await setup();
  const result = await s.app.inject({ method: "POST", url: "/api/providers", headers: s.headers(), payload: { name: "Bad", type: "openai_compatible", baseUrl: configuration.baseURL, apiKey: "fixture", model: "model-a", ...extra } });
  expect(result.statusCode).toBe(422); expect((await s.repository.snapshot()).providers).toEqual({});
});

test("loop itself pins model across turns for non-HTTP callers", async () => {
  const s = await setup(), original = s.fetchImplementation.getMockImplementation()!;
  s.fetchImplementation.mockImplementation(async (...args) => { const response = await original(...args); s.runtime.activate({ ...configuration, model: "model-d" }); return response; });
  await runQueryLoop({ userMessage: "Show invoices", chatHistory: [], sessionId: s.sessionId, actorId: "admin", actorRole: "Platform Admin" }, s.registries.snapshot().tools, async () => ({ value: "fixture" }), s.runtime);
  expect(s.fetchImplementation.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).model)).toEqual(["model-a", "model-a"]);
});
