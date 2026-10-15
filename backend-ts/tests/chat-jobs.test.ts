import { resolve } from "node:path";
import jwt from "jsonwebtoken";
import { afterEach, expect, test, vi } from "vitest";
import { loadConfig } from "../src/config/config.js";
import { buildApp } from "../src/http/app.js";
import { Repository, type PersistenceBackend, type RepositoryState } from "../src/repository/store.js";
import { RegistryService } from "../src/registry/service.js";
import { RegistryValidator } from "../src/validator/registry-validator.js";
import { Executor } from "../src/runner/executor.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { ProviderRuntime } from "../src/providers/runtime.js";
import { SynthesisService } from "../src/synthesis/service.js";
import { createErpbridgeMcpSession, ErpbridgeMcpToolError } from "../src/tools/erpbridge-mcp-client.js";
import { chatJobQueue, decodePrivateChatInput } from "../src/agent/chat-jobs.js";
import { FirestoreRecordCodec } from "../src/storage/firestore-record-codec.js";
import { migrateNativeChatContent } from "../src/storage/chat-native-content.js";
import { workflowContentHash, parseWorkflowYAMLStrict } from "../src/parser/workflow.js";
import { stringify } from "yaml";
import type { Workflow } from "../src/models/schemas.js";
import { AESGCMCodec } from "../src/storage/aes-gcm.js";
import * as optionalPolicy from "../src/governance/optional-policy.js";
import { dispatchReadTool } from "../src/tools/read-tool-broker.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
const yaml = 'name: Report\ndescription: Read\ntrigger:\n  type: manual\nsteps:\n  - id: echo\n    action: demo.echo\n    parameters:\n      value: fixture';

test.each(["role_builder", "role_client", "role_admin"])("private chat scope and read-only administrative review: %s", async roleId => {
  const s = await setup();
  await s.repository.mutate(state => { state.users.other!.roleId = roleId; });
  const listing = await s.app.inject({ method: "GET", url: "/api/chat/sessions", headers: s.headers("other") });
  expect(listing.statusCode).toBe(200);
  expect(listing.json().data.some((chat: { id: string }) => chat.id === s.sessionId)).toBe(roleId === "role_admin");
  const view = await s.app.inject({ method: "GET", url: `/api/chat/sessions/${s.sessionId}`, headers: s.headers("other") });
  expect(view.statusCode).toBe(roleId === "role_admin" ? 200 : 404);
  if (roleId === "role_admin") expect(view.json().data.access).toEqual({ canReply: false, canManage: false, reviewOnly: true });
  for (const [method, suffix, payload] of [["PATCH", "", { title: "Not mine" }], ["DELETE", "", undefined],
    ["POST", "/messages", { content: "Hello" }], ["POST", "/messages", { content: "Hello", delivery: "async-chat", idempotencyKey: "private-owner-test-000001" }]] as const) {
    const response = await s.app.inject({ method, url: `/api/chat/sessions/${s.sessionId}${suffix}`, headers: s.headers("other"), ...(payload ? { payload } : {}) });
    expect(response.statusCode, `${method} ${suffix}: ${response.body}`).toBe(404);
  }
  expect(s.fetchImplementation).not.toHaveBeenCalled(); expect(s.callTool).not.toHaveBeenCalled();
  const admitted = await s.send(); await s.terminal(admitted.json().data.operation.id);
  const op = admitted.json().data.operation.id;
  expect((await s.get(op, "other")).statusCode).toBe(404);
  const operations = await s.app.inject({ method: "GET", url: `/api/chat/sessions/${s.sessionId}/operations`, headers: s.headers("other") });
  expect(operations.statusCode).toBe(roleId === "role_admin" ? 200 : 404);
  if (roleId === "role_admin") expect(operations.json().data).toEqual([]);
  expect((await s.app.inject({ method: "POST", url: `/api/chat/operations/${op}/cancel`, headers: s.headers("other"), payload: {} })).statusCode).toBe(404);
});

test("ordinary queued conversations work without ERPBridge and never fabricate a no-data failure", async () => {
  const s = await setup({ noBridge: true });
  s.fetchImplementation.mockImplementation(async (_url, init) => {
    const wire = JSON.parse(String(init?.body)); expect(wire.tools).toBeUndefined(); expect(wire.messages[0].content).toContain("prompt/conversation/v1");
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: "Hello! I can help with questions and planning." } }], usage: { prompt_tokens: 6, completion_tokens: 8 } });
  });
  const receipt = await s.send("Hello, how are you?"); expect(receipt.statusCode, receipt.body).toBe(202);
  const operation = await s.terminal(receipt.json().data.operation.id); expect(operation.status).toBe("ANSWERED"); expect(operation.attempts).toEqual([]);
  const message = (await s.repository.snapshot()).chats[s.sessionId]!.messages.at(-1)!;
  expect(message.text).toBe("Hello! I can help with questions and planning."); expect(message.artifacts).toMatchObject({ intent: "CONVERSATION", toolsDispatched: false });
  expect(s.callTool).not.toHaveBeenCalled(); expect(s.fetchImplementation).toHaveBeenCalledOnce();
});

test("selected workflow questions and same-chat follow-ups use saved context without changing or executing it", async () => {
  const s = await nodeSetup({ noBridge: true });
  const reference = { workflowId: "report", baseVersion: 1, baseHash: workflowContentHash(yaml) };
  s.fetchImplementation.mockImplementation(async (_url, init) => {
    const wire = JSON.parse(String(init?.body)); expect(wire.tools).toBeUndefined(); expect(wire.messages[0].content).toContain("prompt/workflow-discussion/v1");
    const current = JSON.parse(wire.messages.at(-1).content).CURRENT_WORKFLOW_JSON;
    expect(current).toMatchObject({ workflowId: "report", name: "Report", nodeCount: 1, draftVersion: 1 });
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: "This workflow reads the reference value in one step. You can inspect that step before changing it." } }] });
  });
  const before = await s.repository.snapshot();
  for (const [index, content] of ["what is this work flow", "What does it do?"].entries()) {
    const receipt = await s.send(content, { workflowContext: reference, idempotencyKey: `workflow-discussion-followup-${index}` });
    expect(receipt.statusCode, receipt.body).toBe(202); expect((await s.terminal(receipt.json().data.operation.id)).status).toBe("ANSWERED");
    const message = (await s.repository.snapshot()).chats[s.sessionId]!.messages.at(-1)!;
    expect(message.artifacts).toMatchObject({ intent: "WORKFLOW_DISCUSSION", discussion: { workflowId: "report", nodeCount: 1 }, toolsDispatched: false });
    expect(message.text).not.toContain("No confirmed ERP data"); expect(message.text).toContain("This workflow reads");
  }
  const after = await s.repository.snapshot(); expect(after.workflows).toEqual(before.workflows); expect(after.executions).toEqual(before.executions);
  expect(s.callTool).not.toHaveBeenCalled(); expect(s.fetchImplementation).toHaveBeenCalledTimes(2);
});

test("a stale selected workflow reference is rejected before admitting or sending conversational context", async () => {
  const s = await nodeSetup();
  const response = await s.send("what is this workflow", { workflowContext: { workflowId: "report", baseVersion: 2, baseHash: workflowContentHash(yaml) } });
  expect(response.statusCode).toBe(409); expect(s.fetchImplementation).not.toHaveBeenCalled(); expect(s.callTool).not.toHaveBeenCalled();
});

test("chat rename validates the same title contract as creation, preserving old metadata on invalid input", async () => {
  const s = await setup();
  const initial = (await s.repository.snapshot()).chats[s.sessionId]!;
  for (const title of [42, null, {}, "x".repeat(201)]) {
    const response = await s.app.inject({ method: "PATCH", url: `/api/chat/sessions/${s.sessionId}`, headers: s.headers(), payload: { title } });
    expect(response.statusCode).toBe(400); expect((await s.repository.snapshot()).chats[s.sessionId]!.title).toBe(initial.title);
  }
  const renamed = await s.app.inject({ method: "PATCH", url: `/api/chat/sessions/${s.sessionId}`, headers: s.headers(), payload: { title: "  Renamed safely  " } });
  expect(renamed.statusCode).toBe(200); expect(renamed.json().data.title).toBe("Renamed safely");
  const blank = await s.app.inject({ method: "PATCH", url: `/api/chat/sessions/${s.sessionId}`, headers: s.headers(), payload: { title: "  " } });
  expect(blank.statusCode).toBe(200); expect(blank.json().data.title).toBe("New conversation");
  expect(s.fetchImplementation).not.toHaveBeenCalled(); expect(s.callTool).not.toHaveBeenCalled();
});
function barrier() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
class Persistence implements PersistenceBackend {
  readonly readQueueDurability = "encrypted-single-writer" as const;
  payload: Uint8Array | null = null;
  failWhen: ((state: RepositoryState) => boolean) | undefined; commitBeforeFailure = false;
  async load() { return this.payload; }
  async save(payload: Uint8Array) { const state = JSON.parse(Buffer.from(payload).toString("utf8")) as RepositoryState;
    if (this.failWhen?.(state)) { this.failWhen = undefined; if (this.commitBeforeFailure) this.payload = Buffer.from(payload); throw new Error("Fixture acknowledgement lost"); }
    this.payload = Buffer.from(payload);
  }
  async close() {} async probe() {}
}
async function setup(options: { persistence?: PersistenceBackend; timeoutMs?: number; noBridge?: boolean; toolFile?: string; nativeFields?: boolean } = {}) {
  const config = { ...loadConfig({ APP_ENV: "test", JWT_SECRET: "chat-job-secret-at-least-32-bytes", STORAGE_DRIVER: "memory", MCP_MODE: "mock" }), storageEncryptionKey: "x".repeat(32), erpbridgeRoleMap: { "Platform Admin": "admin" }, ...(options.nativeFields ? {firestoreContentFormat:"native-fields/v1" as const} : {}) };
  const repository = await Repository.open(options.persistence ?? null);
  await repository.mutate(state => { for (const id of ["owner", "other"]) state.users[id] = { id, name: id, email: `${id}@example.test`, roleId: "role_admin", permissionOverrides: [], status: "Active", initials: "U", departmentId: null, lastLoginAt: null, createdAt: new Date().toISOString() }; });
  const registries = await RegistryService.load(resolve("tests/fixtures", options.toolFile ?? "chat-read-tools.json"), resolve("tests/fixtures/rules.json"));
  const validator = new RegistryValidator(registries, repository), executor = new Executor(new ToolRegistry(), validator);
  const fetchImplementation = vi.fn<typeof fetch>(async (_url, init) => {
    const input = JSON.parse(String(init?.body));
    if (input.messages[0].content.includes("ONE SELECTED NODE PATCH")) return Response.json({ choices: [{ message: { content: '{"description":"Proposed label"}' } }] });
    if (input.messages[0].content.includes("WORKFLOW DRAFT SYNTHESIS")) return Response.json({ choices: [{ message: { content: yaml } }] });
    if (input.messages[0].content.includes("WORKFLOW MODIFICATION PROPOSAL")) return Response.json({ choices: [{ message: { content: yaml.replace("Report", "Updated") } }] });
    const hasRead = input.messages.some((m: { role: string }) => m.role === "tool");
    return Response.json({ choices: [{ finish_reason: hasRead ? "stop" : "tool_calls", message: hasRead ? { content: "Confirmed fixture read." } : {
      content: "", tool_calls: [{ id: "read-one", type: "function", function: { name: "demo.echo", arguments: '{"value":"fixture"}' } }],
    } }], usage: { prompt_tokens: 5, completion_tokens: 7 } });
  });
  const runtime = new ProviderRuntime(repository, executor, fetchImplementation);
  runtime.activate({ id: "fixture", name: "Fixture", type: "openai_compatible", baseURL: "https://old.example.test/v1", apiKey: "private-fixture-key", model: "model-a", additionalModels: ["model-b"], temperature: 0, timeoutMs: 1000,
    egressPolicy: { profile: "model-egress-policy/v1", approvedOrigin: "https://old.example.test", runtimeAnalysisDataClasses: [], interactiveDataClasses: ["restricted"], reviewedAt: "2026-10-07T00:00:00.000Z", reviewedBy: { id: "owner", name: "owner" } } });
  const callTool = vi.fn(async (): Promise<unknown> => ({ content: [], structuredContent: { value: "confirmed receipt", token: "private-remote-secret" } }));
  const bridge = await createErpbridgeMcpSession({ baseURL: "https://bridge.example.test", token: "fixture-credential", timeoutMs: options.timeoutMs ?? 1000, validator,
    sdkClient: { connect: async () => {}, close: async () => {}, listTools: async () => registries.snapshot().tools.map(t => ({ name: t.mcp_tool_name, inputSchema: t.input_schema })), callTool } });
  const services = { config, repository, registries, validator, executor, providerRuntime: runtime, synthesis: new SynthesisService(runtime, registries, validator), ...(options.noBridge ? {} : { erpbridgeSession: bridge }) };
  const app = await buildApp(services); apps.push(app);
  const headers = (id = "owner") => ({ authorization: `Bearer ${jwt.sign({}, config.jwtSecret, { algorithm: "HS256", subject: id, expiresIn: 3600 })}` });
  const created = await app.inject({ method: "POST", url: "/api/chat/sessions", headers: headers(), payload: {} }); const sessionId = created.json().data.id;
  const send = (content = "Show me invoices", extra: Record<string, unknown> = {}) => app.inject({ method: "POST", url: `/api/chat/sessions/${sessionId}/messages`, headers: headers(), payload: { content, delivery: "async-chat", idempotencyKey: "chat-job-fixture-00001", ...extra } });
  const get = (id: string, actor = "owner", after = 0) => app.inject({ method: "GET", url: `/api/chat/operations/${id}?after=${after}`, headers: headers(actor) });
  async function terminal(id: string) { await vi.waitFor(async () => expect((await repository.snapshot()).chatOperations[id]?.status).not.toMatch(/^(QUEUED|RUNNING)$/), { timeout: 3500, interval: 10 }); return (await repository.snapshot()).chatOperations[id]!; }
  return { services, repository, runtime, callTool, fetchImplementation, app, headers, sessionId, send, get, terminal };
}

