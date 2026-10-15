import { resolve } from "node:path";
import jwt from "jsonwebtoken";
import { afterEach, expect, test, vi } from "vitest";
import { RegistryService } from "../src/registry/service.js";
import { Repository, type PersistenceBackend, type RepositoryState } from "../src/repository/store.js";
import { applyExecutionCheckpoint, type ExecutionCheckpoint } from "../src/repository/execution-transaction.js";
import { RegistryValidator } from "../src/validator/registry-validator.js";
import { toolSchema } from "../src/registry/schemas.js";
import { admissionAuthorizer, observeCapabilities, reviewCapability, disableCapability, capabilityAdmissionCatalog, capabilityContractHash, requireProductionAdmissionProfile, captureReadAdmissionPin, reviewedCapabilityDataClass } from "../src/registry/capability-admission.js";
import { bridgeTransportSchema, exactBridgeName } from "../src/tools/erpbridge-contract.js";
import { createErpbridgeMcpSession } from "../src/tools/erpbridge-mcp-client.js";
import { discoverTools } from "../src/agent/tool-discovery.js";
import { dispatchReadTool } from "../src/tools/read-tool-broker.js";
import { buildApp } from "../src/http/app.js";
import { loadConfig } from "../src/config/config.js";
import { Executor } from "../src/runner/executor.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { stringify } from "yaml";
import { readJobQueue } from "../src/runner/read-jobs.js";
import type { Workflow } from "../src/models/schemas.js";
import { modelDataClasses } from "../src/providers/egress-policy.js";

const sessions: { close(): Promise<unknown> }[] = [];
afterEach(async () => { await Promise.all(sessions.splice(0).map(value => value.close())); });
class Persistence implements PersistenceBackend {
  readonly readQueueDurability = "encrypted-single-writer" as const;
  payload: Uint8Array | null = null; loseAck = false;
  async load() { return this.payload; }
  async save(bytes: Uint8Array) { this.payload = Buffer.from(bytes); if (this.loseAck) { this.loseAck = false; throw new Error("Commit acknowledgement lost"); } }
  async close() {} async probe() {}
}
// Explicit record-capability fault fixture, not an encryption or SQL proof.
// Actual encrypted normalized storage is exercised by verify-postgres-records.
class RecordPersistence extends Persistence {
  readonly executionCheckpointDurability = "encrypted-record-transactions/v1" as const;
  failWhen: ((state: RepositoryState) => boolean) | undefined;
  committedLoss = false;
  async save(bytes: Uint8Array) {
    if (this.failWhen?.(JSON.parse(Buffer.from(bytes).toString("utf8")))) {
      this.failWhen = undefined;
      if (this.committedLoss) this.payload = Buffer.from(bytes);
      throw new Error("Record fixture acknowledgement lost");
    }
    await super.save(bytes);
  }
  async saveExecutionCheckpoint(checkpoint: ExecutionCheckpoint) {
    const state = JSON.parse(Buffer.from(this.payload!).toString("utf8")) as RepositoryState;
    await this.save(Buffer.from(JSON.stringify(applyExecutionCheckpoint(state, checkpoint))));
  }
}
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
async function setup(persistence: PersistenceBackend | null = null, noAuthorizer = false) {
  const repository = await Repository.open(persistence), timestamp = new Date().toISOString();
  await repository.mutate(state => { for (const [id, roleId] of [["admin", "role_admin"], ["builder", "role_builder"]]) state.users[id!] = { id: id!, name: id!, email: `${id}@example.test`, roleId: roleId!, status: "Active", permissionOverrides: [], initials: "A", departmentId: null, lastLoginAt: null, createdAt: timestamp }; });
  const registries = await RegistryService.load(resolve("tests/fixtures/chat-read-tools.json"), resolve("tests/fixtures/rules.json"));
  let tool = toolSchema.parse({ ...registries.snapshot().tools[0], bridge_contract: { profile: "toolplane-v1", resource_version: "1.0.0", resource_digest: "a".repeat(64), remote_roles: [] } });
  const original = registries.snapshot();
  vi.spyOn(registries, "snapshot").mockImplementation(() => ({ ...original, tools: [tool] }));
  vi.spyOn(registries, "findTool").mockImplementation(name => [tool.name, tool.mcp_tool_name, tool.tool_id].includes(name) ? tool : undefined);
  vi.spyOn(registries, "hash").mockImplementation(() => capabilityContractHash(tool));
  const validator = new RegistryValidator(registries, repository);
  let generationListener: (() => void) | undefined;
  const remote = () => ({ name: exactBridgeName(tool), inputSchema: bridgeTransportSchema(tool), _meta: { "toolplane.resourceDigest": tool.bridge_contract!.resource_digest, "toolplane.resourceVersion": tool.bridge_contract!.resource_version, "io.erpbridge/allowedRoles": [] } });
  const sdk = { metadataComplete: true, connect: vi.fn(async () => {}), close: vi.fn(async () => {}), onToolsChanged: (listener: () => void) => { generationListener = listener; return () => {}; },
    listTools: vi.fn(async () => [remote()]), callTool: vi.fn(async (_name?: string, _args?: Record<string, unknown>, _meta?: Record<string, unknown>) => ({ content: [{ type: "text", text: "Confirmed fixture" }] })) };
  const session = await createErpbridgeMcpSession({ baseURL: "https://fixture.example.test", token: "private-credential", timeoutMs: 1000, validator, sdkClient: sdk,
    ...(!noAuthorizer ? { admissionAuthorizer: admissionAuthorizer(repository, registries) } : {}) }); sessions.push(session);
  const admin = (await repository.effectiveUser("admin"))!, builder = (await repository.effectiveUser("builder"))!;
  const config = loadConfig({ APP_ENV: "test", JWT_SECRET: "admission-test-secret-at-least-32-bytes", STORAGE_DRIVER: "memory", MCP_MODE: "mock", STORAGE_ENCRYPTION_KEY: "x".repeat(32) });
  const services = { repository, registries, validator, erpbridgeSession: session, config, executor: new Executor(new ToolRegistry(), validator) };
  const observe = () => observeCapabilities({ repository, registries, session, user: admin });
  const body = (observation: { id: string; contractHash: string }, extra = {}) => ({ observationId: observation.id, contractHash: observation.contractHash,
    decisionKey: "review-fixture-key-0001", effectClass: "read", riskClass: "low", dataClass: "internal", retryPolicy: "never", note: "Reviewed exact fixture and read policy", ...extra });
  const review = async (extra = {}) => { const observation = (await observe()).observations[0]!; return reviewCapability({ repository, registries, session, user: admin, capabilityId: observation.capabilityId, body: body(observation, extra) }); };
  return { repository, registries, validator, session, sdk, admin, builder, services, observe, body, review, remote,
    tool: () => tool, changeTool: (patch: Partial<typeof tool>) => { tool = { ...tool, ...patch }; }, changed: () => generationListener?.() };
}

