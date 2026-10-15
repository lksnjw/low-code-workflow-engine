import { expect, test, vi } from "vitest";
// @ts-expect-error Operator-only JavaScript acceptance, not an application dependency.
import { assertNativeRealModelScope, nativeRealCheckpoint, qualifyNativeRealModel } from "../scripts/native-functions-real-model-qa.mjs";
// @ts-expect-error Operator-only JavaScript diagnostics, not an application dependency.
import { createNativeQaContext, safeNativeFailureDiagnostic, NativeQaStop } from "../scripts/native-qa-diagnostics.mjs";

const config = { FIRESTORE_PROJECT_ID: "demo-lcwe-records", FIRESTORE_DATABASE_ID: "(default)",
  FIRESTORE_WORKSPACE_ID: `test_${"a".repeat(32)}_native`, STORAGE_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
  LCWE_LOCAL_DOCKER_QA: "native-read/v1", ERPBRIDGE_BASE_URL: "http://127.0.0.1:18080" };
const environment = { FIRESTORE_EMULATOR_HOST: "127.0.0.1:23671", GCLOUD_PROJECT: "demo-lcwe-records",
  LCWE_REAL_MODEL_QA: "synthetic-docker-only", GENERATION_BASE_URL: "https://openrouter.ai/api/v1",
  GENERATION_API_KEY: "synthetic-guard-test-not-an-api-key", GENERATION_MODEL_PRIMARY: "deepseek/deepseek-v4.1-flash" };
const references = { workflowId: "wf_test", chatId: "chat_test", executionId: "run-test", nodeId: "departments" };
const state = () => ({
  workflows: { wf_test: { chatSessionId: "chat_test", draftVersion: 2, publishedVersion: 2, yaml: "private fixture source" } },
  versions: { wf_test: [{ version: 2, yaml: "private fixture source" }] },
  chats: { chat_test: { selectedModel: "deepseek/deepseek-v4.1-flash", messages: [
    { artifacts: { policyCheck: { decision: "allow", source: "local_model", fallbackUsed: true } } },
    { artifacts: { proposal: { status: "APPLIED" } } },
  ] } },
  executions: { "run-test": { workflowId: "wf_test", status: "DONE", workflowSnapshot: { version: 2, yaml: "private fixture source" },
    stepOutputs: { departments: { structuredContent: { data: Array.from({ length: 8 }, (_, id) => ({ id })) } } } } },
  executionEvents: { "run-test": [{ sequence: 1 }] }, timelines: { "run-test": [{ nodeId: "departments", status: "DONE" }] },
});

test("native real-model acceptance requires both isolated emulator/Docker and explicit selected inference scope", () => {
  expect(() => assertNativeRealModelScope(config, environment)).not.toThrow();
});
test.each([
  [{ FIRESTORE_PROJECT_ID: "owner-project" }, {}], [{ FIRESTORE_DATABASE_ID: "owner" }, {}],
  [{ FIRESTORE_WORKSPACE_ID: "owner" }, {}], [{ LCWE_LOCAL_DOCKER_QA: "native-operation/v1" }, {}],
  [{ ERPBRIDGE_BASE_URL: "https://remote.example.test" }, {}], [{ STORAGE_ENCRYPTION_KEY: "bad" }, {}],
  [{}, { FIRESTORE_EMULATOR_HOST: "remote.example.test:23671" }], [{}, { GCLOUD_PROJECT: "owner-project" }],
  [{}, { GOOGLE_APPLICATION_CREDENTIALS: "owner.json" }], [{}, { LCWE_REAL_MODEL_QA: "" }],
  [{}, { GENERATION_BASE_URL: "https://other.example.test/v1" }], [{}, { GENERATION_API_KEY: "" }],
  [{}, { GENERATION_MODEL_PRIMARY: "unselected-model" }],
])("operator refuses widened scope: %j", (configPatch, envPatch) => {
  expect(() => assertNativeRealModelScope({ ...config, ...configPatch }, { ...environment, ...envPatch })).toThrow();
});

