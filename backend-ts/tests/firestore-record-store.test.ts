import { beforeEach, expect, test, vi } from "vitest";
import { FirestoreRecordStore } from "../src/storage/firestore-record-store.js";
import { FirestoreRecordCodec, FIRESTORE_RECORD_BOUNDS as B } from "../src/storage/firestore-record-codec.js";
import { initialState } from "../src/repository/store.js";
import { splitFirestoreState, assembleFirestoreState } from "../src/storage/firestore-record-layout.js";
import type { RuntimeRecord } from "../src/storage/execution-record-layout.js";
import { recordKey } from "../src/storage/execution-record-layout.js";
import * as canonicalJSON from "../src/core/canonical-json.js";

const runtime = vi.hoisted(() => ({ db: null as any }));
vi.mock("@google-cloud/firestore", () => ({ Firestore: class { constructor(settings: any) { return new FakeClient(runtime.db, settings); } } }));
import { Database, FakeClient, clone } from "./fixtures/fake-firestore.js";
const scope = { projectId: "demo-lcwe-records", databaseId: "(default)", workspaceId: "fixture_workspace" }, key = "k".repeat(32);
const record = (id: string, value: unknown): RuntimeRecord => ({ profile: "runtime-record/v1", path: ["domain", "settings", id], value });
let db: Database;
beforeEach(() => { db = new Database(); runtime.db = db; });
const store = () => FirestoreRecordStore.create(key, scope);
async function setup() {
  const storage = store(), empty = await storage.load();
  const first = await storage.commit(empty, { transitionId: "initial-records", upsert: [record("one", false), record("two", 0)] });
  return { storage, empty, first };
}

test("explicit client scope and authenticated snapshot are created without durability markers or implicit migration", async () => {
  const storage = store(), empty = await storage.load();
  expect(empty).toMatchObject({ revision: 0, recordCount: 0 }); expect(storage.readRecords(empty)).toEqual([]);
  expect(db.settings[0]).toMatchObject({ projectId: scope.projectId, databaseId: scope.databaseId });
  expect(storage).not.toHaveProperty("readQueueDurability"); expect(storage).not.toHaveProperty("executionCheckpointDurability");
});
test("a complete repository round-trips through normalized encrypted records", async () => {
  const storage = store(), original = initialState(); original.settings.private = { token: "synthetic-secret" };
  const saved = await storage.commit(await storage.load(), { transitionId: "initial-state", upsert: splitFirestoreState(original) });
  expect(assembleFirestoreState(storage.readRecords(await storage.load()))).toEqual(original);
  expect(saved.recordCount).toBeGreaterThan(10);
  expect([...db.documents.values()].every(value => value.payload && !value.payload.includes(Buffer.from("synthetic-secret")))).toBe(true);
});

test("native business records keep indexed authenticated manifests and exact checkpoint/duplicate semantics", async () => {
  const storage=FirestoreRecordStore.create(key,scope,{},"native-fields/v1"), source=initialState();
  source.providers.fixture={id:"fixture",name:"Readable provider",apiKey:"synthetic-native-secret",active:false};
  const saved=await storage.initializeStaged(splitFirestoreState(source),"native-staged-fixture");
  expect(assembleFirestoreState(storage.readRecords(await storage.load()))).toEqual(source);
  const documents=[...db.documents.values()]; expect(documents.some(value=>value.profile==="firestore-native/v1")).toBe(true);
  expect(documents.some(value=>value.index?.kind==="providers")).toBe(true);
  expect(JSON.stringify(documents)).not.toContain("synthetic-native-secret");
  const mutation={transitionId:"native-update-provider",upsert:[{profile:"runtime-record/v1" as const,path:["domain","providers","fixture"],value:{...source.providers.fixture,name:"Updated native provider"}}]};
  const updated=await storage.commit(saved,mutation); expect((await storage.commit(saved,mutation)).revision).toBe(updated.revision);
  expect(storage.readRecords(await storage.load()).find(row=>row.path.join("/")==="domain/providers/fixture")?.value).toMatchObject({name:"Updated native provider",apiKey:"synthetic-native-secret"});
  await storage.close();
});

test("native mode rejects legacy manifests with an explicit migration error, not a canonical JSON TypeError", async () => {
  const { storage } = await setup();
  const native = FirestoreRecordStore.create(key, scope, {}, "native-fields/v1");
  await expect(native.load()).rejects.toThrow("explicit migration is required");
  expect(native.writeUncertain).toBe(true);
  await native.close(); await storage.close();
});

