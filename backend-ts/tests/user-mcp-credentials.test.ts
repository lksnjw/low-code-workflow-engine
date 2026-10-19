import { afterEach, expect, test, vi } from "vitest";
import { Repository, restoreState } from "../src/repository/store.js";
import { loadConfig } from "../src/config/config.js";
import { UserMcpCredentials } from "../src/tools/user-mcp-credentials.js";
import { withoutSecretFields } from "../src/redact/secrets.js";
import { splitFirestoreState, assembleFirestoreState } from "../src/storage/firestore-record-layout.js";
import { RegistryService } from "../src/registry/service.js";
import { RegistryValidator } from "../src/validator/registry-validator.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { Executor } from "../src/runner/executor.js";
import { buildApp } from "../src/http/app.js";
import { resolve } from "node:path";
import jwt from "jsonwebtoken";
import { createErpbridgeMcpSession } from "../src/tools/erpbridge-mcp-client.js";
import { executionTransaction } from "../src/repository/execution-transaction.js";
import { withToolAccess } from "../src/governance/tool-access.js";
import { operationReadbackJobSchema } from "../src/runner/operation-readback-state.js";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const repository = new Repository(); cleanup.push(() => repository.close());
  await repository.mutate(state => {
    for (const id of ["alice", "bob"]) state.users[id] = { id, name: id, email: `${id}@example.test`, roleId: "role_builder", status: "Active", initials: "T", permissionOverrides: [], departmentId: null, lastLoginAt: null, createdAt: new Date().toISOString() };
  });
  const config = loadConfig({ APP_ENV: "test", JWT_SECRET: "user-mcp-test-secret-at-least-32-chars", STORAGE_DRIVER: "memory", STORAGE_ENCRYPTION_KEY: "x".repeat(32),
    MCP_TRANSPORT: "erpbridge-mcp", MCP_MODE: "remote",
    ERPBRIDGE_BASE_URL: "https://erp.example.test", ERPBRIDGE_MCP_TOKEN: "ENV-CATALOG-NEVER-A-USER", ERPBRIDGE_ROLE_MAP: '{"Workflow Builder":"builder"}' });
  const calls: { token: string; name: string }[] = [];
  let connectHook: (() => Promise<void>) | undefined;
  const adapters: { close: ReturnType<typeof vi.fn>; listTools: ReturnType<typeof vi.fn>; connect: ReturnType<typeof vi.fn> }[] = [];
  const factory = (options: { token: string }) => {
    const sdk = { metadataComplete: true, connect: vi.fn(async () => { await connectHook?.(); }), close: vi.fn(async () => {}), listTools: vi.fn(async () => []),
      callTool: vi.fn(async (name: string) => { calls.push({ token: options.token, name }); return { content: [] }; }) };
    adapters.push(sdk); return sdk;
  };
  const credentials = new UserMcpCredentials(repository, config, factory); cleanup.push(() => credentials.close());
  const id = "erpbridge-default", identity = (userId = "alice") => ({ userId, localRole: "Workflow Builder", erpbridgeRole: "builder" });
  const binding = (actor = "alice") => repository.readAuthoritative(state => credentials.binding(state, actor));
  const call = async (userId = "alice") => { const prepared = await credentials.prepare(identity(userId), id); try { prepared.assertCurrent(); await prepared.sdk.callTool("test.read", {}); } finally { await prepared.close(); } };
  return { repository, config, credentials, adapters, calls, id, identity, binding, call, setConnectHook: (hook: () => Promise<void>) => { connectHook = hook; } };
}
test("credential is encrypted, owner-addressed and absent from public settings/audit", async () => {
  const f = await fixture(), token = "ALICE-PRIVATE-ERP-TOKEN";
  const result = await f.credentials.save("alice", f.id, { baseRevision: 0, token });
  const state = await f.repository.snapshot();
  expect(JSON.stringify(state)).not.toContain(token); expect(JSON.stringify(result)).not.toContain("ciphertext");
  expect((await f.credentials.list("bob")).connections[0]!.configured).toBe(false);
  expect(result.connections[0]).toMatchObject({ configured: true, revision: 1 });
  expect(JSON.stringify(state.auditLogs)).not.toContain("ciphertext");
  expect(assembleFirestoreState(splitFirestoreState(state)).userMcpCredentials).toEqual(state.userMcpCredentials);
  expect(restoreState(Buffer.from(JSON.stringify(state))).userMcpCredentials).toEqual(state.userMcpCredentials);
});
test("parallel users dispatch with their own tokens, never the catalog token", async () => {
  const f = await fixture();
  await f.credentials.save("alice", f.id, { baseRevision: 0, token: "ALICE-PRIVATE-ERP-TOKEN" });
  await f.credentials.save("bob", f.id, { baseRevision: 0, token: "BOB-PRIVATE-ERP-TOKEN" });
  await Promise.all(["alice", "bob"].map(async actor => f.credentials.scope(actor, await f.binding(actor), () => f.call(actor))));
  expect(f.calls.map(c => c.token).sort()).toEqual(["ALICE-PRIVATE-ERP-TOKEN", "BOB-PRIVATE-ERP-TOKEN"]);
  expect(f.adapters.every(a => a.close.mock.calls.length === 1)).toBe(true);
});

