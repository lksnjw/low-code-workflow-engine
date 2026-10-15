import { resolve } from "node:path";
import jwt from "jsonwebtoken";
import { afterEach, expect, test, vi } from "vitest";
import { Repository, type Execution, type PersistenceBackend } from "../src/repository/store.js";
import { buildApp } from "../src/http/app.js";
import { loadConfig } from "../src/config/config.js";
import { RegistryService } from "../src/registry/service.js";
import { RegistryValidator } from "../src/validator/registry-validator.js";
import { Executor } from "../src/runner/executor.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { capabilityContractHash } from "../src/registry/capability-admission.js";
import { canonicalJSONBytes, resolvedParameterHashBytes } from "../src/core/canonical-json.js";
import { workflowContentHash } from "../src/parser/workflow.js";
import { newReadProgress } from "../src/runner/read-checkpoints.js";
import { consumeRuntimeApproval, requestRuntimeApproval, runtimeApprovalPolicyHash, updateRuntimeApprovalPolicy, type RuntimeApprovalBinding } from "../src/runner/runtime-approvals.js";
import { splitFirestoreState, assembleFirestoreState } from "../src/storage/firestore-record-layout.js";
import { withoutSecretFields } from "../src/redact/secrets.js";
import { compileReadWorkflow, readCompilationReceipt } from "../src/workflows/compiled-read.js";
import { applyExecutionCheckpoint } from "../src/repository/execution-transaction.js";
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(apps.splice(0).map(app => app.close())); });
const hash = (value: unknown) => resolvedParameterHashBytes(canonicalJSONBytes(value));
const yaml = "name: Review fixture\ntrigger:\n  type: manual\nsteps:\n - id: lookup\n   action: demo.echo\n   parameters:\n    value: fixture\n";
const policy = { profile: "runtime-approval-policy/v1", baseRevision: 0, enabled: true, approverRoleIds: ["reviewer"], ttlSeconds: 300, separationOfDuties: true };
async function setup(persistence: PersistenceBackend | null = null) {
  const repository = await Repository.open(persistence);
  const config = loadConfig({ APP_ENV: "test", JWT_SECRET: "exact-approval-fixture-secret-at-least-32", STORAGE_DRIVER: "memory", STORAGE_ENCRYPTION_KEY: "x".repeat(32), MCP_MODE: "mock" });
  const registries = await RegistryService.load(resolve("tests/fixtures/tools.json"), resolve("tests/fixtures/rules.json"));
  const tool = { ...registries.snapshot().tools.find(tool => tool.name === "demo.echo")!, allowed_roles: ["Platform Admin"] };
  const pin = { capabilityId: "cap", revisionId: "revision", connectionId: "erpbridge-default", admissionVersion: 1, contractHash: capabilityContractHash(tool) };
  const plan = compileReadWorkflow(yaml, [tool], "Platform Admin", new Map([[tool.tool_id, pin]]));
  const validator = new RegistryValidator(registries, repository), executor = new Executor(new ToolRegistry(), validator);
  await repository.mutate(state => {
    state.roles.reviewer = { id: "reviewer", name: "Transaction reviewer", description: "Review only", permissions: ["execution:approve"], createdAt: new Date().toISOString() };
    for (const id of ["owner", "reviewer", "other", "second"]) state.users[id] = { id, name: id, email: `${id}@example.test`, roleId: id === "reviewer" || id === "second" ? "reviewer" : "role_admin",
      permissionOverrides: [], status: "Active", initials: "U", departmentId: null, lastLoginAt: null, createdAt: new Date().toISOString() };
    const owner = { id: "owner", name: "owner" }, now = new Date().toISOString();
    state.workflows.flow = { id: "flow", name: "Review fixture", description: "", owner, assignedUserIds: [], status: "Published", trigger: null, steps: 1, successRate: 0, lastRunAt: null,
      publishedVersion: 1, draftVersion: 1, tags: [], domainTags: [], canRun: true, createdAt: now, updatedAt: now, yaml, archived: false };
    const compilation = readCompilationReceipt(plan, hash("registry"), "PUBLICATION", "reviewed");
    state.versions.flow = [{ id: "published", version: 1, artifactState: "PUBLISHED", yaml, compiledRead: { receipt: compilation, plan, verifiedRole: "Platform Admin", compiledAt: now } }];
    state.executions.run = { id: "run", workflowId: "flow", workflowName: "Review fixture", status: "RUNNING", startedAt: now, completedAt: null, durationMs: 0, startedBy: owner,
      tokens: { input: 0, output: 0, total: 0 }, costUsd: 0, workflowSnapshot: { yaml, version: 1, contentHash: compilation.sourceHash, registryHash: compilation.registryHash, executionProfile: "sequential-read-v1", compilation, input: {} }, readProgress: newReadProgress(repository) };
    state.executions.run.readProgress!.attempts.lookup = { id: "lookup:first", nodeId: "lookup", stepIndex: 0, status: "PREPARING", startedAt: now };
    state.capabilityAdmissions.cap = { capabilityId: "cap", revisionId: "revision", version: 1, state: "AVAILABLE" };
    state.capabilityRevisions.revision = { capabilityId: "cap", connectionId: "erpbridge-default", connectionBinding: "a".repeat(64), contractHash: capabilityContractHash(tool), definition: tool };
  });
  const actor = (id: string) => repository.effectiveUser(id).then(user => user!);
  const ownerActor = await actor("owner");
  await repository.mutate(state => updateRuntimeApprovalPolicy(state, ownerActor, policy));
  const binding: RuntimeApprovalBinding = { executionId: "run", workflowId: "flow", nodeId: "lookup", invocationId: "lookup:first", operationKey: "operation-first",
    sourceHash: workflowContentHash(yaml), semanticHash: plan.semanticHash, connectionId: "erpbridge-default", connectionBinding: "a".repeat(64), capabilityId: "cap", capabilityRevision: "revision",
    admissionVersion: 1, contractHash: capabilityContractHash(tool), argumentHash: hash({ value: "fixture" }), requesterId: "owner", requesterRoleId: "role_admin", workerEpoch: 1,
    policyHash: await repository.read(state => runtimeApprovalPolicyHash(state, "owner")) };
  const app = await buildApp({ config, repository, registries, validator, executor }); apps.push(app);
  const headers = (id = "reviewer") => ({ authorization: `Bearer ${jwt.sign({}, config.jwtSecret, { subject: id, expiresIn: 3600 })}` });
  const request = (method: "GET" | "POST" | "PATCH", url: string, payload?: object, id = "reviewer") => app.inject({ method, url, headers: headers(id), ...(payload === undefined ? {} : { payload }) });
  const create = () => requestRuntimeApproval(repository, "run", binding, { value: "fixture" }, "Independent review of this exact fixture read");
  const command = async () => { const review = (await request("GET", "/api/executions/run?view=approval")).json().data.runtimeApproval; return { approvalId: review.id, baseVersion: review.version, reviewHash: review.reviewHash, decisionKey: "fixture-decision-0001", note: "Reviewed exact details" }; };
  return { repository, app, binding, actor, request, create, command };
}
test("canonical Super Admin explicitly confirms their own exact transaction, without automatic approval", async () => {
  const s = await setup(); await s.create();
  const view = (await s.request("GET", "/api/executions/run?view=approval", undefined, "owner")).json().data.runtimeApproval;
  expect(view).toMatchObject({ selfApprovalAllowed: true, canDecide: true, state: "PENDING", arguments: { value: "fixture" } });
  expect((await s.repository.snapshot()).executions.run!.runtimeApprovalSecret!.records[view.id]!.decision).toBeUndefined();
  const command = { approvalId: view.id, baseVersion: view.version, reviewHash: view.reviewHash, decisionKey: "admin-self-decision-01" };
  expect((await s.request("POST", "/api/executions/run/approve", command, "owner")).json().data).toMatchObject({ state: "APPROVED", canResume: false });
  expect((await s.request("POST", "/api/executions/run/approve", command, "owner")).json().data.replayed).toBe(true);
});

