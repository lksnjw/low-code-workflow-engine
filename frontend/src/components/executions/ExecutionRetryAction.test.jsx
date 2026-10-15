/** @jest-environment jsdom */
import React from "react";
import { jest, test, expect, afterEach } from "@jest/globals";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import ExecutionRetryAction from "./ExecutionRetryAction";
import { executionService } from "../../services/execution.service";
const source = { id: "failed-run", workflowId: "wf", status: "FAILED", retryAdmission: { allowed: true, requiresUncertaintyAcknowledgement: false } };
afterEach(() => { cleanup(); jest.restoreAllMocks(); });
test("retry is explicit, creates a different run and retains the original", async () => {
  jest.spyOn(executionService, "retry").mockResolvedValue({ id: "new-run", status: "PENDING" }); const onRetried = jest.fn();
  render(<ExecutionRetryAction execution={source} onRetried={onRetried} />);
  expect(executionService.retry).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole("button", { name: "Review retry" }));
  expect(screen.getByRole("button", { name: "Start new execution" }).disabled).toBe(true);
  fireEvent.click(screen.getByRole("checkbox")); fireEvent.click(screen.getByRole("button", { name: "Start new execution" }));
  await waitFor(() => expect(onRetried).toHaveBeenCalledWith({ id: "new-run", status: "PENDING" }));
  expect(executionService.retry).toHaveBeenCalledWith("failed-run", false);
  expect(screen.getByRole("link", { name: /Open new execution/ }).getAttribute("href")).toBe("/executions/new-run");
});
test("unknown read/model outcome requires a second acknowledgement", async () => {
  jest.spyOn(executionService, "retry").mockResolvedValue({ id: "new-run" });
  render(<ExecutionRetryAction execution={{ ...source, status: "RECOVERY_REQUIRED", retryAdmission: { ...source.retryAdmission, requiresUncertaintyAcknowledgement: true } }} />);
  fireEvent.click(screen.getByRole("button", { name: "Review retry" })); const checks = screen.getAllByRole("checkbox");
  fireEvent.click(checks[0]); expect(screen.getByRole("button", { name: "Start new execution" }).disabled).toBe(true);
  fireEvent.click(checks[1]); fireEvent.click(screen.getByRole("button", { name: "Start new execution" }));
  await waitFor(() => expect(executionService.retry).toHaveBeenCalledWith("failed-run", true));
});
test("uncertain write and revoked-authority cases have no retry button", () => {
  render(<ExecutionRetryAction execution={{ ...source, retryAdmission: { allowed: false, reason: "An ERP write may already have happened" } }} />);
  expect(screen.queryByRole("button")).toBeNull(); expect(screen.getByText(/write may already have happened/)).toBeTruthy();
});
test("lost response keeps an explicit same-request recovery action, not automatic resubmission", async () => {
  jest.spyOn(executionService, "retry").mockRejectedValue(Object.assign(new Error("Admission unconfirmed; check the same request"), { runAdmissionUnconfirmed: true }));
  render(<ExecutionRetryAction execution={source} />); fireEvent.click(screen.getByRole("button", { name: "Review retry" }));
  fireEvent.click(screen.getByRole("checkbox")); fireEvent.click(screen.getByRole("button", { name: "Start new execution" }));
  await screen.findByRole("alert"); expect(executionService.retry).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "Check same retry request" })).toBeTruthy();
});
test("preflight rejection does not claim a request entered the server", async () => {
  jest.spyOn(executionService, "retry").mockRejectedValue(Object.assign(new Error("This publication is not ready"), { runAdmissionUnconfirmed: false }));
  render(<ExecutionRetryAction execution={source} />); fireEvent.click(screen.getByRole("button", { name: "Review retry" }));
  fireEvent.click(screen.getByRole("checkbox")); fireEvent.click(screen.getByRole("button", { name: "Start new execution" }));
  await screen.findByRole("alert"); expect(screen.getByRole("button", { name: "Start new execution" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Check same retry request" })).toBeNull(); expect(executionService.retry).toHaveBeenCalledTimes(1);
});
