import jwt from "jsonwebtoken";
import { stringify } from "yaml";
import { afterEach, expect, test, vi } from "vitest";
import { loadConfig } from "../src/config/config.js";
import { buildApp } from "../src/http/app.js";
import { Repository, type PersistenceBackend, type RepositoryState, type Execution } from "../src/repository/store.js";
import { ReadCheckpoints, appendExecutionEvent, reconcileInterruptedExecutions, newReadProgress } from "../src/runner/read-checkpoints.js";
import { ReadIterationCheckpoints, newReadIterationLedger } from "../src/runner/read-iteration-checkpoints.js";
import { compileReadWorkflow, readCompilationReceipt } from "../src/workflows/compiled-read.js";
import { readJobQueue } from "../src/runner/read-jobs.js";
import type { ApplicationServices } from "../src/http/app.js";
import { RegistryService } from "../src/registry/service.js";
import { toolSchema, ruleSchema } from "../src/registry/schemas.js";
import { RegistryValidator } from "../src/validator/registry-validator.js";
import { Executor } from "../src/runner/executor.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { createErpbridgeMcpSession, ErpbridgeMcpToolError } from "../src/tools/erpbridge-mcp-client.js";
import { dispatchReadTool } from "../src/tools/read-tool-broker.js";
import { parseWorkflowYAMLStrict, workflowContentHash } from "../src/parser/workflow.js";
import { inspectReadWorkflow } from "../src/runner/read-workflow.js";
import type { ProviderRuntime } from "../src/providers/runtime.js";
import type { Workflow } from "../src/models/schemas.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });
const yaml = stringify({ name: "Daily read", description: "Read invoice details", trigger: { type: "manual" }, steps: [
  { id: "lookup", action: "finance.read", parameters: { id: "{{input.invoiceId}}" } },
  { id: "details", action: "invoice-read", parameters: { id: "{{lookup.structuredContent.id}}" } },
] });

async function setup(options: { noBridge?: boolean; roleId?: string; provider?: boolean; write?: boolean; persistence?: PersistenceBackend; mcpTimeoutMs?: number; readWorkerConcurrency?: number; readWorkerPerActor?: number; readWorkerLeaseMs?: number } = {}) {
  const config = { ...loadConfig({ APP_ENV: "test", JWT_SECRET: "read-workflow-test-secret-at-least-32-bytes", STORAGE_DRIVER: "memory", MCP_MODE: "mock" }),
    storageEncryptionKey: "x".repeat(32), erpbridgeRoleMap: { "Platform Admin": "admin", Client: "client" },
    readWorkerConcurrency: options.readWorkerConcurrency ?? 2, readWorkerPerActor: options.readWorkerPerActor ?? 1, readWorkerLeaseMs: options.readWorkerLeaseMs ?? 30_000 };
  const repository = await Repository.open(options.persistence ?? null);
  const tool = toolSchema.parse({ tool_id: "READ-1", name: "finance.read", mcp_tool_name: "invoice-read", allowed_roles: ["Platform Admin", "Client"],
    is_read_only: !options.write, input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false } });
  let hash = "sha256:registry-v1";
  const registries = { snapshot: () => ({ tools: [tool], rules: [], versions: { tools: "v1", rules: "v1" } }), hash: () => hash,
    findTool: (name: string) => [tool.name, tool.mcp_tool_name].includes(name) ? tool : undefined, findRule: () => undefined, enabledRules: () => [] } as unknown as RegistryService;
  const validator = new RegistryValidator(registries, repository);
  const callTool = vi.fn(async (_name: string, _args: Record<string, unknown>): Promise<unknown> => ({ content: [], structuredContent: { id: "invoice-actual" } }));
  const listTools = vi.fn(async () => [{ name: tool.mcp_tool_name, inputSchema: tool.input_schema }]);
  const erpbridgeSession = await createErpbridgeMcpSession({ baseURL: "https://bridge.example.test", token: "fixture-only", timeoutMs: options.mcpTimeoutMs ?? 1000, validator,
    sdkClient: { connect: async () => {}, close: async () => {}, listTools, callTool } });
  const queryWithTools = vi.fn(async () => { throw new Error("Published reads must never invoke the model"); });
  const services: ApplicationServices = { config, repository, registries, validator, executor: new Executor(new ToolRegistry(), validator),
    ...(options.noBridge ? {} : { erpbridgeSession }), ...(options.provider ? { providerRuntime: { configured: true, queryWithTools } as unknown as ProviderRuntime } : {}) };
  await repository.mutate((state) => {
    state.users.actor = { id: "actor", name: "Actor", email: "actor@example.test", roleId: options.roleId ?? "role_admin", permissionOverrides: [], status: "Active", initials: "A", departmentId: null, lastLoginAt: null, createdAt: new Date().toISOString() };
  });
  const app = await buildApp(services);
  apps.push(app);
  const headers = { authorization: `Bearer ${jwt.sign({}, config.jwtSecret, { algorithm: "HS256", subject: "actor", expiresIn: 3600 })}` };
  async function seed(source = yaml, published = true) {
    const now = new Date().toISOString();
    const workflow: Workflow = { id: "read", name: "Daily read", description: "Read", owner: { id: options.roleId === "role_client" ? "other" : "actor", name: "Owner" }, assignedUserIds: ["actor"], status: "PENDING", trigger: { type: "manual" },
      steps: 2, successRate: 0, lastRunAt: null, publishedVersion: published ? 1 : 0, draftVersion: 1, tags: [], domainTags: [], canRun: published, createdAt: now, updatedAt: now, yaml: source, archived: false };
    await repository.mutate((state) => { state.workflows.read = workflow; state.versions.read = published ? [{ version: 1, artifactState: "PUBLISHED", yaml: source }] : []; });
  }
  const run = (payload: Record<string, unknown> = { input: { invoiceId: "invoice-requested" } }) => app.inject({ method: "POST", url: "/api/workflows/read/run", headers, payload });
  return { app, services, repository, tool, validator, listTools, callTool, queryWithTools, headers, seed, run, drift: () => { hash = "sha256:registry-v2"; } };
}

test.each([false, true])("published two-node read executes exact bindings with provider configured=%s", async (provider) => {
  const s = await setup({ provider }); await s.seed();
  const response = await s.run();
  expect(response.statusCode, response.body).toBe(200);
  const execution = response.json().data;
  expect(execution).toMatchObject({ status: "DONE", tokens: { input: 0, output: 0, total: 0 }, costUsd: 0,
    workflowSnapshot: { version: 1, yaml, registryHash: "sha256:registry-v1", executionProfile: "sequential-read-v1" } });
  expect(s.callTool.mock.calls).toEqual([["invoice-read", { id: "invoice-requested", role: "admin" }], ["invoice-read", { id: "invoice-actual", role: "admin" }]]);
  const state = await s.repository.snapshot();
  expect(state.timelines[execution.id]?.map((step) => [step.nodeId, step.status])).toEqual([["lookup", "DONE"], ["details", "DONE"]]);
  for (const step of state.timelines[execution.id]!) {
    expect(Date.parse(String(step.completedAt))).toBeGreaterThanOrEqual(Date.parse(String(step.startedAt)));
    expect(step.durationMs).toBeGreaterThanOrEqual(0);
  }
  expect(s.listTools).toHaveBeenCalledTimes(1);
  expect(s.queryWithTools).not.toHaveBeenCalled();
});

const conditionalYAML = (predicate: unknown = { kind: "ref", source: "workflowInput", path: ["enabled"] }) => stringify({ name: "Branch report", description: "Read exactly one branch", trigger: { type: "manual" }, steps: ["yes", "no", "after"].map(id => ({ id, action: "finance.read", parameters: { id } })), metadata: { controlFlow: { schemaVersion: "read-control-flow/v1", root: { kind: "sequence", nodes: [{ kind: "if", id: "gate", predicate, then: { kind: "sequence", nodes: [{ kind: "action", nodeId: "yes" }] }, else: { kind: "sequence", nodes: [{ kind: "action", nodeId: "no" }] } }, { kind: "action", nodeId: "after" }] } } } });

const valueYAML = (output?: unknown, nested = false) => {
  const value = parseWorkflowYAMLStrict(conditionalYAML()) as any;
  value.metadata.controlFlow.schemaVersion = "read-control-flow/v2";
  const nodes = value.metadata.controlFlow.root.nodes, gate = nodes[0];
  gate.merge = { schema: { type: "string" }, then: { kind: "ref", source: "nodeOutput", nodeId: "yes", path: ["structuredContent", "id"] }, else: { kind: "ref", source: "nodeOutput", nodeId: "no", path: ["structuredContent", "id"] } };
  value.steps[2].parameters.id = "{{gate.value}}";
  const answer = { kind: "return", id: "answer", output: output ?? { schema: { type: "string" }, value: { kind: "ref", source: "nodeOutput", nodeId: "after", path: ["structuredContent", "id"] } } };
  if (nested) gate.then.nodes.push(answer); else nodes.push(answer);
  return stringify(value);
};

const simulationPayload = (source: string, outputs: Record<string, unknown> = { yes: { content: [], structuredContent: { id: "fixture-yes" } }, after: { content: [], structuredContent: { id: "fixture-final" } } }) => ({ dryRun: true, input: { enabled: true }, simulation: { profile: "read-fixtures/v1", baseVersion: 1, baseHash: workflowContentHash(source), outputs } });

const collectionYAML = () => stringify({ name: "Collection report", description: "Read a bounded list", trigger: { type: "manual" }, steps: [{ id: "lookup", action: "finance.read", parameters: { id: "{{each.item}}" } }], metadata: { controlFlow: { schemaVersion: "read-control-flow/v3", root: { kind: "sequence", nodes: [
  { kind: "foreach", id: "each", items: { schema: { type: "array", items: { type: "string" } }, value: { kind: "ref", source: "workflowInput", path: ["rows"] } }, maxItems: 3, body: { kind: "sequence", nodes: [{ kind: "action", nodeId: "lookup" }] }, collect: { schema: { type: "string" }, value: { kind: "ref", source: "nodeOutput", nodeId: "lookup", path: ["structuredContent", "id"] } } },
  { kind: "return", id: "answer", output: { schema: { type: "array", items: { type: "string" } }, value: { kind: "ref", source: "nodeOutput", nodeId: "each", path: ["value"] } } },
] } } } });

test("iteration receipts integrate with existing scoped event replay and cancellation without admitting a live collection", async () => {
  const s = await setup({ provider: true }); await s.app.ready(); const source = collectionYAML(); await s.seed(source);
  const input = { rows: ["first", "second"], private_token: "private-journal-input" }, plan = compileReadWorkflow(source, [s.tool], "Platform Admin"), key = "fixture-server-iteration-binding-key-32-bytes", timestamp = new Date().toISOString();
  const item: Execution = { id: "iteration-run", workflowId: "read", workflowName: "Collection", status: "RUNNING", startedAt: timestamp, completedAt: null, durationMs: 0, costUsd: 0, tokens: { input: 0, output: 0, total: 0 }, startedBy: { id: "actor", name: "Actor" }, workflowSnapshot: { version: 1, contentHash: plan.sourceHash, registryHash: s.services.registries.hash(), yaml: source, input: {}, executionProfile: "collection-read-v1", compilation: readCompilationReceipt(plan, s.services.registries.hash(), "PUBLICATION", "fixture-legacy") }, readProgress: newReadProgress(s.repository), iterationProgress: newReadIterationLedger("iteration-run", plan, input, "Platform Admin", key) };
  await s.repository.mutate(state => { state.executions[item.id] = item; });
  const worker = new ReadIterationCheckpoints(s.repository, item.id, 1, source, plan, input, [s.tool], key);
  await worker.advance(); const first = await worker.advance(); await worker.dispatchIntent(first!.visit, "Platform Admin"); await worker.completed(first!.visit, { content: [], structuredContent: { id: "confirmed-first" } }); await worker.advance(); await worker.advance();
  const page = await s.app.inject({ method: "GET", url: `/api/executions/${item.id}/events?after=0&limit=100`, headers: s.headers }); expect(page.statusCode, page.body).toBe(200);
  expect(page.json().data.events.find((event: any) => event.type === "iteration.action.completed").payload).toMatchObject({ invocationId: "each/0/lookup", iterations: [{ loopId: "each", index: 0 }] }); expect(page.body).not.toContain("private-journal-input"); expect(page.body).not.toContain(key);
  const cancelled = await s.app.inject({ method: "POST", url: `/api/executions/${item.id}/cancel`, headers: s.headers, payload: {} }); expect(cancelled.statusCode, cancelled.body).toBe(202); await expect(worker.advance()).rejects.toThrow();
  const final = await worker.finish(); expect(final.status).toBe("CANCELLED"); expect(final.stepOutputs?.["each/0/lookup"]).toMatchObject({ structuredContent: { id: "confirmed-first" } }); expect(final.readProgress!.attempts["each/1/lookup"]!.status).toBe("CANCELLED");
  expect((await s.run({ input: { rows: [] } })).statusCode).toBe(422); expect(s.callTool).not.toHaveBeenCalled(); expect(s.listTools).not.toHaveBeenCalled(); expect(s.queryWithTools).not.toHaveBeenCalled();
});

async function seedMonitoredExecution(s: Awaited<ReturnType<typeof setup>>, id: string): Promise<void> {
  const timestamp = new Date().toISOString();
  await s.repository.mutate((state) => {
    const item: Execution = { id, workflowId: "read", workflowName: "Monitored read", status: "RUNNING", startedAt: timestamp, completedAt: null, durationMs: 0,
      costUsd: 0, tokens: { input: 0, output: 0, total: 0 }, startedBy: { id: "actor", name: "Actor" }, readProgress: newReadProgress(s.repository) };
    state.executions[id] = item; state.executionEvents[id] = []; state.timelines[id] = [];
    appendExecutionEvent(state, item, "run.started", { profile: "read-progress-v1" });
  });
}

test("authenticated event long poll wakes on a relevant commit and replays only saved evidence", async () => {
  const s = await setup(); await s.app.ready(); await seedMonitoredExecution(s, "monitor-wake");
  const observe = vi.spyOn(s.repository, "observeCommits");
  const response = s.app.inject({ method: "GET", url: "/api/executions/monitor-wake/events?after=1&limit=100&waitMs=1000", headers: s.headers });
  await vi.waitFor(() => expect(observe).toHaveBeenCalledTimes(1));
  await s.repository.mutate((state) => appendExecutionEvent(state, state.executions["monitor-wake"]!, "node.completed", { outcome: "DONE" }, "lookup"));
  const result = await response;
  expect(result.statusCode, result.body).toBe(200);
  expect(result.json().data).toMatchObject({ cursor: 2, lastSequence: 2, waited: true, hasMore: false, status: "RUNNING",
    events: [{ sequence: 2, type: "node.completed", nodeId: "lookup", payload: { outcome: "DONE" } }] });
  expect(result.json().data.waitedMs).toBeLessThan(1000);
});

test("event long poll times out unchanged and never invents a status transition", async () => {
  const s = await setup(); await s.app.ready(); await seedMonitoredExecution(s, "monitor-timeout");
  const response = await s.app.inject({ method: "GET", url: "/api/executions/monitor-timeout/events?after=1&limit=100&waitMs=15", headers: s.headers });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().data).toMatchObject({ events: [], cursor: 1, lastSequence: 1, waited: true, status: "RUNNING" });
  expect(response.json().data.waitedMs).toBeGreaterThanOrEqual(10);
});

test("event long poll reapplies authorization after wake and hides previously readable evidence", async () => {
  const s = await setup(); await s.app.ready(); await seedMonitoredExecution(s, "monitor-revoked");
  const observe = vi.spyOn(s.repository, "observeCommits");
  const response = s.app.inject({ method: "GET", url: "/api/executions/monitor-revoked/events?after=1&waitMs=1000", headers: s.headers });
  await vi.waitFor(() => expect(observe).toHaveBeenCalledTimes(1));
  await s.repository.mutate((state) => { state.users.actor!.status = "Suspended"; });
  const result = await response;
  expect(result.statusCode, result.body).toBe(404);
  expect(result.json().message).toBe("Execution not found");
  expect(result.body).not.toContain("run.started");
});

