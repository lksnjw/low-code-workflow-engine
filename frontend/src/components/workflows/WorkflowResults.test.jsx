/** @jest-environment jsdom */
import React from "react";
import { afterEach, expect, jest, test } from "@jest/globals";
import { cleanup, fireEvent, render, screen, act } from "@testing-library/react";
import { executionService } from "../../services/execution.service";
const receipt = jest.fn();
jest.unstable_mockModule("./WorkflowRunReceipt", () => ({ default: props => { receipt(props); return <p>Confirmed saved output {props.initialExecution.id}</p>; } }));
const { default: WorkflowResults } = await import("./WorkflowResults");
afterEach(() => { cleanup(); jest.restoreAllMocks(); receipt.mockClear(); });

test("a reserved result area explains original-run recovery, without starting or automatically fetching history", () => {
  const list = jest.spyOn(executionService, "list"); render(<WorkflowResults workflowId="wf" loading />);
  expect(screen.getByRole("region", { name: "Workflow results" })).toBeTruthy(); expect(screen.getByRole("status").textContent).toContain("no second run"); expect(list).not.toHaveBeenCalled();
});

test("the current receipt is rendered with its existing monitor instead of starting another polling owner", () => {
  const execution = { id: "run", workflowId: "wf", status: "DONE" }, monitor = { execution, timeline: [] };
  render(<WorkflowResults workflowId="wf" execution={execution} monitor={monitor} />);
  expect(receipt).toHaveBeenCalledWith(expect.objectContaining({ initialExecution: execution, externalMonitor: monitor })); expect(screen.getByText("Confirmed saved output run")).toBeTruthy();
});

test("load latest reads one bounded page and its exact matching receipt; it never runs or retries", async () => {
  const list = jest.spyOn(executionService, "list").mockResolvedValue([{ id: "run-one" }]), get = jest.spyOn(executionService, "get").mockResolvedValue({ id: "run-one", workflowId: "wf", status: "DONE" }), run = jest.spyOn(executionService, "run");
  render(<WorkflowResults workflowId="wf" />); fireEvent.click(screen.getByRole("button", { name: "Load latest saved result" }));
  await screen.findByText("Confirmed saved output run-one"); expect(list).toHaveBeenCalledWith({ workflowId: "wf", limit: 1 }); expect(get).toHaveBeenCalledWith("run-one"); expect(run).not.toHaveBeenCalled();
});

test("foreign or revoked results are hidden rather than reused as this workflow's output", async () => {
  jest.spyOn(executionService, "list").mockResolvedValue([{ id: "wrong" }]); jest.spyOn(executionService, "get").mockResolvedValue({ id: "wrong", workflowId: "another" });
  render(<WorkflowResults workflowId="wf" />); fireEvent.click(screen.getByRole("button", { name: "Load latest saved result" }));
  expect((await screen.findByRole("alert")).textContent).toContain("does not match"); expect(receipt).not.toHaveBeenCalled();
});

test("a late history read after unmount cannot expose saved output", async () => {
  let finish; jest.spyOn(executionService, "list").mockImplementation(() => new Promise(resolve => { finish = resolve; })); const get = jest.spyOn(executionService, "get");
  const view = render(<WorkflowResults workflowId="wf" />); fireEvent.click(screen.getByRole("button", { name: "Load latest saved result" })); view.unmount();
  await act(async () => finish([{ id: "late" }])); expect(get).not.toHaveBeenCalled(); expect(receipt).not.toHaveBeenCalled();
});

test.each([{ denied: true }, { execution: { id: "foreign", workflowId: "other" } }])("unavailable current results are hidden with an actionable explanation %j", props => {
  render(<WorkflowResults workflowId="wf" execution={props.execution || { id: "run", workflowId: "wf" }} monitor={props.denied ? { denied: true } : undefined} />);
  expect(screen.getByRole("alert").textContent).toContain("hidden"); expect(receipt).not.toHaveBeenCalled();
});
