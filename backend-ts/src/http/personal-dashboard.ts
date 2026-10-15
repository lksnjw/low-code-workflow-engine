import type { RepositoryState } from "../repository/store.js";
import type { CurrentUser } from "./handlers/common.js";
import { canReadExecution } from "./execution-scope.js";
import { canViewWorkflow } from "../workflows/commands.js";

export const dashboardActiveStatuses = new Set(["PENDING", "RUNNING", "HEALING"]);
export const dashboardAttentionStatuses = new Set(["AWAITING_APPROVAL", "RECOVERY_REQUIRED", "RECONCILIATION_REQUIRED", "UNKNOWN"]);
type Task = { id: string; kind: "run" | "schedule" | "occurrence"; name: string; status: string; at: string | null; date: string | null;
  workflowId: string | null; executionId: string | null; important: boolean; cadence?: string; scheduleTimezone?: string };

/** Read-only personal projection, never inputs, model text, receipts or authority.
 * Counts precede clipping; a visible execution replaces its occurrence marker. */
export function personalDashboard(state: Readonly<RepositoryState>, user: CurrentUser, month: string, timezone: string, now = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
  const day = (at: string | null) => {
    if (!at || !Number.isFinite(Date.parse(at))) return null;
    const parts = formatter.formatToParts(new Date(at)), part = (type: string) => parts.find(value => value.type === type)!.value;
    return `${part("year")}-${part("month")}-${part("day")}`;
  };
  const today = day(now.toISOString())!, events: Task[] = [], ongoing: Task[] = [], attention: Task[] = [], visibleRuns = new Set<string>();
  let todayTotal = 0, completedToday = 0;
  const record = (task: Task) => {
    if (task.date === today) todayTotal++;
    if (task.date?.startsWith(month)) events.push(task);
  };
  const canReadRuns = user.permissions.some(value => ["workflow:read", "execution:read_own"].includes(value));
  const canReadWorkflows = user.permissions.some(value => ["workflow:read", "workflow:read_own"].includes(value));
  for (const run of Object.values(state.executions)) {
    if (!canReadRuns || run.startedBy.id !== user.id || !canReadExecution(user, run)) continue;
    visibleRuns.add(run.id);
    const workflow = state.workflows[run.workflowId], task: Task = {
      id: `run:${run.id}`, kind: "run", name: run.workflowName, status: run.status,
      at: run.scheduleSource?.scheduledFor ?? run.snapshotScheduleSource?.scheduledFor ?? run.startedAt, date: day(run.scheduleSource?.scheduledFor ?? run.snapshotScheduleSource?.scheduledFor ?? run.startedAt),
      workflowId: canReadWorkflows && workflow && canViewWorkflow(workflow, user) ? workflow.id : null, executionId: run.id,
      important: dashboardAttentionStatuses.has(run.status) || run.status === "FAILED",
    };
    record(task);
    if (["DONE", "SUCCEEDED"].includes(run.status) && day(run.completedAt) === today) completedToday++;
    if (dashboardActiveStatuses.has(run.status)) ongoing.push(task);
    if (dashboardAttentionStatuses.has(run.status)) attention.push(task);
  }
  const visibleSchedules = new Map<string, { name: string; workflowId: string }>();
  const claimedDates = new Set(Object.values(state.scheduleOccurrences).map(value => JSON.stringify([value.scheduleId, value.scheduleRevision, value.scheduledFor])));
  for (const schedule of Object.values(state.schedules)) {
    const workflow = state.workflows[schedule.workflowId];
    if (!canReadWorkflows || !workflow || !canViewWorkflow(workflow, user) || !(workflow.owner.id === user.id || workflow.assignedUserIds?.includes(user.id) ||
        schedule.servicePrincipalId === user.id || schedule.createdBy.id === user.id)) continue;
    visibleSchedules.set(schedule.id, { name: workflow.name, workflowId: workflow.id });
    const task: Task = { id: `schedule:${schedule.id}`, kind: "schedule", name: workflow.name, status: schedule.state,
      at: schedule.state === "ACTIVE" ? schedule.nextRunAt : null, date: schedule.state === "ACTIVE" ? day(schedule.nextRunAt) : null,
      workflowId: workflow.id, executionId: null, important: schedule.state === "BLOCKED" || schedule.state === "ACTIVE" && !!schedule.nextRunAt && Date.parse(schedule.nextRunAt) < now.getTime(),
      cadence: schedule.cadence ?? "daily", scheduleTimezone: schedule.timezone };
    if (!claimedDates.has(JSON.stringify([schedule.id, schedule.revision, schedule.nextRunAt]))) record(task);
    if (schedule.state === "BLOCKED") attention.push(task);
  }
  for (const occurrence of Object.values(state.scheduleOccurrences)) {
    const schedule = visibleSchedules.get(occurrence.scheduleId);
    if (!schedule || occurrence.executionId && visibleRuns.has(occurrence.executionId)) continue;
    const date = day(occurrence.scheduledFor);
    record({ id: `occurrence:${occurrence.id}`, kind: "occurrence", name: schedule.name, status: occurrence.state, at: occurrence.scheduledFor, date,
      workflowId: schedule.workflowId, executionId: null, important: occurrence.state === "BLOCKED" });
  }
  const dayCounts: Record<string, { total: number; important: number }> = {};
  for (const task of events) {
    const counts = dayCounts[task.date!] ??= { total: 0, important: 0 }; counts.total++; if (task.important) counts.important++;
  }
  const sorted = (tasks: Task[]) => tasks.sort((a, b) => Number(b.important) - Number(a.important) || (a.at ?? "").localeCompare(b.at ?? "") || a.id.localeCompare(b.id));
  return { profile: "personal-task-dashboard/v1", scope: "personal", generatedAt: now.toISOString(), month, timezone, today,
    counts: { today: todayTotal, ongoing: ongoing.length, attention: attention.length, completedToday },
    dayCounts, events: sorted(events).slice(0, 500), ongoing: sorted(ongoing).slice(0, 100), attention: sorted(attention).slice(0, 100),
    truncated: events.length > 500 || ongoing.length > 100 || attention.length > 100 };
}