async function workflowHarness(s: Awaited<ReturnType<typeof setup>>, legacyPublication = false, controlFlow?: unknown, firstValue = "first") {
  const yaml = stringify({ name: "Compiled reads", description: "Two exact fixture reads", trigger: { type: "manual" }, steps: [{ id: "one", action: s.tool().name, parameters: { value: firstValue } }, { id: "two", action: s.tool().name, parameters: { value: "second" } }], ...(controlFlow ? { metadata: { controlFlow } } : {}) });
  const date = new Date().toISOString();
  const workflow: Workflow = { id: "compiled", name: "Compiled reads", description: "", owner: { id: "admin", name: "admin" }, assignedUserIds: [], status: "PENDING", trigger: { type: "manual" }, steps: 2,
    successRate: 0, lastRunAt: null, publishedVersion: legacyPublication ? 1 : 0, draftVersion: 1, tags: [], domainTags: [], canRun: false, createdAt: date, updatedAt: date, yaml, archived: false };
  await s.repository.mutate(state => { state.workflows.compiled = workflow; state.versions.compiled = legacyPublication ? [{ id: "historical", version: 1, artifactState: "PUBLISHED", yaml }] : []; });
  const app = await buildApp(s.services); sessions.push(app);
  const headers = { authorization: `Bearer ${jwt.sign({}, s.services.config.jwtSecret, { subject: "admin", expiresIn: 3600 })}` };
  const publish = () => app.inject({ method: "POST", url: "/api/workflows/compiled/publish", headers, payload: {} });
  const run = (payload = {}) => app.inject({ method: "POST", url: "/api/workflows/compiled/run", headers, payload });
  const readiness = () => app.inject({ method: "GET", url: "/api/workflows/compiled/readiness", headers });
  return { yaml, app, publish, run, readiness, headers };
}

const collectionFlow = () => ({ schemaVersion: "read-control-flow/v3", root: { kind: "sequence", nodes: [
  { kind: "foreach", id: "each", maxItems: 3, items: { schema: { type: "array", items: { type: "string" } }, value: { kind: "ref", source: "workflowInput", path: ["rows"] } },
    body: { kind: "sequence", nodes: [{ kind: "action", nodeId: "one" }] }, collect: { schema: { type: "string" }, value: { kind: "ref", source: "nodeOutput", nodeId: "one", path: ["content", "0", "text"] } } },
  { kind: "action", nodeId: "two" },
  { kind: "return", id: "answer", output: { schema: { type: "array", items: { type: "string" } }, value: { kind: "ref", source: "nodeOutput", nodeId: "each", path: ["value"] } } },
] } });

test("business-error mapping requires exact fresh review and persists its immutable definition without migrating old pins", async () => {
  const storage = new Persistence(), s = await setup(storage); await s.review();
  const before = await s.repository.snapshot(), oldPin = captureReadAdmissionPin(before, s.registries, s.tool(), s.session.admissionBinding!);
  s.changeTool({ read_error_contract: { profile: "erpbridge-read-error/v1", remote_type: "not_found", business_error: "ERP_RESOURCE_NOT_FOUND" } });
  expect(() => captureReadAdmissionPin(before, s.registries, s.tool(), s.session.admissionBinding!, oldPin)).toThrow();
  const review = await s.review({ decisionKey: "review-business-error-0002", note: "Reviewed exact ERP 404 meaning; not a proof of absent employee or permission to continue" });
  const reopened = await Repository.open(storage); sessions.push(reopened);
  const state = await reopened.snapshot(), pin = captureReadAdmissionPin(state, s.registries, s.tool(), s.session.admissionBinding!);
  expect(pin.admissionVersion).toBe(oldPin.admissionVersion + 2); // discovery blocks drift, then fresh review admits
  expect(pin.revisionId).not.toBe(oldPin.revisionId); expect(pin.contractHash).not.toBe(oldPin.contractHash);
  expect(state.capabilityRevisions[oldPin.revisionId]!.definition).not.toHaveProperty("read_error_contract");
  expect(review.revision.definition.read_error_contract).toEqual(s.tool().read_error_contract);
  expect(() => captureReadAdmissionPin(state, s.registries, s.tool(), s.session.admissionBinding!, oldPin)).toThrow();
  expect(s.sdk.callTool).not.toHaveBeenCalled();
});

test.each(["connectionId", "capabilityId", "revisionId", "admissionVersion", "contractHash"] as const)("classification evidence rejects a changed %s pin", async field => {
  const s = await setup(); await s.review();
  const state = await s.repository.snapshot(), pin = captureReadAdmissionPin(state, s.registries, s.tool(), s.session.admissionBinding!);
  expect(reviewedCapabilityDataClass(state, pin)).toBe("internal");
  const changed = { ...pin, [field]: field === "admissionVersion" ? 999 : field === "contractHash" ? `sha256:${"f".repeat(64)}` : "different" };
  expect(() => reviewedCapabilityDataClass(state, changed)).toThrow(); expect(s.sdk.callTool).not.toHaveBeenCalled();
});

test.each(["DISABLED", "BLOCKED", "malformed-policy", "changed-definition"])("classification evidence fails closed for %s authoritative review", async scenario => {
  const s = await setup(); await s.review();
  const state = await s.repository.snapshot(), pin = captureReadAdmissionPin(state, s.registries, s.tool(), s.session.admissionBinding!);
  if (scenario === "DISABLED" || scenario === "BLOCKED") state.capabilityAdmissions[pin.capabilityId]!.state = scenario;
  else if (scenario === "malformed-policy") (state.capabilityRevisions[pin.revisionId]!.policy as Record<string, unknown>).dataClass = "unknown";
  else (state.capabilityRevisions[pin.revisionId]!.definition as Record<string, unknown>).name = "different";
  expect(() => reviewedCapabilityDataClass(state, pin)).toThrow(); expect(s.sdk.callTool).not.toHaveBeenCalled();
});

test.each(modelDataClasses)("explicit %s read review preserves exact sensitivity evidence without granting model egress", async dataClass => {
  const s = await setup(), before = await s.repository.snapshot(), result = await s.review({ dataClass });
  expect(result.revision.policy).toMatchObject({ effectClass: "read", riskClass: "low", dataClass, retryPolicy: "never" });
  const state = await s.repository.snapshot(), pin = captureReadAdmissionPin(state, s.registries, s.tool(), s.session.admissionBinding!);
  expect(reviewedCapabilityDataClass(state, pin)).toBe(dataClass);
  const catalog = await capabilityAdmissionCatalog(s.repository, 0, 10, { registries: s.registries, session: s.session });
  expect(catalog.capabilities[0]!.revision!.policy.dataClass).toBe(dataClass);
  expect(state.providers).toEqual(before.providers); expect(s.sdk.callTool).not.toHaveBeenCalled();
});

test.each(["confidential", "restricted"])("%s read review survives a persistence reopen with unchanged pinned classification", async dataClass => {
  const storage = new Persistence(), s = await setup(storage); await s.review({ dataClass });
  const state = await s.repository.snapshot(), pin = captureReadAdmissionPin(state, s.registries, s.tool(), s.session.admissionBinding!);
  const reopened = await Repository.open(storage), restored = await reopened.snapshot();
  expect(reviewedCapabilityDataClass(restored, pin)).toBe(dataClass);
  expect(captureReadAdmissionPin(restored, s.registries, s.tool(), s.session.admissionBinding!, pin)).toEqual(pin);
  expect(s.sdk.callTool).not.toHaveBeenCalled();
});

test.each([undefined, null, "unknown", "PUBLIC", " internal", 1])("unsupported read classification %s is not defaulted or admitted", async dataClass => {
  const s = await setup(); await expect(s.review({ dataClass })).rejects.toMatchObject({ status: 400 });
  expect((await s.repository.snapshot()).capabilityAdmissions).toEqual({}); expect(s.sdk.callTool).not.toHaveBeenCalled();
});

