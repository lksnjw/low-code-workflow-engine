import { afterEach, expect, test } from "vitest";
import { stringify } from "yaml";
import { workflowLifecycleFixture } from "./fixtures/workflow-lifecycle.js";
import { TaskRecords } from "./fixtures/bounded-read-task.js";
import { configureReadTaskDispatch, type ReadTaskCommand } from "../src/runner/read-task-outbox.js";
import { readJobQueue } from "../src/runner/read-jobs.js";
import { advanceWorkflowLifecycle } from "../src/runner/workflow-lifecycle.js";
import { exactBridgeName } from "../src/tools/erpbridge-contract.js";
import { splitFirestoreState, assembleFirestoreState } from "../src/storage/firestore-record-layout.js";
import { chatSchedulePlan } from "../src/agent/chat-scheduling.js";
import jwt from "jsonwebtoken";

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => { await Promise.all(closers.splice(0).reverse().map(close => close())); });
async function setup(records?: TaskRecords) {
  const s = await workflowLifecycleFixture(records ? { records } : {}); closers.push(s.close);
  const reads: ReadTaskCommand[] = [];
  configureReadTaskDispatch(s.repository, { timeoutMs: 1000, enqueue: async command => { reads.push(structuredClone(command)); return { taskId: command.taskId, outcome: "CREATED" }; } });
  s.sdk.callTool.mockImplementation(async (name, args) => {
    if (name !== exactBridgeName(s.target)) throw new Error("Snapshot must not invoke the effect fixture");
    return { content: [], structuredContent: { value: args.value, state: "ABSENT", settled: true, observedAt: new Date().toISOString() } };
  });
  if (!(await s.repository.read(state => state.workflows.snapshot))) {
    const yaml = stringify({ name: "Twelve-step read snapshot", description: "Twelve bounded synthetic reference reads without effects or date-range claims", trigger: { type: "manual" }, steps: Array.from({ length: 12 }, (_, index) => ({
      id: `read_${index}`, action: s.target.name, parameters: { value: `record-${index}` } })) });
    const created = await s.request("POST", "/api/workflows", { yaml }); expect(created.statusCode, created.body).toBe(201);
    const createdId = created.json().data.id;
    await s.repository.mutate(state => { state.workflows.snapshot = { ...state.workflows[createdId]!, id: "snapshot" }; state.versions.snapshot = []; delete state.workflows[createdId]; delete state.versions[createdId]; });
    const published = await s.request("POST", "/api/workflows/snapshot/publish", {}); expect(published.statusCode, published.body).toBe(200);
  }
  s.sdk.callTool.mockClear();
  const save = (overrides: Record<string, unknown> = {}) => s.save("snapshot", { profile: "workflow-snapshot-schedule-command/v1", cadence: "daily",
    reportingPeriod: "snapshot", reportWindowBinding: null, input: {}, ...overrides });
  return { ...s, reads, saveSnapshot: save, readQueue: readJobQueue(s.services) };
}

test.each(["daily", "weekly", "monthly"])("%s snapshot schedules a twelve-read task without inventing report coverage or effects", async cadence => {
  const s = await setup();
  const saved = await s.saveSnapshot({ cadence, ...(cadence === "weekly" ? { dayOfWeek: 1 } : cadence === "monthly" ? { dayOfMonth: 1 } : {}) });
  expect(saved.statusCode, saved.body).toBe(200); expect(saved.json().data.profile).toBe("workflow-snapshot-schedule/v1");
  const nowMs = Date.parse(saved.json().data.nextRunAt);
  expect((await advanceWorkflowLifecycle(s.services, { nowMs })).admitted).toBe(1);
  expect(s.reads).toHaveLength(1); expect(s.sent).toHaveLength(0); expect(s.sdk.callTool).not.toHaveBeenCalled();
  expect((await advanceWorkflowLifecycle(s.services, { nowMs })).admitted).toBe(0); expect(s.reads).toHaveLength(1);
  const occurrence = Object.values((await s.repository.snapshot()).scheduleOccurrences)[0]!;
  expect(occurrence.reportWindow).toBeUndefined();
  await s.readQueue.executeTask(s.reads[0], { timeoutMs: 3000 });
  const run = (await s.repository.snapshot()).executions[s.reads[0]!.executionId]!;
  expect(run.status).toBe("DONE"); expect(Object.keys(run.stepOutputs ?? {})).toHaveLength(12); expect(s.sdk.callTool).toHaveBeenCalledTimes(12);
  expect(run.scheduleSource).toBeUndefined(); expect(run.snapshotScheduleSource).toMatchObject({ occurrenceId: occurrence.id });
  const restored = assembleFirestoreState(splitFirestoreState(await s.repository.snapshot()));
  expect(restored.executions[run.id]!.snapshotScheduleSource).toEqual(run.snapshotScheduleSource);
});

