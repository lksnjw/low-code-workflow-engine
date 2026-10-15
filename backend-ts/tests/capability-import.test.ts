import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jwt from "jsonwebtoken";
import { afterEach, expect, test, vi } from "vitest";
import { RegistryService } from "../src/registry/service.js";
import { Repository, type PersistenceBackend } from "../src/repository/store.js";
import { RegistryValidator } from "../src/validator/registry-validator.js";
import { createErpbridgeMcpSession, type ErpbridgeMcpSdkTool } from "../src/tools/erpbridge-mcp-client.js";
import { admissionAuthorizer, captureCapabilityAdmissionPin, disableCapability, observeCapabilities, reviewCapability } from "../src/registry/capability-admission.js";
import { stringify } from "yaml";
import { importDiscoveredCapability, restoreImportedCapabilities } from "../src/registry/capability-import.js";
import { discoveredContract, discoveredToolIdentity, remoteContractHash } from "../src/registry/discovered-contract.js";
import { discoverTools } from "../src/agent/tool-discovery.js";
import { matchesBridgeContract } from "../src/tools/erpbridge-contract.js";
import { dispatchReadTool } from "../src/tools/read-tool-broker.js";
import { Executor } from "../src/runner/executor.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { buildApp } from "../src/http/app.js";
import { loadConfig } from "../src/config/config.js";

const disposers: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const dispose of disposers.splice(0).reverse()) await dispose(); });
class Persistence implements PersistenceBackend {
  readonly readQueueDurability = "encrypted-single-writer" as const;
  payload: Uint8Array | null = null; loseAck = false;
  async load() { return this.payload; }
  async save(bytes: Uint8Array) { this.payload = Buffer.from(bytes); if (this.loseAck) { this.loseAck = false; throw new Error("Acknowledgement lost after commit"); } }
  async close() {} async probe() {}
}
function remoteTool(base = "reports.lookup", roles: string[] = []): ErpbridgeMcpSdkTool {
  return { name: `${base}.rev_MS4wLjA`, description: "Remote description is evidence, never permission", annotations: { readOnlyHint: true },
    inputSchema: { type: "object", properties: { recordId: { type: "string" }, ...(roles.length ? { role: { type: "string", description: "Authorization role used for this tool call", enum: [...roles].sort() } } : {}) }, required: ["recordId"], additionalProperties: false },
    outputSchema: { type: "object", properties: { count: { type: "integer" } }, required: ["count"], additionalProperties: false },
    _meta: { "toolplane.resourceVersion": "1.0.0", "toolplane.resourceDigest": "a".repeat(64), "io.erpbridge/allowedRoles": roles } };
}
async function setup(persistence: PersistenceBackend | null = null, connectionId = "erpbridge-default", initial = remoteTool()) {
  const directory = await mkdtemp(join(tmpdir(), "lcwe-import-contract-")); disposers.push(() => rm(directory, { recursive: true, force: true }));
  const toolsPath = join(directory, "tools.json"), rulesPath = join(directory, "rules.json");
  await writeFile(toolsPath, "[]"); await writeFile(rulesPath, "[]");
  const repository = await Repository.open(persistence); disposers.push(() => repository.close());
  const timestamp = new Date().toISOString();
  await repository.mutate(state => { for (const [id, roleId] of [["admin", "role_admin"], ["builder", "role_builder"]]) state.users[id!] = { id: id!, name: id!, email: `${id}@example.test`, roleId: roleId!, status: "Active", permissionOverrides: [], initials: "A", departmentId: null, lastLoginAt: null, createdAt: timestamp }; });
  const registries = await RegistryService.load(toolsPath, rulesPath), validator = new RegistryValidator(registries, repository);
  let remote = initial, generationChanged: (() => void) | undefined;
  const sdk = { metadataComplete: true, connect: vi.fn(async () => {}), close: vi.fn(async () => {}),
    onToolsChanged: (listener: () => void) => { generationChanged = listener; return () => {}; },
    listTools: vi.fn(async () => [structuredClone(remote)]), callTool: vi.fn(async () => ({ structuredContent: { count: 7 }, content: [] })) };
  const session = await createErpbridgeMcpSession({ baseURL: "https://fixture.invalid", token: "fixture-only", timeoutMs: 1000, validator, sdkClient: sdk,
    connectionId, admissionAuthorizer: admissionAuthorizer(repository, registries, connectionId) }); disposers.push(() => session.close());
  const admin = (await repository.effectiveUser("admin"))!, builder = (await repository.effectiveUser("builder"))!;
  // Synthetic immutable-host projection; not production storage/transport qualification.
  const config = { ...loadConfig({ APP_ENV: "test", JWT_SECRET: "discovery-import-tests-at-least-32-bytes", STORAGE_DRIVER: "memory", MCP_MODE: "mock" }), environment: "production" as const };
  const services = { repository, registries, validator, erpbridgeSession: session, config, executor: new Executor(new ToolRegistry(), validator) };
  const body = (patch = {}) => ({ remoteName: remote.name, remoteHash: remoteContractHash(remote), decisionKey: "explicit-import-key-0001", allowedRoles: ["Platform Admin"], effectClass: "read", riskClass: "low", dataClass: "internal", retryPolicy: "never", note: "Explicit synthetic contract/policy review", confirmed: true, ...patch });
  const runImport = (patch = {}, user = admin) => importDiscoveredCapability({ repository, registries, session, user, connectionId, body: body(patch) });
  return { repository, registries, validator, session, sdk, admin, builder, config, services, body, runImport, toolsPath, rulesPath,
    remote: () => remote, change: (value: ErpbridgeMcpSdkTool) => { remote = value; generationChanged?.(); } };
}