test("shared mode binds the configured server credential to each real active role without exposing it", async () => withToolAccess("all-authenticated", async () => {
  const f = await fixture(); f.config.erpbridgeAdminEnvironmentAccess = true;
  const alice = await f.binding(), bob = await f.binding("bob");
  expect(alice.actorId).toBe("alice"); expect(bob.actorId).toBe("bob");
  expect(alice.environmentSecret?.[f.id]).not.toBe(bob.environmentSecret?.[f.id]);
  expect(JSON.stringify(alice)).not.toContain(f.config.erpbridgeMcpToken);
  await f.credentials.scope("alice", alice, () => f.call());
  expect(f.calls[0]!.token).toBe(f.config.erpbridgeMcpToken);
  await expect(f.credentials.scope("bob", alice, () => f.call("bob"))).rejects.toThrow(/original user/);
}));
test("missing token cannot fall back to environment or another actor", async () => {
  const f = await fixture(); await f.credentials.save("alice", f.id, { baseRevision: 0, token: "ALICE-PRIVATE-ERP-TOKEN" });
  await expect(f.credentials.scope("bob", await f.binding("bob"), () => f.call("bob"))).rejects.toThrow(/own ERPBridge token/);
  await expect(f.credentials.scope("alice", await f.binding(), () => f.call("bob"))).rejects.toThrow(/original user/);
  expect(f.adapters).toHaveLength(0);
});
test("old jobs and mismatched actor receipts cannot adopt today's token", async () => {
  const f = await fixture(); await f.credentials.save("alice", f.id, { baseRevision: 0, token: "ALICE-PRIVATE-ERP-TOKEN" });
  await expect(f.credentials.scope("alice", undefined, () => f.call())).rejects.toThrow(/original user/);
  await expect(f.credentials.scope("alice", await f.binding("bob"), () => f.call())).rejects.toThrow(/original user/);
});
test("replacement fences queued work and does not expose previous token", async () => {
  const f = await fixture(); await f.credentials.save("alice", f.id, { baseRevision: 0, token: "ALICE-PRIVATE-ERP-TOKEN" });
  const original = await f.binding();
  await f.credentials.save("alice", f.id, { baseRevision: 1, token: "ALICE-NEW-ERP-TOKEN" });
  await expect(f.credentials.scope("alice", original, () => f.call())).rejects.toThrow(/token changed/);
  await f.credentials.scope("alice", await f.binding(), () => f.call()); expect(f.calls[0]!.token).toBe("ALICE-NEW-ERP-TOKEN");
});
test("remove fences in-flight SDK entry and retains monotonic revision tombstone", async () => {
  const f = await fixture(); await f.credentials.save("alice", f.id, { baseRevision: 0, token: "ALICE-PRIVATE-ERP-TOKEN" });
  await f.credentials.scope("alice", await f.binding(), async () => {
    const prepared = await f.credentials.prepare(f.identity(), f.id);
    await f.credentials.remove("alice", f.id, { baseRevision: 1 });
    expect(() => prepared.assertCurrent()).toThrow(/token changed/); await prepared.close();
  });
  expect(f.calls).toHaveLength(0); expect((await f.credentials.list("alice")).connections[0]).toMatchObject({ configured: false, revision: 2 });
  await expect(f.credentials.save("alice", f.id, { baseRevision: 0, token: "STALE-TOKEN-VALUE" })).rejects.toThrow(/changed/);
});