async function nodeSetup(options: Parameters<typeof setup>[0] = {}) {
  const s = await setup(options), timestamp = new Date().toISOString();
  await s.repository.mutate(state => {
    state.workflows.report = { id: "report", name: "Report", description: "Read", owner: { id: "owner", name: "owner" }, assignedUserIds: [], status: "PENDING", trigger: { type: "manual" }, steps: 1, successRate: 0, lastRunAt: null,
      publishedVersion: 1, draftVersion: 1, tags: [], domainTags: [], canRun: true, createdAt: timestamp, updatedAt: timestamp, yaml, archived: false } satisfies Workflow;
    state.versions.report = [{ version: 1, artifactState: "PUBLISHED", yaml }];
  });
  const nodeContext = { workflowId: "report", nodeId: "echo", baseVersion: 1, baseHash: workflowContentHash(yaml) };
  s.fetchImplementation.mockImplementation(async () => Response.json({ choices: [{ message: { content: '{"description":"Proposed label"}' } }] }));
  return { ...s, nodeContext };
}

async function workflowEditSetup(result: unknown = { kind: "proposal", yaml: yaml.replace("description: Read", "description: Show the directory here"), summary: "Show the directory in this workspace." }) {
  const s = await nodeSetup({ noBridge: true }); s.services.config.chatIntentRouting = "agent";
  const context = { workflowId: "report", baseVersion: 1, baseHash: workflowContentHash(yaml) };
  s.fetchImplementation.mockImplementation(async (_url, init) => {
    const wire = JSON.parse(String(init?.body));
    if (wire.messages[0].content.includes("prompt/intent-routing/v4")) return Response.json({ choices: [{ finish_reason: "stop", message: { content: '{"intent":"WORKFLOW_MODIFY","needsClarification":false}' } }] });
    expect(wire.messages[0].content).toContain("prompt/workflow-modifier/v4");
    const data = JSON.parse(wire.messages.at(-1).content);
    expect(data.currentYaml).toBe(yaml); expect(data.tools[0]).toHaveProperty("inputSchema");
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(result) } }] });
  });
  return { ...s, context };
}

test("ordinary whole-workflow edit becomes an exact saved proposal, not a duplicate workflow or an automatic change", async () => {
  const s = await workflowEditSetup(), before = await s.repository.snapshot();
  const receipt = await s.send("Edit the above workflow so it shows the directory here", { workflowContext: s.context });
  expect(receipt.statusCode).toBe(202); const op = await s.terminal(receipt.json().data.operation.id);
  expect(op.status).toBe("ANSWERED"); expect(op.attempts).toEqual([]);
  let state = await s.repository.snapshot(); const message = state.chats[s.sessionId]!.messages.at(-1)!, proposal = (message.artifacts as any).proposal;
  expect(message.artifacts).toMatchObject({ intent: "WORKFLOW_PATCH_PROPOSAL", workflowId: "report", toolsDispatched: false,
    proposal: { scope: "workflow", ...s.context, status: "PROPOSED", command: { type: "restoreDraft" } } });
  expect(op.artifactRefs).toEqual([{ type: "workflow-proposal", id: proposal.id }]);
  expect(state.workflows).toEqual(before.workflows); expect(state.executions).toEqual({}); expect(state.schedules).toEqual({});
  const apply = (command = proposal.command, actor = "owner") => s.app.inject({ method: "POST", url: "/api/workflows/report/commands", headers: s.headers(actor), payload: { baseVersion: 1, baseHash: s.context.baseHash, proposalId: proposal.id, command } });
  expect((await apply({ ...proposal.command, yaml: yaml.replace("Read", "Tampered") })).statusCode).toBe(409);
  expect((await apply(proposal.command, "other")).statusCode).toBe(404);
  const saved = await apply(); expect(saved.statusCode, saved.body).toBe(200); expect(saved.json().data).toMatchObject({ version: 2, publishedVersion: 1, canRun: false });
  state = await s.repository.snapshot(); expect(Object.keys(state.workflows)).toEqual(["report"]);
  expect(parseWorkflowYAMLStrict(state.workflows.report!.yaml).description).toBe("Show the directory here");
  expect((state.chats[s.sessionId]!.messages.at(-1)!.artifacts as any).proposal.status).toBe("APPLIED");
  expect((await apply()).statusCode).toBe(409); expect(s.callTool).not.toHaveBeenCalled();
});

test.each(["ambiguous", "missing fields", "malformed"])("whole-workflow %s result asks or stops without creating/saving/executing a plan", async mode => {
  const s = await workflowEditSetup(mode === "malformed" ? { kind: "proposal", yaml: "steps: []", summary: "Invalid" } : { kind: "clarification", question: "Which department should this report include?" });
  if (mode === "ambiguous") await s.repository.mutate(state => { state.workflows.report!.chatSessionId = s.sessionId; state.workflows.second = { ...state.workflows.report!, id: "second" }; });
  const before = await s.repository.snapshot();
  const receipt = await s.send("Change the workflow", mode === "ambiguous" ? {} : { workflowContext: s.context });
  expect((await s.terminal(receipt.json().data.operation.id)).status).toBe("ANSWERED");
  const state = await s.repository.snapshot(), artifact = state.chats[s.sessionId]!.messages.at(-1)!.artifacts as any;
  expect(artifact.intent).toBe(mode === "malformed" ? "WORKFLOW_MODIFY_ERROR" : "CONVERSATION");
  expect(artifact.proposal).toBeUndefined(); expect(state.workflows).toEqual(before.workflows);
  expect(state.executions).toEqual({}); expect(s.callTool).not.toHaveBeenCalled();
  expect(s.fetchImplementation).toHaveBeenCalledTimes(mode === "ambiguous" ? 1 : 2);
});

test.each(["revision", "authority"])("a whole-workflow proposal cannot survive changed %s during model inference", async change => {
  const s = await workflowEditSetup(), original = s.fetchImplementation.getMockImplementation()!;
  s.fetchImplementation.mockImplementation(async (url, init) => {
    if (JSON.parse(String(init?.body)).messages[0].content.includes("prompt/workflow-modifier/v4")) await s.repository.mutate(state => {
      if (change === "revision") { state.workflows.report!.draftVersion = 2; state.workflows.report!.yaml = yaml.replace("Read", "Another saved edit"); }
      else state.users.owner!.roleId = "role_client";
    });
    return original(url, init);
  });
  const receipt = await s.send("Change the workflow", { workflowContext: s.context });
  const op = await s.terminal(receipt.json().data.operation.id); expect(op.status).toBe("FAILED");
  const state = await s.repository.snapshot(); expect(state.chats[s.sessionId]!.messages.some(message => (message.artifacts as any)?.proposal)).toBe(false);
  expect(state.executions).toEqual({}); expect(s.callTool).not.toHaveBeenCalled();
});

test("missing mandatory input types remain a visibly blocked proposal, never automatic ERP dispatch", async () => {
  const s = await workflowEditSetup({ kind: "proposal", yaml: yaml.replace("value: fixture", "value: []"), summary: "Proposed input change." });
  const receipt = await s.send("Change the workflow", { workflowContext: s.context });
  expect((await s.terminal(receipt.json().data.operation.id)).status).toBe("ANSWERED");
  const state = await s.repository.snapshot(), proposal = (state.chats[s.sessionId]!.messages.at(-1)!.artifacts as any).proposal;
  expect(proposal.validation.passed).toBe(false); expect(state.workflows.report!.yaml).toBe(yaml); expect(s.callTool).not.toHaveBeenCalled();
});

test.each(["run", "schedule", "pause", "publish", "review"])("agent-selected saved workflow %s exposes review controls without YAML generation or execution", async action => {
  const s = await nodeSetup({ noBridge: true }); s.services.config.chatIntentRouting = "agent";
  s.fetchImplementation.mockImplementation(async () => Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ intent: "WORKFLOW_CONTROL", needsClarification: false, workflowControl: action }) } }] }));
  const before = await s.repository.snapshot();
  const response = await s.send(action === "schedule" ? "Run the directory workflow every morning at 9" : `${action} this workflow`, { workflowContext: { workflowId: "report" } });
  expect((await s.terminal(response.json().data.operation.id)).status).toBe("ANSWERED");
  const state = await s.repository.snapshot(), message = state.chats[s.sessionId]!.messages.at(-1)!;
  expect(message.artifacts).toMatchObject({ intent: "WORKFLOW_CONTROL", toolsDispatched: false,
    workflowControl: { action, workflowId: "report", scheduleSupported: false } });
  if (action === "schedule") expect(message.text).toMatch(/Automatic runs (?:are not available|need a current reviewed)/);
  expect(state.workflows).toEqual(before.workflows); expect(state.executions).toEqual({}); expect(state.schedules).toEqual({});
  expect(s.fetchImplementation).toHaveBeenCalledOnce(); expect(s.callTool).not.toHaveBeenCalled();
});

test("agent identifies indirect/general intent in the same selected-node chat, without treating every message as an edit", async () => {
  const s = await nodeSetup({ noBridge: true }); s.services.config.chatIntentRouting = "agent";
  const decisions = ["CONVERSATION", "WORKFLOW_DISCUSSION", "CONVERSATION"];
  let index = 0;
  s.fetchImplementation.mockImplementation(async (_url, init) => {
    const wire = JSON.parse(String(init?.body)); expect(wire.tools).toBeUndefined();
    const routing = wire.messages[0].content.includes("prompt/intent-routing/v4");
    const answer = routing ? JSON.stringify({ intent: decisions[index++], needsClarification: false }) :
      wire.messages[0].content.includes("prompt/workflow-discussion/v1") ? "The selected plan has one reference-read step." : "Hello! An invoice is a request for payment.";
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: answer } }] });
  });
  const before = await s.repository.snapshot();
  for (const [i, content] of ["Hey friend", "Walk me through what I'm looking at", "What is an invoice?"].entries()) {
    const response = await s.send(content, { nodeContext: s.nodeContext, idempotencyKey: `agent-intent-followup-${i}` });
    expect(response.statusCode, response.body).toBe(202); expect((await s.terminal(response.json().data.operation.id)).status).toBe("ANSWERED");
    const message = (await s.repository.snapshot()).chats[s.sessionId]!.messages.at(-1)!;
    expect(message.artifacts).toMatchObject({ intent: decisions[i], intentRouting: { source: "agent", toolsDispatched: false } });
    expect(message.artifacts).not.toHaveProperty("nodeProposal");
  }
  const after = await s.repository.snapshot(); expect(after.workflows).toEqual(before.workflows); expect(after.executions).toEqual(before.executions);
  expect(s.callTool).not.toHaveBeenCalled(); expect(s.fetchImplementation).toHaveBeenCalledTimes(6);
});

test("agent routing can recognize an indirect live ERP read without granting write authority", async () => {
  const s = await setup(); s.services.config.chatIntentRouting = "agent";
  const original = s.fetchImplementation.getMockImplementation()!;
  s.fetchImplementation.mockImplementation(async (url, init) => {
    const wire = JSON.parse(String(init?.body));
    if (wire.messages[0].content.includes("prompt/intent-routing/v4")) return Response.json({ choices: [{ finish_reason: "stop", message: {
      content: JSON.stringify({ intent: "QUERY", needsClarification: false }) } }] });
    return original(url, init);
  });
  const receipt = await s.send("Could you pull up the latest fixture value for me?");
  expect(receipt.statusCode).toBe(202); const operation = await s.terminal(receipt.json().data.operation.id);
  const message = (await s.repository.snapshot()).chats[s.sessionId]!.messages.at(-1)!;
  expect(s.callTool, JSON.stringify({ status: operation.status, artifacts: message.artifacts })).toHaveBeenCalledOnce();
  expect(operation.status).toBe("ANSWERED"); expect(operation.attempts).toHaveLength(1); expect(operation.attempts[0]!.status).toBe("DONE");
  expect(message.artifacts).toMatchObject({ intent: "QUERY", intentRouting: { source: "agent" } });
});

test("invalid agent routing asks for clarification and dispatches no ERP or edit proposal", async () => {
  const s = await nodeSetup(); s.services.config.chatIntentRouting = "agent";
  s.fetchImplementation.mockImplementation(async () => Response.json({ choices: [{ finish_reason: "stop", message: { content: '{"intent":"EXECUTE_ANYTHING","needsClarification":false}' } }] }));
  const response = await s.send("yes do that", { nodeContext: s.nodeContext });
  expect(response.statusCode).toBe(202); expect((await s.terminal(response.json().data.operation.id)).status).toBe("ANSWERED");
  const message = (await s.repository.snapshot()).chats[s.sessionId]!.messages.at(-1)!;
  expect(message.artifacts).toMatchObject({ intent: "CONVERSATION", intentRouting: { source: "unavailable", needsClarification: true }, toolsDispatched: false });
  expect(s.callTool).not.toHaveBeenCalled(); expect(s.fetchImplementation).toHaveBeenCalledOnce();
});

