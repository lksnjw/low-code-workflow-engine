import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { FirestoreRecordPersistence } from "../src/storage/firestore-records.js";
import { FirestoreRecordCodec } from "../src/storage/firestore-record-codec.js";
import { Repository, initialState, type Execution } from "../src/repository/store.js";
import { executionTransaction } from "../src/repository/execution-transaction.js";
import { Database, FakeClient } from "./fixtures/fake-firestore.js";
import { loadConfig } from "../src/config/config.js";
import { openApplicationRepository } from "../src/storage/open-repository.js";
import { AESGCMCodec } from "../src/storage/aes-gcm.js";
import { FirestoreOwnershipFailure, FirestoreWriterOwnership } from "../src/storage/firestore-writer-ownership.js";
import { splitFirestoreState } from "../src/storage/firestore-record-layout.js";

const runtime = vi.hoisted(() => ({ db: null as any, clients: [] as any[] }));
vi.mock("@google-cloud/firestore", () => ({ Firestore: class { constructor(settings: any) { const client = new FakeClient(runtime.db, settings); runtime.clients.push(client); return client; } } }));
const namespace = { projectId: "demo-lcwe-records", databaseId: "(default)", workspaceId: "repository_fixture" }, key = "k".repeat(32);
const codec = () => new FirestoreRecordCodec(key, namespace);
let db: Database, adapters: FirestoreRecordPersistence[];
beforeEach(() => { db = new Database(); runtime.db = db; runtime.clients = []; adapters = []; });
afterEach(async () => { await Promise.all(adapters.map(value => value.close())); vi.useRealTimers(); });
async function open(options: Parameters<typeof FirestoreRecordPersistence.open>[2] = {}) {
  const value = await FirestoreRecordPersistence.open(key, namespace, options); adapters.push(value); return value;
}

test("writer startup preserves a safe diagnostic cause without exposing raw SDK errors", async () => {
  const first = await open();
  await expect(open()).rejects.toMatchObject({ message: "Firestore record storage could not establish confirmed exclusive writer authority",
    cause: { reason: "WRITER_HELD" } });
  expect(first.records.writerFailureReason).toBeNull(); await first.close();
  db.fault = "before-commit";
  await expect(open()).rejects.toMatchObject({ cause: { reason: "UNCONFIRMED" } });
});

test.each(["WRITER_HELD", "WRITER_HANDOFF"] as const)("confirmed %s startup drains its SDK client before exposing a retryable category", async reason => {
  await open(); let finish!: () => void, settled = false;
  const acquisition = reason === "WRITER_HANDOFF" ? vi.spyOn(FirestoreWriterOwnership.prototype, "acquire").mockRejectedValueOnce(new FirestoreOwnershipFailure(reason)) : undefined;
  const termination = vi.spyOn(FakeClient.prototype, "terminate").mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  try {
    const pending = open().catch(error => { settled = true; return error; });
    await vi.waitFor(() => expect(termination).toHaveBeenCalledOnce()); expect(settled).toBe(false);
    finish(); expect(await pending).toMatchObject({ cause: { reason } });
  } finally { termination.mockRestore(); acquisition?.mockRestore(); }
});

test.each(["WRITER_HELD", "WRITER_HANDOFF"] as const)("failed %s client disposal cannot expose retryable admission", async reason => {
  await open();
  const acquisition = reason === "WRITER_HANDOFF" ? vi.spyOn(FirestoreWriterOwnership.prototype, "acquire").mockRejectedValueOnce(new FirestoreOwnershipFailure(reason)) : undefined;
  const termination = vi.spyOn(FakeClient.prototype, "terminate").mockRejectedValueOnce(new Error("Private disposal diagnostic"));
  try {
    await expect(open()).rejects.toMatchObject({ cause: { reason: "UNCONFIRMED" } });
  } finally { termination.mockRestore(); acquisition?.mockRestore(); }
});
const run = (id: string): Execution => ({ id, workflowId: "flow", workflowName: "Read", status: "RUNNING", startedAt: "2026-10-06T00:00:00Z", completedAt: null, durationMs: 0,
  tokens: { input: 0, output: 0, total: 0 }, costUsd: 0, startedBy: { id: "owner", name: "Owner" }, stepOutputs: {} });

