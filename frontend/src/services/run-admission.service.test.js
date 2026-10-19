/** @jest-environment jsdom */
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import { apiClient, AUTH_STORAGE } from "../config/axios";
import { runAdmissionService } from "./run-admission.service";
import { workflowService } from "./workflow.service";
import { executionService } from "./execution.service";

const wrap = data => ({ data: { success: true, data } });
const run = { id: "run-one", workflowId: "flow", status: "DONE", tokens: { input: 2, output: 2, total: 4 } };
const receipt = (extra = {}) => ({ profile: "run-admission-receipt/v1", outcome: "RECORDED", workflowId: "flow", mode: "async-operation", executionId: run.id, status: run.status, noReplay: true, ...extra });
let queues;
beforeEach(() => {
  localStorage.clear(); localStorage.setItem(AUTH_STORAGE.user, JSON.stringify({ id: "actor" })); queues = new Map();
  Object.defineProperty(navigator, "locks", { configurable: true, value: { request: jest.fn((name, _options, action) => {
    const task = (queues.get(name) || Promise.resolve()).catch(() => {}).then(action); queues.set(name, task); return task;
  }) } });
  jest.spyOn(crypto, "randomUUID").mockReturnValue("stable-request-key-0001");
  jest.spyOn(apiClient, "get").mockImplementation(async path => path.endsWith("/readiness") ? wrap({ can_attempt_run: true, operation_job_admission: "operation-job/v1" }) : path.includes("/run-receipts/") ? wrap(receipt()) : wrap(run));
  jest.spyOn(apiClient, "post").mockResolvedValue(wrap(run));
});
afterEach(() => { localStorage.clear(); jest.restoreAllMocks(); delete navigator.locks; });

test("shared admission is serialized, stores identity only and restores earlier work instead of submitting different inputs", async () => {
  const results = await Promise.all([runAdmissionService.admit("flow", { privatePayroll: "never store this" }), runAdmissionService.admit("flow", { privatePayroll: "different input" })]);
  expect(apiClient.post).toHaveBeenCalledTimes(1);
  expect(apiClient.post).toHaveBeenCalledWith("/workflows/flow/run", { input: { privatePayroll: "never store this" }, mode: "async-operation", idempotencyKey: "stable-request-key-0001", expectedActorId: "actor" }, { timeout: 300000 });
  expect(results[1].admissionNotice).toMatch(/No new inputs/);
  const saved = runAdmissionService.pending("flow"); expect(Object.keys(saved).sort()).toEqual(["profile", "key", "mode", "executionId", "createdAt"].sort());
  expect(JSON.stringify(localStorage)).not.toMatch(/privatePayroll|never store this|different input/);
});
test("a page/service remount recovers a recorded ID by GET only", async () => {
  await runAdmissionService.admit("flow", {}); apiClient.post.mockClear(); apiClient.get.mockClear();
  expect((await runAdmissionService.recover("flow")).id).toBe("run-one"); expect(apiClient.post).not.toHaveBeenCalled();
  expect(apiClient.get.mock.calls.map(call => call[0])).toEqual(["/workflows/flow/run-receipts/stable-request-key-0001", "/executions/run-one"]);
});
test("workflow and execution Run services share one admission instead of two dispatch commands", async () => {
  const first = await workflowService.run("flow", {}), second = await executionService.run("flow", { changed: true });
  expect(first.id).toBe(second.id); expect(second.recordedUsage.total).toBe(4); expect(second.admissionNotice).toMatch(/No new inputs/);
  expect(apiClient.post).toHaveBeenCalledTimes(1);
});
test("lost admission acknowledgement finds its original receipt with no second POST", async () => {
  apiClient.post.mockRejectedValue(new Error("Connection lost"));
  expect((await runAdmissionService.admit("flow", {})).id).toBe("run-one");
  expect(apiClient.post).toHaveBeenCalledTimes(1); expect(runAdmissionService.pending("flow").executionId).toBe("run-one");
});

test("double-clicked retry has one new command, a separate lock scope and exact source lineage", async () => {
  const retry = { sourceExecutionId: "original-failed", acknowledgeUnconfirmed: true };
  const child = { ...run, retrySource: { sourceExecutionId: retry.sourceExecutionId } };
  apiClient.post.mockResolvedValue(wrap(child));
  apiClient.get.mockImplementation(async path => path.endsWith("/readiness") ? wrap({ can_attempt_run: true, operation_job_admission: "operation-job/v1" }) : path.includes("/run-receipts/") ? wrap(receipt()) : wrap(child));
  const results = await Promise.all([runAdmissionService.admit("flow", undefined, { retry }), runAdmissionService.admit("flow", undefined, { retry })]);
  expect(results.map(value => value.id)).toEqual(["run-one", "run-one"]); expect(apiClient.post).toHaveBeenCalledTimes(1);
  expect(apiClient.post).toHaveBeenCalledWith("/executions/original-failed/retry", { input: undefined, mode: "async-operation", idempotencyKey: "stable-request-key-0001", expectedActorId: "actor", retry }, { timeout: 300000 });
  expect(runAdmissionService.pending("flow")).toBeNull(); expect(Object.keys(localStorage).some(key => key.includes(".retry.original-failed"))).toBe(true);
});

