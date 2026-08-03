/** @jest-environment jsdom */

import { afterEach, expect, test } from "@jest/globals";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import ExecutionOutputPanel from "./ExecutionOutputPanel";

afterEach(cleanup);

const doneExecution = {
  id: "run-1",
  status: "DONE",
  finalOutput: { invoiceId: "INV-42", cleared: true },
  stepOutputs: { classify: { category: "utilities" }, clear: { invoiceId: "INV-42", cleared: true } },
};

const failedExecution = {
  id: "run-2",
  status: "FAILED",
  finalOutput: { vendorId: "V-1", valid: true },
  stepOutputs: { validate: { vendorId: "V-1", valid: true } },
  failure: {
    failureCategory: "TOOL_FAILURE",
    failedStepId: "create",
    failedToolName: "procurement.create_purchase_order",
    toolWasCalled: true,
  },
};

test("a DONE execution renders its final output", () => {
  render(<ExecutionOutputPanel execution={doneExecution} />);

  const final = screen.getByTestId("final-output");
  expect(final.textContent).toMatch(/Final output/);
  expect(final.textContent).toMatch(/INV-42/);
  expect(final.textContent).toMatch(/"cleared": true/);
  // Every step output is listed too.
  expect(screen.getByTestId("step-outputs").textContent).toMatch(/classify/);
  expect(screen.getByTestId("step-outputs").textContent).toMatch(/utilities/);
  // A completed run is not labelled partial.
  expect(screen.queryByTestId("partial-output-badge")).toBeNull();
});

test("a FAILED execution still renders the partial output it produced", () => {
  render(<ExecutionOutputPanel execution={failedExecution} />);

  expect(screen.getByTestId("partial-output-badge").textContent).toMatch(/Partial/);
  const final = screen.getByTestId("final-output");
  expect(final.textContent).toMatch(/Last completed step/);
  expect(final.textContent).toMatch(/V-1/);
  expect(screen.getByTestId("step-outputs").textContent).toMatch(/validate/);
});

test("an execution with no output says so instead of rendering an empty box", () => {
  render(<ExecutionOutputPanel execution={{ id: "run-3", status: "FAILED" }} />);
  expect(screen.getByTestId("no-output").textContent).toMatch(/did not produce an output/i);
  expect(screen.queryByTestId("final-output")).toBeNull();
});

test("a large output is truncated with a view-full affordance and does not crash", () => {
  const big = { rows: Array.from({ length: 4000 }, (_, index) => ({ index, value: `row-${index}` })) };
  render(<ExecutionOutputPanel execution={{ id: "run-4", status: "DONE", finalOutput: big }} />);

  const block = screen.getAllByTestId("output-block")[0];
  expect(block.textContent.length).toBeLessThan(2100);
  expect(block.textContent.endsWith("…")).toBe(true);

  const toggle = screen.getByRole("button", { name: /View full output/i });
  fireEvent.click(toggle);
  expect(screen.getAllByTestId("output-block")[0].textContent.length).toBeGreaterThan(2100);
  expect(screen.getByRole("button", { name: /Show less/i })).not.toBeNull();
});
