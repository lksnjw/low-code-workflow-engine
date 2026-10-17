import { afterEach, expect, test, vi } from "vitest";
import { stringify } from "yaml";
import { workflowLifecycleFixture } from "./fixtures/workflow-lifecycle.js";
import { advanceWorkflowLifecycle } from "../src/runner/workflow-lifecycle.js";
import { exactBridgeName } from "../src/tools/erpbridge-contract.js";
import { executionReviewInbox } from "../src/runner/execution-review-inbox.js";
import { splitFirestoreState, assembleFirestoreState } from "../src/storage/firestore-record-layout.js";
import { runtimeApprovalAdministration, updateRuntimeApprovalPolicy } from "../src/runner/runtime-approvals.js";

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => { await Promise.all(closers.splice(0).reverse().map(close => close())); vi.restoreAllMocks(); });
async function setup() {
  const s = await workflowLifecycleFixture(); closers.push(s.close);
  const previous = s.sdk.callTool.getMockImplementation()!;
  s.sdk.callTool.mockImplementation(async (name, args) => name === exactBridgeName(s.target) ? { content: [], structuredContent: {
    value: args.value, state: "ABSENT", settled: true, observedAt: new Date().toISOString() } } : previous(name, args));
  const steps = [{ id: "covered_report", action: s.report.name, description: "Read the complete reviewed reporting window",
    parameters: { startAt: "{{input.reportStartAt}}", endAt: "{{input.reportEndAt}}" } },
    ...Array.from({ length: 8 }, (_, index) => ({ id: `check_${index + 1}`, action: s.target.name,
      description: `Read local verification status ${index + 1}`, parameters: { value: `verification-${index + 1}` } })),
    { id: "reviewed_receipt", action: s.effect.name, description: "Synthetic local receipt; independent human approval required", parameters: { value: "{{covered_report.structuredContent.summary}}" } }];
  const yaml = stringify({ name: "Local ten-node scheduled review", description: "Synthetic local lifecycle scenario, no hosted tools or real messages", trigger: { type: "manual", config: {
    inputSchema: { type: "object", properties: { reportStartAt: { type: "string" }, reportEndAt: { type: "string" } }, required: ["reportStartAt", "reportEndAt"], additionalProperties: false } } }, steps });
  const created = await s.request("POST", "/api/workflows", { yaml }); expect(created.statusCode, created.body).toBe(201);
  const id = created.json().data.id;
  const published = await s.request("POST", `/api/workflows/${id}/publish`, {}); expect(published.statusCode, published.body).toBe(200);
  expect(steps).toHaveLength(10); s.sdk.callTool.mockClear(); s.sent.length = 0;
  return { ...s, tenId: id };
}

test.each(["daily", "weekly", "monthly"])("local 10-node %s occurrence pauses after 9 reads, refuses self-approval, then completes one synthetic effect", async cadence => {
  const s = await setup();
  const saved = await s.save(s.tenId, { profile: "workflow-calendar-schedule-command/v2", cadence,
    reportingPeriod: `previous-calendar-${cadence === "daily" ? "day" : cadence === "weekly" ? "week" : "month"}`,
    ...(cadence === "weekly" ? { dayOfWeek: 1 } : cadence === "monthly" ? { dayOfMonth: 1 } : {}) });
  expect(saved.statusCode, saved.body).toBe(200); const nowMs = Date.parse(saved.json().data.nextRunAt);
  expect((await advanceWorkflowLifecycle(s.services, { nowMs })).admitted).toBe(1);
  expect(s.sdk.callTool).not.toHaveBeenCalled();
  expect((await advanceWorkflowLifecycle(s.services, { nowMs })).admitted).toBe(0);
  expect(s.sent).toHaveLength(1);
  const run = s.sent[0]!; await s.queue.executeTask(run, { timeoutMs: 3000 });
  const waiting = (await s.repository.snapshot()).executions[run.executionId]!;
  expect(waiting.status).toBe("AWAITING_APPROVAL"); expect(Object.keys(waiting.stepOutputs ?? {})).toHaveLength(9);
  expect(s.sdk.callTool).toHaveBeenCalledTimes(9);
  const reviewer = (await s.repository.effectiveUser("reviewer"))!;
  const restored = assembleFirestoreState(splitFirestoreState(await s.repository.snapshot()));
  const morningQueue = executionReviewInbox(restored, reviewer, { kind: "approval", state: "open" }, s.services.config.jwtSecret, s.services);
  expect(morningQueue.items).toContainEqual(expect.objectContaining({ executionId: run.executionId, nodeId: "reviewed_receipt", scheduledFor: waiting.scheduleSource!.scheduledFor, actionable: true }));
  const command = await s.approvalCommand(run.executionId, `ten-node-${cadence}-approval-001`);
  expect((await s.approve(run.executionId, command, "requester")).statusCode).toBe(403);
  expect((await s.approve(run.executionId, command)).statusCode).toBe(200);
  await s.queue.executeTask(s.sent[1]!, { timeoutMs: 3000 });
  expect((await s.repository.snapshot()).executions[run.executionId]!.status).toBe("DONE");
  expect(s.sdk.callTool).toHaveBeenCalledTimes(10);
});