test("an actual PersistenceBackend initializes and round-trips private domains with actual ownership/checkpoint capabilities", async () => {
  const persistence = await open(), repository = await Repository.open(persistence);
  await repository.mutate(state => {
    state.settings.private = { secret: "synthetic-private-token" };
    state.chats.chat = { id: "chat", ownerId: "owner", title: "Saved", createdAt: "now", updatedAt: "now", messageCount: 1, messages: [{ role: "assistant", text: "Confirmed" }] };
  });
  const before = await repository.snapshot(); repository.assertAuthority();
  expect(persistence.readQueueDurability).toBe("encrypted-single-writer"); expect(persistence.executionCheckpointDurability).toBe("encrypted-record-transactions/v1");
  await repository.close(); const restored = await Repository.open(await open()); expect(await restored.snapshot()).toEqual(before);
  expect([...db.documents.values()].every(value => !value.payload.includes(Buffer.from("synthetic-private-token")))).toBe(true);
  expect(db.settings.every(value => value.projectId === namespace.projectId && value.databaseId === namespace.databaseId)).toBe(true);
});

test("an existing normalized database without personal credentials starts safely and upgrades on its next save", async () => {
  const persistence = await open(), legacy = initialState();
  legacy.settings.saved = { value: "retained" }; delete (legacy as Partial<typeof legacy>).userMcpCredentials;
  await persistence.records.initializeStaged(splitFirestoreState(legacy), "pre-personal-token-snapshot");
  const repository = await Repository.open(persistence);
  expect((await repository.snapshot()).userMcpCredentials).toEqual({});
  expect((await repository.snapshot()).settings.saved).toEqual({ value: "retained" });
  await repository.mutate(state => { state.settings.current = { value: "new" }; });
  await repository.close();
  const reloaded = await Repository.open(await open()), state = await reloaded.snapshot();
  expect(state.userMcpCredentials).toEqual({});
  expect(state.settings).toMatchObject({ saved: { value: "retained" }, current: { value: "new" } });
  await reloaded.close();
});

test("normal repository saves write bounded changed-record deltas even with more than 400 unchanged records", async () => {
  const persistence = await open(), repository = await Repository.open(persistence);
  for (let batch = 0; batch < 3; batch++) await repository.mutate(state => { for (let at = 0; at < 200; at++) state.settings[`field_${batch * 200 + at}`] = { answer: at }; });
  const before = new Map(db.documents); db.writes = [];
  await repository.mutate(state => { state.settings.field_500 = { answer: false }; });
  const writes = db.writes.filter(value => value.length); expect(writes).toHaveLength(1); expect(writes[0]).toHaveLength(2);
  const touched = new Set(writes[0]!.map(value => value.path));
  for (const [path, document] of before) if (!touched.has(path)) expect(db.documents.get(path)).toEqual(document);
  expect((await repository.snapshot()).settings.field_500).toEqual({ answer: false });
});

test.each(["settings", "chat", "flow"])("scoped checkpoint for %s cannot delete colliding domain/chat/version records", async id => {
  const persistence = await open(), repository = await Repository.open(persistence);
  await repository.mutate(state => {
    state.executions[id] = run(id); state.timelines[id] = []; state.settings.saved = { value: 42 };
    state.chats[id] = { id, ownerId: "owner", title: "Preserve", createdAt: "now", updatedAt: "now", messageCount: 1, messages: [{ role: "assistant", text: "Unrelated answer" }] };
    state.versions[id] = [{ version: 1, description: "Unrelated version" }]; state.chatOperationEvents[id] = [{ version: 1, operationId: id, sessionId: id, sequence: 1, timestamp: "now", type: "saved", stage: "DONE" }];
  });
  const original = await repository.snapshot(), transaction = executionTransaction(original, id);
  transaction.view.executions[id]!.stepOutputs = { read: { value: false } }; transaction.view.timelines[id]!.push({ id: "answer", result: 0 }); transaction.view.auditLogs.push({ id: "append" });
  await persistence.saveExecutionCheckpoint(transaction.checkpoint());
  const saved = JSON.parse(Buffer.from((await persistence.load())!).toString("utf8"));
  expect(saved.chats).toEqual(original.chats); expect(saved.settings).toEqual(original.settings); expect(saved.versions).toEqual(original.versions); expect(saved.chatOperationEvents).toEqual(original.chatOperationEvents);
  expect(saved.executions[id].stepOutputs).toEqual({ read: { value: false } }); expect(saved.timelines[id]).toEqual([{ id: "answer", result: 0 }]); expect(saved.auditLogs).toEqual([{ id: "append" }]);
});

