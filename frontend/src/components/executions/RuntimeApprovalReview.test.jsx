/** @jest-environment jsdom */
import React from "react";
import { jest, test, expect, afterEach, beforeEach } from "@jest/globals";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import RuntimeApprovalReview, { completeApprovalDisplay } from "./RuntimeApprovalReview";
import PendingApprovalCard from "./PendingApprovalCard";
import { executionService } from "../../services/execution.service";
const view = { id: "run", workflowName: "Invoice review", status: "AWAITING_APPROVAL", runtimeApproval: { profile: "runtime-approval/v1", id: "review", version: 1, state: "PENDING",
  reviewHash: `sha256:${"a".repeat(64)}`, toolName: "Fixture report review", remoteToolName: "fixture.review", nodeId: "send", invocationId: "attempt", connectionId: "erpbridge-default", capabilityRevision: "revision", requesterId: "employee", approverRole: "Manager",
  reason: "Review exact recipient and content", expiresAt: "2026-10-06T15:00:00.000Z", arguments: { recipient: "manager@example.test", subject: "Invoices", body: "Reviewed report" },
  canDecide: true, canResume: false, resumeReason: "Approval alone does not execute or send." } };
const receipt = { approvalId: "review", executionId: "run", state: "APPROVED", version: 2, canResume: false };
beforeEach(() => { Object.defineProperty(crypto, "randomUUID", { configurable: true, value: jest.fn(() => "decision-command-00000001") }); });
afterEach(() => { cleanup(); jest.restoreAllMocks(); });
const acknowledge = () => fireEvent.click(screen.getByRole("checkbox"));