test.each(["-1", "25001", "1.5", "forever"])("event long poll rejects invalid wait duration %s", async (waitMs) => {
  const s = await setup(); await s.app.ready(); await seedMonitoredExecution(s, `monitor-invalid-${waitMs}`);
  const response = await s.app.inject({ method: "GET", url: `/api/executions/monitor-invalid-${encodeURIComponent(waitMs)}/events?after=1&waitMs=${encodeURIComponent(waitMs)}`, headers: s.headers });
  expect(response.statusCode, response.body).toBe(400);
});

test("collection HTTP simulation has separate iteration evidence and performs no live or persisted work", async () => {
  const s = await setup({ provider: true }), source = collectionYAML(); await s.seed(source, false); await s.app.ready();
  const before = await s.repository.snapshot(), mutate = vi.spyOn(s.repository, "mutate");
  const response = await s.run({ dryRun: true, input: { rows: ["first", "second"] }, simulation: { profile: "read-fixtures/v2", baseVersion: 1, baseHash: workflowContentHash(source), outputs: { "each/0/lookup": { content: [], structuredContent: { id: "A" } }, "each/1/lookup": { content: [], structuredContent: { id: "B" } } } } });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().data).toMatchObject({ simulation: "fixture-read/v2", outcome: "SIMULATED_COMPLETE", finalOutput: ["A", "B"], erp_calls: 0, model_calls: 0, persisted_run: false, can_execute: false });
  expect(response.json().data.trace.filter((entry: any) => entry.kind === "action").map((entry: any) => [entry.invocationId, entry.arguments])).toEqual([["each/0/lookup", { id: "first" }], ["each/1/lookup", { id: "second" }]]);
  expect(s.callTool).not.toHaveBeenCalled(); expect(s.listTools).not.toHaveBeenCalled(); expect(s.queryWithTools).not.toHaveBeenCalled(); expect(mutate).not.toHaveBeenCalled(); expect(await s.repository.snapshot()).toEqual(before);
});

test.each(["complete", "empty", "all-skipped"])("HTTP selected-path verification uses actual %s collection evidence, not declarations", async scenario => {
  const s = await setup({ provider: true }), src = parseWorkflowYAMLStrict(collectionYAML()) as any, loop = src.metadata.controlFlow.root.nodes[0];
  src.steps.push({ id: "details", action: "invoice-read", parameters: { id: "summary" } }); src.metadata.controlFlow.root.nodes.splice(1, 0, { kind: "action", nodeId: "details" });
  if (scenario === "all-skipped") { const body = structuredClone(loop.body); loop.body.nodes = [{ kind: "if", id: "gate", predicate: { kind: "literal", value: false }, then: body, else: { kind: "sequence", nodes: [] } }]; loop.collect.value = { kind: "literal", value: "skipped" }; }
  const source = stringify(src); await s.seed(source, false); await s.app.ready();
  const rule = ruleSchema.parse({ rule_id: "COLLECTION-PREREQUISITE", rule_type: "process_order", enabled: true, enforcement_action: "block", condition: { value: ["finance.read", "invoice-read"] } });
  vi.spyOn(s.services.registries, "enabledRules").mockReturnValue([rule]);
  const original = s.validator.validatePlan.bind(s.validator), projections: ReturnType<typeof parseWorkflowYAMLStrict>[] = [];
  vi.spyOn(s.validator, "validatePlan").mockImplementation((id, yaml, role) => { if (id === "ReadFixtureSelectedPath") projections.push(parseWorkflowYAMLStrict(yaml)); return original(id, yaml, role); });
  const before = await s.repository.snapshot(), mutate = vi.spyOn(s.repository, "mutate"), outputs = { "each/0/lookup": { content: [], structuredContent: { id: "A" } }, "each/1/lookup": { content: [], structuredContent: { id: "B" } }, details: { content: [], structuredContent: { id: "summary" } } };
  const response = await s.run({ dryRun: true, input: { rows: scenario === "empty" ? [] : ["first", "second"] }, simulation: { profile: "read-fixtures/v2", baseVersion: 1, baseHash: workflowContentHash(source), outputs } });
  expect(response.statusCode, response.body).toBe(200); expect(response.json().data.validation.passed).toBe(true);
  if (scenario === "complete") {
    expect(response.json().data).toMatchObject({ outcome: "SIMULATED_COMPLETE", finalOutput: ["A", "B"] });
    expect(projections.at(-1)!.steps.map(step => [step.id, step.parameters])).toEqual([["each/0/lookup", { id: "first" }], ["each/1/lookup", { id: "second" }], ["details", { id: "summary" }]]);
  } else {
    expect(response.json().data).toMatchObject({ outcome: "SIMULATED_STOPPED", reason: "SELECTED_PATH_RULE_BLOCKED", failedNodeId: "details", usedFixtureIds: [] });
    expect(projections.at(-1)!.steps.map(step => step.id)).toEqual(["details"]);
  }
  expect(s.callTool).not.toHaveBeenCalled(); expect(s.listTools).not.toHaveBeenCalled(); expect(s.queryWithTools).not.toHaveBeenCalled(); expect(mutate).not.toHaveBeenCalled(); expect(await s.repository.snapshot()).toEqual(before);
});

test("HTTP frozen-verifier supplement never borrows a prerequisite from the previous collection item", async () => {
  const s = await setup({ provider: true }), src = parseWorkflowYAMLStrict(collectionYAML()) as any, loop = src.metadata.controlFlow.root.nodes[0];
  loop.items.schema.items = { type: "object", properties: { id: { type: "string" }, enabled: { type: "boolean" } }, required: ["id", "enabled"], additionalProperties: false };
  src.steps[0].parameters.id = "{{each.item.id}}"; src.steps.push({ id: "details", action: "invoice-read", parameters: { id: "{{each.item.id}}" } });
  const originalBody = structuredClone(loop.body); loop.body.nodes = [{ kind: "if", id: "gate", predicate: { kind: "ref", source: "nodeOutput", nodeId: "each", path: ["item", "enabled"] }, then: originalBody, else: { kind: "sequence", nodes: [] } }, { kind: "action", nodeId: "details" }]; loop.collect.value = { kind: "literal", value: "selected" };
  const source = stringify(src); await s.seed(source, false); await s.app.ready();
  const rule = ruleSchema.parse({ rule_id: "ITEM-PREREQUISITE", rule_type: "process_order", enabled: true, enforcement_action: "block", condition: { value: ["finance.read", "invoice-read"] } }); vi.spyOn(s.services.registries, "enabledRules").mockReturnValue([rule]);
  const before = await s.repository.snapshot(), response = await s.run({ dryRun: true, input: { rows: [{ id: "a", enabled: true }, { id: "b", enabled: false }] }, simulation: { profile: "read-fixtures/v2", baseVersion: 1, baseHash: workflowContentHash(source), outputs: { "each/0/lookup": { content: [], structuredContent: { id: "A" } }, "each/0/details": { content: [], structuredContent: { id: "confirmed" } }, "each/1/details": { content: [], structuredContent: { id: "must-not-use" } } } } });
  expect(response.statusCode, response.body).toBe(200); expect(response.json().data).toMatchObject({ outcome: "SIMULATED_STOPPED", reason: "SELECTED_PATH_RULE_BLOCKED", usedFixtureIds: ["each/0/lookup", "each/0/details"], unusedFixtureIds: ["each/1/details"] });
  expect(response.json().data.trace.at(-1)).toMatchObject({ invocationId: "each/1/details", arguments: { id: "b" } }); expect(await s.repository.snapshot()).toEqual(before);
  expect(s.callTool).not.toHaveBeenCalled(); expect(s.listTools).not.toHaveBeenCalled(); expect(s.queryWithTools).not.toHaveBeenCalled();
});

test.each(["legacy-fixtures", "unscoped", "wrong-owner", "stale"])("collection HTTP rejects %s fixture request before side effects", async kind => {
  const s = await setup({ provider: true }), source = collectionYAML(); await s.seed(source, false);
  const simulation: any = { profile: "read-fixtures/v2", baseVersion: 1, baseHash: workflowContentHash(source), outputs: {} };
  if (kind === "legacy-fixtures") simulation.profile = "read-fixtures/v1";
  if (kind === "unscoped") simulation.outputs.lookup = { content: [] };
  if (kind === "wrong-owner") simulation.outputs["other/0/lookup"] = { content: [] };
  if (kind === "stale") simulation.baseVersion = 2;
  const response = await s.run({ dryRun: true, input: { rows: [] }, simulation });
  expect(response.statusCode, response.body).toBe(kind === "stale" ? 409 : 400);
  expect(s.callTool).not.toHaveBeenCalled(); expect(s.listTools).not.toHaveBeenCalled(); expect(s.queryWithTools).not.toHaveBeenCalled(); expect((await s.repository.snapshot()).executions).toEqual({});
});

test.each([undefined, "async-read"])("a legacy published collection cannot run in mode %s or mint live checkpoints", async mode => {
  const s = await setup({ provider: true }); await s.seed(collectionYAML());
  const response = await s.run({ input: { rows: ["first"] }, ...(mode ? { mode, idempotencyKey: "collection-live-fence-001" } : {}) });
  expect(response.statusCode, response.body).toBe(422);
  expect(s.callTool).not.toHaveBeenCalled(); expect(s.listTools).not.toHaveBeenCalled(); expect(s.queryWithTools).not.toHaveBeenCalled(); expect((await s.repository.snapshot()).executions).toEqual({});
});

test("an unsupported collection remains saved as a draft but cannot publish an executable artifact", async () => {
  const s = await setup({ provider: true }); await s.seed(collectionYAML(), false);
  const result = await s.app.inject({ method: "POST", url: "/api/workflows/read/publish", headers: s.headers, payload: {} });
  expect(result.statusCode, result.body).toBe(422); expect(result.json().meta.code).toBe("UNSUPPORTED_PUBLICATION_PROFILE");
  const state = await s.repository.snapshot(); expect(state.workflows.read!.canRun).toBe(false);
  expect(state.workflows.read!.yaml).toBe(collectionYAML());
  expect(state.versions.read!.some(version => version.artifactState === "PUBLISHED" || version.compiledRead)).toBe(false);
  expect(s.listTools).not.toHaveBeenCalled();
  const readiness = await s.app.inject({ method: "GET", url: "/api/workflows/read/readiness", headers: s.headers });
  expect(readiness.json().data.authoring.executionProfile).toBe("collection-simulation-only");
  expect(readiness.json().data.can_attempt_run).toBe(false);
  expect(s.callTool).not.toHaveBeenCalled(); expect(s.listTools).toHaveBeenCalledTimes(1); expect(s.queryWithTools).not.toHaveBeenCalled();
});

test("collection commands preserve action ownership, revision fences and never flatten nonempty bodies", async () => {
  const s = await setup({ provider: true }); await s.seed(yaml, false);
  let source = yaml, revision = 1;
  const command = async (value: unknown) => {
    const result = await s.app.inject({ method: "POST", url: "/api/workflows/read/commands", headers: s.headers, payload: { baseVersion: revision, baseHash: workflowContentHash(source), command: value } });
    if (result.statusCode === 200) { source = result.json().data.yaml; revision = result.json().data.version; } return result;
  };
  const config = { items: { schema: { type: "array", items: { type: "string" } }, value: { kind: "array", items: [] } }, maxItems: 2, collect: { schema: { type: "string" }, value: { kind: "literal", value: "test" } } };
  const wrapped = await command({ type: "wrapCollection", nodeId: "lookup", loopId: "each", ...config }); expect(wrapped.statusCode, wrapped.body).toBe(200);
  expect((parseWorkflowYAMLStrict(source) as any).metadata.controlFlow.root.nodes[0].body.nodes).toEqual([{ kind: "action", nodeId: "lookup" }]);
  expect((await command({ type: "removeCollection", nodeId: "each" })).statusCode).toBe(422);
  const changed = await command({ type: "updateCollection", nodeId: "each", patch: { ...config, maxItems: 3 } }); expect(changed.statusCode, changed.body).toBe(200);
  expect((parseWorkflowYAMLStrict(source) as any).metadata.controlFlow.root.nodes[0].maxItems).toBe(3);
  const stale = await s.app.inject({ method: "POST", url: "/api/workflows/read/commands", headers: s.headers, payload: { baseVersion: 1, baseHash: workflowContentHash(yaml), command: { type: "updateCollection", nodeId: "each", patch: config } } }); expect(stale.statusCode).toBe(409);
  const added = await command({ type: "addNode", node: { id: "nested", action: "finance.read", parameters: { id: "nested" } }, beforeNodeId: null, destination: { loopId: "each", scope: "body" } }); expect(added.statusCode, added.body).toBe(200);
  expect((parseWorkflowYAMLStrict(source) as any).metadata.controlFlow.root.nodes[0].body.nodes.map((node: any) => node.nodeId)).toEqual(["lookup", "nested"]);
  expect((await command({ type: "removeNode", nodeId: "nested" })).statusCode).toBe(200);
  expect((await command({ type: "moveNode", nodeId: "lookup", beforeNodeId: "details" })).statusCode).toBe(200);
  const removed = await command({ type: "removeCollection", nodeId: "each" }); expect(removed.statusCode, removed.body).toBe(200);
  const restored: any = parseWorkflowYAMLStrict(source); expect(restored.metadata.controlFlow.schemaVersion).toBe("read-control-flow/v3"); expect(restored.steps.map((step: any) => step.id)).toEqual(["lookup", "details"]);
  expect(s.callTool).not.toHaveBeenCalled(); expect(s.listTools).not.toHaveBeenCalled(); expect(s.queryWithTools).not.toHaveBeenCalled();
});

test("fixture HTTP simulation evaluates an unpublished draft without dispatch, discovery, model calls or repository writes", async () => {
  const s = await setup({ provider: true }), source = valueYAML(); await s.seed(source, false);
  await s.app.ready(); // Startup recovery is separate from the simulation request.
  const before = await s.repository.snapshot(), mutate = vi.spyOn(s.repository, "mutate");
  const response = await s.run(simulationPayload(source)); expect(response.statusCode, response.body).toBe(200);
  expect(response.json().data).toMatchObject({ outcome: "SIMULATED_COMPLETE", simulation: "fixture-read/v1", dry_run: true, can_execute: false, erp_calls: 0, model_calls: 0, persisted_run: false, live_readiness: "not_checked", runtime_authorization: "not_checked", capability_admission: "not_checked", workflowId: "read", baseVersion: 1, baseHash: workflowContentHash(source), finalOutput: "fixture-final", valueOutputs: { gate: { value: "fixture-yes" }, answer: { value: "fixture-final" } } });
  expect(response.json().data.trace.find((entry: any) => entry.nodeId === "after").arguments).toEqual({ id: "fixture-yes" });
  expect(s.callTool).not.toHaveBeenCalled(); expect(s.listTools).not.toHaveBeenCalled(); expect(s.queryWithTools).not.toHaveBeenCalled(); expect(mutate).not.toHaveBeenCalled(); expect(await s.repository.snapshot()).toEqual(before);
});

