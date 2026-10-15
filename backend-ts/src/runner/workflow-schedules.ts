import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJSONBytes } from "../core/canonical-json.js";
import { HandlerFailure, type CurrentUser, type HandlerServices } from "../http/handlers/common.js";
import type { ReportWindow, ReportWindowInputBinding, Repository, RepositoryState, ScheduleOccurrence, WorkflowSchedule } from "../repository/store.js";
import { workflowContentHash } from "../parser/workflow.js";
import { isSecretField, withoutSecretFields } from "../redact/secrets.js";
import { prepareOperationExecution } from "../workflows/operation-compilation-lifecycle.js";
import { validateToolInput } from "../tools/tool-input-schema.js";
import { operationJobQueue, supportsOperationJobs } from "./operation-jobs.js";
import { canViewWorkflow } from "../workflows/commands.js";
import { isOperationToolNode, type CompiledOperationPlan, type ReadBinding } from "../workflows/compiled-read.js";
import type { ToolDefinition } from "../registry/schemas.js";
import { scheduledReportPaths } from "./scheduled-report-paths.js";
import { bindExecutionHost, residentExecutionAllowed, requireResidentExecution } from "./execution-host.js";
import { assertWorkflowLifecycleScope, requireWorkflowLifecycleAdmission, type WorkflowLifecycleScope } from "./workflow-lifecycle-host.js";
import { prepareReadSnapshot, admitReadSnapshot } from "./snapshot-schedule.js";
import { requireReadTaskAdmission } from "./read-task-outbox.js";

const digest = (value: unknown) => `sha256:${createHash("sha256").update(canonicalJSONBytes(value)).digest("hex")}`;
const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const inputName = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
const reportWindowInputBindingSchema = z.object({
  profile: z.literal("workflow-report-window-input-binding/v1"),
  startAtInput: inputName,
  endAtInput: inputName,
}).strict();
const commonScheduleCommand = {
  baseRevision: z.number().int().min(0),
  workflowVersion: z.number().int().positive(),
  workflowHash: hash,
  enabled: z.boolean(),
  timezone: z.string().trim().min(1).max(128),
  localTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  misfirePolicy: z.enum(["SKIP", "FIRE_ONCE"]),
  misfireGraceSeconds: z.number().int().min(60).max(86_400),
  servicePrincipalId: z.string().min(1).max(256),
  input: z.record(z.string(), z.unknown()),
  reportWindowBinding: reportWindowInputBindingSchema.nullable().optional(),
};
const scheduleRefinement = (value: { enabled: boolean; reportWindowBinding?: { startAtInput: string; endAtInput: string } | null | undefined }, context: z.RefinementCtx) => {
  if (value.enabled && !value.reportWindowBinding) context.addIssue({ code: "custom", path: ["reportWindowBinding"], message: "Active schedules require an exact report-window input binding" });
  if (value.reportWindowBinding?.startAtInput === value.reportWindowBinding?.endAtInput)
    context.addIssue({ code: "custom", path: ["reportWindowBinding"], message: "Report-window inputs must be distinct" });
};
export const dailyScheduleCommandSchema = z.object({
  profile: z.literal("workflow-daily-schedule-command/v1"),
  ...commonScheduleCommand,
  reportingPeriod: z.literal("previous-calendar-day"),
}).strict().superRefine(scheduleRefinement);
export const calendarScheduleCommandSchema = z.object({
  profile: z.literal("workflow-calendar-schedule-command/v2"),
  ...commonScheduleCommand,
  cadence: z.enum(["daily", "weekly", "monthly"]),
  dayOfWeek: z.number().int().min(1).max(7).optional(),
  dayOfMonth: z.number().int().min(1).max(28).optional(),
  reportingPeriod: z.enum(["previous-calendar-day", "previous-calendar-week", "previous-calendar-month"]),
}).strict().superRefine((value, context) => {
  scheduleRefinement(value, context);
  const expected = value.cadence === "daily" ? "previous-calendar-day" : value.cadence === "weekly" ? "previous-calendar-week" : "previous-calendar-month";
  if (value.reportingPeriod !== expected) context.addIssue({ code: "custom", path: ["reportingPeriod"], message: `Reporting period must match ${value.cadence} cadence` });
  if (value.cadence === "weekly" && value.dayOfWeek == null) context.addIssue({ code: "custom", path: ["dayOfWeek"], message: "Weekly schedules require an ISO weekday" });
  if (value.cadence !== "weekly" && value.dayOfWeek != null) context.addIssue({ code: "custom", path: ["dayOfWeek"], message: "Only weekly schedules may set a weekday" });
  if (value.cadence === "monthly" && value.dayOfMonth == null) context.addIssue({ code: "custom", path: ["dayOfMonth"], message: "Monthly schedules require a day from 1 through 28" });
  if (value.cadence !== "monthly" && value.dayOfMonth != null) context.addIssue({ code: "custom", path: ["dayOfMonth"], message: "Only monthly schedules may set a day of month" });
});
export const snapshotScheduleCommandSchema = z.object({
  profile: z.literal("workflow-snapshot-schedule-command/v1"), ...commonScheduleCommand,
  cadence: z.enum(["daily", "weekly", "monthly"]), dayOfWeek: z.number().int().min(1).max(7).optional(),
  dayOfMonth: z.number().int().min(1).max(28).optional(), reportingPeriod: z.literal("snapshot"),
  reportWindowBinding: z.null().optional(),
}).strict().superRefine((value, context) => {
  if ((value.cadence === "weekly") !== (value.dayOfWeek !== undefined)) context.addIssue({ code: "custom", path: ["dayOfWeek"], message: "Only weekly snapshots require an ISO weekday" });
  if ((value.cadence === "monthly") !== (value.dayOfMonth !== undefined)) context.addIssue({ code: "custom", path: ["dayOfMonth"], message: "Only monthly snapshots require a day of month" });
});
export const scheduleCommandSchema = z.union([dailyScheduleCommandSchema, calendarScheduleCommandSchema, snapshotScheduleCommandSchema]);
export type DailyScheduleCommand = z.infer<typeof dailyScheduleCommandSchema>;
export type CalendarScheduleCommand = z.infer<typeof calendarScheduleCommandSchema>;
type ScheduleCommand = z.infer<typeof scheduleCommandSchema>;
type ScheduleCadence = "daily" | "weekly" | "monthly";
type ReportingPeriod = ReportWindow["reportingPeriod"];

