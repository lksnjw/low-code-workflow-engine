import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { canonicalJSONBytes } from "../core/canonical-json.js";
import type { Execution, ReadJob } from "../repository/store.js";

export type ReadWorkerLease = { profile: "read-worker-lease/v1"; executionId: string; ownerId: string; leaseId: string; epoch: number;
  acquiredAt: string; renewedAt: string; expiresAt: string; seal: string };
export type ReadWorkerContext = { assertActive(): void; assertDispatch(): void };
export class ReadWorkerLeaseFailure extends Error { constructor(readonly code: string = "READ_WORKER_LEASE_LOST") { super("Read worker ownership is unavailable or expired; no further dispatch is authorized"); } }
export const readJobHasInput=(job:ReadJob)=>job.inputFields!==undefined ? job.inputCiphertext===undefined && !!job.inputFields && typeof job.inputFields==="object" && !Array.isArray(job.inputFields) : typeof job.inputCiphertext==="string" && !!job.inputCiphertext;

const seal = (key: string, job: ReadJob, item: Execution, lease: Omit<ReadWorkerLease, "seal">) => {
  if (Buffer.byteLength(key) < 32) throw new Error("Read lease requires a server-held key");
  return createHmac("sha256", key).update(canonicalJSONBytes({ profile: "read-worker-lease-seal/v1", lease,
    job: { version: job.version, executionId: job.executionId, actorId: job.actorId, admittedRole: job.admittedRole, requestFingerprint: job.requestFingerprint,
      idempotencyScope: job.idempotencyScope, connectionFingerprint: job.connectionFingerprint, ...(job.inputFields?{inputFields:job.inputFields}:{inputCiphertext:job.inputCiphertext}), createdAt: job.createdAt, queueSequence: job.queueSequence, claimedAt: job.claimedAt },
    workflowId: item.workflowId, actorId: item.startedBy.id, snapshot: item.workflowSnapshot })).digest("hex");
};
const iso = (now: number) => new Date(now).toISOString();
function bounds(now: number, duration: number) { if (!Number.isSafeInteger(now) || now < 0 || now + duration > 8.64e15 || !Number.isSafeInteger(duration) || duration < 5000 || duration > 300_000) throw new ReadWorkerLeaseFailure("READ_WORKER_LEASE_INVALID"); }

export function issueReadWorkerLease(key: string, job: ReadJob, item: Execution, ownerId: string, now: number, duration: number): ReadWorkerLease {
  bounds(now, duration);
  if (!ownerId || job.version !== 1 || job.state !== "CLAIMED" || job.workerId !== ownerId || job.executionId !== item.id || job.actorId !== item.startedBy.id || item.status !== "RUNNING" || !item.readProgress || !Number.isSafeInteger(item.readProgress.epoch) || item.readProgress.epoch < 1 || !readJobHasInput(job)) throw new ReadWorkerLeaseFailure("READ_WORKER_LEASE_INVALID");
  const value: Omit<ReadWorkerLease, "seal"> = { profile: "read-worker-lease/v1", executionId: item.id, ownerId, leaseId: randomBytes(16).toString("hex"), epoch: item.readProgress.epoch,
    acquiredAt: iso(now), renewedAt: iso(now), expiresAt: iso(now + duration) };
  return { ...value, seal: seal(key, job, item, value) };
}

