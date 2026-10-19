import { resolve } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import jwt from "jsonwebtoken";
import { Repository, type PersistenceBackend } from "../src/repository/store.js";
import { RegistryService } from "../src/registry/service.js";
import { toolSchema } from "../src/registry/schemas.js";
import { RegistryValidator } from "../src/validator/registry-validator.js";
import { loadConfig } from "../src/config/config.js";
import { createErpbridgeMcpSession } from "../src/tools/erpbridge-mcp-client.js";
import { McpConnectionManager, McpConnectionRuntime } from "../src/tools/mcp-connection-runtime.js";
import type { McpNotificationState } from "../src/tools/mcp-notification-stream.js";
import { bridgeTransportSchema, exactBridgeName } from "../src/tools/erpbridge-contract.js";
import { capabilityContractHash, observeCapabilities, reviewCapability } from "../src/registry/capability-admission.js";
import { dispatchReadTool } from "../src/tools/read-tool-broker.js";
import { buildApp } from "../src/http/app.js";
import { Executor } from "../src/runner/executor.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { stringify } from "yaml";
import { prepareReadPublication } from "../src/workflows/read-compilation-lifecycle.js";
import { bindExecutionHost } from "../src/runner/execution-host.js";

const runtimes: { stop(): Promise<unknown> }[] = [], apps: { close(): Promise<unknown> }[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); await Promise.all(runtimes.splice(0).map(runtime => runtime.stop())); vi.restoreAllMocks(); });
class Persistence implements PersistenceBackend {
  readonly readQueueDurability = "encrypted-single-writer" as const;
  payload: Uint8Array | null = null; loseAck = false;
  async load() { return this.payload; }
  async save(value: Uint8Array) { this.payload = Buffer.from(value); if (this.loseAck) { this.loseAck = false; throw new Error("Lost commit acknowledgement"); } }
  async close() {} async probe() {}
}
function config() { return loadConfig({ APP_ENV: "test", JWT_SECRET: "mcp-runtime-test-secret-at-least-32-bytes", STORAGE_DRIVER: "memory", MCP_MODE: "remote", MCP_TRANSPORT: "erpbridge-mcp",
  ERPBRIDGE_BASE_URL: "https://fixture.example.test", ERPBRIDGE_MCP_TOKEN: "fixture-private-credential", ERPBRIDGE_ROLE_MAP: '{"Platform Admin":"fixture_reader"}', MCP_TIMEOUT_MS: "1000" }); }
async function setup(persistence: PersistenceBackend | null = null, host: "resident-server" | "bounded-invocation" = "resident-server") {
  const repository = await Repository.open(persistence), timestamp = new Date().toISOString();
  bindExecutionHost(repository, host);
  await repository.mutate(state => { for (const [id, roleId] of [["admin", "role_admin"], ["builder", "role_builder"]]) state.users[id!] = { id: id!, roleId: roleId!, name: id!, email: `${id}@example.test`, status: "Active", initials: "A", departmentId: null, lastLoginAt: null, createdAt: timestamp, permissionOverrides: [] }; });
  const registries = await RegistryService.load(resolve("tests/fixtures/chat-read-tools.json"), resolve("tests/fixtures/rules.json"));
  const original = registries.snapshot(), tool = toolSchema.parse({ ...original.tools[0], bridge_contract: { profile: "toolplane-v1", resource_version: "1.0.0", resource_digest: "a".repeat(64), remote_roles: [] } });
  vi.spyOn(registries, "snapshot").mockReturnValue({ ...original, tools: [tool] }); vi.spyOn(registries, "hash").mockReturnValue(capabilityContractHash(tool));
  vi.spyOn(registries, "findTool").mockImplementation(name => [tool.tool_id, tool.name, tool.mcp_tool_name].includes(name) ? tool : undefined);
  const validator = new RegistryValidator(registries, repository), sdkClients: ReturnType<typeof sdk>[] = [];
  function sdk() { return { metadataComplete: true, connect: vi.fn(async () => {}), close: vi.fn(async () => {}),
    listTools: vi.fn(async () => [{ name: exactBridgeName(tool), inputSchema: bridgeTransportSchema(tool), _meta: { "toolplane.resourceDigest": "a".repeat(64), "toolplane.resourceVersion": "1.0.0", "io.erpbridge/allowedRoles": [] } }]),
    callTool: vi.fn(async () => ({ content: [{ type: "text", text: "Confirmed fixture result" }] })) }; }
  const factory = vi.fn<typeof createErpbridgeMcpSession>(async options => { const client = sdk(); sdkClients.push(client); return createErpbridgeMcpSession({ ...options, sdkClient: client }); });
  const options = { repository, registries, validator, config: config(), factory };
  const runtime = await McpConnectionRuntime.open(options); runtimes.push(runtime);
  const admin = (await repository.effectiveUser("admin"))!, builder = (await repository.effectiveUser("builder"))!;
  const services = { ...options, executor: new Executor(new ToolRegistry(), validator), mcpConnectionRuntime: runtime, get erpbridgeSession() { return runtime.session; } };
  const command = (action: "connect" | "disconnect" | "test", baseRevision: number, requestId = `fixture_${action}_request_0001`) => runtime.command(action, admin, { baseRevision, requestId });
  const connect = () => command("connect", 1);
  const review = async () => { const observation = (await observeCapabilities({ repository, registries, session: runtime.session, user: admin })).observations[0]!;
    return reviewCapability({ repository, registries, session: runtime.session, user: admin, capabilityId: observation.capabilityId,
      body: { observationId: observation.id, contractHash: observation.contractHash, decisionKey: "fixture_review_decision_0001", effectClass: "read", riskClass: "low", dataClass: "internal", retryPolicy: "never", note: "Fixture exact read reviewed" } }); };
  return { repository, registries, validator, options, runtime, admin, builder, services, factory, sdkClients, sdk, tool, command, connect, review };
}

