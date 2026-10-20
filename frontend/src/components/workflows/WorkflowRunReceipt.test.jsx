/** @jest-environment jsdom */
import React from "react";
import { afterEach, expect, jest, test } from "@jest/globals";
import { act, cleanup, render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { NotificationProvider } from "../../context/NotificationContext";
import WorkflowRunReceipt from "./WorkflowRunReceipt";
import { executionService, normalizeExecution } from "../../services/execution.service";

afterEach(() => { cleanup(); jest.restoreAllMocks(); });
const initial = (status = "PENDING") => normalizeExecution({ id: "run/one", status, tokens: { input: 0, output: 0, total: 0 } });
async function mount(run, dismiss = jest.fn()) {
  let view;
  await act(async () => { view = render(<MemoryRouter><WorkflowRunReceipt initialExecution={run} onDismiss={dismiss} /></MemoryRouter>); });
  return view;
}
function mockMonitor(execution) {
  jest.spyOn(executionService, "getEvents").mockResolvedValue({ events: [], cursor: 0, lastSequence: 0, hasMore: false, status: execution.status, profile: "legacy-no-journal" });
  jest.spyOn(executionService, "get").mockResolvedValue(execution); jest.spyOn(executionService, "getTimeline").mockResolvedValue([]);
  return { run: jest.spyOn(executionService, "run"), retry: jest.spyOn(executionService, "retry"), cancel: jest.spyOn(executionService, "cancel") };
}
test.each([["PENDING", "Pending"], ["RUNNING", "Running"], ["AWAITING_APPROVAL", "Awaiting approval"], ["RECOVERY_REQUIRED", "Recovery required"], ["RECONCILIATION_REQUIRED", "ERP reconciliation required"], ["CANCELLED", "Cancelled"], ["FAILED", "Failed"]])(
  "%s remains a distinct recorded state, never inferred as failure or success", async (status, label) => {
    const run = initial(status), writes = mockMonitor(run), dismiss = jest.fn();
    await mount(run, dismiss);
    expect(screen.getByTestId("execution-status").textContent).toBe(label);
    expect(screen.getByRole("link", { name: "Open run details and controls" }).getAttribute("href")).toBe("/executions/run%2Fone");
    const dismissButton = screen.getByRole("button", { name: "Dismiss run summary" });
    expect(dismissButton.disabled).toBe(!["FAILED", "CANCELLED"].includes(status));
    fireEvent.click(dismissButton); expect(dismiss).toHaveBeenCalledTimes(["FAILED", "CANCELLED"].includes(status) ? 1 : 0);
    for (const spy of Object.values(writes)) expect(spy).not.toHaveBeenCalled();
    if (["PENDING", "RUNNING", "AWAITING_APPROVAL"].includes(status)) expect(screen.getByText("No confirmed output has been saved yet.")).toBeTruthy();
    await screen.findByRole("region", { name: "Recorded model usage" });
  });
test("follows the saved run to DONE, shows readable actual output and recorded usage, without a second run", async () => {
  const done = normalizeExecution({ id: "run/one", status: "DONE", tokens: { input: 11, output: 7, total: 18 }, finalOutput: { structuredContent: { departmentCount: 8 } } });
  const writes = mockMonitor(done);
  const view = await mount(initial());
  await screen.findByText("Done"); expect(screen.getByText("18")).toBeTruthy(); expect(screen.getByText("8")).toBeTruthy();
  expect(view.container.querySelector("pre")).toBeNull(); expect(screen.queryByText(/"departmentCount"/)).toBeNull();
  for (const spy of Object.values(writes)) expect(spy).not.toHaveBeenCalled();
});
test("transport failure retains explicitly stale evidence; authorization loss hides it", async () => {
  const run = { ...initial("RUNNING"), stepOutputs: { first: { structuredContent: { answer: "Saved answer" } } } };
  const writes = mockMonitor(run);
  executionService.getEvents.mockRejectedValue(new Error("Network unavailable"));
  const view = await mount(run);
  await screen.findByRole("status"); expect(screen.getByText(/Saved evidence may be stale/)).toBeTruthy(); expect(screen.getByText("Saved answer")).toBeTruthy();
  expect(screen.getByTestId("execution-status").textContent).toBe("Running");
  view.unmount(); executionService.getEvents.mockRejectedValue({ response: { status: 403 } });
  await mount(run);
  await screen.findByRole("alert"); expect(screen.queryByText("Saved answer")).toBeNull(); expect(screen.queryByRole("region", { name: "Recorded model usage" })).toBeNull();
  for (const spy of Object.values(writes)) expect(spy).not.toHaveBeenCalled();
});


test("chat run receipt shows the actual failed step, tool and safe explanation", async () => {
  const run = normalizeExecution({ id: "run/one", status: "FAILED", tokens: { input: 0, output: 0, total: 0 }, failure: {
    failureCategory: "READ_EXECUTION_FAILED", failedStepId: "customer_lookup", failedToolName: "get_customer", stage: "input_resolution",
    reason: "A required workflow input or prior step output is missing. Check this step's data mappings.",
  } });
  mockMonitor(run); await mount(run);
  expect(screen.getByText("customer_lookup")).toBeTruthy(); expect(screen.getByText("get_customer")).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toContain("prior step output is missing");
});


test("draft requirement notes remain visible without hiding completed saved tool results", async () => {
  const run = normalizeExecution({ id: "run/one", status: "DONE", tokens: { input: 0, output: 0, total: 0 },
    workflowSnapshot: { yaml: "name: Saved steps\nmetadata:\n  unresolved_requirements:\n    - Follow up on duplicate branching\nsteps:\n  - id: lookup\n    action: get_customer\n" },
    finalOutput: { structuredContent: { customer: "Confirmed customer" } } });
  mockMonitor(run); await mount(run);
  expect(screen.getByTestId("execution-status").textContent).toContain("Done");
  expect(screen.getByLabelText("Workflow requirement notes").textContent).toContain("Follow up on duplicate branching");
  expect(screen.getByText("Confirmed customer")).toBeTruthy();
  expect(screen.queryByText(/Edit those requirements/)).toBeNull();
});


test("saved workflow polling shows approval and its notification automatically, then clears them when the run continues", async () => {
  jest.useFakeTimers();
  try {
    let current = initial("RUNNING");
    const writes = mockMonitor(current);
    executionService.getEvents.mockImplementation(async () => ({ events: [], cursor: 0, lastSequence: 0, hasMore: false, status: current.status, profile: "legacy-no-journal" }));
    executionService.get.mockImplementation(async () => current);
    const review = jest.spyOn(executionService, "getApproval").mockResolvedValue({ ...initial("AWAITING_APPROVAL"), runtimeApproval: { state: "PENDING", canDecide: false } });
    const approve = jest.spyOn(executionService, "approve"), reject = jest.spyOn(executionService, "reject");
    await act(async () => { render(<MemoryRouter><NotificationProvider><WorkflowRunReceipt initialExecution={current} /></NotificationProvider></MemoryRouter>); });
    expect(screen.queryByRole("button", { name: "Review approval" })).toBeNull();
    current = { ...initial("AWAITING_APPROVAL"), hasRuntimeApproval: true, pendingApproval: { stepId: "create", requestedAt: "2026-10-19T12:00:00Z" } };
    await act(async () => { await jest.advanceTimersByTimeAsync(2000); });
    expect(screen.getByTestId("execution-status").textContent).toBe("Awaiting approval");
    expect(screen.getByRole("button", { name: "Review approval" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Workflow transaction approval" })).toBeTruthy();
    expect(review).toHaveBeenCalledTimes(1);
    current = initial("DONE");
    await act(async () => { await jest.advanceTimersByTimeAsync(2000); });
    expect(screen.getByTestId("execution-status").textContent).toBe("Done");
    expect(screen.queryByRole("button", { name: "Review approval" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Workflow transaction approval" })).toBeNull();
    expect(approve).not.toHaveBeenCalled(); expect(reject).not.toHaveBeenCalled();
    for (const spy of Object.values(writes)) expect(spy).not.toHaveBeenCalled();
  } finally { jest.useRealTimers(); }
});