test("rotation during initialize remains a credential-change failure, never business dispatch", async () => {
  const f = await fixture(); await f.credentials.save("alice", f.id, { baseRevision: 0, token: "ALICE-PRIVATE-ERP-TOKEN" });
  f.setConnectHook(async () => { await f.credentials.remove("alice", f.id, { baseRevision: 1 }); });
  await expect(f.credentials.scope("alice", await f.binding(), () => f.call())).rejects.toMatchObject({ meta: { code: "ERP_USER_CREDENTIAL_CHANGED" } });
  expect(f.calls).toHaveLength(0); expect(f.adapters[0]!.close).toHaveBeenCalledOnce();
});

test("upstream initialize errors never expose private error bodies", async () => {
  const f = await fixture(); await f.credentials.save("alice", f.id, { baseRevision: 0, token: "ALICE-PRIVATE-ERP-TOKEN" });
  f.setConnectHook(async () => { throw new Error("upstream token=ALICE-PRIVATE-ERP-TOKEN"); });
  await expect(f.credentials.scope("alice", await f.binding(), () => f.call())).rejects.toThrow("Your ERPBridge token could not connect.");
  expect(f.calls).toHaveLength(0); expect(f.adapters[0]!.close).toHaveBeenCalledOnce();
});
test("unknown connection and injected actor/URL/role fields are rejected", async () => {
  const f = await fixture();
  await expect(f.credentials.save("alice", "other", { baseRevision: 0, token: "PRIVATE-TOKEN" })).rejects.toThrow(/Unknown/);
  for (const extra of [{ actorId: "bob" }, { baseURL: "https://attacker.test" }, { role: "admin" }])
    await expect(f.credentials.save("alice", f.id, { baseRevision: 0, token: "PRIVATE-TOKEN", ...extra })).rejects.toThrow(/valid bearer/);
});
test("test performs initialize/discovery only, closes SDK, exposes no inventory or secret", async () => {
  const f = await fixture(); await f.credentials.save("alice", f.id, { baseRevision: 0, token: "ALICE-PRIVATE-ERP-TOKEN" });
  const value = await f.credentials.test("alice", f.id, { baseRevision: 1 });
  expect(f.calls).toHaveLength(0); expect(f.adapters[0]!.listTools).toHaveBeenCalledOnce(); expect(f.adapters[0]!.close).toHaveBeenCalledOnce();
  expect(value.connections[0]!.testedAt).toBeTruthy(); expect(JSON.stringify(value)).not.toContain("ALICE-PRIVATE");
});
test("suspension and role change fence a prepared transport", async () => {
  const f = await fixture(); await f.credentials.save("alice", f.id, { baseRevision: 0, token: "ALICE-PRIVATE-ERP-TOKEN" });
  await f.credentials.scope("alice", await f.binding(), async () => {
    const p = await f.credentials.prepare(f.identity(), f.id);
    await f.repository.mutate(s => { s.users.alice!.status = "Suspended"; });
    expect(() => p.assertCurrent()).toThrow(/not active/); await p.close();
  });
});
test("private binding receipts are stripped from model/public evidence", () => {
  expect(withoutSecretFields({ id: "run", erpCredentialSecret: { profile: "user-mcp-binding/v1", actorId: "alice", revisions: { primary: 1 } } })).toEqual({ id: "run" });
});