test("absent reviewer configuration has only a requester-scoped Super Admin fallback and is not globally saved", async () => {
  const s = await setup();
  await s.repository.mutate(state => { delete (state.settings.rbac as Record<string, unknown>).runtimeApprovalPolicy; });
  s.binding.policyHash = await s.repository.read(state => runtimeApprovalPolicyHash(state, "owner"));
  await s.create();
  const view = (await s.request("GET", "/api/executions/run?view=approval", undefined, "owner")).json().data.runtimeApproval;
  expect(view).toMatchObject({ selfApprovalAllowed: true, canDecide: true });
  expect((await s.request("GET", "/api/executions/run?view=approval")).statusCode).toBe(403);
  expect((await s.request("GET", "/api/executions/run?view=approval", undefined, "other")).statusCode).toBe(403);
  await expect(s.repository.read(state => runtimeApprovalPolicyHash(state, "reviewer"))).rejects.toThrow(/enabled exact runtime approval policy/);
  expect((await s.repository.snapshot()).settings.rbac).not.toHaveProperty("runtimeApprovalPolicy");
});

test("a role name or permission copy cannot acquire the canonical Super Admin self-approval exception", async () => {
  const s = await setup();
  await s.repository.mutate(state => {
    state.roles.copy = { ...state.roles.role_admin!, id: "copy" };
    state.users.owner!.roleId = "copy";
    (state.settings.rbac as { runtimeApprovalPolicy: { approverRoleIds: string[] } }).runtimeApprovalPolicy.approverRoleIds.push("copy");
  });
  s.binding.requesterRoleId = "copy";
  s.binding.policyHash = await s.repository.read(state => runtimeApprovalPolicyHash(state, "owner"));
  await s.create();
  expect((await s.request("GET", "/api/executions/run?view=approval", undefined, "owner")).statusCode).toBe(403);
  expect((await s.request("POST", "/api/executions/run/approve", await s.command(), "owner")).statusCode).toBe(403);
});