test("agent-selected older chat recall supplies server-scoped saved text without ERP dispatch", async () => {
  const s = await setup({ noBridge: true }); s.services.config.chatIntentRouting = "agent";
  await s.repository.mutate(state => { state.chats[s.sessionId]!.messages.push({ id: "old-first", role: "user", text: "What is an invoice?" },
    ...Array.from({ length: 30 }, (_, index) => ({ id: `ordinary-${index}`, role: "assistant", text: `Later discussion ${index}` }))); });
  s.fetchImplementation.mockImplementation(async (_url, init) => {
    const wire = JSON.parse(String(init?.body)); expect(wire.tools).toBeUndefined();
    if (wire.messages[0].content.includes("prompt/intent-routing/v4")) return Response.json({ choices: [{ finish_reason: "stop", message: {
      content: '{"intent":"CONVERSATION","needsClarification":false,"historyRecall":{"mode":"start"}}' } }] });
    const recalled = JSON.parse(wire.messages.at(-1).content).HISTORY_REFERENCE_JSON;
    expect(recalled.messages[0]).toMatchObject({ id: "old-first", text: "What is an invoice?" });
    expect(recalled).toMatchObject({ freshBusinessEvidence: false, executionAuthority: false });
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: 'Your first question was: "What is an invoice?"' } }] });
  });
  const response = await s.send("What was my first question?"); expect(response.statusCode).toBe(202);
  const operation = await s.terminal(response.json().data.operation.id); expect(operation.attempts).toEqual([]);
  const message = (await s.repository.snapshot()).chats[s.sessionId]!.messages.at(-1)!;
  expect(message.artifacts).toMatchObject({ intent: "CONVERSATION", toolsDispatched: false, conversationRecall: { profile: "chat-history-recall/v1" } });
  expect(message.text).toContain("What is an invoice?"); expect(s.callTool).not.toHaveBeenCalled();
});

test("Client capability listing and ERP read denial agree with the actual role grant, without inference or dispatch", async () => {
  const s = await setup(); await s.repository.mutate(state => { state.users.owner!.roleId = "role_client"; });
  const cap = await s.send("List available tools", { idempotencyKey: "client-capability-list-0001" });
  expect(cap.statusCode).toBe(202); await s.terminal(cap.json().data.operation.id);
  let message = (await s.repository.snapshot()).chats[s.sessionId]!.messages.at(-1)!;
  expect(message.artifacts).toMatchObject({ intent: "CAPABILITIES", capabilities: { offeredCount: 0, readOnlyCount: 0 } });
  expect(message.text).toContain("for your role"); expect(message.text).not.toContain("demo.echo");
  const read = await s.send("Show me invoices", { idempotencyKey: "client-capability-read-0001" });
  expect(read.statusCode).toBe(202); const operation = await s.terminal(read.json().data.operation.id); expect(operation.attempts).toEqual([]);
  message = (await s.repository.snapshot()).chats[s.sessionId]!.messages.at(-1)!;
  expect(message.artifacts).toMatchObject({ intent: "QUERY", code: "NO_APPROVED_READ_TOOLS", toolsDispatched: false });
  expect(s.fetchImplementation).not.toHaveBeenCalled(); expect(s.callTool).not.toHaveBeenCalled();
});

test("an administrator without reviewed reads gets actionable review guidance, never an implicit tool grant", async () => {
  const s = await setup();
  const snapshot = s.services.registries.snapshot();
  vi.spyOn(s.services.registries, "snapshot").mockReturnValue({ ...snapshot, tools: [] });
  const read = await s.send("Show me invoices", { idempotencyKey: "admin-capability-read-0001" });
  expect(read.statusCode).toBe(202); await s.terminal(read.json().data.operation.id);
  const message = (await s.repository.snapshot()).chats[s.sessionId]!.messages.at(-1)!;
  expect(message.text).toContain("You have tool-review permission");
  expect(message.text).not.toContain("Ask an administrator");
  expect(message.artifacts).toMatchObject({ code: "NO_APPROVED_READ_TOOLS", toolsDispatched: false,
    accessRecovery: { profile: "erp-read-access-recovery/v1", canReview: true, automaticGrant: false } });
  expect(s.fetchImplementation).not.toHaveBeenCalled(); expect(s.callTool).not.toHaveBeenCalled();
});

test("a semantic route change is rechecked by policy before an ERP read can dispatch", async () => {
  const s = await setup(); s.services.config.chatIntentRouting = "agent";
  const spy = vi.spyOn(optionalPolicy, "evaluateOptionalPolicy").mockImplementation(async (_services, _user, request) =>
    request.context?.intent === "QUERY" ? { source: "erpbridge", decision: "deny", reason: "Read requires review" } : { source: "skipped", decision: "allow", reason: "Initial classification allowed" });
  s.fetchImplementation.mockImplementation(async () => Response.json({ choices: [{ finish_reason: "stop", message: {
    content: '{"intent":"QUERY","needsClarification":false}' } }] }));
  try {
    const response = await s.send("Please pull that latest value for me"); expect(response.statusCode).toBe(202);
    expect((await s.terminal(response.json().data.operation.id)).status).toBe("ANSWERED");
    const message = (await s.repository.snapshot()).chats[s.sessionId]!.messages.at(-1)!;
    expect(message.artifacts).toMatchObject({ intent: "POLICY_DENIAL", intentRouting: { intent: "QUERY" } });
    expect(s.callTool).not.toHaveBeenCalled(); expect(spy).toHaveBeenCalledTimes(2);
  } finally { spy.mockRestore(); }
});

test("queued read uses saved publication/run facts rather than old chat and re-samples state after model wait", async () => {
  const s = await setup(), timestamp = "2026-10-12T08:00:00.000Z";
  await s.repository.mutate(state => {
    state.workflows.report = { id: "report", name: "Report", description: "Read", owner: { id: "owner", name: "owner" }, assignedUserIds: [], status: "PENDING", trigger: { type: "manual" }, steps: 1,
      successRate: 0, lastRunAt: timestamp, publishedVersion: 2, draftVersion: 3, tags: [], domainTags: [], canRun: true, createdAt: timestamp, updatedAt: timestamp, yaml, archived: false, chatSessionId: s.sessionId };
    state.versions.report = [{ version: 2, artifactState: "PUBLISHED", yaml }, { version: 3, artifactState: "DRAFT", yaml }];
    state.executions.prior_run = { id: "prior_run", workflowId: "report", workflowName: "Report", status: "DONE", startedAt: timestamp, completedAt: timestamp, durationMs: 1,
      tokens: { input: 0, output: 0, total: 0 }, costUsd: 0, startedBy: { id: "owner", name: "owner" },
      workflowSnapshot: { version: 2, yaml, contentHash: workflowContentHash(yaml), registryHash: "fixture", input: {}, executionProfile: "sequential-read-v1" } };
    state.chats[s.sessionId]!.messages.push({ id: "historical_message", role: "assistant", text: "Workflow draft saved. Not published or executed." });
    state.chats[s.sessionId]!.messageCount = 1;
  });
  const original = s.fetchImplementation.getMockImplementation()!;
  s.fetchImplementation.mockImplementation(async (url, init) => {
    const request = JSON.parse(String(init?.body));
    if (request.messages.some((message: any) => message.role === "tool")) await s.repository.mutate(state => {
      state.workflows.report!.draftVersion = 4;
      state.executions.current_run = { ...state.executions.prior_run!, id: "current_run", status: "RUNNING", startedAt: "2026-10-12T08:01:00.000Z", completedAt: null };
    });
    return original(url, init);
  });
  const admitted = (await s.send("List the invoices. Do not create or change ERP records or send email.")).json().data;
  expect((await s.terminal(admitted.operation.id)).status).toBe("ANSWERED");
  const request = JSON.parse(String(s.fetchImplementation.mock.calls[0]![1]?.body)), latestUser = request.messages.findLast((message: any) => message.role === "user");
  expect(request.messages[0].content).toContain("prompt/query/v6");
  expect(JSON.parse(latestUser.content).CURRENT_WORKSPACE_STATUS_JSON.workflows).toEqual([{ id: "report", draftVersion: 3, publishedVersion: 2,
    latestRun: { id: "prior_run", status: "DONE", publishedVersion: 2 } }]);
  const saved = await s.repository.snapshot(), answer = saved.chats[s.sessionId]!.messages.at(-1)!;
  expect(answer.text).toContain("draft v4; published v2; latest recorded run current_run: RUNNING (published v2)");
  expect((answer.artifacts as any).workspaceStatus.workflows[0]).toMatchObject({ draftVersion: 4, publishedVersion: 2, latestRun: { id: "current_run", status: "RUNNING" } });
  expect(s.callTool).toHaveBeenCalledTimes(1); expect(saved.emailDeliveryAdmissions).toEqual({});
  expect(saved.chats[s.sessionId]!.messages.some(message => (message.artifacts as any)?.emailDraft)).toBe(false);
});

const protectedChatOutput = { schema: { type: "string" }, success: { kind: "ref", source: "nodeOutput", nodeId: "echo", path: ["structuredContent", "value"] }, handled: { kind: "ref", source: "nodeOutput", nodeId: "guard", path: ["error", "code"] } };
async function protectedChatSetup(output: unknown = { output: protectedChatOutput }, options: Parameters<typeof setup>[0] = {}) {
  const s = await nodeSetup({ ...options, toolFile: "condition-chat-tools.json" });
  const source = stringify({ name: "Protected saved chat", description: "Synthetic saved group editing", trigger: { type: "manual" }, steps: [{ id: "echo", action: "demo.echo", parameters: { value: "fixture" } }], metadata: { ownerNotes: "keep", controlFlow: { schemaVersion: "read-control-flow/v4", root: { kind: "sequence", nodes: [
    { kind: "protect", id: "guard", onError: { code: "ERP_RESOURCE_NOT_FOUND" }, body: { kind: "sequence", nodes: [{ kind: "action", nodeId: "echo" }] }, handler: { kind: "sequence", nodes: [] }, output: { ...protectedChatOutput, handled: { kind: "literal", value: "Old fallback" } } },
  ] } } } });
  await s.repository.mutate(state => { state.workflows.report!.yaml = source; state.versions.report![0]!.yaml = source; });
  s.fetchImplementation.mockImplementation(async () => Response.json({ choices: [{ message: { content: JSON.stringify(output) } }] }));
  return { ...s, source, nodeContext: { ...s.nodeContext, nodeId: "guard", baseHash: workflowContentHash(source) } };
}

test("saved protected chat reopens/replays exact model-bound proposal and applies one owned draft without ERP dispatch", async () => {
  const persistence = new Persistence(), s = await protectedChatSetup(undefined, { persistence }), content = "Change this group's output; do not send mail";
  const receipt = (await s.send(content, { nodeContext: s.nodeContext, model: "model-b" })).json().data;
  expect(await s.terminal(receipt.operation.id)).toMatchObject({ status: "ANSWERED", attempts: [] });
  const snapshot = await s.repository.snapshot(), proposal = (snapshot.chats[s.sessionId]!.messages.at(-1)!.artifacts as any).proposal;
  expect(proposal.validation.passed, JSON.stringify(proposal.validation)).toBe(true);
  expect(proposal).toMatchObject({ ...s.nodeContext, status: "PROPOSED", command: { type: "updateProtected", nodeId: "guard", patch: { output: protectedChatOutput } }, modelBinding: { model: "model-b" } });
  for (const field of ["id", "kind", "body", "handler", "onError"]) expect(proposal.after[field]).toEqual(proposal.before[field]);
  const request = JSON.parse(String(s.fetchImplementation.mock.calls[0]![1]?.body)), data = JSON.parse(request.messages[1].content);
  expect(request.model).toBe("model-b"); expect(request.messages[0].content).toContain("prompt/protected-group-patch/v1"); expect(data.tools).toEqual([]);
  expect(data.allowedProtectedSources.success.some((hint: any) => hint.binding.nodeId === "echo")).toBe(true);
  expect(data.allowedProtectedSources.handled.some((hint: any) => hint.binding.nodeId === "echo")).toBe(false);
  expect(snapshot.workflows.report!.yaml).toBe(s.source);
  await s.app.close(); apps.splice(apps.indexOf(s.app), 1);
  const reopened = await setup({ persistence, toolFile: "condition-chat-tools.json" });
  expect((await reopened.repository.snapshot()).chats[s.sessionId]!.messages).toEqual(snapshot.chats[s.sessionId]!.messages);
  const replay = await reopened.app.inject({ method: "POST", url: `/api/chat/sessions/${s.sessionId}/messages`, headers: reopened.headers(), payload: { content, delivery: "async-chat", idempotencyKey: "chat-job-fixture-00001", nodeContext: s.nodeContext, model: "model-b" } });
  expect(replay.json().data.operation.id).toBe(receipt.operation.id); expect(reopened.fetchImplementation).not.toHaveBeenCalled();
  const apply = (actor = "owner") => reopened.app.inject({ method: "POST", url: "/api/workflows/report/commands", headers: reopened.headers(actor), payload: { baseVersion: 1, baseHash: s.nodeContext.baseHash, proposalId: proposal.id, command: proposal.command } });
  expect((await apply("other")).statusCode).toBe(404);
  const applied = await apply(); expect(applied.statusCode, applied.body).toBe(200);
  expect(applied.json().data).toMatchObject({ version: 2, publishedVersion: 1, canRun: false });
  const next = parseWorkflowYAMLStrict(applied.json().data.yaml); expect(next.steps).toEqual(parseWorkflowYAMLStrict(s.source).steps); expect((next.metadata!.controlFlow as any).root.nodes[0]).toEqual(proposal.after);
  expect((await apply()).statusCode).toBe(409); expect((await reopened.repository.snapshot()).executions).toEqual({});
  expect(s.callTool).not.toHaveBeenCalled(); expect(reopened.callTool).not.toHaveBeenCalled();
});

