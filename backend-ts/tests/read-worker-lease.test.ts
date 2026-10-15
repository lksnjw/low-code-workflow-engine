import { describe, expect, test } from "vitest";
import { Repository, type Execution, type ReadJob } from "../src/repository/store.js";
import { newReadProgress } from "../src/runner/read-checkpoints.js";
import { assertReadWorkerLease, issueReadWorkerLease, renewReadWorkerLease, nextFairReadJob, ReadWorkerLeaseFailure } from "../src/runner/read-worker-lease.js";

const key = "server-held-read-lease-fixture-key-32-bytes", now = Date.parse("2026-10-06T00:00:00.000Z"), duration = 30_000;
function fixture() {
  const item: Execution = { id: "run-one", workflowId: "wf-one", workflowName: "Read", status: "RUNNING", startedAt: new Date(now).toISOString(), completedAt: null,
    durationMs: 0, tokens: { input: 0, output: 0, total: 0 }, costUsd: 0, startedBy: { id: "actor", name: "Actor" }, readProgress: newReadProgress(new Repository()),
    workflowSnapshot: { version: 1, contentHash: "source-hash", registryHash: "registry-hash", yaml: "fixture", input: {}, executionProfile: "sequential-read-v1" } };
  const job: ReadJob = { version: 1, executionId: item.id, actorId: "actor", admittedRole: "Client", state: "CLAIMED", inputCiphertext: "encrypted-input",
    requestFingerprint: "request", idempotencyScope: "scope", connectionFingerprint: "connection", createdAt: item.startedAt, claimedAt: item.startedAt, workerId: "worker-one" };
  job.lease = issueReadWorkerLease(key, job, item, "worker-one", now, duration);
  return { job, item, expected: structuredClone(job.lease) };
}

describe("authenticated read-worker ownership", () => {
  test("native input is bound by the same lease MAC, including its credential fields",()=>{
    const {job,item}=fixture();delete job.inputCiphertext;job.inputFields={version:1,executionId:item.id,input:{invoiceId:"native-invoice",api_key:"private-fixture"}};
    job.lease=issueReadWorkerLease(key,job,item,"worker-one",now,duration);const expected=structuredClone(job.lease);
    expect(assertReadWorkerLease(key,job,item,expected,now,duration)).toEqual(expected);
    job.inputFields.input.invoiceId="different";expect(()=>assertReadWorkerLease(key,job,item,expected,now,duration)).toThrow(ReadWorkerLeaseFailure);
    job.inputFields.input.invoiceId="native-invoice";job.inputFields.input.api_key="changed";
    expect(()=>assertReadWorkerLease(key,job,item,expected,now,duration)).toThrow(ReadWorkerLeaseFailure);
    job.inputCiphertext="ambiguous";expect(()=>issueReadWorkerLease(key,job,item,"worker-one",now,duration)).toThrow(ReadWorkerLeaseFailure);
  });
  test("binds issuance, acknowledged renewal and final entry to the same private run generation", () => {
    const { job, item, expected } = fixture();
    expect(assertReadWorkerLease(key, job, item, expected, now, duration)).toEqual(expected);
    job.lease = renewReadWorkerLease(key, job, item, expected, now + 10_000, duration);
    expect(job.lease).toMatchObject({ leaseId: expected.leaseId, epoch: expected.epoch, acquiredAt: expected.acquiredAt, renewedAt: new Date(now + 10_000).toISOString(), expiresAt: new Date(now + 40_000).toISOString() });
    expect(job.lease.seal).not.toBe(expected.seal);
    expect(assertReadWorkerLease(key, job, item, expected, now + 35_000, duration)).toEqual(job.lease);
  });
  test.each([duration, duration + 1])("expiry at +%i denies both dispatch and renewal, never reviving ownership", offset => {
    const { job, item, expected } = fixture();
    expect(() => assertReadWorkerLease(key, job, item, expected, now + offset, duration)).toThrow(ReadWorkerLeaseFailure);
    expect(() => renewReadWorkerLease(key, job, item, expected, now + offset, duration)).toThrow(ReadWorkerLeaseFailure);
  });
  test.each([
    ["owner", (job: ReadJob) => { job.workerId = "other-worker"; }],
    ["job profile", (job: ReadJob) => { job.version = 2 as never; }],
    ["execution", (job: ReadJob) => { job.executionId = "other-run"; }],
    ["actor", (job: ReadJob) => { job.actorId = "other-actor"; }],
    ["role", (job: ReadJob) => { job.admittedRole = "Platform Admin"; }],
    ["fingerprint", (job: ReadJob) => { job.requestFingerprint = "other-request"; }],
    ["idempotency", (job: ReadJob) => { job.idempotencyScope = "other-scope"; }],
    ["connection", (job: ReadJob) => { job.connectionFingerprint = "other-connection"; }],
    ["input", (job: ReadJob) => { job.inputCiphertext = "other-input"; }],
    ["creation", (job: ReadJob) => { job.createdAt = new Date(now + 1).toISOString(); }],
    ["admission sequence", (job: ReadJob) => { job.queueSequence = 100; }],
    ["claim", (job: ReadJob) => { job.claimedAt = new Date(now + 1).toISOString(); }],
    ["queued", (job: ReadJob) => { job.state = "QUEUED"; }],
    ["finished", (job: ReadJob) => { job.state = "FINISHED"; }],
    ["lease deletion", (job: ReadJob) => { delete job.lease; }],
    ["extended expiry", (job: ReadJob) => { job.lease!.expiresAt = new Date(now + duration * 2).toISOString(); }],
    ["forged renewal", (job: ReadJob) => { job.lease!.renewedAt = new Date(now + 1000).toISOString(); job.lease!.expiresAt = new Date(now + duration + 1000).toISOString(); }],
    ["epoch", (job: ReadJob) => { job.lease!.epoch++; }],
    ["lease ID", (job: ReadJob) => { job.lease!.leaseId = "a".repeat(32); }],
    ["bad MAC", (job: ReadJob) => { job.lease!.seal = "0".repeat(64); }],
    ["Unicode MAC", (job: ReadJob) => { job.lease!.seal = "é".repeat(64); }],
    ["extra lease property", (job: ReadJob) => { Object.assign(job.lease!, { trusted: true }); }],
  ] as const)("denies changed %s instead of accepting persisted-looking ownership", (_name, mutate) => {
    const { job, item, expected } = fixture(); mutate(job);
    expect(() => assertReadWorkerLease(key, job, item, expected, now + 1000, duration)).toThrow(ReadWorkerLeaseFailure);
  });
  test.each(["status", "epoch", "workflow", "snapshot", "actor"])("denies changed execution %s", kind => {
    const { job, item, expected } = fixture();
    if (kind === "status") item.status = "DONE";
    if (kind === "epoch") item.readProgress!.epoch++;
    if (kind === "workflow") item.workflowId = "other-workflow";
    if (kind === "snapshot") item.workflowSnapshot!.yaml = "other-source";
    if (kind === "actor") item.startedBy.id = "other-actor";
    expect(() => assertReadWorkerLease(key, job, item, expected, now + 1000, duration)).toThrow(ReadWorkerLeaseFailure);
  });
  test("rejects another server key, clock rollback and another worker's expected tuple", () => {
    const { job, item, expected } = fixture();
    expect(() => assertReadWorkerLease("other-server-held-fixture-key-32-bytes", job, item, expected, now, duration)).toThrow(ReadWorkerLeaseFailure);
    expect(() => assertReadWorkerLease(key, job, item, expected, now - 1, duration)).toThrow(ReadWorkerLeaseFailure);
    expect(() => assertReadWorkerLease(key, job, item, { ...expected, ownerId: "other" }, now, duration)).toThrow(ReadWorkerLeaseFailure);
  });
  test.each([4999, 300001, 10.5, NaN, Infinity])("rejects invalid lease duration %s", value => {
    const { job, item } = fixture(); expect(() => issueReadWorkerLease(key, job, item, "worker-one", now, value)).toThrow(ReadWorkerLeaseFailure);
  });
  test.each([-1, 8.64e15, 10.5, NaN, Infinity])("rejects unsupported clock value %s", value => {
    const { job, item } = fixture(); expect(() => issueReadWorkerLease(key, job, item, "worker-one", value, duration)).toThrow(ReadWorkerLeaseFailure);
  });
});