test("unknown discovery has schema/hints but grants no roles or execution; explicit import persists and admits the exact new action", async () => {
  const s = await setup(), beforeHash = s.registries.hash();
  const discovery = await observeCapabilities({ ...s, user: s.admin });
  expect(discovery.authorityGranted).toBe(false); expect(discovery.observations).toEqual([]);
  expect(discovery.unreviewedInventory[0]).toMatchObject({ importable: true, authorityGranted: false, hints: { advisoryOnly: true }, definition: { allowed_roles: [], is_read_only: false } });
  expect(await discoverTools(s.session, s.registries)).toEqual([]); expect(s.sdk.callTool).not.toHaveBeenCalled();
  const imported = await s.runImport(), tool = s.registries.snapshot().tools[0]!;
  expect(imported.duplicate).toBe(false); expect(imported.admission.state).toBe("AVAILABLE"); expect(tool.connection_id).toBe("erpbridge-default");
  expect(s.registries.hash()).not.toBe(beforeHash); expect(matchesBridgeContract(tool, s.remote())).toBe(true);
  expect(await discoverTools(s.session, s.registries)).toEqual([tool]);
  expect((await dispatchReadTool(s.services, "admin", tool.name, { recordId: "REC-7" })).structuredContent).toEqual({ count: 7 });
  expect(s.sdk.callTool).toHaveBeenCalledTimes(1); expect(await readFile(s.toolsPath, "utf8")).toBe("[]"); expect(await readFile(s.rulesPath, "utf8")).toBe("[]");
  expect((await s.repository.snapshot()).auditLogs.some(value => value.action === "capability.discovered.imported")).toBe(true);
});

test("immutable-host HTTP fixture import does not mutate release files and rejects a non-admin before discovery", async () => {
  const s = await setup(), app = await buildApp(s.services); disposers.push(() => app.close());
  const headers = (id: string) => ({ authorization: `Bearer ${jwt.sign({}, s.config.jwtSecret, { subject: id, expiresIn: 3600 })}` });
  const beforeCalls = s.sdk.listTools.mock.calls.length;
  const denied = await app.inject({ method: "POST", url: "/api/registry/capabilities/import", headers: headers("builder"), payload: s.body() });
  expect(denied.statusCode).toBe(403); expect(s.sdk.listTools).toHaveBeenCalledTimes(beforeCalls);
  const response = await app.inject({ method: "POST", url: "/api/registry/capabilities/import", headers: headers("admin"), payload: s.body() });
  expect(response.statusCode, response.body).toBe(200); expect(response.json().data.admission.state).toBe("AVAILABLE");
  expect(response.body).not.toContain("fixture-only"); expect(response.json().data.revision).not.toHaveProperty("connectionBinding");
  expect(await readFile(s.toolsPath, "utf8")).toBe("[]"); expect(s.sdk.callTool).not.toHaveBeenCalled();
});