test.each(["stale", "invalid", "live", "async", "unknown"])("fixture HTTP rejects %s requests without dispatch or persisted runs", async kind => {
  const s = await setup({ provider: true }), source = valueYAML(); await s.seed(source, false);
  const payload: any = simulationPayload(source);
  if (kind === "stale") payload.simulation.baseVersion = 2;
  if (kind === "invalid") payload.simulation.approved = true;
  if (kind === "live") payload.dryRun = false;
  if (kind === "async") payload.mode = "async-read";
  if (kind === "unknown") payload.simulation.outputs.extra = { content: [] };
  expect((await s.run(payload)).statusCode).toBe(kind === "stale" ? 409 : kind === "async" ? 422 : 400);
  expect(s.callTool).not.toHaveBeenCalled(); expect(s.listTools).not.toHaveBeenCalled(); expect(s.queryWithTools).not.toHaveBeenCalled(); expect((await s.repository.snapshot()).executions).toEqual({});
});

test("simulation requires run permission and assigned scope even without a live bridge", async () => {
  const s = await setup({ noBridge: true, roleId: "role_client" }), source = valueYAML(); await s.seed(source, false);
  await s.repository.mutate(state => { state.workflows.read!.assignedUserIds = []; });
  expect((await s.run(simulationPayload(source))).statusCode).toBe(403);
  await s.repository.mutate(state => { state.workflows.read!.assignedUserIds = ["actor"]; state.roles.role_client!.permissions = ["workflow:read_own", "chat:use"]; });
  expect((await s.run(simulationPayload(source))).statusCode).toBe(403); expect(s.callTool).not.toHaveBeenCalled();
});

test.each(["actor", "draft", "registry"])("simulation delivery fences changed %s context", async kind => {
  const s = await setup(), source = valueYAML(); await s.seed(source, false);
  await s.app.ready();
  const original = s.repository.readAuthoritative.bind(s.repository); let reads = 0;
  vi.spyOn(s.repository, "readAuthoritative").mockImplementation(async read => {
    if (++reads === 1) {
      if (kind === "registry") s.drift();
      else await s.repository.mutate(state => { if (kind === "actor") state.users.actor!.status = "Inactive"; else state.workflows.read!.draftVersion = 2; });
    }
    return original(read);
  });
  const response = await s.run(simulationPayload(source)); expect(response.statusCode, response.body).toBe(kind === "actor" ? 403 : 409);
  expect(s.callTool).not.toHaveBeenCalled(); expect(s.listTools).not.toHaveBeenCalled(); expect((await s.repository.snapshot()).executions).toEqual({});
});

test("simulation bounds deeply nested and oversized inputs before recursive request validation", async () => {
  const s = await setup(), source = valueYAML(); await s.seed(source, false);
  let nested: any = {};
  for (let i = 0; i < 1000; i++) nested = { next: nested };
  for (const input of [nested, { large: "x".repeat(512000) }]) expect((await s.run({ ...simulationPayload(source), input })).statusCode).toBe(400);
  expect(s.callTool).not.toHaveBeenCalled(); expect(s.listTools).not.toHaveBeenCalled();
});

test("simulation cannot deliver results from uncertain authoritative storage", async () => {
  const s = await setup(), source = valueYAML(); await s.seed(source, false); await s.app.ready();
  vi.spyOn(s.repository, "readAuthoritative").mockRejectedValue(new Error("Uncertain storage"));
  const response = await s.run(simulationPayload(source)); expect(response.statusCode).toBe(503); expect(response.json().meta.code).toBe("SIMULATION_AUTHORITY_UNAVAILABLE"); expect(s.callTool).not.toHaveBeenCalled();
});

test("blocked simulation does not echo parser source excerpts or unresolved goals as results", async () => {
  const s = await setup(), source = "invalid: [PRIVATE_SOURCE_VALUE"; await s.seed(source, false);
  const response = await s.run(simulationPayload(source, {})); expect(response.statusCode, response.body).toBe(200);
  expect(response.json().data).toMatchObject({ outcome: "PLAN_BLOCKED", plan_valid: false, trace: [], validation: { passed: false, errors: ["YAML_PARSE_ERROR"] } }); expect(response.body).not.toContain("PRIVATE_SOURCE_VALUE"); expect(s.callTool).not.toHaveBeenCalled();
});

test("a root return before any action records every later action as skipped without evaluating future conditions", async () => {
  const s = await setup({ provider: true }), value = parseWorkflowYAMLStrict(valueYAML()) as any;
  value.metadata.controlFlow.root.nodes.unshift({ kind: "return", id: "early", output: { schema: { type: "boolean" }, value: { kind: "literal", value: false } } });
  await s.seed(stringify(value)); const response = await s.run({ input: {} }); expect(response.statusCode, response.body).toBe(200);
  expect(response.json().data).toMatchObject({ status: "DONE", finalOutput: false, readProgress: { nextStepIndex: 3, values: { early: { status: "DONE", kind: "return" } } } });
  expect(response.json().data.readProgress.decisions ?? {}).toEqual({}); expect(Object.keys(response.json().data.valueOutputs)).toEqual(["early"]); expect(s.callTool).not.toHaveBeenCalled(); expect(s.queryWithTools).not.toHaveBeenCalled();
});

test("queued typed workflow uses the same merge and return receipts without model inference", async () => {
  const s = await setup({ provider: true }); await s.seed(valueYAML());
  const response = await s.run({ input: { enabled: false }, mode: "async-read", idempotencyKey: "typed_job_request_0001" }); expect(response.statusCode, response.body).toBe(202);
  const id = response.json().data.id; await vi.waitFor(async () => expect((await s.repository.snapshot()).executions[id]!.status).toBe("DONE"));
  expect((await s.repository.snapshot()).executions[id]).toMatchObject({ finalOutput: "invoice-actual", workflowSnapshot: { executionProfile: "structured-read-v1" }, readProgress: { values: { answer: { kind: "return", status: "DONE" } } } });
  expect(s.queryWithTools).not.toHaveBeenCalled(); expect(s.callTool).toHaveBeenCalledTimes(2);
});

test.each(["output", "final", "skip"])("completion denies missing/forged %s evidence rather than marking a typed workflow done", async damage => {
  const s = await setup(), value = parseWorkflowYAMLStrict(valueYAML()) as any;
  value.metadata.controlFlow.root.nodes.unshift({ kind: "return", id: "early", output: { schema: { type: "boolean" }, value: { kind: "literal", value: false } } });
  await s.seed(stringify(value)); const original = s.repository.mutateExecution.bind(s.repository);
  vi.spyOn(s.repository, "mutateExecution").mockImplementation((id, mutation) => original(id, state => {
    const result = mutation(state);
    const item = Object.values(state.executions).find(item => item.status === "RUNNING" && item.readProgress?.values?.early);
    if (item) { if (damage === "output") delete item.valueOutputs!.early; else if (damage === "final") item.finalOutput = true; else { const entry = state.timelines[item.id]?.find(entry => entry.status === "SKIPPED"); if (entry) entry.outcome = "NOT_SELECTED"; } }
    return result;
  }));
  expect((await s.run({ input: {} })).statusCode).toBe(503); expect(Object.values((await s.repository.snapshot()).executions)[0]!.status).toBe("RECOVERY_REQUIRED"); expect(s.callTool).not.toHaveBeenCalled();
});

test.each([true, false])("selected typed branch merge feeds a later read and explicit return, enabled=%s", async enabled => {
  const s = await setup({ provider: true }); await s.seed(valueYAML());
  s.callTool.mockImplementation(async (_name, args) => ({ content: [], structuredContent: { id: `actual-${args.id}` } }));
  const response = await s.run({ input: { enabled } }); expect(response.statusCode, response.body).toBe(200);
  const item = response.json().data, selected = enabled ? "yes" : "no";
  expect(item).toMatchObject({ status: "DONE", workflowSnapshot: { executionProfile: "structured-read-v1" }, valueOutputs: { gate: { value: `actual-${selected}` }, answer: { value: `actual-actual-${selected}` } }, finalOutput: `actual-actual-${selected}`, readProgress: { values: { gate: { kind: "merge", status: "DONE" }, answer: { kind: "return", status: "DONE" } } } });
  expect(s.callTool.mock.calls.map(call => call[1].id)).toEqual([selected, `actual-${selected}`]);
  expect(Object.keys(item.stepOutputs)).toEqual([selected, "after"]); expect(s.queryWithTools).not.toHaveBeenCalled();
});

test.each([{ schema: { type: "boolean" }, value: false }, { schema: { type: "number" }, value: 0 }, { schema: { type: "null" }, value: null }])("nested explicit return preserves %j and skips future calls without merging", async ({ schema, value }) => {
  const s = await setup(); await s.seed(valueYAML({ schema, value: { kind: "literal", value } }, true));
  const response = await s.run({ input: { enabled: true } }); expect(response.statusCode, response.body).toBe(200);
  const item = response.json().data, state = await s.repository.snapshot();
  expect(item.status).toBe("DONE"); expect(item.finalOutput).toEqual(value); expect(item.valueOutputs).toEqual({ answer: { value } });
  expect(item.readProgress.values.gate).toBeUndefined(); expect(s.callTool.mock.calls.map(call => call[1].id)).toEqual(["yes"]);
  expect(state.timelines[item.id]!.find(entry => entry.nodeId === "after")).toMatchObject({ status: "SKIPPED", outcome: "AFTER_RETURN", returnId: "answer" });
  expect(state.timelines[item.id]!.find(entry => entry.nodeId === "no")).toMatchObject({ status: "SKIPPED", outcome: "NOT_SELECTED" });
  expect(item.stepOutputs.after).toBeUndefined(); expect(item.readProgress.attempts.after.dispatchIntentAt).toBeUndefined();
});

test("missing selected merge data records a typed failure and retains the confirmed ERP answer without dependent dispatch", async () => {
  const s = await setup(); await s.seed(valueYAML()); s.callTool.mockResolvedValue({ content: [], structuredContent: {} });
  const response = await s.run({ input: { enabled: false } }); expect(response.statusCode, response.body).toBe(422);
  const item = Object.values((await s.repository.snapshot()).executions)[0]!;
  expect(item).toMatchObject({ status: "FAILED", failure: { failedStepId: "gate" }, readProgress: { values: { gate: { kind: "merge", status: "FAILED" } } } });
  expect(Object.keys(item.stepOutputs!)).toEqual(["no"]); expect(item.valueOutputs?.gate).toBeUndefined(); expect(s.callTool).toHaveBeenCalledTimes(1);
});

test.each(["gate", "answer"])("lost %s value acknowledgement preserves the committed receipt and stops without replay", async nodeId => {
  const s = await setup(); await s.seed(valueYAML()); const original = s.repository.mutateExecution.bind(s.repository);
  vi.spyOn(s.repository, "mutateExecution").mockImplementation(async (id, mutation) => {
    let written = false;
    const result = await original(id, state => { const before = Object.values(state.executions).some(item => item.readProgress?.values?.[nodeId]); const value = mutation(state); written = !before && Object.values(state.executions).some(item => item.readProgress?.values?.[nodeId]); return value; });
    if (written) throw new Error("Lost typed value acknowledgement"); return result;
  });
  const response = await s.run({ input: { enabled: true } }); expect(response.statusCode).toBe(503);
  const item = Object.values((await s.repository.snapshot()).executions)[0]!;
  expect(item.status).toBe("RECOVERY_REQUIRED"); expect(item.readProgress!.values![nodeId]!.status).toBe("DONE"); expect(item.valueOutputs?.[nodeId]).toEqual({ value: "invoice-actual" });
  expect(s.callTool).toHaveBeenCalledTimes(nodeId === "gate" ? 1 : 2);
});

test("structure-aware authoring creates a publishable branch workflow that runs only its selected path", async () => {
  const s = await setup({ provider: true }), blueprint = parseWorkflowYAMLStrict(conditionalYAML()); delete blueprint.metadata;
  let source = stringify(blueprint), revision = 1; await s.seed(source, false);
  for (const command of [
    { type: "wrapNode", nodeId: "yes", conditionId: "gate", predicate: { kind: "ref", source: "workflowInput", path: ["enabled"] }, branch: "then" },
    { type: "moveNode", nodeId: "no", beforeNodeId: null, destination: { conditionId: "gate", branch: "else" } },
  ]) {
    const result = await s.app.inject({ method: "POST", url: "/api/workflows/read/commands", headers: s.headers, payload: { baseVersion: revision, baseHash: workflowContentHash(source), command } });
    expect(result.statusCode, result.body).toBe(200); source = result.json().data.yaml; revision = result.json().data.version;
    expect(result.json().data.canRun).toBe(false);
  }
  expect(s.callTool).not.toHaveBeenCalled();
  const readiness = await s.app.inject({ method: "GET", url: "/api/workflows/read/readiness", headers: s.headers });
  expect(readiness.json().data.issues).toEqual([]); expect(readiness.json().data.authoring.controlFlow).toBeTruthy();
  const published = await s.app.inject({ method: "POST", url: "/api/workflows/read/publish", headers: s.headers, payload: {} });
  expect(published.statusCode, published.body).toBe(200); expect(s.callTool).not.toHaveBeenCalled();
  const response = await s.run({ input: { enabled: false } }); expect(response.statusCode, response.body).toBe(200);
  expect(response.json().data).toMatchObject({ status: "DONE", workflowSnapshot: { yaml: source, executionProfile: "conditional-read-v1" }, readProgress: { attempts: { yes: { status: "SKIPPED" }, no: { status: "DONE" }, after: { status: "DONE" } } } });
  expect(s.callTool.mock.calls.map(call => call[1].id)).toEqual(["no", "after"]); expect(s.queryWithTools).not.toHaveBeenCalled();
});

test.each([true, false])("v3 format without loops uses normal conditional checkpoints through SDK entry, enabled=%s", async enabled => {
  const s = await setup({ provider: true }), source = parseWorkflowYAMLStrict(conditionalYAML());
  (source.metadata!.controlFlow as { schemaVersion: string }).schemaVersion = "read-control-flow/v3";
  await s.seed(stringify(source));
  const response = await s.run({ input: { enabled } }); expect(response.statusCode, response.body).toBe(200);
  expect(response.json().data).toMatchObject({ status: "DONE", workflowSnapshot: { executionProfile: "structured-read-v1", compilation: { schemaVersion: "workflow-read-ir/v3" } },
    readProgress: { decisions: { gate: { status: "DONE", selected: enabled ? "then" : "else" } } } });
  expect(s.callTool.mock.calls.map(call => call[1].id)).toEqual([enabled ? "yes" : "no", "after"]);
  expect(s.queryWithTools).not.toHaveBeenCalled();
});

test.each([true, false])("conditional read chooses exactly one path with enabled=%s, preserves source indexes and records the other path as skipped", async enabled => {
  const s = await setup({ provider: true }); await s.seed(conditionalYAML());
  const response = await s.run({ input: { enabled } }); expect(response.statusCode, response.body).toBe(200);
  const execution = response.json().data, state = await s.repository.snapshot();
  expect(execution).toMatchObject({ status: "DONE", workflowSnapshot: { executionProfile: "conditional-read-v1", compilation: { schemaVersion: "workflow-read-ir/v2" } }, readProgress: { nextStepIndex: 3, decisions: { gate: { status: "DONE", selected: enabled ? "then" : "else" } } } });
  expect(s.callTool.mock.calls.map(call => call[1].id)).toEqual([enabled ? "yes" : "no", "after"]);
  expect(Object.keys(execution.stepOutputs)).toEqual([enabled ? "yes" : "no", "after"]);
  const skipped = enabled ? "no" : "yes";
  expect(execution.readProgress.attempts[skipped]).toMatchObject({ status: "SKIPPED", stepIndex: enabled ? 1 : 0 });
  expect(execution.readProgress.attempts[skipped].dispatchIntentAt).toBeUndefined();
  expect(state.timelines[execution.id]!.find(entry => entry.nodeId === "gate")).toMatchObject({ outcome: "CONDITION_SELECTED", output: { selectedBranch: enabled ? "If yes" : "If no" } });
  expect(state.executionEvents[execution.id]!.findIndex(event => event.type === "condition.selected")).toBeLessThan(state.executionEvents[execution.id]!.findIndex(event => event.type === "node.dispatch_intent"));
  expect(s.queryWithTools).not.toHaveBeenCalled();
});