const formatter = (timezone: string) => {
  try { return new Intl.DateTimeFormat("en-CA-u-nu-latn", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }); }
  catch { throw new HandlerFailure(422, "Timezone must be a supported IANA timezone", { code: "SCHEDULE_TIMEZONE_INVALID" }); }
};
function localParts(timezone: string, instant: number, dateFormatter = formatter(timezone)) {
  const values = Object.fromEntries(dateFormatter.formatToParts(new Date(instant)).filter(part => part.type !== "literal").map(part => [part.type, part.value]));
  return { date: `${values.year}-${values.month}-${values.day}`, time: `${values.hour}:${values.minute}` };
}
function shiftDate(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + days)).toISOString().slice(0, 10);
}
function isoWeekday(date: string): number {
  const [year, month, day] = date.split("-").map(Number), weekday = new Date(Date.UTC(year!, month! - 1, day!)).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}
function monthStart(date: string, offset: number): string {
  const [year, month] = date.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1 + offset, 1)).toISOString().slice(0, 10);
}
function startOfLocalDate(timezone: string, date: string): string {
  const [year, month, day] = date.split("-").map(Number), center = Date.UTC(year!, month! - 1, day!);
  let low = center - 48 * 60 * 60_000, high = center + 48 * 60 * 60_000;
  while (low < high) {
    const middle = Math.floor((low + high) / 120_000) * 60_000;
    if (localParts(timezone, middle).date < date) low = middle + 60_000; else high = middle;
  }
  if (localParts(timezone, low).date !== date) throw new HandlerFailure(422, "The requested local report day does not exist in this timezone", { code: "SCHEDULE_REPORT_WINDOW_UNRESOLVED" });
  return new Date(low).toISOString();
}
export function reportWindowFor(timezone: string, scheduledFor: string, reportingPeriod: ReportingPeriod): ReportWindow {
  formatter(timezone);
  const instant = Date.parse(scheduledFor);
  if (!Number.isFinite(instant)) throw new HandlerFailure(422, "Scheduled occurrence time is invalid", { code: "SCHEDULE_REPORT_WINDOW_UNRESOLVED" });
  const occurrenceDate = localParts(timezone, instant).date;
  let localDate: string, endDate: string;
  if (reportingPeriod === "previous-calendar-day") {
    localDate = shiftDate(occurrenceDate, -1); endDate = occurrenceDate;
  } else if (reportingPeriod === "previous-calendar-week") {
    endDate = shiftDate(occurrenceDate, 1 - isoWeekday(occurrenceDate)); localDate = shiftDate(endDate, -7);
  } else if (reportingPeriod === "previous-calendar-month") {
    endDate = monthStart(occurrenceDate, 0); localDate = monthStart(occurrenceDate, -1);
  } else throw new HandlerFailure(422, "Reporting period is unsupported", { code: "SCHEDULE_REPORT_WINDOW_UNRESOLVED" });
  return { profile: "workflow-report-window/v1", reportingPeriod, timezone, localDate,
    ...(reportingPeriod === "previous-calendar-day" ? {} : { localEndDate: shiftDate(endDate, -1) }),
    startAt: startOfLocalDate(timezone, localDate), endAt: startOfLocalDate(timezone, endDate) };
}
/** Finds the first real UTC minute that represents the requested local wall
 * time. A nonexistent DST wall time is skipped; an ambiguous time chooses the
 * first occurrence after the supplied instant. */