test("native owner/date index uses keyset pages and rejects a changed committed head", async () => {
  const storage=FirestoreRecordStore.create(key,scope,{},"native-fields/v1");
  const records=Array.from({length:45},(_,i)=>({profile:"runtime-record/v1" as const,path:["domain","chats",`chat-${i}`],value:{id:`chat-${i}`,ownerId:i<40?"owner":"other",updatedAt:new Date(Date.UTC(2026,9,1,0,i)).toISOString(),messages:[]}}));
  const image=await storage.initializeStaged(records,"native-query-fixture");
  const page=await storage.metadataPage(image,"chats","owner",20); expect(page).toHaveLength(20);
  expect(page[0]!.path[2]).toBe("chat-39"); const last=page.at(-1)!.value as any;
  const older=await storage.metadataPage(image,"chats","owner",20,{updatedAt:last.updatedAt,entityId:last.id});
  expect(older).toHaveLength(20); expect(new Set([...page,...older].map(row=>row.path[2])).size).toBe(40);
  await storage.commit(image,{transitionId:"native-query-change",upsert:[{...records[0]!,value:{...records[0]!.value,updatedAt:"2026-10-16T10:00:00Z"}}]});
  await expect(storage.metadataPage(image,"chats","owner",20)).rejects.toThrow("changed"); await storage.close();
});

test("unchanged observer head requires one fresh database read; a new commit reloads changed data", async () => {
  const { storage, first } = await setup(); db.reads = [];
  expect(await storage.load(first)).toBe(first); expect(db.reads).toEqual([storage.headPath]);
  const other = store(); await other.commit(await other.load(), { transitionId: "observer-update", upsert: [record("one", "new")] });
  const fresh = await storage.load(first); expect(fresh).not.toBe(first);
  expect(storage.readRecords(fresh)).toContainEqual(record("one", "new"));
});

test("invalid or missing head never serves the observer's cached image", async () => {
  const { storage, first } = await setup(); db.documents.get(storage.headPath).payload[80] ^= 1;
  await expect(storage.load(first)).rejects.toThrow(); expect(storage.writeUncertain).toBe(true);
  expect(() => storage.readRecords(first)).toThrow("fenced");
});

