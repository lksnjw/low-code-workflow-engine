import { resolve } from "node:path";
import jwt from "jsonwebtoken";
import { afterEach, expect, test, vi } from "vitest";
import { stringify } from "yaml";
import { loadConfig } from "../src/config/config.js";
import { buildApp } from "../src/http/app.js";
import { Repository } from "../src/repository/store.js";
import { RegistryService } from "../src/registry/service.js";
import { RegistryValidator } from "../src/validator/registry-validator.js";
import { Executor } from "../src/runner/executor.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { ProviderRuntime } from "../src/providers/runtime.js";
import { workflowContentHash, parseWorkflowYAMLStrict } from "../src/parser/workflow.js";
import type { Workflow } from "../src/models/schemas.js";
import { agentNodePatchSchema, analysisNodePatchSchema, applyWorkflowCommand, selectedNodePatchCommand, selectedNodePatchSchema, selectedNodePatchVersion, workflowCommandSchema } from "../src/workflows/commands.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });
const blueprint = { name: "Report", description: "Read report", trigger: { type: "manual" }, steps: [
  { id: "first", action: "demo.echo", parameters: { value: "original" }, condition: "{{input.enabled}}" },
  { id: "approval", kind: "approval", description: "Approve any transaction separately" },
  { id: "last", action: "demo.echo", parameters: { value: "tail" } },
] };
const yaml = stringify(blueprint);
async function setup(output: unknown = { parameters: { value: "proposed" } }, toolFile = "chat-read-tools.json") {
  const config = loadConfig({ APP_ENV: "test", JWT_SECRET: "commands-test-secret-at-least-32-bytes", STORAGE_DRIVER: "memory", MCP_MODE: "mock" });
  const repository = new Repository(null), now = new Date().toISOString();
  await repository.mutate((state) => {
    for (const [id, roleId] of [["admin", "role_admin"], ["client", "role_client"]]) state.users[id!] = { id: id!, name: id!, email: `${id}@example.test`, roleId: roleId!, permissionOverrides: [], status: "Active", initials: "A", departmentId: null, createdAt: now, lastLoginAt: null };
    state.workflows.report = { id: "report", name: "Report", description: "Read report", owner: { id: "admin", name: "Admin" }, assignedUserIds: [], status: "PENDING", trigger: { type: "manual" }, steps: 3, successRate: 0, lastRunAt: null,
      publishedVersion: 1, draftVersion: 1, tags: [], domainTags: [], canRun: true, createdAt: now, updatedAt: now, yaml, archived: false } satisfies Workflow;
    state.versions.report = [{ version: 1, artifactState: "PUBLISHED", yaml }];
    state.chats.chat = { id: "chat", ownerId: "admin", title: "Node changes", createdAt: now, updatedAt: now, messageCount: 0, messages: [] };
  });
  const registries = await RegistryService.load(resolve("tests/fixtures", toolFile), resolve("tests/fixtures/rules.json"));
  const validator = new RegistryValidator(registries, repository), executor = new Executor(new ToolRegistry(), validator);
  const fetchImplementation = vi.fn<typeof fetch>(async () => Response.json({ choices: [{ message: { content: JSON.stringify(output) } }] }));
  const providerRuntime = new ProviderRuntime(repository, executor, fetchImplementation);
  providerRuntime.activate({ id: "fixture", name: "Fixture", type: "openai_compatible", baseURL: "https://provider.example.test/v1", apiKey: "fixture", model: "fixture-v1", temperature: 0, timeoutMs: 1000,
    egressPolicy: { profile: "model-egress-policy/v1", approvedOrigin: "https://provider.example.test", runtimeAnalysisDataClasses: [], interactiveDataClasses: ["restricted"], reviewedAt: "2026-10-07T00:00:00.000Z", reviewedBy: { id: "admin", name: "admin" } } });
  const app = await buildApp({ config, repository, registries, validator, executor, providerRuntime }); apps.push(app);
  const headers = (id = "admin") => ({ authorization: `Bearer ${jwt.sign({}, config.jwtSecret, { algorithm: "HS256", subject: id, expiresIn: 3600 })}` });
  const edit = (command: unknown, baseVersion = 1, baseHash = workflowContentHash(yaml), actor = "admin") => app.inject({ method: "POST", url: "/api/workflows/report/commands", headers: headers(actor), payload: { baseVersion, baseHash, command } });
  const propose = (extra: Record<string, unknown> = {}) => app.inject({ method: "POST", url: "/api/workflows/report/node-proposals", headers: headers(), payload: { baseVersion: 1, baseHash: workflowContentHash(yaml), nodeId: "first", prompt: "Change the value only", sessionId: "chat", ...extra } });
  return { app, repository, headers, edit, propose, fetchImplementation };
}

test("protected commands persist exact saved structure, reject stale/unauthorized edits and remain non-runnable", async () => {
  const s = await setup();
  const source = stringify({ name: "Protected report", description: "Editable protected group", trigger: { type: "manual" }, steps: ["first", "last"].map(id => ({ id, action: "demo.echo", parameters: { value: id } })), metadata: { ownerNotes: "preserve" } });
  await s.repository.mutate(state => { state.workflows.report!.yaml = source; state.workflows.report!.steps = 2; state.versions.report = [{ version: 1, artifactState: "PUBLISHED", yaml: source }]; });
  const command = { type: "wrapProtected", nodeIds: ["first"], protectedId: "guard", onError: { code: "ERP_RESOURCE_NOT_FOUND" }, output: { schema: { type: "string" }, success: { kind: "literal", value: "found" }, handled: { kind: "ref", source: "nodeOutput", nodeId: "guard", path: ["error", "code"] } } };
  expect((await s.edit(command, 1, workflowContentHash(source), "client")).statusCode).toBe(403);
  const applied = await s.edit(command, 1, workflowContentHash(source));
  expect(applied.statusCode, applied.body).toBe(200);
  expect(applied.json().data).toMatchObject({ version: 2, publishedVersion: 1, canRun: false });
  const currentSource = applied.json().data.yaml;
  expect(parseWorkflowYAMLStrict(currentSource).steps).toEqual(parseWorkflowYAMLStrict(source).steps);
  expect((await s.edit(command, 1, workflowContentHash(source))).statusCode).toBe(409);
  const handler = await s.edit({ type: "addNode", node: { id: "fallback", action: "demo.echo", parameters: { value: "{{guard.error.code}}" } }, beforeNodeId: null, destination: { protectedId: "guard", scope: "handler" } }, 2, workflowContentHash(currentSource));
  expect(handler.statusCode, handler.body).toBe(200);
  const saved = handler.json().data, state = await s.repository.snapshot();
  expect(saved).toMatchObject({ version: 3, canRun: false });
  expect(state.versions.report![0]!.yaml).toBe(source);
  expect(state.versions.report!.at(-1)!.artifactState).toBe("DRAFT");
  expect(state.executions).toEqual({}); expect(s.fetchImplementation).not.toHaveBeenCalled();
  const readiness = await s.app.inject({ method: "GET", url: "/api/workflows/report/readiness", headers: s.headers() });
  expect(readiness.statusCode).toBe(200);
  expect(readiness.json().data.can_attempt_run).toBe(false);
  expect(readiness.json().data.executionProfile).toBe("protected-draft-runtime-pending");
  expect(readiness.json().data.operation_job_admission).toBe("unavailable");
  expect(readiness.json().data.authoring.protectedIssues).toEqual(["Protected group guard requires an exact reviewed ERP_RESOURCE_NOT_FOUND read-error source in its body"]);
  const publish = await s.app.inject({ method: "POST", url: "/api/workflows/report/publish", headers: s.headers(), payload: { baseVersion: 3, baseHash: workflowContentHash(saved.yaml) } });
  expect(publish.statusCode).toBeGreaterThanOrEqual(400);
  const run = await s.app.inject({ method: "POST", url: "/api/workflows/report/run", headers: s.headers(), payload: {} });
  expect(run.statusCode).toBeGreaterThanOrEqual(400);
  const proposal = await s.app.inject({ method: "POST", url: "/api/workflows/report/node-proposals", headers: s.headers(), payload: { baseVersion: 3, baseHash: workflowContentHash(saved.yaml), nodeId: "guard", prompt: "Update this handler", sessionId: "chat" } });
  expect(proposal.statusCode, proposal.body).toBe(422);
  expect(s.fetchImplementation).toHaveBeenCalledOnce(); expect((await s.repository.snapshot()).executions).toEqual({});
});