export function nextDailyOccurrence(timezone: string, localTime: string, afterExclusive: number): string {
  return nextCalendarOccurrence({ timezone, localTime, cadence: "daily" }, afterExclusive);
}
export function nextCalendarOccurrence(schedule: { timezone: string; localTime: string; cadence: ScheduleCadence; dayOfWeek?: number; dayOfMonth?: number }, afterExclusive: number): string {
  const dateFormatter = formatter(schedule.timezone);
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(schedule.localTime) || !Number.isFinite(afterExclusive) ||
      schedule.cadence === "weekly" && (!Number.isInteger(schedule.dayOfWeek) || schedule.dayOfWeek! < 1 || schedule.dayOfWeek! > 7) ||
      schedule.cadence === "monthly" && (!Number.isInteger(schedule.dayOfMonth) || schedule.dayOfMonth! < 1 || schedule.dayOfMonth! > 28))
    throw new HandlerFailure(422, "Calendar recurrence is invalid", { code: "SCHEDULE_TIME_UNRESOLVED" });
  const firstDate = localParts(schedule.timezone, afterExclusive, dateFormatter).date;
  const days = schedule.cadence === "daily" ? 9 : schedule.cadence === "weekly" ? 16 : 70;
  for (let offset = 0; offset <= days; offset++) {
    const date = shiftDate(firstDate, offset);
    if (schedule.cadence === "weekly" && isoWeekday(date) !== schedule.dayOfWeek) continue;
    if (schedule.cadence === "monthly" && Number(date.slice(8, 10)) !== schedule.dayOfMonth) continue;
    let start: number;
    try { start = Date.parse(startOfLocalDate(schedule.timezone, date)); } catch { continue; }
    let end = Number.NaN;
    for (let next = 1; next <= 3 && !Number.isFinite(end); next++) {
      try { end = Date.parse(startOfLocalDate(schedule.timezone, shiftDate(date, next))); } catch {}
    }
    if (!Number.isFinite(end)) continue;
    let candidate = Math.max(start, Math.floor(afterExclusive / 60_000) * 60_000 + 60_000);
    for (; candidate < end; candidate += 60_000)
      if (localParts(schedule.timezone, candidate, dateFormatter).time === schedule.localTime) return new Date(candidate).toISOString();
  }
  throw new HandlerFailure(422, `No valid ${schedule.cadence} occurrence was found for this timezone and local calendar`, { code: "SCHEDULE_TIME_UNRESOLVED" });
}
function recurrence(schedule: Pick<WorkflowSchedule, "profile" | "timezone" | "localTime" | "cadence" | "dayOfWeek" | "dayOfMonth">) {
  const cadence = schedule.profile === "workflow-daily-schedule/v1" ? "daily" as const : schedule.cadence;
  if (!cadence || schedule.profile !== "workflow-daily-schedule/v1" &&
      (cadence === "weekly" ? !Number.isInteger(schedule.dayOfWeek) || schedule.dayOfWeek! < 1 || schedule.dayOfWeek! > 7 || schedule.dayOfMonth !== undefined : schedule.dayOfWeek !== undefined) ||
      schedule.profile !== "workflow-daily-schedule/v1" &&
      (cadence === "monthly" ? !Number.isInteger(schedule.dayOfMonth) || schedule.dayOfMonth! < 1 || schedule.dayOfMonth! > 28 || schedule.dayOfWeek !== undefined : schedule.dayOfMonth !== undefined))
    throw new HandlerFailure(422, "Stored calendar recurrence is invalid", { code: "SCHEDULE_TIME_UNRESOLVED" });
  return { timezone: schedule.timezone, localTime: schedule.localTime, cadence,
    ...(schedule.dayOfWeek === undefined ? {} : { dayOfWeek: schedule.dayOfWeek }), ...(schedule.dayOfMonth === undefined ? {} : { dayOfMonth: schedule.dayOfMonth }) };
}
function commandRecurrence(command: ScheduleCommand) {
  return command.profile === "workflow-daily-schedule-command/v1" ? { cadence: "daily" as const } : { cadence: command.cadence,
    ...(command.dayOfWeek == null ? {} : { dayOfWeek: command.dayOfWeek }), ...(command.dayOfMonth == null ? {} : { dayOfMonth: command.dayOfMonth }) };
}
function canRun(state: Readonly<RepositoryState>, workflowId: string, actor: CurrentUser) {
  const workflow = state.workflows[workflowId];
  return !!workflow && actor.permissions.some(permission => ["workflow:run", "workflow:run_own"].includes(permission)) &&
    (actor.permissions.includes("workflow:run") || workflow.owner.id === actor.id || (workflow.assignedUserIds ?? []).includes(actor.id));
}
function effectiveStateUser(state: Readonly<RepositoryState>, userId: string): CurrentUser | null {
  const user = state.users[userId], role = user ? state.roles[user.roleId] : undefined;
  if (!user || !role || user.status.toLowerCase() !== "active") return null;
  return { ...structuredClone(user), role: role.name, permissions: [...new Set([...role.permissions, ...user.permissionOverrides].filter(Boolean))] };
}
function publicSchedule(schedule: WorkflowSchedule | null) {
  return schedule ? withoutSecretFields({ ...schedule, reportWindowBinding: schedule.reportWindowBinding ?? null }) : null;
}
function publicOccurrence(value: ScheduleOccurrence) {
  const { idempotencyKey: _idempotencyKey, ...visible } = value;
  return withoutSecretFields({ ...visible, reportWindow: value.reportWindow ?? null });
}
function containsSecretField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSecretField);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) => isSecretField(key) || containsSecretField(child));
}
function referencesWorkflowInput(binding: ReadBinding, name: string): boolean {
  if (binding.kind === "ref") return binding.source === "workflowInput" && binding.path[0] === name;
  if (binding.kind === "template") return binding.parts.some(part => typeof part !== "string" && referencesWorkflowInput(part, name));
  if (binding.kind === "object") return Object.values(binding.fields).some(child => referencesWorkflowInput(child, name));
  if (binding.kind === "array") return binding.items.some(child => referencesWorkflowInput(child, name));
  return false;
}
function bindReportWindowInput(plan: CompiledOperationPlan, staticInput: Record<string, unknown>, binding: ReportWindowInputBinding, window: ReportWindow,
  tools: readonly ToolDefinition[]) {
  if (!reportWindowInputBindingSchema.safeParse(binding).success)
    throw new HandlerFailure(422, "Report-window input binding is malformed", { code: "SCHEDULE_REPORT_WINDOW_BINDING_INVALID" });
  const names = [binding.startAtInput, binding.endAtInput];
  if (new Set(names).size !== names.length) throw new HandlerFailure(422, "Report-window inputs must be distinct", { code: "SCHEDULE_REPORT_WINDOW_BINDING_INVALID" });
  if (names.some(name => Object.hasOwn(staticInput, name)))
    throw new HandlerFailure(422, "Server-derived report-window inputs cannot be supplied as static schedule values", { code: "SCHEDULE_REPORT_WINDOW_OVERRIDE_DENIED" });
  const schema = plan.ir.inputSchema, properties = schema?.properties as Record<string, Record<string, unknown>> | undefined;
  const values: Record<string, string> = { [binding.startAtInput]: window.startAt, [binding.endAtInput]: window.endAt };
  for (const name of names) {
    if (!properties?.[name] || properties[name]!.writeOnly || validateToolInput(properties[name], values[name]).length)
      throw new HandlerFailure(422, `Report-window input ${name} must be a declared non-sensitive string field`, { code: "SCHEDULE_REPORT_WINDOW_BINDING_INVALID" });
    if (!plan.ir.root.nodes.some(node => isOperationToolNode(node) && node.effectClass === "read" && referencesWorkflowInput(node.inputs, name)))
      throw new HandlerFailure(422, `Report-window input ${name} must be referenced by a reviewed ERP read step`, { code: "SCHEDULE_REPORT_WINDOW_BINDING_UNUSED" });
  }
  scheduledReportPaths(plan, tools, binding);
  const effective = { ...structuredClone(staticInput), ...values };
  if (!schema || validateToolInput(schema, effective).length)
    throw new HandlerFailure(422, "Schedule values plus the server-derived report window do not match the published workflow input schema", { code: "SCHEDULE_INPUT_INVALID" });
  return effective;
}

