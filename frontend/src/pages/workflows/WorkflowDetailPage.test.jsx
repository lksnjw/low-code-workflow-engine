/** @jest-environment jsdom */
import React from "react";
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { workflowService } from "../../services/workflow.service";

let permissions = ["workflow:write", "chat:use"];
const navigateTo = jest.fn(), refetch = jest.fn();
const runWorkflow = jest.fn();
const workflow = { id: "saved-flow", name: "Saved report", description: "Existing reviewed source", owner: "Owner", status: "published", steps: 2,
  yaml: "must not be copied into an authoring handoff", draftVersion: 4 };
jest.unstable_mockModule("@xyflow/react", () => ({ MarkerType: { ArrowClosed: "arrow-closed" } }));
jest.unstable_mockModule("../../context/RouteContext", () => ({ useRoute: () => ({ selectedWorkflowId: workflow.id, navigateTo }) }));
jest.unstable_mockModule("../../hooks/usePermissions", () => ({ default: () => ({ has: permission => permissions.includes(permission), actorId: "owner" }) }));
jest.unstable_mockModule("../../hooks/useWorkflows", () => ({ useWorkflow: () => ({ data: workflow, refetch }) }));
jest.unstable_mockModule("../../hooks/useWorkflowDetailRun", () => ({ useWorkflowDetailRun: () => ({ state: {}, recovery: {}, run: runWorkflow }) }));
for (const path of ["../../components/workflows/WorkflowActions", "../../components/workflows/WorkflowAssignments", "../../components/canvas/WorkflowBuilderCanvas",
  "../../components/workflows/PendingGenerationApprovalCard", "../../components/workflows/WorkflowSchedulePanel", "../../components/workflows/WorkflowRunReceipt",
  "../../components/executions/RunAdmissionRecoveryPanel"]) jest.unstable_mockModule(path, () => ({ default: () => null }));
const { default: WorkflowDetailPage } = await import("./WorkflowDetailPage");
const { peekWorkflowForChatEdit } = await import("../../utils/workflowCanvas.utils");
function Location() { const location = useLocation(); return <output aria-label="Current route">{location.pathname}{location.search}</output>; }
function open() { return render(<MemoryRouter initialEntries={["/workflows/saved-flow"]}><WorkflowDetailPage /><Location /></MemoryRouter>); }
beforeEach(() => { jest.spyOn(workflowService, "readiness").mockResolvedValue({ workflowId: workflow.id, version: 4, publishedVersion: 3, can_attempt_run: true, authoring: {} }); runWorkflow.mockResolvedValue({ id: "run-one" }); });
afterEach(() => { cleanup(); localStorage.clear(); permissions = ["workflow:write", "chat:use"]; navigateTo.mockClear(); refetch.mockClear(); runWorkflow.mockReset(); jest.restoreAllMocks(); });

test("saved workflow opens the chat editor by identity, never a stale source copy or execution", () => {
  open(); fireEvent.click(screen.getByRole("button", { name: "Edit in chat" }));
  expect(screen.getByLabelText("Current route").textContent).toMatch(/^\/chat\?new=1&creation=[a-f0-9-]{36}&workflow=saved-flow$/);
  expect(peekWorkflowForChatEdit()).toEqual({ workflowId: "saved-flow", workflowName: "Saved report" });
  expect(navigateTo).not.toHaveBeenCalled(); expect(refetch).not.toHaveBeenCalled();
});
test.each([["workflow:write"], ["chat:use"], []])("chat authoring entry requires both permissions: %j", (...values) => {
  permissions = values; open(); expect(screen.queryByRole("button", { name: "Edit in chat" })).toBeNull();
  expect(peekWorkflowForChatEdit()).toBeNull();
});
test("the builder action is labelled as a preview and preserves its existing destination", () => {
  open(); fireEvent.click(screen.getByRole("button", { name: "Preview canvas" }));
  expect(navigateTo).toHaveBeenCalledWith("workflows", "builder"); expect(peekWorkflowForChatEdit()).toBeNull();
});

test("the main run button checks runtime requirements without admitting a run on open or cancel", async () => {
  permissions.push("workflow:run"); open();
  fireEvent.click(screen.getByRole("button", { name: "Run Workflow" }));
  fireEvent.click(await screen.findByText("Advanced input"));
  expect(screen.getByLabelText("Runtime input (JSON)").value).toBe("{}");
  expect(runWorkflow).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByLabelText("Runtime input (JSON)")).toBeNull();
  expect(runWorkflow).not.toHaveBeenCalled();
});

test("invalid JSON and non-object input never start the workflow; valid input is forwarded exactly", async () => {
  permissions.push("workflow:run"); open();
  fireEvent.click(screen.getByRole("button", { name: "Run Workflow" }));
  fireEvent.click(await screen.findByText("Advanced input"));
  const input = screen.getByLabelText("Runtime input (JSON)");
  fireEvent.change(input, { target: { value: "{" } });
  expect(screen.getByRole("button", { name: "Start workflow" }).disabled).toBe(true);
  expect(screen.getByRole("status", { name: "Required run inputs" }).textContent).toContain("not valid JSON");
  for (const value of ["[]", "null", '"yes"', "true"]) {
    fireEvent.change(input, { target: { value } });
    expect(screen.getByRole("button", { name: "Start workflow" }).disabled).toBe(true);
    expect(screen.getByRole("status", { name: "Required run inputs" }).textContent).toContain("must be an object");
  }
  expect(runWorkflow).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: '{"recordReviewReceipt":false}' } });
  fireEvent.click(screen.getByRole("button", { name: "Start workflow" }));
  expect(runWorkflow).toHaveBeenCalledTimes(1);
  expect(runWorkflow).toHaveBeenCalledWith({ recordReviewReceipt: false });
  await screen.findByRole("button", { name: "Run Workflow" });
});

test("results have a dedicated visible section before scheduling and required fields open as labelled controls", async () => {
  workflowService.readiness.mockResolvedValue({ workflowId: workflow.id, publishedVersion: 3, can_attempt_run: true, authoring: { inputSchema: { type: "object", required: ["customer_name"], properties: { customer_name: { type: "string" } } } } });
  permissions.push("workflow:run"); open();
  expect(screen.getByRole("region", { name: "Workflow results" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Run Workflow" }));
  const name = await screen.findByLabelText("Customer name");
  expect(name.value).toBe(""); expect(screen.getByRole("button", { name: "Start workflow" }).disabled).toBe(true);
  fireEvent.change(name, { target: { value: "Example customer" } });
  fireEvent.click(screen.getByRole("button", { name: "Start workflow" }));
  expect(runWorkflow).toHaveBeenCalledWith({ customer_name: "Example customer" });
  await screen.findByRole("button", { name: "Run Workflow" });
});