test.each(["edit", "cancel", "revocation"])("protected chat proposal cannot commit after %s during model generation", async kind => {
  const s = await protectedChatSetup(), entered = barrier(), release = barrier();
  s.fetchImplementation.mockImplementationOnce(async () => { entered.release(); await release.promise; return Response.json({ choices: [{ message: { content: JSON.stringify({ output: protectedChatOutput }) } }] }); });
  const id = (await s.send("Edit output", { nodeContext: s.nodeContext })).json().data.operation.id; await entered.promise;
  if (kind === "edit") await s.repository.mutate(state => { state.workflows.report!.draftVersion++; });
  else if (kind === "revocation") await s.repository.mutate(state => { state.users.owner!.status = "Inactive"; });
  else await s.app.inject({ method: "POST", url: `/api/chat/operations/${id}/cancel`, headers: s.headers(), payload: {} });
  release.release(); expect((await s.terminal(id)).status).toBe(kind === "cancel" ? "CANCELLED" : "FAILED");
  const state = await s.repository.snapshot(); expect(state.chats[s.sessionId]!.messages).toHaveLength(1); expect(state.workflows.report!.yaml).toBe(s.source); expect(s.callTool).not.toHaveBeenCalled();
});

test.each([{ parameters: {} }, { output: protectedChatOutput, handler: {} }, { output: protectedChatOutput, onError: { code: "ERP_RESOURCE_NOT_FOUND" } }])("saved protected chat rejects scope enlargement %j without draft changes or SDK dispatch", async patch => {
  const s = await protectedChatSetup(patch), id = (await s.send("Edit", { nodeContext: s.nodeContext })).json().data.operation.id;
  expect((await s.terminal(id)).status).toBe("FAILED"); const state = await s.repository.snapshot();
  expect(state.workflows.report!.yaml).toBe(s.source); expect(state.chats[s.sessionId]!.messages).toHaveLength(1); expect(s.callTool).not.toHaveBeenCalled();
});

async function savedRevisionSource(s: Awaited<ReturnType<typeof setup>>, sourceMessageId: string) {
  const session = await s.app.inject({ method: "GET", url: `/api/chat/sessions/${s.sessionId}`, headers: s.headers() });
  return session.json().data.messages.find((message: { id: string }) => message.id === sourceMessageId).revisionSource;
}
test("native chat jobs store readable business fields, seal only captured credentials and expose neither in progress DTOs", async () => {
  const s = await setup({ persistence: new Persistence(), nativeFields: true });
  const queue = chatJobQueue(s.services), kick = vi.spyOn(queue, "kick").mockImplementation(() => {});
  const receipt = (await s.send("Show invoices NATIVE-724")).json().data, id = receipt.operation.id;
  const operation = (await s.repository.snapshot()).chatOperations[id]!;
  expect(operation.inputCiphertext).toBeUndefined(); expect(operation.revisionContextCiphertext).toBeUndefined();
  expect(operation.inputFields).toMatchObject({content:"Show invoices NATIVE-724",provider:{apiKey:"private-fixture-key"}});
  expect(operation.revisionContextFields).toMatchObject({content:"Show invoices NATIVE-724",operationId:id});
  expect(decodePrivateChatInput(operation,s.services.config.storageEncryptionKey).body.content).toBe("Show invoices NATIVE-724");
  const codec = new FirestoreRecordCodec(s.services.config.storageEncryptionKey,{projectId:"demo-lcwe-native",databaseId:"(default)",workspaceId:"plain_jobs"},"native-fields/v1");
  const raw = codec.encodeRecord({profile:"runtime-record/v1",path:["domain","chatOperations",id],value:operation});
  expect(raw.chunks.every(chunk=>chunk.document.profile==="firestore-native/v1")).toBe(true);
  const serialized=JSON.stringify(raw.chunks.map(chunk=>chunk.document.data));
  expect(serialized).toContain("Show invoices NATIVE-724"); expect(serialized).toContain("credential-field/v1"); expect(serialized).not.toContain("private-fixture-key");
  expect(JSON.stringify((await s.get(id)).json())).not.toMatch(/inputFields|revisionContextFields|private-fixture-key|Ciphertext/);
  kick.mockRestore(); queue.kick(); await s.terminal(id);
  const terminal = (await s.repository.snapshot()).chatOperations[id]!;
  expect(terminal.inputFields).toBeUndefined(); expect(terminal.inputCiphertext).toBeUndefined();
  expect(terminal.revisionContextFields).toMatchObject({content:"Show invoices NATIVE-724"});
  expect(JSON.stringify(terminal.revisionContextFields)).not.toMatch(/private-fixture-key|egressPolicy/);
});

test("native saved requests can be revised after reopening without replaying their original operation", async () => {
  const persistence = new Persistence(), first = await setup({persistence,nativeFields:true});
  const receipt=(await first.send("Show invoices ORIGINAL-NATIVE")).json().data; await first.terminal(receipt.operation.id);
  const source=await savedRevisionSource(first,receipt.userMessage.id);
  await first.app.close(); apps.splice(apps.indexOf(first.app),1);
  const next=await setup({persistence,nativeFields:true});
  const response=await next.app.inject({method:"POST",url:`/api/chat/sessions/${first.sessionId}/messages`,headers:next.headers(),payload:{
    content:"Show purchase orders REVISED-NATIVE",delivery:"async-chat",idempotencyKey:"native-reopen-revision-0001",requestRevision:{messageId:source.messageId,sourceHash:source.sourceHash}}});
  expect(response.statusCode,response.body).toBe(202); const revised=await next.terminal(response.json().data.operation.id);
  expect(revised.revisionContextCiphertext).toBeUndefined(); expect(revised.revisionContextFields).toMatchObject({content:"Show purchase orders REVISED-NATIVE"});
  expect(next.callTool).toHaveBeenCalledOnce();
});

test.each(["body","content","actor"])("native job identity still rejects tampering with %s before ERP dispatch", async damage=>{
  const s=await setup({persistence:new Persistence(),nativeFields:true}),queue=chatJobQueue(s.services),kick=vi.spyOn(queue,"kick").mockImplementation(()=>{});
  const id=(await s.send()).json().data.operation.id;
  const original=(await s.repository.snapshot()).chatOperations[id]!;
  const changed=structuredClone(original),input=changed.inputFields as any;
  if(damage==="body")input.body.content="Different request";
  if(damage==="content")input.content="Different source";
  if(damage==="actor")input.user.id="other";
  expect(()=>decodePrivateChatInput(changed,s.services.config.storageEncryptionKey)).toThrow();
  await s.repository.mutate(state=>{state.chatOperations[id]=changed;});
  kick.mockRestore();queue.kick(); expect((await s.terminal(id)).status).toBe("FAILED"); expect(s.callTool).not.toHaveBeenCalled();
  expect((await s.repository.snapshot()).chatOperations[id]!.inputFields).toBeUndefined();
});

test("native queued cancellation erases captured provider input, while retaining readable revision context",async()=>{
  const s=await setup({persistence:new Persistence(),nativeFields:true}),queue=chatJobQueue(s.services),kick=vi.spyOn(queue,"kick").mockImplementation(()=>{});
  const id=(await s.send()).json().data.operation.id;
  const cancelled=await s.app.inject({method:"POST",url:`/api/chat/operations/${id}/cancel`,headers:s.headers(),payload:{}});
  expect(cancelled.statusCode,cancelled.body).toBe(200);
  const saved=(await s.repository.snapshot()).chatOperations[id]!;
  expect(saved).toMatchObject({status:"CANCELLED",revisionContextFields:{content:"Show me invoices"}}); expect(saved.inputFields).toBeUndefined();
  expect(s.fetchImplementation).not.toHaveBeenCalled();expect(s.callTool).not.toHaveBeenCalled();kick.mockRestore();
});

test("explicit legacy-content migration preserves evidence and permits revisions without whole-request encryption",async()=>{
  const s=await setup({persistence:new Persistence()}),receipt=(await s.send()).json().data; await s.terminal(receipt.operation.id);
  const before=await s.repository.snapshot();
  const expected=JSON.parse(new AESGCMCodec(s.services.config.storageEncryptionKey).decode(Buffer.from(before.chatOperations[receipt.operation.id]!.revisionContextCiphertext!,"base64")).toString("utf8"));
  const result=await s.repository.mutate(state=>migrateNativeChatContent(state,s.services.config.storageEncryptionKey));
  expect(result).toEqual({changedOperations:1,readableRevisionContexts:1,erasedTerminalInputs:0,readableModelReceipts:0});
  const after=await s.repository.snapshot(); expect(after.chats).toEqual(before.chats); expect(after.executions).toEqual(before.executions);
  expect(after.chatOperations[receipt.operation.id]!.revisionContextFields).toEqual(expected); expect(after.chatOperations[receipt.operation.id]!.revisionContextCiphertext).toBeUndefined();
  const source=await savedRevisionSource(s,receipt.userMessage.id);s.services.config.firestoreContentFormat="native-fields/v1";
  const revised=await s.send("Show purchase orders after migration",{idempotencyKey:"native-migrated-revision-0001",requestRevision:{messageId:source.messageId,sourceHash:source.sourceHash}});
  expect(revised.statusCode,revised.body).toBe(202);await s.terminal(revised.json().data.operation.id);
  expect((await s.repository.snapshot()).chatOperations[revised.json().data.operation.id]!.revisionContextCiphertext).toBeUndefined();
  expect(s.callTool).toHaveBeenCalledTimes(2);
});

test("content migration is all-or-nothing for invalid context and refuses active jobs",async()=>{
  const s=await setup({persistence:new Persistence()}),receipt=(await s.send()).json().data; await s.terminal(receipt.operation.id);
  const before=await s.repository.snapshot(),damaged=structuredClone(before),original=damaged.chatOperations[receipt.operation.id]!;
  damaged.chatOperations.corrupt={...original,id:"corrupt",revisionContextCiphertext:"tampered"};
  const unchanged=structuredClone(damaged);
  expect(()=>migrateNativeChatContent(damaged,s.services.config.storageEncryptionKey)).toThrow();expect(damaged).toEqual(unchanged);
  original.status="QUEUED";
  expect(()=>migrateNativeChatContent(damaged,s.services.config.storageEncryptionKey)).toThrow("Active chat work");
  expect(damaged.chatOperations[receipt.operation.id]!.revisionContextCiphertext).toBeTruthy();
});

test("migration converts retained model replies without altering their outcome or provenance",async()=>{
 const s=await setup({persistence:new Persistence()}),receipt=(await s.send()).json().data;await s.terminal(receipt.operation.id);
 const state=await s.repository.snapshot(),op=state.chatOperations[receipt.operation.id]!,response={text:"Inventory quantity is 12",toolCalls:[]};
 op.modelAttemptsSecret=[{id:"retained-receipt",status:"DONE",provenanceId:"original-provenance",resultCiphertext:new AESGCMCodec(s.services.config.storageEncryptionKey).encode(Buffer.from(JSON.stringify(response))).toString("base64")} as import("../src/repository/store.js").ChatModelAttempt];
 expect(migrateNativeChatContent(state,s.services.config.storageEncryptionKey).readableModelReceipts).toBe(1);
 expect(op.modelAttemptsSecret[0]).toMatchObject({id:"retained-receipt",status:"DONE",provenanceId:"original-provenance",resultFields:response});
 expect(op.modelAttemptsSecret[0]!.resultCiphertext).toBeUndefined();expect(migrateNativeChatContent(state,s.services.config.storageEncryptionKey).changedOperations).toBe(0);
});