test.each([false, true])("normal reviewed collection publication/readiness/execution preserves exact per-item answers, async=%s", async queued => {
  const s = await setup(); await s.review(); const w = await workflowHarness(s, false, collectionFlow(), "{{each.item}}");
  const published = await w.publish(); expect(published.statusCode, published.body).toBe(200);
  expect(published.json().data).toMatchObject({ executionReadiness: "COMPILED_READ", compiledRead: { schemaVersion: "workflow-read-ir/v4", admissionMode: "reviewed", origin: "PUBLICATION" } });
  expect((await w.readiness()).json().data).toMatchObject({ can_attempt_run: true, executionProfile: "collection-read-v1", compilation: { state: "CURRENT" } });
  s.sdk.callTool.mockImplementation(async (_name, args) => ({ content: [{ type: "text", text: String(args?.value).toUpperCase() }] }));
  const payload = { input: { rows: ["a", "b"], private_token: "not-public-collection-input" }, ...(queued ? { mode: "async-read", idempotencyKey: "reviewed-collection-job-0001" } : {}) };
  const response = await w.run(payload); expect(response.statusCode, response.body).toBe(queued ? 202 : 200); const id = response.json().data.id;
  await vi.waitFor(async () => { expect((await s.repository.snapshot()).executions[id]!.status).toBe("DONE"); });
  const state = await s.repository.snapshot(), item = state.executions[id]!;
  expect(item).toMatchObject({ finalOutput: ["A", "B"], workflowSnapshot: { executionProfile: "collection-read-v1", compilation: published.json().data.compiledRead }, tokens: { total: 0 } });
  expect(Object.keys(item.stepOutputs!)).toEqual(["each/0/one", "each/1/one", "two"]); expect(item.iterationProgress?.receipts["action:each/0/one"]?.status).toBe("DONE");
  expect(s.sdk.callTool.mock.calls.map(call => call[1]?.value)).toEqual(["a", "b", "second"]);
  expect(s.sdk.callTool.mock.calls.every(call => call[0] === exactBridgeName(s.tool()) && call[2]?.["toolplane.resourceDigest"] === "a".repeat(64))).toBe(true);
  expect(state.readContinuations[id]).toBeUndefined(); expect(JSON.stringify(item)).not.toContain("not-public-collection-input"); expect(response.body).not.toMatch(/bindingKey|inputCiphertext|ciphertext/);
  if (queued) { await vi.waitFor(async () => expect((await s.repository.snapshot()).readJobs[id]!.state).toBe("FINISHED")); expect((await w.run(payload)).json().data.id).toBe(id); expect(s.sdk.callTool).toHaveBeenCalledTimes(3); }
});

test.each([{ rows: [] }, { rows: ["a", "b", "c", "d"] }])("normal collection empty/oversized input %j has truthful bounded outcomes", async ({ rows }) => {
  const s = await setup(); await s.review(); const w = await workflowHarness(s, false, collectionFlow(), "{{each.item}}"); expect((await w.publish()).statusCode).toBe(200);
  const response = await w.run({ input: { rows } }); expect(response.statusCode, response.body).toBe(rows.length ? 422 : 200);
  expect(s.sdk.callTool).toHaveBeenCalledTimes(rows.length ? 0 : 1);
  const item = Object.values((await s.repository.snapshot()).executions)[0]!; expect(item.status).toBe(rows.length ? "FAILED" : "DONE");
  if (!rows.length) expect(item.finalOutput).toEqual([]);
});

test.each([false, true])("normal nested collection execution keeps distinct invocation identities and nested answers, async=%s", async queued => {
  const s = await setup(); await s.review(); const flow = collectionFlow(), outer = flow.root.nodes[0] as any;
  const strings = { type: "array", items: { type: "string" } }, nested = { type: "array", items: strings };
  const ref = (nodeId: string, path: string[]) => ({ kind: "ref", source: "nodeOutput", nodeId, path });
  outer.body = { kind: "sequence", nodes: [{ kind: "foreach", id: "inner", maxItems: 2,
    items: { schema: strings, value: { kind: "ref", source: "workflowInput", path: ["innerRows"] } },
    body: { kind: "sequence", nodes: [{ kind: "action", nodeId: "one" }] }, collect: { schema: { type: "string" }, value: ref("one", ["content", "0", "text"]) } }] };
  outer.collect = { schema: strings, value: ref("inner", ["value"]) };
  (flow.root.nodes[2] as any).output.schema = nested;
  const w = await workflowHarness(s, false, flow, "{{inner.item}}"); const publication = await w.publish(); expect(publication.statusCode, publication.body).toBe(200);
  s.sdk.callTool.mockImplementation(async (_name, args) => ({ content: [{ type: "text", text: String(args?.value).toUpperCase() }] }));
  const response = await w.run({ input: { rows: ["outer-a", "outer-b"], innerRows: ["x", "y"] }, ...(queued ? { mode: "async-read", idempotencyKey: "nested-collection-0001" } : {}) });
  expect(response.statusCode, response.body).toBe(queued ? 202 : 200); const id = response.json().data.id;
  await vi.waitFor(async () => expect((await s.repository.snapshot()).executions[id]!.status).toBe("DONE"));
  const item = (await s.repository.snapshot()).executions[id]!;
  expect(item.finalOutput).toEqual([["X", "Y"], ["X", "Y"]]);
  expect(Object.keys(item.stepOutputs!)).toEqual(["each/0/inner/0/one", "each/0/inner/1/one", "each/1/inner/0/one", "each/1/inner/1/one", "two"]);
  expect(s.sdk.callTool.mock.calls.map(call => call[1]?.value)).toEqual(["x", "y", "x", "y", "second"]);
  expect(item.iterationProgress?.receipts["collection:each"]?.status).toBe("DONE");
});

test("historical collections require reviewed re-publication and unsupported aggregate durable publication stays denied", async () => {
  const s = await setup(); await s.review(); const w = await workflowHarness(s, true, collectionFlow(), "{{each.item}}");
  expect((await w.run({ input: { rows: ["a"] } })).statusCode).toBe(409); expect(s.sdk.callTool).not.toHaveBeenCalled();
  expect((await w.publish()).json().data).toMatchObject({ version: 2, compiledRead: { schemaVersion: "workflow-read-ir/v4" } });
  const durable = await setup(new Persistence()); await durable.review(); const design = await workflowHarness(durable, false, collectionFlow(), "{{each.item}}");
  const publication = await design.publish(); expect(publication.statusCode, publication.body).toBe(422); expect(publication.json().meta.code).toBe("UNSUPPORTED_PUBLICATION_PROFILE");
  expect((await durable.repository.snapshot()).workflows.compiled!.publishedVersion).toBe(0);
  const deniedRun = await design.run({ mode: "async-read", idempotencyKey: "aggregate-collection-fixture", input: { rows: ["a"] } });
  expect(deniedRun.statusCode).toBe(409); expect(deniedRun.json().meta.code).toBe("WORKFLOW_NOT_PUBLISHED"); expect(durable.sdk.callTool).not.toHaveBeenCalled();
});

test.each([false, true])("collection review changes after intent acknowledgement deny actual SDK entry, async=%s", async queued => {
  const s = await setup(); await s.review(); const w = await workflowHarness(s, false, collectionFlow(), "{{each.item}}"); await w.publish();
  const original = s.repository.mutateExecution.bind(s.repository); let changed = false;
  vi.spyOn(s.repository, "mutateExecution").mockImplementation(async (id, mutation) => {
    const result = await original(id, mutation);
    if (!changed && await s.repository.read(state => state.executions[id]?.readProgress?.attempts["each/0/one"]?.status === "DISPATCH_INTENT")) {
      changed = true; await s.repository.mutate(state => { Object.values(state.capabilityAdmissions).forEach(value => { value.state = "DISABLED"; }); });
    }
    return result;
  });
  const response = await w.run({ input: { rows: ["a"] }, ...(queued ? { mode: "async-read", idempotencyKey: "collection-final-entry-0001" } : {}) }); expect(response.statusCode, response.body).toBe(queued ? 202 : 503);
  const id = queued ? response.json().data.id : response.json().meta.executionId;
  await vi.waitFor(async () => expect((await s.repository.snapshot()).executions[id]!.status).toBe("RECOVERY_REQUIRED"));
  expect(changed).toBe(true); expect(s.sdk.callTool).not.toHaveBeenCalled(); expect((await s.repository.snapshot()).executions[id]!.stepOutputs).toEqual({});
});