test("writer ownership cannot use the read-only observer shortcut", async () => {
  const { storage, first } = await setup(); await storage.acquireWriter(); db.reads = [];
  expect(await storage.load(first)).not.toBe(first);
  expect(db.reads).toContain(storage.collectionPath); await storage.close();
});
test("scoped activation touches only the changed encrypted manifest plus head, not unrelated data", async () => {
  const { storage, first } = await setup(), before = new Map(db.documents); db.writes = []; db.reads = [];
  const second = await storage.commit(first, { transitionId: "change-one-only", upsert: [record("one", { answer: false })] });
  expect(second.revision).toBe(2); expect(db.writes[0]).toHaveLength(2);
  const changed = new Set(db.writes[0]!.map(entry => entry.path));
  for (const [path, document] of before) if (!changed.has(path)) expect(db.documents.get(path)).toEqual(document);
  expect(db.reads.filter(path => path.includes("lcwe_private_records"))).toHaveLength(1);
  const answers = storage.readRecords(second), answer = answers.find(entry => entry.path.at(-1) === "one")!; (answer.value as any).hidden = true;
  expect(storage.readRecords(second).find(entry => entry.path.at(-1) === "one")!.value).toEqual({ answer: false });
});
test("repeated same transition is a read-only acknowledgement and retains actual ciphertext for the next checkpoint", async () => {
  const { storage, empty } = await setup(); db.writes = [];
  const repeat = await storage.commit(empty, { transitionId: "initial-records", upsert: [record("two", 0), record("one", false)] });
  expect(repeat.revision).toBe(1); expect(db.writes[0]).toEqual([]);
  const next = await storage.commit(repeat, { transitionId: "after-repeat-one", upsert: [record("one", 1)] });
  expect(next.revision).toBe(2); expect(storage.readRecords(await storage.load())).toContainEqual(record("one", 1));
});
test("rollback readiness atomically binds the loaded head and exact retained legacy source", async () => {
  const { storage, first } = await setup(), source = { payload: "retained", encrypted: true };
  db.documents.set("runtime/state", clone(source)); await storage.acquireWriter();
  await expect(storage.probeWriterAndLegacySource(first, { path: "runtime/state", document: source })).resolves.toBeUndefined();
  expect(storage.writeUncertain).toBe(false);
});
test("rollback readiness fences the store when the retained legacy source differs", async () => {
  const { storage, first } = await setup(), source = { payload: "retained", encrypted: true };
  db.documents.set("runtime/state", { payload: "changed", encrypted: true }); await storage.acquireWriter();
  await expect(storage.probeWriterAndLegacySource(first, { path: "runtime/state", document: source })).rejects.toThrow("differs from the authenticated backup");
  expect(storage.writeUncertain).toBe(true);
});
test("same identity with different content is rejected and fences cached reads/writes", async () => {
  const { storage, empty, first } = await setup();
  await expect(storage.commit(empty, { transitionId: "initial-records", upsert: [record("one", 2), record("two", 0)] })).rejects.toThrow("identity was reused");
  expect(storage.writeUncertain).toBe(true); expect(() => storage.readRecords(first)).toThrow("fenced");
  await storage.load(); expect(storage.writeUncertain).toBe(false);
});
test.each(["before-commit", "after-commit"] as const)("%s fault requires authoritative reload, then exact recovery without another write", async fault => {
  const { storage, first } = await setup(), mutation = { transitionId: "faulted-mutation", upsert: [record("one", { result: 1 })] };
  db.fault = fault; await expect(storage.commit(first, mutation)).rejects.toThrow();
  expect(storage.writeUncertain).toBe(true);
  await expect(storage.commit(first, mutation)).rejects.toThrow("reloaded");
  const loaded = await storage.load(); expect(loaded.revision).toBe(fault === "after-commit" ? 2 : 1);
  const writes = db.version, recovered = await storage.commit(first, mutation);
  expect(recovered.revision).toBe(2); expect(db.version).toBe(writes + (fault === "before-commit" ? 1 : 0));
});
test("SDK callback retry uses identical prepared ciphertext and does not increment revision twice", async () => {
  const { storage, first } = await setup(); db.fault = "retry"; db.writes = [];
  const saved = await storage.commit(first, { transitionId: "sdk-retry-once", upsert: [record("one", 5)] });
  expect(saved.revision).toBe(2); expect(db.writes).toHaveLength(2); expect(db.writes[0]).toEqual(db.writes[1]);
});
test("two clients cannot overwrite the same admitted revision", async () => {
  const { storage, first } = await setup(), other = store(), secondBase = await other.load();
  const results = await Promise.allSettled([storage.commit(first, { transitionId: "writer-one-same", upsert: [record("one", "a")] }), other.commit(secondBase, { transitionId: "writer-two-same", upsert: [record("one", "b")] })]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  const authority = await store().load(); expect(authority.revision).toBe(2);
});
test.each(["orphan-manifest", "ciphertext", "head", "extra-manifest", "missing-chunk", "plaintext"])("%s damage cannot be silently healed or downgraded", async damage => {
  const { storage, first } = await setup(), paths = [...db.documents.keys()], chunk = paths.find(path => path.includes("lcwe_record_chunks"))!;
  if (damage === "orphan-manifest") db.documents.delete(storage.headPath);
  if (damage === "ciphertext") { const data = db.documents.get(chunk); data.payload[80] ^= 1; }
  if (damage === "head") { const data = db.documents.get(storage.headPath); data.payload[80] ^= 1; }
  if (damage === "extra-manifest") db.documents.set(`${storage.collectionPath}/${"a".repeat(64)}`, clone(db.documents.get(paths.find(path => path.includes("lcwe_private_records"))!)));
  if (damage === "missing-chunk") db.documents.delete(chunk);
  if (damage === "plaintext") db.documents.set(chunk, { profile: "firestore-private/v1", payload: Buffer.from('{"private":"plaintext"}') });
  await expect(storage.load()).rejects.toThrow(); expect(storage.writeUncertain).toBe(true);
  await expect(storage.commit(first, { transitionId: "do-not-heal-00", upsert: [record("one", 10)] })).rejects.toThrow("reloaded");
});
test("corruption of a touched packet is rejected before any overwrite", async () => {
  const { storage, first } = await setup(), codec = new FirestoreRecordCodec(key, scope), id = codec.encodeRecord(record("one", false)).chunks[0]!.id;
  const path = `${storage.chunkCollectionPath}/${id}`, original = db.documents.get(path); original.payload[80] ^= 1;
  const head = clone(db.documents.get(storage.headPath));
  await expect(storage.commit(first, { transitionId: "touched-tamper", upsert: [record("one", true)] })).rejects.toThrow();
  expect(db.documents.get(storage.headPath)).toEqual(head); expect(db.documents.get(path)).toEqual(original);
});
test("large records activate and shrink atomically; retired immutable bodies do not appear in the active image", async () => {
  const storage = store(), original = await storage.load();
  const large = await storage.commit(original, { transitionId: "large-record-initial", upsert: [record("large", "x".repeat(5_400_000))] });
  expect(large.chunkCount).toBeGreaterThan(10);
  const small = await storage.commit(large, { transitionId: "large-record-shrink", upsert: [record("large", "answer")] });
  expect(small.chunkCount).toBe(1);
  expect([...db.documents.keys()].filter(path => path.startsWith(storage.chunkCollectionPath + "/"))).toHaveLength(large.chunkCount + 1);
  expect([...db.documents.keys()].filter(path => path.startsWith(storage.collectionPath + "/"))).toHaveLength(1);
  expect(storage.readRecords(await storage.load())).toEqual([record("large", "answer")]);
});

test("packet equality never expands binary chunk payloads into canonical JSON objects", async () => {
  const storage = store(), original = await storage.load();
  const large = await storage.commit(original, { transitionId: "binary-compare-initial", upsert: [record("large", "x".repeat(64000))] });
  const canonical = vi.spyOn(canonicalJSON, "canonicalJSONBytes");
  try {
    await storage.commit(large, { transitionId: "binary-compare-update", upsert: [record("large", "updated")] });
    expect(canonical.mock.calls.filter(([value]) => value && typeof value === "object" && "payload" in value && Buffer.isBuffer(value.payload) && value.payload.length > 16000)).toHaveLength(0);
  } finally { canonical.mockRestore(); await storage.close(); }
});
test("atomic metadata write/size and logical record budgets reject before SDK staging or activation", async () => {
  const { storage, first } = await setup(), calls = db.invocations, prepared = db.staged.length;
  await expect(storage.commit(first, { transitionId: "too-many-documents", upsert: Array.from({ length: B.transactionWrites }, (_, at) => record(`new_${at}`, at)) })).rejects.toThrow("atomic transaction budget");
  await expect(storage.commit(first, { transitionId: "too-many-bytes-00", upsert: [record("large", "x".repeat(B.recordBytes))] })).rejects.toThrow("logical record byte budget");
  await expect(storage.commit(first, { transitionId: "too-much-metadata", upsert: Array.from({ length: 160 }, (_, at) => ({ ...record(`new_${at}`, at), path: ["a".repeat(4000), "b".repeat(4000), "c".repeat(4000), `new_${at}`] })) })).rejects.toThrow("atomic transaction budget");
  expect(db.staged.length).toBe(prepared);
  expect(db.invocations).toBe(calls); expect(storage.writeUncertain).toBe(false);
});

test("a 7.9 MB record fits bounded staging without becoming a giant transaction", async () => {
  const storage = store(), large = record("large", "x".repeat(7_900_000));
  const saved = await storage.commit(await storage.load(), { transitionId: "larger-private-record", upsert: [large] });
  expect(saved.chunkCount).toBeGreaterThan(20); expect(db.writes.at(-1)).toHaveLength(2);
  expect(db.writes.at(-1)!.reduce((sum, write) => sum + write.data.payload.length, 0)).toBeLessThan(24_000);
  expect(storage.readRecords(await storage.load())).toEqual([large]);
});

test("partial preparation never advances authority; healthy reload and exact retry can finish it", async () => {
  const { storage, first } = await setup(), before = clone(db.documents.get(storage.headPath));
  db.stageFaultAt = db.staged.length + 2;
  const mutation = { transitionId: "partial-staging-fault", upsert: [record("large", "x".repeat(5_400_000))] };
  await expect(storage.commit(first, mutation)).rejects.toThrow("staging failure");
  expect(db.documents.get(storage.headPath)).toEqual(before); expect(storage.writeUncertain).toBe(true);
  const reader = store(), observed = await reader.load(); expect(observed.revision).toBe(1);
  expect(reader.readRecords(observed, [record("one", false).path, record("two", 0).path])).toEqual([record("one", false), record("two", 0)]);
  await storage.load(); db.stageFaultAt = -1;
  const recovered = await storage.commit(first, mutation); expect(recovered.revision).toBe(2);
  expect(storage.readRecords(await storage.load(), [mutation.upsert[0]!.path])).toEqual(mutation.upsert);
});

test("staged content-address collisions are authenticated and never overwritten", async () => {
  const { storage, first } = await setup(), value = record("new", "answer"), codec = new FirestoreRecordCodec(key, scope), encoded = codec.encodeRecord(value);
  const path = `${storage.chunkCollectionPath}/${encoded.chunks[0]!.id}`, alien = codec.encodeRecord(record("other", "private"));
  db.documents.set(path, alien.chunks[0]!.document);
  const saved = clone(db.documents.get(path)), head = clone(db.documents.get(storage.headPath));
  await expect(storage.commit(first, { transitionId: "staged-collision-test", upsert: [value] })).rejects.toThrow();
  expect(db.documents.get(path)).toEqual(saved); expect(db.documents.get(storage.headPath)).toEqual(head);
});

test("unreferenced stage packets do not activate even in an empty workspace, but orphan manifests reject", async () => {
  const storage = store(), codec = new FirestoreRecordCodec(key, scope), encoded = codec.encodeRecord(record("not-active", true));
  db.documents.set(`${storage.chunkCollectionPath}/${encoded.chunks[0]!.id}`, encoded.chunks[0]!.document);
  expect((await storage.load()).revision).toBe(0);
  db.documents.set(`${storage.collectionPath}/${codec.manifestId(recordKey(encoded.record.path))}`, codec.encodeHead({ profile: "firestore-record-manifest/v1", key: encoded.key, hash: encoded.hash, bytes: encoded.bytes.length, chunks: encoded.chunks.map(chunk => chunk.id) }));
  await expect(storage.load()).rejects.toThrow("no authoritative head");
});

test("staged initialization publishes more than one transaction of records with one final authoritative head", async () => {
  const storage = store(), records = Array.from({ length: B.transactionWrites + 25 }, (_, at) => record(`migration_${at}`, at % 3 === 0 ? false : at));
  const saved = await storage.initializeStaged(records, "staged-migration-large");
  expect(saved).toMatchObject({ revision: 1, recordCount: records.length });
  expect(db.writes.at(-1)).toHaveLength(1); expect(db.writes.at(-1)![0]!.path).toBe(storage.headPath);
  const reopened = store(), loaded = await reopened.load();
  expect(reopened.readRecords(loaded).sort((a, b) => recordKey(a.path).localeCompare(recordKey(b.path)))).toEqual([...records].sort((a, b) => recordKey(a.path).localeCompare(recordKey(b.path))));
});

test("partial staged manifests stay unavailable and an exact fresh-store retry safely completes activation", async () => {
  const storage = store(), records = Array.from({ length: 40 }, (_, at) => record(`recover_${at}`, { at }));
  db.stageFaultAt = records.length + 5;
  await expect(storage.initializeStaged(records, "staged-migration-retry")).rejects.toThrow("staging failure");
  expect(db.documents.has(storage.headPath)).toBe(false); await expect(store().load()).rejects.toThrow("no authoritative head");
  const successor = store(), saved = await successor.initializeStaged(records, "staged-migration-retry");
  expect(saved).toMatchObject({ revision: 1, recordCount: records.length });
  expect(successor.readRecords(await successor.load()).sort((a, b) => recordKey(a.path).localeCompare(recordKey(b.path)))).toEqual([...records].sort((a, b) => recordKey(a.path).localeCompare(recordKey(b.path))));
});

test("staged activation lost acknowledgement never republishes and authoritative reopen reveals the exact outcome", async () => {
  const storage = store(), records = Array.from({ length: 20 }, (_, at) => record(`ack_${at}`, at)); db.fault = "after-commit";
  await expect(storage.initializeStaged(records, "staged-migration-lost-ack")).rejects.toThrow("acknowledgement");
  expect(storage.writeUncertain).toBe(true); const reopened = store(), loaded = await reopened.load();
  expect(loaded).toMatchObject({ revision: 1, recordCount: records.length });
  expect(reopened.readRecords(loaded).sort((a, b) => recordKey(a.path).localeCompare(recordKey(b.path)))).toEqual([...records].sort((a, b) => recordKey(a.path).localeCompare(recordKey(b.path))));
  await expect(reopened.initializeStaged(records, "staged-migration-lost-ack")).rejects.toThrow("empty target");
});

test("staged initialization refuses its record bound before any SDK write", async () => {
  const storage = store(), records = Array.from({ length: B.migrationRecords + 1 }, (_, at) => record(`bounded_${at}`, at)), version = db.version;
  await expect(storage.initializeStaged(records, "staged-migration-too-many")).rejects.toThrow("Invalid bounded");
  expect(db.version).toBe(version); expect(db.documents.size).toBe(0);
});

test("an unrelated orphan manifest prevents staged head publication instead of being adopted", async () => {
  const storage = store(), codec = new FirestoreRecordCodec(key, scope), alien = codec.encodeRecord(record("alien", true));
  db.documents.set(`${storage.collectionPath}/${codec.manifestId(alien.key)}`, codec.encodeHead({ profile: "firestore-record-manifest/v1", key: alien.key,
    hash: alien.hash, bytes: alien.bytes.length, chunks: alien.chunks.map(chunk => chunk.id) }));
  await expect(storage.initializeStaged([record("wanted", false)], "staged-migration-extra")).rejects.toThrow("manifest set differs");
  expect(db.documents.has(storage.headPath)).toBe(false);
});

test("explicit headless cleanup removes abandoned manifests and chunks and permits a different retry", async () => {
  const failed = store(), first = Array.from({ length: 30 }, (_, at) => record(`old_${at}`, at)); db.stageFaultAt = first.length + 5;
  await expect(failed.initializeStaged(first, "staged-migration-abandon")).rejects.toThrow("staging failure");
  expect([...db.documents.keys()].some(path => path.startsWith(failed.collectionPath + "/"))).toBe(true);
  expect([...db.documents.keys()].some(path => path.startsWith(failed.chunkCollectionPath + "/"))).toBe(true);
  db.stageFaultAt = -1; const recovery = store(); await recovery.acquireWriter();
  const report = await recovery.clearUnactivatedStaging(); expect(report.manifests).toBeGreaterThan(0); expect(report.chunks).toBeGreaterThan(0);
  expect([...db.documents.keys()].some(path => path.startsWith(recovery.collectionPath + "/"))).toBe(false);
  expect([...db.documents.keys()].some(path => path.startsWith(recovery.chunkCollectionPath + "/"))).toBe(false);
  const next = [record("new", false)]; expect((await recovery.initializeStaged(next, "staged-migration-new")).recordCount).toBe(1);
});

test("staging cleanup refuses an authoritative target and preserves every active packet", async () => {
  const storage = store(), saved = await storage.initializeStaged([record("active", false)], "staged-migration-active");
  expect(saved.revision).toBe(1); await storage.acquireWriter(); const before = new Map(db.documents);
  await expect(storage.clearUnactivatedStaging()).rejects.toThrow("refuses an authoritative target");
  expect(db.documents).toEqual(before);
});

test("close waits for in-flight staging and refuses subsequent activation or cached success", async () => {
  const { storage, first } = await setup(), head = clone(db.documents.get(storage.headPath)); let resume!: () => void, started!: () => void;
  const hold = new Promise<void>(resolve => { resume = resolve; }), entered = new Promise<void>(resolve => { started = resolve; });
  db.stageHook = async () => { started(); await hold; };
  const operation = storage.commit(first, { transitionId: "close-during-stage", upsert: [record("one", true)] });
  await entered; const close = storage.close(); resume();
  await expect(operation).rejects.toThrow("closed"); await close;
  expect(db.writes.at(-1)).toHaveLength(3); expect(db.documents.get(storage.headPath)).toEqual(head);
});

test("a staging failure drains already-started writes before recovery obtains the store mutex", async () => {
  const { storage, first } = await setup(); let resume!: () => void, entered!: () => void;
  const hold = new Promise<void>(resolve => { resume = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  db.stageHook = async () => { entered(); await hold; }; db.stageFaultAt = db.staged.length + 2;
  let settled = false, loaded = false;
  const operation = storage.commit(first, { transitionId: "drain-inflight-stage", upsert: [record("large", "x".repeat(5_400_000))] });
  const failure = operation.catch(error => { settled = true; return error; });
  await started; const reload = storage.load().then(snapshot => { loaded = true; return snapshot; });
  await new Promise(resolve => setImmediate(resolve));
  expect(settled).toBe(false); expect(loaded).toBe(false);
  resume(); expect((await failure).message).toMatch(/staging failure/);
  expect((await reload).revision).toBe(1); const prepared = db.staged.length;
  await new Promise(resolve => setImmediate(resolve)); expect(db.staged.length).toBe(prepared);
});

test("close during final reference reads denies activation before transaction writes", async () => {
  const { storage, first } = await setup(), head = clone(db.documents.get(storage.headPath));
  let entered!: () => void, resume!: () => void;
  const reading = new Promise<void>(resolve => { entered = resolve; }), hold = new Promise<void>(resolve => { resume = resolve; });
  const original = storage.db.runTransaction.bind(storage.db);
  storage.db.runTransaction = ((callback: any, options: any) => original(async (tx: any) => {
    const get = tx.getAll.bind(tx);
    tx.getAll = async (...refs: any[]) => { const rows = await get(...refs); if (refs[0]?.path.includes("lcwe_record_chunks")) { entered(); await hold; } return rows; };
    return callback(tx);
  }, options)) as any;
  const operation = storage.commit(first, { transitionId: "close-at-activation", upsert: [record("one", true)] });
  await reading; const close = storage.close(); resume();
  await expect(operation).rejects.toThrow("closed"); await close;
  expect(db.documents.get(storage.headPath)).toEqual(head); expect(db.writes.at(-1)).toHaveLength(3);
});

test.each(["missing", "tampered", "wrong-address", "wrong-count", "head-totals"])("%s manifest/reference damage fails authoritative startup", async damage => {
  const { storage } = await setup(), codec = new FirestoreRecordCodec(key, scope), id = codec.manifestId(recordKey(record("one", false).path)), path = `${storage.collectionPath}/${id}`;
  const document = db.documents.get(path), value = codec.decodeHead(document) as any;
  if (damage === "missing") db.documents.delete(path);
  if (damage === "tampered") document.payload[80] ^= 1;
  if (damage === "wrong-address") { value.chunks[0] = codec.encodeRecord(record("other", false)).chunks[0]!.id; db.documents.set(path, codec.encodeHead(value)); }
  if (damage === "wrong-count") { value.chunks.push(value.chunks[0]); db.documents.set(path, codec.encodeHead(value)); }
  if (damage === "head-totals") { const head = codec.decodeHead(db.documents.get(storage.headPath)) as any; head.bytes++; db.documents.set(storage.headPath, codec.encodeHead(head)); }
  await expect(storage.load()).rejects.toThrow(); expect(storage.writeUncertain).toBe(true);
});

test("removal activates only manifest deletion and preserves other records plus retired bodies", async () => {
  const { storage, first } = await setup(), bodyCount = [...db.documents.keys()].filter(path => path.startsWith(storage.chunkCollectionPath)).length;
  const next = await storage.commit(first, { transitionId: "remove-one-record", upsert: [], remove: [record("one", false).path] });
  expect(next.recordCount).toBe(1); expect(next.chunkCount).toBe(1);
  expect(db.writes.at(-1)).toHaveLength(2); expect(db.writes.at(-1)![0]!.data).toBeNull();
  expect([...db.documents.keys()].filter(path => path.startsWith(storage.chunkCollectionPath))).toHaveLength(bodyCount);
  expect(storage.readRecords(await storage.load())).toEqual([record("two", 0)]);
});
test("unknown/copied snapshots, duplicate mutation addresses and invalid identities never reach the SDK", async () => {
  const { storage, first } = await setup(), other = store(), calls = db.invocations;
  await expect(other.commit(first, { transitionId: "wrong-instance-00", upsert: [record("one", true)] })).rejects.toThrow("does not belong");
  await expect(storage.commit({ ...first }, { transitionId: "copied-snapshot-00", upsert: [record("one", true)] })).rejects.toThrow("does not belong");
  await expect(storage.commit(first, { transitionId: "duplicate-address-00", upsert: [record("one", false), record("one", true)] })).rejects.toThrow("Duplicate");
  await expect(storage.commit(first, { transitionId: "?secret=private", upsert: [record("one", false)] })).rejects.toThrow("Invalid bounded");
  expect(db.invocations).toBe(calls);
});
test("closed stores refuse cached reads and writes", async () => {
  const { storage, first } = await setup(); await storage.close();
  expect(() => storage.readRecords(first)).toThrow("closed"); await expect(storage.load()).rejects.toThrow("closed");
  await expect(storage.commit(first, { transitionId: "closed-operation", upsert: [] })).rejects.toThrow("closed");
});

test("an exclusive writer activates the generation atomically and rejects an unowned client", async () => {
  const { storage, first } = await setup(); await storage.acquireWriter(); storage.assertWriterActive();
  const owned = await storage.commit(first, { transitionId: "owned-first-checkpoint", upsert: [record("one", true)] });
  const codec = new FirestoreRecordCodec(key, scope), head = codec.decodeHead(db.documents.get(storage.headPath)) as any;
  expect(head.writerGeneration).toBe(1); expect(owned.revision).toBe(2);
  const other = store(), read = await other.load();
  await expect(other.commit(read, { transitionId: "unowned-write-attempt", upsert: [record("one", "must not write")] })).rejects.toThrow("ownership");
  expect((await storage.load()).revision).toBe(2);
});

test("a retained owned head prevents unowned writes even if its lease document is deleted", async () => {
  const { storage, first } = await setup(); await storage.acquireWriter();
  await storage.commit(first, { transitionId: "owned-protected-head", upsert: [record("one", true)] });
  db.documents.delete(storage.writerPath);
  const other = store(), read = await other.load(), before = clone(db.documents.get(storage.headPath));
  await expect(other.commit(read, { transitionId: "lease-deletion-bypass", upsert: [record("one", "must not write")] })).rejects.toThrow("ownership");
  expect(db.documents.get(storage.headPath)).toEqual(before);
  await expect(storage.load()).rejects.toThrow("ownership");
  await expect(storage.commit(first, { transitionId: "lost-owner-mutation", upsert: [] })).rejects.toThrow("ownership");
});

test("an owned lease handoff preserves records and advances the next activated generation", async () => {
  const { storage, first } = await setup(); await storage.acquireWriter();
  const owned = await storage.commit(first, { transitionId: "owned-before-handoff", upsert: [record("one", true)] });
  await storage.close(); const next = store(); await next.acquireWriter();
  const restored = await next.load(); expect(restored.revision).toBe(owned.revision);
  await next.commit(restored, { transitionId: "owned-after-handoff", upsert: [record("one", "next")] });
  expect((new FirestoreRecordCodec(key, scope).decodeHead(db.documents.get(next.headPath)) as any).writerGeneration).toBe(2);
});

test("lost writer-renewal ACK immediately fences record reads, activation and attempted reload", async () => {
  const { storage, first } = await setup(); await storage.acquireWriter();
  let denials = 0; storage.observeWriterUnavailable(() => { denials++; }); db.fault = "after-commit";
  await expect(storage.renewWriter()).rejects.toThrow("ownership"); expect(denials).toBe(1); expect(storage.writeUncertain).toBe(true);
  expect(() => storage.assertWriterActive()).toThrow(); expect(() => storage.readRecords(first)).toThrow();
  await expect(storage.load()).rejects.toThrow();
  await expect(storage.commit(first, { transitionId: "after-renewal-fault", upsert: [record("one", true)] })).rejects.toThrow();
});

test("the generation anchor blocks an unowned writer even before the first owned data checkpoint", async () => {
  const storage = store(); await storage.acquireWriter(); db.documents.delete(storage.writerPath);
  const raw = store(), empty = await raw.load(); expect(empty.revision).toBe(0);
  await expect(raw.commit(empty, { transitionId: "early-owner-bypass", upsert: [record("one", true)] })).rejects.toThrow("ownership");
  const fresh = store(); await expect(fresh.acquireWriter()).rejects.toThrow("ownership"); expect(db.documents.has(storage.headPath)).toBe(false);
});

test("ownership expiry during awaited chunk reads denies metadata activation before writes", async () => {
  const { storage, first } = await setup(), head = clone(db.documents.get(storage.headPath)); let wall = Date.now(), monotonic = 100;
  await storage.acquireWriter({ duration: 5000, clock: { sample: () => ({ wall, monotonic }) } });
  const original = storage.db.runTransaction.bind(storage.db);
  storage.db.runTransaction = ((callback: any, options: any) => original(async (tx: any) => {
    const get = tx.getAll.bind(tx);
    tx.getAll = async (...refs: any[]) => { const rows = await get(...refs); if (refs[0]?.path.startsWith(storage.chunkCollectionPath)) { wall += 5000; monotonic += 5000; db.serverTime += 5000; } return rows; };
    return callback(tx);
  }, options)) as any;
  await expect(storage.commit(first, { transitionId: "expiry-at-activation", upsert: [record("one", true)] })).rejects.toThrow("ownership");
  expect(db.documents.get(storage.headPath)).toEqual(head); expect(storage.writeUncertain).toBe(true); expect(() => storage.assertWriterActive()).toThrow();
});

test("a future head generation denies owned load and a replayed older ownership cannot acquire the same generation", async () => {
  const { storage, first } = await setup(), codec = new FirestoreRecordCodec(key, scope); await storage.acquireWriter();
  await storage.commit(first, { transitionId: "owned-generation-bind", upsert: [record("one", true)] });
  const head = codec.decodeHead(db.documents.get(storage.headPath)) as any;
  db.documents.set(storage.headPath, codec.encodeHead({ ...head, writerGeneration: 2 }));
  await expect(storage.load()).rejects.toThrow("ownership");
  const owner = codec.decodeHead(db.documents.get(storage.writerPath)) as any;
  db.documents.set(storage.writerPath, codec.encodeHead({ ...owner, state: "RELEASED", expiresAt: owner.issuedAt }));
  const another = store(); await expect(another.acquireWriter()).rejects.toThrow("ownership");
  expect((codec.decodeHead(db.documents.get(storage.headPath)) as any).writerGeneration).toBe(2);
});