test("bounded reopen preserves an unresolved original MCP connect claim and its enabled revision", async () => {
  const storage = new Persistence(), s = await setup(storage, "bounded-invocation");
  let enter!: () => void, finish!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), held = new Promise<void>(resolve => { finish = resolve; });
  s.factory.mockImplementationOnce(async options => { enter(); await held; return createErpbridgeMcpSession({ ...options, sdkClient: s.sdk() }); });
  const pending = s.connect().then(value => ({ value }), error => ({ error }));
  let reopened: Repository | undefined;
  try {
    await entered;
    const original = await s.repository.snapshot();
    reopened = await Repository.open(storage); bindExecutionHost(reopened, "bounded-invocation");
    const second = await McpConnectionRuntime.open({ ...s.options, repository: reopened, validator: new RegistryValidator(s.registries, reopened) }); runtimes.push(second);
    const saved = await reopened.snapshot();
    expect(saved.mcpConnectionOperations).toEqual(original.mcpConnectionOperations);
    expect(saved.mcpConnections).toEqual(original.mcpConnections);
    expect(second.session).toBeUndefined();
  } finally { finish(); await pending; await reopened?.close(); }
});

test("chat admission preserves configured identity without network discovery or a no-op database write",async()=>{
  const s=await setup(new Persistence(),"bounded-invocation");await s.connect();
  const binding=s.runtime.session!.admissionBinding, calls=s.factory.mock.calls.length;
  const mutate=vi.spyOn(s.repository,"mutate");
  const deferred=await McpConnectionRuntime.open({...s.options,deferConnection:true});runtimes.push(deferred);
  expect(s.factory).toHaveBeenCalledTimes(calls);expect(mutate).not.toHaveBeenCalled();
  expect(deferred.session).toBeUndefined();expect(deferred.admissionConfigurationBinding).toBe(binding);
  expect((await deferred.status(s.admin)).connections[0]).toMatchObject({initialized:false,discoveryAvailable:false});
  expect(s.sdkClients.every(client=>client.callTool.mock.calls.length===0)).toBe(true);
});

test.each(["connect", "test"] as const)("bounded %s reopen keeps original receipt, rejects competing work and disconnect fences its late completion", async action => {
  const storage = new Persistence(), s = await setup(storage, "bounded-invocation");
  if (action === "test") await s.connect();
  const revision = action === "test" ? 2 : 1, requestId = `bounded_${action}_original_request_0001`;
  let enter!: () => void, finish!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), held = new Promise<void>(resolve => { finish = resolve; });
  s.factory.mockImplementationOnce(async options => { enter(); await held; return createErpbridgeMcpSession({ ...options, sdkClient: s.sdk() }); });
  const pending = s.command(action, revision, requestId).then(value => ({ value }), error => ({ error }));
  let reopened: Repository | undefined;
  try {
    await entered; const original = await s.repository.snapshot();
    await s.runtime.stop(); await s.repository.close();
    reopened = await Repository.open(storage); bindExecutionHost(reopened, "bounded-invocation");
    const runtime = await McpConnectionRuntime.open({ ...s.options, repository: reopened, validator: new RegistryValidator(s.registries, reopened) }); runtimes.push(runtime);
    const state = await reopened.snapshot(), record = state.mcpConnections["erpbridge-default"]!;
    expect(state.mcpConnectionOperations).toEqual(original.mcpConnectionOperations);
    expect(state.mcpConnections).toEqual(original.mcpConnections);
    expect(Boolean(runtime.session)).toBe(action === "test");
    const calls = s.factory.mock.calls.length;
    const duplicate = await runtime.command(action, s.admin, { baseRevision: revision, requestId });
    expect(duplicate.operation.state).toBe("RUNNING"); expect(duplicate.connection.operationInProgress).toBe(true);
    expect(duplicate.connection.supports.connect).toBe(false); expect(s.factory).toHaveBeenCalledTimes(calls);
    for (const conflicting of ["test", "connect"] as const) await expect(runtime.command(conflicting, s.admin,
      { baseRevision: record.revision, requestId: `bounded_${conflicting}_competing_request_0001` })).rejects.toMatchObject({ status: 409, meta: { code: "MCP_OPERATION_IN_PROGRESS" } });
    const disconnected = await runtime.command("disconnect", s.admin, { baseRevision: record.revision, requestId: "bounded_disconnect_supersedes_0001" });
    expect(disconnected.connection).toMatchObject({ revision: Number(record.revision) + 1, desiredEnabled: false, initialized: false });
    finish(); expect(await pending).toHaveProperty("error");
    const final = await reopened.snapshot();
    expect(Object.values(final.mcpConnectionOperations).find(operation => operation.requestId === requestId)).toMatchObject({ state: "INTERRUPTED", reason: "MCP_OPERATION_INTERRUPTED" });
    expect(final.mcpConnections["erpbridge-default"]).toMatchObject({ revision: Number(record.revision) + 1, desiredEnabled: false });
  } finally { finish(); await pending; await reopened?.close(); }
});