test("fresh-process evidence contains only identities, counts and hashes, not source/prompt/private data", () => {
  const saved = state(), checkpoint = nativeRealCheckpoint(saved, references);
  expect(checkpoint).toMatchObject({ ...references, selectedModel: environment.GENERATION_MODEL_PRIMARY, status: "DONE", savedRows: 8 });
  expect(JSON.stringify(checkpoint)).not.toContain("private fixture source");
  expect(JSON.stringify(checkpoint)).not.toContain(environment.GENERATION_API_KEY);
  expect(JSON.stringify(nativeRealCheckpoint(saved, { ...references, secret: "not-evidence" }))).not.toContain("not-evidence");
  for (const [key, hash] of Object.entries(checkpoint)) if (key.endsWith("Hash")) expect(hash).toMatch(/^[a-f0-9]{64}$/);
  expect(nativeRealCheckpoint(structuredClone(saved), references)).toEqual(checkpoint);
});
test.each(["workflow", "versions", "chat", "snapshot", "outputs", "events", "timeline"])("checkpoint comparison detects changed %s", key => {
  const saved = state(), expected = nativeRealCheckpoint(saved, references);
  if (key === "workflow") saved.workflows.wf_test.yaml += " changed";
  if (key === "versions") saved.versions.wf_test[0]!.yaml += " changed";
  if (key === "chat") Object.assign(saved.chats.chat_test.messages[0]!, { text: "changed" });
  if (key === "snapshot") saved.executions["run-test"].workflowSnapshot.yaml += " changed";
  if (key === "outputs") saved.executions["run-test"].stepOutputs.departments.structuredContent.data[0]!.id = 99;
  if (key === "events") saved.executionEvents["run-test"][0]!.sequence = 2;
  if (key === "timeline") saved.timelines["run-test"][0]!.status = "FAILED";
  expect(nativeRealCheckpoint(saved, references)).not.toEqual(expected);
});
test.each(["missing", "wrong-link", "draft", "publication", "running", "model", "rows", "proposal", "policy", "remote-source", "no-fallback"])("checkpoint rejects incomplete evidence: %s", key => {
  const saved = state();
  if (key === "missing") delete (saved.workflows as Record<string, unknown>).wf_test;
  if (key === "wrong-link") saved.workflows.wf_test.chatSessionId = "other";
  if (key === "draft") saved.workflows.wf_test.draftVersion = 1;
  if (key === "publication") saved.workflows.wf_test.publishedVersion = 0;
  if (key === "running") saved.executions["run-test"].status = "RUNNING";
  if (key === "model") saved.chats.chat_test.selectedModel = "other";
  if (key === "rows") saved.executions["run-test"].stepOutputs.departments.structuredContent.data.pop();
  if (key === "proposal") saved.chats.chat_test.messages[1]!.artifacts.proposal!.status = "PROPOSED";
  if (key === "policy") saved.chats.chat_test.messages[0]!.artifacts.policyCheck!.decision = "deny";
  if (key === "remote-source") saved.chats.chat_test.messages[0]!.artifacts.policyCheck!.source = "erpbridge";
  if (key === "no-fallback") saved.chats.chat_test.messages[0]!.artifacts.policyCheck!.fallbackUsed = false;
  expect(() => nativeRealCheckpoint(saved, references)).toThrow();
});

