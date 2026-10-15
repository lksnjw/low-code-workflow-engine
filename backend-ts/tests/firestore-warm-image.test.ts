import { beforeEach, expect, test, vi } from "vitest";
import { FirestoreRecordStore } from "../src/storage/firestore-record-store.js";
import type { RuntimeRecord } from "../src/storage/execution-record-layout.js";
const fixture = vi.hoisted(() => ({ db: null as any }));
vi.mock("@google-cloud/firestore", () => ({ Firestore: class { constructor(settings: any) { return new FakeClient(fixture.db, settings); } } }));
import { Database, FakeClient } from "./fixtures/fake-firestore.js";
let db: Database, sequence = 0;
const key = "w".repeat(32);
const scope = () => ({ projectId: "demo-lcwe-records", databaseId: "(default)", workspaceId: `warm_image_${sequence}` });
const record = (id: string, value: unknown): RuntimeRecord => ({ profile: "runtime-record/v1", path: ["domain", "settings", id], value });
const open = (warm = true, namespace = scope(), encryptionKey = key) => FirestoreRecordStore.create(encryptionKey, namespace, {}, "native-fields/v1", warm);
beforeEach(() => { db = new Database(); fixture.db = db; sequence++; });

test("a fresh client reuses verified bytes only after reading its current authenticated head", async () => {
  const first = open(), saved = await first.commit(await first.load(), { transitionId: "seed-warm-image", upsert: [record("allowed", true), record("unchanged", 42)] });
  await first.close(); db.reads = [];
  const second = open(), loaded = await second.load();
  expect(loaded).toEqual(saved); expect(second.readRecords(loaded)).toEqual([record("allowed", true), record("unchanged", 42)]);
  expect(db.reads).toEqual([second.headPath]);
  const copy = second.readRecords(loaded); copy[0]!.value = "untrusted mutation";
  expect(second.readRecords(loaded)[0]!.value).toBe(true); await second.close();
});

test("a current head change reloads changed records and cannot cache a revoked permission", async () => {
  const first = open(); await first.commit(await first.load(), { transitionId: "seed-warm-revocation", upsert: [record("allowed", true), record("unchanged", 42)] }); await first.close();
  // Simulate another process: its default cold store cannot update this process's cache.
  const external = open(false); await external.commit(await external.load(), { transitionId: "revoke-warm-permission", upsert: [record("allowed", false)] }); await external.close();
  db.reads = []; const second = open(), loaded = await second.load();
  expect(second.readRecords(loaded).find(row => row.path.at(-1) === "allowed")!.value).toBe(false);
  expect(db.reads).toContain(second.collectionPath);
  expect(db.reads.filter(path => path.startsWith(second.chunkCollectionPath + "/"))).toHaveLength(1);
  await second.close();
});

test("verified image reuse never transfers a writer lease or bypasses its fresh acquisition", async () => {
  const seed = open(); await seed.commit(await seed.load(), { transitionId: "seed-warm-writer", upsert: [record("value", 1)] }); await seed.close();
  const writer = open(); await writer.acquireWriter(); db.reads = [];
  const loaded = await writer.load(); expect(writer.readRecords(loaded)).toEqual([record("value", 1)]);
  expect(db.reads).toContain(writer.writerPath); expect(db.reads).toContain(writer.writerGenerationPath); expect(db.reads).toContain(writer.headPath);
  const competing = open(); await expect(competing.acquireWriter()).rejects.toMatchObject({ reason: "WRITER_HELD" });
  await competing.close(); await writer.close();
});

test("an unknown commit ACK is not published as cache authority; a fresh reader proves the committed head", async () => {
  const first = open(), saved = await first.commit(await first.load(), { transitionId: "seed-warm-unknown", upsert: [record("value", 1)] });
  db.fault = "after-commit";
  await expect(first.commit(saved, { transitionId: "unknown-warm-commit", upsert: [record("value", 2)] })).rejects.toThrow();
  expect(first.writeUncertain).toBe(true); await first.close(); db.reads = [];
  const second = open(), loaded = await second.load();
  expect(second.readRecords(loaded)).toEqual([record("value", 2)]);
  expect(db.reads).toContain(second.collectionPath); expect(db.reads.some(path => path.startsWith(second.chunkCollectionPath + "/"))).toBe(true);
  await second.close();
});

test("keys and explicit namespaces remain isolated even when another image is warm", async () => {
  const first = open(); await first.commit(await first.load(), { transitionId: "seed-warm-scope", upsert: [record("value", 1)] }); await first.close();
  const wrongKey = open(true, scope(), "x".repeat(32)); await expect(wrongKey.load()).rejects.toThrow(); await wrongKey.close();
  const foreign = open(true, { ...scope(), workspaceId: "other_warm_scope" });
  expect(foreign.readRecords(await foreign.load())).toEqual([]); await foreign.close();
});

test("the warm image cache is bounded and disabled clients retain full verification", async () => {
  for (let i = 0; i < 3; i++) {
    const writer = open(true, { ...scope(), workspaceId: `bounded_warm_${sequence}_${i}` });
    await writer.commit(await writer.load(), { transitionId: `seed-bounded-warm-${i}`, upsert: [record("value", i)] }); await writer.close();
  }
  db.reads = []; const evicted = open(true, { ...scope(), workspaceId: `bounded_warm_${sequence}_0` }); await evicted.load();
  expect(db.reads).toContain(evicted.collectionPath); await evicted.close();
  db.reads = []; const disabled = open(false, { ...scope(), workspaceId: `bounded_warm_${sequence}_0` }); await disabled.load();
  expect(db.reads).toContain(disabled.collectionPath); await disabled.close();
});
