/** @jest-environment jsdom */
import React from "react";
import { jest, test, expect, afterEach } from "@jest/globals";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { ChatWorkspaceContext } from "./ChatWorkspaceContext";
import WorkflowFixButton from "./WorkflowFixButton";
afterEach(cleanup);

test("collects explicit business details without assuming missing values or executing", () => {
  const requestWorkflowHelp = jest.fn();
  render(<ChatWorkspaceContext.Provider value={{ requestWorkflowHelp }}><WorkflowFixButton workflowId="draft_1" requirements={["Recipient is unresolved", "Confirm the timezone", "Delivery channel is unresolved", "Confirm report window"]} /></ChatWorkspaceContext.Provider>);
  fireEvent.click(screen.getByRole("button", { name: "Fix missing details" }));
  expect(screen.getByRole("dialog", { name: "Complete workflow details" })).toBeTruthy();
  expect(screen.getByLabelText("Timezone").value).toBe("");
  fireEvent.change(screen.getByLabelText("Recipient email"), { target: { value: "recipient@example.test" } });
  fireEvent.change(screen.getByLabelText("Delivery method"), { target: { value: "Email" } });
  fireEvent.click(screen.getByRole("button", { name: "Prepare message to fix workflow" }));
  expect(requestWorkflowHelp).toHaveBeenCalledTimes(1);
  const [id, text] = requestWorkflowHelp.mock.calls[0];
  expect(id).toBe("draft_1"); expect(text).toContain("recipient@example.test"); expect(text).toContain("Delivery method: Email");
  expect(text).not.toContain("Asia/Colombo"); expect(text).not.toContain("Report period:");
  expect(text).toContain("Keep unresolved requirements visible"); expect(text).toContain("Do not run");
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("supports generic validation failures and cancelling leaves workflow untouched", () => {
  const requestWorkflowHelp = jest.fn();
  render(<ChatWorkspaceContext.Provider value={{ requestWorkflowHelp }}><WorkflowFixButton workflowId="draft_1" errors={["Unknown required tool"]} /></ChatWorkspaceContext.Provider>);
  fireEvent.click(screen.getByRole("button", { name: "Fix missing details" }));
  expect(screen.getByText("Unknown required tool")).toBeTruthy();
  expect(screen.queryByLabelText("Recipient email")).toBeNull();
  expect(screen.getByText("Unknown required tool").closest("details").open).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Close without changes", exact: true }));
  expect(requestWorkflowHelp).not.toHaveBeenCalled();
});

test("cannot open fixes while the chat is busy or read only", () => {
  const requestWorkflowHelp = jest.fn();
  render(<ChatWorkspaceContext.Provider value={{ requestWorkflowHelp }}><WorkflowFixButton workflowId="draft_1" busy /></ChatWorkspaceContext.Provider>);
  fireEvent.click(screen.getByRole("button", { name: "Fix missing details" }));
  expect(screen.queryByRole("dialog")).toBeNull();
});
