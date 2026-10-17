/** @jest-environment jsdom */
import React from "react";
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import { cleanup, fireEvent, render, screen, waitFor, within, act } from "@testing-library/react";
import ChatWorkspaceLayout from "./ChatWorkspaceLayout";
import WorkflowRunApproval from "./WorkflowRunApproval";
import { executionService } from "../../services/execution.service";
import { transitionAuthority } from "../../utils/authAuthority";

const run = { id: "run", workflowId: "orders", workflowName: "Order review", status: "AWAITING_APPROVAL", hasRuntimeApproval: true };
const exact = { ...run, runtimeApproval: { profile: "runtime-approval/v1", id: "approval", version: 1, reviewHash: `sha256:${"a".repeat(64)}`, state: "PENDING", toolName: "Create order", remoteToolName: "orders.create", nodeId: "create", invocationId: "attempt", requesterId: "requester", connectionId: "erp", capabilityRevision: "rev-1", approverRole: "Manager", expiresAt: "2026-10-18T00:00:00Z", reason: "Check this exact order", resumeReason: "Current policy applies.", canDecide: true, canResume: false, operationManaged: true, arguments: { customer: "LOCAL test customer", quantity: 2 } } };
const receipt = { approvalId: "approval", executionId: "run", state: "APPROVED", version: 2, canResume: false, operationManaged: true };
beforeEach(() => {
  transitionAuthority({ id: "reviewer", role: "Manager", permissions: ["execution:approve"] });
  jest.spyOn(executionService, "getApproval").mockResolvedValue(exact);
  Object.defineProperty(crypto, "randomUUID", { configurable: true, value: jest.fn(() => "exact-decision-command") });
});
afterEach(() => { cleanup(); sessionStorage.clear(); jest.restoreAllMocks(); transitionAuthority(null); });
const mount = (props = {}) => render(<ChatWorkspaceLayout storageKey="approval.layout" chat={<textarea aria-label="Message to workflow assistant" />} canvas={<WorkflowRunApproval execution={run} {...props} />} />);
const open = async (pane = "chat") => {
  fireEvent.click(within(screen.getByRole("region", { name: `Workflow human approval — ${pane}` })).getByRole("button", { name: "Review transaction" }));
  return screen.findByRole("region", { name: "Exact transaction review" });
};

