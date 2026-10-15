/** @jest-environment jsdom */
import React from "react";
import { afterEach, expect, jest, test } from "@jest/globals";
import { cleanup, fireEvent, render, screen, waitFor, act } from "@testing-library/react";
import { workflowService } from "../../services/workflow.service";
import WorkflowRunDialog from "./WorkflowRunDialog";
import { workflowRunInputIssues } from "./workflowRunInput";

const schema = { type: "object", required: ["customer_name", "quantity", "reviewed", "territory"], additionalProperties: false, properties: {
  customer_name: { type: "string", title: "Customer name" }, quantity: { type: "integer", minimum: 0 }, reviewed: { type: "boolean" }, territory: { type: "string", enum: ["Sri Lanka", "Rest Of The World"] }, note: { type: "string" },
} };
const ready = { workflowId: "wf", publishedVersion: 3, version: 3, can_attempt_run: true, authoring: { inputSchema: schema } };
afterEach(() => { cleanup(); jest.restoreAllMocks(); });
const mount = props => render(<WorkflowRunDialog open workflowId="wf" initialRecord={ready} onClose={jest.fn()} onRun={jest.fn()} {...props} />);
const fill = () => {
  fireEvent.change(screen.getByLabelText("Customer name"), { target: { value: "New Customer" } });
  fireEvent.change(screen.getByLabelText("Quantity"), { target: { value: "0" } });
  fireEvent.change(screen.getByLabelText("Reviewed"), { target: { value: "false" } });
  fireEvent.change(screen.getByLabelText("Territory"), { target: { value: "0" } });
};

test.each([true, false])("missing reviewers give an actionable settings route for administrator=%s without admission", admin => {
  const onRun = jest.fn();
  mount({ onRun, initialRecord: { ...ready, can_attempt_run: false, approval_setup_required: true, can_manage_approval_policy: admin,
    issues: ["Transaction reviewers are not configured. Configure independent approval in Settings."] } });
  expect(screen.getByRole("button", { name: "Start workflow" }).disabled).toBe(true);
  if (admin) expect(screen.getByRole("link", { name: "Configure transaction reviewers in Settings" }).getAttribute("href")).toBe("/settings");
  else { expect(screen.queryByRole("link", { name: /Configure transaction reviewers/ })).toBeNull(); expect(screen.getByText("Ask your administrator to configure transaction reviewers in Settings.")).toBeTruthy(); }
  expect(onRun).not.toHaveBeenCalled();
});

test("required fields are visible immediately, with no invented defaults or admission on open/cancel", async () => {
  const onRun = jest.fn(), onClose = jest.fn(); mount({ onRun, onClose });
  expect(await screen.findByRole("dialog", { name: "Run workflow" })).toBeTruthy();
  expect(screen.getByLabelText("Quantity").value).toBe(""); expect(screen.getByLabelText("Reviewed").value).toBe("");
  expect(screen.getByRole("button", { name: "Start workflow" }).disabled).toBe(true);
  expect(screen.getByRole("status", { name: "Required run inputs" }).textContent).toContain("Customer name is required");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" })); expect(onClose).toHaveBeenCalledTimes(1); expect(onRun).not.toHaveBeenCalled();
});

test("typed zero and No are valid values; an exact single explicit submission closes after a known run ID", async () => {
  let finish; const onRun = jest.fn(() => new Promise(resolve => { finish = resolve; })), onClose = jest.fn(); mount({ onRun, onClose }); fill();
  const start = screen.getByRole("button", { name: "Start workflow" }); expect(start.disabled).toBe(false); fireEvent.click(start); fireEvent.click(start);
  expect(onRun).toHaveBeenCalledTimes(1); expect(onRun).toHaveBeenCalledWith({ customer_name: "New Customer", quantity: 0, reviewed: false, territory: "Sri Lanka" });
  expect(onClose).not.toHaveBeenCalled(); await act(async () => finish({ id: "run-one" })); expect(onClose).toHaveBeenCalledTimes(1);
});

test("definite failure retains inputs and an unknown result is not presented as a completed run", async () => {
  const onRun = jest.fn().mockResolvedValue(null), onClose = jest.fn(); mount({ onRun, onClose }); fill();
  fireEvent.click(screen.getByRole("button", { name: "Start workflow" })); await screen.findByText(/The run was not confirmed/);
  expect(screen.getByLabelText("Customer name").value).toBe("New Customer"); expect(onClose).not.toHaveBeenCalled(); expect(onRun).toHaveBeenCalledTimes(1);
});