test.each([[true, true], [true, false], [false, true]])("nested conditions with outer=%s inner=%s evaluate only the selected scope", async (outer, inner) => {
  const s = await setup();
  const action = (nodeId: string) => ({ kind: "action", nodeId });
  const block = (...nodes: unknown[]) => ({ kind: "sequence", nodes });
  await s.seed(stringify({ name: "Nested read", description: "Select one nested path", trigger: { type: "manual" },
    steps: ["first", "yes", "no", "outside", "after"].map(id => ({ id, action: "finance.read", parameters: { id } })),
    metadata: { controlFlow: { schemaVersion: "read-control-flow/v1", root: block({ kind: "if", id: "outerGate", predicate: { kind: "ref", source: "workflowInput", path: ["outer"] },
      then: block(action("first"), { kind: "if", id: "innerGate", predicate: { kind: "ref", source: "workflowInput", path: ["inner"] }, then: block(action("yes")), else: block(action("no")) }),
      else: block(action("outside")) }, action("after")) } } }));
  const response = await s.run({ input: { outer, inner } }); expect(response.statusCode, response.body).toBe(200);
  const item = response.json().data;
  expect(item.status).toBe("DONE"); expect(item.readProgress.nextStepIndex).toBe(5);
  expect(s.callTool.mock.calls.map(call => call[1].id)).toEqual(outer ? ["first", inner ? "yes" : "no", "after"] : ["outside", "after"]);
  expect(Object.keys(item.readProgress.decisions)).toEqual(outer ? ["outerGate", "innerGate"] : ["outerGate"]);
  for (const id of ["first", "yes", "no", "outside", "after"]) {
    const called = s.callTool.mock.calls.some(call => call[1].id === id);
    expect(item.readProgress.attempts[id].status).toBe(called ? "DONE" : "SKIPPED");
    if (!called) { expect(item.readProgress.attempts[id].dispatchIntentAt).toBeUndefined(); expect(item.stepOutputs[id]).toBeUndefined(); }
  }
});

test("condition and skipped action IDs can match inherited object members without false replay detection", async () => {
  const s = await setup(), blueprint = parseWorkflowYAMLStrict(conditionalYAML());
  blueprint.steps[0]!.id = "valueOf";
  const flow = blueprint.metadata!.controlFlow as { root: { nodes: Array<{ id?: string; then?: { nodes: Array<{ nodeId: string }> } }> } };
  flow.root.nodes[0]!.id = "toString"; flow.root.nodes[0]!.then!.nodes[0]!.nodeId = "valueOf";
  await s.seed(stringify(blueprint)); const response = await s.run({ input: { enabled: false } });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().data.readProgress).toMatchObject({ decisions: { toString: { status: "DONE", selected: "else" } }, attempts: { valueOf: { status: "SKIPPED" } } });
  expect(s.callTool.mock.calls.map(call => call[1].id)).toEqual(["no", "after"]);
});

test.each([undefined, null, "true", 1, {}, []])("condition input %j fails without truthiness coercion or a branch SDK call", async enabled => {
  const s = await setup(); await s.seed(conditionalYAML());
  const response = await s.run({ input: enabled === undefined ? {} : { enabled } }); expect(response.statusCode, response.body).toBe(422);
  const execution = Object.values((await s.repository.snapshot()).executions)[0]!;
  expect(execution).toMatchObject({ status: "FAILED", failure: { failedStepId: "gate" }, readProgress: { decisions: { gate: { status: "FAILED" } }, nextStepIndex: 0 } });
  expect(execution.stepOutputs).toEqual({}); expect(s.callTool).not.toHaveBeenCalled();
});

test("condition checkpoint lost acknowledgement stops all branch work and never replays the decision or reads", async () => {
  const s = await setup(); await s.seed(conditionalYAML());
  const original = s.repository.mutateExecution.bind(s.repository);
  vi.spyOn(s.repository, "mutateExecution").mockImplementation(async (id, mutation) => {
    let decisionWritten = false;
    const result = await original(id, state => { const before = Object.values(state.executions).some(item => item.readProgress?.decisions?.gate); const value = mutation(state); decisionWritten = !before && Object.values(state.executions).some(item => item.readProgress?.decisions?.gate); return value; });
    if (decisionWritten) throw new Error("Lost decision acknowledgement"); return result;
  });
  const response = await s.run({ input: { enabled: true } }); expect(response.statusCode).toBe(503);
  expect(s.callTool).not.toHaveBeenCalled();
  expect(Object.values((await s.repository.snapshot()).executions)[0]!.status).toBe("RECOVERY_REQUIRED");
});

test("conditional read cancellation after decision stops before any branch dispatch", async () => {
  const s = await setup(); await s.seed(conditionalYAML());
  const original = s.repository.mutateExecution.bind(s.repository);
  vi.spyOn(s.repository, "mutateExecution").mockImplementation((id, mutation) => original(id, state => { const value = mutation(state); const item = Object.values(state.executions).find(item => item.readProgress?.decisions?.gate); if (item?.readProgress && item.status === "RUNNING") item.readProgress.cancellation = { requestedAt: new Date().toISOString(), requestedBy: item.startedBy }; return value; }));
  const response = await s.run({ input: { enabled: true } }); expect(response.statusCode, response.body).toBe(200);
  expect(response.json().data.status).toBe("CANCELLED"); expect(s.callTool).not.toHaveBeenCalled();
});

test("a skipped prerequisite cannot satisfy process order merely because it is earlier in the source catalog", async () => {
  const s = await setup();
  const rule = ruleSchema.parse({ rule_id: "CONFIRMED-PATH-ORDER", rule_type: "process_order", enabled: true, enforcement_action: "block", condition: { value: ["finance.read", "invoice-read"] } });
  vi.spyOn(s.services.registries, "enabledRules").mockReturnValue([rule]);
  const blueprint = parseWorkflowYAMLStrict(conditionalYAML()); blueprint.steps[1]!.action = "invoice-read"; blueprint.steps[2]!.action = "invoice-read";
  const source = stringify(blueprint); expect(s.validator.validatePlan("Original declarations", source, "Platform Admin").passed).toBe(true);
  await s.seed(source); const response = await s.run({ input: { enabled: false } }); expect(response.statusCode, response.body).toBe(422);
  expect(s.callTool).not.toHaveBeenCalled();
  const execution = Object.values((await s.repository.snapshot()).executions)[0]!;
  expect(execution).toMatchObject({ status: "FAILED", readProgress: { attempts: { yes: { status: "SKIPPED" }, no: { status: "FAILED" } } } });
});

test("queued conditional execution preserves the same selected-path checkpoints without invoking a model", async () => {
  const s = await setup({ provider: true }); await s.seed(conditionalYAML());
  const response = await s.run({ input: { enabled: false }, mode: "async-read", idempotencyKey: "conditional_job_request_0001" }); expect(response.statusCode, response.body).toBe(202);
  const id = response.json().data.id;
  await vi.waitFor(async () => expect((await s.repository.snapshot()).executions[id]!.status).toBe("DONE"));
  expect(s.callTool.mock.calls.map(call => call[1].id)).toEqual(["no", "after"]); expect(s.queryWithTools).not.toHaveBeenCalled();
});

test("lost branch-skip acknowledgement retains its receipt and stops before a dependent branch SDK read", async () => {
  const s = await setup(); await s.seed(conditionalYAML()); const original = s.repository.mutateExecution.bind(s.repository);
  vi.spyOn(s.repository, "mutateExecution").mockImplementation(async (id, mutation) => {
    let skipWritten = false;
    const result = await original(id, state => { const before = Object.values(state.executions).some(item => item.readProgress?.attempts.yes?.status === "SKIPPED"); const value = mutation(state); skipWritten = !before && Object.values(state.executions).some(item => item.readProgress?.attempts.yes?.status === "SKIPPED"); return value; });
    if (skipWritten) throw new Error("Lost skip acknowledgement"); return result;
  });
  expect((await s.run({ input: { enabled: false } })).statusCode).toBe(503); expect(s.callTool).not.toHaveBeenCalled();
  const execution = Object.values((await s.repository.snapshot()).executions)[0]!;
  expect(execution).toMatchObject({ status: "RECOVERY_REQUIRED", readProgress: { attempts: { yes: { status: "SKIPPED" } } } });
  await reconcileInterruptedExecutions(s.repository); expect(s.callTool).not.toHaveBeenCalled();
});

test("candidate stays a draft until explicit publication, then runs without a provider", async () => {
  const s = await setup();
  const created = await s.app.inject({ method: "POST", url: "/api/workflows", headers: s.headers, payload: { candidate: { yaml } } });
  expect(created.statusCode, created.body).toBe(201);
  const id = created.json().data.id;
  const run = () => s.app.inject({ method: "POST", url: `/api/workflows/${id}/run`, headers: s.headers, payload: { input: { invoiceId: "actual" } } });
  expect((await run()).statusCode).toBe(409);
  expect(s.listTools).not.toHaveBeenCalled();
  const publication = await s.app.inject({ method: "POST", url: `/api/workflows/${id}/publish`, headers: s.headers, payload: {} });
  expect(publication.statusCode, publication.body).toBe(200);
  expect(publication.json().data.artifactState).toBe("PUBLISHED");
  expect((await run()).statusCode).toBe(200);
  expect(s.callTool).toHaveBeenCalledTimes(2);
});

test("offline draft simulation is static and never discovers, dispatches or invokes a model", async () => {
  const s = await setup({ provider: true }); await s.seed(yaml, false);
  const response = await s.run({ dryRun: true });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().data).toMatchObject({ dry_run: true, plan_valid: true, can_execute: false, live_readiness: "not_checked", simulation: "static-read-plan" });
  expect(s.listTools).not.toHaveBeenCalled(); expect(s.callTool).not.toHaveBeenCalled(); expect(s.queryWithTools).not.toHaveBeenCalled();
  expect((await s.repository.snapshot()).executions).toEqual({});
});

test("missing bridge returns a precise connection failure without inventing an execution", async () => {
  const s = await setup({ noBridge: true, provider: true }); await s.seed();
  const response = await s.run();
  expect(response.statusCode, response.body).toBe(503);
  expect(response.json().meta.code).toBe("ERPBRIDGE_NOT_CONNECTED");
  expect((await s.repository.snapshot()).executions).toEqual({}); expect(s.queryWithTools).not.toHaveBeenCalled(); expect(s.callTool).not.toHaveBeenCalled();
});

test.each(["condition", "retryCount", "forward", "malformed", "reserved", "write", "schema"])("unsupported %s is blocked before live discovery", async (scenario) => {
  const s = await setup({ write: scenario === "write" });
  const blueprint = parseWorkflowYAMLStrict(yaml);
  if (scenario === "condition") blueprint.steps[0]!.condition = "true";
  if (scenario === "retryCount") blueprint.steps[0]!.retryCount = 1;
  if (scenario === "forward") blueprint.steps[0]!.parameters = { id: "{{details.structuredContent.id}}" };
  if (scenario === "malformed") blueprint.steps[0]!.parameters = { id: "{{ input.id + 1 }}" };
  if (scenario === "reserved") blueprint.steps[0]!.id = "input";
  if (scenario === "schema") s.tool.input_schema = { type: "invalid" };
  await s.seed(stringify(blueprint));
  const response = await s.run();
  expect(response.statusCode, response.body).toBe(422);
  expect(s.listTools).not.toHaveBeenCalled(); expect(s.callTool).not.toHaveBeenCalled();
  expect((await s.repository.snapshot()).executions).toEqual({});
});

test.each(["missing-input", "invalid-input", "missing-output", "mcp-error", "malformed-output"])("%s stops at the actual failed node without replay", async (scenario) => {
  const s = await setup(); await s.seed();
  if (scenario === "missing-output") s.callTool.mockResolvedValue({ content: [], structuredContent: {} });
  if (scenario === "mcp-error") s.callTool.mockResolvedValue({ content: [{ type: "text", text: "private-remote-error" }], isError: true });
  if (scenario === "malformed-output") s.callTool.mockResolvedValue({ invented: "not an MCP envelope" });
  const response = await s.run({ input: scenario === "missing-input" ? {} : { invoiceId: scenario === "invalid-input" ? 123 : "invoice-1" } });
  expect(response.statusCode, response.body).toBe(422);
  const state = await s.repository.snapshot(), execution = Object.values(state.executions)[0]!;
  expect(execution.status).toBe(scenario === "malformed-output" ? "RECOVERY_REQUIRED" : "FAILED");
  expect(execution.failure?.failedStepId).toBe(scenario === "missing-output" ? "details" : "lookup");
  expect(s.callTool).toHaveBeenCalledTimes(["missing-input", "invalid-input"].includes(scenario) ? 0 : 1);
  expect(JSON.stringify(state.executions)).not.toContain("private-remote-error");
  expect(state.timelines[execution.id]?.at(-1)?.status).toBe(scenario === "malformed-output" ? "UNKNOWN" : "FAILED");
  if (scenario === "missing-output") expect(execution.finalOutput).toEqual({ content: [], structuredContent: {} });
  else expect(execution.finalOutput).toBeUndefined();
});

test("known bridge failure receipt belongs to its failed attempt, never successful outputs or downstream inputs", async () => {
  const s = await setup(); await s.seed();
  s.callTool.mockResolvedValueOnce({ content: [{ type: "text", text: "Rate limit reached" }], isError: true, _meta: { secret: "private-meta", "com.erpbridge/error": { type: "rate_limit", retryable: true, retryAfterMs: 1000 } } });
  expect((await s.run()).statusCode).toBe(422);
  const state = await s.repository.snapshot(), execution = Object.values(state.executions)[0]!;
  expect(execution.status).toBe("FAILED"); expect(execution.stepOutputs?.lookup).toBeUndefined(); expect(execution.finalOutput).toBeUndefined();
  expect(state.timelines[execution.id]?.at(-1)).toMatchObject({ nodeId: "lookup", status: "FAILED", output: { isError: true, _meta: { "com.erpbridge/error": { type: "rate_limit", retryAfterMs: 1000 } } } });
  expect(JSON.stringify(state.timelines)).not.toContain("private-meta"); expect(s.callTool).toHaveBeenCalledOnce();
});

test("a thrown public MCP error constructor cannot convert an unconfirmed sequential read into a failed receipt", async () => {
  const s = await setup(); await s.seed();
  s.callTool.mockRejectedValueOnce(new ErpbridgeMcpToolError({ content: [], isError: true }));
  expect((await s.run()).statusCode).toBe(422);
  const state = await s.repository.snapshot(), execution = Object.values(state.executions)[0]!;
  expect(execution.status).toBe("RECOVERY_REQUIRED"); expect(execution.stepOutputs?.lookup).toBeUndefined();
  expect(state.timelines[execution.id]?.at(-1)).toMatchObject({ nodeId: "lookup", status: "UNKNOWN" });
  expect(state.timelines[execution.id]?.at(-1)?.output).toBeUndefined(); expect(s.callTool).toHaveBeenCalledOnce();
});

test.each(["disabled", "assignment", "registry"])("%s revocation after first node prevents second dispatch", async (scenario) => {
  const s = await setup({ roleId: scenario === "assignment" ? "role_client" : "role_admin" }); await s.seed();
  s.callTool.mockImplementationOnce(async () => {
    if (scenario === "registry") s.drift();
    else await s.repository.mutate((state) => { if (scenario === "disabled") state.users.actor!.status = "Disabled"; else state.workflows.read!.assignedUserIds = []; });
    return { content: [], structuredContent: { id: "actual-first-output" } };
  });
  const response = await s.run();
  expect(response.statusCode, response.body).toBe(422);
  expect(s.callTool).toHaveBeenCalledTimes(1);
  const state = await s.repository.snapshot(), execution = Object.values(state.executions)[0]!;
  expect(execution).toMatchObject({ status: "FAILED", failure: { failedStepId: "details" }, stepOutputs: { lookup: { structuredContent: { id: "actual-first-output" } } } });
  expect(execution.workflowSnapshot?.registryHash).toBe("sha256:registry-v1");
});