test("credential admission reads scoped transaction views without cloning proxies or broadening writes", async () => {
  const f = await fixture(); await f.credentials.save("alice", f.id, { baseRevision: 0, token: "ALICE-PRIVATE-ERP-TOKEN" });
  const transaction = executionTransaction(await f.repository.snapshot(), "new-queued-read");
  expect(f.credentials.binding(transaction.view, "alice")).toEqual(await f.binding());
  expect(() => { transaction.view.users.alice!.status = "Suspended"; }).toThrow(/cannot mutate unrelated/);
});
test("HTTP self-service uses authenticated subject, not supplied owner; non-admin roles can manage only their token", async () => {
  const f = await fixture();
  const registries = await RegistryService.load(resolve("tests/fixtures/tools.json"), resolve("tests/fixtures/rules.json"));
  const validator = new RegistryValidator(registries, f.repository);
  const app = await buildApp({ config: f.config, repository: f.repository, registries, validator, executor: new Executor(new ToolRegistry(), validator), userMcpCredentials: f.credentials });
  cleanup.push(() => app.close());
  const headers = (id = "alice") => ({ authorization: `Bearer ${jwt.sign({}, f.config.jwtSecret, { subject: id })}` });
  expect((await app.inject({ method: "GET", url: "/api/profile/erp-connections" })).statusCode).toBe(401);
  const save = await app.inject({ method: "PUT", url: "/api/profile/erp-connections/erpbridge-default", headers: headers(), payload: { baseRevision: 0, token: "ALICE-HTTP-PRIVATE-TOKEN" } });
  expect(save.statusCode).toBe(200); expect(save.body).not.toContain("ALICE-HTTP-PRIVATE-TOKEN"); expect(save.body).not.toContain("ciphertext");
  const bob = await app.inject({ method: "GET", url: "/api/profile/erp-connections", headers: headers("bob") });
  expect(bob.json().data.connections[0].configured).toBe(false);
  const injection = await app.inject({ method: "PUT", url: "/api/profile/erp-connections/erpbridge-default", headers: headers(), payload: { baseRevision: 1, token: "ATTEMPTED-USER-TOKEN", actorId: "bob" } });
  expect(injection.statusCode).toBe(400); expect(injection.body).not.toContain("ATTEMPTED-USER-TOKEN");
  const deniedAdmin = await app.inject({ method: "GET", url: "/api/settings/mcp-connections", headers: headers() });
  expect(deniedAdmin.statusCode).toBe(403);
  const testResult = await app.inject({ method: "POST", url: "/api/profile/erp-connections/erpbridge-default/test", headers: headers(), payload: { baseRevision: 1 } });
  expect(testResult.statusCode).toBe(200); expect(f.calls).toHaveLength(0);
});
test("governed SDK entry uses the user's transport and keeps catalog transport for metadata only", async () => {
  const f = await fixture();
  await f.credentials.save("alice", f.id, { baseRevision: 0, token: "ALICE-GOVERNED-ERP-TOKEN" });
  const registries = await RegistryService.load(resolve("tests/fixtures/tools.json"), resolve("tests/fixtures/rules.json"));
  const validator = new RegistryValidator(registries, f.repository);
  const yaml = "name: personal_transport\ndescription: Verify the governed ERPBridge adapter.\ntrigger:\n  type: manual\nsteps:\n  - id: echo\n    action: demo.echo\n    parameters:\n      value: ok\n";
  const gate = await validator.validateAndIssueToken("test", yaml, "Workflow Builder"); expect(gate.result.errors).toEqual([]);
  const identity = f.identity();
  const evaluated = await validator.evaluateResolvedStep("test", yaml, 0, { value: "ok" }, gate.token, identity);
  const catalog = { connect: vi.fn(async () => {}), close: vi.fn(async () => {}), listTools: vi.fn(async () => []), callTool: vi.fn(async () => ({ content: [] })) };
  const session = await createErpbridgeMcpSession({ baseURL: "https://erp.example.test", token: "CATALOG-NOT-FOR-BUSINESS", timeoutMs: 1000, validator, sdkClient: catalog, userMcpCredentials: f.credentials });
  cleanup.push(() => session.close());
  const tool = { ...registries.snapshot().tools[0]!, mcp_tool_name: "erp.echo", allowed_roles: ["Workflow Builder"] };
  await f.credentials.scope("alice", await f.binding(), () => session.clientFor(tool).execute("demo.echo", evaluated.capability!, { value: "ok" }, identity));
  expect(catalog.callTool).not.toHaveBeenCalled(); expect(f.calls).toEqual([{ token: "ALICE-GOVERNED-ERP-TOKEN", name: "erp.echo" }]);
});

async function environmentAdminFixture() {
  const f = await fixture(); f.config.erpbridgeAdminEnvironmentAccess = true;
  await f.repository.mutate(state => { state.users.alice!.roleId = "role_admin"; });
  const identity = { userId: "alice", localRole: "Platform Admin", erpbridgeRole: "admin" };
  const call = async () => { const p = await f.credentials.prepare(identity, f.id); try { p.assertCurrent(); await p.sdk.callTool("test.read", {}); } finally { await p.close(); } };
  return { ...f, adminIdentity: identity, adminCall: call };
}

test("explicit opt-in lets only the built-in admin use the server environment token", async () => {
  const f = await environmentAdminFixture(), binding = await f.binding();
  expect(binding.environmentSecret?.[f.id]).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(binding)).not.toContain(f.config.erpbridgeMcpToken);
  await f.credentials.scope("alice", binding, f.adminCall);
  expect(f.calls).toEqual([{ token: f.config.erpbridgeMcpToken, name: "test.read" }]);
  const listed = await f.credentials.list("alice");
  expect(listed).toMatchObject({ credentialMode: "administrator-environment", connections: [{ source: "administrator-environment", configured: true }] });
  expect(JSON.stringify(listed)).not.toContain(f.config.erpbridgeMcpToken);
  expect((await f.credentials.list("bob")).connections[0]).toMatchObject({ source: "missing", configured: false });
  expect(withoutSecretFields({ environmentSecret: binding.environmentSecret })).toEqual({});
  expect(operationReadbackJobSchema.shape.erpCredentialSecret.parse(binding)).toEqual(binding);
});