test.each([
  ["dispatch", "TASK_DISPATCH"], ["binding", "MODEL_BINDING"], ["terminal", "TERMINAL_RESPONSE"], ["recovery", "TERMINAL_RESPONSE"], ["message", "SAVED_MESSAGE"],
  ["saved-model", "SAVED_MODEL"], ["source", "POLICY_SOURCE"], ["fallback", "POLICY_FALLBACK"], ["deny", "POLICY_CONTINUES"],
  ["capture", "POLICY_CONTINUES"],
  ["tool", "TOOL_STATUS"], ["rows", "ROW_COUNT"], ["transport", "HTTP_RESPONSE"],
])("actual query campaign preserves failure and performs no generation/replay: %s", async (fault, expectedCheck) => {
  // This is an injected query-fault simulation, not a live Node 22 qualification.
  // Keep its prerequisite deterministic without weakening the operator guard.
  const originalVersion = Object.getOwnPropertyDescriptor(process, "version")!;
  Object.defineProperty(process, "version", { ...originalVersion, value: "v22.0.0" });
  for (const [key, value] of Object.entries(environment)) vi.stubEnv(key, value);
  const secret = "RAW_SECRET_SENTINEL", requests: string[] = [], events: unknown[] = [];
  const admission = { taskDispatch: "ENQUEUED", operation: { id: `chatop_${secret}`, modelBinding: { model: environment.GENERATION_MODEL_PRIMARY } } };
  const operation = { id: admission.operation.id, status: "ANSWERED", assistantMessageId: `msg_${secret}` };
  const message = { id: operation.assistantMessageId, artifacts: { policyCheck: { source: "local_model", fallbackUsed: true, decision: "allow" },
    toolSteps: [{ status: "SUCCEEDED", result: { structuredContent: { data: Array.from({ length: 8 }, () => ({ secret })) } } }] } };
  const saved = { selectedModel: environment.GENERATION_MODEL_PRIMARY, messages: [message] };
  if (fault === "dispatch") admission.taskDispatch = secret;
  if (fault === "binding") admission.operation.modelBinding.model = secret;
  if (fault === "terminal") operation.status = secret;
  if (fault === "recovery") operation.status = "RECOVERY_REQUIRED";
  if (fault === "message") saved.messages = [];
  if (fault === "saved-model") saved.selectedModel = secret;
  if (fault === "source") message.artifacts.policyCheck.source = secret;
  if (fault === "fallback") message.artifacts.policyCheck.fallbackUsed = false;
  if (["deny", "capture"].includes(fault)) message.artifacts.policyCheck.decision = "deny";
  if (fault === "tool") message.artifacts.toolSteps[0]!.status = secret;
  if (fault === "rows") message.artifacts.toolSteps[0]!.result.structuredContent.data.pop();
  const request = vi.fn(async (_name: string, path: string, method: string) => {
    requests.push(`${method} ${path}`);
    if (fault === "transport" && path.endsWith("/messages")) throw Object.assign(new Error(secret), { actual: secret, expected: secret, headers: { authorization: secret } });
    const data = path === "/api/providers" ? { id: "provider_synthetic" } : path.endsWith("/test") ? { ok: true } :
      path === "/api/chat/sessions" ? { id: `chat_${secret}` } : path.endsWith("/messages") ? admission : path.includes("/operations/") ? { operation } : saved;
    const status = path === "/api/providers" || path === "/api/chat/sessions" ? 201 : path.endsWith("/messages") ? 202 : 200;
    return { status, body: "synthetic-safe-body", data: { data } };
  });
  const open = vi.fn(), diagnostics = createNativeQaContext((event: unknown) => events.push(event));
  const capturePolicyStop = vi.fn(() => { if (fault === "capture") throw new Error(secret); return { privatePolicyCaptured: true, ciphertextSha256: "e".repeat(64) }; });
  try {
    let failure: unknown;
    try { await qualifyNativeRealModel({ request, open, config, diagnostics, capturePolicyStop }); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(NativeQaStop);
    expect(safeNativeFailureDiagnostic(failure)).toMatchObject({ stage: "query", check: expectedCheck });
    if (["deny", "capture"].includes(fault)) {
      expect(capturePolicyStop).toHaveBeenCalledExactlyOnceWith({ stage: "query", operation, message, nodeContext: undefined });
      expect(safeNativeFailureDiagnostic(failure).code).toBe(fault === "capture" ? "PRIVATE_POLICY_CAPTURE_FAILED" : "RESPONSE_BLOCKED");
    } else expect(capturePolicyStop).not.toHaveBeenCalled();
    if (fault === "recovery") expect(safeNativeFailureDiagnostic(failure)).toMatchObject({ operationStatus: "RECOVERY_REQUIRED", pollCount: 1 });
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(JSON.stringify(failure)).not.toContain(secret);
    expect(String(failure)).not.toContain(secret);
    expect(requests.filter(value => value.endsWith("/messages"))).toHaveLength(1);
    expect(requests.some(value => value.includes("/workflows"))).toBe(false);
    expect(open).not.toHaveBeenCalled();
  } finally { Object.defineProperty(process, "version", originalVersion); vi.unstubAllEnvs(); }
});

test("native qualification still rejects a non-Node-22 host before any HTTP request", async () => {
  const originalVersion = Object.getOwnPropertyDescriptor(process, "version")!;
  Object.defineProperty(process, "version", { ...originalVersion, value: "v24.0.0" });
  for (const [key, value] of Object.entries(environment)) vi.stubEnv(key, value);
  const request = vi.fn();
  try {
    let failure: unknown;
    try { await qualifyNativeRealModel({ request, open: vi.fn(), config }); } catch (error) { failure = error; }
    expect(safeNativeFailureDiagnostic(failure)).toMatchObject({ stage: "provider_setup", check: "NODE_VERSION" });
    expect(request).not.toHaveBeenCalled();
  } finally { Object.defineProperty(process, "version", originalVersion); vi.unstubAllEnvs(); }
});