test("run retains its exact published snapshot despite a later draft edit and redacts structured credentials", async () => {
  const s = await setup(); await s.seed();
  s.callTool.mockImplementationOnce(async () => {
    await s.repository.mutate((state) => { state.workflows.read!.yaml = yaml.replace("Daily read", "New draft"); state.workflows.read!.draftVersion = 2; });
    return { content: [{ type: "text", text: JSON.stringify({ id: "invoice-1", api_key: "remote-secret" }) }], structuredContent: { id: "invoice-1", token: "remote-secret" } };
  });
  const response = await s.run({ input: { invoiceId: "invoice-1", api_key: "input-secret" } });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().data.workflowSnapshot.yaml).toBe(yaml);
  expect(response.body).not.toContain("remote-secret"); expect(response.body).not.toContain("input-secret");
  expect((await s.run()).statusCode).toBe(409);
  expect(s.callTool).toHaveBeenCalledTimes(2);
});

test("discovery failure and schema drift do not create runnable tool contracts", async () => {
  const s = await setup(); await s.seed(); s.listTools.mockRejectedValue(new Error("secret-discovery-detail"));
  const response = await s.run();
  expect(response.statusCode).toBe(503); expect(response.json().meta.code).toBe("ERPBRIDGE_DISCOVERY_FAILED");
  expect(response.body).not.toContain("secret-discovery-detail"); expect(s.callTool).not.toHaveBeenCalled();
  s.listTools.mockResolvedValue([{ name: s.tool.mcp_tool_name, inputSchema: { type: "object" } }]);
  const drift = await s.run();
  expect(drift.statusCode).toBe(422); expect(drift.json().meta.code).toBe("LIVE_CONTRACT_NOT_READY");
  expect((await s.repository.snapshot()).executions).toEqual({});
});

test("server-only full-plan dispatch rejects a forged original verification receipt", async () => {
  const s = await setup(); await s.seed();
  const gate = await s.validator.validateAndIssueToken("RunWorkflow", yaml, "Platform Admin");
  const forged = structuredClone(gate.token!);
  await expect(dispatchReadTool(s.services, "actor", "finance.read", { id: "invoice-1" }, { workflowId: "read", plan: { yaml, stepIndex: 0, token: forged } })).rejects.toThrow();
  expect(s.callTool).not.toHaveBeenCalled();
});

test("schema profile rejects ignored constraints, missing types and reserved reference traversal", async () => {
  const s = await setup();
  s.tool.input_schema = { type: "object", properties: { id: { description: "Missing type" } } };
  expect(inspectReadWorkflow(parseWorkflowYAMLStrict(yaml), [s.tool], "Platform Admin")).not.toEqual([]);
  s.tool.input_schema = { type: "object", properties: { id: { type: "string", minLength: 2 } } };
  expect(inspectReadWorkflow(parseWorkflowYAMLStrict(yaml), [s.tool], "Platform Admin")).not.toEqual([]);
  const blueprint = parseWorkflowYAMLStrict(yaml); blueprint.steps[0]!.parameters = { id: "{{input.__proto__.id}}" };
  expect(inspectReadWorkflow(blueprint, [s.tool], "Platform Admin")).not.toEqual([]);
});

class ReadPersistence implements PersistenceBackend {
  payload: Uint8Array | null = null;
  failWhen: ((state: RepositoryState) => boolean) | undefined;
  commitBeforeFailure = false;
  async load() { return this.payload; }
  async save(payload: Uint8Array) {
    const state = JSON.parse(Buffer.from(payload).toString("utf8")) as RepositoryState;
    if (this.failWhen?.(state)) {
      this.failWhen = undefined;
      if (this.commitBeforeFailure) this.payload = Buffer.from(payload);
      throw new Error("fixture storage acknowledgement failure");
    }
    this.payload = Buffer.from(payload);
  }
  async probe() {}
  async close() {}
  state(): RepositoryState { return JSON.parse(Buffer.from(this.payload!).toString("utf8")); }
}
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

class QueuePersistence extends ReadPersistence { readonly readQueueDurability = "encrypted-single-writer" as const; }
const queuedInput = (key = "read-job-fixture-001", input = { invoiceId: "queued-invoice", api_key: "private-queue-secret" }) => ({ mode: "async-read", idempotencyKey: key, input });

test("native read-job inputs stay in business fields, never enter the public execution and are erased on completion",async()=>{
 const s=await setup();s.services.config.firestoreContentFormat="native-fields/v1";await s.seed();
 const queue=readJobQueue(s.services),kick=vi.spyOn(queue,"kick").mockImplementation(()=>{});
 const response=await s.run(queuedInput());expect(response.statusCode,response.body).toBe(202);const id=response.json().data.id;
 const job=(await s.repository.snapshot()).readJobs[id]!;
 expect(job.inputCiphertext).toBeUndefined();expect(job.inputFields).toMatchObject({version:1,executionId:id,input:{invoiceId:"queued-invoice",api_key:"private-queue-secret"}});
 expect(response.body).not.toMatch(/inputFields|private-queue-secret/);
 kick.mockRestore();queue.kick();expect((await waitForTerminal(s.repository,id)).status).toBe("DONE");
 const saved=(await s.repository.snapshot()).readJobs[id]!;expect(saved.inputFields).toBeUndefined();expect(saved.inputCiphertext).toBeUndefined();expect(s.callTool).toHaveBeenCalledTimes(2);
});

test("read admission lookup recovers identity after draft changes without dispatch, replay or private fields", async () => {
  const s = await setup(); await s.seed(); vi.spyOn(readJobQueue(s.services), "kick").mockImplementation(() => {});
  const response = await s.run(queuedInput()); expect(response.statusCode, response.body).toBe(202); const id = response.json().data.id;
  await s.repository.mutate(state => { state.workflows.read!.yaml += "\n# later draft"; state.workflows.read!.draftVersion++; });
  const before = await s.repository.snapshot();
  for (let attempt = 0; attempt < 2; attempt++) {
    const receipt = await s.app.inject({ method: "GET", url: "/api/workflows/read/run-receipts/read-job-fixture-001?mode=async-read", headers: s.headers });
    expect(receipt.statusCode, receipt.body).toBe(200); expect(receipt.headers["cache-control"]).toBe("no-store");
    expect(receipt.json().data).toEqual({ profile: "run-admission-receipt/v1", outcome: "RECORDED", workflowId: "read", mode: "async-read", executionId: id, status: "PENDING", noReplay: true });
    expect(receipt.body).not.toMatch(/private-queue-secret|inputCiphertext|requestFingerprint|idempotencyScope|workflowSnapshot/);
  }
  expect(await s.repository.snapshot()).toEqual(before); expect(s.callTool).not.toHaveBeenCalled(); expect(s.listTools).not.toHaveBeenCalled();
});

test.each(["unknown", "other-account", "wrong-workflow", "wrong-mode", "malformed", "override", "revoked", "storage"])("read receipt handles %s without admitting anything", async kind => {
  const s = await setup(); await s.seed(); vi.spyOn(readJobQueue(s.services), "kick").mockImplementation(() => {});
  const response = await s.run(queuedInput()); expect(response.statusCode, response.body).toBe(202);
  let path = "/api/workflows/read/run-receipts/read-job-fixture-001?mode=async-read", headers = s.headers;
  if (kind === "unknown") path = path.replace("read-job-fixture-001", "unknown-request-0001");
  if (kind === "wrong-workflow") path = path.replace("workflows/read", "workflows/other");
  if (kind === "wrong-mode") path = path.replace("async-read", "async-operation");
  if (kind === "malformed") path = path.replace("read-job-fixture-001", "short");
  if (kind === "override") path += "&actorId=actor";
  if (kind === "other-account") {
    await s.repository.mutate(state => { state.users.other = { ...state.users.actor!, id: "other" }; });
    headers = { authorization: `Bearer ${jwt.sign({}, s.services.config.jwtSecret, { subject: "other", expiresIn: 3600 })}` };
  }
  if (kind === "revoked") await s.repository.mutate(state => { state.users.actor!.permissionOverrides = []; state.roles[state.users.actor!.roleId]!.permissions = ["workflow:run"]; });
  if (kind === "storage") vi.spyOn(s.repository, "readAuthoritative").mockRejectedValue(new Error("Uncertain image"));
  const lookup = await s.app.inject({ method: "GET", url: path, headers });
  expect(lookup.statusCode, lookup.body).toBe(["malformed", "override"].includes(kind) ? 400 : kind === "revoked" ? 403 : kind === "storage" ? 503 : 200);
  if (lookup.statusCode === 200) expect(lookup.json().data).toMatchObject({ outcome: "NOT_FOUND", executionId: null, noReplay: true });
  expect(Object.keys((await s.repository.snapshot()).executions)).toHaveLength(1); expect(s.callTool).not.toHaveBeenCalled();
});

test("read idempotent replay preserves validated numeric usage but filters secret fields", async () => {
  const s = await setup(); await s.seed(); vi.spyOn(readJobQueue(s.services), "kick").mockImplementation(() => {});
  const admitted = await s.run(queuedInput()); const id = admitted.json().data.id;
  await s.repository.mutate(state => { state.executions[id]!.tokens = { input: 11, output: 7, total: 18 }; (state.executions[id] as any).access_token = "private-token"; });
  const replay = await s.run(queuedInput()); expect(replay.statusCode, replay.body).toBe(202);
  expect(replay.json().data.tokens).toEqual({ input: 11, output: 7, total: 18 }); expect(replay.body).not.toMatch(/private-token|access_token|private-queue-secret/);
  expect(s.callTool).not.toHaveBeenCalled();
});

test("captured actor mismatch denies a queued run before any execution is saved", async () => {
  const s = await setup(); await s.seed();
  const denied = await s.run({ ...queuedInput(), expectedActorId: "other-account" });
  expect(denied.statusCode, denied.body).toBe(403); expect(denied.json().meta.code).toBe("RUN_ACTOR_CHANGED");
  expect(Object.keys((await s.repository.snapshot()).executions)).toHaveLength(0); expect(s.callTool).not.toHaveBeenCalled();
});
async function waitForTerminal(repository: Repository, id: string) {
  await vi.waitFor(async () => { expect((await repository.snapshot()).executions[id]?.status).not.toMatch(/^(PENDING|RUNNING)$/); }, { timeout: 3000, interval: 10 });
  await vi.waitFor(async () => { expect((await repository.snapshot()).readJobs[id]?.state).not.toBe("CLAIMED"); }, { timeout: 3000, interval: 10 });
  return (await repository.snapshot()).executions[id]!;
}

const oneQueuedRead = stringify({ name: "One read", description: "Bounded pool fixture", trigger: { type: "manual" }, steps: [{ id: "lookup", action: "finance.read", parameters: { id: "{{input.invoiceId}}" } }] });
async function admitAs(s: Awaited<ReturnType<typeof setup>>, actorId: string, inputId: string) {
  if (actorId !== "actor") await s.repository.mutate(state => { state.users[actorId] ??= { ...state.users.actor!, id: actorId, name: actorId, email: `${actorId}@example.test` }; });
  const headers = { authorization: `Bearer ${jwt.sign({}, s.services.config.jwtSecret, { subject: actorId, expiresIn: 3600 })}` };
  const response = await s.app.inject({ method: "POST", url: "/api/workflows/read/run", headers, payload: queuedInput(`read-pool-${inputId}-key`, { invoiceId: inputId, api_key: "private-queue-secret" }) });
  expect(response.statusCode, response.body).toBe(202); return response.json().data as Execution;
}

test("bounded workers execute another principal while one SDK read is held, with FIFO and actor fairness", async () => {
  const s = await setup({ mcpTimeoutMs: 10_000 }); await s.seed(oneQueuedRead);
  const queue = readJobQueue(s.services), kick = vi.spyOn(queue, "kick").mockImplementation(() => {});
  const admitted = [await admitAs(s, "actor", "a-first"), await admitAs(s, "actor", "a-second"), await admitAs(s, "actor-b", "b-first"), await admitAs(s, "actor-c", "c-first")];
  const waits = new Map(admitted.map(item => [String(item.workflowSnapshot!.input.invoiceId), barrier()]));
  let inFlight = 0, max = 0;
  s.callTool.mockImplementation(async (_name, args) => { inFlight++; max = Math.max(max, inFlight); await waits.get(String(args.id))!.promise; inFlight--; return { content: [], structuredContent: { id: args.id } }; });
  kick.mockRestore(); queue.kick();
  await vi.waitFor(() => { expect(s.callTool).toHaveBeenCalledTimes(2); }, { timeout: 3000 });
  expect(s.callTool.mock.calls.map(call => call[1].id)).toEqual(["a-first", "b-first"]);
  waits.get("b-first")!.release(); expect((await waitForTerminal(s.repository, admitted[2]!.id)).status).toBe("DONE");
  await vi.waitFor(() => { expect(s.callTool).toHaveBeenCalledTimes(3); }); expect(s.callTool.mock.calls[2]![1].id).toBe("c-first");
  waits.get("c-first")!.release(); await waitForTerminal(s.repository, admitted[3]!.id);
  expect((await s.repository.snapshot()).executions[admitted[1]!.id]!.status).toBe("PENDING");
  waits.get("a-first")!.release(); await waitForTerminal(s.repository, admitted[0]!.id);
  await vi.waitFor(() => { expect(s.callTool).toHaveBeenCalledTimes(4); }); expect(s.callTool.mock.calls[3]![1].id).toBe("a-second");
  waits.get("a-second")!.release(); await waitForTerminal(s.repository, admitted[1]!.id); expect(max).toBe(2);
  expect((await s.repository.snapshot()).readJobs[admitted[0]!.id]!.lease).toBeUndefined();
});

test.each([{ workers: 1, perActor: 1, sameActor: false, initial: 1 }, { workers: 2, perActor: 2, sameActor: true, initial: 2 }])("worker bounds are enforced for %j", async limits => {
  const s = await setup({ mcpTimeoutMs: 10_000, readWorkerConcurrency: limits.workers, readWorkerPerActor: limits.perActor }); await s.seed(oneQueuedRead);
  const queue = readJobQueue(s.services), kick = vi.spyOn(queue, "kick").mockImplementation(() => {});
  const first = await admitAs(s, "actor", "first"), second = await admitAs(s, limits.sameActor ? "actor" : "actor-b", "second"), held = barrier();
  s.callTool.mockImplementation(async (_name, args) => { await held.promise; return { content: [], structuredContent: { id: args.id } }; });
  kick.mockRestore(); queue.kick(); await vi.waitFor(() => { expect(s.callTool).toHaveBeenCalledTimes(limits.initial); });
  const state = await s.repository.snapshot(); expect(Object.values(state.readJobs).filter(job => job.state === "CLAIMED")).toHaveLength(limits.initial);
  if (limits.initial === 1) expect(state.executions[second.id]!.status).toBe("PENDING");
  held.release(); expect((await waitForTerminal(s.repository, first.id)).status).toBe("DONE"); expect((await waitForTerminal(s.repository, second.id)).status).toBe("DONE"); expect(s.callTool).toHaveBeenCalledTimes(2);
});