test("bounded enabled restores create independent owned sessions and configuration rotation prevents restoration", async () => {
  const storage = new Persistence(), s = await setup(storage, "bounded-invocation"); await s.connect();
  await s.runtime.stop(); await s.repository.close();
  for (let index = 0; index < 2; index++) {
    const repository = await Repository.open(storage); bindExecutionHost(repository, "bounded-invocation");
    const runtime = await McpConnectionRuntime.open({ ...s.options, repository, validator: new RegistryValidator(s.registries, repository) });
    const client = s.sdkClients.at(-1)!;
    expect(runtime.session).toBeDefined(); expect(client.close).not.toHaveBeenCalled();
    const closing = vi.spyOn(repository, "close").mockImplementation(async () => { expect(client.close).toHaveBeenCalledOnce(); });
    await runtime.stop(); await repository.close(); closing.mockRestore(); await repository.close();
  }
  expect(s.factory).toHaveBeenCalledTimes(3);
  const repository = await Repository.open(storage); bindExecutionHost(repository, "bounded-invocation");
  const rotated = await McpConnectionRuntime.open({ ...s.options, repository, validator: new RegistryValidator(s.registries, repository), config: { ...s.options.config, erpbridgeMcpToken: "rotated-fixture-secret" } });
  try { expect(rotated.session).toBeUndefined(); expect(s.factory).toHaveBeenCalledTimes(3);
    expect((await rotated.status(s.admin)).connections[0]).toMatchObject({ revision: 3, desiredEnabled: false });
  } finally { await rotated.stop(); await repository.close(); }
});

test("bounded MCP cleanup failure rejects its owned runtime while resident disposal remains best effort", async () => {
  const s = await setup(null, "bounded-invocation"); await s.connect();
  s.sdkClients[0]!.close.mockRejectedValueOnce(new Error("synthetic disposal failed"));
  await expect(s.runtime.stop()).rejects.toThrow("synthetic disposal failed");
  runtimes.splice(runtimes.indexOf(s.runtime), 1); await s.repository.close();
  const resident = await setup(); await resident.connect(); resident.sdkClients[0]!.close.mockRejectedValueOnce(new Error("resident disposal failed"));
  await expect(resident.runtime.stop()).resolves.toBeUndefined();
});

test("real runtime connect initializes/discovers without a business call or granting authority; explicit review enables the actual broker", async () => {
  const s = await setup(); expect(s.runtime.session).toBeUndefined(); expect((await s.runtime.status(s.admin)).connections[0]).toMatchObject({ state: "DISCONNECTED", revision: 1, desiredEnabled: false });
  const result = await s.connect(); expect(result.operation).toMatchObject({ state: "DONE", discoveryCount: 1 }); expect(result.connection).toMatchObject({ state: "CONNECTED", revision: 2, initialized: true });
  expect(s.factory).toHaveBeenCalledOnce(); expect(s.sdkClients[0]!.callTool).not.toHaveBeenCalled(); expect(Object.keys((await s.repository.snapshot()).capabilityAdmissions)).toHaveLength(0);
  await expect(dispatchReadTool(s.services, "admin", s.tool.name, { value: "fixture" })).rejects.toThrow(/admitted/);
  await s.review(); expect((await dispatchReadTool(s.services, "admin", s.tool.name, { value: "fixture" })).content).toEqual([{ type: "text", text: "Confirmed fixture result" }]); expect(s.sdkClients[0]!.callTool).toHaveBeenCalledOnce();
});

test("stop drains an invalidated session disposal exactly once before returning", async () => {
  const s = await setup(); await s.connect(); const client = s.sdkClients[0]!;
  let finish!: () => void, settled = false;
  client.close.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  const stopping = s.runtime.stop().then(() => { settled = true; });
  await vi.waitFor(() => expect(client.close).toHaveBeenCalledOnce()); expect(settled).toBe(false);
  finish(); await stopping; await s.runtime.stop(); expect(client.close).toHaveBeenCalledOnce();
});