test.each(["publication", "actor", "archive", "lease", "storage"])("normal queued collection denies %s changes after acknowledged intent", async change => {
  const persistence = change === "storage" ? new RecordPersistence() : null, s = await setup(persistence);
  await s.review(); const w = await workflowHarness(s, false, collectionFlow(), "{{each.item}}"); await w.publish();
  const original = s.repository.mutateExecution.bind(s.repository); let changed = false;
  vi.spyOn(s.repository, "mutateExecution").mockImplementation(async (id, mutation) => {
    const result = await original(id, mutation);
    if (!changed && await s.repository.read(state => state.executions[id]?.readProgress?.attempts["each/0/one"]?.status === "DISPATCH_INTENT")) {
      changed = true;
      if (persistence) {
        persistence.loseAck = true;
        await expect(s.repository.mutate(state => { state.users.admin!.status = "Disabled"; })).rejects.toThrow("acknowledgement");
      } else await s.repository.mutate(state => {
        if (change === "publication") state.versions.compiled = [];
        if (change === "actor") state.users.admin!.status = "Disabled";
        if (change === "archive") state.workflows.compiled!.archived = true;
        if (change === "lease") state.readJobs[id]!.lease!.expiresAt = new Date(Date.now() + 300_000).toISOString();
      });
    }
    return result;
  });
  const response = await w.run({ mode: "async-read", idempotencyKey: "collection-boundary-fault-0001", input: { rows: ["a", "b"] } });
  expect(response.statusCode, response.body).toBe(202); const id = response.json().data.id;
  await vi.waitFor(async () => expect((await s.repository.snapshot()).executions[id]!.status).toBe("RECOVERY_REQUIRED"));
  const state = await s.repository.snapshot(); expect(changed).toBe(true); expect(s.sdk.callTool).not.toHaveBeenCalled();
  expect(state.executions[id]!.stepOutputs).toEqual({}); expect(state.executions[id]!.valueOutputs?.each).toBeUndefined();
  expect(state.executions[id]!.readProgress?.attempts["each/0/one"]?.status).toBe("UNKNOWN");
  expect(state.executionEvents[id]!.some(event => event.type === "iteration.action.completed")).toBe(false);
});

test.each([false, true])("normal collection cancellation during policy prevents dispatch, async=%s", async queued => {
  const s = await setup(); await s.review(); const w = await workflowHarness(s, false, collectionFlow(), "{{each.item}}"); await w.publish();
  const entered = barrier(), unblock = barrier();
  const gate = { validateAndIssueToken: async (action: string, yaml: string, actor: { role: string }) => {
    if (action === "ReadToolBroker") { entered.release(); await unblock.promise; }
    return s.validator.validateAndIssueToken(action, yaml, actor.role);
  } };
  const services = s.services as typeof s.services & { validationGate?: typeof gate }; services.validationGate = gate;
  const pending = w.run({ input: { rows: ["a", "b"] }, ...(queued ? { mode: "async-read", idempotencyKey: "collection-policy-cancel-0001" } : {}) });
  await entered.promise; const id = Object.keys((await s.repository.snapshot()).executions)[0]!;
  try {
    const cancelled = await w.app.inject({ method: "POST", url: `/api/executions/${id}/cancel`, headers: w.headers, payload: {} }); expect(cancelled.statusCode, cancelled.body).toBe(202);
  } finally { unblock.release(); }
  const response = await pending; expect(response.statusCode, response.body).toBe(queued ? 202 : 200);
  await vi.waitFor(async () => expect((await s.repository.snapshot()).executions[id]!.status).toBe("CANCELLED"));
  const item = (await s.repository.snapshot()).executions[id]!; expect(s.sdk.callTool).not.toHaveBeenCalled();
  expect(item.readProgress?.attempts["each/0/one"]?.dispatchIntentAt).toBeUndefined(); expect(item.valueOutputs?.each).toBeUndefined();
});

test.each([false, true])("normal collection saves an already confirmed answer after cancellation without starting the next item, async=%s", async queued => {
  const s = await setup(); await s.review(); const w = await workflowHarness(s, false, collectionFlow(), "{{each.item}}"); await w.publish();
  s.sdk.callTool.mockImplementationOnce(async () => {
    const id = Object.keys((await s.repository.snapshot()).executions)[0]!;
    const cancel = await w.app.inject({ method: "POST", url: `/api/executions/${id}/cancel`, headers: w.headers, payload: {} }); expect(cancel.statusCode, cancel.body).toBe(202);
    return { content: [{ type: "text", text: "Confirmed before the next boundary" }] };
  });
  const response = await w.run({ input: { rows: ["a", "b"] }, ...(queued ? { mode: "async-read", idempotencyKey: "collection-answer-cancel-0001" } : {}) });
  expect(response.statusCode, response.body).toBe(queued ? 202 : 200); const id = response.json().data.id;
  await vi.waitFor(async () => expect((await s.repository.snapshot()).executions[id]!.status).toBe("CANCELLED"));
  const item = (await s.repository.snapshot()).executions[id]!; expect(s.sdk.callTool).toHaveBeenCalledOnce();
  expect(item.stepOutputs?.["each/0/one"]).toMatchObject({ content: [{ text: "Confirmed before the next boundary" }] });
  expect(item.valueOutputs?.each).toBeUndefined(); expect(item.finalOutput).toEqual(item.stepOutputs?.["each/0/one"]); expect(item.stepOutputs?.["each/1/one"]).toBeUndefined();
});

test("normal queued collection lease expiry during policy stops before SDK entry", async () => {
  const s = await setup(); s.services.config.readWorkerLeaseMs = 5000; await s.review();
  const w = await workflowHarness(s, false, collectionFlow(), "{{each.item}}"); await w.publish(); const entered = barrier(), unblock = barrier();
  const validate = s.validator.validateAndIssueToken.bind(s.validator);
  vi.spyOn(s.validator, "validateAndIssueToken").mockImplementation(async (...args) => {
    if (args[0] === "ReadToolBroker") { entered.release(); await unblock.promise; }
    return validate(...args);
  });
  const response = await w.run({ mode: "async-read", idempotencyKey: "collection-expired-worker-0001", input: { rows: ["a"] } });
  expect(response.statusCode, response.body).toBe(202); const id = response.json().data.id; await entered.promise;
  const timestamp = Date.now(), clock = vi.spyOn(Date, "now").mockReturnValue(timestamp + 5001);
  try {
    unblock.release(); await vi.waitFor(async () => expect((await s.repository.snapshot()).executions[id]!.status).toBe("RECOVERY_REQUIRED"));
    expect(s.sdk.callTool).not.toHaveBeenCalled(); expect((await s.repository.snapshot()).executions[id]!.readProgress?.attempts["each/0/one"]?.dispatchIntentAt).toBeUndefined();
  } finally { clock.mockRestore(); unblock.release(); }
});