test.each(["lease", "actor", "assignment", "storage"])("final queued SDK entry denies %s changes after the intent acknowledgement", async change => {
  const persistence = change === "storage" ? new QueuePersistence() : undefined;
  const s = await setup({ roleId: "role_client", ...(persistence ? { persistence } : {}) }); await s.seed(oneQueuedRead);
  const original = s.repository.mutateExecution.bind(s.repository); let changed = false;
  vi.spyOn(s.repository, "mutateExecution").mockImplementation(async (id, mutation) => {
    const result = await original(id, mutation);
    if (!changed && await s.repository.read(state => state.executions[id]?.readProgress?.attempts.lookup?.status === "DISPATCH_INTENT")) {
      changed = true;
      if (change === "storage") {
        persistence!.commitBeforeFailure = true; persistence!.failWhen = () => true;
        await expect(s.repository.mutate(state => { state.users.actor!.status = "Disabled"; })).rejects.toThrow("acknowledgement");
      } else await s.repository.mutate(state => {
        if (change === "lease") state.readJobs[id]!.lease!.expiresAt = new Date(Date.now() + 300_000).toISOString();
        if (change === "actor") state.users.actor!.status = "Disabled";
        if (change === "assignment") state.workflows.read!.assignedUserIds = [];
      });
    }
    return result;
  });
  const admitted = (await s.run(queuedInput())).json().data; await waitForTerminal(s.repository, admitted.id);
  expect(changed).toBe(true); expect(s.callTool).not.toHaveBeenCalled();
  const state = await s.repository.snapshot(); expect(state.executions[admitted.id]!.status).not.toBe("DONE"); expect(state.executions[admitted.id]!.stepOutputs).toEqual({});
  expect(state.executionEvents[admitted.id]!.some(event => event.type === "node.completed")).toBe(false);
});

test("a sustained storage-health outage denies final SDK entry until explicit authoritative startup reconciliation", async () => {
  const persistence = new QueuePersistence(), s = await setup({ persistence }); await s.seed(oneQueuedRead);
  const original = s.repository.mutateExecution.bind(s.repository); let unavailable = false;
  vi.spyOn(s.repository, "mutateExecution").mockImplementation(async (id, mutation) => {
    const result = await original(id, mutation);
    if (!unavailable && await s.repository.read(state => state.executions[id]?.readProgress?.attempts.lookup?.status === "DISPATCH_INTENT")) {
      unavailable = true; persistence.probe = async () => { throw new Error("storage remains unavailable"); }; await s.repository.persistenceStatus();
    }
    return result;
  });
  const admitted = (await s.run(queuedInput())).json().data;
  await vi.waitFor(() => { expect(unavailable).toBe(true); }); await new Promise(resolve => setImmediate(resolve)); expect(s.callTool).not.toHaveBeenCalled();
  expect(await s.repository.persistenceStatus()).toEqual({ durable: true, healthy: false }); await expect(s.repository.readAuthoritative(() => true)).rejects.toThrow("unavailable");
  // No terminal write can truthfully be promised while storage is unavailable.
  // A fresh supervised queue reconciles the saved intent, never resumes it.
  persistence.probe = async () => {}; await s.repository.persistenceStatus(); await readJobQueue(s.services).stop(); await readJobQueue(s.services).start();
  const item = await waitForTerminal(s.repository, admitted.id); expect(item.status).toBe("RECOVERY_REQUIRED"); expect(item.readProgress?.attempts.lookup?.status).toBe("UNKNOWN"); expect(s.callTool).not.toHaveBeenCalled();
});

test("queued lease expiry during awaited broker policy prevents SDK entry and preserves a recovery outcome", async () => {
  const s = await setup({ readWorkerLeaseMs: 5000 }); await s.seed(oneQueuedRead); const entered = barrier(), unblock = barrier();
  s.services.validationGate = { validateAndIssueToken: async (action, source, actor) => { if (action === "ReadToolBroker") { entered.release(); await unblock.promise; } return s.validator.validateAndIssueToken(action, source, actor.role); } };
  const admitted = (await s.run(queuedInput())).json().data; await entered.promise;
  const timestamp = Date.now(), clock = vi.spyOn(Date, "now").mockReturnValue(timestamp + 5001);
  try { unblock.release(); const item = await waitForTerminal(s.repository, admitted.id); expect(item.status).toBe("RECOVERY_REQUIRED"); expect(item.readProgress?.attempts.lookup?.status).toBe("FAILED"); expect(s.callTool).not.toHaveBeenCalled(); }
  finally { clock.mockRestore(); }
});

test("an acknowledged heartbeat renews the exact private lease while a slow read is pending", async () => {
  const s = await setup({ readWorkerLeaseMs: 5000, mcpTimeoutMs: 10_000 }); await s.seed(oneQueuedRead); const entered = barrier(), unblock = barrier();
  s.callTool.mockImplementation(async () => { entered.release(); await unblock.promise; return { content: [], structuredContent: { id: "confirmed-after-renewal" } }; });
  const admitted = (await s.run(queuedInput())).json().data; await entered.promise;
  const before = (await s.repository.snapshot()).readJobs[admitted.id]!.lease!;
  await vi.waitFor(async () => { const after = (await s.repository.snapshot()).readJobs[admitted.id]!.lease!; expect(after.renewedAt).not.toBe(before.renewedAt); expect(after.leaseId).toBe(before.leaseId); expect(after.epoch).toBe(before.epoch); expect(after.seal).not.toBe(before.seal); }, { timeout: 3000 });
  unblock.release(); expect((await waitForTerminal(s.repository, admitted.id)).status).toBe("DONE"); expect(s.callTool).toHaveBeenCalledTimes(1);
});

test("lost heartbeat acknowledgement stops the worker, retains recovery evidence and rejects new admissions", async () => {
  const persistence = new QueuePersistence(), s = await setup({ persistence, readWorkerLeaseMs: 5000, mcpTimeoutMs: 10_000 }); await s.seed(oneQueuedRead); const entered = barrier(), unblock = barrier();
  s.callTool.mockImplementation(async () => { entered.release(); await unblock.promise; return { content: [], structuredContent: { id: "late-unconfirmed-answer" } }; });
  const admitted = (await s.run(queuedInput())).json().data; await entered.promise;
  persistence.commitBeforeFailure = true; persistence.failWhen = state => Object.values(state.readJobs).some(job => job.lease && job.lease.renewedAt !== job.lease.acquiredAt);
  const item = await waitForTerminal(s.repository, admitted.id); expect(item.status).toBe("RECOVERY_REQUIRED"); expect(item.readProgress?.attempts.lookup?.status).toBe("UNKNOWN");
  expect(s.callTool).toHaveBeenCalledTimes(1); expect(item.stepOutputs).toEqual({});
  const queue = readJobQueue(s.services); expect(() => queue.assertCapacity(persistence.state())).toThrow("unavailable");
  unblock.release(); await new Promise(resolve => setImmediate(resolve)); expect((await s.repository.snapshot()).executions[admitted.id]!.stepOutputs).toEqual({});
});

test("one uncertain renewal fences all concurrent principals without exposing either late SDK answer", async () => {
  const persistence = new QueuePersistence(), s = await setup({ persistence, readWorkerLeaseMs: 5000, mcpTimeoutMs: 10_000 }); await s.seed(oneQueuedRead);
  const queue = readJobQueue(s.services), kick = vi.spyOn(queue, "kick").mockImplementation(() => {}), unblock = barrier();
  const first = await admitAs(s, "actor", "first"), second = await admitAs(s, "actor-b", "second");
  s.callTool.mockImplementation(async () => { await unblock.promise; return { content: [], structuredContent: { id: "late-from-uncertain-generation" } }; });
  kick.mockRestore(); queue.kick(); await vi.waitFor(() => { expect(s.callTool).toHaveBeenCalledTimes(2); });
  persistence.commitBeforeFailure = true; persistence.failWhen = state => Object.values(state.readJobs).some(job => job.lease && job.lease.renewedAt !== job.lease.acquiredAt);
  for (const id of [first.id, second.id]) { const item = await waitForTerminal(s.repository, id); expect(item.status).toBe("RECOVERY_REQUIRED"); expect(item.readProgress?.attempts.lookup?.status).toBe("UNKNOWN"); expect(item.stepOutputs).toEqual({}); }
  unblock.release(); await new Promise(resolve => setImmediate(resolve)); expect(s.callTool).toHaveBeenCalledTimes(2);
  for (const id of [first.id, second.id]) expect((await s.repository.snapshot()).executions[id]!.stepOutputs).toEqual({});
});

test("shutdown fences every active slot and ignores late results instead of replaying either principal", async () => {
  const s = await setup({ mcpTimeoutMs: 10_000 }); await s.seed(oneQueuedRead); const queue = readJobQueue(s.services), kick = vi.spyOn(queue, "kick").mockImplementation(() => {}), unblock = barrier();
  const first = await admitAs(s, "actor", "first"), second = await admitAs(s, "actor-b", "second");
  s.callTool.mockImplementation(async () => { await unblock.promise; return { content: [], structuredContent: { id: "late-from-stopped-worker" } }; });
  kick.mockRestore(); queue.kick(); await vi.waitFor(() => { expect(s.callTool).toHaveBeenCalledTimes(2); }); await queue.stop();
  for (const id of [first.id, second.id]) {
    const item = await waitForTerminal(s.repository, id); expect(item.status).toBe("RECOVERY_REQUIRED"); expect(item.readProgress?.attempts.lookup?.status).toBe("UNKNOWN"); expect(item.readProgress?.epoch).toBe(3); expect(item.stepOutputs).toEqual({});
  }
  unblock.release(); await new Promise(resolve => setImmediate(resolve)); expect(s.callTool).toHaveBeenCalledTimes(2);
  for (const id of [first.id, second.id]) expect((await s.repository.snapshot()).executions[id]!.stepOutputs).toEqual({});
});

test("stopping an in-memory queue preserves the encrypted input key for a fresh queue's unclaimed jobs", async () => {
  const s = await setup(); await s.seed(oneQueuedRead); const first = readJobQueue(s.services), kick = vi.spyOn(first, "kick").mockImplementation(() => {});
  const admitted = (await s.run(queuedInput())).json().data; await first.stop(); kick.mockRestore();
  const second = readJobQueue(s.services); await second.start(); expect((await waitForTerminal(s.repository, admitted.id)).status).toBe("DONE"); expect(s.callTool).toHaveBeenCalledTimes(1);
});

test("async admission returns a run ID before held SDK completion; same key never dispatches twice", async () => {
  const s = await setup({ provider: true }); await s.seed(); const entered = barrier(), unblock = barrier();
  s.callTool.mockImplementationOnce(async () => { entered.release(); await unblock.promise; return { content: [], structuredContent: { id: "queued-result" } }; });
  const response = await s.run(queuedInput()); expect(response.statusCode, response.body).toBe(202);
  const admitted = response.json().data;
  expect(admitted.status).toBe("PENDING"); expect(admitted.id).toBeTruthy(); expect(response.body).not.toContain("private-queue-secret");
  await entered.promise;
  const duplicate = await s.run(queuedInput()); expect(duplicate.statusCode, duplicate.body).toBe(202); expect(duplicate.json().data.id).toBe(admitted.id);
  expect(s.callTool).toHaveBeenCalledTimes(1);
  const state = await s.repository.snapshot(); expect(state.readJobs[admitted.id]?.inputCiphertext).toBeTruthy();
  expect(state.readJobs[admitted.id]?.inputCiphertext).not.toContain("private-queue-secret");
  const list = await s.app.inject({ method: "GET", url: "/api/executions", headers: s.headers });
  expect(list.body).not.toContain("inputCiphertext"); expect(list.body).not.toContain("private-queue-secret");
  unblock.release(); const done = await waitForTerminal(s.repository, admitted.id);
  expect(done.status).toBe("DONE"); expect(s.callTool.mock.calls).toEqual([["invoice-read", { id: "queued-invoice", role: "admin" }], ["invoice-read", { id: "queued-result", role: "admin" }]]);
  expect((await s.repository.snapshot()).readJobs[admitted.id]?.inputCiphertext).toBeUndefined();
  expect((await s.run(queuedInput())).json().data.id).toBe(admitted.id); expect(s.callTool).toHaveBeenCalledTimes(2); expect(s.queryWithTools).not.toHaveBeenCalled();
});

test("same-key concurrent admission is atomic and changed inputs conflict", async () => {
  const s = await setup(); await s.seed(); const queue = readJobQueue(s.services), kick = vi.spyOn(queue, "kick").mockImplementation(() => {});
  const responses = await Promise.all([s.run(queuedInput()), s.run(queuedInput())]);
  expect(responses.map((response) => response.statusCode)).toEqual([202, 202]);
  expect(new Set(responses.map((response) => response.json().data.id)).size).toBe(1);
  expect(Object.keys((await s.repository.snapshot()).readJobs)).toHaveLength(1);
  expect((await s.run(queuedInput("read-job-fixture-001", { invoiceId: "other", api_key: "private-queue-secret" }))).statusCode).toBe(409);
  expect(s.callTool).not.toHaveBeenCalled(); kick.mockRestore();
});

test("a queued cancellation is terminal before worker claim and deletes private input", async () => {
  const s = await setup(); await s.seed(); const queue = readJobQueue(s.services), kick = vi.spyOn(queue, "kick").mockImplementation(() => {});
  const admitted = (await s.run(queuedInput())).json().data;
  const cancel = await s.app.inject({ method: "POST", url: `/api/executions/${admitted.id}/cancel`, headers: s.headers, payload: {} });
  expect(cancel.statusCode, cancel.body).toBe(200); expect(cancel.json().data.status).toBe("CANCELLED");
  expect((await s.repository.snapshot()).readJobs[admitted.id]).toMatchObject({ state: "FINISHED" });
  expect((await s.repository.snapshot()).readJobs[admitted.id]?.inputCiphertext).toBeUndefined();
  kick.mockRestore(); queue.kick(); await new Promise((resolve) => setImmediate(resolve)); expect(s.callTool).not.toHaveBeenCalled();
});

test.each(["disabled", "role", "assignment", "registry", "publication", "ciphertext", "endpoint", "credential", "role-map"])("queued %s change stops before SDK dispatch", async (change) => {
  const s = await setup({ roleId: "role_client" }); await s.seed(); const queue = readJobQueue(s.services), kick = vi.spyOn(queue, "kick").mockImplementation(() => {});
  const admitted = (await s.run(queuedInput())).json().data;
  await s.repository.mutate((state) => {
    if (change === "disabled") state.users.actor!.status = "Disabled";
    if (change === "role") state.users.actor!.roleId = "role_admin";
    if (change === "assignment") state.workflows.read!.assignedUserIds = [];
    if (change === "publication") state.versions.read = [];
    if (change === "ciphertext") state.readJobs[admitted.id]!.inputCiphertext = Buffer.from("tampered-input").toString("base64");
  });
  if (change === "registry") s.drift();
  if (change === "role-map") s.services.config.erpbridgeRoleMap.Client = "changed-client";
  if (["endpoint", "credential"].includes(change)) s.services.erpbridgeSession = await createErpbridgeMcpSession({
    baseURL: change === "endpoint" ? "https://other-bridge.example.test" : "https://bridge.example.test", token: change === "credential" ? "other-fixture-token" : "fixture-only", timeoutMs: 1000, validator: s.validator,
    sdkClient: { connect: async () => {}, close: async () => {}, listTools: s.listTools, callTool: s.callTool },
  });
  kick.mockRestore(); queue.kick(); const item = await waitForTerminal(s.repository, admitted.id);
  expect(item).toMatchObject({ status: "FAILED", failure: { failureCategory: "READ_JOB_PREPARATION_FAILED", toolWasCalled: false } }); expect(s.callTool).not.toHaveBeenCalled();
  expect(item.failure?.preparationStage).toBe(change === "ciphertext" ? "PRIVATE_INPUT" :
    ["endpoint", "credential", "role-map"].includes(change) ? "AUTHORITY_AND_CONNECTION" : "PUBLICATION");
});