test("lost retry response recovers the original new execution without repeating the POST", async () => {
  const retry = { sourceExecutionId: "original-failed", acknowledgeUnconfirmed: false }, child = { ...run, retrySource: { sourceExecutionId: "original-failed" } };
  apiClient.post.mockRejectedValue(new Error("Lost response"));
  apiClient.get.mockImplementation(async path => path.endsWith("/readiness") ? wrap({ can_attempt_run: true, operation_job_admission: "operation-job/v1" }) : path.includes("/run-receipts/") ? wrap(receipt()) : wrap(child));
  expect((await runAdmissionService.admit("flow", undefined, { retry })).id).toBe("run-one");
  expect((await runAdmissionService.admit("flow", undefined, { retry })).id).toBe("run-one"); expect(apiClient.post).toHaveBeenCalledTimes(1);
});
test("NOT_FOUND is uncertainty, not permission for a new key or automatic resend", async () => {
  apiClient.post.mockRejectedValue(new Error("Lost response"));
  apiClient.get.mockImplementation(async path => path.endsWith("/readiness") ? wrap({ can_attempt_run: true, operation_job_admission: "operation-job/v1" }) : wrap(receipt({ outcome: "NOT_FOUND", executionId: null, status: null })));
  await expect(runAdmissionService.admit("flow", {})).rejects.toMatchObject({ runAdmissionUnconfirmed: true });
  const original = runAdmissionService.pending("flow");
  await expect(runAdmissionService.admit("flow", { changed: true })).rejects.toMatchObject({ runAdmissionUnconfirmed: true });
  await expect(runAdmissionService.recover("flow")).rejects.toThrow(/unconfirmed/);
  expect(runAdmissionService.pending("flow")).toEqual(original); expect(apiClient.post).toHaveBeenCalledTimes(1); expect(crypto.randomUUID).toHaveBeenCalledTimes(1);
});
test.each([400, 401, 403, 404, 413, 422, 429])("definite HTTP %s without an execution ID releases only the rejected command", async status => {
  apiClient.post.mockRejectedValueOnce({ response: { status } });
  await expect(runAdmissionService.admit("flow", {})).rejects.toMatchObject({ runAdmissionUnconfirmed: false });
  expect(runAdmissionService.pending("flow")).toBeNull();
  expect((await runAdmissionService.admit("flow", {})).id).toBe("run-one");
});
test.each([409, 500, 503])("HTTP %s remains recoverable and never creates another command", async status => {
  apiClient.post.mockRejectedValue({ response: { status } }); apiClient.get.mockImplementation(async path => path.endsWith("/readiness") ? wrap({ can_attempt_run: true, operation_job_admission: "operation-job/v1" }) : Promise.reject(new Error("Offline")));
  await expect(runAdmissionService.admit("flow", {})).rejects.toMatchObject({ runAdmissionUnconfirmed: true });
  await expect(runAdmissionService.admit("flow", {})).rejects.toMatchObject({ runAdmissionUnconfirmed: true });
  expect(apiClient.post).toHaveBeenCalledTimes(1); expect(runAdmissionService.pending("flow")).not.toBeNull();
});
test("an explicit execution ID in an error is retained when evidence is unavailable", async () => {
  apiClient.post.mockRejectedValue({ response: { status: 422, data: { meta: { executionId: "run-one" } } } });
  apiClient.get.mockImplementation(async path => path.endsWith("/readiness") ? wrap({ can_attempt_run: true, operation_job_admission: "operation-job/v1" }) : Promise.reject(new Error("Offline")));
  await expect(runAdmissionService.admit("flow", {})).rejects.toMatchObject({ runAdmissionUnconfirmed: true });
  expect(runAdmissionService.pending("flow").executionId).toBe("run-one");
});
test.each(["wrong-id", "wrong-workflow", "wrong-mode", "replay-allowed", "missing-id"])("invalid %s recovery evidence cannot replace or clear the original identity", async kind => {
  await runAdmissionService.admit("flow", {}); const original = runAdmissionService.pending("flow");
  const changes = { "wrong-id": { executionId: "other" }, "wrong-workflow": { workflowId: "other" }, "wrong-mode": { mode: "async-read" }, "replay-allowed": { noReplay: false }, "missing-id": { executionId: null } };
  apiClient.get.mockResolvedValue(wrap(receipt(changes[kind])));
  await expect(runAdmissionService.recover("flow")).rejects.toThrow(/verified/); expect(runAdmissionService.pending("flow")).toEqual(original); expect(apiClient.post).toHaveBeenCalledTimes(1);
});
test("only exact server-confirmed terminal evidence allows explicit new admission", async () => {
  await runAdmissionService.admit("flow", {});
  expect(await runAdmissionService.release("flow", { ...run, id: "other" })).toBe(false);
  expect(await runAdmissionService.release("flow", { ...run, status: "RECOVERY_REQUIRED" })).toBe(false);
  apiClient.get.mockResolvedValueOnce(wrap(receipt({ status: "RUNNING" })));
  expect(await runAdmissionService.release("flow", run)).toBe(false); expect(runAdmissionService.pending("flow")).not.toBeNull();
  expect(await runAdmissionService.release("flow", run)).toBe(true); expect(runAdmissionService.pending("flow")).toBeNull();
  await runAdmissionService.admit("flow", {}); expect(apiClient.post).toHaveBeenCalledTimes(2);
});