test("bounded manager owns independent revisioned connections and dispatches only through an immutable reviewed node connection", async () => {
  const s = await setup();
  const multi = loadConfig({ APP_ENV: "test", JWT_SECRET: "mcp-runtime-test-secret-at-least-32-bytes", STORAGE_DRIVER: "memory", MCP_MODE: "remote", MCP_TRANSPORT: "erpbridge-mcp",
    ERPBRIDGE_PRIMARY_CONNECTION_ID: "finance", ERPBRIDGE_CONNECTIONS_JSON: JSON.stringify([
      { id: "finance", baseURL: "https://finance.example.test", tokenEnv: "FINANCE_TOKEN", roleMap: { "Platform Admin": "finance_admin" } },
      { id: "hr", baseURL: "https://hr.example.test", tokenEnv: "HR_TOKEN", roleMap: { "Platform Admin": "hr_admin" } },
    ]), FINANCE_TOKEN: "finance-private-credential", HR_TOKEN: "hr-private-credential", MCP_TIMEOUT_MS: "1000" });
  const manager = await McpConnectionManager.open({ ...s.options, config: multi }); runtimes.push(manager);
  let status = await manager.status(s.admin);
  expect(status).toMatchObject({ primaryConnectionId: "finance", connections: [
    { id: "finance", primary: true, dispatchSupported: true, state: "DISCONNECTED", secretReference: "FINANCE_TOKEN" },
    { id: "hr", primary: false, dispatchSupported: true, state: "DISCONNECTED", secretReference: "HR_TOKEN" },
  ] });
  await manager.command("connect", s.admin, { baseRevision: 1, requestId: "finance_connect_request_0001" }, undefined, "finance");
  await manager.command("connect", s.admin, { baseRevision: 1, requestId: "hr_connect_request_0001" }, undefined, "hr");
  expect(manager.session).toBe(manager.sessionFor("finance")); expect(manager.sessionFor("hr")).toBeDefined(); expect(manager.sessionFor("unknown")).toBeUndefined();
  status = await manager.status(s.admin); expect(status.connections.map(value => [value.id, value.revision, value.initialized])).toEqual([["finance", 2, true], ["hr", 2, true]]);
  expect(status.recentOperations.map(value => value.connectionId).sort()).toEqual(["finance", "hr"]);
  expect(JSON.stringify(status)).not.toMatch(/finance-private-credential|hr-private-credential|configurationHash|requestHash/);
  await expect(manager.command("connect", s.admin, { baseRevision: 1, requestId: "unknown_connect_request_0001" }, undefined, "unknown")).rejects.toMatchObject({ status: 404 });

  const services = { ...s.services, config: multi, mcpConnectionRuntime: manager, get erpbridgeSession() { return manager.session; } };
  const app = await buildApp(services); apps.push(app);
  const headers = { authorization: `Bearer ${jwt.sign({}, multi.jwtSecret, { subject: "admin", expiresIn: 3600 })}` };
  const listed = await app.inject({ method: "GET", url: "/api/settings/mcp-connections", headers });
  expect(listed.statusCode, listed.body).toBe(200); expect(listed.json().data.primaryConnectionId).toBe("finance");
  const discoveredFinance = await app.inject({ method: "POST", url: "/api/registry/capabilities/discovery?connectionId=finance", headers, payload: {} });
  expect(discoveredFinance.statusCode, discoveredFinance.body).toBe(200);
  const financeObservation = discoveredFinance.json().data.observations[0];
  const reviewedFinance = await app.inject({ method: "POST", url: `/api/registry/capabilities/${financeObservation.capabilityId}/review?connectionId=finance`, headers, payload: {
    observationId: financeObservation.id, contractHash: financeObservation.contractHash, decisionKey: "finance_capability_review_0001",
    effectClass: "read", riskClass: "low", dataClass: "internal", retryPolicy: "never", note: "Exact finance read contract reviewed",
  } });
  expect(reviewedFinance.statusCode, reviewedFinance.body).toBe(200);
  const discoveredHr = await app.inject({ method: "POST", url: "/api/registry/capabilities/discovery?connectionId=hr", headers, payload: {} });
  expect(discoveredHr.statusCode, discoveredHr.body).toBe(200); expect(discoveredHr.json().data).toMatchObject({ connectionId: "hr", authorityGranted: false });
  const hrObservation = discoveredHr.json().data.observations[0];
  const reviewBody = { observationId: hrObservation.id, contractHash: hrObservation.contractHash, decisionKey: "hr_capability_review_0001",
    effectClass: "read", riskClass: "low", dataClass: "internal", retryPolicy: "never", note: "Exact HR read contract reviewed" };
  const wrongConnection = await app.inject({ method: "POST", url: `/api/registry/capabilities/${hrObservation.capabilityId}/review?connectionId=finance`, headers, payload: reviewBody });
  expect(wrongConnection.statusCode).toBe(409);
  const reviewedHr = await app.inject({ method: "POST", url: `/api/registry/capabilities/${hrObservation.capabilityId}/review?connectionId=hr`, headers, payload: reviewBody });
  expect(reviewedHr.statusCode, reviewedHr.body).toBe(200); expect(reviewedHr.json().data.revision.connectionId).toBe("hr");
  const yaml = stringify({ name: "Exact multi-connection read", trigger: { type: "manual" }, steps: [
    { id: "finance_read", action: s.tool.name, connection_id: "finance", parameters: { value: "finance" } },
    { id: "hr_read", action: s.tool.name, connection_id: "hr", parameters: { value: "hr" } },
  ] });
  const prepared = await prepareReadPublication(services, yaml, s.admin);
  const financePin = prepared!.stored.plan.ir.root.nodes[0]!.capability.admission!, hrPin = prepared!.stored.plan.ir.root.nodes[1]!.capability.admission!;
  expect(financePin).toMatchObject({ connectionId: "finance", capabilityId: financeObservation.capabilityId, revisionId: reviewedFinance.json().data.revision.id });
  expect(hrPin).toMatchObject({ connectionId: "hr", capabilityId: hrObservation.capabilityId, revisionId: reviewedHr.json().data.revision.id });
  await dispatchReadTool(services, "admin", s.tool.name, { value: "finance" }, { dynamicPlan: { admissionPin: financePin, contractHash: financePin.contractHash, toolId: s.tool.tool_id } });
  await dispatchReadTool(services, "admin", s.tool.name, { value: "hr" }, { dynamicPlan: { admissionPin: hrPin, contractHash: hrPin.contractHash, toolId: s.tool.tool_id } });
  expect(s.sdkClients[0]!.callTool).toHaveBeenCalledOnce(); expect(s.sdkClients[1]!.callTool).toHaveBeenCalledOnce();
  const financeCatalog = await app.inject({ method: "GET", url: "/api/registry/capabilities?connectionId=finance", headers });
  const hrCatalog = await app.inject({ method: "GET", url: "/api/registry/capabilities?connectionId=hr", headers });
  expect(financeCatalog.statusCode, financeCatalog.body).toBe(200); expect(financeCatalog.json().data).toMatchObject({ connection: { id: "finance" }, capabilities: [{ capabilityId: financeObservation.capabilityId, effectiveState: "AVAILABLE" }] });
  expect(hrCatalog.statusCode, hrCatalog.body).toBe(200); expect(hrCatalog.json().data).toMatchObject({ connection: { id: "hr" }, capabilities: [{ capabilityId: hrObservation.capabilityId, effectiveState: "AVAILABLE" }] });
  expect(hrCatalog.body).not.toMatch(/hr-private-credential|connectionBinding|decisionHash/);
  expect((await app.inject({ method: "GET", url: "/api/registry/capabilities?connectionId=unknown", headers })).statusCode).toBe(404);
  const disconnected = await app.inject({ method: "POST", url: "/api/settings/mcp-connections/hr/disconnect", headers,
    payload: { baseRevision: 2, requestId: "hr_disconnect_request_0001" } });
  expect(disconnected.statusCode, disconnected.body).toBe(200); expect(disconnected.json().data.connection).toMatchObject({ id: "hr", revision: 3, initialized: false });
  expect(manager.sessionFor("finance")).toBeDefined(); expect(manager.sessionFor("hr")).toBeUndefined();
  const missing = await app.inject({ method: "POST", url: "/api/settings/mcp-connections/unknown/test", headers,
    payload: { baseRevision: 1, requestId: "unknown_http_request_0001" } });
  expect(missing.statusCode).toBe(404);

  await manager.command("connect", s.admin, { baseRevision: 3, requestId: "hr_reconnect_request_0001" }, undefined, "hr");
  await manager.stop();
  const restored = await McpConnectionManager.open({ ...s.options, config: multi }); runtimes.push(restored);
  expect(restored.sessionFor("finance")).toBeDefined(); expect(restored.sessionFor("hr")).toBeDefined();
  await restored.stop();
  const rotatedConfig = { ...multi, erpbridgeConnections: multi.erpbridgeConnections.map(connection => connection.id === "hr" ?
    { ...connection, mcpToken: "rotated-hr-private-credential" } : connection) };
  const rotated = await McpConnectionManager.open({ ...s.options, config: rotatedConfig }); runtimes.push(rotated);
  status = await rotated.status(s.admin);
  expect(status.connections.map(value => [value.id, value.revision, value.state, value.desiredEnabled])).toEqual([
    ["finance", 2, "CONNECTED", true], ["hr", 5, "DISCONNECTED", false],
  ]);
  expect(rotated.session).toBe(rotated.sessionFor("finance")); expect(rotated.sessionFor("hr")).toBeUndefined();
  expect(s.sdkClients.reduce((count, client) => count + client.callTool.mock.calls.length, 0)).toBe(2);
});