const protectedOutput = { schema: { type: "string" }, success: { kind: "ref", source: "nodeOutput", nodeId: "first", path: ["structuredContent", "value"] }, handled: { kind: "ref", source: "nodeOutput", nodeId: "guard", path: ["error", "code"] } };
async function protectedProposalSetup(patch: unknown = { output: protectedOutput }) {
  const s = await setup(patch, "condition-chat-tools.json");
  const source = stringify({ name: "Protected proposal", description: "Synthetic output proposal", trigger: { type: "manual" }, steps: ["first", "last"].map(id => ({ id, action: "demo.echo", parameters: { value: id } })), metadata: { ownerNotes: "preserve", controlFlow: { schemaVersion: "read-control-flow/v4", root: { kind: "sequence", nodes: [
    { kind: "protect", id: "guard", onError: { code: "ERP_RESOURCE_NOT_FOUND" }, body: { kind: "sequence", nodes: [{ kind: "action", nodeId: "first" }] }, handler: { kind: "sequence", nodes: [{ kind: "action", nodeId: "last" }] }, output: { ...protectedOutput, handled: { kind: "literal", value: "Explicit old fallback" } } },
  ] } } } });
  await s.repository.mutate(state => { state.workflows.report!.yaml = source; state.versions.report![0]!.yaml = source; });
  return { ...s, source, hash: workflowContentHash(source) };
}
test("direct protected proposal has exact path guidance and Apply preserves immutable contents and unrelated metadata", async () => {
  const s = await protectedProposalSetup(), response = await s.propose({ nodeId: "guard", baseHash: s.hash });
  expect(response.statusCode, response.body).toBe(200); const proposal = response.json().data;
  expect(proposal.validation.passed, JSON.stringify(proposal.validation)).toBe(true);
  expect(proposal.command).toEqual({ type: "updateProtected", nodeId: "guard", patch: { output: protectedOutput } });
  for (const field of ["id", "kind", "body", "handler", "onError"]) expect(proposal.after[field]).toEqual(proposal.before[field]);
  const body = JSON.parse(String(s.fetchImplementation.mock.calls[0]![1]?.body)), data = JSON.parse(body.messages[1].content);
  expect(body.messages[0].content).toContain("prompt/protected-group-patch/v1"); expect(data.tools).toEqual([]);
  expect(data.allowedProtectedSources.success.some((hint: any) => hint.binding.nodeId === "first")).toBe(true);
  expect(data.allowedProtectedSources.success.some((hint: any) => hint.binding.nodeId === "last")).toBe(false);
  expect(data.allowedProtectedSources.handled.some((hint: any) => hint.expression === "{{guard.error.code}}")).toBe(true);
  expect(data.allowedProtectedSources.handled.some((hint: any) => hint.binding.nodeId === "first")).toBe(false);
  expect((await s.repository.snapshot()).workflows.report!.yaml).toBe(s.source);
  const apply = (command = proposal.command, actor = "admin") => s.app.inject({ method: "POST", url: "/api/workflows/report/commands", headers: s.headers(actor), payload: { baseVersion: 1, baseHash: s.hash, proposalId: proposal.id, command } });
  expect((await apply({ ...proposal.command, patch: { output: { ...protectedOutput, handled: { kind: "literal", value: "tampered" } } } })).statusCode).toBe(409);
  expect((await apply(proposal.command, "client")).statusCode).toBe(403);
  const applied = await apply(); expect(applied.statusCode, applied.body).toBe(200); expect(applied.json().data).toMatchObject({ version: 2, canRun: false });
  const next = parseWorkflowYAMLStrict(applied.json().data.yaml), old = parseWorkflowYAMLStrict(s.source);
  expect(next.steps).toEqual(old.steps); expect(next.metadata!.ownerNotes).toBe("preserve");
  expect((next.metadata!.controlFlow as any).root.nodes[0]).toEqual(proposal.after);
  expect((await apply()).statusCode).toBe(409); expect((await s.repository.snapshot()).executions).toEqual({});
});
test.each([{ parameters: {} }, { output: protectedOutput, body: {} }, { output: protectedOutput, onError: { code: "ERP_RESOURCE_NOT_FOUND" } }, {}])("protected proposal cannot change path contents or policy %j", async patch => {
  const s = await protectedProposalSetup(patch), response = await s.propose({ nodeId: "guard", baseHash: s.hash });
  expect(response.statusCode).toBe(422); const state = await s.repository.snapshot();
  expect(state.chats.chat!.messages).toHaveLength(0); expect(state.workflows.report!.yaml).toBe(s.source); expect(state.executions).toEqual({});
});
test.each([
  { ...protectedOutput, handled: protectedOutput.success },
  { ...protectedOutput, success: protectedOutput.handled },
  { ...protectedOutput, schema: { type: "boolean" } },
])("invalid protected output scope/type remains a visible blocked proposal, never executable %j", async output => {
  const s = await protectedProposalSetup({ output }), response = await s.propose({ nodeId: "guard", baseHash: s.hash });
  expect(response.statusCode, response.body).toBe(200); const proposal = response.json().data; expect(proposal.validation.passed).toBe(false);
  const applied = await s.app.inject({ method: "POST", url: "/api/workflows/report/commands", headers: s.headers(), payload: { baseVersion: 1, baseHash: s.hash, proposalId: proposal.id, command: proposal.command } });
  expect(applied.statusCode).toBe(200); expect(applied.json().data).toMatchObject({ canRun: false, validation: { passed: false } });
  expect((await s.repository.snapshot()).executions).toEqual({});
});

test("scoped node edit preserves unrelated nodes and control flow and creates a nonrunnable draft", async () => {
  const s = await setup(); const response = await s.edit({ type: "updateNode", nodeId: "first", patch: { parameters: { value: "edited" } } });
  expect(response.statusCode, response.body).toBe(200);
  const record = response.json().data;
  expect(record).toMatchObject({ version: 2, publishedVersion: 1, canRun: false, validation: { passed: false } });
  const next = parseWorkflowYAMLStrict(record.yaml);
  expect(next.steps[0]).toEqual({ ...blueprint.steps[0], parameters: { value: "edited" } });
  expect(next.steps.slice(1)).toEqual(blueprint.steps.slice(1));
  const state = await s.repository.snapshot();
  expect(state.versions.report?.[0]?.yaml).toBe(yaml);
  expect(state.versions.report?.at(-1)?.artifactState).toBe("DRAFT");
  expect(state.workflows.report?.pendingGenerationApproval?.steps[0]?.stepId).toBe("approval");
  expect(state.executions).toEqual({}); expect(s.fetchImplementation).not.toHaveBeenCalled();
});

test("analysis node commands edit only the bounded analysis contract and add only an explicit flat analysis step", () => {
  const source = stringify({ name: "Analysis editing", description: "Author one bounded transformation", trigger: { type: "manual" }, steps: [
    { id: "first", action: "demo.echo", parameters: { value: "original" } },
    { id: "summary", kind: "analysis", description: "Summarize", instruction: "Return a short summary", input: "{{first.structuredContent.value}}",
      output_schema: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"], additionalProperties: false },
      data_class: "internal", model: "model-2026-10", max_input_items: 10, max_input_chars: 2000, max_output_tokens: 512 },
    { id: "last", action: "demo.echo", parameters: { value: "{{summary.structuredContent.summary}}" } },
  ] });
  const patch = analysisNodePatchSchema.parse({ instruction: "Return a concise reviewed summary", max_output_tokens: 256 });
  expect(selectedNodePatchVersion({ kind: "analysis" })).toBe("prompt/analysis-node-patch/v3");
  expect(selectedNodePatchCommand({ id: "summary", kind: "analysis" }, patch)).toEqual({ type: "updateAnalysis", nodeId: "summary", patch });
  const updated = parseWorkflowYAMLStrict(applyWorkflowCommand(source, { type: "updateAnalysis", nodeId: "summary", patch }));
  expect(updated.steps[1]).toMatchObject({ id: "summary", kind: "analysis", instruction: "Return a concise reviewed summary", input: "{{first.structuredContent.value}}",
    data_class: "internal", model: "model-2026-10", max_output_tokens: 256 });
  expect(updated.steps[0]).toEqual(parseWorkflowYAMLStrict(source).steps[0]); expect(updated.steps[2]).toEqual(parseWorkflowYAMLStrict(source).steps[2]);
  expect(() => applyWorkflowCommand(source, { type: "updateNode", nodeId: "summary", patch: { description: "Wrong command" } })).toThrow(/type does not match/);
  const node = { id: "second_summary", kind: "analysis" as const, instruction: "Classify", input: "{{first.structuredContent.value}}", data_class: "public" as const,
    output_schema: { type: "object", properties: { label: { type: "string" } }, required: ["label"], additionalProperties: false }, max_output_tokens: 128 };
  const added = parseWorkflowYAMLStrict(applyWorkflowCommand(source, { type: "addAnalysis", node, beforeNodeId: "last" }));
  expect(added.steps.map(step => step.id)).toEqual(["first", "summary", "second_summary", "last"]);
});

