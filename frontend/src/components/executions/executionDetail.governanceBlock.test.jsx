/** @jest-environment jsdom */

import { expect, test } from "@jest/globals";
import { cleanup, render, screen } from "@testing-library/react";
import React from "react";
import ExecutionStatus from "./ExecutionStatus";
import ExecutionTimeline from "./ExecutionTimeline";
import GovernanceBlockPanel from "./GovernanceBlockPanel";

const policyFailure = {
  failureCategory: "POLICY_VIOLATION",
  failedStepId: "node-2",
  failedToolName: "demo.echo",
  ruleId: "DEMO-AMOUNT-001",
  ruleMessage: "Demo amount exceeds the allowed maximum of 100.",
  blockedParameter: "amount",
  toolWasCalled: false,
};

const toolFailure = {
  failureCategory: "TOOL_FAILURE",
  failedStepId: "step_1",
  failedToolName: "procurement.validate_vendor",
  toolWasCalled: true,
};

test("a governance block renders as a policy block, not a tool failure", () => {
  render(<GovernanceBlockPanel failure={policyFailure} />);

  const panel = screen.getByTestId("governance-block-panel");
  expect(panel).not.toBeNull();
  expect(screen.queryByTestId("tool-failure-panel")).toBeNull();

  // amber, never the tool-failure red
  expect(panel.className).toMatch(/amber/);
  expect(panel.className).not.toMatch(/red/);

  // heading says blocked, not failed
  expect(screen.getByText(/Blocked by policy before the tool was called/i)).not.toBeNull();
  expect(screen.queryByText(/^Tool failure$/i)).toBeNull();

  // rule id, plain-language message, blocked parameter, tool-never-called line
  expect(screen.getByText("DEMO-AMOUNT-001")).not.toBeNull();
  expect(screen.getByText("Demo amount exceeds the allowed maximum of 100.")).not.toBeNull();
  expect(screen.getByText("amount")).not.toBeNull();
  expect(screen.getByTestId("tool-not-called").textContent).toMatch(/never called/i);

  cleanup();
});

test("a tool failure keeps the red treatment and names step and tool", () => {
  render(<GovernanceBlockPanel failure={toolFailure} />);

  const panel = screen.getByTestId("tool-failure-panel");
  expect(panel.className).toMatch(/red/);
  expect(panel.className).not.toMatch(/amber/);
  expect(screen.queryByTestId("governance-block-panel")).toBeNull();
  expect(screen.queryByTestId("tool-not-called")).toBeNull();
  expect(screen.getByText("step_1")).not.toBeNull();
  expect(screen.getByText("procurement.validate_vendor")).not.toBeNull();

  cleanup();
});

test("the status badge reads Blocked for a policy violation and Failed for a tool failure", () => {
  const { unmount } = render(<ExecutionStatus status="FAILED" failure={policyFailure} />);
  const blocked = screen.getByTestId("execution-status");
  expect(blocked.textContent).toMatch(/Blocked/);
  expect(blocked.textContent).not.toMatch(/Failed/);
  expect(blocked.getAttribute("data-blocked")).toBe("true");
  expect(blocked.className).toMatch(/amber/);
  unmount();

  render(<ExecutionStatus status="FAILED" failure={toolFailure} />);
  const failed = screen.getByTestId("execution-status");
  expect(failed.textContent).toMatch(/Failed/);
  expect(failed.getAttribute("data-blocked")).toBe("false");
  expect(failed.className).toMatch(/red/);

  cleanup();
});

test("the timeline chip reads BLOCKED and names the rule", () => {
  render(
    <ExecutionTimeline
      timeline={[
        { id: "s1", nodeId: "echo", label: "Echo", status: "DONE" },
        { id: "s2", nodeId: "node-2", label: "Second echo", status: "FAILED", failure: policyFailure },
      ]}
    />,
  );

  const steps = screen.getAllByTestId("timeline-step");
  expect(steps).toHaveLength(2);
  expect(steps[0].getAttribute("data-blocked")).toBe("false");
  expect(steps[1].getAttribute("data-blocked")).toBe("true");
  expect(steps[1].textContent).toMatch(/Second echo: BLOCKED/);
  expect(steps[1].textContent).not.toMatch(/FAILED/);
  expect(steps[1].textContent).toMatch(/Blocked by DEMO-AMOUNT-001 — tool never called/);

  cleanup();
});