test("reviewed catalog restores from saved records in a fresh registry without file edits; disable survives reopen", async () => {
  const storage = new Persistence(), s = await setup(storage), result = await s.runImport();
  const reopened = await Repository.open(storage); disposers.push(() => reopened.close());
  const registry = await RegistryService.load(s.toolsPath, s.rulesPath);
  await restoreImportedCapabilities(reopened, registry); expect(registry.snapshot().tools).toEqual(s.registries.snapshot().tools); expect(registry.hash()).toBe(s.registries.hash());
  await disableCapability({ repository: s.repository, user: s.admin, capabilityId: result.admission.capabilityId, body: { revisionId: result.revision.id, baseVersion: result.admission.version, note: "Explicitly disable synthetic import" } });
  const again = await Repository.open(storage); disposers.push(() => again.close());
  await restoreImportedCapabilities(again, registry); expect(registry.snapshot().tools).toHaveLength(1);
  const state = await again.snapshot();
  expect(() => captureCapabilityAdmissionPin(state, registry, registry.snapshot().tools[0]!, s.session.admissionBinding!)).toThrow(/disabled/);
  const retry = await s.runImport(); expect(retry.duplicate).toBe(true); expect(retry.admission.state).toBe("DISABLED"); expect(await discoverTools(s.session, s.registries)).toEqual([]);
});

test.each([
  { confirmed: false }, { allowedRoles: [] }, { allowedRoles: ["Imaginary Administrator"] }, { retryPolicy: "always" },
  { approved: true }, { definition: { name: "attacker" } }, { remoteHash: `sha256:${"b".repeat(64)}` }, { riskClass: "high" },
])("invalid or drifted review %j never grants an imported capability", async patch => {
  const s = await setup(); await expect(s.runImport(patch)).rejects.toThrow();
  expect(s.registries.snapshot().tools).toEqual([]); expect((await s.repository.snapshot()).capabilityAdmissions).toEqual({}); expect(s.sdk.callTool).not.toHaveBeenCalled();
});

test("changed remote contract blocks old admission and needs a distinct explicit review, never automatic re-enable", async () => {
  const s = await setup(), first = await s.runImport();
  s.change({ ...s.remote(), _meta: { ...s.remote()._meta, "toolplane.resourceDigest": "b".repeat(64) } });
  const discovery = await observeCapabilities({ ...s, user: s.admin }); expect(discovery.blockedCount).toBe(1); expect(await discoverTools(s.session, s.registries)).toEqual([]);
  await expect(s.runImport()).rejects.toThrow(/decision key/);
  const next = await s.runImport({ decisionKey: "explicit-import-key-0002" }); expect(next.revision.id).not.toBe(first.revision.id); expect(next.admission.state).toBe("AVAILABLE");
  expect(s.registries.snapshot().tools).toHaveLength(1); expect(s.registries.snapshot().tools[0]?.bridge_contract?.resource_digest).toBe("b".repeat(64));
});

test("transport role is removed from business arguments and reconstructed exactly; a role-looking business field is not blindly accepted", async () => {
  const s = await setup(null, "erpbridge-default", remoteTool("reports.lookup", ["admin"]));
  await s.runImport(); const tool = s.registries.snapshot().tools[0]!;
  expect(tool.input_schema.properties).not.toHaveProperty("role"); expect(matchesBridgeContract(tool, s.remote())).toBe(true);
  const bad = remoteTool("bad.lookup", ["admin"]); (bad.inputSchema.properties as Record<string, unknown>).role = { type: "string", description: "Business role", enum: ["manager"] };
  expect(() => discoveredContract(bad, "erpbridge-default")).toThrow(/exactly/);
});