test("normal mutateExecution preserves unrelated domains and retains/removes private continuations atomically", async () => {
  const persistence = await open(), repository = await Repository.open(persistence);
  await repository.mutate(state => { state.executions.settings = run("settings"); state.settings.keep = "unchanged"; });
  await repository.mutateExecution("settings", state => { state.readContinuations.settings = { profile: "read-continuation/v1", executionId: "settings", ciphertext: "private-cursor" }; state.executions.settings!.stepOutputs = { first: 0 }; });
  await repository.mutateExecution("settings", state => { delete state.readContinuations.settings; state.executions.settings!.status = "DONE"; });
  const saved = await repository.snapshot(); await repository.close(); const recovered = await Repository.open(await open());
  expect(await recovered.snapshot()).toEqual(saved); expect(saved.readContinuations).toEqual({}); expect(saved.settings.keep).toBe("unchanged");
});

test.each(["before-commit", "after-commit"] as const)("protected selection %s ACK loss preserves an all-or-nothing private checkpoint", async fault => {
  const persistence = await open(), repository = await Repository.open(persistence), id = "protected-run", time = "2026-10-09T00:00:00.000Z";
  await repository.mutate(state => {
    const execution = run(id);
    execution.readProgress = { profile: "read-progress-v1", epoch: 1, persistence: "durable", nextStepIndex: 0, lastSequence: 0, attempts: {} };
    execution.operationSecret = { profile: "operation-job/v1", actorId: "owner", roleId: "role_admin", admittedRole: "Platform Admin", state: "CLAIMED",
      createdAt: time, idempotencyScope: "fixture", requestFingerprint: "fixture", intents: {}, protectedScopes: {} };
    state.executions[id] = execution; state.timelines[id] = []; state.executionEvents[id] = []; state.settings.unrelated = "preserved";
  });
  const before = await repository.snapshot(); db.fault = fault;
  await expect(repository.mutateExecution(id, state => {
    const execution = state.executions[id]!, progress = execution.readProgress!, job = execution.operationSecret!;
    progress.attempts.lookup = { id: "attempt", nodeId: "lookup", stepIndex: 0, status: "FAILED", startedAt: time, completedAt: time };
    progress.nextStepIndex = 1; progress.lastSequence = 1;
    job.intents.lookup = { id: "intent", nodeId: "lookup", invocationId: "attempt", operationKey: "fixture-key", argumentHash: `sha256:${"a".repeat(64)}`,
      dispatchKind: "tool", state: "ACKNOWLEDGED", preparedAt: time, completedAt: time, evidenceMeaning: "read-tool-error" };
    job.protectedScopes!.group = { profile: "operation-protected/v1", startIndex: 0, startedAt: time, selection: { code: "ERP_RESOURCE_NOT_FOUND",
      failedNodeId: "lookup", failedIndex: 0, intentKey: "lookup", intentId: "intent", argumentHash: job.intents.lookup.argumentHash, selectedAt: time } };
    state.timelines[id]!.push({ nodeId: "lookup", attemptId: "attempt", status: "FAILED", outcome: "MCP_READ_TOOL_ERROR" });
    state.executionEvents[id]!.push({ version: 1, executionId: id, workflowId: "flow", sequence: 1, timestamp: time, type: "protected.handler_selected", nodeId: "group",
      payload: { failedNodeId: "lookup", outcome: "HANDLER_SELECTED_NOT_COMPLETED" } });
  })).rejects.toThrow();
  expect(() => repository.assertAuthority()).toThrow(); await repository.recoverPersistenceState(); const saved = await repository.snapshot();
  expect(saved.settings).toEqual(before.settings);
  if (fault === "before-commit") expect(saved).toEqual(before);
  else {
    expect(saved.executions[id]!.operationSecret!.protectedScopes!.group!.selection!.intentId).toBe("intent");
    expect(saved.executions[id]!.operationSecret!.intents.lookup!.state).toBe("ACKNOWLEDGED");
    expect(saved.executions[id]!.readProgress!.attempts.lookup!.status).toBe("FAILED");
    expect(saved.executionEvents[id]).toHaveLength(1); expect(saved.timelines[id]).toHaveLength(1);
    expect(saved.executions[id]!.stepOutputs).toEqual({});
  }
  await repository.close(); const reopened = await Repository.open(await open()); expect(await reopened.snapshot()).toEqual(saved);
});

