import { apiClient, AUTH_STORAGE } from "../config/axios";
import { unwrap } from "./api";

const terminal = status => ["DONE", "FAILED", "CANCELLED"].includes(status);
const validKey = value => typeof value === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(value);
const id = value => typeof value === "string" && value.length > 0 && value.length <= 256;
export const RUN_ADMISSION_CHANGED = "workflow:run-admission-changed";
const uncertain = "The original run outcome is unconfirmed. Recover its receipt or review Execution History; no request was repeated.";

function identity(workflowId, expectedActorId, retrySourceId) {
  let actor;
  try { actor = JSON.parse(localStorage.getItem(AUTH_STORAGE.user) || "null")?.id; }
  catch { throw new Error("The signed-in account identity is unavailable."); }
  if (!id(actor) || !id(workflowId)) throw new Error("A signed-in account and saved workflow are required.");
  if (expectedActorId && actor !== expectedActorId) throw new Error("The signed-in account changed. Reload before continuing.");
  if (retrySourceId !== undefined && !id(retrySourceId)) throw new Error("An exact original execution is required for Retry.");
  return { actor, workflowId, retrySourceId, name: `workflow.run-admission.v1.${encodeURIComponent(apiClient.defaults.baseURL)}.${encodeURIComponent(actor)}.${encodeURIComponent(workflowId)}${retrySourceId ? `.retry.${encodeURIComponent(retrySourceId)}` : ""}` };
}
function read(scope) {
  const raw = localStorage.getItem(scope.name);
  if (raw === null) return null;
  let entry; try { entry = JSON.parse(raw); } catch { throw new Error("Saved run identity is unreadable. Inspect Execution History before another run."); }
  if (!entry || entry.profile !== "run-admission-client/v1" || !validKey(entry.key) || !["async-read", "async-operation"].includes(entry.mode) ||
      entry.executionId !== null && !id(entry.executionId) || typeof entry.createdAt !== "string" || !Number.isFinite(Date.parse(entry.createdAt)) ||
      Object.keys(entry).some(key => !["profile", "key", "mode", "executionId", "createdAt"].includes(key)))
    throw new Error("Saved run identity is invalid. Inspect Execution History before another run.");
  return entry;
}
function write(scope, entry) {
  const raw = entry ? JSON.stringify(entry) : null;
  if (raw === null) localStorage.removeItem(scope.name); else localStorage.setItem(scope.name, raw);
  if (localStorage.getItem(scope.name) !== raw) throw new Error("Run identity storage could not be confirmed; no additional request is safe.");
  window.dispatchEvent(new CustomEvent(RUN_ADMISSION_CHANGED, { detail: scope.name }));
}
function assertAccount(scope) {
  if (identity(scope.workflowId, scope.actor, scope.retrySourceId).name !== scope.name) throw new Error("The signed-in account changed. Reload before continuing.");
}
async function locked(scope, action) {
  if (!navigator.locks?.request) throw new Error("Safe cross-tab run admission requires a secure browser with Web Locks support.");
  return navigator.locks.request(scope.name, { mode: "exclusive" }, () => { assertAccount(scope); return action(); });
}
async function receipt(scope, entry) {
  assertAccount(scope);
  const value = unwrap(await apiClient.get(`/workflows/${encodeURIComponent(scope.workflowId)}/run-receipts/${encodeURIComponent(entry.key)}`, { params: { mode: entry.mode } }));
  assertAccount(scope);
  if (value?.profile !== "run-admission-receipt/v1" || value.workflowId !== scope.workflowId || value.mode !== entry.mode || value.noReplay !== true ||
      !["RECORDED", "NOT_FOUND"].includes(value.outcome) || value.outcome === "RECORDED" && (!id(value.executionId) || typeof value.status !== "string") ||
      value.outcome === "NOT_FOUND" && (value.executionId !== null || value.status !== null) || entry.executionId && value.outcome === "RECORDED" && value.executionId !== entry.executionId)
    throw new Error("The exact original run receipt could not be verified. Nothing was repeated.");
  return value;
}
async function recover(scope, entry) {
  const evidence = await receipt(scope, entry);
  if (evidence.outcome !== "RECORDED") throw new Error(uncertain);
  const next = { ...entry, executionId: evidence.executionId }; if (entry.executionId !== next.executionId) write(scope, next);
  const run = unwrap(await apiClient.get(`/executions/${encodeURIComponent(evidence.executionId)}`));
  assertAccount(scope);
  if (run?.id !== evidence.executionId || run.workflowId !== scope.workflowId) throw new Error("Saved execution identity does not match its receipt.");
  if (scope.retrySourceId && run.retrySource?.sourceExecutionId !== scope.retrySourceId) throw new Error("Saved retry source does not match the original execution.");
  return { ...run, admissionNotice: "Restored the original run. No new inputs or run request were submitted." };
}

