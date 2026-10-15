import { expect, test } from "vitest";
import { initialState, effectiveUserFromState, type Execution } from "../src/repository/store.js";
import { workflowContentHash } from "../src/parser/workflow.js";
import { assertExecutionRetry, executionRetryView, canReviewStoppedRunForNewRun } from "../src/runner/execution-retry.js";
import type { Workflow } from "../src/models/schemas.js";

function fixture(operation = false) {
  const state = initialState(), timestamp = "2026-10-14T06:00:00Z";
  state.users.owner = { id: "owner", email: "owner@example.test", name: "Owner", roleId: "role_admin", permissionOverrides: [], status: "Active", initials: "QA", departmentId: null, lastLoginAt: null, createdAt: timestamp };
  const user = effectiveUserFromState(state, "owner")!;
  const yaml = "name: Retry test\ntrigger:\n  type: manual\nsteps:\n  - id: lookup\n    action: demo.read\n    parameters: {}\n";
  const workflow: Workflow = { id: "wf", name: "Retry test", description: "", status: "PENDING", trigger: { type: "manual" }, steps: 1, tags: [], domainTags: [], successRate: 0, lastRunAt: null, createdAt: timestamp, updatedAt: timestamp,
    yaml, archived: false, publishedVersion: 1, draftVersion: 1, owner: { id: user.id, name: user.name }, assignedUserIds: [], canRun: true };
  state.workflows.wf = workflow;
  const receipt = { sourceHash: workflowContentHash(yaml) };
  state.versions.wf = [{ id: "ver", workflowId: "wf", version: 1, artifactState: "PUBLISHED", yaml,
    compiledRead: { receipt }, compiledOperation: { receipt, plan: { ir: { root: { nodes: [{ id: "lookup", kind: "action", effectClass: "read" }, { id: "model", kind: "analysis" }, { id: "write", kind: "action", effectClass: "write" }] } } } } }];
  const source = { id: "old", workflowId: "wf", workflowName: workflow.name, status: "FAILED", startedBy: workflow.owner, startedAt: timestamp,
    workflowSnapshot: { yaml, version: 1, contentHash: workflowContentHash(yaml), registryHash: "registry", input: { recordId: "EMP-QA-1042" }, executionProfile: operation ? "sequential-operation-v1" : "sequential-read-v1", ...(operation ? { operationCompilation: receipt } : { compilation: receipt }) },
    readProgress: { profile: "read-progress-v1", attempts: {} },
    ...(operation ? { operationSecret: { profile: "operation-job/v1", intents: {} } } : {}) } as unknown as Execution;
  state.executions.old = source;
  return { state, user, workflow, source };
}
const request = { sourceExecutionId: "old", acknowledgeUnconfirmed: false };