test("a scoped audit mismatch is a known rejection and never changes the saved image", async () => {
  const persistence = await open(), repository = await Repository.open(persistence), before = await repository.snapshot(), writes = db.version;
  await expect(persistence.saveExecutionCheckpoint({ executionId: "x", execution: run("x"), auditStart: 10, auditAppend: [{ id: "bad" }] })).rejects.toThrow("audit append");
  expect(db.version).toBe(writes); expect(await repository.snapshot()).toEqual(before); repository.assertAuthority();
});

test.each(["before-commit", "after-commit"] as const)("normal repository %s uncertainty fences cached authority and recovers only the committed image", async fault => {
  const persistence = await open(), repository = await Repository.open(persistence), committed = vi.fn(), unavailable = vi.fn();
  repository.observeCommits({ committed, unavailable }); db.fault = fault;
  await expect(repository.mutate(state => { state.counter = 7; })).rejects.toThrow();
  expect(() => repository.assertAuthority()).toThrow("fenced"); await expect(repository.read(() => true)).rejects.toThrow("fenced");
  expect(committed).not.toHaveBeenCalled(); expect(unavailable).toHaveBeenCalledTimes(1);
  await repository.recoverPersistenceState(); expect((await repository.snapshot()).counter).toBe(fault === "after-commit" ? 7 : 0);
  repository.assertAuthority(); await repository.mutate(state => { state.counter += 1; }); expect(committed).toHaveBeenCalledTimes(2);
});

test("heartbeat renews the exact writer after acknowledgement and does not create an application checkpoint", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); let wall = 1_000_000, monotonic = 100;
  const persistence = await open({ writerDuration: 6000, clock: { sample: () => ({ wall, monotonic }) } }), repository = await Repository.open(persistence);
  const oldHead = db.documents.get(persistence.records.headPath); wall += 2000; monotonic += 2000; db.serverTime += 2000;
  await vi.advanceTimersByTimeAsync(2000); repository.assertAuthority();
  expect(codec().decodeHead(db.documents.get(persistence.records.writerPath))).toMatchObject({ generation: 1, sequence: 2 }); expect(db.documents.get(persistence.records.headPath)).toEqual(oldHead);
});

test.each(["before-commit", "after-commit"] as const)("heartbeat %s lost ACK denies every attached repository without probe/load revival", async fault => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); let wall = 1_000_000, monotonic = 100;
  const persistence = await open({ writerDuration: 6000, clock: { sample: () => ({ wall, monotonic }) } }), repository = await Repository.open(persistence), unavailable = vi.fn();
  repository.observeCommits({ committed: vi.fn(), unavailable }); db.fault = fault; wall += 2000; monotonic += 2000; db.serverTime += 2000;
  await vi.advanceTimersByTimeAsync(2000);
  expect(unavailable).toHaveBeenCalledTimes(1); expect(() => repository.assertAuthority()).toThrow(); await expect(repository.snapshot()).rejects.toThrow(); await expect(persistence.load()).rejects.toThrow();
  expect(await repository.persistenceStatus()).toEqual({ durable: true, healthy: false });
  expect(codec().decodeHead(db.documents.get(persistence.records.writerPath))).toMatchObject({ generation: 1, sequence: fault === "after-commit" ? 2 : 1 });
  const version = db.version; await vi.advanceTimersByTimeAsync(10_000); expect(db.version).toBe(version);
});

test("probe reads bounded lease/anchor/head metadata, does not renew and cannot adopt changed authority", async () => {
  const persistence = await open(), repository = await Repository.open(persistence), sequence = codec().decodeHead(db.documents.get(persistence.records.writerPath));
  db.reads = []; await persistence.probe(); expect(db.reads).toEqual([persistence.records.writerPath, persistence.records.writerGenerationPath, persistence.records.headPath]);
  expect(codec().decodeHead(db.documents.get(persistence.records.writerPath))).toEqual(sequence);
  const head = codec().decodeHead(db.documents.get(persistence.records.headPath)) as Record<string, unknown>;
  db.documents.set(persistence.records.headPath, codec().encodeHead({ ...head, revision: Number(head.revision) + 1 }));
  await expect(persistence.probe()).rejects.toThrow(); expect(() => repository.assertAuthority()).toThrow();
});