test("analysis patch schema rejects authority changes, floating models, workflow-input references and unsafe bounds", () => {
  const schema = selectedNodePatchSchema({ kind: "analysis" });
  for (const value of [{ action: "demo.echo" }, { model: "provider:latest" }, { input: "{{input.value}}" }, { max_output_tokens: 8193 }, {}])
    expect(schema.safeParse(value).success).toBe(false);
});

test.each(["analysis", "agent"] as const)("%s branch insertion is revisioned, undoable, nonrunnable and never calls a model", async kind => {
  for (const branch of ["then", "else"] as const) {
    const s = await setup(), node = { id: "branch_model", kind, instruction: "Summarize only acknowledged data", input: "{{first.structuredContent.value}}",
      data_class: "internal", output_schema: { type: "object", properties: { complete: { type: "boolean" } }, required: ["complete"], additionalProperties: false },
      ...(kind === "agent" ? { allowed_actions: ["demo.echo"], completion_predicate: { path: ["complete"], equals: true } } : {}) };
    const created = await s.edit({ type: "addCondition", conditionId: "gate", predicate: { kind: "literal", value: true }, beforeNodeId: "approval" });
    expect(created.statusCode, created.body).toBe(200); const empty = created.json().data;
    const command = { type: kind === "analysis" ? "addAnalysis" : "addAgent", node, beforeNodeId: null, destination: { conditionId: "gate", branch } };
    const response = await s.edit(command, empty.version, empty.contentHash);
    expect(response.statusCode, response.body).toBe(200); const saved = response.json().data;
    expect(saved).toMatchObject({ version: 3, publishedVersion: 1, canRun: false });
    const flow = parseWorkflowYAMLStrict(saved.yaml).metadata!.controlFlow as any;
    expect(flow.root.nodes[1][branch].nodes).toEqual([{ kind: "action", nodeId: node.id }]);
    expect(flow.root.nodes[1][branch === "then" ? "else" : "then"].nodes).toEqual([]);
    expect(parseWorkflowYAMLStrict(saved.yaml).steps.map(step => step.id)).toEqual(["first", node.id, "approval", "last"]);
    const state = await s.repository.snapshot(); expect(state.versions.report![0]!.yaml).toBe(yaml); expect(state.executions).toEqual({}); expect(s.fetchImplementation).not.toHaveBeenCalled();
    expect((await s.edit(command, empty.version, empty.contentHash)).statusCode).toBe(409);
    const undone = await s.edit({ type: "undoDraft", versionId: saved.editHistory.undoTarget }, saved.version, saved.contentHash);
    expect(undone.statusCode, undone.body).toBe(200); expect(undone.json().data.yaml).toBe(empty.yaml);
  }
});

test.each(["analysis", "agent"] as const)("%s insertion rejects missing/mismatched scope and forged destinations without mutating saved state", async kind => {
  const s = await setup(), created = (await s.edit({ type: "wrapNode", nodeId: "first", conditionId: "gate", predicate: { kind: "literal", value: true }, branch: "then" })).json().data;
  const node = { id: "branch_model", kind, instruction: "Summarize", input: "{{first.structuredContent.value}}", data_class: "internal",
    output_schema: { type: "object" }, ...(kind === "agent" ? { allowed_actions: ["demo.echo"], completion_predicate: { path: ["complete"], equals: true } } : {}) };
  const before = await s.repository.snapshot();
  for (const destination of [{ conditionId: "missing", branch: "then" }, { conditionId: "gate", branch: "else" }, { loopId: "gate", scope: "body" }, { conditionId: "gate", branch: "then", approved: true }]) {
    const response = await s.edit({ type: kind === "analysis" ? "addAnalysis" : "addAgent", node, beforeNodeId: "first", destination }, created.version, created.contentHash);
    expect([400, 422]).toContain(response.statusCode);
  }
  expect(await s.repository.snapshot()).toEqual(before); expect(s.fetchImplementation).not.toHaveBeenCalled();
  expect(workflowCommandSchema.safeParse({ type: kind === "analysis" ? "addAnalysis" : "addAgent", node, beforeNodeId: null, destination: { conditionId: "gate", branch: "unknown" } }).success).toBe(false);
});