test.each(["publication", "principal", "pause", "archive"])("snapshot %s changes cannot dispatch a scheduled task", async reason => {
  const s = await setup(), saved = await s.saveSnapshot(); expect(saved.statusCode, saved.body).toBe(200);
  await s.repository.mutate(state => {
    if (reason === "publication") state.workflows.snapshot!.yaml += "\n# changed";
    if (reason === "principal") state.users.requester!.status = "Suspended";
    if (reason === "pause") { state.schedules["schedule-snapshot"]!.state = "PAUSED"; state.schedules["schedule-snapshot"]!.nextRunAt = null; }
    if (reason === "archive") state.workflows.snapshot!.archived = true;
  });
  expect((await advanceWorkflowLifecycle(s.services, { nowMs: Date.parse(saved.json().data.nextRunAt) })).admitted).toBe(0);
  expect(s.reads).toHaveLength(0); expect(s.sdk.callTool).not.toHaveBeenCalled();
});

test("the snapshot profile cannot downgrade a write workflow or invent a reporting window", async () => {
  const s = await setup();
  const effect = await s.save("scheduled", { profile: "workflow-snapshot-schedule-command/v1", cadence: "daily", reportingPeriod: "snapshot", reportWindowBinding: null });
  expect(effect.statusCode).toBe(422);
  expect((await s.saveSnapshot({ reportWindowBinding: { profile: "workflow-report-window-input-binding/v1", startAtInput: "start", endAtInput: "end" } })).statusCode).toBe(422);
  expect((await s.saveSnapshot({ cadence: "weekly" })).statusCode).toBe(422);
  expect((await s.saveSnapshot({ cadence: "monthly", dayOfMonth: 31 })).statusCode).toBe(422);
  expect(s.reads).toHaveLength(0); expect(s.sdk.callTool).not.toHaveBeenCalled();
});

test.each([false, true])("snapshot recovers the original occurrence after a lost link acknowledgement committed=%s", async committed => {
  const records = new TaskRecords(), a = await setup(records), saved = await a.saveSnapshot(); expect(saved.statusCode, saved.body).toBe(200);
  const nowMs = Date.parse(saved.json().data.nextRunAt);
  records.commitBeforeFailure = committed; records.failWhen = state => Object.values(state.scheduleOccurrences).some(value => value.state === "ADMITTED");
  await expect(advanceWorkflowLifecycle(a.services, { nowMs })).rejects.toThrow(); expect(a.reads).toHaveLength(1);
  const original = a.reads[0]!; await a.close();
  const b = await setup(records); await advanceWorkflowLifecycle(b.services, { nowMs });
  const state = await b.repository.snapshot();
  expect(Object.values(state.scheduleOccurrences)[0]).toMatchObject({ state: "ADMITTED", executionId: original.executionId });
  expect(Object.values(state.executions).filter(run => run.snapshotScheduleSource)).toHaveLength(1);
  expect(b.reads).toHaveLength(0); expect(b.sdk.callTool).not.toHaveBeenCalled();
});