test.each([false, true])("normal queued collection lost checkpoint acknowledgement never replays, committed=%s", async committedLoss => {
  for (const phase of ["DISPATCH_INTENT", "DONE"] as const) {
    const persistence = new RecordPersistence(), s = await setup(persistence); persistence.committedLoss = committedLoss;
    await s.review(); const w = await workflowHarness(s, false, collectionFlow(), "{{each.item}}"); await w.publish();
    persistence.failWhen = state => Object.values(state.executions).some(item => item.readProgress?.attempts["each/0/one"]?.status === phase);
    const payload = { mode: "async-read", idempotencyKey: `collection-ack-${phase}-0001`, input: { rows: ["a", "b"] } };
    const response = await w.run(payload); expect(response.statusCode, response.body).toBe(202); const id = response.json().data.id;
    await vi.waitFor(async () => expect((await s.repository.snapshot()).executions[id]!.status).toBe("RECOVERY_REQUIRED"));
    const item = (await s.repository.snapshot()).executions[id]!; expect(s.sdk.callTool).toHaveBeenCalledTimes(phase === "DISPATCH_INTENT" ? 0 : 1);
    expect(item.valueOutputs?.each).toBeUndefined();
    if (committedLoss && phase === "DONE") expect(item.finalOutput).toEqual(item.stepOutputs?.["each/0/one"]);
    else expect(item.finalOutput).toBeUndefined();
    const duplicate = await w.run(payload); expect(duplicate.statusCode, duplicate.body).toBe(202); expect(duplicate.json().data.id).toBe(id);
    await readJobQueue(s.services).stop(); await readJobQueue(s.services).start(); expect(s.sdk.callTool).toHaveBeenCalledTimes(phase === "DISPATCH_INTENT" ? 0 : 1);
  }
});

test("normal collection queue replacement preserves genuine unclaimed input and iteration keys", async () => {
  const s = await setup(); await s.review(); const w = await workflowHarness(s, false, collectionFlow(), "{{each.item}}"); await w.publish();
  const first = readJobQueue(s.services), kick = vi.spyOn(first, "kick").mockImplementation(() => {});
  const response = await w.run({ mode: "async-read", idempotencyKey: "collection-unclaimed-restart-0001", input: { rows: ["a"] } });
  expect(response.statusCode, response.body).toBe(202); const id = response.json().data.id;
  await first.stop(); kick.mockRestore(); await readJobQueue(s.services).start();
  await vi.waitFor(async () => expect((await s.repository.snapshot()).executions[id]!.status).toBe("DONE")); expect(s.sdk.callTool).toHaveBeenCalledTimes(2);
});

test("normal collection shutdown fences a held SDK result and restart does not replay it", async () => {
  const s = await setup(); await s.review(); const w = await workflowHarness(s, false, collectionFlow(), "{{each.item}}"); await w.publish();
  const entered = barrier(), unblock = barrier(); s.sdk.callTool.mockImplementationOnce(async () => { entered.release(); await unblock.promise; return { content: [{ type: "text", text: "Late old worker answer" }] }; });
  const response = await w.run({ mode: "async-read", idempotencyKey: "collection-shutdown-0001", input: { rows: ["a", "b"] } });
  expect(response.statusCode, response.body).toBe(202); const id = response.json().data.id; await entered.promise;
  try { await readJobQueue(s.services).stop(); } finally { unblock.release(); }
  await vi.waitFor(async () => expect((await s.repository.snapshot()).executions[id]!.status).toBe("RECOVERY_REQUIRED"));
  await readJobQueue(s.services).start(); await new Promise(resolve => setImmediate(resolve));
  const item = (await s.repository.snapshot()).executions[id]!; expect(s.sdk.callTool).toHaveBeenCalledOnce(); expect(item.stepOutputs).toEqual({});
  expect(item.readProgress?.attempts["each/0/one"]?.status).toBe("UNKNOWN"); expect(item.finalOutput).toBeUndefined();
});

test.each([true, false])("modern compiled conditional publication with enabled=%s preserves exact review pins and dispatches only its selected branch", async enabled => {
  const s = await setup(); await s.review();
  const flow = { schemaVersion: "read-control-flow/v1", root: { kind: "sequence", nodes: [{ kind: "if", id: "gate", predicate: { kind: "ref", source: "workflowInput", path: ["enabled"] }, then: { kind: "sequence", nodes: [{ kind: "action", nodeId: "one" }] }, else: { kind: "sequence", nodes: [{ kind: "action", nodeId: "two" }] } }] } };
  const w = await workflowHarness(s, false, flow), published = await w.publish(); expect(published.statusCode, published.body).toBe(200);
  expect(published.json().data.compiledRead).toMatchObject({ schemaVersion: "workflow-read-ir/v2", origin: "PUBLICATION", admissionMode: "reviewed" });
  const response = await w.run({ input: { enabled } }); expect(response.statusCode, response.body).toBe(200);
  expect(s.sdk.callTool).toHaveBeenCalledOnce(); expect(s.sdk.callTool.mock.calls[0]).toEqual([exactBridgeName(s.tool()), { value: enabled ? "first" : "second" }, { "toolplane.resourceDigest": "a".repeat(64) }]);
  expect(response.json().data.workflowSnapshot.compilation).toEqual(published.json().data.compiledRead);
  expect(response.json().data.readProgress.attempts[enabled ? "two" : "one"].status).toBe("SKIPPED");
});

test.each([false, true])("reviewed typed merge/return publication preserves exact MCP digest and immutable compiled receipts, async=%s", async queued => {
  const s = await setup(); await s.review();
  const read = (nodeId: string) => ({ kind: "action", nodeId }), block = (...nodes: unknown[]) => ({ kind: "sequence", nodes });
  const ref = (nodeId: string) => ({ kind: "ref", source: "nodeOutput", nodeId, path: ["content", "0", "text"] });
  const flow = { schemaVersion: "read-control-flow/v2", root: block({ kind: "if", id: "gate", predicate: { kind: "literal", value: false }, then: block(read("one")), else: block(read("two")), merge: { schema: { type: "string" }, then: ref("one"), else: ref("two") } }, { kind: "return", id: "answer", output: { schema: { type: "string" }, value: { kind: "ref", source: "nodeOutput", nodeId: "gate", path: ["value"] } } }) };
  const w = await workflowHarness(s, false, flow), published = await w.publish(); expect(published.statusCode, published.body).toBe(200);
  expect(published.json().data.compiledRead).toMatchObject({ schemaVersion: "workflow-read-ir/v3", origin: "PUBLICATION", admissionMode: "reviewed" });
  expect((await w.readiness()).json().data.executionProfile).toBe("structured-read-v1");
  const response = await w.run(queued ? { mode: "async-read", idempotencyKey: "typed_review_job_0001" } : {}); expect(response.statusCode, response.body).toBe(queued ? 202 : 200);
  const id = response.json().data.id; await vi.waitFor(async () => expect((await s.repository.snapshot()).executions[id]!.status).toBe("DONE"));
  const item = (await s.repository.snapshot()).executions[id]!;
  expect(item).toMatchObject({ finalOutput: "Confirmed fixture", valueOutputs: { gate: { value: "Confirmed fixture" }, answer: { value: "Confirmed fixture" } } }); expect(item.workflowSnapshot!.compilation).toEqual(published.json().data.compiledRead);
  expect(s.sdk.callTool.mock.calls).toEqual([[exactBridgeName(s.tool()), { value: "second" }, { "toolplane.resourceDigest": "a".repeat(64) }]]);
  await s.review({ decisionKey: "review-typed-replacement-0002" }); expect((await w.run()).statusCode).toBe(409); expect(s.sdk.callTool).toHaveBeenCalledOnce();
});