export function workflowScheduleView(state: Readonly<RepositoryState>, workflowId: string, actor: CurrentUser) {
  const workflow = state.workflows[workflowId];
  if (!workflow || !canViewWorkflow(workflow, actor))
    throw new HandlerFailure(404, "Workflow not found");
  const schedule = state.schedules[`schedule-${workflowId}`] ?? null;
  const occurrences = schedule ? Object.values(state.scheduleOccurrences).filter(item => item.scheduleId === schedule.id)
    .sort((a, b) => b.scheduledFor.localeCompare(a.scheduledFor) || b.id.localeCompare(a.id)).slice(0, 20).map(publicOccurrence) : [];
  return { profile: "workflow-schedule-view/v1", workflowId, schedule: publicSchedule(schedule), occurrences,
    canManage: actor.permissions.includes("workflow:write"), explanation: schedule?.state === "ACTIVE" ?
      "The next occurrence is durable. Each occurrence uses the named service principal and the pinned publication; effects still require fresh independent runtime approval." :
      schedule?.state === "BLOCKED" ? "The schedule is blocked. Review the recorded reason and explicitly save a new revision; no automatic dispatch is allowed." :
      "No active schedule is confirmed. Saving workflow trigger text alone does not activate recurring execution." };
}

export async function saveWorkflowSchedule(services: HandlerServices, workflowId: string, actor: CurrentUser, raw: unknown,
  commit?: { assertCurrent(state: RepositoryState): void; saved(state: RepositoryState, schedule: WorkflowSchedule): void }) {
  if (!supportsOperationJobs(services)) throw new HandlerFailure(503, "Schedules require qualified encrypted operation persistence", { code: "SCHEDULE_STORAGE_UNSUPPORTED" });
  const parsed = scheduleCommandSchema.safeParse(raw);
  if (!parsed.success) throw new HandlerFailure(422, "Invalid calendar schedule command", { code: "SCHEDULE_COMMAND_INVALID" });
  const command = parsed.data;
  if (command.enabled) requireWorkflowLifecycleAdmission(services.repository);
  if (command.enabled && command.profile === "workflow-snapshot-schedule-command/v1") requireReadTaskAdmission(services.repository);
  formatter(command.timezone);
  if (canonicalJSONBytes(command.input).length > 64_000) throw new HandlerFailure(422, "Schedule input exceeds supported bounds");
  if (containsSecretField(command.input)) throw new HandlerFailure(422, "Schedule inputs cannot contain credentials or secret fields; use the admitted connection configuration");
  const scheduleId = `schedule-${workflowId}`, now = new Date().toISOString();
  const saved = await services.repository.mutate(state => {
    commit?.assertCurrent(state);
    const workflow = state.workflows[workflowId], previous = state.schedules[scheduleId];
    if (!workflow || workflow.archived) throw new HandlerFailure(404, "Workflow not found");
    if (workflow.emailDeliverySource || workflow.recoverySource) throw new HandlerFailure(409, "One-time linked operation publications cannot be scheduled", { code: "LINKED_OPERATION_SCHEDULE_DENIED" });
    const currentActor = effectiveStateUser(state, actor.id);
    if (!currentActor?.permissions.includes("workflow:write")) throw new HandlerFailure(403, "Current workflow write authority is required");
    if (!canViewWorkflow(workflow, currentActor)) throw new HandlerFailure(403, "Current workflow access is required");
    if (command.servicePrincipalId !== currentActor.id && currentActor.role !== "Platform Admin")
      throw new HandlerFailure(403, "Only a Platform Admin may select another execution account");
    if ((previous?.revision ?? 0) !== command.baseRevision) throw new HandlerFailure(409, "Schedule changed; reload before saving", { code: "SCHEDULE_REVISION_CONFLICT" });
    if (!command.enabled) {
      if (!previous) throw new HandlerFailure(409, "There is no saved schedule to pause", { code: "SCHEDULE_NOT_FOUND" });
      const schedule: WorkflowSchedule = { ...structuredClone(previous), state: "PAUSED", revision: previous.revision + 1, nextRunAt: null, updatedAt: now };
      delete schedule.lastError; state.schedules[scheduleId] = schedule;
      state.auditLogs.push({ id: `schedule-audit-${digest([scheduleId, schedule.revision, now]).slice(7, 31)}`, actor: { id: currentActor.id, name: currentActor.name },
        action: "workflow.schedule_paused", resource: { type: "workflow-schedule", id: scheduleId },
        after: { workflowId, revision: schedule.revision, state: schedule.state, workflowVersion: schedule.workflowVersion, timezone: schedule.timezone,
          localTime: schedule.localTime, cadence: schedule.cadence ?? "daily", dayOfWeek: schedule.dayOfWeek ?? null, dayOfMonth: schedule.dayOfMonth ?? null,
          servicePrincipalId: schedule.servicePrincipalId, nextRunAt: schedule.nextRunAt }, createdAt: now });
      commit?.saved(state, structuredClone(schedule));
      return structuredClone(schedule);
    }
    const principal = effectiveStateUser(state, command.servicePrincipalId);
    if (!principal) throw new HandlerFailure(422, "The named service principal is not active");
    if (workflow.publishedVersion !== command.workflowVersion || workflowContentHash(workflow.yaml) !== command.workflowHash)
      throw new HandlerFailure(409, "Schedule must bind the exact current published workflow", { code: "SCHEDULE_PUBLICATION_CHANGED" });
    if (!canRun(state, workflowId, principal)) throw new HandlerFailure(403, "The named service principal cannot run this workflow");
    const publication = (state.versions[workflowId] ?? []).findLast(value => value.artifactState === "PUBLISHED" && value.version === command.workflowVersion && value.yaml === workflow.yaml);
    const snapshotMode = command.profile === "workflow-snapshot-schedule-command/v1";
    if (!publication || (snapshotMode ? !publication.compiledRead : !publication.compiledOperation))
      throw new HandlerFailure(422, "Scheduling requires an exact reviewed publication for the selected profile");
    if (snapshotMode) prepareReadSnapshot(state, services, publication, workflow, principal.role, command.input);
    const compiled = snapshotMode ? null : prepareOperationExecution(state, services, publication, workflow.yaml, principal.role);
    const reportWindowBinding = command.reportWindowBinding ?? null;
    const recurrenceRule = commandRecurrence(command);
    const scheduleHash = digest({ profile: command.profile, workflowId, workflowVersion: command.workflowVersion, workflowHash: command.workflowHash,
      timezone: command.timezone, localTime: command.localTime, ...recurrenceRule, reportingPeriod: command.reportingPeriod, misfirePolicy: command.misfirePolicy,
      misfireGraceSeconds: command.misfireGraceSeconds, servicePrincipalId: command.servicePrincipalId, input: command.input, reportWindowBinding });
    const unchanged = previous?.scheduleHash === scheduleHash && previous.state === "ACTIVE" && previous.nextRunAt && Date.parse(previous.nextRunAt) > Date.now();
    const nextRunAt = unchanged ? previous.nextRunAt! : nextCalendarOccurrence({ timezone: command.timezone, localTime: command.localTime, ...recurrenceRule }, Date.now());
    if (command.reportingPeriod !== "snapshot") {
      const nextReportWindow = reportWindowFor(command.timezone, nextRunAt, command.reportingPeriod);
      bindReportWindowInput(compiled!.plan, command.input, reportWindowBinding!, nextReportWindow, services.registries.snapshot().tools);
    }
    const schedule: WorkflowSchedule = { profile: snapshotMode ? "workflow-snapshot-schedule/v1" : command.profile === "workflow-daily-schedule-command/v1" ? "workflow-daily-schedule/v1" : "workflow-calendar-schedule/v2",
      id: scheduleId, workflowId, workflowVersion: command.workflowVersion,
      workflowHash: command.workflowHash, state: command.enabled ? "ACTIVE" : "PAUSED", revision: (previous?.revision ?? 0) + 1,
      timezone: command.timezone, localTime: command.localTime, ...(command.profile === "workflow-daily-schedule-command/v1" ? {} : recurrenceRule),
      reportingPeriod: command.reportingPeriod, misfirePolicy: command.misfirePolicy,
      misfireGraceSeconds: command.misfireGraceSeconds, servicePrincipalId: command.servicePrincipalId, input: structuredClone(command.input),
      ...(!snapshotMode ? { reportWindowBinding: structuredClone(reportWindowBinding!) } : {}),
      nextRunAt: command.enabled ? nextRunAt : null,
      ...(previous?.lastOccurrenceAt ? { lastOccurrenceAt: previous.lastOccurrenceAt } : {}), createdBy: previous?.createdBy ?? { id: currentActor.id, name: currentActor.name },
      createdAt: previous?.createdAt ?? now, updatedAt: now, scheduleHash };
    state.schedules[scheduleId] = schedule;
    state.auditLogs.push({ id: `schedule-audit-${digest([scheduleId, schedule.revision, now]).slice(7, 31)}`, actor: { id: currentActor.id, name: currentActor.name },
      action: "workflow.schedule_saved", resource: { type: "workflow-schedule", id: scheduleId },
      after: { workflowId, revision: schedule.revision, state: schedule.state, workflowVersion: schedule.workflowVersion, timezone: schedule.timezone,
        localTime: schedule.localTime, cadence: schedule.cadence ?? "daily", dayOfWeek: schedule.dayOfWeek ?? null, dayOfMonth: schedule.dayOfMonth ?? null,
        servicePrincipalId: schedule.servicePrincipalId, nextRunAt: schedule.nextRunAt }, createdAt: now });
    commit?.saved(state, structuredClone(schedule));
    return structuredClone(schedule);
  });
  workflowScheduleRunner(services).kick();
  return publicSchedule(saved);
}