export function assertReadWorkerLease(key: string, job: ReadJob | undefined, item: Execution | undefined, expected: Pick<ReadWorkerLease, "executionId" | "ownerId" | "leaseId" | "epoch">, now: number, duration: number): ReadWorkerLease {
  bounds(now, duration); const lease = job?.lease;
  if (!job || !item || !lease || !readJobHasInput(job) || job.version !== 1 || job.state !== "CLAIMED" || item.status !== "RUNNING" || job.executionId !== expected.executionId || item.id !== expected.executionId || job.workerId !== expected.ownerId ||
      !Number.isSafeInteger(expected.epoch) || expected.epoch < 1 || !/^[a-f0-9]{32}$/.test(lease.leaseId) || job.actorId !== item.startedBy.id || item.readProgress?.epoch !== expected.epoch || lease.profile !== "read-worker-lease/v1" || lease.executionId !== expected.executionId || lease.ownerId !== expected.ownerId || lease.leaseId !== expected.leaseId || lease.epoch !== expected.epoch ||
      Object.keys(lease).some(key => !["profile", "executionId", "ownerId", "leaseId", "epoch", "acquiredAt", "renewedAt", "expiresAt", "seal"].includes(key))) throw new ReadWorkerLeaseFailure("READ_WORKER_LEASE_INVALID");
  const acquired = Date.parse(lease.acquiredAt), renewed = Date.parse(lease.renewedAt), expires = Date.parse(lease.expiresAt);
  if (![acquired, renewed, expires].every(Number.isSafeInteger) || iso(acquired) !== lease.acquiredAt || iso(renewed) !== lease.renewedAt || iso(expires) !== lease.expiresAt || renewed < acquired || expires - renewed !== duration || now < renewed)
    throw new ReadWorkerLeaseFailure("READ_WORKER_LEASE_INVALID");
  const { seal: actual, ...record } = lease, proof = seal(key, job, item, record);
  if (typeof actual !== "string" || !/^[a-f0-9]{64}$/.test(actual) || !timingSafeEqual(Buffer.from(actual), Buffer.from(proof))) throw new ReadWorkerLeaseFailure("READ_WORKER_LEASE_INVALID");
  if (now >= expires) throw new ReadWorkerLeaseFailure("READ_WORKER_LEASE_EXPIRED"); return lease;
}

export function renewReadWorkerLease(key: string, job: ReadJob, item: Execution, expected: Pick<ReadWorkerLease, "executionId" | "ownerId" | "leaseId" | "epoch">, now: number, duration: number): ReadWorkerLease {
  const current = assertReadWorkerLease(key, job, item, expected, now, duration);
  const { seal: _proof, ...value } = current, record = { ...value, renewedAt: iso(now), expiresAt: iso(now + duration) };
  return { ...record, seal: seal(key, job, item, record) };
}

/** FIFO within a principal, rotating principals across slots. Active actors
 * keep their ring position; a continually queued actor cannot jump past a
 * different waiting actor when another slot becomes available. */
export function nextFairReadJob(jobs: readonly ReadJob[], activeActors: ReadonlyMap<string, number>, ring: readonly string[], perActor: number): { executionId?: string; ring: string[] } {
  if (!Number.isSafeInteger(perActor) || perActor < 1 || perActor > 8) throw new Error("Invalid per-actor read concurrency");
  const heads = new Map<string, ReadJob>();
  const sequenced = (job: ReadJob) => Number.isSafeInteger(job.queueSequence) && job.queueSequence! > 0;
  // Legacy unsequenced jobs precede new admissions; within the new queue an
  // acknowledged ordinal preserves FIFO even for same-millisecond admission.
  for (const job of jobs.filter(job => job.state === "QUEUED").sort((a, b) =>
    Number(sequenced(a)) - Number(sequenced(b)) || (sequenced(a) ? a.queueSequence! - b.queueSequence! : 0) || a.createdAt.localeCompare(b.createdAt) || a.executionId.localeCompare(b.executionId))) if (!heads.has(job.actorId)) heads.set(job.actorId, job);
  const pending = [...new Set(ring.filter(actor => heads.has(actor)))]; for (const actor of heads.keys()) if (!pending.includes(actor)) pending.push(actor);
  for (let index = 0, count = pending.length; index < count; index++) {
    const actor = pending.shift()!; pending.push(actor);
    if ((activeActors.get(actor) ?? 0) < perActor) return { executionId: heads.get(actor)!.executionId, ring: pending };
  }
  return { ring: pending };
}
