/** @jest-environment jsdom */
import React from "react";
import { expect, jest, test, afterEach } from "@jest/globals";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import ChatOperationProgress from "./ChatOperationProgress";
afterEach(cleanup);

test("ordinary conversation progress is natural while business responses retain their completion boundary", () => {
  const operation = { status: "ANSWERED", stage: "ANSWERED", persistence: "durable", attempts: [] };
  const { rerender } = render(<ChatOperationProgress operation={operation} answerIntent="CONVERSATION" />);
  expect(screen.getByText("Reply saved.")).toBeTruthy(); expect(screen.queryByText(/not proof of email delivery/)).toBeNull();
  rerender(<ChatOperationProgress operation={operation} answerIntent="WORKFLOW_DISCUSSION" />);
  expect(screen.getByText("Explanation saved. No workflow changes were applied.")).toBeTruthy();
  rerender(<ChatOperationProgress operation={operation} answerIntent="QUERY" />);
  expect(screen.getByText(/not proof of email delivery/)).toBeTruthy();
});
test.each([
  ["POLICY_REVIEW_REQUIRED", "This ERP read requires policy review."],
  ["POLICY_DENIED", "Policy denied this ERP read."],
  ["POLICY_UNAVAILABLE", "The policy check was unavailable."],
  ["LOCAL_POLICY_CONFIG_INVALID", "The policy check failed."],
  ["LOCAL_POLICY_PROVIDER_FAILED", "The policy check failed."],
  ["LOCAL_POLICY_RESPONSE_INVALID", "The policy check failed."],
])("server-owned failed reason %s shows a fixed policy stop without retry controls", (reason, text) => {
  const { container } = render(<ChatOperationProgress operation={{ status: "FAILED", stage: "FAILED", persistence: "durable", reason, attempts: [] }} />);
  expect(screen.getByText(new RegExp(text))).toBeTruthy();
  expect(screen.getByText(/This attempted read was not dispatched. Nothing will be retried automatically./)).toBeTruthy();
  expect(container.textContent).not.toContain(reason);
  expect(screen.queryByRole("button", { name: /approve|retry/i })).toBeNull();
});
test.each(["RAW_SECRET_SENTINEL", "POLICY_CHECK_CANCELLED", "__proto__"])("a policy-like receipt or unknown reason %s cannot change recovery wording", reason => {
  const { rerender } = render(<ChatOperationProgress operation={{ status: "RECOVERY_REQUIRED", stage: "RECOVERY_REQUIRED", reason: "POLICY_DENIED", attempts: [{ id: "one", toolName: "demo.echo", status: "FAILED", output: { decision: "review", source: "local_model" } }] }} />);
  expect(screen.getByText(/uncertain or interrupted outcome/)).toBeTruthy();
  expect(screen.queryByText(/This attempted read was not dispatched/)).toBeNull();
  rerender(<ChatOperationProgress operation={{ status: "FAILED", stage: "FAILED", reason, attempts: [] }} />);
  expect(screen.getByText(/stopped before a response could be saved/)).toBeTruthy();
  expect(screen.queryByText(/RAW_SECRET_SENTINEL|This attempted read was not dispatched/)).toBeNull();
});
test("shows readable confirmed answers and cancellation without claiming rollback", () => {
  const cancel = jest.fn(), refresh = jest.fn();
  const { container } = render(<ChatOperationProgress operation={{ status: "RUNNING", stage: "READ_SAVED", persistence: "durable", modelBinding: { model: "fixture-model" }, attempts: [{ id: "one", toolName: "read_invoices", status: "DONE", output: { structuredContent: [{ invoiceNumber: "INV-001", total: 100 }] } }] }} onCancel={cancel} onRefresh={refresh} />);
  expect(screen.getByRole("status").textContent).toBe("ERP result received"); expect(screen.getByText("Working on your request")).toBeTruthy(); expect(screen.getByRole("table")).toBeTruthy(); expect(screen.getByText("INV-001")).toBeTruthy(); expect(container.querySelector("pre")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Cancel request" })); fireEvent.click(screen.getByRole("button", { name: "Refresh saved progress" })); expect(cancel).toHaveBeenCalledTimes(1); expect(refresh).toHaveBeenCalledTimes(1);
});
test("uncertain and answered states never imply business completion or automatic retry", () => {
  const { rerender } = render(<ChatOperationProgress operation={{ status: "RECOVERY_REQUIRED", stage: "RECOVERY_REQUIRED", persistence: "memory-only", cancellationRequested: true, attempts: [{ id: "one", toolName: "read", status: "UNKNOWN" }] }} />);
  expect(screen.getByText(/remote work was rolled back/)).toBeTruthy(); expect(screen.getByText(/Outcome unconfirmed/)).toBeTruthy(); expect(screen.getByText(/lost on server restart/)).toBeTruthy(); expect(screen.queryByRole("button", { name: "Cancel request" })).toBeNull();
  rerender(<ChatOperationProgress operation={{ status: "ANSWERED", stage: "ANSWERED", persistence: "durable", attempts: [] }} />); expect(screen.getByText(/not proof of email delivery/)).toBeTruthy();
});

test("saved proposal progress describes its original source without prescribing a stale apply action", () => {
  render(<ChatOperationProgress operation={{ status: "ANSWERED", stage: "ANSWERED", persistence: "durable", nodeContext: { nodeId: "each", baseVersion: 1 }, artifactRefs: [{ type: "node-proposal", id: "proposal-one" }] }} />);
  expect(screen.getByText(/source draft v1/)).toBeTruthy(); expect(screen.getByText(/current review status is shown beside the workflow/)).toBeTruthy(); expect(screen.queryByText(/choose Apply to draft/)).toBeNull();
});

test("sending cancellation is not displayed as a server-acknowledged request", () => {
  const operation = { status: "RUNNING", stage: "MODEL", persistence: "durable", cancellationRequested: false, attempts: [] };
  const { rerender } = render(<ChatOperationProgress operation={operation} cancelling />);
  expect(screen.getByRole("button", { name: "Requesting cancellation…" }).disabled).toBe(true);
  expect(screen.queryByRole("button", { name: "Cancel requested" })).toBeNull();
  expect(screen.getByText(/not yet acknowledged/)).toBeTruthy();
  expect(screen.getByRole("status").textContent).toBe("Understanding what you need");
  rerender(<ChatOperationProgress operation={{ ...operation, cancellationRequested: true }} cancelling={false} />);
  expect(screen.getByRole("button", { name: "Cancel requested" }).disabled).toBe(true);
  expect(screen.queryByText(/not yet acknowledged/)).toBeNull();
  expect(screen.getByText(/does not prove that remote work was rolled back/)).toBeTruthy();
});

test("unconfirmed cancellation keeps original running status and offers progress inspection without resending", () => {
  const cancel = jest.fn(), refresh = jest.fn();
  render(<ChatOperationProgress operation={{ status: "RUNNING", stage: "MODEL", persistence: "durable", cancellationRequested: false, attempts: [] }}
    error="Cancellation was not acknowledged. Refresh saved progress before trying again." onCancel={cancel} onRefresh={refresh} />);
  expect(screen.getByRole("status").textContent).toBe("Understanding what you need");
  expect(screen.getByRole("button", { name: "Cancel request" }).disabled).toBe(false);
  expect(screen.queryByRole("button", { name: "Cancel requested" })).toBeNull();
  expect(screen.getByRole("alert").textContent).toContain("not acknowledged");
  fireEvent.click(screen.getByRole("button", { name: "Refresh saved progress" }));
  expect(refresh).toHaveBeenCalledTimes(1); expect(cancel).not.toHaveBeenCalled();
});