test("queued worker executes pinned published source even if a different draft is edited later", async () => {
  const s = await setup(); await s.seed(); const queue = readJobQueue(s.services), kick = vi.spyOn(queue, "kick").mockImplementation(() => {});
  const admitted = (await s.run(queuedInput())).json().data;
  await s.repository.mutate((state) => { state.workflows.read!.yaml = yaml.replace("Daily read", "Changed draft"); state.workflows.read!.draftVersion = 2; });
  kick.mockRestore(); queue.kick(); const item = await waitForTerminal(s.repository, admitted.id);
  expect(item.status).toBe("DONE"); expect(item.workflowSnapshot?.yaml).toBe(yaml); expect(s.callTool).toHaveBeenCalledTimes(2);
});

test("connection role-map drift after a saved node cannot authorize a later queued read", async () => {
  const s = await setup(); await s.seed();
  s.callTool.mockImplementationOnce(async () => {
    s.services.config.erpbridgeRoleMap["Platform Admin"] = "changed-admin";
    return { content: [], structuredContent: { id: "first-saved" } };
  });
  const admitted = (await s.run(queuedInput())).json().data, item = await waitForTerminal(s.repository, admitted.id);
  expect(item.status).toBe("FAILED"); expect(item.stepOutputs?.lookup).toMatchObject({ structuredContent: { id: "first-saved" } });
  expect(item.readProgress?.attempts.details?.status).toBe("FAILED"); expect(s.callTool).toHaveBeenCalledTimes(1);
  expect((await s.repository.snapshot()).timelines[admitted.id]?.[1]).toMatchObject({ status: "FAILED", outcome: "FAILED" });
  expect((await s.repository.snapshot()).executionEvents[admitted.id]?.filter((event) => event.type === "node.dispatch_intent")).toHaveLength(1);
});

test("durable unclaimed job survives a repository/process restart with private input intact", async () => {
  const persistence = new QueuePersistence(), first = await setup({ persistence }); await first.seed();
  const kick = vi.spyOn(readJobQueue(first.services), "kick").mockImplementation(() => {});
  const admitted = (await first.run(queuedInput())).json().data; expect(admitted.readProgress.persistence).toBe("durable");
  await first.app.close(); kick.mockRestore();
  const second = await setup({ persistence }); await second.app.ready();
  const item = await waitForTerminal(second.repository, admitted.id);
  expect(item.status).toBe("DONE"); expect(first.callTool).not.toHaveBeenCalled(); expect(second.callTool.mock.calls[0]?.[1]).toMatchObject({ id: "queued-invoice" });
  const events = (await second.repository.snapshot()).executionEvents[admitted.id];
  const receipt = await second.app.inject({ method: "GET", url: "/api/workflows/read/run-receipts/read-job-fixture-001?mode=async-read", headers: second.headers });
  expect(receipt.statusCode, receipt.body).toBe(200); expect(receipt.json().data).toMatchObject({ outcome: "RECORDED", executionId: admitted.id, status: "DONE", noReplay: true });
  expect((await second.repository.snapshot()).executionEvents[admitted.id]).toEqual(events); expect(second.callTool).toHaveBeenCalledTimes(2);
  expect((await second.run(queuedInput())).json().data.id).toBe(admitted.id); expect(second.callTool).toHaveBeenCalledTimes(2);
});

test("shutdown fences in-flight job and restart never replays it", async () => {
  const persistence = new QueuePersistence(), first = await setup({ persistence }); await first.seed(); const entered = barrier(), unblock = barrier();
  first.callTool.mockImplementationOnce(async () => { entered.release(); await unblock.promise; return { content: [], structuredContent: { id: "late-old-worker" } }; });
  const admitted = (await first.run(queuedInput())).json().data; await entered.promise; await first.app.close();
  const image = persistence.state(); expect(image.executions[admitted.id]?.status).toBe("RECOVERY_REQUIRED"); expect(image.readJobs[admitted.id]?.state).toBe("RECOVERY_REQUIRED");
  unblock.release(); await new Promise((resolve) => setImmediate(resolve));
  const second = await setup({ persistence }); await second.app.ready();
  const item = (await second.repository.snapshot()).executions[admitted.id]!;
  expect(item.status).toBe("RECOVERY_REQUIRED"); expect(item.stepOutputs?.lookup).toBeUndefined(); expect(second.callTool).not.toHaveBeenCalled();
});

test("unenforced durable storage and missing async key reject without admission", async () => {
  const s = await setup({ persistence: new ReadPersistence() }); await s.seed();
  const rejected = await s.run(queuedInput()); expect(rejected.statusCode).toBe(503); expect(rejected.json().meta.code).toBe("READ_QUEUE_STORAGE_UNSUPPORTED");
  expect((await s.repository.snapshot()).readJobs).toEqual({}); expect(s.callTool).not.toHaveBeenCalled();
  const memory = await setup(); await memory.seed(); expect((await memory.run({ mode: "async-read", input: {} })).statusCode).toBe(400);
  expect((await memory.repository.snapshot()).executions).toEqual({});
});

test("read job bounds reject excessive input and keys before discovery or admission", async () => {
  const s = await setup(); await s.seed();
  let nested: Record<string, unknown> = {};
  for (let index = 0; index < 18; index++) nested = { child: nested };
  const requests = [
    { ...queuedInput(), idempotencyKey: "short" },
    { ...queuedInput(), idempotencyKey: "x".repeat(129) },
    { ...queuedInput(), input: { invoiceId: "x".repeat(64001) } },
    { ...queuedInput(), input: nested },
  ];
  expect((await Promise.all(requests.map((payload) => s.run(payload)))).map((response) => response.statusCode)).toEqual([400, 400, 413, 400]);
  expect((await s.repository.snapshot()).executions).toEqual({});
  expect(s.listTools).not.toHaveBeenCalled(); expect(s.callTool).not.toHaveBeenCalled();
});

test("bounded queue refuses a new job but preserves same-key lookup; queued retry is blocked", async () => {
  const s = await setup(); await s.seed(); const queue = readJobQueue(s.services);
  const kick = vi.spyOn(queue, "kick").mockImplementation(() => {});
  const admitted = (await s.run(queuedInput())).json().data;
  await s.repository.mutate((state) => {
    for (let index = 1; index < 100; index++) state.readJobs[`fixture-${index}`] = { ...state.readJobs[admitted.id]!, executionId: `fixture-${index}`, idempotencyScope: `fixture-${index}` };
  });
  const rejected = await s.run(queuedInput("read-job-new-fixture"));
  expect(rejected.statusCode).toBe(429); expect(rejected.json().meta.code).toBe("READ_QUEUE_FULL");
  expect((await s.run(queuedInput())).json().data.id).toBe(admitted.id);
  expect((await s.app.inject({ method: "POST", url: `/api/executions/${admitted.id}/retry`, headers: s.headers, payload: {} })).statusCode).toBe(409);
  expect(Object.keys((await s.repository.snapshot()).executions)).toHaveLength(1); expect(s.callTool).not.toHaveBeenCalled();
  // Invalid capacity-only fixture entries must never reach the worker.
  await s.repository.mutate((state) => { for (let index = 1; index < 100; index++) delete state.readJobs[`fixture-${index}`]; });
  kick.mockRestore();
});

test("same-key admission cannot silently bind a later publication", async () => {
  const s = await setup(); await s.seed(); const kick = vi.spyOn(readJobQueue(s.services), "kick").mockImplementation(() => {});
  await s.run(queuedInput());
  await s.repository.mutate((state) => { state.workflows.read!.publishedVersion = 2; state.versions.read!.push({ version: 2, artifactState: "PUBLISHED", yaml }); });
  const response = await s.run(queuedInput()); expect(response.statusCode).toBe(409); expect(response.json().meta.code).toBe("READ_JOB_KEY_CONFLICT");
  expect(Object.keys((await s.repository.snapshot()).executions)).toHaveLength(1); expect(s.callTool).not.toHaveBeenCalled(); kick.mockRestore();
});

test("an async in-flight cancellation retains the committed answer and prevents the next read", async () => {
  const s = await setup(); await s.seed(); const entered = barrier(), unblock = barrier();
  s.callTool.mockImplementationOnce(async () => { entered.release(); await unblock.promise; return { content: [], structuredContent: { id: "saved-after-cancellation" } }; });
  const admitted = (await s.run(queuedInput())).json().data; await entered.promise;
  const response = await s.app.inject({ method: "POST", url: `/api/executions/${admitted.id}/cancel`, headers: s.headers, payload: {} });
  expect(response.statusCode).toBe(202); expect(response.json().data.status).toBe("RUNNING");
  unblock.release(); const item = await waitForTerminal(s.repository, admitted.id);
  expect(item).toMatchObject({ status: "CANCELLED", stepOutputs: { lookup: { structuredContent: { id: "saved-after-cancellation" } } } });
  expect(s.callTool).toHaveBeenCalledTimes(1); expect((await s.repository.snapshot()).readJobs[admitted.id]?.inputCiphertext).toBeUndefined();
});

test("a crash image of a CLAIMED job retains confirmed nodes and never dispatches on restart", async () => {
  const persistence = new QueuePersistence(), first = await setup({ persistence }); await first.seed(); const entered = barrier(), unblock = barrier();
  first.callTool.mockImplementationOnce(async () => ({ content: [], structuredContent: { id: "first-saved" } }));
  first.callTool.mockImplementationOnce(async () => { entered.release(); await unblock.promise; return { content: [], structuredContent: { id: "old-late" } }; });
  const admitted = (await first.run(queuedInput())).json().data; await entered.promise;
  const crashImage = new QueuePersistence(); crashImage.payload = Buffer.from(persistence.payload!);
  const second = await setup({ persistence: crashImage }); await second.app.ready();
  const state = await second.repository.snapshot();
  expect(state.readJobs[admitted.id]?.state).toBe("RECOVERY_REQUIRED");
  expect(state.executions[admitted.id]).toMatchObject({ status: "RECOVERY_REQUIRED", readProgress: { attempts: { lookup: { status: "DONE" }, details: { status: "UNKNOWN" } } }, stepOutputs: { lookup: { structuredContent: { id: "first-saved" } } } });
  expect(second.callTool).not.toHaveBeenCalled();
  expect((await second.run(queuedInput())).json().data.id).toBe(admitted.id); expect(second.callTool).not.toHaveBeenCalled();
  await first.app.close(); unblock.release(); await new Promise((resolve) => setImmediate(resolve));
});

test("a ciphertext from another queued execution cannot substitute its inputs", async () => {
  const s = await setup(); await s.seed(); const queue = readJobQueue(s.services), kick = vi.spyOn(queue, "kick").mockImplementation(() => {});
  const first = (await s.run(queuedInput())).json().data;
  const second = (await s.run(queuedInput("another-read-job-001"))).json().data;
  await s.repository.mutate((state) => { state.readJobs[first.id]!.inputCiphertext = state.readJobs[second.id]!.inputCiphertext!; });
  await s.app.inject({ method: "POST", url: `/api/executions/${second.id}/cancel`, headers: s.headers, payload: {} });
  kick.mockRestore(); queue.kick(); const item = await waitForTerminal(s.repository, first.id);
  expect(item).toMatchObject({ status: "FAILED", failure: { toolWasCalled: false } }); expect(s.callTool).not.toHaveBeenCalled();
});

test.each(["QUEUED", "CLAIMED"])("lost %s acknowledgement fences dispatch and preserves admitted identity after reload", async (phase) => {
  const persistence = new QueuePersistence(), first = await setup({ persistence }); await first.seed();
  persistence.commitBeforeFailure = true;
  persistence.failWhen = (state) => Object.values(state.readJobs).some((job) => job.state === phase);
  const response = await first.run(queuedInput());
  expect(response.statusCode).toBe(phase === "QUEUED" ? 500 : 202);
  await vi.waitFor(async () => { expect((await first.repository.persistenceStatus()).healthy).toBe(false); }, { timeout: 3000, interval: 10 });
  const admitted = Object.values(persistence.state().executions)[0]!;
  expect(first.callTool).not.toHaveBeenCalled();
  const crashImage = new QueuePersistence(); crashImage.payload = Buffer.from(persistence.payload!);
  await first.repository.recoverPersistenceState(); await first.app.close();
  const second = await setup({ persistence: crashImage }); await second.app.ready();
  const item = phase === "QUEUED" ? await waitForTerminal(second.repository, admitted.id) : (await second.repository.snapshot()).executions[admitted.id]!;
  expect(item.status).toBe(phase === "QUEUED" ? "DONE" : "RECOVERY_REQUIRED");
  expect((await second.run(queuedInput())).json().data.id).toBe(admitted.id);
  expect(second.callTool).toHaveBeenCalledTimes(phase === "QUEUED" ? 2 : 0);
  expect(Object.keys((await second.repository.snapshot()).executions)).toHaveLength(1);
});

test("dispatch intent is persisted before the SDK; completed output is persisted before the following call", async () => {
  const persistence = new ReadPersistence(), s = await setup({ persistence }); await s.seed();
  s.callTool.mockImplementation(async () => {
    const record = Object.values(persistence.state().executions)[0]!;
    const nodeId = s.callTool.mock.calls.length === 1 ? "lookup" : "details";
    expect(record.readProgress?.attempts[nodeId]?.status).toBe("DISPATCH_INTENT");
    expect(persistence.state().executionEvents[record.id]?.at(-1)?.type).toBe("node.dispatch_intent");
    if (nodeId === "details") expect(record.stepOutputs?.lookup).toEqual({ content: [], structuredContent: { id: "first-result" } });
    return { content: [], structuredContent: { id: "first-result" } };
  });
  const response = await s.run(); expect(response.statusCode, response.body).toBe(200);
  const record = response.json().data;
  expect(record.readProgress).toMatchObject({ persistence: "durable", nextStepIndex: 2, lastSequence: 8 });
  expect(persistence.state().executionEvents[record.id]?.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
});

test("in-flight cancellation is a durable request, not a claim that the transport stopped", async () => {
  const s = await setup(); await s.seed(); const entered = barrier(), unblock = barrier();
  s.callTool.mockImplementationOnce(async () => { entered.release(); await unblock.promise; return { content: [], structuredContent: { id: "completed-in-flight" } }; });
  const running = s.run().then((response) => response); await entered.promise;
  const record = Object.values((await s.repository.snapshot()).executions)[0]!;
  expect(record.status).toBe("RUNNING"); expect(record.stepOutputs?.lookup).toBeUndefined();
  const cancel = () => s.app.inject({ method: "POST", url: `/api/executions/${record.id}/cancel`, headers: s.headers, payload: {} });
  const accepted = await cancel(); expect(accepted.statusCode, accepted.body).toBe(202);
  expect(accepted.json()).toMatchObject({ data: { status: "RUNNING" }, meta: { transportInterrupted: false } });
  expect((await cancel()).statusCode).toBe(202);
  expect((await s.repository.snapshot()).executionEvents[record.id]?.filter((event) => event.type === "run.cancel_requested")).toHaveLength(1);
  unblock.release(); const response = await running;
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().data).toMatchObject({ status: "CANCELLED", stepOutputs: { lookup: { structuredContent: { id: "completed-in-flight" } } } });
  expect(s.callTool).toHaveBeenCalledTimes(1);
  expect((await cancel()).statusCode).toBe(200);
});

test("cancellation during awaited policy work prevents the first dispatch and is not a failed tool call", async () => {
  const s = await setup(); await s.seed(); const entered = barrier(), unblock = barrier();
  s.services.validationGate = { validateAndIssueToken: async (action, source, actor) => {
    if (action === "ReadToolBroker") { entered.release(); await unblock.promise; }
    return s.validator.validateAndIssueToken(action, source, actor.role);
  } };
  const running = s.run().then((response) => response); await entered.promise;
  const record = Object.values((await s.repository.snapshot()).executions)[0]!;
  expect(record.readProgress?.attempts.lookup?.status).toBe("PREPARING");
  expect((await s.app.inject({ method: "POST", url: `/api/executions/${record.id}/cancel`, headers: s.headers, payload: {} })).statusCode).toBe(202);
  unblock.release(); const response = await running;
  expect(response.json().data.status).toBe("CANCELLED"); expect(s.callTool).not.toHaveBeenCalled();
  expect((await s.repository.snapshot()).timelines[record.id]?.[0]).toMatchObject({ status: "CANCELLED", outcome: "NOT_DISPATCHED" });
});