test("two connections may import the same remote name without catalog collision or cross-connection dispatch", async () => {
  const s = await setup(), first = await s.runImport(), secondId = "secondary", sdk = { ...s.sdk, listTools: vi.fn(async () => [s.remote()]), callTool: vi.fn(async () => ({ structuredContent: { count: 8 }, content: [] })) };
  const second = await createErpbridgeMcpSession({ baseURL: "https://fixture.invalid", token: "other-fixture", timeoutMs: 1000, validator: s.validator, sdkClient: sdk, connectionId: secondId,
    admissionAuthorizer: admissionAuthorizer(s.repository, s.registries, secondId) }); disposers.push(() => second.close());
  const imported = await importDiscoveredCapability({ ...s, session: second, user: s.admin, connectionId: secondId, body: s.body() });
  expect(imported.admission.capabilityId).not.toBe(first.admission.capabilityId); expect(s.registries.snapshot().tools).toHaveLength(2);
  expect((await discoverTools(s.session, s.registries)).map(tool => tool.connection_id)).toEqual(["erpbridge-default"]);
  expect((await discoverTools(second, s.registries)).map(tool => tool.connection_id)).toEqual([secondId]);
  const wrong = s.registries.snapshot().tools.find(tool => tool.connection_id === secondId)!;
  const state = await s.repository.snapshot(); expect(() => captureCapabilityAdmissionPin(state, s.registries, wrong, s.session.admissionBinding!)).toThrow(/another connection/);
  const refreshed = await observeCapabilities({ ...s, user: s.admin }); expect(refreshed.observations).toHaveLength(1); expect(refreshed.blockedCount).toBe(0);
});

test("operation import requires a matching declared result contract and independent approval, without executing it", async () => {
  const remote = remoteTool("messages.dispatch"); remote.annotations = { readOnlyHint: false, destructiveHint: false };
  remote.outputSchema = { type: "object", properties: { accepted: { type: "boolean" } }, required: ["accepted"], additionalProperties: false };
  const s = await setup(null, "erpbridge-default", remote);
  await expect(s.runImport()).rejects.toThrow(/conflict/);
  const operation = { effectClass: "notification", riskClass: "medium", dataClass: "internal", sideEffects: ["External message delivery"], requireIndependentApproval: true,
    operationContract: { profile: "operation-result/v1", effect_class: "notification", retry_policy: "never", confirmation: { path: ["accepted"], expected: true, meaning: "operation-accepted" } } };
  const result = await s.runImport(operation); expect(result.revision.policy).toMatchObject({ effectClass: "notification", requireIndependentApproval: true });
  const tool = s.registries.snapshot().tools[0]!; expect(tool.is_read_only).toBe(false);
  await expect(dispatchReadTool(s.services, "admin", tool.name, { recordId: "REC-7" })).rejects.toThrow(); expect(s.sdk.callTool).not.toHaveBeenCalled();
  await expect(s.runImport({ ...operation, decisionKey: "operation-review-next-0002", requireIndependentApproval: false })).rejects.toThrow();
});

test("lost commit acknowledgement is not success; reopen recovers the one original review and exact-key retry does not duplicate it", async () => {
  const storage = new Persistence(), s = await setup(storage); storage.loseAck = true;
  await expect(s.runImport()).rejects.toThrow(/Acknowledgement/); expect(s.registries.snapshot().tools).toEqual([]);
  const reopened = await Repository.open(storage); disposers.push(() => reopened.close());
  await restoreImportedCapabilities(reopened, s.registries);
  // The original session is correctly fenced with its failed repository.
  // Reopening storage must construct a new owned validator/session as well.
  const validator = new RegistryValidator(s.registries, reopened);
  const session = await createErpbridgeMcpSession({ baseURL: "https://fixture.invalid", token: "fixture-only", timeoutMs: 1000, validator, sdkClient: s.sdk,
    connectionId: "erpbridge-default", admissionAuthorizer: admissionAuthorizer(reopened, s.registries) }); disposers.push(() => session.close());
  const result = await importDiscoveredCapability({ ...s, session, repository: reopened, user: s.admin, body: s.body() });
  expect(result.duplicate).toBe(true); const state = await reopened.snapshot(); expect(Object.keys(state.capabilityRevisions)).toHaveLength(1); expect(Object.keys(state.capabilityAdmissions)).toHaveLength(1);
});