test("disconnect fences old clients while unchanged reconnects preserve reviewed tool identity", async () => {
  const s = await setup(); await s.connect(); await s.review(); const old = s.runtime.session!, binding = old.admissionBinding;
  const yaml = stringify({ name: "Reusable read", trigger: { type: "manual" }, steps: [{ id: "lookup", action: s.tool.name, parameters: { value: "reused" } }] });
  const prepared = await prepareReadPublication(s.services, yaml, s.admin);
  const disconnected = await s.command("disconnect", 2); expect(disconnected.connection).toMatchObject({ state: "DISCONNECTED", revision: 3, initialized: false, desiredEnabled: false });
  expect(s.runtime.session).toBeUndefined(); await expect(old.assertAdmission!(s.tool)).rejects.toThrow(); expect(old.available).toBe(false);
  const reviewed = structuredClone((await s.repository.snapshot()).capabilityAdmissions);
  for (let index = 0; index < 3; index++) {
    await s.command("connect", 3 + index * 2, `fixture_same_connect_${index}`); expect(s.runtime.session!.admissionBinding).toBe(binding);
    await expect(s.runtime.session!.assertAdmission!(s.tool)).resolves.toBeUndefined();
    expect((await s.repository.snapshot()).capabilityAdmissions).toEqual(reviewed);
    if (index < 2) await s.command("disconnect", 4 + index * 2, `fixture_same_disconnect_${index}`);
  }
  await expect(old.assertAdmission!(s.tool)).rejects.toThrow();
  expect(s.sdkClients.every(client => client.callTool.mock.calls.length === 0)).toBe(true);
  const current = await prepareReadPublication(s.services, yaml, s.admin); expect(current!.stored.plan).toEqual(prepared!.stored.plan);
  const pin = prepared!.stored.plan.ir.root.nodes[0]!.capability.admission!;
  await dispatchReadTool(s.services, "admin", s.tool.name, { value: "reused" }, { dynamicPlan: { admissionPin: pin, contractHash: pin.contractHash, toolId: s.tool.tool_id } });
  expect(s.sdkClients.at(-1)!.callTool).toHaveBeenCalledOnce();
});

test("actual endpoint, credential or role-map changes still invalidate a previous tool review", async () => {
  for (const patch of [{ erpbridgeBaseURL: "https://another.example.test" }, { erpbridgeMcpToken: "new-fixture-credential" }, { erpbridgeRoleMap: { "Platform Admin": "changed_admin" } }]) {
    const s = await setup(); await s.connect(); await s.review(); const binding = s.runtime.session!.admissionBinding;
    await s.runtime.stop();
    const updated = await McpConnectionRuntime.open({ ...s.options, config: { ...s.options.config, ...patch } }); runtimes.push(updated);
    const status = (await updated.status(s.admin)).connections[0]!;
    await updated.command("connect", s.admin, { baseRevision: status.revision, requestId: "fixture_new_configuration_01" });
    expect(updated.session!.admissionBinding).not.toBe(binding);
    await expect(updated.session!.assertAdmission!(s.tool)).rejects.toThrow(/binding changed/);
  }
});

