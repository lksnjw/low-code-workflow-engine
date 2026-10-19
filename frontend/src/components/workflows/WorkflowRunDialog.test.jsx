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

test("complete inputs can submit Start despite a stale readiness flag", async () => {
  const onRun = jest.fn().mockResolvedValue({ id: "run-one" });
  mount({ initialRecord: { ...ready, can_attempt_run: false }, onRun }); fill();
  expect(screen.queryByRole("region", { name: "What to fix before running" })).toBeNull();
  expect(screen.queryByText("Technical details")).toBeNull();
  expect(screen.getByRole("button", { name: "Start workflow" }).disabled).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Start workflow" }));
  await waitFor(() => expect(onRun).toHaveBeenCalledTimes(1));
});

test("saved technical blockers and publication controls are absent from the input form", () => {
  mount({ initialRecord: { ...ready, can_attempt_run: false, publishedVersion: 0, published: false,
    yaml: "name: Registration\nsteps: []\nmetadata:\n  unresolved_requirements:\n    - Old generated readiness note", validation: { errors: ["Write workflow requires audit.write_audit_log."] } } });
  expect(screen.queryByText(/Old generated readiness note/)).toBeNull();
  expect(screen.queryByText(/audit.write_audit_log/)).toBeNull();
  expect(screen.queryByRole("button", { name: /publish|Check again|Recheck run readiness/i })).toBeNull();
  expect(screen.getByText(/This workflow is saved/)).toBeTruthy();
  fill(); expect(screen.getByRole("button", { name: "Start workflow" }).disabled).toBe(false);
});

test("a backend rejection after Start keeps entered inputs for correction and a new explicit attempt", async () => {
  const onRun = jest.fn().mockRejectedValue({ response: { data: { message: "Customer group is unavailable" } } });
  mount({ initialRecord: { ...ready, can_attempt_run: false }, onRun }); fill();
  fireEvent.click(screen.getByRole("button", { name: "Start workflow" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Customer group is unavailable");
  expect(screen.getByLabelText("Customer name").value).toBe("New Customer");
  expect(onRun).toHaveBeenCalledTimes(1);
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


test("validated draft starts with entered fields without publication controls", async () => {
  const onRun = jest.fn().mockResolvedValue({ id: "run-draft" }), publish = jest.fn();
  mount({ onRun, onPublishReviewed: publish, initialRecord: { ...ready, publishedVersion: 0, published: false, validation: { passed: true }, start_revision: { baseVersion: 1, baseHash: `sha256:${"a".repeat(64)}` } } });
  fill(); expect(screen.queryByRole("button", { name: /Review & publish/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Start workflow" }));
  await waitFor(() => expect(onRun).toHaveBeenCalledTimes(1)); expect(publish).not.toHaveBeenCalled();
});


test("the same saved workflow can reopen with fresh inputs for another explicit run", async () => {
  const onRun = jest.fn().mockResolvedValue({ id: "run-one" }), onClose = jest.fn();
  const props = { workflowId: "wf", initialRecord: { ...ready, can_attempt_run: false }, onRun, onClose };
  const view = render(<WorkflowRunDialog open {...props} />); fill();
  fireEvent.click(screen.getByRole("button", { name: "Start workflow" }));
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  view.rerender(<WorkflowRunDialog open={false} {...props} />);
  view.rerender(<WorkflowRunDialog open {...props} />);
  expect(screen.getByLabelText("Customer name").value).toBe("");
  fill(); fireEvent.change(screen.getByLabelText("Customer name"), { target: { value: "Another customer" } });
  fireEvent.click(screen.getByRole("button", { name: "Start workflow" }));
  await waitFor(() => expect(onRun).toHaveBeenCalledTimes(2));
  expect(onRun.mock.calls[1][0]).toMatchObject({ customer_name: "Another customer" });
});