test("normal HTTP gives an independent review-only role minimal payload, exact approval and idempotent acknowledgement, never execution", async () => {
  const s = await setup(); await s.create();
  const review = await s.request("GET", "/api/executions/run?view=approval"); expect(review.statusCode).toBe(200);
  expect(review.json().data.runtimeApproval).toMatchObject({ state: "PENDING", toolName: "demo.echo", remoteToolName: "demo.echo", arguments: { value: "fixture" }, canDecide: true, canResume: false });
  for (const key of ["workflowSnapshot", "stepOutputs", "runtimeApprovalSecret", "logs"]) expect(review.json().data).not.toHaveProperty(key);
  expect((await s.request("GET", "/api/executions/run")).statusCode).toBe(404);
  expect((await s.request("GET", "/api/executions/run/logs")).statusCode).toBe(403);
  expect((await s.request("GET", "/api/executions/run", undefined, "owner")).body).not.toContain("runtimeApprovalSecret");
  const command = await s.command(), first = await s.request("POST", "/api/executions/run/approve", command);
  expect(first.statusCode).toBe(200); expect(first.json().data).toMatchObject({ state: "APPROVED", executionStatus: "BLOCKED", canResume: false, replayed: false });
  const events = (await s.repository.snapshot()).executionEvents.run!.length;
  expect((await s.request("POST", "/api/executions/run/approve", command)).json().data.replayed).toBe(true);
  expect((await s.repository.snapshot()).executionEvents.run).toHaveLength(events);
  expect((await s.request("POST", "/api/executions/run/approve", { ...command, note: "Different" })).statusCode).toBe(409);
  expect((await s.request("POST", "/api/executions/run/reject", command)).statusCode).toBe(409);
  expect((await s.request("POST", "/api/executions/run/approve", command, "second")).statusCode).toBe(409);
});