test("fatal notification status reaches administration and fences captured admission/discovery without any business call", async () => {
  const s = await setup(), client = { ...s.sdk(), available: true, notificationState: { state: "ACTIVE", recoveryAttempts: 0 } as McpNotificationState };
  s.factory.mockImplementationOnce(options => createErpbridgeMcpSession({ ...options, sdkClient: client }));
  await s.connect(); await s.review(); const captured = s.runtime.session!;
  expect((await s.runtime.status(s.admin)).connections[0]?.notificationStream).toEqual(client.notificationState);
  client.available = false; client.notificationState = { state: "FAILED", reason: "SESSION_EXPIRED", recoveryAttempts: 1 };
  expect(s.runtime.session).toBeUndefined(); expect(captured.available).toBe(false);
  await expect(captured.assertAdmission!(s.tool)).rejects.toThrow(/unavailable/); await expect(captured.listTools()).rejects.toThrow(/unavailable/);
  const status = await s.runtime.status(s.admin); expect(status.connections[0]).toMatchObject({ state: "DEGRADED", initialized: false, discoveryAvailable: false, notificationStream: client.notificationState });
  expect(JSON.stringify(status)).not.toContain("fixture-private-credential"); expect(client.callTool).not.toHaveBeenCalled();
});

test("exact connect retries after disconnect return history/current state without reconnecting; request conflicts and stale commands have no side effect", async () => {
  const s = await setup(); await s.connect(); await s.command("disconnect", 2);
  const repeated = await s.connect(); expect(repeated.duplicate).toBe(true); expect(repeated.operation.state).toBe("DONE"); expect(repeated.connection.state).toBe("DISCONNECTED"); expect(s.factory).toHaveBeenCalledOnce();
  await expect(s.command("connect", 3)).rejects.toMatchObject({ status: 409 });
  await expect(s.command("connect", 1, "different_request_key_0001")).rejects.toMatchObject({ status: 409 });
  expect((await s.runtime.status(s.admin)).connections[0]!.state).toBe("DISCONNECTED");
});

test("testing a connection uses a disposable session and does not replace/disable or grant the agent's active connection", async () => {
  const s = await setup(); await s.connect(); const old = s.runtime.session!, binding = old.admissionBinding;
  const tested = await s.command("test", 2); expect(tested.operation).toMatchObject({ state: "DONE", discoveryCount: 1 }); expect(tested.connection.revision).toBe(2);
  expect(s.runtime.session).toBe(old); expect(old.admissionBinding).toBe(binding); expect(old.available).toBe(true); expect(s.sdkClients[1]!.close).toHaveBeenCalled();
  expect(s.sdkClients.every(client => client.callTool.mock.calls.length === 0)).toBe(true);
});

test("disconnect interrupts a hanging connect immediately; late ignored SDK completion cannot publish a session", async () => {
  const s = await setup(); let release: (() => void) | undefined; const client = s.sdk();
  client.connect.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
  s.factory.mockImplementationOnce(options => createErpbridgeMcpSession({ ...options, sdkClient: client }));
  const connecting = s.connect(); const rejected = expect(connecting).rejects.toMatchObject({ meta: { code: "MCP_OPERATION_INTERRUPTED" } });
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  expect((await s.runtime.status(s.admin)).connections[0]!.state).toBe("CONNECTING");
  await s.command("disconnect", 2); await rejected; release!(); await vi.waitFor(() => expect(client.close).toHaveBeenCalled());
  expect(s.runtime.session).toBeUndefined(); expect((await s.runtime.status(s.admin)).connections[0]!.state).toBe("DISCONNECTED"); expect(client.callTool).not.toHaveBeenCalled();
});

test("revoked administrator during SDK initialization cannot publish readiness and does not expose upstream secrets", async () => {
  const s = await setup(); const client = s.sdk();
  client.listTools.mockImplementation(async () => { await s.repository.mutate(state => { state.users.admin!.status = "Inactive"; }); return []; });
  s.factory.mockImplementationOnce(options => createErpbridgeMcpSession({ ...options, sdkClient: client }));
  await expect(s.connect()).rejects.toMatchObject({ status: 403, meta: { code: "MCP_ACTOR_REVOKED" } }); expect(s.runtime.session).toBeUndefined(); expect(client.close).toHaveBeenCalled();
});

test("bounded failed connect records only safe failure and its exact retry never replays initialization", async () => {
  const s = await setup(); s.factory.mockRejectedValueOnce(new Error("Authorization: Bearer fixture-private-credential upstream-body"));
  try { await s.connect(); throw new Error("Unexpected success"); } catch (error) { expect(String(error)).not.toMatch(/private-credential|upstream-body/); }
  const status = await s.runtime.status(s.admin); expect(status.connections[0]!.state).toBe("DEGRADED"); expect(status.recentOperations[0]).toMatchObject({ state: "FAILED", reason: "MCP_OPERATION_FAILED" });
  expect(status.connections[0]!.desiredEnabled).toBe(false);
  expect(JSON.stringify(status)).not.toMatch(/configurationHash|scope|requestHash|private-credential|upstream-body/);
  expect((await s.connect()).duplicate).toBe(true); expect(s.factory).toHaveBeenCalledOnce();
  const restarted = await McpConnectionRuntime.open(s.options); runtimes.push(restarted); expect(restarted.session).toBeUndefined(); expect(s.factory).toHaveBeenCalledOnce();
});