test("Super Admin self-confirmation is explicit and does not submit when the review opens", () => {
  const save = jest.spyOn(executionService, "approve").mockResolvedValue(receipt);
  render(<RuntimeApprovalReview execution={{ ...view, runtimeApproval: { ...view.runtimeApproval, selfApprovalAllowed: true } }} onReload={jest.fn()} />);
  expect(screen.getByText(/As Super Admin, you may confirm your own exact transaction/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Record approval" }).disabled).toBe(true);
  expect(save).not.toHaveBeenCalled();
});
test("business arguments are formatted and affirmative review sends exact binding, not an approval note alone", async () => {
  const save = jest.spyOn(executionService, "approve").mockResolvedValue(receipt), reload = jest.fn().mockResolvedValue(view);
  render(<RuntimeApprovalReview execution={view} onReload={reload} />);
  const button = screen.getByRole("button", { name: "Record approval" }); expect(button.disabled).toBe(true);
  expect(screen.getByText("manager@example.test")).toBeTruthy(); expect(screen.getByText("Reviewed report")).toBeTruthy();
  expect(screen.getByText("fixture.review")).toBeTruthy();
  expect(screen.queryByText(/\{"recipient"/)).toBeNull();
  fireEvent.change(screen.getByRole("textbox", { name: "Decision note" }), { target: { value: "Exact review" } }); acknowledge(); fireEvent.click(button);
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  expect(save).toHaveBeenCalledWith("run", { approvalId: "review", baseVersion: 1, reviewHash: view.runtimeApproval.reviewHash, decisionKey: "decision-command-00000001", note: "Exact review" });
  await screen.findByText(/Exact approval saved/); expect(screen.getByRole("status").textContent).toMatch(/not resumed, sent or completed/);
  expect(reload).toHaveBeenCalledTimes(1); expect(button.disabled).toBe(true);
});
test("rejection needs explicit confirmation and records a decision rather than a fabricated execution result", async () => {
  const save = jest.spyOn(executionService, "reject").mockResolvedValue({ ...receipt, state: "REJECTED" });
  render(<RuntimeApprovalReview execution={view} onReload={jest.fn().mockResolvedValue(view)} />);
  fireEvent.click(screen.getByRole("button", { name: "Reject transaction" })); expect(save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Confirm rejection" })); await screen.findByText(/Exact transaction rejected/);
  expect(save).toHaveBeenCalledTimes(1); expect(screen.getByRole("status").textContent).toMatch(/checkpoint did not dispatch/);
});
test.each([undefined, 403, 409, 422, 503])("a %s decision failure keeps one request and locks until explicit authoritative reload", async status => {
  const save = jest.spyOn(executionService, "approve").mockRejectedValue(status ? { response: { status, data: { message: "Approval unavailable" } } } : new Error("Network lost"));
  const reload = jest.fn().mockResolvedValue(view); render(<RuntimeApprovalReview execution={view} onReload={reload} />);
  acknowledge(); fireEvent.click(screen.getByRole("button", { name: "Record approval" }));
  await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
  expect(screen.getByRole("button", { name: "Record approval" }).disabled).toBe(true); expect(save).toHaveBeenCalledTimes(1); expect(reload).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Reload exact review" })); await screen.findByText(/Authoritative review reloaded/);
  expect(save).toHaveBeenCalledTimes(1); expect(reload).toHaveBeenCalledTimes(1);
});
test("a confirmed decision followed by refresh failure is not described as a failed or retried save", async () => {
  const save = jest.spyOn(executionService, "approve").mockResolvedValue(receipt);
  render(<RuntimeApprovalReview execution={view} onReload={jest.fn().mockRejectedValue(new Error("Refresh offline"))} />);
  acknowledge(); fireEvent.click(screen.getByRole("button", { name: "Record approval" })); await screen.findByText(/Decision was acknowledged/);
  expect(screen.getByRole("button", { name: "Record approval" }).disabled).toBe(true); expect(save).toHaveBeenCalledTimes(1);
});
test("changed/expired server review and incomplete payload display cannot be approved", () => {
  const first = render(<RuntimeApprovalReview execution={{ ...view, runtimeApproval: { ...view.runtimeApproval, canDecide: false, unavailable: "Approval expired" } }} />);
  expect(screen.getByRole("alert").textContent).toBe("Approval expired"); expect(screen.getByRole("button", { name: "Record approval" }).disabled).toBe(true); first.unmount();
  render(<RuntimeApprovalReview execution={{ ...view, runtimeApproval: { ...view.runtimeApproval, arguments: { body: "x".repeat(12001) } } }} />);
  expect(screen.getByText(/shortened preview is not a full transaction review/)).toBeTruthy(); expect(screen.getByRole("button", { name: "Record approval" }).disabled).toBe(true);
});
test("display limits cover nested, many-field, non-finite and oversized values", () => {
  expect(completeApprovalDisplay(view.runtimeApproval.arguments)).toBe(true);
  expect(completeApprovalDisplay({ value: Number.NaN })).toBe(false);
  expect(completeApprovalDisplay(Array.from({ length: 26 }, () => 1))).toBe(false);
  let nested = {}; for (let n = 0; n < 8; n++) nested = { nested }; expect(completeApprovalDisplay(nested)).toBe(false);
});
test("a missing exact tool identity cannot be substituted by a node name", () => {
  render(<RuntimeApprovalReview execution={{ ...view, runtimeApproval: { ...view.runtimeApproval, remoteToolName: null } }} />);
  expect(screen.getByText(/node label alone does not identify an operation/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Record approval" }).disabled).toBe(true);
});
test("legacy pending approval has no resume or approve button, while exact records link to a scoped review", () => {
  const legacy = render(<MemoryRouter><PendingApprovalCard execution={{ id: "run", pendingApproval: { description: "Old unbound checkpoint" } }} /></MemoryRouter>);
  expect(screen.queryByRole("button")).toBeNull(); expect(screen.getByText(/Safe runtime resume is unavailable/)).toBeTruthy(); legacy.unmount();
  render(<MemoryRouter><PendingApprovalCard execution={{ id: "run", hasRuntimeApproval: true }} /></MemoryRouter>);
  expect(screen.getByRole("link", { name: "Review exact transaction" }).getAttribute("href")).toBe("/executions/run?view=approval");
});

test("managed operation consent authorizes queued execution but its receipt never claims delivery", async () => {
  const operation = { ...view, runtimeApproval: { ...view.runtimeApproval, operationManaged: true, resumeReason: "Approval queues fresh checks, not delivery confirmation." } };
  const save = jest.spyOn(executionService, "approve").mockResolvedValue({ ...receipt, operationManaged: true, resumeQueued: true, executionStatus: "PENDING" });
  render(<RuntimeApprovalReview execution={operation} onReload={jest.fn().mockResolvedValue(operation)} />);
  expect(screen.getByLabelText(/authorize this operation to be queued for fresh checks and execution/)).toBeTruthy();
  expect(screen.queryByText(/understand that approval does not send or execute/)).toBeNull();
  acknowledge(); fireEvent.click(screen.getByRole("button", { name: "Record approval" }));
  await screen.findByText(/operation worker rechecks authority before dispatch/);
  expect(screen.getByRole("status").textContent).toMatch(/does not confirm delivery/); expect(save).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "Record approval" }).disabled).toBe(true);
});

const protectedView = () => ({ ...view, runtimeApproval: { ...view.runtimeApproval, profile: "protected-approval/v1", invocationId: "each/1/nested/0/send",
  iterations: [{ loopId: "each", index: 1 }, { loopId: "nested", index: 0 }], sourceHash: `sha256:${"b".repeat(64)}`, semanticHash: `sha256:${"c".repeat(64)}`,
  requestedAt: "2026-10-06T14:59:00.000Z", unavailable: null, protectedInvocationManaged: true, operationManaged: false, resumeQueued: false,
  decision: null, closure: null, expiredAt: null } });

test("protected review displays the nested selected item and formatted arguments; consent records no effect resumption", async () => {
  const item = protectedView(), save = jest.spyOn(executionService, "approve").mockResolvedValue({ ...receipt, protectedInvocationManaged: true,
    operationManaged: false, executionStatus: "BLOCKED", resumeQueued: false });
  render(<RuntimeApprovalReview execution={item} onReload={jest.fn().mockResolvedValue(item)} />);
  expect(screen.getByRole("heading", { name: "Selected workflow item" })).toBeTruthy();
  expect(screen.getByText("each · item 2 → nested · item 1")).toBeTruthy();
  expect(screen.getByText(/not other items/)).toBeTruthy(); expect(screen.queryByText(/\{"recipient"/)).toBeNull();
  acknowledge(); fireEvent.click(screen.getByRole("button", { name: "Record approval" }));
  await screen.findByText(/Exact approval saved/); expect(save).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("status").textContent).toMatch(/not resumed, sent or completed/);
});

test.each(["APPROVED", "EXPIRED", "CLOSED"])("protected %s history never offers a decision or claims delivery", state => {
  const item = protectedView(), review = item.runtimeApproval;
  Object.assign(review, { state, version: 2, canDecide: false });
  if (state === "APPROVED") { item.status = "BLOCKED"; review.decision = { outcome: "APPROVED", actorId: "reviewer", decidedAt: "2026-10-06T14:59:10.000Z" }; }
  if (state === "EXPIRED") { item.status = "FAILED"; review.expiredAt = review.expiresAt; }
  if (state === "CLOSED") { item.status = "CANCELLED"; review.closure = { reason: "PROTECTED_APPROVAL_CANCELLED", status: "CANCELLED", closedAt: "2026-10-06T14:59:20.000Z" }; }
  render(<RuntimeApprovalReview execution={item} />);
  expect(screen.getByText(new RegExp(`${state === "APPROVED" ? "Approved" : state === "EXPIRED" ? "Expired" : "Closed"} — not dispatched`))).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Record approval" })).toBeNull();
  expect(screen.queryByRole("checkbox")).toBeNull();
});

test("a mismatched protected item tuple disables consent even if canDecide was supplied", () => {
  const item = protectedView(); item.runtimeApproval.invocationId = "each/0/nested/0/send";
  render(<RuntimeApprovalReview execution={item} />);
  expect(screen.getByRole("alert").textContent).toMatch(/workflow item or review lifecycle is incomplete/);
  expect(screen.getByRole("button", { name: "Record approval" }).disabled).toBe(true);
  expect(screen.getByRole("checkbox").disabled).toBe(true);
});
