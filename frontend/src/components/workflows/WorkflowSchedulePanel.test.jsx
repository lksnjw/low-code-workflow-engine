/** @jest-environment jsdom */
import React from "react";
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import "@testing-library/jest-dom/jest-globals";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import WorkflowSchedulePanel, { suggestedScheduleForm } from "./WorkflowSchedulePanel";
import { workflowScheduleService } from "../../services/workflow-schedule.service";
import { workflowService } from "../../services/workflow.service";

const h = `sha256:${"a".repeat(64)}`, binding = { profile: "workflow-report-window-input-binding/v1", startAtInput: "reportStartAt", endAtInput: "reportEndAt" };
const readiness = { published: true, publishedVersion: 2, contentHash: h, executionProfile: "sequential-operation-v1", compilation: { state: "CURRENT" },
  authoring: { inputSchema: { type: "object", properties: { report: { type: "string" }, reportStartAt: { type: "string" }, reportEndAt: { type: "string" } },
    required: ["report", "reportStartAt", "reportEndAt"], additionalProperties: false } } };
const empty = { profile: "workflow-schedule-view/v1", workflowId: "flow", schedule: null, occurrences: [], canManage: true, explanation: "No active schedule is confirmed." };
const saved = { profile: "workflow-daily-schedule/v1", id: "schedule-flow", workflowId: "flow", workflowVersion: 2, workflowHash: h, state: "ACTIVE", revision: 1,
  timezone: "Asia/Colombo", localTime: "09:00", reportingPeriod: "previous-calendar-day", misfirePolicy: "SKIP", misfireGraceSeconds: 900,
  servicePrincipalId: "owner", input: { report: "invoices" }, reportWindowBinding: binding, nextRunAt: "2026-10-07T03:30:00.000Z", createdBy: { id: "owner", name: "Owner" },
  createdAt: "2026-10-06T10:00:00.000Z", updatedAt: "2026-10-06T10:00:00.000Z", scheduleHash: h };
const occurrence = { profile: "workflow-schedule-occurrence/v1", id: "occurrence-one", scheduleId: "schedule-flow", scheduleRevision: 1,
  workflowId: "flow", workflowVersion: 2, workflowHash: h, scheduledFor: "2026-10-07T03:30:00.000Z", localDate: "2026-10-07", timezone: "Asia/Colombo",
  reportWindow: { profile: "workflow-report-window/v1", reportingPeriod: "previous-calendar-day", timezone: "Asia/Colombo", localDate: "2026-10-06",
    startAt: "2026-10-05T18:30:00.000Z", endAt: "2026-10-06T18:30:00.000Z" }, servicePrincipalId: "owner", state: "ADMITTED",
  createdAt: "2026-10-07T03:30:00.000Z", executionId: "run-one", admittedAt: "2026-10-07T03:30:01.000Z" };
beforeEach(() => { jest.spyOn(workflowScheduleService, "status").mockResolvedValue(empty); jest.spyOn(workflowScheduleService, "save").mockResolvedValue(saved);
  jest.spyOn(workflowService, "readiness").mockResolvedValue(readiness); });
afterEach(() => { cleanup(); jest.restoreAllMocks(); });

test("a plain-language schedule suggestion prefills only editable timing fields without activating anything", async () => {
  const suggestion = { cadence: "weekly", dayOfWeek: 5, localTime: "18:00", timezone: "Asia/Colombo" };
  render(<WorkflowSchedulePanel workflow={{ id: "flow" }} actorId="owner" suggestion={suggestion} />);
  await screen.findByText(/prefilled an unsaved schedule proposal/);
  expect(screen.getByLabelText("Schedule cadence")).toHaveValue("weekly"); expect(screen.getByLabelText("Weekly local weekday")).toHaveValue("5");
  expect(screen.getByLabelText("Schedule local time")).toHaveValue("18:00"); expect(screen.getByLabelText("Schedule timezone")).toHaveValue("Asia/Colombo");
  expect(screen.getByLabelText("Reporting period")).toHaveValue("previous-calendar-week");
  expect(screen.getByRole("button", { name: "Activate weekly schedule" })).toBeDisabled();
  expect(workflowScheduleService.save).not.toHaveBeenCalled();
});