test("modern publication stores exact compiled/review pins; sync run executes the artifact and repeated publication is immutable/idempotent", async () => {
  const s = await setup(); await s.review(); const w = await workflowHarness(s);
  const published = await w.publish(); expect(published.statusCode, published.body).toBe(200); const receipt = published.json().data.compiledRead;
  expect(receipt).toMatchObject({ schemaVersion: "workflow-read-ir/v1", compilerVersion: "read-compiler/v1", origin: "PUBLICATION", admissionMode: "reviewed" });
  expect(receipt.ir).toBeUndefined(); expect(published.body).not.toMatch(/connectionBinding|private-credential/); expect(s.sdk.callTool).not.toHaveBeenCalled();
  const state = await s.repository.snapshot(), stored = state.versions.compiled![0]!.compiledRead as any;
  expect(stored.plan.ir.root.nodes.every((node: any) => node.capability.admission.revisionId === Object.values(state.capabilityRevisions)[0]!.id)).toBe(true);
  const repeated = await w.publish(); expect(repeated.json().data.id).toBe(published.json().data.id); expect((await s.repository.snapshot()).versions.compiled).toHaveLength(1);
  const ready = await w.readiness(); expect(ready.json().data).toMatchObject({ can_attempt_run: true, compilation: { state: "CURRENT", receipt } });
  const run = await w.run(); expect(run.statusCode, run.body).toBe(200); expect(run.json().data.workflowSnapshot.compilation).toEqual(receipt); expect(s.sdk.callTool).toHaveBeenCalledTimes(2);
});

test("modern historical YAML-only publication is not silently compiled/granted on Run or readiness", async () => {
  const s = await setup(); await s.review(); const w = await workflowHarness(s, true);
  expect((await w.readiness()).json().data).toMatchObject({ can_attempt_run: false, compilation: { state: "BLOCKED" } });
  const run = await w.run(); expect(run.statusCode, run.body).toBe(409); expect(run.json().meta.code).toBe("PUBLISHED_COMPILATION_REQUIRED"); expect(s.sdk.callTool).not.toHaveBeenCalled();
  const publication = await w.publish(); expect(publication.statusCode, publication.body).toBe(200); expect(publication.json().data.version).toBe(2);
  const versions = (await s.repository.snapshot()).versions.compiled!; expect(versions).toHaveLength(2); expect(versions[0]!.compiledRead).toBeUndefined();
});

test("a new same-contract review invalidates an old publication and explicit re-publication creates a new immutable version", async () => {
  const s = await setup(); await s.review(); const w = await workflowHarness(s); const first = await w.publish();
  const before = structuredClone((await s.repository.snapshot()).versions.compiled![0]);
  await s.review({ decisionKey: "review-fixture-key-0002" });
  expect((await w.readiness()).json().data.can_attempt_run).toBe(false); expect((await w.run()).statusCode).toBe(409); expect(s.sdk.callTool).not.toHaveBeenCalled();
  const next = await w.publish(); expect(next.statusCode, next.body).toBe(200); expect(next.json().data.version).toBe(2); expect(next.json().data.compiledRead.semanticHash).not.toBe(first.json().data.compiledRead.semanticHash);
  expect((await s.repository.snapshot()).versions.compiled![0]).toEqual(before); expect((await w.run()).statusCode).toBe(200); expect(s.sdk.callTool).toHaveBeenCalledTimes(2);
});

test("changed admission between successful read nodes is rejected by the final SDK pin check, not rebound to the new grant", async () => {
  const s = await setup(); await s.review(); const w = await workflowHarness(s); expect((await w.publish()).statusCode).toBe(200);
  s.sdk.callTool.mockImplementationOnce(async () => { await s.review({ decisionKey: "review-fixture-key-0002" }); return { content: [{ type: "text", text: "First confirmed" }] }; });
  const run = await w.run(); expect(run.statusCode, run.body).toBe(422); expect(s.sdk.callTool).toHaveBeenCalledOnce();
  const execution = Object.values((await s.repository.snapshot()).executions)[0]!; expect(execution).toMatchObject({ status: "FAILED", failure: { failedStepId: "two" } }); expect(execution.stepOutputs?.one).toBeDefined(); expect(execution.stepOutputs?.two).toBeUndefined();
});

test.each(["plan", "receipt"])("tampered saved compilation %s cannot dispatch and is not repaired by Run", async what => {
  const s = await setup(); await s.review(); const w = await workflowHarness(s); await w.publish();
  await s.repository.mutate(state => { const compilation = state.versions.compiled![0]!.compiledRead as any; if (what === "plan") compilation.plan.ir.root.nodes[0].inputs.fields.value.value = "forged"; else compilation.receipt.compilerVersion = "unknown-compiler"; });
  const run = await w.run(); expect(run.statusCode, run.body).toBe(409); expect(s.sdk.callTool).not.toHaveBeenCalled(); expect(Object.keys((await s.repository.snapshot()).executions)).toHaveLength(0);
});

test("queued run retains its compiled publication and stops before dispatch if its admission was replaced", async () => {
  const s = await setup(); await s.review(); const w = await workflowHarness(s); await w.publish();
  const queue = readJobQueue(s.services), kick = vi.spyOn(queue, "kick").mockImplementation(() => {});
  const admitted = await w.run({ mode: "async-read", idempotencyKey: "compiled_queue_request_0001" }); expect(admitted.statusCode, admitted.body).toBe(202); const id = admitted.json().data.id;
  await s.review({ decisionKey: "review-fixture-key-0002" }); expect((await w.publish()).json().data.version).toBe(2);
  kick.mockRestore(); queue.kick(); await vi.waitFor(async () => expect((await s.repository.snapshot()).executions[id]?.status).toBe("FAILED"));
  expect((await s.repository.snapshot()).executions[id]?.failure).toMatchObject({ failureCategory: "READ_JOB_PREPARATION_FAILED", toolWasCalled: false, preparationStage: "PUBLICATION" }); expect(s.sdk.callTool).not.toHaveBeenCalled();
});

test("modern discovery is not permission; explicit saved review enables one exact governed read and warm discovery never grants from cache", async () => {
  const s = await setup(); expect(await discoverTools(s.session, s.registries)).toEqual([]);
  const observation = (await s.observe()).observations[0]!;
  expect(observation.state).toBe("REVIEW_REQUIRED"); expect(Object.keys((await s.repository.snapshot()).capabilityAdmissions)).toHaveLength(0);
  await expect(dispatchReadTool(s.services, "admin", s.tool().name, { value: "fixture" })).rejects.toThrow(); expect(s.sdk.callTool).not.toHaveBeenCalled();
  const reviewed = await reviewCapability({ ...s.services, session: s.session, user: s.admin, capabilityId: observation.capabilityId, body: s.body(observation) });
  expect(reviewed.admission).toMatchObject({ state: "AVAILABLE", version: 1 }); expect(reviewed.revision.reviewedBy.id).toBe("admin");
  const calls = s.sdk.listTools.mock.calls.length; expect(await discoverTools(s.session, s.registries)).toEqual([s.tool()]); expect(s.sdk.listTools).toHaveBeenCalledTimes(calls);
  const result = await dispatchReadTool(s.services, "admin", s.tool().name, { value: "fixture" }); expect(result.content).toEqual([{ type: "text", text: "Confirmed fixture" }]);
  expect(s.sdk.callTool).toHaveBeenCalledOnce(); expect(s.sdk.callTool.mock.calls[0]).toEqual([exactBridgeName(s.tool()), { value: "fixture" }, { "toolplane.resourceDigest": "a".repeat(64) }]);
});