test("selected analysis chat proposal uses its hardened narrow prompt and persists no workflow edit", async () => {
  const source = stringify({ name: "Analysis proposal", trigger: { type: "manual" }, steps: [
    { id: "first", action: "demo.echo", parameters: { value: "original" } },
    { id: "summary", kind: "analysis", instruction: "Summarize", input: "{{first.structuredContent.value}}", data_class: "internal",
      output_schema: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"], additionalProperties: false } },
  ] }), hash = workflowContentHash(source);
  const s = await setup({ instruction: "Return one concise summary", max_output_tokens: 256 });
  await s.repository.mutate(state => { state.workflows.report!.yaml = source; state.workflows.report!.steps = 2; state.versions.report = [{ version: 1, artifactState: "PUBLISHED", yaml: source }]; });
  const response = await s.propose({ nodeId: "summary", baseHash: hash, prompt: "Make the summary concise" });
  expect(response.statusCode, response.body).toBe(200); expect(response.json().data).toMatchObject({ nodeId: "summary", baseHash: hash,
    command: { type: "updateAnalysis", nodeId: "summary", patch: { instruction: "Return one concise summary", max_output_tokens: 256 } } });
  const request = JSON.parse(String(s.fetchImplementation.mock.calls[0]![1]?.body));
  expect(request.messages[0].content).toContain("TASK: ONE SELECTED ANALYSIS NODE PATCH");
  const state = await s.repository.snapshot(); expect(state.workflows.report!.yaml).toBe(source); expect(state.workflows.report!.draftVersion).toBe(1); expect(state.executions).toEqual({});
});

test("bounded agent commands edit only its allow-list, completion contract and budgets", () => {
  const source = stringify({ name: "Agent editing", description: "Author one bounded dynamic read", trigger: { type: "manual" }, steps: [
    { id: "first", action: "demo.echo", parameters: { value: "original" } },
    { id: "research", kind: "agent", description: "Research", instruction: "Gather the required evidence", input: "{{first.structuredContent.value}}",
      allowed_actions: ["demo.echo"], output_schema: { type: "object", properties: { summary: { type: "string" }, complete: { type: "boolean" } }, required: ["summary", "complete"], additionalProperties: false },
      completion_predicate: { path: ["complete"], equals: true }, data_class: "internal", model: "model-2026-10", max_input_items: 10, max_input_chars: 2000,
      max_output_tokens: 512, max_total_tokens: 2048, max_rounds: 3, max_tool_calls: 4, max_wall_time_ms: 30000, max_concurrency: 1 },
    { id: "last", action: "demo.echo", parameters: { value: "{{research.structuredContent.summary}}" } },
  ] });
  const patch = agentNodePatchSchema.parse({ instruction: "Gather only the reviewed evidence", max_rounds: 2, max_tool_calls: 2 });
  expect(selectedNodePatchVersion({ kind: "agent" })).toBe("prompt/agent-node-patch/v3");
  expect(selectedNodePatchCommand({ id: "research", kind: "agent" }, patch)).toEqual({ type: "updateAgent", nodeId: "research", patch });
  const updated = parseWorkflowYAMLStrict(applyWorkflowCommand(source, { type: "updateAgent", nodeId: "research", patch }));
  expect(updated.steps[1]).toMatchObject({ id: "research", kind: "agent", instruction: "Gather only the reviewed evidence", allowed_actions: ["demo.echo"],
    completion_predicate: { path: ["complete"], equals: true }, max_rounds: 2, max_tool_calls: 2, max_concurrency: 1 });
  expect(updated.steps[0]).toEqual(parseWorkflowYAMLStrict(source).steps[0]); expect(updated.steps[2]).toEqual(parseWorkflowYAMLStrict(source).steps[2]);
  expect(() => applyWorkflowCommand(source, { type: "updateNode", nodeId: "research", patch: { description: "Wrong command" } })).toThrow(/type does not match/);
  const schema = selectedNodePatchSchema({ kind: "agent" });
  for (const value of [{ action: "demo.echo" }, { model: "provider:latest" }, { input: "{{input.value}}" }, { max_rounds: 9 }, { max_concurrency: 2 },
    { completion_predicate: { path: [], equals: true } }, {}]) expect(schema.safeParse(value).success).toBe(false);
});

test("selected agent chat proposal uses the hardened agent prompt and keeps the draft unchanged", async () => {
  const source = stringify({ name: "Agent proposal", description: "Edit one bounded agent", trigger: { type: "manual" }, steps: [
    { id: "first", action: "demo.echo", parameters: { value: "original" } },
    { id: "research", kind: "agent", instruction: "Gather evidence", input: "{{first.structuredContent.value}}", allowed_actions: ["demo.echo"],
      data_class: "internal", output_schema: { type: "object", properties: { complete: { type: "boolean" } }, required: ["complete"], additionalProperties: false },
      completion_predicate: { path: ["complete"], equals: true }, max_concurrency: 1 },
  ] }), hash = workflowContentHash(source);
  const s = await setup({ instruction: "Gather only the exact reviewed evidence", max_rounds: 2 });
  await s.repository.mutate(state => { state.workflows.report!.yaml = source; state.workflows.report!.steps = 2; state.versions.report = [{ version: 1, artifactState: "PUBLISHED", yaml: source }]; });
  const response = await s.propose({ nodeId: "research", baseHash: hash, prompt: "Use at most two rounds" });
  expect(response.statusCode, response.body).toBe(200); expect(response.json().data).toMatchObject({ nodeId: "research", baseHash: hash,
    command: { type: "updateAgent", nodeId: "research", patch: { instruction: "Gather only the exact reviewed evidence", max_rounds: 2 } } });
  const request = JSON.parse(String(s.fetchImplementation.mock.calls[0]![1]?.body));
  expect(request.messages[0].content).toContain("TASK: ONE SELECTED BOUNDED AGENT NODE PATCH");
  expect(request.messages[1].content).not.toContain("send_email");
  const state = await s.repository.snapshot(); expect(state.workflows.report!.yaml).toBe(source); expect(state.workflows.report!.draftVersion).toBe(1); expect(state.executions).toEqual({});
});

const historyURL = (value: { version: number; contentHash: string }, extra = "") => `/api/workflows/report/versions?view=edit-history&baseVersion=${value.version}&baseHash=${value.contentHash}${extra}`;
test("whole-condition canvas moves save revisioned drafts, preserve approval/content and undo without provider or execution", async () => {
  const s = await setup();
  const wrapped = (await s.edit({ type: "wrapNode", nodeId: "first", conditionId: "gate", predicate: { kind: "literal", value: true }, branch: "then" })).json().data;
  const next = await s.edit({ type: "moveNode", nodeId: "gate", beforeNodeId: null }, wrapped.version, wrapped.contentHash);
  expect(next.statusCode, next.body).toBe(200); const moved = next.json().data;
  expect(moved).toMatchObject({ version: 3, canRun: false, publishedVersion: 1, editHistory: { undoDepth: 2 } });
  expect(parseWorkflowYAMLStrict(moved.yaml).steps).toEqual([blueprint.steps[1], blueprint.steps[2], blueprint.steps[0]]);
  const source = parseWorkflowYAMLStrict(moved.yaml), flow = source.metadata!.controlFlow as any;
  expect(flow.root.nodes.at(-1)).toMatchObject({ kind: "if", id: "gate", then: { nodes: [{ kind: "action", nodeId: "first" }] }, else: { nodes: [] } });
  const stale = await s.edit({ type: "moveNode", nodeId: "gate", beforeNodeId: "approval" }, wrapped.version, wrapped.contentHash);
  expect(stale.statusCode).toBe(409);
  const denied = await s.edit({ type: "moveNode", nodeId: "gate", beforeNodeId: "approval" }, moved.version, moved.contentHash, "client"); expect(denied.statusCode).toBe(403);
  const undone = await s.edit({ type: "undoDraft", versionId: moved.editHistory.undoTarget }, moved.version, moved.contentHash);
  expect(undone.statusCode).toBe(200); expect(undone.json().data.yaml).toBe(wrapped.yaml);
  const state = await s.repository.snapshot(); expect(state.versions.report![0]!.yaml).toBe(yaml);
  expect(state.workflows.report!.pendingGenerationApproval?.steps[0]?.stepId).toBe("approval");
  expect(state.executions).toEqual({}); expect(s.fetchImplementation).not.toHaveBeenCalled();
});

test("self/descendant subtree moves fail before saving a version or modifying an audit", async () => {
  const s = await setup(), wrapped = (await s.edit({ type: "wrapNode", nodeId: "first", conditionId: "gate", predicate: { kind: "literal", value: true }, branch: "then" })).json().data;
  const before = await s.repository.snapshot();
  for (const target of [{ beforeNodeId: "first" }, { beforeNodeId: null, destination: { conditionId: "gate", branch: "else" } }]) {
    const denied = await s.edit({ type: "moveNode", nodeId: "gate", ...target }, wrapped.version, wrapped.contentHash); expect(denied.statusCode).toBe(422);
  }
  const after = await s.repository.snapshot(); expect(after.versions).toEqual(before.versions); expect(after.workflows).toEqual(before.workflows); expect(after.auditLogs).toEqual(before.auditLogs);
});

test("saved history undo/redo restores exact content as new nonrunnable revisions and never edits publications or executes", async () => {
  const s = await setup();
  const changed = (await s.edit({ type: "updateNode", nodeId: "first", patch: { description: "Changed label" } })).json().data;
  expect(changed.editHistory).toMatchObject({ undoDepth: 1, redoDepth: 0 });
  const entries = (await s.app.inject({ method: "GET", url: historyURL(changed), headers: s.headers() })).json().data;
  expect(entries.entries).toHaveLength(2); expect(JSON.stringify(entries)).not.toContain('"yaml"');
  const source = await s.app.inject({ method: "GET", url: historyURL(changed, `&versionId=${entries.entries[1].id}&contentHash=${entries.entries[1].contentHash}`), headers: s.headers() });
  expect(source.json().data.yaml).toBe(yaml);
  const undone = (await s.edit({ type: "undoDraft", versionId: changed.editHistory.undoTarget }, changed.version, changed.contentHash)).json().data;
  expect(undone).toMatchObject({ version: 3, yaml, publishedVersion: 1, canRun: false, editHistory: { undoDepth: 0, redoDepth: 1 } });
  const redone = (await s.edit({ type: "redoDraft", versionId: undone.editHistory.redoTarget }, undone.version, undone.contentHash)).json().data;
  expect(redone).toMatchObject({ version: 4, yaml: changed.yaml, canRun: false, editHistory: { undoDepth: 1, redoDepth: 0 } });
  const state = await s.repository.snapshot(); expect(state.versions.report![0]!.yaml).toBe(yaml);
  expect(state.versions.report!.filter(value => value.change).map(value => (value.change as any).type)).toEqual(["baseline", "updateNode", "undoDraft", "redoDraft"]);
  expect(state.executions).toEqual({}); expect(s.fetchImplementation).not.toHaveBeenCalled();
});

test("editing after undo abandons only the redo cursor, preserving the abandoned saved revision for explicit restoration", async () => {
  const s = await setup(), change = (await s.edit({ type: "updateNode", nodeId: "first", patch: { description: "Branch A" } })).json().data;
  const undone = (await s.edit({ type: "undoDraft", versionId: change.editHistory.undoTarget }, change.version, change.contentHash)).json().data;
  const branch = (await s.edit({ type: "updateNode", nodeId: "first", patch: { description: "Branch B" } }, undone.version, undone.contentHash)).json().data;
  expect(branch.editHistory.redoDepth).toBe(0);
  const invalidRedo = await s.edit({ type: "redoDraft", versionId: undone.editHistory.redoTarget }, branch.version, branch.contentHash);
  expect(invalidRedo.statusCode).toBe(409);
  const old = (await s.repository.snapshot()).versions.report!.find(value => value.yaml === change.yaml)!;
  const restored = await s.edit({ type: "restoreVersion", versionId: old.id, contentHash: workflowContentHash(change.yaml) }, branch.version, branch.contentHash);
  expect(restored.statusCode, restored.body).toBe(200); expect(restored.json().data.yaml).toBe(change.yaml);
  expect(restored.json().data).toMatchObject({ version: 5, canRun: false });
});

test("stale base, wrong undo target and tampered history cannot overwrite the draft", async () => {
  const s = await setup(), changed = (await s.edit({ type: "updateNode", nodeId: "first", patch: { description: "Changed" } })).json().data;
  for (const [command, version, hash] of [
    [{ type: "undoDraft", versionId: changed.editHistory.undoTarget }, 1, workflowContentHash(yaml)],
    [{ type: "undoDraft", versionId: "wrong" }, changed.version, changed.contentHash],
    [{ type: "restoreVersion", versionId: changed.editHistory.undoTarget, contentHash: changed.contentHash }, changed.version, changed.contentHash],
  ] as const) expect((await s.edit(command, version, hash)).statusCode).toBe(409);
  await s.repository.mutate(state => { state.versions.report!.find(value => value.id === changed.editHistory.undoTarget)!.yaml = yaml.replace("original", "tampered"); });
  const before = await s.repository.snapshot(), denied = await s.edit({ type: "undoDraft", versionId: changed.editHistory.undoTarget }, changed.version, changed.contentHash);
  expect(denied.statusCode).toBe(409); expect(denied.json().meta.code).toBe("DRAFT_HISTORY_INVALID");
  expect((await s.repository.snapshot()).workflows).toEqual(before.workflows);
});

test("history rejects other workflow IDs, duplicate version IDs and missing or changed scopes", async () => {
  const s = await setup(), changed = (await s.edit({ type: "updateNode", nodeId: "first", patch: { description: "Saved" } })).json().data;
  await s.repository.mutate(state => { state.versions.other = [{ id: "foreign", workflowId: "other", version: 1, yaml, artifactState: "DRAFT" }]; });
  expect((await s.edit({ type: "restoreVersion", versionId: "foreign", contentHash: workflowContentHash(yaml) }, changed.version, changed.contentHash)).statusCode).toBe(409);
  expect((await s.app.inject({ method: "GET", url: historyURL(changed), headers: s.headers("client") })).statusCode).toBe(404);
  expect((await s.app.inject({ method: "GET", url: historyURL({ ...changed, version: 1 }), headers: s.headers() })).statusCode).toBe(409);
  await s.repository.mutate(state => { const base = state.versions.report!.find(value => value.id === changed.editHistory.undoTarget)!; state.versions.report!.push(structuredClone(base)); });
  const denied = await s.edit({ type: "undoDraft", versionId: changed.editHistory.undoTarget }, changed.version, changed.contentHash);
  expect(denied.statusCode).toBe(409); expect(denied.json().meta.code).toBe("DRAFT_HISTORY_INVALID");
});

test("older history is paged in bounded stable server order without private compilation or workflow source", async () => {
  const s = await setup(); let current = { version: 1, contentHash: workflowContentHash(yaml) };
  for (let index = 0; index < 24; index++) current = (await s.edit({ type: "updateNode", nodeId: "first", patch: { description: String(index) } }, current.version, current.contentHash)).json().data;
  const first = (await s.app.inject({ method: "GET", url: historyURL(current), headers: s.headers() })).json().data;
  expect(first.entries).toHaveLength(20); expect(first.total).toBe(25); expect(first.entries[0].version).toBe(25);
  const next = (await s.app.inject({ method: "GET", url: historyURL(current, `&beforeId=${first.nextBeforeId}`), headers: s.headers() })).json().data;
  expect(next.entries.map((value: any) => value.version)).toEqual([5, 4, 3, 2, 1]); expect(next.nextBeforeId).toBeNull();
  expect(JSON.stringify(first)).not.toMatch(/compiledRead|editHistory|"yaml"/);
});

test("legacy source replacement and version restore now record history and clear run readiness", async () => {
  const s = await setup();
  const updatedSource = stringify({ ...blueprint, description: "Source editor replacement" });
  const replacement = await s.app.inject({ method: "PUT", url: "/api/workflows/report/yaml", headers: s.headers(), payload: { yaml: updatedSource, baseVersion: 1, baseHash: workflowContentHash(yaml) } });
  expect(replacement.statusCode, replacement.body).toBe(200);
  const state = await s.repository.snapshot(), baseline = state.versions.report!.find(value => value.change && (value.change as any).type === "baseline")!;
  expect(state.workflows.report).toMatchObject({ draftVersion: 2, canRun: false });
  const restored = await s.app.inject({ method: "POST", url: `/api/workflows/report/restore/${baseline.id}`, headers: s.headers(), payload: { baseVersion: 2, baseHash: workflowContentHash(updatedSource) } });
  expect(restored.statusCode, restored.body).toBe(200); expect(restored.json().data).toMatchObject({ draftVersion: 3, canRun: false, publishedVersion: 1, validation: { passed: false } });
  expect(restored.json().message).toContain("blocked draft");
  expect((await s.repository.snapshot()).versions.report!.at(-1)?.change).toEqual({ type: "restoreVersion", sourceVersionId: baseline.id });
  expect((await s.repository.snapshot()).workflows.report!.yaml).toBe(yaml);
  expect(s.fetchImplementation).not.toHaveBeenCalled();
});

test("a lost command acknowledgement never claims the already-saved draft was unchanged or retries it", async () => {
  const s = await setup(), mutate = s.repository.mutate.bind(s.repository); let lost = false;
  vi.spyOn(s.repository, "mutate").mockImplementation(async mutation => {
    const result = await mutate(mutation);
    if (!lost && (await s.repository.snapshot()).workflows.report!.draftVersion === 2) { lost = true; throw new Error("Synthetic committed response lost"); }
    return result;
  });
  const response = await s.edit({ type: "updateNode", nodeId: "first", patch: { description: "Actually saved" } });
  expect(response.statusCode, response.body).toBe(503); expect(response.json().meta.code).toBe("DRAFT_SAVE_UNCONFIRMED");
  expect(response.json().message).not.toContain("nothing was changed");
  expect((await s.repository.snapshot()).workflows.report!.draftVersion).toBe(2);
  expect((await s.edit({ type: "updateNode", nodeId: "first", patch: { description: "Actually saved" } })).statusCode).toBe(409);
  expect((await s.repository.snapshot()).versions.report!.filter(value => value.version === 2)).toHaveLength(1);
});

async function conditionSetup(output: unknown = { predicate: { kind: "literal", value: false } }) {
  const s = await setup(output, "condition-chat-tools.json");
  const source = stringify({ name: "Conditional report", description: "Read the selected fixture path", trigger: { type: "manual" }, steps: ["first", "last"].map(id => ({ id, action: "demo.echo", parameters: { value: id } })),
    metadata: { controlFlow: { schemaVersion: "read-control-flow/v1", root: { kind: "sequence", nodes: [{ kind: "if", id: "gate", predicate: { kind: "literal", value: true }, then: { kind: "sequence", nodes: [{ kind: "action", nodeId: "first" }] }, else: { kind: "sequence", nodes: [{ kind: "action", nodeId: "last" }] } }] } } } });
  await s.repository.mutate(state => { state.workflows.report!.yaml = source; state.versions.report![0]!.yaml = source; });
  return { ...s, source, hash: workflowContentHash(source) };
}

async function collectionSetup(output: unknown = { maxItems: 2 }) {
  const s = await setup(output);
  const source = stringify({ name: "Collection report", description: "Read a bounded supplied list", trigger: { type: "manual", config: { inputSchema: { type: "object", properties: { rows: { type: "array", items: { type: "string" } } }, required: ["rows"], additionalProperties: false } } },
    steps: ["first", "last"].map(id => ({ id, action: "demo.echo", parameters: { value: "{{each.item}}" } })), metadata: { controlFlow: { schemaVersion: "read-control-flow/v3", root: { kind: "sequence", nodes: [{ kind: "foreach", id: "each", maxItems: 3,
      items: { schema: { type: "array", items: { type: "string" } }, value: { kind: "ref", source: "workflowInput", path: ["rows"] } }, body: { kind: "sequence", nodes: ["first", "last"].map(nodeId => ({ kind: "action", nodeId })) },
      collect: { schema: { type: "string" }, value: { kind: "ref", source: "nodeOutput", nodeId: "each", path: ["item"] } } }] } } } });
  await s.repository.mutate(state => { state.workflows.report!.yaml = source; state.versions.report![0]!.yaml = source; });
  return { ...s, source, hash: workflowContentHash(source) };
}

test("collection-owner proposal has a dedicated data-only scope and explicit partial apply preserves ID/body/publication", async () => {
  const s = await collectionSetup(), reply = await s.propose({ nodeId: "each", baseHash: s.hash });
  expect(reply.statusCode, reply.body).toBe(200); const proposal = reply.json().data;
  expect(proposal.command).toEqual({ type: "updateCollection", nodeId: "each", patch: { maxItems: 2 } });
  expect(proposal.validation.passed).toBe(true);
  expect((await s.repository.snapshot()).workflows.report!.yaml).toBe(s.source);
  const body = JSON.parse(String(s.fetchImplementation.mock.calls[0]![1]?.body)), data = JSON.parse(body.messages[1].content);
  expect(body.messages[0].content).toContain("ONE SELECTED COLLECTION PATCH"); expect(data.tools).toEqual([]);
  expect(data.allowedItemSources.map((value: any) => value.expression)).toEqual(["{{input}}", "{{input.rows}}"]);
  expect(data.allowedCollectSources.map((value: any) => value.expression)).toEqual(expect.arrayContaining(["{{each.item}}", "{{each.index}}"]));
  const applied = await s.app.inject({ method: "POST", url: "/api/workflows/report/commands", headers: s.headers(), payload: { baseVersion: 1, baseHash: s.hash, proposalId: proposal.id, command: proposal.command } });
  expect(applied.statusCode, applied.body).toBe(200);
  const original = parseWorkflowYAMLStrict(s.source) as any, next = parseWorkflowYAMLStrict(applied.json().data.yaml) as any;
  expect(next.steps).toEqual(original.steps); expect(next.metadata.controlFlow.root.nodes[0]).toEqual({ ...original.metadata.controlFlow.root.nodes[0], maxItems: 2 });
  const state = await s.repository.snapshot(); expect(state.versions.report![0]!.yaml).toBe(s.source); expect(state.workflows.report).toMatchObject({ draftVersion: 2, publishedVersion: 1, canRun: false });
  expect(state.executions).toEqual({}); expect(s.fetchImplementation).toHaveBeenCalledOnce();
});

test.each([{}, { body: { kind: "sequence", nodes: [] }, maxItems: 2 }, { id: "other", maxItems: 2 }, { kind: "action", maxItems: 2 },
  { action: "demo.echo" }, { parameters: { role: "admin" } }, { approved: true, maxItems: 2 }, { maxItems: 0 }, { maxItems: 101 }, { maxItems: 1.5 },
  { items: { schema: { type: "string" }, value: { kind: "literal", value: "not-a-list" } } }])("collection-owner model patch cannot enlarge scope or remove bounds: %j", async output => {
  const s = await collectionSetup(output), before = await s.repository.snapshot(), reply = await s.propose({ nodeId: "each", baseHash: s.hash });
  expect(reply.statusCode, reply.body).toBe(422); expect(reply.json().meta.code).toBe("NODE_PROPOSAL_INVALID");
  const state = await s.repository.snapshot(); expect(state.workflows).toEqual(before.workflows); expect(state.versions).toEqual(before.versions); expect(state.chats.chat!.messages).toEqual([]); expect(state.executions).toEqual({});
});

test.each([
  { items: { schema: { type: "array", items: { type: "string" } }, value: { kind: "ref", source: "nodeOutput", nodeId: "each", path: ["value"] } } },
  { collect: { schema: { type: "string" }, value: { kind: "ref", source: "nodeOutput", nodeId: "future", path: ["value"] } } },
  { items: { schema: { type: "array", items: { type: "boolean" } }, value: { kind: "array", items: [{ kind: "literal", value: true }] } } },
])("invalid collection bindings %j remain explicitly blocked in proposal, apply and refreshed readiness", async output => {
  const s = await collectionSetup(output), reply = await s.propose({ nodeId: "each", baseHash: s.hash });
  expect(reply.statusCode, reply.body).toBe(200); const proposal = reply.json().data;
  expect(proposal.validation).toMatchObject({ passed: false, schema_ok: false, failed_rules: expect.arrayContaining(["WORKSPACE_READ_COMPILATION"]) });
  expect(proposal.validation.errors.some((issue: string) => issue.startsWith("WORKSPACE_READ_COMPILATION:"))).toBe(true);
  expect((await s.repository.snapshot()).workflows.report!.yaml).toBe(s.source);
  const applied = await s.app.inject({ method: "POST", url: "/api/workflows/report/commands", headers: s.headers(), payload: { baseVersion: 1, baseHash: s.hash, proposalId: proposal.id, command: proposal.command } });
  expect(applied.statusCode, applied.body).toBe(200); expect(applied.json().data).toMatchObject({ canRun: false, validation: { passed: false } });
  const ready = await s.app.inject({ method: "GET", url: "/api/workflows/report/readiness", headers: s.headers() });
  expect(ready.json().data).toMatchObject({ can_attempt_run: false, validation: { passed: false } });
  const state = await s.repository.snapshot(); expect(state.workflows.report!.status).toBe("draft-unvalidated"); expect(state.executions).toEqual({});
});

test("return proposals receive no tool definitions, preserve other nodes and apply only exact owned output edits", async () => {
  const output = { schema: { type: "boolean" }, value: { kind: "literal", value: false } }, s = await conditionSetup({ output });
  const value = parseWorkflowYAMLStrict(s.source) as any; value.metadata.controlFlow.schemaVersion = "read-control-flow/v2";
  value.metadata.controlFlow.root.nodes.push({ kind: "return", id: "answer", output: { schema: { type: "boolean" }, value: { kind: "literal", value: true } } });
  const source = stringify(value), hash = workflowContentHash(source);
  await s.repository.mutate(state => { state.workflows.report!.yaml = source; });
  const response = await s.propose({ nodeId: "answer", baseHash: hash }); expect(response.statusCode, response.body).toBe(200);
  const proposal = response.json().data; expect(proposal.command).toEqual({ type: "updateReturn", nodeId: "answer", patch: { output } });
  const body = JSON.parse(String(s.fetchImplementation.mock.calls[0]![1]?.body)); expect(body.messages[0].content).toContain("ONE SELECTED RETURN PATCH"); expect(JSON.parse(body.messages[1].content).tools).toEqual([]);
  expect((await s.repository.snapshot()).workflows.report!.yaml).toBe(source);
  const applied = await s.app.inject({ method: "POST", url: "/api/workflows/report/commands", headers: s.headers(), payload: { baseVersion: 1, baseHash: hash, command: proposal.command, proposalId: proposal.id } });
  expect(applied.statusCode, applied.body).toBe(200); expect(parseWorkflowYAMLStrict(applied.json().data.yaml).steps).toEqual(value.steps); expect((await s.repository.snapshot()).executions).toEqual({});
});
test("manual conditional HTTP commands create a revision-bound draft and preserve the immutable publication", async () => {
  const s = await conditionSetup();
  const response = await s.edit({ type: "updateCondition", nodeId: "gate", patch: { predicate: { kind: "literal", value: false } } }, 1, s.hash);
  expect(response.statusCode, response.body).toBe(200); expect(response.json().data).toMatchObject({ version: 2, canRun: false, publishedVersion: 1 });
  const state = await s.repository.snapshot(); expect(state.versions.report![0]!.yaml).toBe(s.source);
  expect(parseWorkflowYAMLStrict(response.json().data.yaml).steps).toEqual(parseWorkflowYAMLStrict(s.source).steps);
  expect((await s.edit({ type: "updateCondition", nodeId: "gate", patch: { predicate: { kind: "literal", value: true } } }, 1, s.hash)).statusCode).toBe(409);
  expect((await s.edit({ type: "removeCondition", nodeId: "gate" }, 1, s.hash, "client")).statusCode).toBe(403);
  expect(s.fetchImplementation).not.toHaveBeenCalled(); expect(state.executions).toEqual({});
});
test("selected condition model proposals change only the predicate and acceptance matches the saved exact command", async () => {
  const s = await conditionSetup(), response = await s.propose({ nodeId: "gate", baseHash: s.hash });
  expect(response.statusCode, response.body).toBe(200);
  const proposal = response.json().data; expect(proposal.command).toEqual({ type: "updateCondition", nodeId: "gate", patch: { predicate: { kind: "literal", value: false } } });
  expect((await s.repository.snapshot()).workflows.report!.yaml).toBe(s.source);
  const body = JSON.parse(String(s.fetchImplementation.mock.calls[0]![1]?.body));
  expect(body.messages[0].content).toContain("ONE SELECTED CONDITION PATCH"); expect(body.messages[0].content).toContain("then/else branch contents and every other node are immutable");
  expect(JSON.parse(body.messages[1].content).tools).toEqual([]);
  const applied = await s.app.inject({ method: "POST", url: "/api/workflows/report/commands", headers: s.headers(), payload: { baseVersion: 1, baseHash: s.hash, command: proposal.command, proposalId: proposal.id } });
  expect(applied.statusCode, applied.body).toBe(200);
  expect(parseWorkflowYAMLStrict(applied.json().data.yaml).steps).toEqual(parseWorkflowYAMLStrict(s.source).steps);
  expect((await s.repository.snapshot()).executions).toEqual({});
});
const conditionMerge = { schema: { type: "string" }, then: { kind: "ref", source: "nodeOutput", nodeId: "first", path: ["structuredContent", "value"] }, else: { kind: "ref", source: "nodeOutput", nodeId: "last", path: ["structuredContent", "value"] } };
test.each([false, true])("selected condition chat proposes exact typed branch outputs with combined predicate edit=%s", async combined => {
  const patch = { merge: conditionMerge, ...(combined ? { predicate: { kind: "literal", value: false } } : {}) }, s = await conditionSetup(patch);
  const result = await s.propose({ nodeId: "gate", baseHash: s.hash }); expect(result.statusCode, result.body).toBe(200);
  const proposal = result.json().data, state = await s.repository.snapshot();
  expect(proposal.validation.passed, JSON.stringify(proposal.validation)).toBe(true);
  expect(proposal).toMatchObject({ status: "PROPOSED", command: { type: "updateCondition", nodeId: "gate", patch }, after: { merge: conditionMerge } });
  expect(proposal.after.then).toEqual(proposal.before.then); expect(proposal.after.else).toEqual(proposal.before.else); expect(proposal.after.id).toBe("gate");
  expect(state.workflows.report!.yaml).toBe(s.source); expect(state.versions.report).toHaveLength(1); expect(state.executions).toEqual({});
  const body = JSON.parse(String(s.fetchImplementation.mock.calls[0]![1]?.body)), guidance = JSON.parse(body.messages[1].content);
  expect(body.messages[0].content).toContain("prompt/condition-patch/v2"); expect(guidance.tools).toEqual([]);
  expect(guidance.allowedMergeSources.then.some((source: any) => source.binding.nodeId === "first")).toBe(true);
  expect(guidance.allowedMergeSources.then.some((source: any) => source.binding.nodeId === "last")).toBe(false);
  expect(guidance.allowedMergeSources.else.some((source: any) => source.binding.nodeId === "last")).toBe(true);
  const apply = (command = proposal.command, actor = "admin", hash = s.hash) => s.app.inject({ method: "POST", url: "/api/workflows/report/commands", headers: s.headers(actor), payload: { baseVersion: 1, baseHash: hash, proposalId: proposal.id, command } });
  expect((await apply({ ...proposal.command, patch: { ...patch, merge: null } })).statusCode).toBe(409);
  expect((await apply(proposal.command, "client")).statusCode).toBe(403);
  const applied = await apply(); expect(applied.statusCode, applied.body).toBe(200); expect(applied.json().data).toMatchObject({ version: 2, publishedVersion: 1, canRun: false, validation: { passed: true } });
  const next = parseWorkflowYAMLStrict(applied.json().data.yaml) as any, original = parseWorkflowYAMLStrict(s.source) as any;
  expect(next.steps).toEqual(original.steps); expect(next.metadata.controlFlow.schemaVersion).toBe("read-control-flow/v2");
  expect(next.metadata.controlFlow.root.nodes[0]).toEqual({ ...original.metadata.controlFlow.root.nodes[0], ...patch });
  const savedVersions = (await s.repository.snapshot()).versions.report;
  expect(savedVersions!.filter(item => item.version === 2)).toHaveLength(1);
  expect((await apply()).statusCode).toBe(409); expect((await s.repository.snapshot()).versions.report).toEqual(savedVersions); expect(s.fetchImplementation).toHaveBeenCalledOnce();
});

test("selected condition output removal uses null explicitly, preserves the predicate and previews the actual absence", async () => {
  const s = await conditionSetup({ merge: null }), original = parseWorkflowYAMLStrict(s.source) as any;
  original.metadata.controlFlow.schemaVersion = "read-control-flow/v2"; original.metadata.controlFlow.root.nodes[0].merge = conditionMerge;
  const source = stringify(original), hash = workflowContentHash(source); await s.repository.mutate(state => { state.workflows.report!.yaml = source; state.versions.report![0]!.yaml = source; });
  const response = await s.propose({ nodeId: "gate", baseHash: hash }); expect(response.statusCode, response.body).toBe(200);
  const proposal = response.json().data; expect(proposal.after).not.toHaveProperty("merge"); expect(proposal.before.merge).toEqual(conditionMerge);
  const applied = await s.app.inject({ method: "POST", url: "/api/workflows/report/commands", headers: s.headers(), payload: { baseVersion: 1, baseHash: hash, proposalId: proposal.id, command: proposal.command } });
  expect(applied.statusCode, applied.body).toBe(200); const next = parseWorkflowYAMLStrict(applied.json().data.yaml) as any;
  expect(next.metadata.controlFlow.root.nodes[0]).toEqual(proposal.after); expect(next.steps).toEqual(original.steps);
});

test.each([
  { ...conditionMerge, then: conditionMerge.else }, // sibling output
  { ...conditionMerge, then: { kind: "ref", source: "nodeOutput", nodeId: "future", path: ["structuredContent", "value"] } },
  { ...conditionMerge, else: { kind: "ref", source: "nodeOutput", nodeId: "gate", path: ["value"] } },
  { ...conditionMerge, schema: { type: "boolean" } },
])("invalid condition output scope/type %j is visible as a blocked proposal and never executable", async merge => {
  const s = await conditionSetup({ merge }), result = await s.propose({ nodeId: "gate", baseHash: s.hash });
  expect(result.statusCode, result.body).toBe(200); const proposal = result.json().data; expect(proposal.validation.passed).toBe(false);
  expect((await s.repository.snapshot()).workflows.report!.yaml).toBe(s.source);
  const applied = await s.app.inject({ method: "POST", url: "/api/workflows/report/commands", headers: s.headers(), payload: { baseVersion: 1, baseHash: s.hash, proposalId: proposal.id, command: proposal.command } });
  expect(applied.statusCode, applied.body).toBe(200); expect(applied.json().data).toMatchObject({ canRun: false, validation: { passed: false } });
  const ready = await s.app.inject({ method: "GET", url: "/api/workflows/report/readiness", headers: s.headers() }); expect(ready.json().data.can_attempt_run).toBe(false);
  const published = await s.app.inject({ method: "POST", url: "/api/workflows/report/publish", headers: s.headers(), payload: {} }); expect(published.statusCode).toBeGreaterThanOrEqual(400);
  expect((await s.repository.snapshot()).executions).toEqual({});
});

test.each([{ predicate: { kind: "literal", value: false }, then: { kind: "sequence", nodes: [] } }, { action: "demo.echo" }, { predicate: { kind: "literal", value: "false" } }, { predicate: { kind: "ref", source: "workflowInput", path: ["__proto__"] } }, {}, { merge: { ...conditionMerge, approved: true } }, { merge: conditionMerge, id: "other" }])("condition proposal %j cannot escape its narrow patch contract", async output => {
  const s = await conditionSetup(output); expect((await s.propose({ nodeId: "gate", baseHash: s.hash })).statusCode).toBe(422);
  expect((await s.repository.snapshot()).workflows.report!.yaml).toBe(s.source); expect((await s.repository.snapshot()).chats.chat!.messages).toHaveLength(0);
});

test("same-base concurrent edits yield exactly one saved revision and one conflict", async () => {
  const s = await setup();
  const responses = await Promise.all(["a", "b"].map((description) => s.edit({ type: "updateNode", nodeId: "first", patch: { description } })));
  expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
  expect((await s.repository.snapshot()).workflows.report?.draftVersion).toBe(2);
});

test("add, move, remove and undo restore source without rewinding revision history", async () => {
  const s = await setup();
  let revision = { version: 1, contentHash: workflowContentHash(yaml), yaml };
  for (const change of [
    { type: "addNode", node: { id: "newNode", action: "demo.echo", parameters: { value: "new" } }, beforeNodeId: "last" },
    { type: "moveNode", nodeId: "newNode", beforeNodeId: "first" },
    { type: "removeNode", nodeId: "newNode" },
    { type: "restoreDraft", yaml },
  ]) {
    const response = await s.edit(change, revision.version, revision.contentHash);
    expect(response.statusCode, response.body).toBe(200); revision = response.json().data;
  }
  expect(revision.version).toBe(5);
  expect(parseWorkflowYAMLStrict(revision.yaml)).toEqual(blueprint);
});

test.each([
  { type: "updateNode", nodeId: "missing", patch: { description: "x" } },
  { type: "updateNode", nodeId: "first", patch: { id: "last" } },
  { type: "updateNode", nodeId: "first", patch: {} },
  { type: "moveNode", nodeId: "first", beforeNodeId: "first" },
  { type: "addNode", node: { id: "first", action: "demo.echo" }, beforeNodeId: null },
])("invalid scoped command %j leaves source unchanged", async (command) => {
  const s = await setup(); expect((await s.edit(command)).statusCode).toBeGreaterThanOrEqual(400);
  expect((await s.repository.snapshot()).workflows.report?.yaml).toBe(yaml);
});

test("unknown action is retained in a blocked draft, never renamed or auto-published", async () => {
  const s = await setup(); const response = await s.edit({ type: "updateNode", nodeId: "first", patch: { action: "missing-tool" } });
  expect(response.statusCode).toBe(200); expect(response.json().data.validation.passed).toBe(false);
  expect(response.json().data.yaml).toContain("missing-tool"); expect(response.json().data.canRun).toBe(false);
});

test.each(["empty draft", "missing mandatory input"])("%s stays editable but cannot be approved into a publication or execution", async scenario => {
  const s = await setup();
  await s.repository.mutate(state => { state.workflows.report!.publishedVersion = 0; state.workflows.report!.canRun = false; state.versions.report = []; });
  const command = scenario === "empty draft" ? { type: "restoreDraft", yaml: stringify({ name: "Unfinished registration", trigger: { type: "manual" }, steps: [], metadata: { unresolved_requirements: ["Customer territory is required"] } }) } : { type: "updateNode", nodeId: "first", patch: { parameters: {} } };
  const changed = await s.edit(command); expect(changed.statusCode, changed.body).toBe(200);
  const draft = changed.json().data; expect(draft.validation.passed).toBe(false); expect(draft.canRun).toBe(false);
  const publication = await s.app.inject({ method: "POST", url: "/api/workflows/report/publish", headers: s.headers(), payload: { baseVersion: draft.version, baseHash: draft.contentHash } });
  expect(publication.statusCode, publication.body).toBeGreaterThanOrEqual(400);
  const run = await s.app.inject({ method: "POST", url: "/api/workflows/report/run", headers: s.headers(), payload: { mode: "async-read", idempotencyKey: `mandatory-field-stop-${scenario.replaceAll(" ", "-")}`, input: {} } });
  expect(run.statusCode, run.body).toBeGreaterThanOrEqual(400);
  const state = await s.repository.snapshot(); expect(state.workflows.report!.publishedVersion).toBe(0); expect(Object.keys(state.executions)).toHaveLength(0);
});

test("client cannot edit, and unassigned read readiness is hidden", async () => {
  const s = await setup(); expect((await s.edit({ type: "removeNode", nodeId: "last" }, 1, workflowContentHash(yaml), "client")).statusCode).toBe(403);
  expect((await s.app.inject({ method: "GET", url: "/api/workflows/report/readiness", headers: s.headers("client") })).statusCode).toBe(404);
});

test("node prompt returns a scope-bound preview and persists it in chat without changing workflow", async () => {
  const s = await setup(); const response = await s.propose(); expect(response.statusCode, response.body).toBe(200);
  const proposal = response.json().data;
  expect(proposal).toMatchObject({ nodeId: "first", baseVersion: 1, baseHash: workflowContentHash(yaml), status: "PROPOSED", command: { type: "updateNode", nodeId: "first" } });
  const state = await s.repository.snapshot();
  expect(state.workflows.report?.yaml).toBe(yaml); expect(state.chats.chat?.messages).toHaveLength(2);
  expect(s.fetchImplementation).toHaveBeenCalledTimes(1);
  const applied = await s.edit(proposal.command, proposal.baseVersion, proposal.baseHash);
  expect(applied.statusCode).toBe(200); expect(parseWorkflowYAMLStrict(applied.json().data.yaml).steps.slice(1)).toEqual(blueprint.steps.slice(1));
});

test.each([{ id: "last", parameters: { value: "bad" } }, { yaml: "replace whole workflow" }, {}, { action: "demo.echo", extra: true }])("unsupported model patch %j cannot escape node scope", async (output) => {
  const s = await setup(output); expect((await s.propose()).statusCode).toBe(422);
  expect((await s.repository.snapshot()).workflows.report?.yaml).toBe(yaml);
});

test("role revocation while model is running prevents proposal persistence", async () => {
  const s = await setup();
  s.fetchImplementation.mockImplementation(async () => { await s.repository.mutate((state) => { state.users.admin!.status = "Disabled"; }); return Response.json({ choices: [{ message: { content: '{"description":"changed"}' } }] }); });
  expect((await s.propose()).statusCode).toBe(403); expect((await s.repository.snapshot()).chats.chat?.messages).toHaveLength(0);
});

test("model wait does not block concurrent revisioned edits; stale proposal is rejected", async () => {
  const s = await setup(); let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; }), started = new Promise<void>((resolve) => { entered = resolve; });
  s.fetchImplementation.mockImplementation(async () => { entered(); await waiting; return Response.json({ choices: [{ message: { content: '{"description":"stale"}' } }] }); });
  const pending = s.propose(); await started;
  try { expect((await s.edit({ type: "updateNode", nodeId: "first", patch: { description: "current" } })).statusCode).toBe(200); }
  finally { release(); }
  expect((await pending).statusCode).toBe(409);
});