test("initialization wait is bounded even when an injected dependency ignores cancellation", async () => {
  const s = await setup(); const runtime = await McpConnectionRuntime.open({ ...s.options, config: { ...s.options.config, mcpTimeoutMs: 30 }, factory: vi.fn(async () => new Promise<never>(() => {})) }); runtimes.push(runtime);
  await expect(runtime.command("connect", s.admin, { baseRevision: 1, requestId: "fixture_timeout_request_0001" })).rejects.toMatchObject({ meta: { code: "MCP_WAIT_TIMEOUT" } });
  expect((await runtime.status(s.admin)).connections[0]!.state).toBe("DEGRADED");
});

test("lost claim acknowledgement fences the old session until recovery and duplicate pending operation never starts the SDK", async () => {
  const persistence = new Persistence(), s = await setup(persistence); await s.connect(); const old = s.runtime.session!;
  persistence.loseAck = true; await expect(s.command("disconnect", 2)).rejects.toThrow(/acknowledgement/);
  expect(s.runtime.session).toBeUndefined(); await expect(old.assertAdmission!(s.tool)).rejects.toThrow(); await expect(s.runtime.status(s.admin)).rejects.toThrow(/Authoritative/);
  await s.repository.recoverPersistenceState(); const repeated = await s.command("disconnect", 2); expect(repeated.duplicate).toBe(true); expect(repeated.operation.state).toBe("RUNNING"); expect(s.runtime.session).toBeUndefined(); expect(s.factory).toHaveBeenCalledOnce();
  const restarted = await McpConnectionRuntime.open(s.options); runtimes.push(restarted); expect((await restarted.status(s.admin)).recentOperations[0]!.state).toBe("INTERRUPTED"); expect(restarted.session).toBeUndefined();
});

test("lost final acknowledgement closes the candidate and cannot expose a connected old local image", async () => {
  const persistence = new Persistence(), s = await setup(persistence), client = s.sdk();
  client.listTools.mockImplementation(async () => { persistence.loseAck = true; return []; }); s.factory.mockImplementationOnce(options => createErpbridgeMcpSession({ ...options, sdkClient: client }));
  await expect(s.connect()).rejects.toThrow(); expect(s.runtime.session).toBeUndefined(); expect(client.close).toHaveBeenCalled(); await s.repository.recoverPersistenceState();
  const repeated = await s.connect(); expect(repeated.operation.state).toBe("DONE"); expect(repeated.connection.initialized).toBe(false); expect(s.factory).toHaveBeenCalledOnce();
});

test("a successful restore candidate is disposed when the final authoritative record check fails", async () => {
  const s = await setup(); await s.connect(); await s.runtime.stop(); const client = s.sdk(), inventory = client.listTools.getMockImplementation()!;
  client.listTools.mockImplementation(async () => { const tools = await inventory(); vi.spyOn(s.repository, "readAuthoritative").mockRejectedValueOnce(new Error("Uncertain repository")); return tools; });
  s.factory.mockImplementationOnce(options => createErpbridgeMcpSession({ ...options, sdkClient: client }));
  const restored = await McpConnectionRuntime.open(s.options); runtimes.push(restored); expect(restored.session).toBeUndefined(); expect(client.close).toHaveBeenCalled();
  expect((await restored.status(s.admin)).connections[0]!.state).toBe("DEGRADED");
});

test("deferred document runtime makes no bridge request until ERP is selected", async () => {
  const s = await setup(new Persistence()); await s.connect(); await s.runtime.stop();
  const deferred = await McpConnectionRuntime.open({ ...s.options, deferConnection: true }); runtimes.push(deferred);
  expect(deferred.session).toBeUndefined(); expect(s.factory).toHaveBeenCalledTimes(1);
  await Promise.all([deferred.ensureSession(), deferred.ensureSession()]);
  expect(deferred.session).toBeDefined(); expect(s.factory).toHaveBeenCalledTimes(2);
  expect(s.sdkClients.every(client => client.callTool.mock.calls.length === 0)).toBe(true);
});

test("deferred startup does not enable a disabled connection or retry a degraded bridge", async () => {
  const s = await setup(new Persistence());
  await s.runtime.ensureSession(); expect(s.factory).not.toHaveBeenCalled();
  await s.connect(); await s.runtime.stop();
  const deferred = await McpConnectionRuntime.open({ ...s.options, deferConnection: true }); runtimes.push(deferred);
  s.factory.mockRejectedValueOnce(new Error("Unavailable"));
  await deferred.ensureSession(); await deferred.ensureSession();
  expect(deferred.session).toBeUndefined(); expect(s.factory).toHaveBeenCalledTimes(2);
});

test("same enabled configuration can restore initialize-only after restart; disabled intent and configuration rotation never auto-connect", async () => {
  const persistence = new Persistence(), s = await setup(persistence); await s.connect(); await s.runtime.stop();
  const restored = await McpConnectionRuntime.open(s.options); runtimes.push(restored); expect(restored.session).toBeDefined(); expect(s.factory).toHaveBeenCalledTimes(2);
  await restored.command("disconnect", s.admin, { baseRevision: 2, requestId: "fixture_restart_disconnect_0001" }); await restored.stop();
  const disabled = await McpConnectionRuntime.open(s.options); runtimes.push(disabled); expect(disabled.session).toBeUndefined(); expect(s.factory).toHaveBeenCalledTimes(2);
  const rotated = await McpConnectionRuntime.open({ ...s.options, config: { ...s.options.config, erpbridgeMcpToken: "rotated-private-credential" } }); runtimes.push(rotated);
  expect((await rotated.status(s.admin)).connections[0]).toMatchObject({ state: "DISCONNECTED", desiredEnabled: false, revision: 4 }); expect(s.factory).toHaveBeenCalledTimes(2);
});

