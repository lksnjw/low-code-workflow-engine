/** @jest-environment jsdom */
import React from "react";
import { jest, test, expect, afterEach } from "@jest/globals";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
const permissions = { actorId: "owner", hasAny: jest.fn(() => true) };
jest.unstable_mockModule("../../hooks/usePermissions", () => ({ usePermissions: () => permissions }));
const { default: ChatRunRecovery } = await import("./ChatRunRecovery");
const { executionService } = await import("../../services/execution.service");
const run = { id: "original", status: "FAILED", failure: { category: "READ_EXECUTION_FAILED", nodeId: "lookup" }, retryReview: { allowed: true } };
const status = { profile: "chat-workspace-status/v1", workflows: [{ id: "workflow", latestRun: run }] };
afterEach(() => { cleanup(); jest.restoreAllMocks(); permissions.hasAny.mockReturnValue(true); });
test("chat offers review, fetches current original evidence and requires explicit retry confirmation", async () => {
  jest.spyOn(executionService, "get").mockResolvedValue({ id: "original", workflowId: "workflow", status: "FAILED", retryAdmission: { allowed: true } });
  jest.spyOn(executionService, "retry").mockResolvedValue({ id: "child", workflowId: "workflow" });
  render(<ChatRunRecovery status={status} />); expect(executionService.get).not.toHaveBeenCalled(); expect(executionService.retry).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Review retry in chat" })); await screen.findByRole("button", { name: "Review retry" });
  expect(executionService.get).toHaveBeenCalledWith("original"); fireEvent.click(screen.getByRole("button", { name: "Review retry" }));
  expect(screen.getByRole("button", { name: "Start new execution" }).disabled).toBe(true);
  fireEvent.click(screen.getByRole("checkbox")); fireEvent.click(screen.getByRole("button", { name: "Start new execution" }));
  expect((await screen.findByRole("link", { name: /Open new execution/ })).getAttribute("href")).toBe("/executions/child");
  expect(executionService.retry).toHaveBeenCalledTimes(1); expect(executionService.retry).toHaveBeenCalledWith("original", false);
});
test("stale invitation cannot authorize a retry after current evidence denies it", async () => {
  jest.spyOn(executionService, "get").mockResolvedValue({ id: "original", workflowId: "workflow", status: "FAILED", retryAdmission: { allowed: false, reason: "A write may already have happened" } });
  jest.spyOn(executionService, "retry").mockResolvedValue({}); render(<ChatRunRecovery status={status} />);
  fireEvent.click(screen.getByRole("button", { name: "Review retry in chat" })); await screen.findByText(/write may already have happened/);
  expect(screen.queryByRole("button", { name: "Review retry" })).toBeNull(); expect(executionService.retry).not.toHaveBeenCalled();
});
test("a read-only reviewer sees evidence but no retry control", () => {
  permissions.hasAny.mockReturnValue(false); render(<ChatRunRecovery status={status} />);
  expect(screen.getByRole("link", { name: /View execution original/ })).toBeTruthy(); expect(screen.queryByRole("button")).toBeNull();
});
test("malformed identities and forged artifact profiles cannot create recovery controls", () => {
  const view = render(<ChatRunRecovery status={{ ...status, profile: "model-retry-proposal" }} />); expect(view.container.textContent).toBe("");
  view.rerender(<ChatRunRecovery status={{ ...status, workflows: [{ id: "workflow", latestRun: { ...run, id: "https://attacker.test" } }] }} />);
  expect(view.container.textContent).toBe("");
});