test("approval administration is current settings-scoped metadata only and makes no mutation or authorization grant", async () => {
  const s = await setup(), before = await s.repository.snapshot();
  const response = await s.request("GET", "/api/settings/runtime-approval-policy", undefined, "owner");
  expect(response.statusCode, response.body).toBe(200); expect(response.json().data).toMatchObject({ profile: "runtime-approval-administration/v1", revision: 1,
    policy: { profile: policy.profile, approverRoleIds: ["reviewer"], separationOfDuties: true }, canManage: true, memoryOnly: true, canExecute: false });
  expect(response.json().data.roles).toContainEqual({ id: "reviewer", name: "Transaction reviewer", eligible: true });
  expect(response.body).not.toMatch(/"(?:users|passwordHashes|arguments|auditLogs|execution|permissions|runtimeApprovalSecret)":/);
  expect(await s.repository.snapshot()).toEqual(before);
  expect((await s.request("GET", "/api/settings/runtime-approval-policy")).statusCode).toBe(403);
  expect((await s.app.inject({ method: "GET", url: "/api/settings/runtime-approval-policy" })).statusCode).toBe(401);
});

test("unconfigured policy is explicit, not an editable fake saved default or automatic reviewer assignment", async () => {
  const s = await setup(); await s.repository.mutate(state => { delete (state.settings.rbac as Record<string, unknown>).runtimeApprovalPolicy; });
  const before = await s.repository.snapshot(), view = (await s.request("GET", "/api/settings/runtime-approval-policy", undefined, "owner")).json().data;
  expect(view).toMatchObject({ policy: null, revision: 0, canManage: true }); expect(await s.repository.snapshot()).toEqual(before);
  expect((await s.request("PATCH", "/api/settings/rbac", { runtimeApprovalPolicy: { ...policy, approverRoleIds: [] } }, "owner")).statusCode).toBe(422);
  expect((await s.repository.snapshot()).roles).toEqual(before.roles);
});

test("revoked selected reviewer roles stay visible as ineligible and cannot silently gain permission on save", async () => {
  const s = await setup(); await s.repository.mutate(state => { state.roles.reviewer!.permissions = []; });
  const view = (await s.request("GET", "/api/settings/runtime-approval-policy", undefined, "owner")).json().data;
  expect(view.roles).toContainEqual({ id: "reviewer", name: "Transaction reviewer", eligible: false });
  expect((await s.request("PATCH", "/api/settings/rbac", { runtimeApprovalPolicy: { ...policy, baseRevision: 1 } }, "owner")).statusCode).toBe(422);
  expect((await s.repository.snapshot()).roles.reviewer!.permissions).toEqual([]);
});

test("malformed saved policies and query overrides fail instead of becoming editable defaults", async () => {
  const s = await setup();
  for (const query of ["?actorId=owner", "?revision=0", "?enabled=true&enabled=false"]) expect((await s.request("GET", `/api/settings/runtime-approval-policy${query}`, undefined, "owner")).statusCode).toBe(400);
  await s.repository.mutate(state => { (state.settings.rbac as Record<string, unknown>).runtimeApprovalPolicy = { ...policy, revision: 1, separationOfDuties: false }; });
  const bad = await s.request("GET", "/api/settings/runtime-approval-policy", undefined, "owner"); expect(bad.statusCode).toBe(409); expect(bad.json().data).toBeNull();
});

test("settings readers can inspect but only a current Platform Admin can change exact approval policy", async () => {
  const s = await setup(); await s.repository.mutate(state => { state.roles.reader = { ...state.roles.reviewer!, id: "reader", name: "Settings reader", permissions: ["settings:manage"] }; state.users.other!.roleId = "reader"; });
  expect((await s.request("GET", "/api/settings/runtime-approval-policy", undefined, "other")).json().data.canManage).toBe(false);
  expect((await s.request("PATCH", "/api/settings/rbac", { runtimeApprovalPolicy: { ...policy, baseRevision: 1 } }, "other")).statusCode).toBe(403);
  await s.repository.mutate(state => { state.roles.reader!.permissions = []; });
  expect((await s.request("GET", "/api/settings/runtime-approval-policy", undefined, "other")).statusCode).toBe(403);
});

