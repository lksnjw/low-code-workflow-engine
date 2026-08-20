/** @jest-environment jsdom */

import { afterEach, expect, test } from "@jest/globals";
import { cleanup, render, screen } from "@testing-library/react";
import React from "react";
import ExecutionStatus from "../executions/ExecutionStatus.jsx";
import WorkflowBadge from "./WorkflowBadge.jsx";

afterEach(cleanup);

test("unknown execution and workflow statuses render the raw value with neutral styling", () => {
  const { unmount } = render(<ExecutionStatus status="CANCELLED" />);
  const executionStatus = screen.getByTestId("execution-status");
  expect(executionStatus.textContent).toBe("CANCELLED");
  expect(executionStatus.className).toMatch(/bg-gray-100/);
  expect(executionStatus.textContent).not.toMatch(/Pending/i);
  unmount();

  render(<WorkflowBadge status="ARCHIVED" />);
  const workflowStatus = screen.getByText("ARCHIVED");
  expect(workflowStatus.className).toMatch(/bg-gray-100/);
  expect(screen.queryByText("Pending")).toBeNull();
});