test("disable is authoritative immediately, review retries never re-enable, and duplicate decisions do not create new revisions", async () => {
  const s = await setup(), reviewed = await s.review(), observation = (await capabilityAdmissionCatalog(s.repository)).observations[0]!;
  const repeated = await reviewCapability({ ...s.services, session: s.session, user: s.admin, capabilityId: reviewed.admission.capabilityId, body: s.body(observation) });
  expect(repeated.duplicate).toBe(true); expect(repeated.revision.id).toBe(reviewed.revision.id);
  const disabled = await disableCapability({ repository: s.repository, user: s.admin, capabilityId: reviewed.admission.capabilityId, body: { revisionId: reviewed.revision.id, baseVersion: 1, note: "Revoke fixture" } });
  expect(disabled.state).toBe("DISABLED"); expect(await discoverTools(s.session, s.registries)).toEqual([]);
  await expect(s.session.assertAdmission!(s.tool())).rejects.toThrow(/disabled/);
  const retry = await reviewCapability({ ...s.services, session: s.session, user: s.admin, capabilityId: reviewed.admission.capabilityId, body: s.body(observation) });
  expect(retry.admission.state).toBe("DISABLED"); expect(Object.keys((await s.repository.snapshot()).capabilityRevisions)).toHaveLength(1); expect(s.sdk.callTool).not.toHaveBeenCalled();
});

test("drift refresh blocks an existing admission, records audit, and restored discovery cannot automatically grant again", async () => {
  const s = await setup(); const reviewed = await s.review();
  s.sdk.listTools.mockImplementationOnce(async () => []);
  expect((await s.observe()).blockedCount).toBe(1);
  expect((await capabilityAdmissionCatalog(s.repository)).admissions[0]).toMatchObject({ state: "BLOCKED", reason: "REMOTE_CONTRACT_DRIFT", version: 2 });
  expect((await s.observe()).blockedCount).toBe(0);
  await expect(s.session.assertAdmission!(s.tool())).rejects.toThrow(/blocked/);
  const again = await s.review({ decisionKey: "review-fixture-key-0002" });
  expect(again.admission).toMatchObject({ state: "AVAILABLE", version: 3 }); expect(again.revision.id).not.toBe(reviewed.revision.id);
  expect((await s.repository.snapshot()).auditLogs.some(entry => entry.action === "capability.drift.blocked")).toBe(true);
  expect(s.sdk.callTool).not.toHaveBeenCalled();
});

test("review catalog is bounded and pageable, and unsafe review classes cannot enable production-only test or effect tools", async () => {
  const s = await setup();
  for (let index = 0; index < 12; index++) await s.observe();
  expect((await capabilityAdmissionCatalog(s.repository)).observations).toHaveLength(10);
  expect((await capabilityAdmissionCatalog(s.repository, 10)).observations).toHaveLength(2);
  await expect(capabilityAdmissionCatalog(s.repository, 0, 11)).rejects.toThrow(/catalog page/);
  for (const patch of [{ is_read_only: false }, { name: "system.write_test" }, { risk_level: "" }, { side_effects: ["Updates ERP"] }]) {
    const original = s.tool(); s.changeTool(patch);
    await expect(s.review()).rejects.toThrow(/unsupported effect/); s.changeTool(original);
  }
  expect(Object.keys((await s.repository.snapshot()).capabilityAdmissions)).toHaveLength(0); expect(s.sdk.callTool).not.toHaveBeenCalled();
});

test.each(["roles", "risk", "input", "digest", "description"])("local %s drift invalidates review and cannot dispatch", async field => {
  const s = await setup(); await s.review();
  if (field === "roles") s.changeTool({ allowed_roles: ["Workflow Builder"] });
  if (field === "risk") s.changeTool({ risk_level: "high" });
  if (field === "input") s.changeTool({ input_schema: { type: "object" } });
  if (field === "digest") s.changeTool({ bridge_contract: { ...s.tool().bridge_contract!, resource_digest: "b".repeat(64) } });
  if (field === "description") s.changeTool({ description: "Changed source contract" });
  await expect(s.session.assertAdmission!(s.tool())).rejects.toThrow(/binding changed/); expect(s.sdk.callTool).not.toHaveBeenCalled();
});

test.each(["missing", "remote-drift", "generation", "expired", "reviewer", "effect"])("admission rejects %s without a grant", async scenario => {
  const s = await setup();
  if (scenario === "remote-drift") s.sdk.listTools.mockImplementation(async () => [{ ...s.remote(), _meta: { ...s.remote()._meta, "toolplane.resourceDigest": "b".repeat(64) } }]);
  const observation = (await s.observe()).observations[0]!;
  if (scenario === "generation") s.changed();
  if (scenario === "expired") await s.repository.mutate(state => { state.capabilityObservations[observation.id]!.discoveredAt = "2000-01-01T00:00:00.000Z"; });
  const user = scenario === "reviewer" ? s.builder : s.admin;
  const body = scenario === "missing" ? {} : s.body(observation, scenario === "effect" ? { effectClass: "write" } : {});
  await expect(reviewCapability({ ...s.services, session: s.session, user, capabilityId: observation.capabilityId, body })).rejects.toThrow();
  expect(Object.keys((await s.repository.snapshot()).capabilityAdmissions)).toHaveLength(0); expect(s.sdk.callTool).not.toHaveBeenCalled();
});

test("lost committed review/disable acknowledgement fences dispatch until authoritative recovery, then respects the actual state", async () => {
  const persistence = new Persistence(), s = await setup(persistence), observation = (await s.observe()).observations[0]!;
  persistence.loseAck = true;
  await expect(reviewCapability({ ...s.services, session: s.session, user: s.admin, capabilityId: observation.capabilityId, body: s.body(observation) })).rejects.toThrow(/acknowledgement/);
  await expect(s.session.assertAdmission!(s.tool())).rejects.toThrow(/Authoritative/); await s.repository.recoverPersistenceState();
  const reviewed = await reviewCapability({ ...s.services, session: s.session, user: s.admin, capabilityId: observation.capabilityId, body: s.body(observation) });
  expect(reviewed.duplicate).toBe(true); await s.session.assertAdmission!(s.tool());
  persistence.loseAck = true;
  await expect(disableCapability({ repository: s.repository, user: s.admin, capabilityId: observation.capabilityId, body: { revisionId: reviewed.revision.id, baseVersion: 1, note: "Disable" } })).rejects.toThrow();
  await expect(s.session.assertAdmission!(s.tool())).rejects.toThrow(/Authoritative/); await s.repository.recoverPersistenceState();
  await expect(s.session.assertAdmission!(s.tool())).rejects.toThrow(/disabled/); expect(s.sdk.callTool).not.toHaveBeenCalled();
});

test("modern session without persisted-authorizer wiring and private policy calls cannot bypass admission", async () => {
  const s = await setup(null, true); await s.review();
  await expect(s.session.assertAdmission!(s.tool())).rejects.toThrow(/persisted capability admission/);
  s.changeTool({ mcp_tool_name: "check_policy" });
  await expect(s.session.callToolDirect("check_policy", { value: "fixture" })).rejects.toThrow(/persisted capability admission/); expect(s.sdk.callTool).not.toHaveBeenCalled();
});

test("connection rotation, corrupt review and decision conflicts are fail-closed; catalog hides private binding/decision identities", async () => {
  const s = await setup(), reviewed = await s.review(), catalog = await capabilityAdmissionCatalog(s.repository), observation = catalog.observations[0]!;
  expect(JSON.stringify(catalog)).not.toMatch(/connectionBinding|decisionScope|decisionHash|private-credential/);
  await expect(admissionAuthorizer(s.repository, s.registries)(s.tool(), "b".repeat(64))).rejects.toThrow(/binding changed/);
  await expect(reviewCapability({ ...s.services, session: s.session, user: s.admin, capabilityId: observation.capabilityId, body: s.body(observation, { note: "Different decision" }) })).rejects.toThrow(/different review input/);
  await s.repository.mutate(state => { state.capabilityRevisions[reviewed.revision.id]!.definition = { ...s.tool(), allowed_roles: ["anyone"] }; });
  await expect(s.session.assertAdmission!(s.tool())).rejects.toThrow(/binding changed/); expect(s.sdk.callTool).not.toHaveBeenCalled();
});