test("a pre-dispatch recovery requires fresh server proof before releasing a browser run lock", async () => {
  await runAdmissionService.admit("flow", {});
  const stopped = { ...run, status: "RECOVERY_REQUIRED", retryAdmission: { canReviewForNewRun: true } };
  apiClient.get.mockResolvedValueOnce(wrap(receipt({ status: "RECOVERY_REQUIRED", safeToReviewForNewRun: false })));
  expect(await runAdmissionService.release("flow", stopped)).toBe(false);
  apiClient.get.mockResolvedValueOnce(wrap(receipt({ status: "RECOVERY_REQUIRED", safeToReviewForNewRun: true })));
  expect(await runAdmissionService.release("flow", stopped)).toBe(true);
  expect(apiClient.post).toHaveBeenCalledTimes(1);
});
test.each(["storage", "locks", "corrupt", "unready", "wrong-mode"])("%s fails before POST and never overwrites an uncertain identity", async kind => {
  if (kind === "storage") jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Quota exhausted"); });
  if (kind === "locks") delete navigator.locks;
  if (kind === "corrupt") { await runAdmissionService.admit("flow", {}); const name = Object.keys(localStorage).find(value => value.startsWith("workflow.run-admission")); localStorage.setItem(name, "broken"); apiClient.post.mockClear(); }
  if (kind === "unready") apiClient.get.mockResolvedValue(wrap({ can_attempt_run: false }));
  await expect(runAdmissionService.admit("flow", {}, kind === "wrong-mode" ? { mode: "async-read" } : {})).rejects.toThrow(); expect(apiClient.post).not.toHaveBeenCalled();
});
test("account changes during preflight prevent admission; saved identity is account/API scoped", async () => {
  apiClient.get.mockImplementationOnce(async () => { localStorage.setItem(AUTH_STORAGE.user, JSON.stringify({ id: "other" })); return wrap({ can_attempt_run: true, operation_job_admission: "operation-job/v1" }); });
  await expect(runAdmissionService.admit("flow", {})).rejects.toThrow(/account changed/); expect(apiClient.post).not.toHaveBeenCalled();
  await runAdmissionService.admit("flow", {}); localStorage.setItem(AUTH_STORAGE.user, JSON.stringify({ id: "actor" })); expect(runAdmissionService.pending("flow")).toBeNull();
});


test("Start forwards the exact draft revision without a separate publication request", async () => {
  const start_revision = { baseVersion: 2, baseHash: `sha256:${"a".repeat(64)}` };
  apiClient.get.mockResolvedValueOnce(wrap({ can_attempt_run: true, operation_job_admission: "operation-job/v1", version: 2, contentHash: start_revision.baseHash, start_revision }));
  await runAdmissionService.admit("flow", { customer_name: "Reviewed customer" });
  expect(apiClient.post).toHaveBeenCalledTimes(1);
  expect(apiClient.post.mock.calls[0][0]).toBe("/workflows/flow/run");
  expect(apiClient.post.mock.calls[0][1]).toMatchObject({ startRevision: start_revision, input: { customer_name: "Reviewed customer" } });
});

test("changed draft revision cannot submit previously reviewed inputs", async () => {
  const startRevision = { baseVersion: 1, baseHash: `sha256:${"a".repeat(64)}` };
  apiClient.get.mockResolvedValueOnce(wrap({ can_attempt_run: true, operation_job_admission: "operation-job/v1", version: 2, contentHash: `sha256:${"b".repeat(64)}` }));
  await expect(runAdmissionService.admit("flow", {}, { startRevision })).rejects.toThrow("saved workflow changed");
  expect(apiClient.post).not.toHaveBeenCalled();
});


test("a stale readiness flag does not prevent server validation on Start", async () => {
  const baseHash = `sha256:${"c".repeat(64)}`;
  apiClient.get.mockResolvedValueOnce(wrap({ can_attempt_run: false, version: 4, contentHash: baseHash, operation_job_admission: "operation-job/v1" }));
  await runAdmissionService.admit("flow", { customer_name: "New customer" });
  expect(apiClient.post).toHaveBeenCalledTimes(1);
  expect(apiClient.post.mock.calls[0][1]).toMatchObject({ startRevision: { baseVersion: 4, baseHash }, input: { customer_name: "New customer" } });
});