test.each(["DISPATCH_INTENT", "DONE"])("a failed %s save stops execution and reconciles without replay", async (phase) => {
  const persistence = new ReadPersistence(), s = await setup({ persistence }); await s.seed();
  persistence.failWhen = (state) => Object.values(state.executions).some((item) => item.readProgress?.attempts.lookup?.status === phase);
  const response = await s.run(); expect(response.statusCode, response.body).toBe(503); expect(response.json().meta.code).toBe("CHECKPOINT_NOT_COMMITTED");
  expect(s.callTool).toHaveBeenCalledTimes(phase === "DONE" ? 1 : 0);
  const restored = await Repository.open(persistence); await reconcileInterruptedExecutions(restored);
  const record = Object.values((await restored.snapshot()).executions)[0]!;
  expect(record.status).toBe("RECOVERY_REQUIRED");
  expect(record.readProgress?.attempts.lookup?.status).toBe(phase === "DONE" ? "UNKNOWN" : "FAILED");
  expect(record.stepOutputs?.lookup).toBeUndefined();
  expect((await restored.snapshot()).executionEvents[record.id]?.some((event) => event.type === "node.completed")).toBe(false);
});

test("a committed checkpoint with a lost acknowledgement is reloaded, not overwritten with the rolled-back aggregate", async () => {
  const persistence = new ReadPersistence(), s = await setup({ persistence }); await s.seed();
  persistence.commitBeforeFailure = true;
  persistence.failWhen = (state) => Object.values(state.executions).some((item) => item.readProgress?.attempts.lookup?.status === "DONE");
  const response = await s.run(); expect(response.statusCode).toBe(503); expect(s.callTool).toHaveBeenCalledTimes(1);
  const record = Object.values(persistence.state().executions)[0]!;
  expect(record).toMatchObject({ status: "RECOVERY_REQUIRED", readProgress: { nextStepIndex: 1, attempts: { lookup: { status: "DONE" } } }, stepOutputs: { lookup: { structuredContent: { id: "invoice-actual" } } } });
  expect(persistence.state().executionEvents[record.id]?.filter((event) => event.type === "node.completed")).toHaveLength(1);
});

test("event replay is paginated, monotonic and account-scoped; uncertain/running runs cannot be retried", async () => {
  const s = await setup(); await s.seed(); const response = await s.run(), id = response.json().data.id;
  const read = (query = "", headers = s.headers) => s.app.inject({ method: "GET", url: `/api/executions/${id}/events${query}`, headers });
  const first = await read("?after=0&limit=2"); expect(first.statusCode).toBe(200);
  expect(first.json().data).toMatchObject({ cursor: 2, lastSequence: 8, hasMore: true });
  const rest = await read("?after=2&limit=100"); expect(rest.json().data.events.map((event: { sequence: number }) => event.sequence)).toEqual([3, 4, 5, 6, 7, 8]);
  expect(JSON.stringify(rest.json().data.events)).not.toContain("invoice-requested");
  for (const query of ["?after=-1", "?after=9", "?limit=101", "?after=1.5", "?other=1"]) expect((await read(query)).statusCode).toBe(400);
  await s.repository.mutate((state) => { state.users.other = { ...state.users.actor!, id: "other", roleId: "role_client" }; state.executions[id]!.status = "RECOVERY_REQUIRED"; });
  const otherHeaders = { authorization: `Bearer ${jwt.sign({}, s.services.config.jwtSecret, { subject: "other" })}` };
  expect((await read("", otherHeaders)).statusCode).toBe(404);
  expect((await s.app.inject({ method: "POST", url: `/api/executions/${id}/cancel`, headers: otherHeaders, payload: {} })).statusCode).toBe(404);
  expect((await s.app.inject({ method: "POST", url: `/api/executions/${id}/retry`, headers: s.headers, payload: {} })).statusCode).toBe(409);
  expect(s.callTool).toHaveBeenCalledTimes(2);
});

test("a draft mutation during run preflight cannot rewrite the pinned source or pass publication checks", async () => {
  const s = await setup(); await s.seed(); const entered = barrier(), unblock = barrier();
  s.services.validationGate = { validateAndIssueToken: async (action, source, actor) => {
    if (action === "RunWorkflow") { entered.release(); await unblock.promise; }
    return s.validator.validateAndIssueToken(action, source, actor.role);
  } };
  const running = s.run().then((response) => response); await entered.promise;
  await s.repository.mutate((state) => { state.workflows.read!.yaml = yaml.replace("Daily read", "Concurrent draft"); state.workflows.read!.publishedVersion = 2; state.versions.read!.push({ version: 2, artifactState: "PUBLISHED", yaml: state.workflows.read!.yaml }); });
  unblock.release(); const response = await running;
  expect(response.statusCode, response.body).toBe(409); expect(s.callTool).not.toHaveBeenCalled(); expect((await s.repository.snapshot()).executions).toEqual({});
});

test("restart reconciliation preserves completed nodes, marks unacknowledged intent UNKNOWN, and fences stale callbacks", async () => {
  const persistence = new ReadPersistence(), s = await setup({ persistence }); await s.seed();
  const secondEntered = barrier(), unblock = barrier();
  s.callTool.mockImplementationOnce(async () => ({ content: [], structuredContent: { id: "first-durable-answer" } }));
  s.callTool.mockImplementationOnce(async () => { secondEntered.release(); await unblock.promise; return { content: [], structuredContent: { id: "late-second-answer" } }; });
  const running = s.run().then((response) => response); await secondEntered.promise;
  const crashImage = new ReadPersistence(); crashImage.payload = Buffer.from(persistence.payload!);
  const reopened = await Repository.open(crashImage); await reconcileInterruptedExecutions(reopened);
  const record = Object.values((await reopened.snapshot()).executions)[0]!;
  expect(record).toMatchObject({ status: "RECOVERY_REQUIRED", readProgress: { epoch: 2, nextStepIndex: 1, attempts: { lookup: { status: "DONE" }, details: { status: "UNKNOWN" } } }, stepOutputs: { lookup: { structuredContent: { id: "first-durable-answer" } } } });
  expect((await reopened.snapshot()).timelines[record.id]?.map((entry) => entry.status)).toEqual(["DONE", "UNKNOWN"]);
  const eventCount = (await reopened.snapshot()).executionEvents[record.id]!.length;
  await reconcileInterruptedExecutions(reopened);
  expect((await reopened.snapshot()).executionEvents[record.id]).toHaveLength(eventCount);
  // Same-repository generation change simulates a stale worker finishing later.
  await reconcileInterruptedExecutions(s.repository); unblock.release();
  const response = await running; expect(response.statusCode).toBe(503);
  const current = (await s.repository.snapshot()).executions[record.id]!;
  expect(current.stepOutputs?.details).toBeUndefined(); expect(current.readProgress?.epoch).toBe(2);
  expect(s.callTool).toHaveBeenCalledTimes(2);
});

test("failed completion of a later node does not discard an earlier saved answer", async () => {
  const persistence = new ReadPersistence(), s = await setup({ persistence }); await s.seed();
  persistence.failWhen = (state) => Object.values(state.executions).some((item) => item.readProgress?.attempts.details?.status === "DONE");
  const response = await s.run(); expect(response.statusCode).toBe(503); expect(s.callTool).toHaveBeenCalledTimes(2);
  const record = Object.values(persistence.state().executions)[0]!;
  expect(record.stepOutputs?.lookup).toEqual({ content: [], structuredContent: { id: "invoice-actual" } });
  expect(record.stepOutputs?.details).toBeUndefined();
  expect(record.readProgress?.attempts.details?.status).toBe("UNKNOWN");
  expect(record.finalOutput).toEqual(record.stepOutputs?.lookup);
});

test("cancellation control rechecks current assignment, and terminal completion is immutable", async () => {
  const s = await setup({ roleId: "role_client" }); await s.seed();
  const entered = barrier(), unblock = barrier();
  s.callTool.mockImplementationOnce(async () => { entered.release(); await unblock.promise; return { content: [], structuredContent: { id: "first" } }; });
  const running = s.run().then((response) => response); await entered.promise;
  const record = Object.values((await s.repository.snapshot()).executions)[0]!;
  await s.repository.mutate((state) => { state.workflows.read!.assignedUserIds = []; });
  expect((await s.app.inject({ method: "POST", url: `/api/executions/${record.id}/cancel`, headers: s.headers, payload: {} })).statusCode).toBe(404);
  expect((await s.repository.snapshot()).executions[record.id]!.readProgress?.cancellation).toBeUndefined();
  unblock.release(); await running; expect(s.callTool).toHaveBeenCalledTimes(1);
  await s.repository.mutate((state) => { state.workflows.read!.assignedUserIds = ["actor"]; });
  expect((await s.app.inject({ method: "POST", url: `/api/executions/${record.id}/cancel`, headers: s.headers, payload: {} })).statusCode).toBe(409);
});

test("a legacy worker without a compiled plan cannot advance or certify a forged v4 snapshot", async () => {
  const s = await setup(); await s.seed(); const response = await s.run(), id = response.json().data.id;
  await s.repository.mutate(state => { const item = state.executions[id]!; item.status = "RUNNING"; item.workflowSnapshot!.compilation!.schemaVersion = "workflow-read-ir/v4"; });
  const before = await s.repository.snapshot(), worker = new ReadCheckpoints(s.repository, id, 1, yaml);
  await expect(worker.preparing(2, "forged", "forged", new Date().toISOString())).rejects.toThrow("checkpoint could not be committed");
  await expect(worker.finish(false)).rejects.toThrow("checkpoint could not be committed");
  expect(await s.repository.snapshot()).toEqual(before); expect(s.callTool).toHaveBeenCalledTimes(2);
});

test("a worker cannot declare DONE when node checkpoints are incomplete", async () => {
  const s = await setup(); await s.seed(); const response = await s.run(), id = response.json().data.id;
  await s.repository.mutate((state) => { const item = state.executions[id]!; item.status = "RUNNING"; item.readProgress!.nextStepIndex = 0; item.readProgress!.attempts = {}; });
  await expect(new ReadCheckpoints(s.repository, id, 1, yaml).finish(false)).rejects.toThrow("checkpoint could not be committed");
  expect((await s.repository.snapshot()).executions[id]!.status).toBe("RUNNING");
  expect((await s.repository.snapshot()).executionEvents[id]).toHaveLength(8);
});

test("valid node IDs do not collide with inherited object members in checkpoint storage", async () => {
  const s = await setup(); await s.seed(stringify({ name: "Read", description: "Read one invoice", trigger: { type: "manual" }, steps: [{ id: "toString", action: "finance.read", parameters: { id: "invoice" } }] }));
  const response = await s.run(); expect(response.statusCode, response.body).toBe(200);
  expect(response.json().data.readProgress.attempts.toString.status).toBe("DONE"); expect(s.callTool).toHaveBeenCalledTimes(1);
});

test("legacy interrupted executions are unknown, not falsely declared failed or safe to replay", async () => {
  const s = await setup(); await s.seed(); const response = await s.run(), id = response.json().data.id;
  await s.repository.mutate((state) => { const item = state.executions[id]!; item.status = "RUNNING"; delete item.readProgress; delete state.executionEvents[id]; });
  await reconcileInterruptedExecutions(s.repository);
  const state = await s.repository.snapshot();
  expect(state.executions[id]).toMatchObject({ status: "RECOVERY_REQUIRED", failure: { failureCategory: "LEGACY_OUTCOME_UNKNOWN" } });
  expect(state.executionEvents[id]).toBeUndefined();
  expect(state.auditLogs.at(-1)?.actor).toEqual({ id: "system", name: "Restart reconciliation" });
  expect((await s.app.inject({ method: "POST", url: `/api/executions/${id}/retry`, headers: s.headers, payload: {} })).statusCode).toBe(409);
  expect(s.callTool).toHaveBeenCalledTimes(2);
});

test("authority revoked during preflight prevents creating a run, before SDK dispatch", async () => {
  const s = await setup(); await s.seed(); const entered = barrier(), unblock = barrier();
  s.services.validationGate = { validateAndIssueToken: async (action, source, actor) => {
    if (action === "RunWorkflow") { entered.release(); await unblock.promise; }
    return s.validator.validateAndIssueToken(action, source, actor.role);
  } };
  const running = s.run().then((response) => response); await entered.promise;
  await s.repository.mutate((state) => { state.users.actor!.status = "Disabled"; });
  unblock.release(); const response = await running;
  expect(response.statusCode).toBe(403); expect(response.json().meta.code).toBe("EXECUTION_AUTHORITY_CHANGED");
  expect(s.callTool).not.toHaveBeenCalled(); expect((await s.repository.snapshot()).executions).toEqual({});
});

test.each([false, true])("MCP timeout after saved first answer=%s records UNKNOWN, rejects late output and never replays", async (savedFirst) => {
  const s = await setup({ mcpTimeoutMs: 80 }); await s.seed();
  const entered = barrier(), unblock = barrier();
  if (savedFirst) s.callTool.mockImplementationOnce(async () => ({ content: [], structuredContent: { id: "confirmed-first" } }));
  s.callTool.mockImplementationOnce(async () => { entered.release(); await unblock.promise; return { content: [], structuredContent: { id: "unconfirmed-late" } }; });
  const admitted = (await s.run(queuedInput())).json().data; await entered.promise;
  const item = await waitForTerminal(s.repository, admitted.id), node = savedFirst ? "details" : "lookup";
  expect(item).toMatchObject({ status: "RECOVERY_REQUIRED", failure: { failureCategory: "READ_OUTCOME_UNKNOWN", failedStepId: node }, readProgress: { attempts: { [node]: { status: "UNKNOWN" } } } });
  expect(s.callTool).toHaveBeenCalledTimes(savedFirst ? 2 : 1);
  expect(s.services.erpbridgeSession!.available).toBe(false);
  if (savedFirst) expect(item.stepOutputs?.lookup).toEqual({ content: [], structuredContent: { id: "confirmed-first" } });
  else { expect(item.stepOutputs).toEqual({}); expect(item.finalOutput).toBeUndefined(); }
  const snapshot = await s.repository.snapshot();
  expect(snapshot.executionEvents[item.id]?.at(-1)?.type).toBe("run.recovery_required");
  expect((await s.run(queuedInput())).json().data.id).toBe(item.id);
  expect((await s.app.inject({ method: "POST", url: `/api/executions/${item.id}/retry`, headers: s.headers, payload: {} })).statusCode).toBe(409);
  unblock.release(); await new Promise(resolve => setImmediate(resolve));
  const after = await s.repository.snapshot();
  expect(after.executions[item.id]).toEqual(snapshot.executions[item.id]);
  expect(after.timelines[item.id]).toEqual(snapshot.timelines[item.id]);
  expect(after.executionEvents[item.id]).toEqual(snapshot.executionEvents[item.id]);
  expect(JSON.stringify(after.executions[item.id])).not.toContain("unconfirmed-late");
});

test("MCP discovery timeout fails preflight without an execution or cached readiness", async () => {
  const s = await setup({ mcpTimeoutMs: 30 }); await s.seed();
  s.listTools.mockImplementationOnce(() => new Promise(() => {}));
  const failed = await s.run(); expect(failed.statusCode).toBe(503);
  expect(failed.json().meta.code).toBe("ERPBRIDGE_DISCOVERY_FAILED");
  expect(s.services.erpbridgeSession!.available).toBe(false);
  expect((await s.run()).statusCode).toBe(503);
  expect(s.listTools).toHaveBeenCalledOnce(); expect(s.callTool).not.toHaveBeenCalled();
  expect((await s.repository.snapshot()).executions).toEqual({});
});