test("changing a queued snapshot's immutable source fails before any read", async () => {
  const s = await setup(), saved = await s.saveSnapshot();
  await advanceWorkflowLifecycle(s.services, { nowMs: Date.parse(saved.json().data.nextRunAt) });
  const command = s.reads[0]!;
  await s.repository.mutateExecution(command.executionId, state => { state.executions[command.executionId]!.snapshotScheduleSource!.scheduleHash = `sha256:${"0".repeat(64)}`; });
  await s.readQueue.executeTask(command, { timeoutMs: 3000 });
  expect((await s.repository.snapshot()).executions[command.executionId]!.status).toBe("FAILED");
  expect(s.sdk.callTool).not.toHaveBeenCalled();
});

test("chat derives a snapshot command from its reviewed publication without date inputs", async () => {
  const s = await setup(), actor = (await s.repository.effectiveUser("requester"))!;
  await s.repository.mutate(state => { state.chats.snapshotChat = { id: "snapshotChat", ownerId: actor.id, title: "Snapshot", messages: [], messageCount: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }; });
  const plan = await s.repository.readAuthoritative(state => chatSchedulePlan(state, s.services, actor, "snapshotChat", { workflowId: "snapshot" }, {
    intent: "WORKFLOW_CONTROL", needsClarification: false, workflowControl: "schedule", source: "agent", toolsDispatched: false,
    scheduleSuggestion: { cadence: "daily", localTime: "09:00", timezone: "Asia/Colombo" } }));
  expect(plan.command).toMatchObject({ profile: "workflow-snapshot-schedule-command/v1", reportingPeriod: "snapshot", reportWindowBinding: null, servicePrincipalId: actor.id });
  expect(s.reads).toHaveLength(0); expect(s.sdk.callTool).not.toHaveBeenCalled();
});

test("native map key reordering does not invalidate a genuine snapshot receipt", async () => {
  const s = await setup(), saved = await s.saveSnapshot();
  await advanceWorkflowLifecycle(s.services, { nowMs: Date.parse(saved.json().data.nextRunAt) });
  const command = s.reads[0]!;
  await s.repository.mutateExecution(command.executionId, state => {
    const run = state.executions[command.executionId]!;
    run.snapshotScheduleSource = Object.fromEntries(Object.entries(run.snapshotScheduleSource!).sort(([a], [b]) => a.localeCompare(b))) as NonNullable<typeof run.snapshotScheduleSource>;
  });
  await s.readQueue.executeTask(command, { timeoutMs: 3000 });
  expect((await s.repository.snapshot()).executions[command.executionId]!.status).toBe("DONE");
  expect(s.sdk.callTool).toHaveBeenCalledTimes(12);
});

test.each([false, true])("a Manager cannot schedule an inaccessible workflow or impersonate its administrator, assigned=%s", async assigned => {
  const s = await setup();
  await s.repository.mutate(state => {
    state.roles.snapshotManager = { id: "snapshotManager", name: "Manager", description: "Own work only", permissions: ["workflow:write", "workflow:read_own", "workflow:run_own"], createdAt: new Date().toISOString() };
    state.users.snapshotManager = { ...state.users.requester!, id: "snapshotManager", roleId: "snapshotManager" };
    if (assigned) state.workflows.snapshot!.assignedUserIds = ["snapshotManager"];
  });
  const command = await s.command("snapshot", { profile: "workflow-snapshot-schedule-command/v1", cadence: "daily", reportingPeriod: "snapshot", reportWindowBinding: null });
  const response = await s.app.inject({ method: "PUT", url: "/api/workflows/snapshot/schedule", payload: command,
    headers: { authorization: `Bearer ${jwt.sign({}, s.services.config.jwtSecret, { subject: "snapshotManager", expiresIn: 3600 })}` } });
  expect(response.statusCode, response.body).toBe(403); expect(s.reads).toHaveLength(0); expect(s.sdk.callTool).not.toHaveBeenCalled();
});