test("a saved policy change invalidates an earlier exact wait instead of approving or dispatching it", async () => {
  const s = await setup(); await s.create(); const command = await s.command();
  expect((await s.request("PATCH", "/api/settings/rbac", { runtimeApprovalPolicy: { ...policy, baseRevision: 1, ttlSeconds: 600 } }, "owner")).statusCode).toBe(200);
  const review = (await s.request("GET", "/api/executions/run?view=approval")).json().data.runtimeApproval;
  expect(review.canDecide).toBe(false); expect(review.unavailable).toMatch(/policy/i);
  expect((await s.request("POST", "/api/executions/run/approve", command)).statusCode).toBe(409);
  const run = (await s.repository.snapshot()).executions.run!; expect(run.runtimeApprovalSecret!.records[command.approvalId]!.decision).toBeUndefined();
});

test("lost durable policy save ACK fences old settings, reload preserves one revision and a stale request cannot write twice", async () => {
  let stored: Buffer | null = null, lose = false;
  const persistence: PersistenceBackend = { load: async () => stored, save: async bytes => { stored = Buffer.from(bytes); if (lose) { lose = false; throw new Error("Synthetic policy save acknowledgement loss"); } }, probe: async () => {}, close: async () => {} };
  const s = await setup(persistence), command = { ...policy, baseRevision: 1, ttlSeconds: 600 }; lose = true;
  const save = await s.request("PATCH", "/api/settings/rbac", { runtimeApprovalPolicy: command }, "owner"); expect(save.statusCode).toBe(503);
  const blocked = await s.request("GET", "/api/settings/runtime-approval-policy", undefined, "owner"); expect(blocked.statusCode).toBe(503); expect(blocked.json().data).toBeNull();
  await s.repository.recoverPersistenceState();
  expect((await s.request("GET", "/api/settings/runtime-approval-policy", undefined, "owner")).json().data).toMatchObject({ revision: 2, policy: { ttlSeconds: 600 } });
  expect((await s.request("PATCH", "/api/settings/rbac", { runtimeApprovalPolicy: command }, "owner")).statusCode).toBe(409);
  const state = await s.repository.snapshot(); expect(state.auditLogs.filter(item => item.action === "runtime_approval.policy_changed")).toHaveLength(2);
});