test("popup loads authoritative requirements once; late results after close cannot populate another review", async () => {
  let finish; jest.spyOn(workflowService, "readiness").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const props = { workflowId: "wf", onClose: jest.fn(), onRun: jest.fn() };
  const view = render(<WorkflowRunDialog open {...props} />); expect(screen.getByRole("status").textContent).toContain("Checking");
  view.rerender(<WorkflowRunDialog open={false} {...props} />); await act(async () => finish(ready));
  expect(screen.queryByRole("dialog")).toBeNull(); expect(workflowService.readiness).toHaveBeenCalledTimes(1); expect(props.onRun).not.toHaveBeenCalled();
});

test("blocked publication cannot run even after every visible field is completed", () => {
  const onRun = jest.fn(); mount({ initialRecord: { ...ready, can_attempt_run: false }, onRun }); fill();
  expect(screen.getByRole("alert").textContent).toContain("not ready to run"); expect(screen.getByRole("button", { name: "Start workflow" }).disabled).toBe(true); expect(onRun).not.toHaveBeenCalled();
});

test("blocked run explains saved requirements and offers chat help without submitting or inventing fields", () => {
  const onRun = jest.fn(), onHelp = jest.fn(), onReview = jest.fn();
  mount({ initialRecord: { ...ready, can_attempt_run: false, publishedVersion: 0, published: false, bridge: "not_connected", compilation: { state: "NOT_PUBLISHED" }, authoring: {},
    yaml: "name: Registration\nsteps: []\nmetadata:\n  unresolved_requirements:\n    - A customer territory is still required", validation: { errors: ["Required steps are missing"] } }, onRun, onHelp, onReview });
  expect(screen.getByRole("region", { name: "What to fix before running" }).textContent).toContain("A customer territory is still required");
  expect(screen.getByText(/This draft has not been published/)).toBeTruthy();
  expect(screen.queryByLabelText("Runtime input (JSON)")).toBeNull();
  expect(screen.queryByText(/Check your ERP connection in Profile/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Help me fix this in chat" }));
  expect(onHelp).toHaveBeenCalledWith(expect.stringContaining("A customer territory is still required"));
  fireEvent.click(screen.getByRole("button", { name: "Review steps and publication" }));
  expect(onReview).toHaveBeenCalledTimes(1); expect(onRun).not.toHaveBeenCalled();
});

test("Check again refreshes run blockers while preserving the business inputs already entered", async () => {
  const onRun = jest.fn(), onReadinessChanged = jest.fn();
  jest.spyOn(workflowService, "readiness").mockResolvedValue(ready);
  mount({ initialRecord: { ...ready, can_attempt_run: false, publishedVersion: 0 }, onRun, onReadinessChanged }); fill();
  fireEvent.click(screen.getByRole("button", { name: "Check again" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Start workflow" }).disabled).toBe(false));
  expect(screen.getByLabelText("Customer name").value).toBe("New Customer");
  expect(onReadinessChanged).toHaveBeenCalledWith(ready); expect(onRun).not.toHaveBeenCalled();
});

test("advanced malformed and non-object JSON cannot submit stale input", async () => {
  mount({ initialRecord: { ...ready, authoring: {} } }); fireEvent.click(screen.getByText("Advanced input"));
  fireEvent.change(screen.getByLabelText("Runtime input (JSON)"), { target: { value: "{" } });
  expect(screen.getByRole("button", { name: "Start workflow" }).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Runtime input (JSON)"), { target: { value: "[]" } });
  expect(screen.getByRole("button", { name: "Start workflow" }).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Runtime input (JSON)"), { target: { value: "{}" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "Start workflow" }).disabled).toBe(false));
});

test("nested inputs, choices and real dates are validated without treating zero/false as missing", () => {
  expect(workflowRunInputIssues(schema, { customer_name: "A", quantity: 0, reviewed: false, territory: "Sri Lanka" })).toEqual([]);
  expect(workflowRunInputIssues(schema, { customer_name: " ", quantity: -1, reviewed: "false", territory: "invented" }).length).toBe(4);
  expect(workflowRunInputIssues({ type: "object", properties: { date: { type: "string", format: "date" } } }, { date: "2026-02-30" })).toHaveLength(1);
});