test("a suggested schedule cannot inject credentials, enablement, run-as identity, revisions or input values", () => {
  const suggestion = { cadence: "monthly", dayOfMonth: 31, localTime: "25:00", timezone: "not/a-zone", enabled: true, servicePrincipalId: "another-person", baseRevision: 99,
    input: { password: "never-accepted" }, reportWindowBinding: { startAtInput: "wrong" } };
  const form = suggestedScheduleForm(saved, "owner", suggestion);
  expect(form.enabled).toBe(true); // The prior saved status, not model enablement.
  expect(form.servicePrincipalId).toBe("owner"); expect(form.input).toEqual(saved.input); expect(form.reportWindowBinding).toEqual(binding);
  expect(form).not.toHaveProperty("baseRevision"); expect(form.dayOfMonth).toBe(1); expect(form.localTime).toBe("09:00"); expect(form.timezone).toBe("Asia/Colombo");
  const initial = suggestedScheduleForm(null, "owner", suggestion); expect(initial.enabled).toBe(false); expect(initial.input).toEqual({});
});

test("manual workflows do not show publication or unavailable-schedule warnings", async () => {
  workflowService.readiness.mockResolvedValue({ ...readiness, published: false, executionProfile: "read-v1" });
  render(<WorkflowSchedulePanel workflow={{ id: "flow" }} actorId="owner" />);
  await waitFor(() => expect(screen.queryByText(/Loading authoritative schedule/)).toBeNull());
  expect(screen.queryByText(/Publish and review/)).toBeNull();
  expect(screen.queryByText("Technical reason")).toBeNull();
  expect(screen.queryByRole("button", { name: "Activate daily schedule" })).toBeNull();
  expect(workflowScheduleService.save).not.toHaveBeenCalled();
});

test("an explicitly admitted read snapshot schedules without invented date fields", async () => {
  workflowService.readiness.mockResolvedValue({ ...readiness, executionProfile: "structured-read-v1", read_snapshot_schedule_admission: "read-snapshot/v1",
    authoring: { inputSchema: { type: "object", properties: {}, additionalProperties: false } } });
  render(<WorkflowSchedulePanel workflow={{ id: "flow" }} actorId="owner" />);
  await screen.findByText(/This is a snapshot, not a complete previous-day report/);
  expect(screen.queryByLabelText("Report start boundary input")).toBeNull();
  expect(screen.getByLabelText("Reporting period")).toHaveValue("snapshot");
  fireEvent.click(screen.getByRole("button", { name: "Activate daily schedule" }));
  await screen.findByText(/Daily schedule active/);
  expect(workflowScheduleService.save).toHaveBeenCalledWith("flow", expect.objectContaining({
    profile: "workflow-snapshot-schedule-command/v1", reportingPeriod: "snapshot", reportWindowBinding: null, input: {}, enabled: true }));
});
const selectWindowBinding = () => {
  fireEvent.change(screen.getByLabelText("Report start boundary input"), { target: { value: "reportStartAt" } });
  fireEvent.change(screen.getByLabelText("Report end boundary input"), { target: { value: "reportEndAt" } });
};