test("dynamic definitions do not leak into file-based rule updates or file tool imports", async () => {
  const s = await setup(); await s.runImport(); const tool = s.registries.snapshot().tools[0]!;
  await s.registries.upsertRule({ rule_id: "TEST", enabled: false }, false); expect(s.registries.snapshot().tools).toEqual([tool]); expect(await readFile(s.toolsPath, "utf8")).toBe("[]");
  await expect(s.registries.upsertTool(tool, true)).rejects.toThrow(/persisted capability/); expect(await readFile(s.toolsPath, "utf8")).toBe("[]");
  expect(discoveredToolIdentity("erpbridge-default", "a".repeat(240)).name.length).toBeLessThanOrEqual(128);
});

test.each(["missing version", "bad digest", "duplicate roles", "unsupported schema"])("%s is shown as unsupported inventory, not an executable proposal", async damage => {
  const remote = remoteTool();
  if (damage === "missing version") delete remote._meta!["toolplane.resourceVersion"];
  if (damage === "bad digest") remote._meta!["toolplane.resourceDigest"] = "untrusted";
  if (damage === "duplicate roles") remote._meta!["io.erpbridge/allowedRoles"] = ["admin", "admin"];
  if (damage === "unsupported schema") remote.inputSchema = { type: "array", items: { type: "string" } };
  const s = await setup(null, "erpbridge-default", remote), result = await observeCapabilities({ ...s, user: s.admin });
  expect(result.unreviewedInventory[0]).toMatchObject({ importable: false, authorityGranted: false });
  expect((await s.repository.snapshot()).capabilityAdmissions).toEqual({}); expect(s.sdk.callTool).not.toHaveBeenCalled();
});

test("plain hosted MCP array contract is discoverable but cannot acquire a fabricated version or admission", async () => {
  const remote: ErpbridgeMcpSdkTool = { name: "list_companies", inputSchema: { type: "object" },
    outputSchema: { type: "array", items: { type: "object" } }, annotations: { readOnlyHint: true, destructiveHint: false },
    _meta: { "io.erpbridge/examples": ["List companies"] } };
  const s = await setup(null, "erpbridge-default", remote);
  const discovery = await observeCapabilities({ ...s, user: s.admin });
  expect(discovery.unreviewedInventory).toHaveLength(1);
  expect(discovery.unreviewedInventory[0]).toMatchObject({ remoteName: "list_companies", importable: false, authorityGranted: false });
  await expect(s.runImport()).rejects.toThrow(/versioned/);
  expect((await s.repository.snapshot()).capabilityAdmissions).toEqual({});
  expect(s.registries.snapshot().tools).toEqual([]);
  expect(s.sdk.callTool).not.toHaveBeenCalled();
});