test("explicit request revision keeps original evidence, removes later answers from context and has one idempotent admission", async () => {
  const s = await setup({ persistence: new Persistence() });
  const first = (await s.send("Show me invoices ORIGINAL-724")).json().data;
  await s.terminal(first.operation.id);
  const before = structuredClone((await s.repository.snapshot()).chats[s.sessionId]!.messages);
  const source = await savedRevisionSource(s, first.userMessage.id), requestRevision = { messageId: source.messageId, sourceHash: source.sourceHash };
  s.fetchImplementation.mockClear(); s.callTool.mockClear();
  const response = await s.send("Show me purchase orders REVISED-815", { idempotencyKey: "revision-request-fixture-0001", requestRevision });
  expect(response.statusCode, response.body).toBe(202);
  const receipt = response.json().data;
  expect(receipt.operation.requestRevision).toEqual(requestRevision); expect(receipt.userMessage.requestRevision).toEqual(requestRevision);
  await s.terminal(receipt.operation.id);
  const state = await s.repository.snapshot();
  expect(state.chats[s.sessionId]!.messages.slice(0, before.length)).toEqual(before);
  expect(state.chatOperations[first.operation.id]?.inputCiphertext).toBeUndefined();
  expect(state.chatOperations[first.operation.id]?.revisionContextCiphertext).toBeTruthy();
  const privateRequest = new AESGCMCodec(s.services.config.storageEncryptionKey).decode(Buffer.from(state.chatOperations[first.operation.id]!.revisionContextCiphertext!, "base64")).toString("utf8");
  expect(privateRequest).not.toContain("private-fixture-key"); expect(privateRequest).not.toContain("egressPolicy");
  expect(JSON.stringify(s.fetchImplementation.mock.calls)).not.toContain("ORIGINAL-724"); expect(JSON.stringify(s.fetchImplementation.mock.calls)).not.toContain("Confirmed fixture read.");
  const duplicate = await s.send("Show me purchase orders REVISED-815", { idempotencyKey: "revision-request-fixture-0001", requestRevision });
  expect(duplicate.json().data.operation.id).toBe(receipt.operation.id);
  expect(s.callTool).toHaveBeenCalledTimes(1);
  expect(state.auditLogs).toContainEqual(expect.objectContaining({ action: "chat.request.revised", before: { sourceMessageId: first.userMessage.id, sourceHash: source.sourceHash } }));
  expect(response.body).not.toContain("Ciphertext");
});
test("request revision retains exact saved node scope and produces only a fresh unapplied proposal", async () => {
  const s = await nodeSetup(), first = (await s.send("Describe this node", { nodeContext: s.nodeContext })).json().data;
  await s.terminal(first.operation.id);
  const source = await savedRevisionSource(s, first.userMessage.id), requestRevision = { messageId: source.messageId, sourceHash: source.sourceHash };
  const noScope = await s.send("Send an email", { idempotencyKey: "revision-node-fixture-0001", requestRevision });
  expect(noScope.statusCode).toBe(409); expect(noScope.json().meta.code).toBe("CHAT_REVISION_SCOPE_CHANGED");
  const response = await s.send("Send an email", { idempotencyKey: "revision-node-fixture-0001", requestRevision, nodeContext: s.nodeContext });
  expect(response.statusCode, response.body).toBe(202);
  const operation = await s.terminal(response.json().data.operation.id);
  expect(operation).toMatchObject({ status: "ANSWERED", nodeContext: s.nodeContext, requestRevision, attempts: [] });
  expect((await s.repository.snapshot()).workflows.report!.draftVersion).toBe(1); expect(s.callTool).not.toHaveBeenCalled();
});
test("stale source, assistant source and foreign-owner revisions fail before provider/tool entry", async () => {
  const s = await setup(), first = (await s.send()).json().data;
  await s.terminal(first.operation.id);
  const source = await savedRevisionSource(s, first.userMessage.id), requestRevision = { messageId: source.messageId, sourceHash: source.sourceHash };
  s.fetchImplementation.mockClear(); s.callTool.mockClear();
  const foreign = await s.app.inject({ method: "POST", url: `/api/chat/sessions/${s.sessionId}/messages`, headers: s.headers("other"), payload: { content: "Show invoices", delivery: "async-chat", idempotencyKey: "revision-owner-fixture-0001", requestRevision } });
  expect(foreign.statusCode).toBe(404);
  const foreignView = await s.app.inject({ method: "GET", url: `/api/chat/sessions/${s.sessionId}`, headers: s.headers("other") });
  expect(foreignView.json().data.messages.some((message: Record<string, unknown>) => message.revisionSource)).toBe(false);
  const assistant = (await s.repository.snapshot()).chats[s.sessionId]!.messages.find(message => message.role === "assistant")!;
  expect((await s.send("Show invoices", { idempotencyKey: "revision-assistant-fixture-01", requestRevision: { ...requestRevision, messageId: assistant.id } })).statusCode).toBe(404);
  await s.repository.mutate(state => { state.chats[s.sessionId]!.messages[0]!.text = "Changed"; });
  const stale = await s.send("Show invoices", { idempotencyKey: "revision-stale-fixture-0001", requestRevision });
  expect(stale.statusCode).toBe(409); expect(stale.json().meta.code).toBe("CHAT_REVISION_SOURCE_CHANGED");
  expect(Object.keys((await s.repository.snapshot()).chatOperations)).toHaveLength(1);
  expect(s.fetchImplementation).not.toHaveBeenCalled(); expect(s.callTool).not.toHaveBeenCalled();
});
test("original workflow context is authenticated and retained but cannot be replaced by a revision", async () => {
  const s = await setup({ persistence: new Persistence() }), context = { yaml, name: "Original workflow" }, first = (await s.send("Create a workflow", { workflowContext: context })).json().data;
  await s.terminal(first.operation.id);
  const source = await savedRevisionSource(s, first.userMessage.id), requestRevision = { messageId: source.messageId, sourceHash: source.sourceHash };
  const wrong = await s.send("Modify the workflow", { idempotencyKey: "revision-context-fixture-0001", requestRevision, workflowContext: { yaml: "different" } });
  expect(wrong.statusCode).toBe(400);
  const response = await s.send("Modify the workflow", { idempotencyKey: "revision-context-fixture-0001", requestRevision });
  expect(response.statusCode, response.body).toBe(202);
  const operation = await s.terminal(response.json().data.operation.id);
  const saved = JSON.parse(new AESGCMCodec(s.services.config.storageEncryptionKey).decode(Buffer.from(operation.revisionContextCiphertext!, "base64")).toString("utf8"));
  expect(saved.body.workflowContext).toEqual(context);
});
test("legacy/missing or corrupted encrypted revision context cannot fabricate a fresh scope", async () => {
  for (const damage of ["legacy", "tamper"] as const) {
    const s = await setup(), first = (await s.send()).json().data; await s.terminal(first.operation.id);
    const source = await savedRevisionSource(s, first.userMessage.id), requestRevision = { messageId: source.messageId, sourceHash: source.sourceHash };
    await s.repository.mutate(state => { const operation = state.chatOperations[first.operation.id]!;
      if (damage === "legacy") delete operation.revisionContextCiphertext; else operation.revisionContextCiphertext = "tampered"; });
    s.fetchImplementation.mockClear(); s.callTool.mockClear();
    const response = await s.send("Show invoices", { idempotencyKey: "revision-corrupt-fixture-0001", requestRevision });
    expect(response.statusCode).toBe(409); expect(response.json().meta.code).toBe("CHAT_REVISION_CONTEXT_UNAVAILABLE");
    expect(s.fetchImplementation).not.toHaveBeenCalled(); expect(s.callTool).not.toHaveBeenCalled();
  }
});
test("request revision remains available after a durable reopen without provider credentials or original job replay", async () => {
  const persistence = new Persistence(), first = await setup({ persistence }), receipt = (await first.send()).json().data;
  await first.terminal(receipt.operation.id);
  const source = await savedRevisionSource(first, receipt.userMessage.id), requestRevision = { messageId: source.messageId, sourceHash: source.sourceHash };
  await first.app.close(); apps.splice(apps.indexOf(first.app), 1);
  const next = await setup({ persistence });
  const response = await next.app.inject({ method: "POST", url: `/api/chat/sessions/${first.sessionId}/messages`, headers: next.headers(), payload: {
    content: "Show purchase orders", delivery: "async-chat", idempotencyKey: "revision-reopen-fixture-0001", requestRevision } });
  expect(response.statusCode, response.body).toBe(202); await next.terminal(response.json().data.operation.id);
  expect(next.callTool).toHaveBeenCalledTimes(1); expect((await next.repository.snapshot()).chatOperations[receipt.operation.id]!.status).toBe("ANSWERED");
});
test.each(["source-context", "actor"])("revision rechecks %s inside the final admission transaction", async damage => {
  const s = await setup(), first = (await s.send()).json().data; await s.terminal(first.operation.id);
  const source = await savedRevisionSource(s, first.userMessage.id), requestRevision = { messageId: source.messageId, sourceHash: source.sourceHash };
  const snapshot = s.runtime.snapshot.bind(s.runtime);
  vi.spyOn(s.runtime, "snapshot").mockImplementationOnce(model => {
    const result = snapshot(model);
    void s.repository.mutate(state => { if (damage === "actor") state.users.owner!.status = "Suspended"; else state.chatOperations[first.operation.id]!.revisionContextCiphertext = "Changed during provider selection"; });
    return result;
  });
  s.fetchImplementation.mockClear(); s.callTool.mockClear();
  const response = await s.send("Show revised invoices", { idempotencyKey: "revision-race-fixture-0001", requestRevision });
  expect(response.statusCode).toBe(damage === "actor" ? 403 : 409);
  expect(Object.keys((await s.repository.snapshot()).chatOperations)).toHaveLength(1);
  expect(s.fetchImplementation).not.toHaveBeenCalled(); expect(s.callTool).not.toHaveBeenCalled();
});
test("revision cannot silently adopt a newer node version or synchronous delivery", async () => {
  const s = await nodeSetup(), first = (await s.send("Edit", { nodeContext: s.nodeContext })).json().data; await s.terminal(first.operation.id);
  const source = await savedRevisionSource(s, first.userMessage.id), requestRevision = { messageId: source.messageId, sourceHash: source.sourceHash };
  await s.repository.mutate(state => { state.workflows.report!.draftVersion++; });
  s.fetchImplementation.mockClear(); s.callTool.mockClear();
  const response = await s.send("Edit again", { idempotencyKey: "revision-stale-node-fixture-1", requestRevision, nodeContext: s.nodeContext });
  expect(response.statusCode).toBe(409);
  expect((await s.send("Edit again", { delivery: undefined, requestRevision })).statusCode).toBe(400);
  expect(s.fetchImplementation).not.toHaveBeenCalled(); expect(s.callTool).not.toHaveBeenCalled();
});
test("an active source operation blocks revision instead of cancelling or replaying it", async () => {
  const s = await setup(), queue = chatJobQueue(s.services), kick = vi.spyOn(queue, "kick").mockImplementation(() => {});
  const first = (await s.send()).json().data, source = await savedRevisionSource(s, first.userMessage.id);
  const response = await s.send("Show revised invoices", { idempotencyKey: "revision-active-fixture-0001", requestRevision: { messageId: source.messageId, sourceHash: source.sourceHash } });
  expect(response.statusCode).toBe(409); expect(response.json().meta.code).toBe("CHAT_OPERATION_ACTIVE");
  expect((await s.repository.snapshot()).chatOperations[first.operation.id]!.status).toBe("QUEUED");
  expect(s.fetchImplementation).not.toHaveBeenCalled(); expect(s.callTool).not.toHaveBeenCalled(); kick.mockRestore();
});

test("node scope overrides action prose, saves a reviewable proposal atomically and never dispatches ERP or edits a draft", async () => {
  const s = await nodeSetup(), content = "Get invoices and send an email to manager@example.test";
  const receipt = (await s.send(content, { nodeContext: s.nodeContext, model: "model-b" })).json().data;
  expect(receipt.operation.nodeContext).toEqual(s.nodeContext);
  const op = await s.terminal(receipt.operation.id);
  expect(op).toMatchObject({ status: "ANSWERED", attempts: [], artifactRefs: [{ type: "node-proposal" }] });
  const state = await s.repository.snapshot(), messages = state.chats[s.sessionId]!.messages;
  expect(messages).toHaveLength(2); expect(messages[0]).toMatchObject({ operationId: op.id, artifacts: { intent: "NODE_EDIT_REQUEST", nodeId: "echo" } });
  expect(messages[1]).toMatchObject({ operationId: op.id, artifacts: { intent: "NODE_PATCH_PROPOSAL", proposal: { ...s.nodeContext, status: "PROPOSED", command: { type: "updateNode", nodeId: "echo", patch: { description: "Proposed label" } } } } });
  expect(state.workflows.report).toMatchObject({ yaml, draftVersion: 1, publishedVersion: 1 });
  expect(s.callTool).not.toHaveBeenCalled(); expect(s.fetchImplementation).toHaveBeenCalledOnce();
  expect(JSON.parse(String(s.fetchImplementation.mock.calls[0]![1]?.body)).model).toBe("model-b");
  // Repeating the original identity after a later revision or lost default still retrieves it.
  await s.repository.mutate(state => { state.workflows.report!.draftVersion++; }); vi.spyOn(s.runtime, "configured", "get").mockReturnValue(false);
  expect((await s.send(content, { nodeContext: s.nodeContext, model: "model-b" })).json().data.operation.id).toBe(op.id);
  expect(s.fetchImplementation).toHaveBeenCalledOnce();
});

async function conditionalNodeSetup(output: unknown = { predicate: { kind: "literal", value: false } }, options: Parameters<typeof setup>[0] = {}) {
  const s = await nodeSetup({ ...options, toolFile: "condition-chat-tools.json" });
  const source = stringify({ name: "Conditional chat report", description: "Read the selected fixture path", trigger: { type: "manual" }, steps: [{ id: "echo", action: "demo.echo", parameters: { value: "fixture" } }], metadata: { controlFlow: { schemaVersion: "read-control-flow/v1", root: { kind: "sequence", nodes: [{ kind: "if", id: "gate", predicate: { kind: "literal", value: true }, then: { kind: "sequence", nodes: [{ kind: "action", nodeId: "echo" }] }, else: { kind: "sequence", nodes: [] } }] } } } });
  await s.repository.mutate(state => { state.workflows.report!.yaml = source; state.versions.report![0]!.yaml = source; });
  s.fetchImplementation.mockImplementation(async () => Response.json({ choices: [{ message: { content: JSON.stringify(output) } }] }));
  return { ...s, source, nodeContext: { ...s.nodeContext, nodeId: "gate", baseHash: workflowContentHash(source) } };
}

async function collectionNodeSetup(output: unknown = { maxItems: 2 }) {
  const s = await nodeSetup();
  const source = stringify({ name: "Collection chat report", description: "Read a bounded supplied list", trigger: { type: "manual", config: { inputSchema: { type: "object", properties: { rows: { type: "array", items: { type: "string" } } }, required: ["rows"], additionalProperties: false } } },
    steps: [{ id: "echo", action: "demo.echo", parameters: { value: "{{each.item}}" } }], metadata: { controlFlow: { schemaVersion: "read-control-flow/v3", root: { kind: "sequence", nodes: [{ kind: "foreach", id: "each", maxItems: 3,
      items: { schema: { type: "array", items: { type: "string" } }, value: { kind: "ref", source: "workflowInput", path: ["rows"] } }, body: { kind: "sequence", nodes: [{ kind: "action", nodeId: "echo" }] },
      collect: { schema: { type: "string" }, value: { kind: "ref", source: "nodeOutput", nodeId: "each", path: ["item"] } } }] } } } });
  await s.repository.mutate(state => { state.workflows.report!.yaml = source; state.versions.report![0]!.yaml = source; });
  s.fetchImplementation.mockImplementation(async () => Response.json({ choices: [{ message: { content: JSON.stringify(output) } }] }));
  return { ...s, source, nodeContext: { ...s.nodeContext, nodeId: "each", baseHash: workflowContentHash(source) } };
}

