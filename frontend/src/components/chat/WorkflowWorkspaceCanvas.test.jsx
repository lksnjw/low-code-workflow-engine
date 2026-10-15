/** @jest-environment jsdom */
import React from "react";
import { expect, test, afterEach, jest } from "@jest/globals";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import ChatWorkspaceLayout from "./ChatWorkspaceLayout";
const editorProps = jest.fn();
jest.unstable_mockModule("./WorkflowWorkspaceEditor", () => ({ default: (props) => { editorProps(props); return React.createElement("div", { "data-testid": "saved-workflow-editor" }); } }));
const { default: WorkflowWorkspaceCanvas } = await import("./WorkflowWorkspaceCanvas");
afterEach(() => { cleanup(); sessionStorage.clear(); editorProps.mockClear(); });

test("new workflow requires confirmation and leaves creation to a fresh chat", () => {
  const startNew = jest.fn(), close = jest.fn();
  render(<WorkflowWorkspaceCanvas canEdit onStartNewWorkflow={startNew} onCloseWorkflow={close} messages={[{ id: "saved", artifacts: { workflowId: "old", yaml: "name: Old\nsteps: []" } }]} />);
  fireEvent.click(screen.getByRole("button", { name: "Start a new workflow" }));
  expect(startNew).not.toHaveBeenCalled(); expect(screen.getByText(/without the old workflow context/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open new workflow chat" }));
  expect(startNew).toHaveBeenCalledTimes(1); expect(close).not.toHaveBeenCalled();
});

test("close is cancellable, persists an empty canvas and can reopen the saved workflow", () => {
  const close = jest.fn();
  const props = { selectionStorageKey: "canvas.close", messages: [{ id: "saved", artifacts: { workflowId: "report", yaml: "name: Report\nsteps: []" } }], onCloseWorkflow: close };
  const { unmount } = render(<WorkflowWorkspaceCanvas {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Reset canvas view" }));
  expect(editorProps).toHaveBeenLastCalledWith(expect.objectContaining({ workflowId: "report", viewReset: 1 }));
  fireEvent.click(screen.getByRole("button", { name: "Close workflow & continue chat" }));
  expect(screen.getByText(/Closing does not cancel/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
  expect(close).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Close workflow & continue chat" }));
  fireEvent.click(screen.getByRole("button", { name: "Close and continue chat" }));
  expect(close).toHaveBeenCalledTimes(1); expect(screen.queryByTestId("saved-workflow-editor")).toBeNull();
  unmount(); render(<WorkflowWorkspaceCanvas {...props} />);
  expect(screen.getByText("Canvas cleared")).toBeTruthy();
  fireEvent.change(screen.getByRole("combobox", { name: "Workflow draft" }), { target: { value: "workflow:report" } });
  expect(screen.getByTestId("saved-workflow-editor")).toBeTruthy();
});

test("the saved-workflow selector remains visible when the right-hand tools panel is closed", () => {
  render(<ChatWorkspaceLayout storageKey="visible-selector" chat={<p>Chat</p>} canvas={<WorkflowWorkspaceCanvas messages={[{ id: "saved", artifacts: { workflowId: "report", yaml: "name: Report\nsteps: []" } }]} />} />);
  expect(screen.getByRole("combobox", { name: "Workflow draft" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Workspace tools", exact: true }).getAttribute("aria-expanded")).toBe("false");
});

test("an explicit URL workflow wins over an older persisted canvas selection", () => {
  sessionStorage.setItem("canvas.url-target", JSON.stringify({ selectedDraft: "workflow:old" }));
  render(<WorkflowWorkspaceCanvas selectionStorageKey="canvas.url-target" initialWorkflowContext={{ workflowId: "new" }} messages={[{ id: "old-message", artifacts: { workflowId: "old" } }, { id: "new-message", artifacts: { workflowId: "new" } }]} />);
  expect(editorProps).toHaveBeenLastCalledWith(expect.objectContaining({ workflowId: "new" }));
});

test("canvas is present before generation", () => {
  render(<WorkflowWorkspaceCanvas messages={[]} />);
  expect(screen.getByRole("region", { name: "Workflow canvas" })).toBeTruthy();
  expect(screen.getByText("Your workflow starts here")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /run/i })).toBeNull();
});

test("a saved selection remains available after its messages leave the latest page", () => {
  sessionStorage.setItem("canvas.long-chat", JSON.stringify({ selectedDraft: "workflow:older" }));
  render(<WorkflowWorkspaceCanvas messages={[{ id: "latest", artifacts: { intent: "CAPABILITIES" } }]}
    workflowCatalog={[{ workflowId: "older", name: "Saved earlier", lastMessageIndex: 0 }, { workflowId: "newer", name: "Saved later", lastMessageIndex: 2 }]}
    selectionStorageKey="canvas.long-chat" sessionId="long-chat" />);
  expect(screen.getByRole("combobox", { name: "Workflow draft" }).value).toBe("workflow:older");
  expect(screen.getAllByRole("option")).toHaveLength(2);
  expect(editorProps).toHaveBeenLastCalledWith(expect.objectContaining({ workflowId: "older", sessionId: "long-chat" }));
});

test("saved workflow selector uses a business name and stable identity, not an ambiguous draft number", () => {
  render(<WorkflowWorkspaceCanvas messages={[{ id: "saved", artifacts: { workflowId: "report", yaml: "name: Report\nsteps: []" } }]} />);
  expect(screen.getByRole("option", { name: "Report · report" })).toBeTruthy(); expect(screen.queryByRole("option", { name: "Draft 1 · report" })).toBeNull();
});

test("the current authorized catalog name survives old source and proposal-only messages", () => {
  render(<WorkflowWorkspaceCanvas messages={[{ id: "old", artifacts: { workflowId: "report", yaml: "name: Historical title\nsteps: []" } }, { id: "patch", artifacts: { proposal: { workflowId: "report" } } }]}
    workflowCatalog={[{ workflowId: "report", name: "Current invoice review", lastMessageIndex: 0 }]} />);
  expect(screen.getByRole("option", { name: "Current invoice review · report" })).toBeTruthy();
});

test("selects node parameters and retains draft after non-workflow answer", () => {
  const messages = [{ id: "one", artifacts: { selected_workflow_yaml: "name: Report\nsteps:\n - id: fetch\n   action: erp.list\n   params:\n     status: open" } }];
  const view = render(<WorkflowWorkspaceCanvas messages={messages} />);
  fireEvent.click(screen.getByRole("button", { name: /fetch/ }));
  expect(screen.getByRole("complementary", { name: "Selected node details" }).textContent).toContain("Statusopen");
  expect(screen.getByRole("complementary", { name: "Selected node details" }).querySelector("pre")).toBeNull();
  view.rerender(<WorkflowWorkspaceCanvas messages={[...messages, { id: "two", artifacts: { intent: "QUERY" } }]} />);
  expect(screen.getByRole("button", { name: /fetch/ }).getAttribute("aria-pressed")).toBe("true");
});

test("restores selected draft and node after Settings navigation remount", () => {
  const messages = [{ id: "one", artifacts: { yaml: "steps:\n - id: fetch\n   action: erp.list" } }];
  const view = render(<WorkflowWorkspaceCanvas messages={messages} selectionStorageKey="canvas.account.session" />);
  fireEvent.click(screen.getByRole("button", { name: /fetch/ }));
  view.unmount();
  render(<WorkflowWorkspaceCanvas messages={messages} selectionStorageKey="canvas.account.session" />);
  expect(screen.getByRole("button", { name: /fetch/ }).getAttribute("aria-pressed")).toBe("true");
});

test("canvas handoff opens the exact saved workflow and selected node", () => {
  render(<WorkflowWorkspaceCanvas messages={[]} initialWorkflowContext={{ workflowId: "report", yaml: "name: Report\nsteps: []", selectedNodeId: "invoices" }} sessionId="chat" />);
  expect(screen.getByTestId("saved-workflow-editor")).toBeTruthy();
  expect(editorProps).toHaveBeenLastCalledWith(expect.objectContaining({ workflowId: "report", sessionId: "chat", initialSelectedNodeId: "invoices" }));
});

test("durable node-edit messages restore workflow and node context without YAML", () => {
  render(<WorkflowWorkspaceCanvas messages={[{ id: "request", artifacts: { intent: "NODE_EDIT_REQUEST", workflowId: "report", nodeId: "invoices" } }]} sessionId="chat" />);
  expect(editorProps).toHaveBeenLastCalledWith(expect.objectContaining({ workflowId: "report", initialSelectedNodeId: "invoices" }));
});

test("repeated saved node requests and replies share one option while distinct workflows remain selectable", () => {
  const messages = [{ id: "one", artifacts: { workflowId: "report" } }, { id: "two", artifacts: { workflowId: "other" } }];
  const view = render(<WorkflowWorkspaceCanvas messages={messages} selectionStorageKey="qa.choices" />);
  fireEvent.change(screen.getByRole("combobox", { name: "Workflow draft" }), { target: { value: "workflow:report" } });
  view.rerender(<WorkflowWorkspaceCanvas messages={[...messages, { id: "request", artifacts: { workflowId: "report", nodeId: "first" } }, { id: "reply", artifacts: { proposal: { workflowId: "report", nodeId: "first" } } }]} selectionStorageKey="qa.choices" />);
  expect(screen.getAllByRole("option")).toHaveLength(2);
  expect(screen.getByRole("combobox", { name: "Workflow draft" }).value).toBe("workflow:report");
  expect(editorProps).toHaveBeenLastCalledWith(expect.objectContaining({ workflowId: "report", initialSelectedNodeId: "first", savedProposals: [expect.objectContaining({ workflowId: "report" })] }));
});

test("legacy message selections survive grouping and Settings remount", () => {
  sessionStorage.setItem("qa.legacy", JSON.stringify({ selectedDraft: "old" }));
  const messages = [{ id: "old", artifacts: { workflowId: "report" } }, { id: "other", artifacts: { workflowId: "other" } }, { id: "patch", artifacts: { workflowId: "report" } }];
  const view = render(<WorkflowWorkspaceCanvas messages={messages} selectionStorageKey="qa.legacy" />);
  expect(screen.getByRole("combobox", { name: "Workflow draft" }).value).toBe("workflow:report");
  view.unmount(); render(<WorkflowWorkspaceCanvas messages={messages} selectionStorageKey="qa.legacy" />);
  expect(editorProps).toHaveBeenLastCalledWith(expect.objectContaining({ workflowId: "report" }));
});