test("hosted digest-pinned read alias requires an explicit review and dispatches its original name with its digest", async () => {
  const remote = { ...remoteTool("reports.lookup"), name: "reports.lookup" };
  remote._meta!["toolplane.serving"] = true;
  const s = await setup(null, "erpbridge-default", remote);
  const preview = await observeCapabilities({ ...s, user: s.admin });
  expect(preview.unreviewedInventory[0]).toMatchObject({ importable: true, authorityGranted: false,
    definition: { is_read_only: false, allowed_roles: [], bridge_contract: { selector: "digest-pinned-alias" } } });
  expect(s.sdk.callTool).not.toHaveBeenCalled();
  const imported = await s.runImport();
  expect(imported.admission.state).toBe("AVAILABLE");
  const definition = s.registries.snapshot().tools[0]!;
  s.sdk.callTool.mockImplementationOnce(async () => ({ content: [{ type: "text", text: '{"count":7}' }] }) as any);
  const result = await dispatchReadTool(s.services, "admin", definition.name, { recordId: "one" });
  expect(JSON.stringify(result)).toContain("7");
  expect(s.sdk.callTool).toHaveBeenCalledWith("reports.lookup", { recordId: "one" }, { "toolplane.resourceDigest": "a".repeat(64) });
});

test.each(["missing-serving", "not-serving", "not-read-only", "destructive", "missing-output"])("alias %s remains non-importable", async scenario => {
  const remote = { ...remoteTool("reports.lookup"), name: "reports.lookup" };
  remote._meta!["toolplane.serving"] = true;
  if (scenario === "missing-serving") delete remote._meta!["toolplane.serving"];
  if (scenario === "not-serving") remote._meta!["toolplane.serving"] = false;
  if (scenario === "not-read-only") remote.annotations = { readOnlyHint: false };
  if (scenario === "destructive") remote.annotations = { readOnlyHint: true, destructiveHint: true };
  if (scenario === "missing-output") delete remote.outputSchema;
  const s = await setup(null, "erpbridge-default", remote);
  expect((await observeCapabilities({ ...s, user: s.admin })).unreviewedInventory[0]).toMatchObject({ importable: false, authorityGranted: false });
  await expect(s.runImport()).rejects.toThrow();
  expect(s.sdk.callTool).not.toHaveBeenCalled();
});

test("read-alias compatibility cannot be promoted to a write or bypass a later disable", async () => {
  const remote = { ...remoteTool("reports.lookup"), name: "reports.lookup" };
  remote._meta!["toolplane.serving"] = true;
  const s = await setup(null, "erpbridge-default", remote);
  await expect(s.runImport({ effectClass: "write", sideEffects: ["Create an ERP record"], requireIndependentApproval: true,
    operationContract: { profile: "operation-result/v1", effect_class: "write", retry_policy: "never", confirmation: { path: ["count"], expected: 7, meaning: "operation-accepted" } } })).rejects.toThrow(/read-only/);
  expect((await s.repository.snapshot()).capabilityAdmissions).toEqual({});
  const reviewed = await s.runImport(), tool = s.registries.snapshot().tools[0]!;
  await disableCapability({ repository: s.repository, user: s.admin, capabilityId: reviewed.admission.capabilityId,
    body: { revisionId: reviewed.revision.id, baseVersion: reviewed.admission.version, note: "Explicit local read revoke" } });
  await expect(dispatchReadTool(s.services, "admin", tool.name, { recordId: "one" })).rejects.toThrow();
  expect(s.sdk.callTool).not.toHaveBeenCalled();
});

test("read-alias digest drift blocks its saved review rather than silently rebinding it", async () => {
  const remote = { ...remoteTool("reports.lookup"), name: "reports.lookup" };
  remote._meta!["toolplane.serving"] = true;
  const s = await setup(null, "erpbridge-default", remote);
  const reviewed = await s.runImport();
  s.change({ ...remote, _meta: { ...remote._meta, "toolplane.resourceDigest": "b".repeat(64) } });
  await observeCapabilities({ ...s, user: s.admin });
  expect((await s.repository.snapshot()).capabilityAdmissions[reviewed.admission.capabilityId]?.state).toBe("BLOCKED");
  expect(await discoverTools(s.session, s.registries)).toEqual([]);
  expect(s.sdk.callTool).not.toHaveBeenCalled();
});
test("authority revoked while metadata is fetched prevents review commit", async () => {
  const s = await setup(); s.sdk.listTools.mockImplementationOnce(async () => {
    await s.repository.mutate(state => { state.users.admin!.roleId = "role_builder"; }); return [s.remote()];
  });
  await expect(s.runImport()).rejects.toThrow(); expect((await s.repository.snapshot()).capabilityAdmissions).toEqual({}); expect(s.registries.snapshot().tools).toEqual([]);
});
test("cancellation during discovery prevents import commit", async () => {
  const s = await setup(), controller = new AbortController();
  s.sdk.listTools.mockImplementationOnce(async () => { controller.abort(); return [s.remote()]; });
  await expect(importDiscoveredCapability({ ...s, user: s.admin, body: s.body(), signal: controller.signal })).rejects.toThrow();
  expect((await s.repository.snapshot()).capabilityAdmissions).toEqual({}); expect(s.registries.snapshot().tools).toEqual([]);
});