test("saved collection-owner chat selects its captured model and saves only a reviewable bounded proposal", async () => {
  const s = await collectionNodeSetup(), content = "Limit this collection to two items and send an email";
  const receipt = (await s.send(content, { nodeContext: s.nodeContext, model: "model-b" })).json().data, op = await s.terminal(receipt.operation.id);
  expect(op).toMatchObject({ status: "ANSWERED", attempts: [], artifactRefs: [{ type: "node-proposal" }] });
  const state = await s.repository.snapshot(), proposal = (state.chats[s.sessionId]!.messages[1]!.artifacts as any).proposal;
  expect(proposal).toMatchObject({ ...s.nodeContext, command: { type: "updateCollection", nodeId: "each", patch: { maxItems: 2 } }, status: "PROPOSED", modelBinding: { model: "model-b" } });
  expect(proposal.after.body).toEqual(proposal.before.body); expect(proposal.after.id).toBe("each");
  expect(proposal.validation.passed).toBe(true);
  expect(state.workflows.report).toMatchObject({ yaml: s.source, draftVersion: 1, publishedVersion: 1 }); expect(state.executions).toEqual({}); expect(s.callTool).not.toHaveBeenCalled();
  const body = JSON.parse(String(s.fetchImplementation.mock.calls[0]![1]?.body)); expect(body.model).toBe("model-b"); expect(body.messages[0].content).toContain("ONE SELECTED COLLECTION PATCH"); expect(JSON.parse(body.messages[1].content).tools).toEqual([]);
  expect((await s.send(content, { nodeContext: s.nodeContext, model: "model-b" })).json().data.operation.id).toBe(op.id); expect(s.fetchImplementation).toHaveBeenCalledOnce();
});

test("saved collection chat does not label an unavailable binding as a valid or executed change", async () => {
  const s = await collectionNodeSetup({ collect: { schema: { type: "string" }, value: { kind: "ref", source: "nodeOutput", nodeId: "future", path: ["value"] } } });
  const receipt = (await s.send("Use this unavailable result", { nodeContext: s.nodeContext })).json().data;
  expect((await s.terminal(receipt.operation.id)).status).toBe("ANSWERED");
  const state = await s.repository.snapshot(), proposal = (state.chats[s.sessionId]!.messages[1]!.artifacts as any).proposal;
  expect(proposal.validation).toMatchObject({ passed: false, failed_rules: expect.arrayContaining(["WORKSPACE_READ_COMPILATION"]) });
  expect(state.workflows.report!.yaml).toBe(s.source); expect(state.executions).toEqual({}); expect(s.callTool).not.toHaveBeenCalled();
});

test("a saved collection patch cannot commit after its source revision changes during the model wait", async () => {
  const s = await collectionNodeSetup(), entered = barrier(), release = barrier();
  s.fetchImplementation.mockImplementation(async () => { entered.release(); await release.promise; return Response.json({ choices: [{ message: { content: '{"maxItems":2}' } }] }); });
  const id = (await s.send("Edit collection", { nodeContext: s.nodeContext })).json().data.operation.id;
  await entered.promise; await s.repository.mutate(state => { state.workflows.report!.draftVersion++; }); release.release();
  const stopped = await s.terminal(id); expect(stopped).toMatchObject({ status: "FAILED", reason: "DRAFT_REVISION_CONFLICT" }); expect(stopped.artifactRefs ?? []).toEqual([]);
  expect((await s.repository.snapshot()).chats[s.sessionId]!.messages).toHaveLength(1); expect(s.callTool).not.toHaveBeenCalled();
});

test("saved return chat job captures the model, emits only an owned output proposal and never dispatches ERP", async () => {
  const output = { schema: { type: "boolean" }, value: { kind: "literal", value: false } }, s = await nodeSetup();
  const source = stringify({ name: "Return chat report", trigger: { type: "manual" }, steps: [{ id: "echo", action: "demo.echo", parameters: { value: "fixture" } }], metadata: { controlFlow: { schemaVersion: "read-control-flow/v2", root: { kind: "sequence", nodes: [{ kind: "action", nodeId: "echo" }, { kind: "return", id: "answer", output }] } } } });
  await s.repository.mutate(state => { state.workflows.report!.yaml = source; });
  s.fetchImplementation.mockImplementation(async () => Response.json({ choices: [{ message: { content: JSON.stringify({ output }) } }] }));
  const context = { ...s.nodeContext, nodeId: "answer", baseHash: workflowContentHash(source) }, id = (await s.send("Send an email after editing this return", { nodeContext: context, model: "model-b" })).json().data.operation.id;
  expect((await s.terminal(id)).status).toBe("ANSWERED"); const state = await s.repository.snapshot();
  const artifact = state.chats[s.sessionId]!.messages[1]!.artifacts as any;
  expect(artifact.proposal.command).toEqual({ type: "updateReturn", nodeId: "answer", patch: { output } }); expect(state.workflows.report!.yaml).toBe(source); expect(state.executions).toEqual({}); expect(s.callTool).not.toHaveBeenCalled();
  const body = JSON.parse(String(s.fetchImplementation.mock.calls[0]![1]?.body)); expect(body.model).toBe("model-b"); expect(body.messages[0].content).toContain("ONE SELECTED RETURN PATCH"); expect(JSON.parse(body.messages[1].content).tools).toEqual([]);
});
test("saved condition chat job returns an owned predicate-only proposal with selected model and zero ERP dispatch", async () => {
  const s = await conditionalNodeSetup(), id = (await s.send("Change this condition and send an email", { nodeContext: s.nodeContext, model: "model-b" })).json().data.operation.id;
  expect((await s.terminal(id)).status).toBe("ANSWERED");
  const state = await s.repository.snapshot(), proposal = (state.chats[s.sessionId]!.messages[1]!.artifacts as any).proposal;
  expect(proposal.command).toEqual({ type: "updateCondition", nodeId: "gate", patch: { predicate: { kind: "literal", value: false } } });
  expect(state.workflows.report!.yaml).toBe(s.source); expect(state.executions).toEqual({}); expect(s.callTool).not.toHaveBeenCalled();
  const body = JSON.parse(String(s.fetchImplementation.mock.calls[0]![1]?.body)); expect(body.model).toBe("model-b"); expect(body.messages[0].content).toContain("ONE SELECTED CONDITION PATCH");
});
test.each([false, true])("saved condition chat persists a typed output proposal with atomic predicate edit=%s and no execution", async combined => {
  const merge = { schema: { type: "string" }, then: { kind: "ref", source: "nodeOutput", nodeId: "echo", path: ["structuredContent", "value"] }, else: { kind: "literal", value: "Explicit No output" } },
    patch = { merge, ...(combined ? { predicate: { kind: "literal", value: false } } : {}) };
  const persistence = new Persistence(), s = await conditionalNodeSetup(patch, { persistence }), content = "Change the selected output; do not send mail";
  const receipt = (await s.send(content, { nodeContext: s.nodeContext, model: "model-b" })).json().data;
  expect(await s.terminal(receipt.operation.id)).toMatchObject({ status: "ANSWERED", attempts: [] });
  const snapshot = await s.repository.snapshot(), proposal = (snapshot.chats[s.sessionId]!.messages.at(-1)!.artifacts as any).proposal;
  expect(proposal).toMatchObject({ ...s.nodeContext, status: "PROPOSED", validation: { passed: true }, command: { type: "updateCondition", nodeId: "gate", patch }, modelBinding: { model: "model-b" } });
  expect(proposal.after.then).toEqual(proposal.before.then); expect(proposal.after.else).toEqual(proposal.before.else);
  expect(snapshot.workflows.report!.yaml).toBe(s.source); expect(snapshot.executions).toEqual({});
  const request = JSON.parse(String(s.fetchImplementation.mock.calls[0]![1]?.body)), data = JSON.parse(request.messages[1].content);
  expect(request.model).toBe("model-b"); expect(data.tools).toEqual([]); expect(data.allowedMergeSources.then.some((hint: any) => hint.binding.nodeId === "echo")).toBe(true);
  expect(data.allowedMergeSources.else.some((hint: any) => hint.binding.nodeId === "echo")).toBe(false);
  await s.app.close(); apps.splice(apps.indexOf(s.app), 1);
  const reopened = await setup({ persistence, toolFile: "condition-chat-tools.json" });
  expect((await reopened.repository.snapshot()).chats[s.sessionId]!.messages).toEqual(snapshot.chats[s.sessionId]!.messages);
  const replay = await reopened.app.inject({ method: "POST", url: `/api/chat/sessions/${s.sessionId}/messages`, headers: reopened.headers(), payload: { content, delivery: "async-chat", idempotencyKey: "chat-job-fixture-00001", nodeContext: s.nodeContext, model: "model-b" } });
  expect(replay.json().data.operation.id).toBe(receipt.operation.id); expect(reopened.fetchImplementation).not.toHaveBeenCalled();
  expect(s.callTool).not.toHaveBeenCalled(); expect(reopened.callTool).not.toHaveBeenCalled();
});

test.each(["edit", "cancel", "revocation"])("a condition-output proposal cannot commit after %s during model generation", async kind => {
  const merge = { schema: { type: "string" }, then: { kind: "literal", value: "Yes" }, else: { kind: "literal", value: "No" } }, s = await conditionalNodeSetup({ merge }), entered = barrier(), release = barrier();
  s.fetchImplementation.mockImplementationOnce(async () => { entered.release(); await release.promise; return Response.json({ choices: [{ message: { content: JSON.stringify({ merge }) } }] }); });
  const id = (await s.send("Change output", { nodeContext: s.nodeContext })).json().data.operation.id; await entered.promise;
  if (kind === "edit") await s.repository.mutate(state => { state.workflows.report!.draftVersion++; });
  else if (kind === "revocation") await s.repository.mutate(state => { state.users.owner!.status = "Inactive"; });
  else await s.app.inject({ method: "POST", url: `/api/chat/operations/${id}/cancel`, headers: s.headers(), payload: {} });
  release.release(); expect((await s.terminal(id)).status).toBe(kind === "cancel" ? "CANCELLED" : "FAILED");
  const state = await s.repository.snapshot(); expect(state.chats[s.sessionId]!.messages).toHaveLength(1); expect(state.workflows.report!.yaml).toBe(s.source); expect(s.callTool).not.toHaveBeenCalled();
});

test.each([{ parameters: {} }, { predicate: { kind: "literal", value: true }, else: { kind: "sequence", nodes: [] } }, { predicate: { kind: "literal", value: 0 } }])("saved condition chat rejects scope-escaping model output %j without applying or dispatching", async output => {
  const s = await conditionalNodeSetup(output), id = (await s.send("Edit", { nodeContext: s.nodeContext })).json().data.operation.id;
  expect((await s.terminal(id)).status).toBe("FAILED");
  const state = await s.repository.snapshot(); expect(state.workflows.report!.yaml).toBe(s.source); expect(state.chats[s.sessionId]!.messages).toHaveLength(1); expect(s.callTool).not.toHaveBeenCalled();
});
test.each(["edit", "cancel"])("late conditional proposal generation is fenced after %s", async kind => {
  const s = await conditionalNodeSetup(), entered = barrier(), unblock = barrier();
  s.fetchImplementation.mockImplementationOnce(async () => { entered.release(); await unblock.promise; return Response.json({ choices: [{ message: { content: '{"predicate":{"kind":"literal","value":false}}' } }] }); });
  const id = (await s.send("Edit", { nodeContext: s.nodeContext })).json().data.operation.id; await entered.promise;
  if (kind === "edit") await s.repository.mutate(state => { state.workflows.report!.draftVersion++; });
  else await s.app.inject({ method: "POST", url: `/api/chat/operations/${id}/cancel`, headers: s.headers(), payload: {} });
  unblock.release(); expect((await s.terminal(id)).status).toBe(kind === "edit" ? "FAILED" : "CANCELLED");
  expect((await s.repository.snapshot()).chats[s.sessionId]!.messages).toHaveLength(1); expect(s.callTool).not.toHaveBeenCalled();
});

test.each(["invalid", "stale", "missing-node", "unconfigured"])("node admission rejects %s before saving a message or invoking a provider", async kind => {
  const s = await nodeSetup(); const context = { ...s.nodeContext };
  if (kind === "stale") context.baseVersion++;
  if (kind === "missing-node") context.nodeId = "absent";
  if (kind === "unconfigured") vi.spyOn(s.runtime, "configured", "get").mockReturnValue(false);
  const result = await s.send("Edit", { nodeContext: kind === "invalid" ? { ...context, hidden: true } : context });
  expect(result.statusCode).toBe(kind === "invalid" ? 400 : kind === "stale" ? 409 : kind === "missing-node" ? 422 : 503);
  expect((await s.repository.snapshot()).chats[s.sessionId]!.messages).toHaveLength(0);
  expect(s.fetchImplementation).not.toHaveBeenCalled(); expect(s.callTool).not.toHaveBeenCalled();
});

test.each(["edit", "revoke", "cancel"])("late node generation cannot save a proposal after %s", async kind => {
  const s = await nodeSetup(), entered = barrier(), unblock = barrier();
  s.fetchImplementation.mockImplementationOnce(async () => { entered.release(); await unblock.promise; return Response.json({ choices: [{ message: { content: '{"description":"Late"}' } }] }); });
  const id = (await s.send("Edit", { nodeContext: s.nodeContext })).json().data.operation.id; await entered.promise;
  if (kind === "edit") await s.repository.mutate(state => { state.workflows.report!.draftVersion++; });
  if (kind === "revoke") await s.repository.mutate(state => { state.users.owner!.status = "Inactive"; });
  if (kind === "cancel") await s.app.inject({ method: "POST", url: `/api/chat/operations/${id}/cancel`, headers: s.headers(), payload: {} });
  unblock.release(); expect((await s.terminal(id)).status).toBe(kind === "cancel" ? "CANCELLED" : "FAILED");
  if (kind === "edit") expect((await s.repository.snapshot()).chatOperations[id]!.reason).toBe("DRAFT_REVISION_CONFLICT");
  const state = await s.repository.snapshot(); expect(state.chats[s.sessionId]!.messages).toHaveLength(1); expect(state.chatOperations[id]!.artifactRefs).toBeUndefined();
  expect(s.callTool).not.toHaveBeenCalled();
});