test("activates a readable daily schedule with explicit timezone, principal, period and schema-generated inputs", async () => {
  workflowScheduleService.status.mockResolvedValueOnce(empty).mockResolvedValueOnce({ ...empty, schedule: saved, explanation: "Active and durable." });
  render(<WorkflowSchedulePanel workflow={{ id: "flow" }} actorId="owner" />); await screen.findByText("No active schedule is confirmed.");
  fireEvent.change(screen.getByLabelText("Schedule timezone"), { target: { value: "Asia/Colombo" } });
  fireEvent.change(screen.getByLabelText("Reporting period"), { target: { value: "previous-calendar-day" } });
  selectWindowBinding();
  fireEvent.click(screen.getByRole("button", { name: "Set report" }));
  fireEvent.change(screen.getByLabelText("Occurrence inputs · report"), { target: { value: "invoices" } });
  fireEvent.click(screen.getByRole("button", { name: "Activate daily schedule" }));
  await screen.findByText(/Daily schedule active/); expect(workflowScheduleService.save).toHaveBeenCalledWith("flow", expect.objectContaining({
    profile: "workflow-calendar-schedule-command/v2", cadence: "daily", workflowVersion: 2, workflowHash: h, enabled: true, timezone: "Asia/Colombo",
    servicePrincipalId: "owner", reportingPeriod: "previous-calendar-day", input: { report: "invoices" }, reportWindowBinding: binding }));
  expect(screen.queryByLabelText("Occurrence inputs · reportStartAt")).toBeNull();
  expect(document.querySelector("pre")).toBeNull();
});

