import type { AppConfig } from "../config/config.js";
import type { RepositoryState } from "../repository/store.js";
import type { ProgressSnapshotReader } from "../storage/firestore-progress-reader.js";
import { borrowProgressReader } from "./progress-reader-pool.js";

type MaintenanceState = Pick<RepositoryState, "schedules" | "scheduleOccurrences" | "executions" | "readJobs" | "chatOperations">;
export type MaintenanceKind = "dispatch" | "lifecycle";

/** A conservative skip check only. A positive result still enters the existing
 * owned dispatcher and rechecks current state; this snapshot grants no rights.
 * New work arriving after an empty snapshot is handled on the next minute. */
export function scheduledWorkPending(state: MaintenanceState, kind: MaintenanceKind, nowMs = Date.now()): boolean {
  if (!Number.isFinite(nowMs)) throw new Error("Invalid maintenance clock");
  if (kind === "lifecycle") return Object.values(state.scheduleOccurrences).some(row => row.state === "ADMITTING") ||
    Object.values(state.schedules).some(row => row.state === "ACTIVE" && !!row.nextRunAt && Date.parse(row.nextRunAt) <= nowMs) ||
    Object.values(state.executions).some(run => run.status === "AWAITING_APPROVAL" && run.operationSecret?.state === "WAITING" &&
      Date.parse(run.runtimeApprovalSecret?.records[run.runtimeApprovalSecret.activeId]?.expiresAt ?? "") <= nowMs);
  if (kind !== "dispatch") throw new Error("Invalid maintenance kind");
  return Object.values(state.readJobs).some(job => job.taskDispatchSecret && job.state === "QUEUED" && state.executions[job.executionId]?.status === "PENDING" && job.taskDispatchSecret.state !== "ENQUEUED") ||
    Object.values(state.chatOperations).some(op => op.taskDispatchSecret && op.status === "QUEUED" && op.taskDispatchSecret.state !== "ENQUEUED") ||
    Object.values(state.executions).some(run => {
      if (Object.values(run.operationSecret?.readbacks ?? {}).some(job => job.taskDispatchSecret && job.state === "QUEUED" && job.taskDispatchSecret.state !== "ENQUEUED")) return true;
      if (!run.operationSecret?.taskDispatchSecret || run.status !== "PENDING" || run.operationSecret.state !== "QUEUED") return false;
      const generation = run.operationSecret.taskDispatchSecret.generations?.at(-1);
      return !generation || !generation.completion && generation.state !== "ENQUEUED";
    });
}

export async function scheduledInvocationNeeded(config: AppConfig, kind: MaintenanceKind,
  open: () => ProgressSnapshotReader = () => borrowProgressReader(config)): Promise<boolean> {
  if (config.storageDriver !== "firestore-records") return true;
  const reader = open();
  try { return scheduledWorkPending(await reader.snapshot({ timeoutMs: 30_000 }), kind); }
  finally { await reader.close(); }
}