test("a no-change save probes authority but never increments the record head or rewrites ciphertext", async () => {
  const persistence = await open(), repository = await Repository.open(persistence), before = new Map(db.documents), version = db.version;
  await repository.mutate(() => {}); expect(db.version).toBe(version); expect(db.documents).toEqual(before);
});

test("legacy aggregate detection refuses silent empty initialization and does not touch its document", async () => {
  const legacy = { profile: "legacy", payload: Buffer.from("synthetic-old-state") }; db.documents.set("runtime/state", legacy);
  const persistence = await open(); await expect(Repository.open(persistence)).rejects.toThrow("explicit backed-up migration");
  expect(db.documents.get("runtime/state")).toEqual(legacy); expect(db.documents.has(persistence.records.headPath)).toBe(false);
});

test("explicit exact-hash legacy cutover preserves the source and activates a lossless empty target", async () => {
  const original = initialState(); original.settings.migrated = { answer: false }; original.executions.run = run("run"); original.timelines.run = [];
  const plaintext = Buffer.from(JSON.stringify(original)), encrypted = new AESGCMCodec(key).encode(gzipSync(plaintext));
  const legacy = { payload: encrypted.toString("base64"), encrypted: true, compression: "gzip", updatedAt: "2026-10-08T00:00:00.000Z" };
  db.documents.set("runtime/state", legacy); const startup = await open();
  await expect(Repository.open(startup)).rejects.toThrow("explicit backed-up migration");
  const persistence = await open();
  await expect(persistence.migrateLegacy(`sha256:${"0".repeat(64)}`)).rejects.toThrow("backup hash");
  expect(db.documents.has(persistence.records.headPath)).toBe(false);
  const sourceHash = `sha256:${createHash("sha256").update(plaintext).digest("hex")}`, report = await persistence.migrateLegacy(sourceHash);
  expect(report).toMatchObject({ sourceHash, sourceBytes: plaintext.length }); expect(report.recordCount).toBeGreaterThan(1); expect(report.recordFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(await Repository.open(persistence).then(value => value.snapshot())).toEqual(original); expect(db.documents.get("runtime/state")).toEqual(legacy);
  await expect(persistence.migrateLegacy(sourceHash)).rejects.toThrow("empty target");
});

test.each([
  ["unknown legacy metadata", { payload: Buffer.from("{}").toString("base64"), encrypted: false, unexpected: true }],
  ["claimed encryption with plaintext", { payload: Buffer.from("{}").toString("base64"), encrypted: true }],
  ["invalid compression", { payload: Buffer.from("{}").toString("base64"), encrypted: false, compression: "zip" }],
])("%s is rejected without activating any normalized records", async (_name, legacy) => {
  db.documents.set("runtime/state", legacy); const persistence = await open();
  await expect(persistence.migrateLegacy(`sha256:${"0".repeat(64)}`)).rejects.toThrow();
  expect(db.documents.has(persistence.records.headPath)).toBe(false); expect(db.documents.get("runtime/state")).toEqual(legacy);
});

test("a legacy image larger than one normal transaction stages and publishes one authoritative head", async () => {
  const original = initialState(); for (let at = 0; at < 450; at++) original.settings[`field_${at}`] = at;
  const plaintext = Buffer.from(JSON.stringify(original));
  const legacy = { payload: plaintext.toString("base64"), encrypted: false }; db.documents.set("runtime/state", legacy);
  const persistence = await open(), report = await persistence.migrateLegacy(`sha256:${createHash("sha256").update(plaintext).digest("hex")}`);
  expect(report.recordCount).toBeGreaterThan(400); expect(db.documents.has(persistence.records.headPath)).toBe(true);
  expect(await Repository.open(persistence).then(value => value.snapshot())).toEqual(original); expect(db.documents.get("runtime/state")).toEqual(legacy);
});

test("a legacy source change during staging denies authoritative activation", async () => {
  const original = initialState(); original.settings.saved = { value: 1 }; const plaintext = Buffer.from(JSON.stringify(original));
  const legacy = { payload: plaintext.toString("base64"), encrypted: false, updatedAt: "2026-10-08T00:00:00.000Z" }; db.documents.set("runtime/state", legacy);
  const persistence = await open(); let changed = false;
  db.stageHook = async () => { if (!changed) { changed = true; db.documents.set("runtime/state", { ...legacy, updatedAt: "2026-10-08T00:01:00.000Z" }); db.version++; } };
  await expect(persistence.migrateLegacy(`sha256:${createHash("sha256").update(plaintext).digest("hex")}`)).rejects.toThrow("source changed");
  expect(db.documents.has(persistence.records.headPath)).toBe(false);
});

test.each(["users", "roles", "capabilityAdmissions"])("a malformed %s map is not silently repaired into authoritative defaults", async field => {
  const persistence = await open(), repository = await Repository.open(persistence), state = await repository.snapshot();
  (state as any)[field] = []; const version = db.version;
  await expect(persistence.save(Buffer.from(JSON.stringify(state)))).rejects.toThrow(); expect(db.version).toBe(version);
});

test("close synchronously denies entry and stops heartbeats before draining the owned SDK", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const persistence = await open(), repository = await Repository.open(persistence), unavailable = vi.fn(); repository.observeCommits({ committed: vi.fn(), unavailable });
  const closing = repository.close(); expect(() => repository.assertAuthority()).toThrow("closed"); expect(unavailable).toHaveBeenCalledTimes(1); await closing;
  const version = db.version; await vi.advanceTimersByTimeAsync(60_000); expect(db.version).toBe(version); expect(runtime.clients[0].closed).toBe(true);
});

