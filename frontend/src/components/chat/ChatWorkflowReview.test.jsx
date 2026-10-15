/** @jest-environment jsdom */
import React from "react";
import { test, expect, afterEach, jest } from "@jest/globals";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
const scheduleMounted = jest.fn();
jest.unstable_mockModule("../workflows/WorkflowSchedulePanel", () => ({ default: props => { scheduleMounted(props); return <p>Current authoritative schedule controls</p>; } }));
const { default: ChatWorkflowReview } = await import("./ChatWorkflowReview");
afterEach(() => { cleanup(); scheduleMounted.mockClear(); });
const control = { profile: "workflow-control-handoff/v1", workflowId: "directory", name: "Directory", action: "schedule", actorId: "requester", canEdit: true };

test("schedule controls load only after review, remain in chat, and use the exact saved workflow", async () => {
  render(<MemoryRouter><ChatWorkflowReview control={control} /></MemoryRouter>);
  expect(scheduleMounted).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Review schedule here" }));
  expect(await screen.findByText("Current authoritative schedule controls")).toBeTruthy();
  expect(scheduleMounted).toHaveBeenCalledWith({ workflow: { id: "directory" }, actorId: "requester", suggestion: undefined });
  fireEvent.click(screen.getByRole("button", { name: "Hide schedule controls" }));
  expect(screen.queryByText("Current authoritative schedule controls")).toBeNull();
});
test("a read-only control handoff cannot open a schedule editor", () => {
  render(<MemoryRouter><ChatWorkflowReview control={{ ...control, canEdit: false }} /></MemoryRouter>);
  expect(screen.queryByRole("button", { name: "Review schedule here" })).toBeNull(); expect(scheduleMounted).not.toHaveBeenCalled();
});
test("a confirmed background schedule shows its durable receipt rather than claiming no command ran", () => {
  render(<MemoryRouter><ChatWorkflowReview control={{ ...control, scheduleCommandApplied: true, scheduleState: "ACTIVE", scheduleRevision: 3, nextRunAt: "2026-10-19T03:30:00.000Z" }} /></MemoryRouter>);
  expect(screen.getByRole("status").textContent).toContain("Schedule active · saved revision 3");
  expect(screen.getByRole("status").textContent).not.toContain("no command executed"); expect(scheduleMounted).not.toHaveBeenCalled();
});
test("busy chat disables repeat review actions and invalid stored workflow IDs are not links", () => {
  const view = render(<MemoryRouter><ChatWorkflowReview control={control} busy /></MemoryRouter>);
  expect(screen.getByRole("button", { name: "Review schedule here" }).disabled).toBe(true);
  expect(screen.getByRole("button", { name: "Open saved workflow" }).disabled).toBe(true);
  view.rerender(<MemoryRouter><ChatWorkflowReview control={{ ...control, workflowId: "../outside" }} /></MemoryRouter>);
  expect(screen.queryByRole("region")).toBeNull();
});