test("admin environment behavior is off by default and cannot be acquired by a copied role name", async () => {
  const f = await fixture(); expect(f.config.erpbridgeAdminEnvironmentAccess).toBe(false);
  await f.repository.mutate(state => { state.users.alice!.roleId = "role_admin"; });
  await expect(f.credentials.scope("alice", await f.binding(), () => f.credentials.prepare({ userId: "alice", localRole: "Platform Admin", erpbridgeRole: "admin" }, f.id))).rejects.toThrow(/own ERPBridge token/);
  f.config.erpbridgeAdminEnvironmentAccess = true;
  await f.repository.mutate(state => { state.roles.role_builder!.name = "Platform Admin"; state.users.alice!.roleId = "role_builder"; });
  expect((await f.binding()).environmentSecret).toBeUndefined();
  await expect(f.credentials.scope("alice", await f.binding(), () => f.credentials.prepare({ userId: "alice", localRole: "Platform Admin", erpbridgeRole: "admin" }, f.id))).rejects.toThrow(/own ERPBridge token/);
  expect(f.calls).toHaveLength(0);
});

test("old admin jobs and personal receipts never adopt the environment credential", async () => {
  const f = await environmentAdminFixture();
  for (const receipt of [undefined, { profile: "user-mcp-binding/v1", actorId: "alice", revisions: { [f.id]: 0 } }])
    await expect(f.credentials.scope("alice", receipt, f.adminCall)).rejects.toThrow(/binding/i);
  expect(f.adapters).toHaveLength(0);
});

test.each(["token", "endpoint", "role-map", "opt-in", "role", "suspended"])("admin environment binding is fenced when %s changes", async change => {
  const f = await environmentAdminFixture(), binding = await f.binding();
  if (change === "token") f.config.erpbridgeConnections[0]!.mcpToken = "ROTATED-SERVER-ADMIN-TOKEN";
  if (change === "endpoint") f.config.erpbridgeConnections[0]!.baseURL = "https://different.example.test";
  if (change === "role-map") f.config.erpbridgeConnections[0]!.roleMap = { "Platform Admin": "different" };
  if (change === "opt-in") f.config.erpbridgeAdminEnvironmentAccess = false;
  if (change === "role") await f.repository.mutate(state => { state.users.alice!.roleId = "role_builder"; });
  if (change === "suspended") await f.repository.mutate(state => { state.users.alice!.status = "Suspended"; });
  await expect(f.credentials.scope("alice", binding, f.adminCall)).rejects.toBeInstanceOf(Error);
  expect(f.calls).toHaveLength(0); expect(f.adapters).toHaveLength(0);
});

test("server-managed admin connection testing is discovery-only and cannot replace/remove the environment secret", async () => {
  const f = await environmentAdminFixture();
  await expect(f.credentials.save("alice", f.id, { baseRevision: 0, token: "BROWSER-TOKEN-REPLACEMENT" })).rejects.toMatchObject({ status: 403 });
  await expect(f.credentials.remove("alice", f.id, { baseRevision: 0 })).rejects.toMatchObject({ status: 403 });
  const tested = await f.credentials.test("alice", f.id, { baseRevision: 0 });
  expect(tested.connections[0]?.testedAt).toBeTruthy(); expect(f.calls).toHaveLength(0);
  expect(Object.keys((await f.repository.snapshot()).userMcpCredentials)).toHaveLength(0);
  expect(f.adapters[0]!.listTools).toHaveBeenCalledOnce(); expect(f.adapters[0]!.close).toHaveBeenCalledOnce();
});

test("admin source changes during initialization fence already prepared transport", async () => {
  const f = await environmentAdminFixture();
  f.setConnectHook(async () => { f.config.erpbridgeConnections[0]!.mcpToken = "ROTATED-DURING-CONNECT"; });
  await expect(f.credentials.scope("alice", await f.binding(), f.adminCall)).rejects.toMatchObject({ meta: { code: "ERP_USER_CREDENTIAL_CHANGED" } });
  expect(f.calls).toHaveLength(0); expect(f.adapters[0]!.close).toHaveBeenCalledOnce();
});