const runners = new WeakMap<Repository, WorkflowScheduleRunner>();
export function workflowScheduleRunner(services: HandlerServices) {
  let runner = runners.get(services.repository);
  if (!runner || runner.closed) { runner = new WorkflowScheduleRunner(services); runners.set(services.repository, runner); }
  return runner;
}
type Claim = { schedule: WorkflowSchedule; occurrence: ScheduleOccurrence };
export class WorkflowScheduleRunner {
  #timer: NodeJS.Timeout | undefined;
  #running = false;
  #started = false;
  #closed = false;
  #invocation: Promise<{ admitted: number; skipped: number; blocked: number; pending: number }> | undefined;
  readonly #unobserve: () => void;
  get closed() { return this.#closed; }
  constructor(readonly services: HandlerServices) {
    bindExecutionHost(services.repository);
    if (!supportsOperationJobs(services)) throw new HandlerFailure(503, "Schedules require qualified encrypted operation persistence");
    this.#unobserve = services.repository.observeCommits({ committed: () => { void this.plan(); }, unavailable: () => { if (this.#timer) clearTimeout(this.#timer); this.#timer = undefined; }, });
  }
  async start() {
    requireResidentExecution(this.services.repository);
    if (this.#started || this.#closed) return;
    this.#started = true;
    const due = await this.services.repository.read(state => {
      this.services.repository.assertAuthority();
      return Object.values(state.scheduleOccurrences).some(value => value.state === "ADMITTING") ||
        Object.values(state.schedules).some(value => value.state === "ACTIVE" && value.nextRunAt && Date.parse(value.nextRunAt) <= Date.now());
    });
    if (due) await this.runDue(); else await this.plan();
  }
  kick() { if (!residentExecutionAllowed(this.services.repository) || !this.#started || this.#closed) return; void this.runDue(); }
  private async plan() {
    if (!residentExecutionAllowed(this.services.repository) || !this.#started || this.#closed || this.#running) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    try {
      const next = await this.services.repository.read(state => {
        this.services.repository.assertAuthority();
        if (Object.values(state.scheduleOccurrences).some(value => value.state === "ADMITTING")) return Date.now();
        return Math.min(...Object.values(state.schedules).filter(value => value.state === "ACTIVE" && value.nextRunAt).map(value => Date.parse(value.nextRunAt!)));
      });
      if (!Number.isFinite(next) || this.#closed || this.#running) return;
      this.#timer = setTimeout(() => { this.#timer = undefined; void this.runDue(); }, Math.max(1, Math.min(2_147_000_000, next - Date.now())));
      this.#timer.unref();
    } catch {}
  }
  async runDue(nowMs = Date.now()) {
    requireResidentExecution(this.services.repository);
    if (this.#running || this.#closed) return { admitted: 0, skipped: 0, blocked: 0 };
    this.#running = true;
    try {
      const { pending: _pending, ...count } = await this.driveDue(nowMs, 100, () => this.services.repository.assertAuthority());
      return count;
    } finally { this.#running = false; await this.plan(); }
  }
  async runDueInvocation(scope: WorkflowLifecycleScope) {
    const assertReady = () => {
      assertWorkflowLifecycleScope(this.services.repository, scope);
      if (this.#closed) throw new Error("Workflow schedule runner closed during invocation");
    };
    assertReady();
    if (this.#running) throw new Error("Workflow schedule owner is already busy");
    this.#running = true;
    try {
      this.#invocation = this.driveDue(scope.nowMs, scope.occurrenceLimit, assertReady, scope);
      return await this.#invocation;
    } finally { this.#invocation = undefined; this.#running = false; }
  }
  private async driveDue(nowMs: number, limit: number, assertReady: () => void, lifecycleScope?: WorkflowLifecycleScope) {
      const count = { admitted: 0, skipped: 0, blocked: 0, pending: 0 };
      for (let index = 0; index < limit; index++) {
        assertReady();
        const claim = await this.claim(nowMs, assertReady);
        assertReady();
        if (!claim) break;
        if (claim.occurrence.state === "SKIPPED") { count.skipped++; continue; }
        if (claim.occurrence.state === "BLOCKED") { count.blocked++; continue; }
        const completed = await this.admit(claim, nowMs, assertReady, lifecycleScope);
        assertReady();
        if (!completed) { count.pending++; break; }
        completed === "ADMITTED" ? count.admitted++ : count.blocked++;
      }
      return count;
  }
  private mutate<T>(assertReady: () => void, change: (state: RepositoryState) => T): Promise<T> {
    return this.services.repository.mutate(state => { assertReady(); const value = change(state); assertReady(); return value; });
  }
  private async claim(nowMs: number, assertReady: () => void): Promise<Claim | null> {
    const available = await this.services.repository.readAuthoritative(state =>
      Object.values(state.scheduleOccurrences).some(value => value.state === "ADMITTING") ||
      Object.values(state.schedules).some(value => value.state === "ACTIVE" && value.nextRunAt && Date.parse(value.nextRunAt) <= nowMs));
    assertReady(); if (!available) return null;
    return this.mutate(assertReady, state => {
      const pending = Object.values(state.scheduleOccurrences).filter(value => value.state === "ADMITTING")
        .sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor))[0];
      if (pending) { const schedule = state.schedules[pending.scheduleId]; return schedule ? { schedule: structuredClone(schedule), occurrence: structuredClone(pending) } : null; }
      const schedule = Object.values(state.schedules).filter(value => value.state === "ACTIVE" && value.nextRunAt && Date.parse(value.nextRunAt) <= nowMs)
        .sort((a, b) => a.nextRunAt!.localeCompare(b.nextRunAt!))[0];
      if (!schedule?.nextRunAt) return null;
      const workflow = state.workflows[schedule.workflowId], publication = (state.versions[schedule.workflowId] ?? []).findLast(value => value.artifactState === "PUBLISHED" && value.version === schedule.workflowVersion);
      const scheduledFor = schedule.nextRunAt, occurrenceId = `occurrence-${digest([schedule.id, schedule.revision, scheduledFor]).slice(7, 39)}`;
      const existing = state.scheduleOccurrences[occurrenceId]; if (existing) return { schedule: structuredClone(schedule), occurrence: structuredClone(existing) };
      let reportWindow: ReportWindow | undefined;
      try {
        recurrence(schedule);
        if (schedule.profile === "workflow-snapshot-schedule/v1") {
          if (schedule.reportingPeriod !== "snapshot" || schedule.reportWindowBinding) throw new Error("Invalid snapshot schedule semantics");
        } else {
          if (schedule.reportingPeriod === "snapshot") throw new Error("Invalid report schedule semantics");
          reportWindow = reportWindowFor(schedule.timezone, scheduledFor, schedule.reportingPeriod);
        }
      }
      catch {
        const reason = "Reporting-period semantics are unsupported or the local report day cannot be resolved; save a new schedule revision";
        const occurrence: ScheduleOccurrence = { profile: "workflow-schedule-occurrence/v1", id: occurrenceId, scheduleId: schedule.id,
          scheduleRevision: schedule.revision, workflowId: schedule.workflowId, workflowVersion: schedule.workflowVersion, workflowHash: schedule.workflowHash,
          scheduledFor, localDate: localParts(schedule.timezone, Date.parse(scheduledFor)).date, timezone: schedule.timezone,
          servicePrincipalId: schedule.servicePrincipalId, state: "BLOCKED", idempotencyKey: `sched_${digest([schedule.id, schedule.revision, scheduledFor]).slice(7, 55)}`,
          reason, createdAt: new Date(nowMs).toISOString() };
        state.scheduleOccurrences[occurrenceId] = occurrence; schedule.state = "BLOCKED"; schedule.lastError = reason; schedule.nextRunAt = null; schedule.updatedAt = new Date(nowMs).toISOString();
        return { schedule: structuredClone(schedule), occurrence: structuredClone(occurrence) };
      }
      if (!workflow || workflow.archived || workflow.publishedVersion !== schedule.workflowVersion || workflowContentHash(workflow.yaml) !== schedule.workflowHash || publication?.yaml !== workflow.yaml) {
        const reason = "Pinned workflow publication changed or is unavailable";
        const occurrence: ScheduleOccurrence = { profile: "workflow-schedule-occurrence/v1", id: occurrenceId, scheduleId: schedule.id,
          scheduleRevision: schedule.revision, workflowId: schedule.workflowId, workflowVersion: schedule.workflowVersion, workflowHash: schedule.workflowHash,
          scheduledFor, localDate: localParts(schedule.timezone, Date.parse(scheduledFor)).date, timezone: schedule.timezone, ...(reportWindow ? { reportWindow } : {}),
          servicePrincipalId: schedule.servicePrincipalId, state: "BLOCKED", idempotencyKey: `sched_${digest([schedule.id, schedule.revision, scheduledFor]).slice(7, 55)}`,
          reason, createdAt: new Date(nowMs).toISOString() };
        state.scheduleOccurrences[occurrenceId] = occurrence;
        schedule.state = "BLOCKED"; schedule.lastError = reason; schedule.nextRunAt = null; schedule.updatedAt = new Date(nowMs).toISOString();
        return { schedule: structuredClone(schedule), occurrence: structuredClone(occurrence) };
      }
      const lateMs = nowMs - Date.parse(scheduledFor), skipped = schedule.misfirePolicy === "SKIP" && lateMs > schedule.misfireGraceSeconds * 1000;
      const occurrence: ScheduleOccurrence = { profile: "workflow-schedule-occurrence/v1", id: occurrenceId, scheduleId: schedule.id, scheduleRevision: schedule.revision,
        workflowId: schedule.workflowId, workflowVersion: schedule.workflowVersion, workflowHash: schedule.workflowHash, scheduledFor,
        localDate: localParts(schedule.timezone, Date.parse(scheduledFor)).date, timezone: schedule.timezone, ...(reportWindow ? { reportWindow } : {}), servicePrincipalId: schedule.servicePrincipalId,
        state: skipped ? "SKIPPED" : "ADMITTING", idempotencyKey: `sched_${digest([schedule.id, schedule.revision, scheduledFor]).slice(7, 55)}`,
        createdAt: new Date(nowMs).toISOString(), ...(skipped ? { reason: "Occurrence exceeded the configured misfire grace window; no execution was admitted" } : {}) };
      state.scheduleOccurrences[occurrenceId] = occurrence;
      if (skipped) { schedule.lastOccurrenceAt = scheduledFor; schedule.nextRunAt = nextCalendarOccurrence(recurrence(schedule), nowMs); schedule.updatedAt = new Date(nowMs).toISOString(); }
      return { schedule: structuredClone(schedule), occurrence: structuredClone(occurrence) };
    });
  }
  private async admit(claim: Claim, nowMs: number, assertReady: () => void, lifecycleScope?: WorkflowLifecycleScope): Promise<"ADMITTED" | "BLOCKED" | null> {
    assertReady();
    const snapshotMode = claim.schedule.profile === "workflow-snapshot-schedule/v1";
    if (!snapshotMode && !claim.occurrence.reportWindow) return this.block(claim, "Occurrence has no immutable report window; save a new schedule revision", assertReady);
    if (claim.occurrence.scheduleRevision !== claim.schedule.revision)
      return this.block(claim, "Occurrence belongs to an older schedule revision and cannot use newer inputs", assertReady);
    if (!snapshotMode && !claim.schedule.reportWindowBinding)
      return this.block(claim, "Schedule has no reviewed report-window input binding; save a new schedule revision", assertReady);
    const principal = await this.services.repository.effectiveUser(claim.schedule.servicePrincipalId);
    assertReady();
    if (!principal) return this.block(claim, "Named service principal is unavailable", assertReady);
    try {
      const prepared = await this.services.repository.readAuthoritative(state => {
        const workflow = state.workflows[claim.schedule.workflowId], publication = (state.versions[claim.schedule.workflowId] ?? [])
          .findLast(value => value.artifactState === "PUBLISHED" && value.version === claim.schedule.workflowVersion && value.yaml === workflow?.yaml);
        if (!workflow || !publication) throw new HandlerFailure(409, "Pinned workflow publication is unavailable");
        if (snapshotMode) {
          prepareReadSnapshot(state, this.services, publication, workflow, principal.role, claim.schedule.input);
          return { workflow: structuredClone(workflow), input: structuredClone(claim.schedule.input) };
        }
        const compiled = prepareOperationExecution(state, this.services, publication, workflow.yaml, principal.role);
        const input = bindReportWindowInput(compiled.plan, claim.schedule.input, claim.schedule.reportWindowBinding!, claim.occurrence.reportWindow!, this.services.registries.snapshot().tools);
        return { workflow: structuredClone(workflow), input };
      });
      const identity = { scheduleId: claim.schedule.id, scheduleRevision: claim.schedule.revision,
        occurrenceId: claim.occurrence.id, scheduledFor: claim.occurrence.scheduledFor, scheduleHash: claim.schedule.scheduleHash,
        inputHash: digest(prepared.input) };
      assertReady();
      const result = snapshotMode ? await admitReadSnapshot(this.services, prepared.workflow, prepared.input, principal, claim.occurrence.idempotencyKey,
        { profile: "workflow-snapshot-schedule-source/v1", ...identity }, lifecycleScope) :
        await operationJobQueue(this.services).admit(prepared.workflow, prepared.input, principal, claim.occurrence.idempotencyKey,
          `schedule:${claim.schedule.id}:${claim.occurrence.id}`, { profile: "workflow-schedule-source/v1", ...identity,
            reportWindow: structuredClone(claim.occurrence.reportWindow!), reportWindowBinding: structuredClone(claim.schedule.reportWindowBinding!) }, lifecycleScope);
      assertReady();
      await this.mutate(assertReady, state => {
        const occurrence = state.scheduleOccurrences[claim.occurrence.id], schedule = state.schedules[claim.schedule.id];
        if (!occurrence || occurrence.state !== "ADMITTING") return;
        occurrence.state = "ADMITTED"; occurrence.executionId = String((result.execution as { id?: unknown }).id); occurrence.admittedAt = new Date(nowMs).toISOString();
        if (schedule?.revision === claim.schedule.revision && schedule.state === "ACTIVE") {
          // A recovered durable claim may be ahead of the current wall clock
          // after clock correction. Never point back at its terminal occurrence.
          schedule.lastOccurrenceAt = occurrence.scheduledFor;
          schedule.nextRunAt = nextCalendarOccurrence(recurrence(schedule), Math.max(nowMs, Date.parse(occurrence.scheduledFor)));
          schedule.updatedAt = new Date(nowMs).toISOString(); delete schedule.lastError;
        }
      });
      return "ADMITTED";
    } catch (error) {
      assertReady();
      if (error instanceof HandlerFailure && error.status < 500) return this.block(claim, error.message, assertReady);
      return null;
    }
  }
  private async block(claim: Claim, reason: string, assertReady: () => void): Promise<"BLOCKED"> {
    await this.mutate(assertReady, state => {
      const occurrence = state.scheduleOccurrences[claim.occurrence.id], schedule = state.schedules[claim.schedule.id];
      if (occurrence?.state === "ADMITTING") { occurrence.state = "BLOCKED"; occurrence.reason = reason; }
      if (schedule?.revision === claim.schedule.revision && claim.occurrence.scheduleRevision === claim.schedule.revision) {
        schedule.state = "BLOCKED"; schedule.nextRunAt = null; schedule.lastError = reason; schedule.updatedAt = new Date().toISOString();
      }
    });
    return "BLOCKED";
  }
  async stop() { this.#closed = true; if (this.#timer) clearTimeout(this.#timer); this.#unobserve(); await this.#invocation?.catch(() => {}); }
}