export const runAdmissionService = {
  storageKey(workflowId, actorId) { return identity(workflowId, actorId).name; },
  pending(workflowId, actorId) { const scope = identity(workflowId, actorId); return read(scope); },
  async recover(workflowId, actorId) {
    const scope = identity(workflowId, actorId);
    return locked(scope, async () => { const entry = read(scope); return entry ? recover(scope, entry) : null; });
  },
  async release(workflowId, snapshot, actorId) {
    const scope = identity(workflowId, actorId);
    return locked(scope, async () => {
      const entry = read(scope); if (!entry) return true;
      const stoppedBeforeDispatch = snapshot?.status === "RECOVERY_REQUIRED" && snapshot.retryAdmission?.canReviewForNewRun === true;
      if (!id(snapshot?.id) || entry.executionId !== snapshot.id || !terminal(snapshot.status) && !stoppedBeforeDispatch) return false;
      const evidence = await receipt(scope, entry);
      if (evidence.outcome !== "RECORDED" || !terminal(evidence.status) && !(stoppedBeforeDispatch && evidence.status === "RECOVERY_REQUIRED" && evidence.safeToReviewForNewRun === true)) return false;
      write(scope, null); return true;
    });
  },
  async admit(workflowId, input, options = {}) {
    let sent = false;
    try {
      const scope = identity(workflowId, options.expectedActorId, options.retry?.sourceExecutionId);
      return await locked(scope, async () => {
        const previous = read(scope);
        if (previous) { sent = true; return recover(scope, previous); }
        const readiness = unwrap(await apiClient.get(`/workflows/${encodeURIComponent(workflowId)}/readiness`));
        assertAccount(scope);
        if (readiness?.can_attempt_run !== true) throw new Error("This publication is not ready. Open the canvas to review its tools, validation and inputs.");
        const mode = readiness.operation_job_admission === "operation-job/v1" ? "async-operation" : readiness.read_job_admission === "read-job-v1" ? "async-read" : null;
        if (!mode || options.mode && options.mode !== mode) throw new Error("A current supported queued admission is required. Reload the canvas.");
        const key = options.idempotencyKey ?? crypto.randomUUID(); if (!validKey(key)) throw new Error("A stable run request identity is required.");
        const entry = { profile: "run-admission-client/v1", key, mode, executionId: null, createdAt: new Date().toISOString() };
        write(scope, entry); assertAccount(scope); sent = true;
        let run;
        try { run = unwrap(await apiClient.post(options.retry ? `/executions/${encodeURIComponent(scope.retrySourceId)}/retry` : `/workflows/${encodeURIComponent(workflowId)}/run`,
          { input, mode, idempotencyKey: key, expectedActorId: scope.actor, ...(options.retry ? { retry: options.retry } : {}) }, { timeout: 300000 })); }
        catch (cause) {
          const executionId = cause?.response?.data?.meta?.executionId;
          if (id(executionId)) write(scope, { ...entry, executionId });
          else if ([400, 401, 403, 404, 413, 422, 429].includes(cause?.response?.status) || cause?.response?.status === 409 && cause?.response?.data?.meta?.code === "EXECUTION_RETRY_BLOCKED") { write(scope, null); sent = false; throw cause; }
          try { return await recover(scope, read(scope)); } catch { throw cause; }
        }
        if (!id(run?.id) || run.workflowId !== workflowId) throw new Error("The run response identity could not be confirmed.");
        write(scope, { ...entry, executionId: run.id }); assertAccount(scope); return run;
      });
    } catch (cause) {
      // Keep original API details for exact-ID recovery, but tell the UI whether
      // a POST might have entered. Preflight/storage/lock failure is not entry.
      if (cause && typeof cause === "object") {
        cause.runAdmissionUnconfirmed = sent;
        if (!cause.response && typeof cause.message === "string") cause.runAdmissionMessage = cause.message;
      }
      throw cause;
    }
  },
};