test("readiness separates validation, supported semantics, publication and disconnected bridge", async () => {
  const s = await setup(); const response = await s.app.inject({ method: "GET", url: "/api/workflows/report/readiness", headers: s.headers() });
  expect(response.statusCode).toBe(200);
  expect(response.json().data).toMatchObject({ published: true, bridge: "not_connected", can_attempt_run: false, validation: { passed: false } });
  expect(response.json().data.issues.length).toBeGreaterThan(0);
  expect(s.fetchImplementation).not.toHaveBeenCalled();
});

test("proposal acceptance is bound to the owned saved command and cannot be replayed", async () => {
  const s = await setup(); const proposal = (await s.propose()).json().data;
  const accept = (command = proposal.command, version = 1, hash = proposal.baseHash) => s.app.inject({ method: "POST", url: "/api/workflows/report/commands", headers: s.headers(), payload: { baseVersion: version, baseHash: hash, command, proposalId: proposal.id } });
  expect((await accept({ ...proposal.command, patch: { description: "not the proposed change" } })).statusCode).toBe(409);
  expect((await s.repository.snapshot()).workflows.report?.draftVersion).toBe(1);
  const result = await accept(); expect(result.statusCode, result.body).toBe(200);
  const state = await s.repository.snapshot();
  const artifact = state.chats.chat!.messages[1]!.artifacts as { proposal: Record<string, unknown> };
  expect(artifact.proposal).toMatchObject({ status: "APPLIED", appliedVersion: 2, resolvedBy: "admin" });
  expect((await accept(proposal.command, 2, result.json().data.contentHash)).statusCode).toBe(409);
  expect((await s.repository.snapshot()).workflows.report?.draftVersion).toBe(2);
});

