import { expect, test, vi } from "vitest";
import { scheduledWorkPending, scheduledInvocationNeeded } from "../src/firebase/scheduled-maintenance.js";
import type { RepositoryState } from "../src/repository/store.js";
import type { AppConfig } from "../src/config/config.js";

const at = Date.parse("2026-10-18T09:00:00Z");
const state = (values: Record<string, unknown> = {}) => ({ schedules: {}, scheduleOccurrences: {}, executions: {}, readJobs: {}, chatOperations: {}, ...values }) as unknown as RepositoryState;

test("idle/future schedules and future approvals do not request a namespace writer", () => {
  expect(scheduledWorkPending(state(), "lifecycle", at)).toBe(false);
  expect(scheduledWorkPending(state({ schedules: { a: { state: "ACTIVE", nextRunAt: "2026-10-19T09:00:00Z" }, b: { state: "PAUSED", nextRunAt: "2026-10-17T09:00:00Z" } },
    executions: { run: { status: "AWAITING_APPROVAL", operationSecret: { state: "WAITING" }, runtimeApprovalSecret: { activeId: "one", records: { one: { expiresAt: "2026-10-18T10:00:00Z" } } } } } }), "lifecycle", at)).toBe(false);
});
test("due occurrences, incomplete admission and approval expiry preserve lifecycle work", () => {
  expect(scheduledWorkPending(state({ schedules: { a: { state: "ACTIVE", nextRunAt: "2026-10-18T09:00:00Z" } } }), "lifecycle", at)).toBe(true);
  expect(scheduledWorkPending(state({ scheduleOccurrences: { a: { state: "ADMITTING" } } }), "lifecycle", at)).toBe(true);
  expect(scheduledWorkPending(state({ executions: { run: { status: "AWAITING_APPROVAL", operationSecret: { state: "WAITING" }, runtimeApprovalSecret: { activeId: "one", records: { one: { expiresAt: "2026-10-18T08:59:00Z" } } } } } }), "lifecycle", at)).toBe(true);
});
test.each(["read", "chat", "readback", "operation"])("pending %s delivery is recovered but acknowledged delivery is not resubmitted", kind => {
  const make = (dispatchState: string) => {
    const dispatch = { state: dispatchState };
    if (kind === "read") return state({ executions: { run: { status: "PENDING" } }, readJobs: { a: { state: "QUEUED", executionId: "run", taskDispatchSecret: dispatch } } });
    if (kind === "chat") return state({ chatOperations: { a: { status: "QUEUED", taskDispatchSecret: dispatch } } });
    if (kind === "readback") return state({ executions: { run: { operationSecret: { readbacks: { a: { state: "QUEUED", taskDispatchSecret: dispatch } } } } } });
    return state({ executions: { run: { status: "PENDING", operationSecret: { state: "QUEUED", taskDispatchSecret: { generations: [dispatch] } } } } });
  };
  expect(scheduledWorkPending(make("PREPARED"), "dispatch", at)).toBe(true);
  expect(scheduledWorkPending(make("INTENT"), "dispatch", at)).toBe(true);
  expect(scheduledWorkPending(make("ENQUEUED"), "dispatch", at)).toBe(false);
});
test("read-only preflight releases its reader and propagates storage failures for the normal scheduler retry", async () => {
  const config = { storageDriver: "firestore-records" } as AppConfig;
  const reader = { snapshot: vi.fn(async () => state()), close: vi.fn(async () => {}) }, open = vi.fn(() => reader);
  expect(await scheduledInvocationNeeded(config, "dispatch", open)).toBe(false);
  expect(reader.close).toHaveBeenCalledTimes(1);
  reader.snapshot.mockRejectedValueOnce(new Error("unavailable"));
  await expect(scheduledInvocationNeeded(config, "lifecycle", open)).rejects.toThrow("unavailable");
  expect(reader.close).toHaveBeenCalledTimes(2);
});