test("interrupted disposable test history does not change the separately approved active connection revision on restart", async () => {
  const s = await setup(); await s.connect(); await s.runtime.stop();
  await s.repository.mutate(state => {
    const { completedAt: _completed, ...original } = Object.values(state.mcpConnectionOperations)[0]!;
    state.mcpConnectionOperations.mcpop_interrupted_probe = { ...original, id: "mcpop_interrupted_probe", action: "test", requestId: "fixture_interrupted_test_0001", scope: `sha256:${"b".repeat(64)}`, state: "RUNNING" };
  });
  const restored = await McpConnectionRuntime.open(s.options); runtimes.push(restored);
  const view = await restored.status(s.admin); expect(view.connections[0]).toMatchObject({ revision: 2, state: "CONNECTED", desiredEnabled: true });
  expect(view.recentOperations[0]).toMatchObject({ action: "test", state: "INTERRUPTED" }); expect(s.factory).toHaveBeenCalledTimes(2); expect(s.sdkClients.every(client => client.callTool.mock.calls.length === 0)).toBe(true);
});

test("bad storage/corrupt records need explicit repair and unsupported transport/config never tries a network fallback", async () => {
  const persistence = new Persistence(); Object.defineProperty(persistence, "readQueueDurability", { value: undefined }); const s = await setup(persistence);
  expect((await s.runtime.status(s.admin)).connections[0]!.state).toBe("STORAGE_UNSUPPORTED"); await expect(s.connect()).rejects.toMatchObject({ status: 503 }); expect(s.factory).not.toHaveBeenCalled();
  await expect(McpConnectionRuntime.open({ ...s.options, config: { ...s.options.config, erpbridgeBaseURL: "https://user:pass@fixture.example.test/path" } })).rejects.toThrow(/not supported/);
  const simple = await setup(); await simple.repository.mutate(state => { state.mcpConnections["erpbridge-default"] = { revision: "wrong" }; });
  await expect(McpConnectionRuntime.open(simple.options)).rejects.toThrow();
});

test("commands reject actor changes, arbitrary endpoint/token input and absent configuration before any initialization", async () => {
  const s = await setup(); await expect(s.runtime.command("connect", s.builder, { baseRevision: 1, requestId: "fixture_builder_request_0001" })).rejects.toMatchObject({ status: 403 });
  await expect(s.runtime.command("connect", s.admin, { baseRevision: 1, requestId: "fixture_injected_request_0001", baseURL: "http://169.254.169.254/", token: "injected" })).rejects.toMatchObject({ status: 400 }); expect(s.factory).not.toHaveBeenCalled();
  const runtime = await McpConnectionRuntime.open({ ...s.options, config: { ...s.options.config, mcpTransport: "bridge-v1", erpbridgeBaseURL: "", erpbridgeMcpToken: "" } }); runtimes.push(runtime);
  expect((await runtime.status(s.admin)).connections[0]!.state).toBe("UNCONFIGURED");
  await expect(runtime.command("connect", s.admin, { baseRevision: 2, requestId: "fixture_unconfigured_request_0001" })).rejects.toMatchObject({ status: 503 }); expect(s.factory).not.toHaveBeenCalled();
});

test("HTTP lifecycle uses actual services, stays permission-scoped and legacy generic URL connect cannot probe or fabricate readiness", async () => {
  const s = await setup(), app = await buildApp(s.services); apps.push(app);
  const headers = (actor = "admin") => ({ authorization: `Bearer ${jwt.sign({}, s.options.config.jwtSecret, { subject: actor, expiresIn: 3600 })}` });
  expect((await app.inject({ method: "GET", url: "/api/settings/mcp-connections", headers: headers("builder") })).statusCode).toBe(403);
  const connected = await app.inject({ method: "POST", url: "/api/settings/mcp-connections/erpbridge-default/connect", headers: headers(), payload: { baseRevision: 1, requestId: "fixture_http_connect_request_0001" } });
  expect(connected.statusCode, connected.body).toBe(200); expect(connected.json().data.connection.initialized).toBe(true); expect(s.services.erpbridgeSession).toBeDefined();
  const get = await app.inject({ method: "GET", url: "/api/settings/mcp-connections", headers: headers() }); expect(get.body).not.toMatch(/private-credential|configurationHash|scope|requestHash/);
  const probe = vi.spyOn(globalThis, "fetch"); await s.repository.mutate(state => { state.integrations.unsafe = { id: "unsafe", name: "Metadata", type: "URL", config: { url: "http://169.254.169.254/latest/meta-data/" }, status: "Disconnected" }; });
  const generic = await app.inject({ method: "POST", url: "/api/integrations/unsafe/connect", headers: headers(), payload: {} }); expect(generic.statusCode, generic.body).toBe(501); expect(generic.json().meta.code).toBe("INTEGRATION_ADAPTER_REQUIRED"); expect(probe).not.toHaveBeenCalled();
  expect(s.sdkClients[0]!.callTool).not.toHaveBeenCalled();
});