test("chat and canvas share one lazy exact review without navigating or running anything", async () => {
  const changed = jest.fn(); mount({ onChanged: changed });
  expect(executionService.getApproval).not.toHaveBeenCalled();
  expect(screen.getAllByRole("button", { name: "Review transaction" })).toHaveLength(2);
  await open();
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  expect(executionService.getApproval).toHaveBeenCalledWith("run", undefined, { signal: expect.any(AbortSignal) });
  expect(screen.getByRole("button", { name: "Record approval" }).disabled).toBe(true);
  expect(screen.getByText("LOCAL test customer")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Close transaction review" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  await open("canvas"); expect(executionService.getApproval).toHaveBeenCalledTimes(2);
});

test("explicit confirmation submits only the exact approval and refreshes saved authority", async () => {
  const approve = jest.spyOn(executionService, "approve").mockResolvedValue(receipt);
  const changed = jest.fn(); mount({ onChanged: changed }); await open();
  expect(approve).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Record approval" }));
  await waitFor(() => expect(approve).toHaveBeenCalledTimes(1));
  expect(approve).toHaveBeenCalledWith("run", expect.objectContaining({ approvalId: "approval", baseVersion: 1, reviewHash: exact.runtimeApproval.reviewHash, decisionKey: "exact-decision-command" }));
  await waitFor(() => expect(executionService.getApproval).toHaveBeenCalledTimes(2));
  expect(changed).toHaveBeenCalled();
});

test("a user without decision authority can inspect but cannot approve or reject", async () => {
  executionService.getApproval.mockResolvedValue({ ...exact, runtimeApproval: { ...exact.runtimeApproval, canDecide: false, unavailable: "This user cannot decide this transaction." } });
  mount(); await open();
  expect(screen.getByRole("button", { name: "Record approval" }).disabled).toBe(true);
  expect(screen.getByRole("button", { name: "Reject transaction" }).disabled).toBe(true);
  expect(screen.getByText("This user cannot decide this transaction.")).toBeTruthy();
});

test("rejection remains a separate confirmed decision in the same workspace", async () => {
  const reject = jest.spyOn(executionService, "reject").mockResolvedValue({ ...receipt, state: "REJECTED" });
  mount(); await open();
  fireEvent.click(screen.getByRole("button", { name: "Reject transaction" })); expect(reject).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Confirm rejection" }));
  await waitFor(() => expect(reject).toHaveBeenCalledTimes(1));
});

test("the dialog remains available when its canvas is hidden in Chat only", async () => {
  mount();
  fireEvent.click(screen.getByRole("button", { name: "Workspace tools", exact: true }));
  fireEvent.click(screen.getByRole("button", { name: "Chat only", exact: true }));
  expect(screen.getByTestId("workspace-canvas-pane").hidden).toBe(true);
  await open("chat"); expect(screen.getByRole("dialog", { name: "Workflow transaction approval" })).toBeTruthy();
});

test("permission failure never leaves old arguments or an enabled decision behind", async () => {
  executionService.getApproval.mockRejectedValue({ response: { status: 403, data: { message: "Review access denied" } } });
  mount();
  fireEvent.click(within(screen.getByRole("region", { name: "Workflow human approval — chat" })).getByRole("button"));
  await screen.findByText("Review access denied");
  expect(screen.queryByText("LOCAL test customer")).toBeNull(); expect(screen.queryByRole("button", { name: "Record approval" })).toBeNull();
  expect(executionService.getApproval).toHaveBeenCalledTimes(1);
});

test("closing aborts a pending read and its late response cannot reopen private review details", async () => {
  let finish; executionService.getApproval.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  mount(); fireEvent.click(within(screen.getByRole("region", { name: "Workflow human approval — chat" })).getByRole("button"));
  await screen.findByText("Loading exact transaction review…");
  const signal = executionService.getApproval.mock.calls[0][2].signal;
  fireEvent.click(screen.getByRole("button", { name: "Close transaction review" }));
  expect(signal.aborted).toBe(true);
  await act(async () => finish(exact));
  expect(screen.queryByText("LOCAL test customer")).toBeNull(); expect(screen.queryByRole("dialog")).toBeNull();
});

test("no run or checkpoint means no review requests and no invented approval", () => {
  mount({ execution: { id: "read", status: "DONE" } });
  expect(screen.queryByText("Human approval needed")).toBeNull(); expect(executionService.getApproval).not.toHaveBeenCalled();
});

test("the next checkpoint in the same run cannot reuse the earlier approved review or its displayed decision", async () => {
  const previous = { ...run, pendingApproval: { stepId: "create", requestedAt: "2026-10-17T10:00:00Z" } };
  executionService.getApproval.mockResolvedValue({ ...exact, runtimeApproval: { ...exact.runtimeApproval, state: "APPROVED", canDecide: false } });
  const view = render(<WorkflowRunApproval execution={previous} />);
  fireEvent.click(screen.getByRole("button", { name: "Review transaction" }));
  await screen.findByText("Human review · approved");
  view.rerender(<WorkflowRunApproval execution={{ ...run, pendingApproval: { stepId: "update", requestedAt: "2026-10-17T11:00:00Z" } }} />);
  expect(screen.queryByRole("dialog")).toBeNull(); expect(screen.queryByText("Human review · approved")).toBeNull();
  expect(screen.getByText("Human approval needed")).toBeTruthy();
  expect(executionService.getApproval).toHaveBeenCalledTimes(1);
});