test("discard persists without changing source or version and cannot be resolved twice", async () => {
  const s = await setup(); const proposal = (await s.propose()).json().data;
  const response = await s.edit({ type: "discardProposal", proposalId: proposal.id });
  expect(response.statusCode).toBe(200); expect(response.json().message).toContain("draft unchanged");
  const state = await s.repository.snapshot();
  expect(state.workflows.report).toMatchObject({ yaml, draftVersion: 1, publishedVersion: 1 });
  expect((state.chats.chat!.messages[1]!.artifacts as { proposal: Record<string, unknown> }).proposal).toMatchObject({ status: "DISCARDED", resolvedBy: "admin" });
  expect((await s.edit({ type: "discardProposal", proposalId: proposal.id })).statusCode).toBe(409);
});

test("saved proposals cannot be resolved through another admin's chat scope", async () => {
  const s = await setup(); const proposal = (await s.propose()).json().data;
  await s.repository.mutate((state) => { state.users.other = { ...state.users.admin!, id: "other", email: "other@example.test" }; });
  expect((await s.edit({ type: "discardProposal", proposalId: proposal.id }, 1, proposal.baseHash, "other")).statusCode).toBe(404);
});

test("proposal requests require an owned chat before calling the provider", async () => {
  const s = await setup();
  expect((await s.propose({ sessionId: undefined })).statusCode).toBe(400);
  expect((await s.propose({ sessionId: "not-owned" })).statusCode).toBe(404);
  expect(s.fetchImplementation).not.toHaveBeenCalled();
});