test("an overnight scheduled checkpoint survives the record layout and remains reviewable eight hours later within a configured 24-hour validity", async () => {
  const s = await setup(), admin = (await s.repository.effectiveUser("requester"))!;
  await s.repository.mutate(state => {
    const administration = runtimeApprovalAdministration(state, admin);
    updateRuntimeApprovalPolicy(state, admin, { profile: "runtime-approval-policy/v1", baseRevision: administration.revision, enabled: true, approverRoleIds: administration.policy!.approverRoleIds, ttlSeconds: 86400, separationOfDuties: true });
  });
  const saved = await s.save(s.tenId); expect(saved.statusCode, saved.body).toBe(200);
  await advanceWorkflowLifecycle(s.services, { nowMs: Date.parse(saved.json().data.nextRunAt) });
  const command = s.sent[0]!; await s.queue.executeTask(command, { timeoutMs: 3000 });
  const snapshot = await s.repository.snapshot(), restored = assembleFirestoreState(splitFirestoreState(snapshot));
  const reviewer = (await s.repository.effectiveUser("reviewer"))!;
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.now() + 8 * 3600000);
  try {
    const inbox = executionReviewInbox(restored, reviewer, { kind: "approval", state: "open" }, s.services.config.jwtSecret, s.services);
    expect(inbox.items).toContainEqual(expect.objectContaining({ executionId: command.executionId, nodeId: "reviewed_receipt", actionable: true, statusLabel: "Awaiting decision" }));
    expect(restored.executions[command.executionId]!.status).toBe("AWAITING_APPROVAL");
    expect(s.sdk.callTool).toHaveBeenCalledTimes(9); expect(s.sent).toHaveLength(1);
    const approval = await s.approvalCommand(command.executionId, "overnight-review-decision-0001");
    const acknowledged = await s.approve(command.executionId, approval);
    expect(acknowledged.statusCode, acknowledged.body).toBe(200);
    await s.queue.executeTask(s.sent[1]!, { timeoutMs: 3000 });
    expect((await s.repository.snapshot()).executions[command.executionId]!.status).toBe("DONE");
    expect(s.sdk.callTool).toHaveBeenCalledTimes(10); // Nine earlier reads were not replayed.
  } finally { vi.useRealTimers(); }
});

test("pausing a local ten-node schedule prevents its due occurrence from being admitted", async () => {
  const s = await setup(), saved = await s.save(s.tenId); expect(saved.statusCode, saved.body).toBe(200);
  const nowMs = Date.parse(saved.json().data.nextRunAt);
  const paused = await s.save(s.tenId, { enabled: false }); expect(paused.statusCode, paused.body).toBe(200);
  expect((await advanceWorkflowLifecycle(s.services, { nowMs })).admitted).toBe(0);
  expect(s.sdk.callTool).not.toHaveBeenCalled(); expect(s.sent).toHaveLength(0);
});

test("rejecting the local scheduled receipt leaves the ninth read as the last dispatched tool", async () => {
  const s = await setup(), saved = await s.save(s.tenId); expect(saved.statusCode, saved.body).toBe(200);
  await advanceWorkflowLifecycle(s.services, { nowMs: Date.parse(saved.json().data.nextRunAt) });
  const run = s.sent[0]!; await s.queue.executeTask(run, { timeoutMs: 3000 });
  const decision = await s.approvalCommand(run.executionId, "ten-node-rejected-approval-001");
  const rejected = await s.request("POST", `/api/executions/${run.executionId}/reject`, decision, "reviewer");
  expect(rejected.statusCode, rejected.body).toBe(200); expect(s.sdk.callTool).toHaveBeenCalledTimes(9);
  expect(s.sent).toHaveLength(1);
  expect((await s.approve(run.executionId, decision)).statusCode).toBe(409);
  expect(s.sdk.callTool).toHaveBeenCalledTimes(9);
});