test("registry review HTTP routes enforce current administrator authority and do not expose private binding", async () => {
  const s = await setup(), app = await buildApp(s.services); sessions.push(app);
  const headers = (actor = "admin") => ({ authorization: `Bearer ${jwt.sign({}, s.services.config.jwtSecret, { subject: actor, expiresIn: 3600 })}` });
  expect((await app.inject({ method: "POST", url: "/api/registry/capabilities/discovery", headers: headers("builder"), payload: {} })).statusCode).toBe(403);
  const scan = await app.inject({ method: "POST", url: "/api/registry/capabilities/discovery", headers: headers(), payload: {} });
  expect(scan.statusCode, scan.body).toBe(200); expect(scan.body).not.toMatch(/connectionBinding|private-credential/);
  const observation = scan.json().data.observations[0];
  const admitted = await app.inject({ method: "POST", url: `/api/registry/capabilities/${observation.capabilityId}/review`, headers: headers(), payload: s.body(observation) });
  expect(admitted.statusCode, admitted.body).toBe(200); expect(admitted.json().data.admission.state).toBe("AVAILABLE");
  await s.repository.mutate(state => { state.users.admin!.status = "Inactive"; });
  expect((await app.inject({ method: "POST", url: `/api/registry/capabilities/${observation.capabilityId}/disable`, headers: headers(), payload: {} })).statusCode).toBe(403);
  expect(s.sdk.callTool).not.toHaveBeenCalled();
});

test("unreviewed legacy remote transport is not a production fallback; mocks and supported modern profile remain explicit", () => {
  expect(() => requireProductionAdmissionProfile({ mcpMode: "remote", mcpTransport: "bridge-v1" })).toThrow(/no reviewed/);
  expect(() => requireProductionAdmissionProfile({ mcpMode: "mock", mcpTransport: "bridge-v1" })).not.toThrow();
  expect(() => requireProductionAdmissionProfile({ mcpMode: "remote", mcpTransport: "erpbridge-mcp" })).not.toThrow();
});

test("persisted review survives restart while malformed collections require repair instead of being discarded", async () => {
  const persistence = new Persistence(), s = await setup(persistence); await s.review();
  const restored = await Repository.open(persistence); await admissionAuthorizer(restored, s.registries)(s.tool(), s.session.admissionBinding!);
  const corrupted = JSON.parse(Buffer.from(persistence.payload!).toString()); corrupted.capabilityAdmissions = [];
  persistence.payload = Buffer.from(JSON.stringify(corrupted)); await expect(Repository.open(persistence)).rejects.toThrow(/admission recovery requires repair/);
  expect(s.sdk.callTool).not.toHaveBeenCalled();
});

test("unqualified multi-writer storage cannot admit or execute using a process-local view", async () => {
  const persistence = new Persistence(); Object.defineProperty(persistence, "readQueueDurability", { value: undefined });
  const s = await setup(persistence); await expect(s.review()).rejects.toThrow(/single-writer storage/);
  await expect(s.session.assertAdmission!(s.tool())).rejects.toThrow(/single-writer storage/);
  expect((await capabilityAdmissionCatalog(s.repository)).persistence).toBe("unsupported-for-admission"); expect(s.sdk.callTool).not.toHaveBeenCalled();
});

test("joined review view pairs latest unique observation with the actual active revision independently of history paging", async () => {
  const s = await setup(), reviewed = await s.review();
  for (let index = 0; index < 12; index++) await s.observe();
  const view = await capabilityAdmissionCatalog(s.repository, 0, 10, { registries: s.registries, session: s.session });
  expect(view.observations).toHaveLength(10); expect(view.capabilities).toHaveLength(1); expect(view.hasMoreCapabilities).toBe(false);
  expect(view.capabilities[0]).toMatchObject({ effectiveState: "AVAILABLE", reviewEligible: true, admission: reviewed.admission, revision: { id: reviewed.revision.id } });
  expect(view.capabilities[0]!.observation!.id).not.toBe(reviewed.revision.observationId);
  expect(JSON.stringify(view)).not.toMatch(/connectionBinding|decisionScope|decisionHash|private-credential/);
  expect((await capabilityAdmissionCatalog(s.repository, 10, 10, { registries: s.registries, session: s.session })).capabilities).toEqual([]);
});

test("review eligibility and displayed current drift are honest snapshots; a GET never modifies stored authority", async () => {
  const s = await setup(), reviewed = await s.review();
  s.changeTool({ description: "Updated local contract" });
  const view = await capabilityAdmissionCatalog(s.repository, 0, 10, { registries: s.registries, session: s.session });
  expect(view.capabilities[0]).toMatchObject({ effectiveState: "BLOCKED", reviewEligible: false, reviewReason: "LOCAL_CONTRACT_CHANGED", admission: { state: "AVAILABLE" } });
  expect((await s.repository.snapshot()).capabilityAdmissions[reviewed.admission.capabilityId]!.state).toBe("AVAILABLE");
  expect(s.sdk.callTool).not.toHaveBeenCalled();
});

test("closed/missing/unsupported sessions never appear live-qualified and cannot be reviewed from catalog hints", async () => {
  const s = await setup(); await s.review();
  const absent = await capabilityAdmissionCatalog(s.repository, 0, 10, { registries: s.registries });
  expect(absent.connection).toMatchObject({ state: "NO_SESSION", discoveryAvailable: false });
  expect(absent.capabilities[0]).toMatchObject({ effectiveState: "BLOCKED", reviewEligible: false, reviewReason: "CONNECTION_UNAVAILABLE" });
  const unsupported = await capabilityAdmissionCatalog(s.repository, 0, 10, { registries: s.registries, session: { ...s.session, requiresReviewedRevision: false } });
  expect(unsupported.connection.state).toBe("UNSUPPORTED_PROFILE");
  const initialized = await capabilityAdmissionCatalog(s.repository, 0, 10, { registries: s.registries, session: s.session });
  expect(initialized.connection.state).toBe("INITIALIZED_NOT_QUALIFIED");
  await s.session.close();
  expect((await capabilityAdmissionCatalog(s.repository, 0, 10, { registries: s.registries, session: s.session })).connection).toMatchObject({ state: "CLOSED", discoveryAvailable: false });
});

test("catalog rejects fresh review on stale generations or unsupported effect classes without hiding saved history", async () => {
  const s = await setup(); await s.review(); s.changed();
  expect((await capabilityAdmissionCatalog(s.repository, 0, 10, { registries: s.registries, session: s.session })).capabilities[0]).toMatchObject({ reviewEligible: false, reviewReason: "OBSERVATION_STALE" });
  s.changeTool({ is_read_only: false }); await s.observe();
  const view = await capabilityAdmissionCatalog(s.repository, 0, 10, { registries: s.registries, session: s.session });
  expect(view.capabilities[0]).toMatchObject({ effectiveState: "BLOCKED", reviewEligible: false, reviewReason: "UNSUPPORTED_EFFECT_OR_RISK", revision: { policy: { effectClass: "read" } } });
  expect(s.sdk.callTool).not.toHaveBeenCalled();
});