test("disabling approval policy blocks a new wait rather than bypassing independent approval", async () => {
  const s = await setup();
  expect((await s.request("PATCH", "/api/settings/rbac", { runtimeApprovalPolicy: { ...policy, baseRevision: 1, enabled: false }, enabled: false }, "owner")).statusCode).toBe(200);
  expect((await s.request("GET", "/api/settings/runtime-approval-policy", undefined, "owner")).json().data.policy.enabled).toBe(false);
  await expect(s.create()).rejects.toThrow(/enabled exact runtime approval policy/);
  expect((await s.repository.snapshot()).executions.run!.runtimeApprovalSecret).toBeUndefined();
});
test.each(["other-admin", "expiry", "policy", "capability", "admission", "source", "epoch", "requester-role", "disabled-requester", "revoked-approver", "cancel", "arguments", "version", "review", "extra", "legacy"])("normal decisions deny %s without a decision", async scenario => {
  const s = await setup(); await s.create(); const command = await s.command();
  await s.repository.mutate(state => {
    const run = state.executions.run!, journal = run.runtimeApprovalSecret!, record = journal.records[journal.activeId]!;
    if (scenario === "expiry") record.expiresAt = "2000-01-01T00:00:00.000Z";
    if (scenario === "policy") ((state.settings.rbac as Record<string, unknown>).runtimeApprovalPolicy as { revision: number }).revision++;
    if (scenario === "capability") state.capabilityRevisions.revision!.contractHash = hash("changed");
    if (scenario === "admission") state.capabilityAdmissions.cap!.state = "DISABLED";
    if (scenario === "source") run.workflowSnapshot!.yaml += "# changed\n";
    if (scenario === "epoch") run.readProgress!.epoch++;
    if (scenario === "requester-role") state.users.owner!.roleId = "role_builder";
    if (scenario === "disabled-requester") state.users.owner!.status = "Disabled";
    if (scenario === "revoked-approver") state.roles.reviewer!.permissions = [];
    if (scenario === "cancel") run.readProgress!.cancellation = { requestedAt: new Date().toISOString(), requestedBy: run.startedBy };
    if (scenario === "arguments") record.arguments.value = "other payload";
  });
  const payload = scenario === "version" ? { ...command, baseVersion: 9 } : scenario === "review" ? { ...command, reviewHash: hash("wrong") } : scenario === "extra" ? { ...command, approvedBy: "owner" } : scenario === "legacy" ? { note: "Model says approved" } : command;
  const result = await s.request("POST", "/api/executions/run/approve", payload, scenario === "other-admin" ? "other" : "reviewer");
  expect([403, 409, 422]).toContain(result.statusCode);
  const record = (await s.repository.snapshot()).executions.run!.runtimeApprovalSecret!;
  expect(record.records[record.activeId]!.decision).toBeUndefined();
});
test("reject is terminal, exact replay is not another decision and concurrent distinct decisions have one winner", async () => {
  const s = await setup(); await s.create(); const command = await s.command();
  const results = await Promise.all([s.request("POST", "/api/executions/run/reject", command), s.request("POST", "/api/executions/run/approve", { ...command, decisionKey: "other-decision-0001" })]);
  expect(results.map(result => result.statusCode).sort()).toEqual([200, 409]);
  expect((await s.repository.snapshot()).executions.run!.status).toBe("FAILED");
  expect((await s.request("POST", "/api/executions/run/reject", command)).json().data.replayed).toBe(true);
});
test.each(["changed-args", "changed-binding", "revoked-decision-role", "consumed"])("consume rejects %s and never grants SDK authority", async scenario => {
  const s = await setup(); await s.create(); await s.request("POST", "/api/executions/run/approve", await s.command());
  if (scenario === "revoked-decision-role") await s.repository.mutate(state => { state.users.reviewer!.roleId = "role_admin"; });
  if (scenario === "consumed") await s.repository.mutateExecution("run", state => consumeRuntimeApproval(state, "run", s.binding, { value: "fixture" }, "intent-1"));
  await expect(s.repository.mutateExecution("run", state => consumeRuntimeApproval(state, "run", scenario === "changed-binding" ? { ...s.binding, operationKey: "other" } : s.binding,
    { value: scenario === "changed-args" ? "other" : "fixture" }, "intent-2"))).rejects.toThrow();
  expect((await s.repository.snapshot()).executions.run!.status).toBe("BLOCKED");
});
test("private approval leaves survive canonical Firestore layout/reopen and are removed by all common public projections", async () => {
  let stored: Buffer | null = null;
  const persistence: PersistenceBackend = { readQueueDurability: "encrypted-single-writer", executionCheckpointDurability: "encrypted-record-transactions/v1",
    load: async () => stored, save: async bytes => { stored = Buffer.from(bytes); }, saveExecutionCheckpoint: async checkpoint => { stored = Buffer.from(JSON.stringify(applyExecutionCheckpoint(JSON.parse(stored!.toString()), checkpoint))); }, probe: async () => {}, close: async () => {} };
  const s = await setup(persistence); await s.create(); await s.request("POST", "/api/executions/run/approve", await s.command());
  const state = await s.repository.snapshot(), cells = splitFirestoreState(state);
  expect(cells.filter(cell => cell.path[0] === "runtime-approvals")).toHaveLength(1);
  expect(assembleFirestoreState(cells)).toEqual(state);
  expect(withoutSecretFields(state.executions.run)).not.toHaveProperty("runtimeApprovalSecret");
  const reopened = await Repository.open(persistence);
  expect((await reopened.snapshot()).executions.run!.runtimeApprovalSecret).toEqual(state.executions.run!.runtimeApprovalSecret);
  expect(JSON.stringify(state.auditLogs)).not.toContain("Reviewed exact details");
});
test.each(["bundle", "group"])("policy %s uses exact revisions and cannot disable separation of duties or use advisory policy toggles", async endpoint => {
  const s = await setup(), url = endpoint === "bundle" ? "/api/settings" : "/api/settings/rbac";
  const payload = (runtimeApprovalPolicy: unknown) => endpoint === "bundle" ? { rbac: { runtimeApprovalPolicy, enabled: false } } : { runtimeApprovalPolicy, enabled: false };
  const good = { ...policy, baseRevision: 1 };
  expect((await s.request("PATCH", url, payload(good), "owner")).statusCode).toBe(200);
  expect((await s.request("PATCH", url, payload(good), "owner")).statusCode).toBe(409);
  expect((await s.request("PATCH", url, payload({ ...good, baseRevision: 2, separationOfDuties: false }), "owner")).statusCode).toBe(422);
  expect(((await s.repository.snapshot()).settings.rbac as Record<string, unknown>).runtimeApprovalPolicy).toMatchObject({ enabled: true, revision: 2 });
});
test("real expiry advances the clock without changing the immutable review, then denies decision", async () => {
  const s = await setup(); await s.create(); const command = await s.command();
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.now() + 301000);
  const review = (await s.request("GET", "/api/executions/run?view=approval")).json().data.runtimeApproval;
  expect(review.reviewHash).toBe(command.reviewHash); expect(review.canDecide).toBe(false); expect(review.unavailable).toMatch(/expired/);
  expect((await s.request("POST", "/api/executions/run/approve", command)).statusCode).toBe(409);
});