test("lost save acknowledgement locks controls until authoritative reload", async () => {
  workflowScheduleService.save.mockRejectedValueOnce(new Error("lost acknowledgement")); render(<WorkflowSchedulePanel workflow={{ id: "flow" }} actorId="owner" />);
  const activate = await screen.findByRole("button", { name: "Activate daily schedule" }); selectWindowBinding(); fireEvent.click(activate);
  await screen.findByText(/outcome is unconfirmed/); expect(screen.getByRole("button", { name: "Activate daily schedule" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Reload status" })); await screen.findByText(/Authoritative schedule reloaded/);
  expect(workflowScheduleService.save).toHaveBeenCalledTimes(1);
});

test("decision schedule guidance requires scope-specific evidence and never treats activation rejection as success", async () => {
  workflowScheduleService.save.mockRejectedValueOnce({ response: { status: 422, data: { message: "Complete report evidence is missing before effect no_send" } } });
  render(<WorkflowSchedulePanel workflow={{ id: "flow" }} actorId="owner" />);
  const activate = await screen.findByRole("button", { name: "Activate daily schedule" }); selectWindowBinding();
  expect(screen.getByText(/a sibling branch cannot supply it/)).toBeTruthy(); fireEvent.click(activate);
  await screen.findByRole("alert"); expect(screen.getByRole("alert")).toHaveTextContent("Complete report evidence is missing before effect no_send");
  expect(screen.queryByText(/Daily schedule active/)).toBeNull(); expect(activate).toBeDisabled();
  expect(workflowScheduleService.save).toHaveBeenCalledTimes(1);
});

test("does not offer activation for an unpublished or unsupported workflow", async () => {
  workflowService.readiness.mockResolvedValue({ ...readiness, published: false, executionProfile: "sequential-read-v1" });
  render(<WorkflowSchedulePanel workflow={{ id: "flow" }} actorId="owner" />); await waitFor(() => expect(screen.queryByText(/Loading authoritative schedule/)).toBeNull());
  expect(screen.queryByRole("button", { name: "Activate daily schedule" })).toBeNull(); expect(workflowScheduleService.save).not.toHaveBeenCalled();
});

test.each(["protected-operation-v1", "protected-draft-runtime-pending"])("protected %s never treats manual readiness as calendar qualification", async executionProfile => {
  workflowService.readiness.mockResolvedValue({ ...readiness, executionProfile, operation_job_admission: "operation-job/v1", can_attempt_run: true });
  render(<WorkflowSchedulePanel workflow={{ id: "flow" }} actorId="owner" />); await waitFor(() => expect(screen.queryByText(/Loading authoritative schedule/)).toBeNull());
  expect(screen.queryByRole("button", { name: "Activate daily schedule" })).toBeNull(); expect(workflowScheduleService.save).not.toHaveBeenCalled();
});

test("a legacy active schedule without a window binding can still be paused", async () => {
  const legacy = { ...saved, reportWindowBinding: null };
  workflowScheduleService.status.mockResolvedValue({ ...empty, schedule: legacy, explanation: "Legacy schedule requires a new revision." });
  workflowScheduleService.save.mockResolvedValue({ ...legacy, state: "PAUSED", revision: 2, nextRunAt: null });
  render(<WorkflowSchedulePanel workflow={{ id: "flow" }} actorId="owner" />);
  fireEvent.click(await screen.findByRole("button", { name: "Pause schedule" }));
  await screen.findByText(/Schedule paused/);
  expect(workflowScheduleService.save).toHaveBeenCalledWith("flow", expect.objectContaining({ enabled: false, reportWindowBinding: null }));
});

test("shows the immutable local report day and exact UTC boundaries for an occurrence", async () => {
  workflowScheduleService.status.mockResolvedValue({ ...empty, schedule: saved, occurrences: [occurrence], explanation: "Active and durable." });
  render(<WorkflowSchedulePanel workflow={{ id: "flow" }} actorId="owner" />);
  expect(await screen.findByText(/Report period 2026-10-06/)).toBeTruthy();
  expect(screen.getByRole("link", { name: "Open execution" }).getAttribute("href")).toBe("/executions/run-one");
});

test("activates a weekly calendar with an explicit local weekday and matching report period", async () => {
  const weekly = { ...saved, profile: "workflow-calendar-schedule/v2", cadence: "weekly", dayOfWeek: 3, reportingPeriod: "previous-calendar-week" };
  workflowScheduleService.status.mockResolvedValueOnce(empty).mockResolvedValueOnce({ ...empty, schedule: weekly, explanation: "Active and durable." });
  workflowScheduleService.save.mockResolvedValue(weekly);
  render(<WorkflowSchedulePanel workflow={{ id: "flow" }} actorId="owner" />); await screen.findByText("No active schedule is confirmed.");
  fireEvent.change(screen.getByLabelText("Schedule cadence"), { target: { value: "weekly" } });
  fireEvent.change(screen.getByLabelText("Weekly local weekday"), { target: { value: "3" } });
  expect(screen.getByLabelText("Reporting period")).toHaveValue("previous-calendar-week");
  selectWindowBinding(); fireEvent.click(screen.getByRole("button", { name: "Activate weekly schedule" }));
  await screen.findByText(/Weekly schedule active/);
  expect(workflowScheduleService.save).toHaveBeenCalledWith("flow", expect.objectContaining({ profile: "workflow-calendar-schedule-command/v2",
    cadence: "weekly", dayOfWeek: 3, reportingPeriod: "previous-calendar-week" }));
});

test("requires a safe monthly day and derives the previous-month report period", async () => {
  render(<WorkflowSchedulePanel workflow={{ id: "flow" }} actorId="owner" />); await screen.findByText("No active schedule is confirmed.");
  fireEvent.change(screen.getByLabelText("Schedule cadence"), { target: { value: "monthly" } });
  selectWindowBinding();
  const day = screen.getByLabelText("Monthly local day"), activate = screen.getByRole("button", { name: "Activate monthly schedule" });
  expect(screen.getByLabelText("Reporting period")).toHaveValue("previous-calendar-month");
  fireEvent.change(day, { target: { value: "29" } }); expect(activate).toBeDisabled();
  fireEvent.change(day, { target: { value: "15" } }); expect(activate).toBeEnabled(); fireEvent.click(activate);
  await screen.findByText(/Monthly schedule active/);
  expect(workflowScheduleService.save).toHaveBeenCalledWith("flow", expect.objectContaining({ cadence: "monthly", dayOfMonth: 15,
    reportingPeriod: "previous-calendar-month" }));
});