test("imported tool supports normal save/publish/queued read and saved output without bypassing revocation", async () => {
  const s = await setup(), imported = await s.runImport(), tool = s.registries.snapshot().tools[0]!;
  const app = await buildApp(s.services); disposers.push(() => app.close());
  const headers = { authorization: `Bearer ${jwt.sign({}, s.config.jwtSecret, { subject: "admin", expiresIn: 3600 })}` };
  const yaml = stringify({ name: "Discovered fixture lookup", description: "Reads one exact synthetic record through the reviewed imported contract", trigger: { type: "manual" }, steps: [{ id: "lookup", action: tool.name, parameters: { recordId: "REC-7" } }] });
  const created = await app.inject({ method: "POST", url: "/api/workflows", headers, payload: { yaml } }); expect(created.statusCode, created.body).toBe(201);
  const workflowId = created.json().data.id;
  const published = await app.inject({ method: "POST", url: `/api/workflows/${workflowId}/publish`, headers, payload: {} }); expect(published.statusCode, published.body).toBe(200);
  const run = await app.inject({ method: "POST", url: `/api/workflows/${workflowId}/run`, headers, payload: { mode: "async-read", idempotencyKey: "imported-read-run-0001", input: {} } }); expect(run.statusCode, run.body).toBe(202);
  const executionId = run.json().data.id;
  await vi.waitFor(async () => expect((await s.repository.snapshot()).executions[executionId]?.status).toBe("DONE"));
  const saved = (await app.inject({ method: "GET", url: `/api/executions/${executionId}`, headers })).json().data;
  expect(saved.stepOutputs.lookup.structuredContent).toEqual({ count: 7 }); expect(s.sdk.callTool).toHaveBeenCalledTimes(1);
  await disableCapability({ repository: s.repository, user: s.admin, capabilityId: imported.admission.capabilityId, body: { revisionId: imported.revision.id, baseVersion: imported.admission.version, note: "Stop new discovered-tool runs" } });
  const denied = await app.inject({ method: "POST", url: `/api/workflows/${workflowId}/run`, headers, payload: { mode: "async-read", idempotencyKey: "imported-denied-run-0002", input: {} } });
  expect(denied.statusCode).toBeGreaterThanOrEqual(400); expect(s.sdk.callTool).toHaveBeenCalledTimes(1);
  expect((await s.repository.snapshot()).executions[executionId]?.stepOutputs).toEqual(saved.stepOutputs);
});

test("ordinary re-review preserves discovered source identity for later process reconstruction", async () => {
  const s = await setup(); await s.runImport(); const observed = await observeCapabilities({ ...s, user: s.admin }), observation = observed.observations[0]!;
  const result = await reviewCapability({ ...s, user: s.admin, capabilityId: observation.capabilityId, body: { observationId: observation.id, contractHash: observation.contractHash,
    decisionKey: "discovered-rereview-0002", effectClass: "read", riskClass: "low", dataClass: "restricted", retryPolicy: "never", note: "Reviewed classification change" } });
  expect(result.revision.definitionSource).toBe("discovered-contract/v1");
  const fresh = await RegistryService.load(s.toolsPath, s.rulesPath); await restoreImportedCapabilities(s.repository, fresh);
  expect(fresh.snapshot().tools).toEqual(s.registries.snapshot().tools);
});