test("an already approved decision expires before consumption without changing its review or appending an intent", async () => {
  const s = await setup(); await s.create(); const command = await s.command();
  expect((await s.request("POST", "/api/executions/run/approve", command)).statusCode).toBe(200);
  const before = await s.repository.snapshot();
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.now() + 301000);
  await expect(s.repository.mutateExecution("run", state => consumeRuntimeApproval(state, "run", s.binding, { value: "fixture" }, "expired-intent"))).rejects.toThrow(/expired/);
  const after = await s.repository.snapshot();
  expect(after.executions.run!.runtimeApprovalSecret).toEqual(before.executions.run!.runtimeApprovalSecret);
  expect(after.executionEvents.run).toEqual(before.executionEvents.run);
});

test("a corrupt event cursor cannot be silently repaired by granting a decision", async () => {
  const s = await setup(); await s.create(); const command = await s.command();
  await s.repository.mutate(state => { state.executions.run!.readProgress!.lastSequence += 10; });
  const before = await s.repository.snapshot();
  expect((await s.request("POST", "/api/executions/run/approve", command)).statusCode).toBe(503);
  const after = await s.repository.snapshot();
  expect(after.executions.run!.runtimeApprovalSecret).toEqual(before.executions.run!.runtimeApprovalSecret);
  expect(after.executionEvents.run).toEqual(before.executionEvents.run);
  expect(after.executions.run!.status).toBe("AWAITING_APPROVAL");
});
test("checkpoint producer denies changed resolved facts, hidden credential fields and already dispatched attempts", async () => {
  const s = await setup();
  await expect(requestRuntimeApproval(s.repository, "run", { ...s.binding, argumentHash: hash({ value: "changed" }) }, { value: "changed" }, "Wrong facts")).rejects.toThrow(/facts changed/);
  await expect(requestRuntimeApproval(s.repository, "run", { ...s.binding, argumentHash: hash({ value: "fixture", secret: "hidden" }) }, { value: "fixture", secret: "hidden" }, "Hidden arguments")).rejects.toThrow(/hidden credential/);
  await s.repository.mutate(state => { state.executions.run!.readProgress!.attempts.lookup!.status = "DISPATCH_INTENT"; });
  await expect(s.create()).rejects.toThrow(/invocation/); expect((await s.repository.snapshot()).executions.run!.runtimeApprovalSecret).toBeUndefined();
});
test("legacy unqualified durable storage cannot create or authorize a private transaction review", async () => {
  let stored: Uint8Array | null = null;
  const s = await setup({ load: async () => stored, save: async bytes => { stored = bytes; }, probe: async () => {}, close: async () => {} });
  await expect(s.create()).rejects.toThrow(/qualified encrypted scoped/);
  expect((await s.repository.snapshot()).executions.run!.runtimeApprovalSecret).toBeUndefined();
});