test("a committed node answer with lost storage acknowledgement is restored without another model call", async () => {
  const persistence = new Persistence(), s = await nodeSetup({ persistence });
  persistence.commitBeforeFailure = true; persistence.failWhen = state => Object.values(state.chatOperations).some(op => op.status === "ANSWERED");
  const receipt = (await s.send("Edit", { nodeContext: s.nodeContext })).json().data;
  await vi.waitFor(() => expect(JSON.parse(Buffer.from(persistence.payload!).toString()).chatOperations[receipt.operation.id].status).toBe("ANSWERED"));
  await s.app.close(); apps.splice(apps.indexOf(s.app), 1);
  const next = await setup({ persistence });
  const saved = (await next.get(receipt.operation.id)).json().data.operation;
  expect(saved).toMatchObject({ status: "ANSWERED", artifactRefs: [{ type: "node-proposal" }] });
  expect((await next.repository.snapshot()).chats[s.sessionId]!.messages).toHaveLength(2);
  expect(next.fetchImplementation).not.toHaveBeenCalled(); expect(next.callTool).not.toHaveBeenCalled();
});

test("capabilities identify admission support without external discovery, and node context cannot fall back to synchronous chat", async () => {
  const s = await nodeSetup();
  const capability = await s.app.inject({ method: "GET", url: "/api/chat/capabilities", headers: s.headers() });
  expect(capability.statusCode).toBe(200); expect(capability.json().data).toEqual({ profile: "chat-admission-v1", asyncChat: true, nodeProposals: true, requestRevisions: true, localDraftEdits: true });
  const response = await s.send("Send an email", { delivery: undefined, nodeContext: s.nodeContext });
  expect(response.statusCode).toBe(400); expect(s.fetchImplementation).not.toHaveBeenCalled(); expect(s.callTool).not.toHaveBeenCalled();
});

test("queued node proposal survives restart with its original model and revision binding", async () => {
  const persistence = new Persistence(), first = await nodeSetup({ persistence });
  const queue = chatJobQueue(first.services), kick = vi.spyOn(queue, "kick").mockImplementation(() => {});
  const op = (await first.send("Edit", { nodeContext: first.nodeContext, model: "model-b" })).json().data.operation;
  await first.app.close(); apps.splice(apps.indexOf(first.app), 1); kick.mockRestore();
  const second = await setup({ persistence });
  expect((await second.terminal(op.id)).status).toBe("ANSWERED");
  expect(second.fetchImplementation).toHaveBeenCalledOnce(); expect(first.fetchImplementation).not.toHaveBeenCalled(); expect(second.callTool).not.toHaveBeenCalled();
  expect(JSON.parse(String(second.fetchImplementation.mock.calls[0]![1]?.body)).model).toBe("model-b");
  expect((await second.repository.snapshot()).chats[first.sessionId]!.messages.at(-1)).toMatchObject({ artifacts: { proposal: { ...first.nodeContext, after: { description: "Proposed label" } } } });
});

test("unsupported storage capability is explicit and a legacy node endpoint cannot bypass an active chat operation", async () => {
  const unsupported = new Persistence(); Object.defineProperty(unsupported, "readQueueDurability", { value: undefined });
  const first = await setup({ persistence: unsupported });
  expect((await first.app.inject({ method: "GET", url: "/api/chat/capabilities", headers: first.headers() })).json().data).toMatchObject({ asyncChat: false, nodeProposals: false });
  const s = await nodeSetup(), queue = chatJobQueue(s.services), kick = vi.spyOn(queue, "kick").mockImplementation(() => {});
  await s.send("Edit", { nodeContext: s.nodeContext });
  const result = await s.app.inject({ method: "POST", url: "/api/workflows/report/node-proposals", headers: s.headers(), payload: { ...s.nodeContext, workflowId: undefined, prompt: "Edit again", sessionId: s.sessionId } });
  expect(result.statusCode).toBe(409); expect(s.fetchImplementation).not.toHaveBeenCalled(); expect(s.callTool).not.toHaveBeenCalled(); kick.mockRestore();
});

test("admission returns before held ERP completion, duplicates never re-execute, and saved receipts precede narration", async () => {
  const s = await setup(), entered = barrier(), unblock = barrier();
  s.callTool.mockImplementationOnce(async () => { entered.release(); await unblock.promise; return { content: [], structuredContent: { value: "confirmed", token: "private-secret" } }; });
  const response = await s.send(); expect(response.statusCode, response.body).toBe(202); const receipt = response.json().data, id = receipt.operation.id;
  expect(receipt.operation.status).toBe("QUEUED"); expect(receipt.userMessage.operationId).toBe(id);
  await entered.promise;
  const running = (await s.get(id)).json().data;
  expect(running.operation).toMatchObject({ status: "RUNNING", stage: "READING", attempts: [{ status: "DISPATCH_INTENT" }] });
  expect((await s.send()).json().data.operation.id).toBe(id); expect(s.callTool).toHaveBeenCalledOnce();
  const mismatch = await s.send("Show me other data"); expect(mismatch.statusCode).toBe(409);
  unblock.release(); expect((await s.terminal(id)).status).toBe("ANSWERED");
  const final = (await s.get(id)).json().data;
  expect(final.operation.attempts[0]).toMatchObject({ status: "DONE", output: { structuredContent: { value: "confirmed" } } });
  expect(final.operation.attempts[0].output.structuredContent.token).toBeUndefined();
  expect(final.events.map((e: { sequence: number }) => e.sequence)).toEqual(final.events.map((_e: unknown, i: number) => i + 1));
  expect(final.events.findIndex((e: { type: string }) => e.type === "tool.completed")).toBeLessThan(final.events.findIndex((e: { type: string }) => e.type === "answer.saved"));
  expect(JSON.stringify(final)).not.toMatch(/private-secret|private-fixture-key|inputCiphertext|requestFingerprint|idempotencyScope/);
  const state = await s.repository.snapshot(); expect(state.chatOperations[id]?.inputCiphertext).toBeUndefined();
  expect(state.chats[s.sessionId]?.messages).toHaveLength(2);
  expect(state.chats[s.sessionId]?.messages[1]?.operationId).toBe(id);
  expect((await s.send()).json().data.operation.id).toBe(id); expect(s.callTool).toHaveBeenCalledOnce();
});

test.each(["Get invoice details and email them to manager@example.test", "Create a workflow to read invoices", "Modify the workflow name", "What can you do?"])("queued path preserves request intent: %s", async content => {
  const s = await setup(); const response = await s.send(content, { model: "model-b", workflowContext: { yaml, name: "Report" } });
  expect(response.statusCode, response.body).toBe(202); const id = response.json().data.operation.id;
  expect((await s.terminal(id)).status).toBe("ANSWERED");
  const state = await s.repository.snapshot(), message = state.chats[s.sessionId]?.messages.at(-1)!;
  expect(message.role).toBe("assistant");
  expect(s.runtime.configuration?.model).toBe("model-a");
  for (const [, init] of s.fetchImplementation.mock.calls) expect(JSON.parse(String(init?.body)).model).toBe("model-b");
  if (content.includes("email")) expect(message.artifacts).toMatchObject({ emailDraft: { state: "DRAFT_NOT_SENT", to: "manager@example.test" }, can_execute: false });
  if (content.startsWith("Create")) expect(Object.values(state.workflows)[0]).toMatchObject({ publishedVersion: 0, canRun: false });
});

test("queued snapshot does not adopt later administration model/endpoint/credential changes", async () => {
  const s = await setup(); const queue = chatJobQueue(s.services), kick = vi.spyOn(queue, "kick").mockImplementation(() => {});
  const admitted = (await s.send("Show me invoices", { model: "model-b" })).json().data.operation;
  s.runtime.activate({ ...s.runtime.configuration!, baseURL: "https://new.example.test/v1", apiKey: "new-fixture-key", model: "new-model",
    egressPolicy: { profile: "model-egress-policy/v1", approvedOrigin: "https://new.example.test", runtimeAnalysisDataClasses: [], interactiveDataClasses: [], reviewedAt: null, reviewedBy: null } });
  kick.mockRestore(); queue.kick(); expect((await s.terminal(admitted.id)).status).toBe("ANSWERED");
  for (const [url, init] of s.fetchImplementation.mock.calls) {
    expect(url).toBe("https://old.example.test/v1/chat/completions"); expect((init!.headers as Record<string,string>).authorization).toBe("Bearer private-fixture-key");
    expect(JSON.parse(String(init!.body)).model).toBe("model-b");
  }
  expect(s.runtime.configuration?.model).toBe("new-model");
  expect(Object.values((await s.repository.snapshot()).invocationProvenance).every(entry => entry.configurationRevision === admitted.modelBinding.configurationRevision)).toBe(true);
});

test.each(["initial", "summary"])("saved queued chat %s failover preserves model selection, confirmed read and original duplicate receipt", async phase => {
  const persistence = new Persistence(), s = await setup({ persistence }), original = s.fetchImplementation.getMockImplementation()!;
  s.runtime.activate({ ...s.runtime.configuration!, fallbackModel: "model-c" });
  s.fetchImplementation.mockImplementation(async (...args) => {
    const input = JSON.parse(String(args[1]?.body)), hasRead = input.messages.some((message: any) => message.role === "tool");
    if (input.model === "model-b" && (phase === "initial" || hasRead)) return new Response("", { status: 503 });
    const response = await original(...args), decoded: any = await response.json();
    if (decoded.choices[0].finish_reason === "tool_calls") decoded.choices[0].message.reasoning_details = [{ type: "reasoning.encrypted", data: "private-queued-continuation-marker" }];
    return Response.json(decoded);
  });
  const request = await s.send("Show me invoices", { model: "model-b" }); expect(request.statusCode, request.body).toBe(202);
  const id = request.json().data.operation.id; expect((await s.terminal(id)).status).toBe("ANSWERED");
  expect(s.callTool).toHaveBeenCalledTimes(1);
  expect(s.fetchImplementation.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).model)).toEqual(phase === "initial" ? ["model-b", "model-c", "model-c"] : ["model-b", "model-b", "model-c"]);
  const opened = await Repository.open(persistence);
  try {
    const state = await opened.snapshot(), op = state.chatOperations[id]!, chat = state.chats[s.sessionId]!;
    expect(op).toMatchObject({ status: "ANSWERED", modelBinding: { model: "model-b" }, attempts: [{ status: "DONE" }] });
    expect(chat.selectedModel).toBe("model-b");
    expect(chat.messages.at(-1)).toMatchObject({ modelBinding: { requestedModel: "model-b", model: "model-c", fallbackUsed: true },
      artifacts: { modelRouting: { requestedModel: "model-b", model: "model-c", fallbackUsed: true } } });
    expect(JSON.stringify(chat)).not.toMatch(/private-queued-continuation-marker|providerContinuationSecret|private-fixture-key|private-remote-secret/);
  } finally { await opened.close(); }
  expect((await s.send("Show me invoices", { model: "model-b" })).json().data.operation.id).toBe(id);
  expect(s.callTool).toHaveBeenCalledTimes(1); expect(s.fetchImplementation).toHaveBeenCalledTimes(3);
});

test("queued cancellation makes zero external calls, and other accounts cannot see or cancel it", async () => {
  const s = await setup(); const kick = vi.spyOn(chatJobQueue(s.services), "kick").mockImplementation(() => {});
  const id = (await s.send()).json().data.operation.id;
  expect((await s.get(id, "other")).statusCode).toBe(404);
  expect((await s.app.inject({ method: "POST", url: `/api/chat/operations/${id}/cancel`, headers: s.headers("other"), payload: {} })).statusCode).toBe(404);
  const result = await s.app.inject({ method: "POST", url: `/api/chat/operations/${id}/cancel`, headers: s.headers(), payload: {} });
  expect(result.statusCode).toBe(200); expect(result.json().data.status).toBe("CANCELLED");
  expect(s.fetchImplementation).not.toHaveBeenCalled(); expect(s.callTool).not.toHaveBeenCalled();
  kick.mockRestore();
});

test("in-flight cancellation preserves UNKNOWN and late output never becomes an answer", async () => {
  const s = await setup(), entered = barrier(), unblock = barrier();
  s.callTool.mockImplementationOnce(async () => { entered.release(); await unblock.promise; return { content: [], structuredContent: { value: "late-not-confirmed" } }; });
  const id = (await s.send()).json().data.operation.id; await entered.promise;
  expect((await s.app.inject({ method: "POST", url: `/api/chat/operations/${id}/cancel`, headers: s.headers(), payload: {} })).statusCode).toBe(202);
  const terminal = await s.terminal(id); expect(terminal).toMatchObject({ status: "RECOVERY_REQUIRED", attempts: [{ status: "UNKNOWN" }] });
  unblock.release(); await new Promise(resolve => setImmediate(resolve));
  expect((await s.repository.snapshot()).chatOperations[id]).toEqual(terminal);
  expect((await s.repository.snapshot()).chats[s.sessionId]?.messages).toHaveLength(1);
});

test("known MCP failure and unconfirmed timeout remain distinct", async () => {
  for (const timeout of [false, true]) {
    const s = await setup({ timeoutMs: 30 });
    s.callTool.mockImplementationOnce(async () => timeout ? new Promise(() => {}) : { content: [{ type: "text", text: "Rate limit reached" }], isError: true, _meta: { private: "secret", "com.erpbridge/error": { type: "rate_limit", retryable: true, retryAfterMs: 1000 } } });
    const id = (await s.send()).json().data.operation.id;
    const final = await s.terminal(id);
    expect(final.attempts[0]?.status).toBe(timeout ? "UNKNOWN" : "FAILED");
    expect(final.status).toBe(timeout ? "RECOVERY_REQUIRED" : "ANSWERED");
    if (!timeout) {
      const visible = (await s.get(id)).json().data.operation;
      expect(visible.attempts[0].output).toMatchObject({ isError: true, _meta: { "com.erpbridge/error": { type: "rate_limit", retryAfterMs: 1000 } } });
      expect(JSON.stringify(visible)).not.toContain("secret");
    }
    expect(s.callTool).toHaveBeenCalledOnce();
  }
});

