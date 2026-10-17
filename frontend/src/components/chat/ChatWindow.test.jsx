/** @jest-environment jsdom */
import React from "react";
import { expect, jest, test, afterEach } from "@jest/globals";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
jest.unstable_mockModule("./ChatMessage", () => ({ default: () => null }));
const loadModels = jest.fn().mockResolvedValue({ configured: true, binding: { model: "model-a" }, models: ["model-a", "model-b"] });
jest.unstable_mockModule("../../services/chat.service", () => ({ chatService: { models: loadModels } }));
jest.unstable_mockModule("../../utils/workflowCanvas.utils", () => ({ peekWorkflowForChatEdit: () => null, clearWorkflowForChatEdit: () => {} }));
const { default: ChatWindow } = await import("./ChatWindow");
const { default: ChatWorkspaceLayout } = await import("./ChatWorkspaceLayout");
HTMLElement.prototype.scrollIntoView = jest.fn();
afterEach(() => { cleanup(); sessionStorage.clear(); });

test("shows immediate thinking feedback before the saved operation arrives", async () => {
  render(<ChatWindow messages={[]} loading draftStorageKey="thinking.chat" />);
  await screen.findByRole("combobox", { name: "Requested model" });
  expect(screen.getByRole("status", { name: "Thinking…" })).toBeTruthy();
  expect(screen.getByText("Sending your request securely…")).toBeTruthy();
  expect(screen.getByText("Working")).toBeTruthy();
  expect(screen.queryByText("What would you like to do?")).toBeNull();
});