test("an already-aborted initialization publishes no writer and disposes its SDK", async () => {
  const controller = new AbortController(); controller.abort();
  await expect(open({ signal: controller.signal })).rejects.toThrow("confirmed exclusive");
  await vi.waitFor(() => expect(runtime.clients.every(client => client.closed)).toBe(true)); expect(db.documents.size).toBe(0);
});

test("a deadline during writer acquisition never publishes late authority and drains the SDK", async () => {
  const original = FakeClient.prototype.runTransaction; let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; }), waiting = new Promise<void>(resolve => { release = resolve; });
  const spy = vi.spyOn(FakeClient.prototype, "runTransaction").mockImplementation(async function (this: FakeClient, ...args) { entered(); await waiting; return original.apply(this, args); });
  const opening = open({ initializationTimeoutMs: 10 }); const rejected = expect(opening).rejects.toThrow("confirmed exclusive");
  await ready; await rejected; release(); await vi.waitFor(() => expect(runtime.clients.every(client => client.closed)).toBe(true));
  expect(db.documents.size).toBe(0); spy.mockRestore();
});

test("the production startup factory selects the normalized adapter only when explicitly configured", async () => {
  const config = loadConfig({ APP_ENV: "test", STORAGE_DRIVER: "firestore-records", FIRESTORE_PROJECT_ID: namespace.projectId, FIRESTORE_DATABASE_ID: namespace.databaseId,
    FIRESTORE_WORKSPACE_ID: namespace.workspaceId, STORAGE_ENCRYPTION_KEY: key });
  const repository = await openApplicationRepository(config); adapters.push(repository.persistence as FirestoreRecordPersistence);
  expect(repository.persistence).toBeInstanceOf(FirestoreRecordPersistence); repository.assertAuthority();
  await repository.mutateExecution("settings", state => { state.executions.settings = run("settings"); }); expect((await repository.snapshot()).settings.general).toEqual({});
});

test("a deadline during application state loading closes the confirmed writer before late load can return", async () => {
  const config = loadConfig({ APP_ENV: "test", STORAGE_DRIVER: "firestore-records", FIRESTORE_PROJECT_ID: namespace.projectId, FIRESTORE_DATABASE_ID: namespace.databaseId,
    FIRESTORE_WORKSPACE_ID: namespace.workspaceId, STORAGE_ENCRYPTION_KEY: key });
  const original = FirestoreRecordPersistence.prototype.load; let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; }), waiting = new Promise<void>(resolve => { release = resolve; });
  const spy = vi.spyOn(FirestoreRecordPersistence.prototype, "load").mockImplementation(async function (this: FirestoreRecordPersistence) { entered(); await waiting; return original.call(this); });
  const opening = openApplicationRepository(config, 25), rejected = expect(opening).rejects.toMatchObject({ name: "OperationDeadlineExceeded" });
  await ready; await rejected; release(); await vi.waitFor(() => expect(runtime.clients.every(client => client.closed)).toBe(true)); spy.mockRestore();
});