test.each([
  { decision: "deny" as const, source: "local_model" as const },
  { decision: "review" as const, source: "local_model" as const },
  { decision: "deny" as const, source: "local_model" as const, failureCode: "LOCAL_POLICY_RESPONSE_INVALID" as const },
])("saved policy failure receipt survives fresh storage readback: $decision $failureCode", async outcome => {
  const persistence = new Persistence(), s = await setup({ persistence }), secret = "RAW_SECRET_SENTINEL";
  const policy = vi.spyOn(optionalPolicy, "evaluateOptionalPolicy")
    .mockResolvedValueOnce({ decision: "allow", source: "local_model", reason: "Synthetic chat preflight" })
    .mockResolvedValueOnce({ ...outcome, reason: secret, model: secret });
  try {
    const id = (await s.send()).json().data.operation.id, final = await s.terminal(id);
    expect(final.attempts).toHaveLength(1);
    expect(final.attempts[0]).toMatchObject({ status: "FAILED", output: outcome });
    const visible = (await s.get(id)).json().data.operation;
    expect(visible.attempts[0].output).toEqual(outcome);
    expect(JSON.stringify(visible)).not.toContain(secret);
    expect(s.callTool).not.toHaveBeenCalled(); expect(s.fetchImplementation).toHaveBeenCalledOnce(); expect(policy).toHaveBeenCalledTimes(2);
    expect((await s.repository.snapshot()).chatOperationEvents[id]!.some(event => event.type === "tool.dispatch_intent")).toBe(false);
    await s.app.close(); apps.splice(apps.indexOf(s.app), 1);
    const fresh = await Repository.open(persistence);
    try { expect((await fresh.snapshot()).chatOperations[id]!.attempts[0]!.output).toEqual(outcome); } finally { await fresh.close(); }
  } finally { policy.mockRestore(); }
});

test("an older authentic policy error cannot settle a newly entered SDK attempt", async () => {
  const s = await setup(), policy = vi.spyOn(optionalPolicy, "evaluateOptionalPolicy")
    .mockResolvedValueOnce({ decision: "deny", source: "local_model", reason: "RAW_SECRET_SENTINEL" });
  let oldError: unknown;
  try { oldError = await dispatchReadTool(s.services, "owner", "demo.echo", { value: "fixture" }).catch(error => error); }
  finally { policy.mockRestore(); }
  expect(s.callTool).not.toHaveBeenCalled();
  s.callTool.mockRejectedValueOnce(oldError);
  const id = (await s.send()).json().data.operation.id, final = await s.terminal(id);
  expect(final.status).toBe("RECOVERY_REQUIRED");
  expect(final.attempts[0]).toMatchObject({ status: "UNKNOWN" }); expect(final.attempts[0]!.output).toBeUndefined();
  expect(s.callTool).toHaveBeenCalledOnce(); expect(s.fetchImplementation).toHaveBeenCalledOnce();
});

test("saved chat does not trust a thrown public MCP error as an acknowledged answer or failure receipt", async () => {
  const s = await setup();
  s.callTool.mockRejectedValueOnce(new ErpbridgeMcpToolError({ content: [], isError: true }));
  const id = (await s.send()).json().data.operation.id, final = await s.terminal(id);
  expect(final.status).toBe("RECOVERY_REQUIRED"); expect(final.attempts[0]!.status).toBe("UNKNOWN");
  expect(final.attempts[0]!.output).toBeUndefined(); expect(s.callTool).toHaveBeenCalledOnce();
  const stopped = (await s.repository.snapshot()).chats[s.sessionId]!.messages.at(-1)!;
  expect(stopped.text).toContain("No confirmed ERP data was retrieved.");
  expect(stopped.text).toContain("No email was sent, schedule activated or ERP change made.");
  expect(stopped.text).not.toContain("Confirmed fixture read");
});

test("actor revocation before final narration cannot persist an old-role answer", async () => {
  const s = await setup(), entered = barrier(), unblock = barrier();
  s.fetchImplementation.mockImplementationOnce(async () => Response.json({ choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [{ id: "one", type: "function", function: { name: "demo.echo", arguments: '{"value":"fixture"}' } }] } }] }));
  s.fetchImplementation.mockImplementationOnce(async () => { entered.release(); await unblock.promise; return Response.json({ choices: [{ finish_reason: "stop", message: { content: "old-role-private-answer" } }] }); });
  const id = (await s.send()).json().data.operation.id; await entered.promise;
  await s.repository.mutate(state => { state.users.owner!.roleId = "role_client"; });
  unblock.release(); expect((await s.terminal(id)).status).toBe("FAILED");
  expect((await s.get(id)).statusCode).toBe(403);
  expect((await s.repository.snapshot()).chats[s.sessionId]?.messages).toHaveLength(1);
  expect(s.callTool).toHaveBeenCalledOnce();
});

test("unclaimed durable job survives restart and private model configuration is encrypted", async () => {
  const persistence = new Persistence(), first = await setup({ persistence });
  const kick = vi.spyOn(chatJobQueue(first.services), "kick").mockImplementation(() => {});
  const id = (await first.send("Show me invoices", { model: "model-b" })).json().data.operation.id;
  const state = await first.repository.snapshot(); expect(state.chatOperations[id]?.inputCiphertext).not.toContain("private-fixture-key");
  await first.app.close(); kick.mockRestore();
  const second = await setup({ persistence }); await second.app.ready();
  const final = await second.terminal(id); expect(final.status).toBe("ANSWERED");
  expect(second.callTool).toHaveBeenCalledOnce(); expect(first.callTool).not.toHaveBeenCalled();
  expect(second.fetchImplementation.mock.calls.every(([, init]) => JSON.parse(String(init?.body)).model === "model-b")).toBe(true);
});

test("claimed crash image recovers without replay; stale worker output is fenced", async () => {
  const persistence = new Persistence(), first = await setup({ persistence }), entered = barrier(), unblock = barrier();
  first.callTool.mockImplementationOnce(async () => { entered.release(); await unblock.promise; return { content: [], structuredContent: { value: "late-stale-worker" } }; });
  const id = (await first.send()).json().data.operation.id; await entered.promise;
  const crash = new Persistence(); crash.payload = Buffer.from(persistence.payload!);
  const second = await setup({ persistence: crash }); await second.app.ready();
  expect((await second.repository.snapshot()).chatOperations[id]).toMatchObject({ status: "RECOVERY_REQUIRED", attempts: [{ status: "UNKNOWN" }] });
  expect(second.callTool).not.toHaveBeenCalled();
  await first.app.close(); unblock.release(); await new Promise(resolve => setImmediate(resolve));
  expect((await first.repository.snapshot()).chats[first.sessionId]?.messages).toHaveLength(1);
});

test.each(["QUEUED", "RUNNING", "ANSWERED"])("lost %s acknowledgement fences dispatch and does not replay a claimed job", async phase => {
  const persistence = new Persistence(), first = await setup({ persistence }); persistence.commitBeforeFailure = true;
  persistence.failWhen = state => Object.values(state.chatOperations).some(op => op.status === phase);
  const response = await first.send(); expect(response.statusCode).toBe(phase === "QUEUED" ? 500 : 202);
  await vi.waitFor(async () => expect((await first.repository.persistenceStatus()).healthy).toBe(false));
  const stored = JSON.parse(Buffer.from(persistence.payload!).toString("utf8")) as RepositoryState;
  const id = Object.keys(stored.chatOperations)[0]!;
  const image = new Persistence(); image.payload = Buffer.from(persistence.payload!);
  await first.repository.recoverPersistenceState(); await first.app.close();
  const second = await setup({ persistence: image }); await second.app.ready();
  const final = await second.terminal(id);
  expect(final.status).toBe(phase === "RUNNING" ? "RECOVERY_REQUIRED" : "ANSWERED");
  expect(second.callTool).toHaveBeenCalledTimes(phase === "QUEUED" ? 1 : 0);
  expect(first.callTool).toHaveBeenCalledTimes(phase === "ANSWERED" ? 1 : 0);
});

test("one active operation per conversation and synchronous sends cannot bypass it", async () => {
  const s = await setup(); const kick = vi.spyOn(chatJobQueue(s.services), "kick").mockImplementation(() => {});
  await s.send(); expect((await s.send("Other", { idempotencyKey: "another-chat-key-0001" })).statusCode).toBe(409);
  const sync = await s.app.inject({ method: "POST", url: `/api/chat/sessions/${s.sessionId}/messages`, headers: s.headers(), payload: { content: "Show me invoices" } });
  expect((await s.app.inject({ method: "DELETE", url: `/api/chat/sessions/${s.sessionId}`, headers: s.headers() })).statusCode).toBe(409);
  expect(sync.statusCode).toBe(409); expect((await s.repository.snapshot()).chats[s.sessionId]?.messages).toHaveLength(1); kick.mockRestore();
});

test("invalid storage or oversized private context admits no operation and performs no external work", async () => {
  const unsupported = new Persistence(); Object.defineProperty(unsupported, "readQueueDurability", { value: undefined });
  const first = await setup({ persistence: unsupported }); expect((await first.send()).statusCode).toBe(503);
  expect(first.fetchImplementation).not.toHaveBeenCalled(); expect(Object.keys((await first.repository.snapshot()).chatOperations)).toHaveLength(0);
  const second = await setup();
  await second.repository.mutate(state => { state.chats[second.sessionId]!.messages.push({ id: "large-history", role: "user", text: "x".repeat(510_000) }); });
  expect((await second.send()).statusCode).toBe(413); expect(second.fetchImplementation).not.toHaveBeenCalled();
  expect(Object.keys((await second.repository.snapshot()).chatOperations)).toHaveLength(0);
});

test.each(["connection", "ciphertext"])("queued %s binding corruption cannot dispatch", async corruption => {
  const s = await setup(), kick = vi.spyOn(chatJobQueue(s.services), "kick").mockImplementation(() => {});
  const id = (await s.send()).json().data.operation.id;
  if (corruption === "connection") s.services.config.erpbridgeRoleMap["Platform Admin"] = "different-role";
  else await s.repository.mutate(state => { state.chatOperations[id]!.inputCiphertext = Buffer.from("not-authenticated").toString("base64"); });
  kick.mockRestore(); chatJobQueue(s.services).kick(); expect((await s.terminal(id)).status).toBe("FAILED");
  expect(s.fetchImplementation).not.toHaveBeenCalled(); expect(s.callTool).not.toHaveBeenCalled();
});

test("events reject future/gapped/cross-session evidence and list omits changed-authority records", async () => {
  const s = await setup(); const id = (await s.send()).json().data.operation.id; const final = await s.terminal(id);
  expect((await s.get(id, "owner", final.lastSequence + 1)).statusCode).toBe(409);
  await s.repository.mutate(state => { state.chatOperationEvents[id]![0]!.sessionId = "unrelated"; });
  expect((await s.get(id)).statusCode).toBe(409);
  await s.repository.mutate(state => { state.users.owner!.permissionOverrides.push("new:permission"); });
  const list = await s.app.inject({ method: "GET", url: `/api/chat/sessions/${s.sessionId}/operations`, headers: s.headers() });
  expect(list.statusCode).toBe(200); expect(list.json().data).toEqual([]); expect((await s.get(id)).statusCode).toBe(403);
});

test("saved draft reference survives a lost artifact acknowledgement without regenerating", async () => {
  const persistence = new Persistence(), first = await setup({ persistence }); persistence.commitBeforeFailure = true;
  persistence.failWhen = state => Object.values(state.chatOperations).some(op => op.stage === "DRAFT_SAVED");
  const id = (await first.send("Create a workflow to read invoices")).json().data.operation.id;
  await vi.waitFor(async () => expect((await first.repository.persistenceStatus()).healthy).toBe(false));
  const image = new Persistence(); image.payload = Buffer.from(persistence.payload!);
  await first.repository.recoverPersistenceState(); await first.app.close();
  const second = await setup({ persistence: image }); await second.app.ready(); const recovered = await second.terminal(id);
  expect(recovered.status).toBe("RECOVERY_REQUIRED"); expect(recovered.artifactRefs).toHaveLength(1);
  const state = await second.repository.snapshot(), draftId = recovered.artifactRefs![0]!.id;
  expect(state.workflows[draftId]).toMatchObject({ canRun: false, publishedVersion: 0, chatSessionId: first.sessionId });
  expect(second.fetchImplementation).not.toHaveBeenCalled(); expect(second.callTool).not.toHaveBeenCalled();
  expect((await second.get(id)).json().data.operation.artifactRefs).toEqual(recovered.artifactRefs);
});

test("reviewed document identity is admitted for normal asynchronous workflow chat", async () => {
  const s = await setup(); const kick = vi.spyOn(chatJobQueue(s.services), "kick").mockImplementation(() => {});
  try {
    const result = await s.send("Create employee workflow", { documentContext: { uploadId: "upload-one", documentId: "doc-one", version: 1, purpose: "erp_record_proposal" } });
    expect(result.statusCode).toBe(202);
    expect(s.callTool).not.toHaveBeenCalled();
    expect(s.fetchImplementation).not.toHaveBeenCalled();
  } finally { kick.mockRestore(); }
});

test.each([{ ownerId: "forged" }, { version: 0 }, { purpose: "execute_erp_write" }])("forged document authority is rejected at chat admission: %s", async (extra) => {
  const s = await setup();
  const result = await s.send("Create employee workflow", { documentContext: { uploadId: "upload-one", documentId: "doc-one", version: 1, purpose: "erp_record_proposal", ...extra } });
  expect(result.statusCode).toBe(422); expect(s.callTool).not.toHaveBeenCalled();
});