test("unsupported selected-group chat retains text and cannot become an unscoped request", async () => {
  const onSend = jest.fn(); render(<ChatWindow messages={[]} onSend={onSend} nodeContext={{ nodeId: "group", version: 1, unavailableReason: "Use protected output settings or select a child node." }} draftStorageKey="scope.protected" />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Edit the handler" } });
  await screen.findByText("Use protected output settings or select a child node.");
  expect(screen.getByRole("button", { name: "Send message" }).disabled).toBe(true);
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" }); fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  expect(onSend).not.toHaveBeenCalled(); expect(screen.getByRole("textbox").value).toBe("Edit the handler");
});

test("pending selected-node context retains text and cannot fall through to a general chat request", async () => {
  const onSend = jest.fn(), view = render(<ChatWindow messages={[]} onSend={onSend} nodeContext={{ nodeId: "each", label: "Collection each", version: 4, pending: true }} draftStorageKey="scope.pending" />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Edit this collection" } });
  expect(screen.getByRole("button", { name: "Send message" }).disabled).toBe(true);
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", shiftKey: false }); expect(onSend).not.toHaveBeenCalled();
  expect(screen.getByRole("textbox").value).toBe("Edit this collection"); expect(screen.queryByRole("button", { name: "Daily invoice report" })).toBeNull();
  view.rerender(<ChatWindow messages={[]} onSend={onSend} nodeContext={{ nodeId: "each", label: "Collection each", version: 4, pending: false }} draftStorageKey="scope.pending" />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Send message" }).disabled).toBe(false));
});

test("keeps unsent draft across leaving and returning to workspace", () => {
  const view = render(<ChatWindow messages={[]} draftStorageKey="draft.account.session" />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Draft report" } });
  view.unmount();
  render(<ChatWindow messages={[]} draftStorageKey="draft.account.session" />);
  expect(screen.getByRole("textbox").value).toBe("Draft report");
  expect(screen.getByText("Ready")).toBeTruthy();
});

test("failed request keeps draft and successful send clears it", async () => {
  const onSend = jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ assistantMessage: {} });
  render(<ChatWindow messages={[]} onSend={onSend} draftStorageKey="draft.account.session" />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Report" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
  expect(screen.getByRole("textbox").value).toBe("Report");
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(screen.getByRole("textbox").value).toBe(""));
  expect(sessionStorage.getItem("draft.account.session")).toBe("");
});

test("session model restores and applies to selected-node chat; unavailable selection is not silently replaced", async () => {
  const onSend = jest.fn().mockResolvedValue({});
  render(<ChatWindow messages={[]} savedModel="model-b" nodeContext={{ nodeId: "read", label: "Read", version: 1 }} onSend={onSend} draftStorageKey="account.chat" />);
  const picker = await screen.findByRole("combobox", { name: "Requested model" });
  await waitFor(() => expect(picker.value).toBe("model-b"));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Edit read" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(onSend).toHaveBeenCalledWith("Edit read", { model: "model-b" }));
  cleanup();
  render(<ChatWindow messages={[]} savedModel="removed-model" draftStorageKey="other.chat" />);
  await screen.findByText("removed-model · unavailable");
  expect(screen.getByRole("combobox").value).toBe("removed-model");
});

test("catalog errors are visible and retry does not discard the draft", async () => {
  loadModels.mockRejectedValueOnce(new Error("Forbidden"));
  render(<ChatWindow messages={[]} draftStorageKey="account.error" />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Keep this" } });
  await screen.findByText(/Could not load configured models/);
  fireEvent.click(screen.getByRole("button", { name: "Reload models" }));
  await screen.findByRole("combobox", { name: "Requested model" });
  expect(screen.getByRole("textbox").value).toBe("Keep this");
});

test("catalog refresh does not overwrite an unsent model choice with the last server selection", async () => {
  render(<ChatWindow messages={[]} savedModel="model-a" draftStorageKey="account.choice" />);
  const picker = await screen.findByRole("combobox", { name: "Requested model" });
  await waitFor(() => expect(picker.value).toBe("model-a"));
  fireEvent.change(picker, { target: { value: "model-b" } });
  fireEvent.click(screen.getByRole("button", { name: "Refresh configured models" }));
  await waitFor(() => expect(picker.value).toBe("model-b"));
});

test("leaving and returning preserves an unsent model choice and node-scoped send uses it", async () => {
  const first = render(<ChatWindow messages={[]} savedModel="model-a" draftStorageKey="account.unsent" />);
  const picker = await screen.findByRole("combobox", { name: "Requested model" });
  await waitFor(() => expect(picker.value).toBe("model-a"));
  fireEvent.change(picker, { target: { value: "model-b" } });
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Edit only this node" } }); first.unmount();
  const onSend = jest.fn().mockResolvedValue({});
  render(<ChatWindow messages={[]} savedModel="model-a" draftStorageKey="account.unsent" onSend={onSend} nodeContext={{ nodeId: "read", label: "Read", version: 1 }} />);
  await waitFor(() => expect(screen.getByRole("combobox", { name: "Requested model" }).value).toBe("model-b"));
  expect(screen.getByRole("textbox").value).toBe("Edit only this node");
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(onSend).toHaveBeenCalledWith("Edit only this node", { model: "model-b" }));
});

test("automatic default is not persisted as intent and a late saved model can restore", async () => {
  const view = render(<ChatWindow messages={[]} draftStorageKey="account.late" />);
  await waitFor(() => expect(screen.getByRole("combobox").value).toBe("model-a"));
  expect(sessionStorage.getItem("account.late.model")).toBeNull();
  view.rerender(<ChatWindow messages={[]} draftStorageKey="account.late" savedModel="model-b" />);
  await waitFor(() => expect(screen.getByRole("combobox").value).toBe("model-b"));
  expect(sessionStorage.getItem("account.late.model")).toBeNull();
});

test("restored removed choice stays explicit and is not silently replaced by an available model", async () => {
  sessionStorage.setItem("account.removed.model", "removed-model");
  render(<ChatWindow messages={[]} savedModel="model-a" draftStorageKey="account.removed" />);
  await screen.findByText("removed-model · unavailable");
  expect(screen.getByRole("combobox").value).toBe("removed-model");
});

test("model intent is isolated between account and conversation storage scopes", async () => {
  sessionStorage.setItem("first.chat.model", "model-b");
  render(<ChatWindow messages={[]} savedModel="model-a" draftStorageKey="second.chat" />);
  await waitFor(() => expect(screen.getByRole("combobox").value).toBe("model-a"));
  expect(sessionStorage.getItem("first.chat.model")).toBe("model-b");
});

test("focus mode hides the heading and keeps the same draft, model selector and right-side tools", async () => {
  const onSend = jest.fn();
  render(<ChatWorkspaceLayout storageKey="focus.qa" chat={<ChatWindow messages={[]} onSend={onSend} draftStorageKey="focus.draft" />} canvas={<p>Saved canvas</p>} />);
  const composer = screen.getByRole("textbox", { name: "Message to workflow assistant" });
  fireEvent.change(composer, { target: { value: "My unsent question" } });
  fireEvent.click(screen.getByRole("button", { name: "Workspace tools", exact: true }));
  const model = await screen.findByRole("combobox", { name: "Requested model" });
  fireEvent.change(model, { target: { value: "model-b" } });
  fireEvent.click(screen.getByRole("button", { name: "Full screen split view" }));
  expect(screen.getByText("Saved canvas")).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Workflow assistant" })).toBeNull();
  expect(screen.queryByRole("combobox", { name: "Requested model" })).toBeNull();
  expect(screen.getByRole("textbox", { name: "Message to workflow assistant" })).toBe(composer);
  expect(composer.value).toBe("My unsent question");
  fireEvent.click(screen.getByRole("button", { name: "Workspace tools", exact: true }));
  expect(screen.getByRole("combobox", { name: "Requested model" })).toBe(model);
  expect(model.value).toBe("model-b");
  fireEvent.click(screen.getByRole("button", { name: "Exit full screen split view" }));
  expect(screen.getByRole("heading", { name: "Workflow assistant" })).toBeTruthy();
  expect(composer.value).toBe("My unsent question");
  expect(onSend).not.toHaveBeenCalled();
});