describe("bounded principal-fair queue selection", () => {
  const queued = (actorId: string, executionId: string, offset: number) => ({ ...fixture().job, actorId, executionId, state: "QUEUED" as const, createdAt: new Date(now + offset).toISOString() });
  test("rotates actors, retains FIFO within each actor and does not mutate source jobs", () => {
    const jobs = [queued("a", "a-2", 2), queued("b", "b-1", 1), queued("a", "a-1", 0), queued("c", "c-1", 3)], before = structuredClone(jobs);
    const first = nextFairReadJob(jobs, new Map(), [], 1); expect(first).toEqual({ executionId: "a-1", ring: ["b", "c", "a"] });
    jobs[2]!.state = "CLAIMED" as never;
    const second = nextFairReadJob(jobs, new Map([["a", 1]]), first.ring, 1); expect(second).toEqual({ executionId: "b-1", ring: ["c", "a", "b"] });
    const third = nextFairReadJob(jobs, new Map([["a", 1], ["b", 1]]), second.ring, 1); expect(third.executionId).toBe("c-1");
    expect(before[2]!.state).toBe("QUEUED"); expect(jobs[0]).toEqual(before[0]);
  });
  test("a continually queued actor cannot jump ahead of a waiting principal", () => {
    const jobs = [queued("a", "a-2", 0), queued("b", "b-2", 1), queued("c", "c-1", 2)];
    const held = nextFairReadJob(jobs, new Map([["a", 1], ["b", 1]]), ["a", "c", "b"], 1);
    expect(held.executionId).toBe("c-1");
    const released = nextFairReadJob(jobs, new Map([["b", 1]]), held.ring, 1); expect(released.executionId).toBe("a-2");
  });
  test("acknowledged admission sequence preserves FIFO for same-millisecond random run IDs", () => {
    const jobs = [{ ...queued("a", "aaa-later", 0), queueSequence: 2 }, { ...queued("a", "zzz-first", 0), queueSequence: 1 }];
    expect(nextFairReadJob(jobs, new Map(), [], 1).executionId).toBe("zzz-first");
    expect(nextFairReadJob([...jobs, queued("a", "legacy-first", 1)], new Map(), [], 1).executionId).toBe("legacy-first");
  });
  test("ignores claimed/terminal jobs, duplicate ring entries and blocked actors", () => {
    const jobs = [queued("a", "a-1", 0), { ...queued("b", "b-1", 1), state: "FINISHED" as const }];
    expect(nextFairReadJob(jobs, new Map([["a", 1]]), ["a", "a", "b"], 1)).toEqual({ ring: ["a"] });
    expect(nextFairReadJob(jobs, new Map([["a", 1]]), [], 2).executionId).toBe("a-1");
  });
  test.each([0, 9, 1.5, NaN])("rejects invalid per-actor capacity %s", value => {
    expect(() => nextFairReadJob([], new Map(), [], value)).toThrow("per-actor");
  });
});