test("a proven pre-dispatch stop can be reviewed for a new publication, not resumed or silently retried", () => {
  const { state, user, workflow, source } = fixture(true);
  source.status = "RECOVERY_REQUIRED"; source.completedAt = "2026-10-14T06:10:00Z";
  workflow.publishedVersion = 2;
  expect(executionRetryView(state, user, source)).toMatchObject({ allowed: false, canReviewForNewRun: true });
  expect(() => assertExecutionRetry(state, workflow, user, request)).toThrow("publication changed");
  source.operationSecret!.intents.write = { id: "intent", nodeId: "write", state: "UNKNOWN" } as never;
  expect(canReviewStoppedRunForNewRun(state, user, source)).toBe(false);
  source.operationSecret!.intents = {};
  source.readProgress!.attempts.model = { id: "model", status: "UNKNOWN" } as never;
  expect(canReviewStoppedRunForNewRun(state, user, source)).toBe(false);
  source.readProgress!.attempts = {};
  source.runtimeApprovalSecret = { profile: "runtime-approvals/v1", activeId: "a", records: { a: { state: "CONSUMED" } } } as never;
  expect(canReviewStoppedRunForNewRun(state, user, source)).toBe(false);
});
test("safe failed read restarts with original inputs and lineage without mutating the failed run", () => {
  const { state, user, workflow, source } = fixture(); const before = structuredClone(source);
  expect(executionRetryView(state, user, source).allowed).toBe(true);
  const result = assertExecutionRetry(state, workflow, user, request);
  expect(result.input).toEqual({ recordId: "EMP-QA-1042" }); expect(result.link.sourceExecutionId).toBe("old"); expect(source).toEqual(before);
  expect(() => assertExecutionRetry(state, workflow, user, request, { recordId: "another-person" })).toThrow("Retry inputs must match");
});
test("unknown analysis/read result requires explicit acknowledgement, but no old invocation is resumed", () => {
  const { state, user, workflow, source } = fixture(true); source.status = "RECOVERY_REQUIRED";
  source.operationSecret!.intents.model = { id: "intent", nodeId: "model", invocationId: "attempt", operationKey: "old:model", argumentHash: "hash", dispatchKind: "analysis", state: "UNKNOWN", preparedAt: source.startedAt };
  expect(executionRetryView(state, user, source)).toMatchObject({ allowed: true, requiresUncertaintyAcknowledgement: true });
  expect(() => assertExecutionRetry(state, workflow, user, request)).toThrow("Confirm that the old read/model");
  expect(assertExecutionRetry(state, workflow, user, { ...request, acknowledgeUnconfirmed: true }).link.acknowledgedUnconfirmedReads).toBe(true);
});
test("historical untagged analysis intent is classified from its original compiled node", () => {
  const { state, user, source } = fixture(true); source.status = "RECOVERY_REQUIRED";
  source.operationSecret!.intents.model = { id: "intent", nodeId: "model", invocationId: "attempt", operationKey: "old:model", argumentHash: "hash", state: "UNKNOWN", preparedAt: source.startedAt };
  expect(executionRetryView(state, user, source)).toMatchObject({ allowed: true, requiresUncertaintyAcknowledgement: true });
});
test.each(["DISPATCH_INTENT", "ACKNOWLEDGED", "UNKNOWN"] as const)("any %s write blocks whole-workflow restart even after a later failure", outcome => {
  const { state, user, workflow, source } = fixture(true);
  source.operationSecret!.intents.write = { id: "intent", nodeId: "write", invocationId: "attempt", operationKey: "old:write", argumentHash: "hash", state: outcome, preparedAt: source.startedAt };
  expect(executionRetryView(state, user, source).allowed).toBe(false);
  expect(() => assertExecutionRetry(state, workflow, user, { ...request, acknowledgeUnconfirmed: true })).toThrow("write may already have happened");
});
test.each(["DONE", "RUNNING", "PENDING", "AWAITING_APPROVAL", "RECONCILIATION_REQUIRED", "RECONCILED", "REJECTED"])("%s cannot be restarted through Retry", status => {
  const { state, user, workflow, source } = fixture(); source.status = status;
  expect(() => assertExecutionRetry(state, workflow, user, request)).toThrow();
});
test("publication changes, revoked authority, missing classification and side-effect receipts fail closed", () => {
  const { state, user, workflow, source } = fixture(true);
  workflow.publishedVersion = 2; expect(executionRetryView(state, user, source).allowed).toBe(false); workflow.publishedVersion = 1;
  state.users.owner!.status = "Disabled"; expect(executionRetryView(state, user, source).allowed).toBe(false); state.users.owner!.status = "Active";
  state.timelines.old = [{ sideEffect: true, phase: "DISPATCH_INTENT", status: "FAILED" }];
  expect(() => assertExecutionRetry(state, workflow, user, request)).toThrow("could duplicate");
  state.timelines.old = []; delete source.workflowSnapshot!.operationCompilation;
  expect(executionRetryView(state, user, source).allowed).toBe(false);
});
