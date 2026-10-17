/** @jest-environment jsdom */
import React from "react";
import { afterEach, expect, jest, test } from "@jest/globals";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { workflowService } from "../../services/workflow.service";
const notify = jest.fn();
jest.unstable_mockModule("../../context/NotificationContext", () => ({ useNotifications: () => ({ notify }) }));
const { default: PendingGenerationApprovalCard } = await import("./PendingGenerationApprovalCard");
afterEach(() => { cleanup(); notify.mockClear(); jest.restoreAllMocks(); });
test("accepting a build never promises automatic execution or the removal of future human checkpoints", async () => {
  const approve = jest.spyOn(workflowService, "approveGeneration").mockResolvedValue({});
  render(<PendingGenerationApprovalCard pending={{ workflowId: "wf", steps: [{ stepId: "review", description: "Review the customer import" }] }} />);
  expect(screen.getByText(/required human transaction approvals remain separate/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Approve", exact: true }));
  await waitFor(() => expect(approve).toHaveBeenCalledWith("wf", ""));
  await screen.findByText("Build proposal approved — not executed");
  expect(notify).toHaveBeenCalledWith("Build proposal approved. No workflow was started; runtime approvals remain required.", "success");
  expect(screen.queryByText(/autonomously|will not ask again|runs automatically/)).toBeNull();
});
