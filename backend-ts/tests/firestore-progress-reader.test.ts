import { beforeEach, expect, test, vi } from "vitest";
import { Repository, type RepositoryState } from "../src/repository/store.js";
import { splitFirestoreState } from "../src/storage/firestore-record-layout.js";
import { openFirestoreProgressReader } from "../src/storage/firestore-progress-reader.js";
import { loadConfig } from "../src/config/config.js";

const calls = vi.hoisted(() => ({ create: vi.fn(), load: vi.fn(), readRecords: vi.fn(), close: vi.fn(), acquireWriter: vi.fn(), renewWriter: vi.fn(), commit: vi.fn(), metadataPage:vi.fn(),
  namespace: { projectId: "demo-lcwe-records", databaseId: "(default)", workspaceId: "test_progress" } }));
vi.mock("../src/storage/firestore-record-store.js", () => ({ FirestoreRecordStore: { create: calls.create } }));
beforeEach(() => {
  vi.resetAllMocks(); calls.create.mockReturnValue(calls); calls.load.mockImplementation(async () => ({})); calls.close.mockResolvedValue(undefined);
});
const config = () => ({ ...loadConfig({ APP_ENV: "test", STORAGE_DRIVER: "memory", JWT_SECRET: "progress-reader-secret-at-least-32-bytes" }), storageDriver: "firestore-records" as const,
  storageEncryptionKey: Buffer.alloc(32, 7).toString("base64"), firestoreProjectId: "demo-lcwe-records", firestoreDatabaseId: "(default)", firestoreWorkspaceId: "test_progress" });
async function state() { const repository = await Repository.open(null); try { return await repository.snapshot(); } finally { await repository.close(); } }
test("reader shares strict state reconstruction but never acquires or renews writer/mutates records", async () => {
  const before = await state(); calls.readRecords.mockReturnValue(splitFirestoreState(before));
  const reader = openFirestoreProgressReader(config()); expect(Object.keys(reader).sort()).toEqual(["cancellationRequested", "close", "snapshot"]);
  expect(await reader.snapshot()).toEqual(before);
  await reader.close(); await reader.close(); expect(calls.close).toHaveBeenCalledOnce();
  expect(calls.acquireWriter).not.toHaveBeenCalled(); expect(calls.renewWriter).not.toHaveBeenCalled(); expect(calls.commit).not.toHaveBeenCalled();
});
test("each snapshot loads a fresh committed head, not the previous response's mutable image", async () => {
  const before = await state(), after = structuredClone(before); after.counter++;
  calls.readRecords.mockReturnValueOnce(splitFirestoreState(before)).mockReturnValueOnce(splitFirestoreState(after));
  const reader = openFirestoreProgressReader(config()), first = await reader.snapshot(); first.counter = -1;
  expect((await reader.snapshot()).counter).toBe(after.counter); expect(calls.load).toHaveBeenCalledTimes(2); await reader.close();
});
test("empty and malformed normalized state cannot seed or repair authority", async () => {
  calls.readRecords.mockReturnValue([]); const reader = openFirestoreProgressReader(config());
  await expect(reader.snapshot()).rejects.toThrow("No committed normalized");
  const invalid = await state(); (invalid as unknown as Record<string, unknown>).roles = null;
  calls.readRecords.mockReturnValue(splitFirestoreState(invalid));
  await expect(reader.snapshot()).rejects.toThrow(); await reader.close();
});
test("authenticated record/head failure is not replaced by a stale or default image", async () => {
  calls.readRecords.mockReturnValue(splitFirestoreState(await state())); const reader = openFirestoreProgressReader(config());
  await reader.snapshot(); calls.load.mockRejectedValueOnce(new Error("Authenticated head mismatch"));
  await expect(reader.snapshot()).rejects.toThrow("Authenticated head mismatch"); await reader.close();
});

test("unchanged authenticated head reuses conversion, but returned images remain isolated", async () => {
  const image = {}, before = await state(); calls.load.mockResolvedValue(image);
  calls.readRecords.mockReturnValue(splitFirestoreState(before));
  const reader = openFirestoreProgressReader(config()), first = await reader.snapshot(); first.counter = -99;
  expect((await reader.snapshot()).counter).toBe(before.counter);
  expect(calls.load).toHaveBeenLastCalledWith(image); expect(calls.readRecords).toHaveBeenCalledTimes(1);
  await reader.close();
});

test("concurrent native queries retain the exact authorizing image, never a later borrower's head",async()=>{
  const firstImage={},secondImage={},before=await state();calls.load.mockResolvedValueOnce(firstImage).mockResolvedValueOnce(secondImage);calls.readRecords.mockReturnValue(splitFirestoreState(before));calls.metadataPage.mockResolvedValue([]);
  const reader=openFirestoreProgressReader({...config(),firestoreContentFormat:"native-fields/v1"}),first=await reader.snapshot();await reader.snapshot();
  await reader.metadataPage!(first,"chats","owner",20);expect(calls.metadataPage).toHaveBeenCalledWith(firstImage,"chats","owner",20,undefined);
  expect(()=>reader.metadataPage!(structuredClone(first),"chats","owner",20)).toThrow("authenticated image");await reader.close();
});
test("timeout closes the reader and late loading cannot publish evidence", async () => {
  let finish!: (value: object) => void; calls.load.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  calls.readRecords.mockReturnValue(splitFirestoreState(await state())); const reader = openFirestoreProgressReader(config());
  await expect(reader.snapshot({ timeoutMs: 10 })).rejects.toThrow("deadline"); finish({}); await reader.close();
  expect(calls.close).toHaveBeenCalledOnce(); expect(calls.readRecords).not.toHaveBeenCalled();
  expect(() => reader.snapshot()).toThrow("closed"); await reader.close();
});
test("abort before loading does not touch storage and abort during loading fences late evidence", async () => {
  const reader = openFirestoreProgressReader(config()), early = new AbortController(); early.abort();
  await expect(reader.snapshot({ signal: early.signal })).rejects.toThrow("cancelled"); expect(calls.load).not.toHaveBeenCalled();
  let finish!: (value: object) => void; calls.load.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const controller = new AbortController(), pending = reader.snapshot({ signal: controller.signal });
  await vi.waitFor(()=>expect(calls.load).toHaveBeenCalledTimes(1));controller.abort();
  await expect(pending).rejects.toThrow("cancelled"); finish({}); await Promise.resolve(); expect(calls.readRecords).not.toHaveBeenCalled();
  await reader.close();
});
test("invalid configuration/deadline never selects an aggregate or alternate driver", async () => {
  expect(() => openFirestoreProgressReader({ ...config(), storageDriver: "memory" })).toThrow("normalized Firestore");
  expect(calls.create).not.toHaveBeenCalled(); const reader = openFirestoreProgressReader(config());
  for (const timeoutMs of [0, -1, 30_001, 1.5, Infinity]) expect(() => reader.snapshot({ timeoutMs })).toThrow("deadline");
  expect(calls.load).not.toHaveBeenCalled(); await reader.close();
});