test("publication with a reviewed revision rejects stale or malformed review evidence", async () => {
  const s = await setup();
  const publish = (baseVersion: unknown, baseHash: unknown) => s.app.inject({ method: "POST", url: "/api/workflows/report/publish", headers: s.headers(), payload: { baseVersion, baseHash } });
  expect((await publish(1, "not-a-hash")).statusCode).toBe(400);
  expect((await publish(0, workflowContentHash(yaml))).statusCode).toBe(409);
  await s.edit({ type: "updateNode", nodeId: "first", patch: { description: "updated" } });
  expect((await publish(1, workflowContentHash(yaml))).statusCode).toBe(409);
  expect((await s.repository.snapshot()).workflows.report?.publishedVersion).toBe(1);
});

test("offline readiness returns local schema guidance without a provider call, mutation or runnable grant", async () => {
  const s = await setup(), before = await s.repository.snapshot();
  const response = await s.app.inject({ method: "GET", url: "/api/workflows/report/readiness", headers: s.headers() });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().data.authoring).toMatchObject({ profile: "read-authoring/v1", nodes: [{ nodeId: "first", state: "LOCAL_CONTRACT", inputSchema: { properties: { value: { type: "string" } } } }, { nodeId: "approval", state: "UNAVAILABLE" }, { nodeId: "last", dataSources: [] }] });
  expect(response.json().data.can_attempt_run).toBe(false);
  expect((await s.repository.snapshot()).workflows).toEqual(before.workflows); expect(s.fetchImplementation).not.toHaveBeenCalled();
});

test.each(["actor", "revision"])("readiness rechecks %s after awaited work before returning authoring context", async change => {
  const s = await setup();
  vi.spyOn(s.repository, "readAuthoritative").mockImplementationOnce(async callback => {
    await s.repository.mutate(state => { if (change === "actor") state.users.admin!.status = "Disabled"; else state.workflows.report!.draftVersion++; });
    return s.repository.read(callback);
  });
  const response = await s.app.inject({ method: "GET", url: "/api/workflows/report/readiness", headers: s.headers() });
  expect(response.statusCode, response.body).toBe(change === "actor" ? 403 : 409);
  expect(response.json().data).toBeNull(); expect(s.fetchImplementation).not.toHaveBeenCalled();
});
