/** @jest-environment jsdom */
import React, { StrictMode } from "react";
import { jest, test, expect, afterEach } from "@jest/globals";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { workflowService } from "../../services/workflow.service";
import { executionService } from "../../services/execution.service";
import { settingsService } from "../../services/settings.service";
import { chatService } from "../../services/chat.service";
import { authorityScope, transitionAuthority } from "../../utils/authAuthority";
import { chatQueryKeys } from "../../utils/chatQueryKeys";

const source = "name: Report\ntrigger:\n  type: manual\nsteps:\n - id: invoices\n   action: demo.echo\n   parameters:\n     value: original\n";
const record = { workflowId: "report", version: 4, contentHash: `sha256:${"a".repeat(64)}`, yaml: source, validation: { passed: true }, published: false, bridge: "not_connected" };
const normalSend = jest.fn().mockResolvedValue({});
const createSession = jest.fn().mockResolvedValue({ id: "created-chat" });
let selectedSessionId = "chat";
let messages = [{ id: "saved", role: "assistant", artifacts: { workflowId: "report", yaml: source } }];
jest.unstable_mockModule("@xyflow/react", () => ({ MarkerType: { ArrowClosed: "arrow-closed" } }));
jest.unstable_mockModule("../../context/AuthContext", () => ({ useAuthContext: () => { const user = { id: "admin", role: "Admin", permissions: ["workflow:write"] }; transitionAuthority(user); return { user }; } }));
jest.unstable_mockModule("../../hooks/useChatSessions", () => ({ useChatSessions: () => ({ selectedSessionId, createSession, sessions: [], loading: false }) }));
jest.unstable_mockModule("../../hooks/useChat", () => ({ useChat: () => ({ messages, send: normalSend, loading: false }) }));
jest.unstable_mockModule("../../components/chat/ChatMessage", () => ({ default: () => null }));
const { default: ChatPage } = await import("./ChatPage");
afterEach(() => { cleanup(); sessionStorage.clear(); localStorage.clear(); jest.restoreAllMocks(); normalSend.mockClear(); createSession.mockReset().mockResolvedValue({ id: "created-chat" }); selectedSessionId = "chat"; messages = [{ id: "saved", role: "assistant", artifacts: { workflowId: "report", yaml: source } }]; });

function Location() { const location = useLocation(); return <output aria-label="Current route">{location.pathname}{location.search}</output>; }
test("indexed-data chat reuses the composer without canvas or unrelated workflow handoff", async () => {
  messages = [];
  localStorage.setItem("workflow.pendingChatEdit", JSON.stringify({ workflowId: "report", workflowName: "Report", yaml: source }));
  const readiness = jest.spyOn(workflowService, "readiness");
  jest.spyOn(chatService, "models").mockResolvedValue({ configured: true, binding: { model: "model-b" }, models: ["model-b"] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  render(<QueryClientProvider client={client}><MemoryRouter><ChatPage routeBase="/datafeed/chat" workspaceLabel="Indexed Data Chat" showCanvas={false} /></MemoryRouter></QueryClientProvider>);
  await screen.findByRole("heading", { name: "Indexed data assistant" });
  expect(screen.queryByTestId("workspace-canvas-pane")).toBeNull();
  expect(screen.queryByText("Editing:")).toBeNull();
  expect(screen.getByRole("heading", { name: "Find stored document details" })).toBeTruthy();
  expect(readiness).not.toHaveBeenCalled();
  openWorkspaceTools();
  await screen.findByRole("combobox", { name: "Requested model" });
  fireEvent.change(screen.getByRole("textbox", { name: "Message to workflow assistant" }), { target: { value: "Find this person's stored certificate" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(normalSend).toHaveBeenCalledWith("Find this person's stored certificate", "chat", { model: "model-b" }));
  client.clear();
});

test("a workflow identity link survives reload without cached source or a new run", async () => {
  messages = [];
  const readiness = jest.spyOn(workflowService, "readiness").mockResolvedValue(record);
  jest.spyOn(executionService, "list").mockResolvedValue([]);
  jest.spyOn(chatService, "models").mockResolvedValue({ configured: false, models: [] });
  const command = jest.spyOn(workflowService, "command"), run = jest.spyOn(workflowService, "run");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const tree = () => <QueryClientProvider client={client}><MemoryRouter initialEntries={["/chat/chat?workflow=report"]}><ChatPage /></MemoryRouter></QueryClientProvider>;
  const view = render(tree());
  await screen.findByRole("button", { name: "Select step invoices", exact: true });
  view.unmount(); sessionStorage.clear(); localStorage.clear();
  render(tree()); await screen.findByRole("button", { name: "Select step invoices", exact: true });
  expect(readiness).toHaveBeenCalledWith("report");
  expect(command).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled(); expect(normalSend).not.toHaveBeenCalled();
  client.clear();
});
test("failed edit-chat creation is visible, never opens the old composer, and retries the original identity", async () => {
  HTMLElement.prototype.scrollIntoView = jest.fn();
  jest.spyOn(workflowService, "readiness").mockResolvedValue(record);
  jest.spyOn(executionService, "list").mockResolvedValue([]);
  jest.spyOn(chatService, "models").mockResolvedValue({ configured: false, models: [] });
  createSession.mockRejectedValueOnce(new Error("Unavailable"));
  localStorage.setItem("workflow.pendingChatEdit", JSON.stringify({ workflowId: "report", workflowName: "Report" }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={["/chat?new=1"]}><StrictMode><ChatPage /><Location /></StrictMode></MemoryRouter></QueryClientProvider>);
  await screen.findByRole("alert");
  expect(screen.getByText("Could not confirm the new conversation.")).toBeTruthy();
  expect(screen.queryByRole("textbox", { name: "Message to workflow assistant" })).toBeNull();
  expect(createSession).toHaveBeenCalledTimes(1);
  expect(createSession.mock.calls[0][0]).toBe("Edit: Report");
  const options = createSession.mock.calls[0][1];
  expect(options.idempotencyKey).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
  expect(localStorage.getItem("workflow.pendingChatEdit")).not.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry conversation creation" }));
  await waitFor(() => expect(screen.getByLabelText("Current route").textContent).toBe("/chat/created-chat?workflow=report"));
  expect(createSession.mock.calls[1]).toEqual(createSession.mock.calls[0]);
  expect(normalSend).not.toHaveBeenCalled();
  client.clear();
});

test("reload after uncertain creation keeps its identity and original title", async () => {
  createSession.mockRejectedValue(new Error("Lost response"));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const tree = () => <QueryClientProvider client={client}><MemoryRouter initialEntries={["/chat?new=1"]}><ChatPage /></MemoryRouter></QueryClientProvider>;
  const view = render(tree());
  await screen.findByRole("alert");
  const original = createSession.mock.calls[0];
  view.unmount();
  render(tree());
  await screen.findByRole("alert");
  expect(createSession).toHaveBeenCalledTimes(2);
  expect(createSession.mock.calls[1]).toEqual(original);
  client.clear();
});

test("chat is left of canvas and first on mobile; selecting a node routes the main composer to a revision-bound proposal, never direct execution", async () => {
  HTMLElement.prototype.scrollIntoView = jest.fn(); // jsdom has no layout/scroll implementation.
  jest.spyOn(workflowService, "readiness").mockResolvedValue(record);
  jest.spyOn(executionService, "list").mockResolvedValue([]);
  jest.spyOn(settingsService, "providers").mockResolvedValue([]);
  jest.spyOn(chatService, "models").mockResolvedValue({ configured: true, binding: { model: "model-b" }, models: ["model-b"] });
  const propose = jest.spyOn(workflowService, "proposeNode").mockResolvedValue({ id: "one", workflowId: "report", nodeId: "invoices", baseVersion: 4, baseHash: record.contentHash, status: "PROPOSED", command: { type: "updateNode", nodeId: "invoices", patch: { description: "Reviewed" } }, before: {}, after: { description: "Reviewed" } });
  const command = jest.spyOn(workflowService, "command");
  const run = jest.spyOn(workflowService, "run");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const view = render(<QueryClientProvider client={client}><MemoryRouter><ChatPage /></MemoryRouter></QueryClientProvider>);
  expect(screen.getByTestId("workspace-chat-pane").compareDocumentPosition(screen.getByTestId("workspace-canvas-pane")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  fireEvent.click(await screen.findByRole("button", { name: "Select step invoices", exact: true }));
  await screen.findByText("Editing node · invoices");
  expect(screen.queryByRole("textbox", { name: "Selected node prompt" })).toBeNull();
  fireEvent.change(screen.getByRole("textbox", { name: "Message to workflow assistant" }), { target: { value: "Rename this node" } });
  openWorkspaceTools();
  await screen.findByRole("combobox", { name: "Requested model" });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(normalSend).toHaveBeenCalledWith("Rename this node", "chat", { model: "model-b", nodeContext: { workflowId: "report", nodeId: "invoices", baseVersion: 4, baseHash: record.contentHash } }));
  expect(screen.queryByRole("region", { name: "Node change preview" })).toBeNull();
  expect(propose).not.toHaveBeenCalled(); expect(command).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled();
  messages = [...messages, { id: "proposal", role: "assistant", artifacts: { proposal: await propose.getMockImplementation()() } }];
  view.rerender(<QueryClientProvider client={client}><MemoryRouter><ChatPage /></MemoryRouter></QueryClientProvider>);
  fireEvent.click(screen.getByRole("button", { name: "Canvas tools", exact: true }));
  await screen.findByRole("region", { name: "Node change preview" });
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Message to workflow assistant" }).value).toBe(""));
  fireEvent.click(screen.getByRole("button", { name: "Exit node editing" }));
  await waitFor(() => expect(screen.queryByText("Editing node · invoices")).toBeNull());
  fireEvent.change(screen.getByRole("textbox", { name: "Message to workflow assistant" }), { target: { value: "Discuss the whole workflow" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(normalSend).toHaveBeenCalledWith("Discuss the whole workflow", "chat", expect.any(Object)));
  client.clear();
});

test("canvas handoff restores selected workflow node and clears it only after admission", async () => {
  HTMLElement.prototype.scrollIntoView = jest.fn();
  messages = [];
  localStorage.setItem("workflow.pendingChatEdit", JSON.stringify({ workflowId: "report", workflowName: "Report", yaml: source, selectedNodeId: "invoices" }));
  jest.spyOn(workflowService, "readiness").mockResolvedValue(record);
  jest.spyOn(executionService, "list").mockResolvedValue([]);
  jest.spyOn(settingsService, "providers").mockResolvedValue([]);
  jest.spyOn(chatService, "models").mockResolvedValue({ configured: true, binding: { model: "model-b" }, models: ["model-b"] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  render(<QueryClientProvider client={client}><MemoryRouter><ChatPage /></MemoryRouter></QueryClientProvider>);
  await screen.findByText("Editing node · invoices");
  fireEvent.change(screen.getByRole("textbox", { name: "Message to workflow assistant" }), { target: { value: "Make this label clearer" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(normalSend).toHaveBeenCalledWith("Make this label clearer", "chat", { model: "model-b", nodeContext: { workflowId: "report", nodeId: "invoices", baseVersion: 4, baseHash: record.contentHash } }));
  await waitFor(() => expect(localStorage.getItem("workflow.pendingChatEdit")).toBeNull());
  client.clear();
});

test("first-message session creation transfers the explicit model with a retained failed-send draft", async () => {
  selectedSessionId = ""; messages = [];
  normalSend.mockResolvedValueOnce(null);
  jest.spyOn(chatService, "models").mockResolvedValue({ configured: true, binding: { model: "model-a" }, models: ["model-a", "model-b"] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  render(<QueryClientProvider client={client}><MemoryRouter><ChatPage /></MemoryRouter></QueryClientProvider>);
  openWorkspaceTools();
  const picker = await screen.findByRole("combobox", { name: "Requested model" });
  await waitFor(() => expect(picker.value).toBe("model-a"));
  fireEvent.change(picker, { target: { value: "model-b" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Message to workflow assistant" }), { target: { value: "Keep this new conversation request" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(normalSend).toHaveBeenCalledWith("Keep this new conversation request", "created-chat", { model: "model-b" }));
  expect(sessionStorage.getItem("workflow.workspace.admin.draft.created-chat.model")).toBe("model-b");
  expect(sessionStorage.getItem("workflow.workspace.admin.draft.created-chat")).toBe("Keep this new conversation request");
  client.clear();
});

test("uncertain first-message creation retains the draft and retries only the same session command", async () => {
  selectedSessionId = ""; messages = [];
  createSession.mockRejectedValueOnce(new Error("Lost creation acknowledgement"));
  jest.spyOn(chatService, "models").mockResolvedValue({ configured: true, binding: { model: "model-a" }, models: ["model-a"] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  render(<QueryClientProvider client={client}><MemoryRouter><ChatPage /></MemoryRouter></QueryClientProvider>);
  const composer = screen.getByRole("textbox", { name: "Message to workflow assistant" });
  fireEvent.change(composer, { target: { value: "Create my report" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await screen.findByText(/Could not send the message\. Your draft has been kept/);
  expect(normalSend).not.toHaveBeenCalled();
  expect(composer.value).toBe("Create my report");
  const first = createSession.mock.calls[0];
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(normalSend).toHaveBeenCalledTimes(1));
  expect(createSession.mock.calls[1]).toEqual(first);
  expect(first[1].idempotencyKey).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
  client.clear();
});

test("applying a saved child proposal invalidates the active authority-scoped chat data", async () => {
  HTMLElement.prototype.scrollIntoView = jest.fn();
  jest.spyOn(chatService, "models").mockResolvedValue({ configured: true, binding: { model: "model-b" }, models: ["model-b"] });
  const proposal = { id: "proposal-1", workflowId: "report", nodeId: "invoices", baseVersion: 4, baseHash: record.contentHash, status: "PROPOSED", command: { type: "updateNode", nodeId: "invoices", patch: { description: "Reviewed" } }, before: {}, after: { description: "Reviewed" } };
  messages = [{ id: "saved", role: "assistant", artifacts: { workflowId: "report", yaml: source, proposal } }];
  jest.spyOn(workflowService, "readiness").mockResolvedValue(record);
  jest.spyOn(workflowService, "command").mockResolvedValue({ ...record, version: 5 });
  jest.spyOn(executionService, "list").mockResolvedValue([]);
  const actor = { id: "admin", role: "Admin", permissions: ["workflow:write"] };
  transitionAuthority(actor);
  const scope = authorityScope(actor);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const sessionKey = chatQueryKeys.session(scope, "chat");
  const sessionsKey = chatQueryKeys.sessions(scope);
  client.setQueryData(sessionKey, { id: "chat", messages: [] });
  client.setQueryData(sessionsKey, []);
  const invalidate = jest.spyOn(client, "invalidateQueries");
  render(<QueryClientProvider client={client}><MemoryRouter><ChatPage /></MemoryRouter></QueryClientProvider>);
  fireEvent.click(screen.getByRole("button", { name: "Workspace tools", exact: true }));
  fireEvent.click(screen.getByRole("button", { name: "Canvas tools", exact: true }));
  fireEvent.click(await screen.findByRole("button", { name: "Apply to draft" }));
  await waitFor(() => expect(workflowService.command).toHaveBeenCalled());
  await waitFor(() => expect(client.getQueryState(sessionKey).isInvalidated).toBe(true));
  expect(invalidate).toHaveBeenCalledWith({ queryKey: sessionKey });
  expect(invalidate).toHaveBeenCalledWith({ queryKey: sessionsKey });
  client.clear();
});

function openWorkspaceTools() {
  const toggle = screen.getByRole("button", { name: "Workspace tools", exact: true });
  if (toggle.getAttribute("aria-expanded") === "false") fireEvent.click(toggle);
  const chatTab = screen.queryByRole("button", { name: "Chat tools", exact: true });
  if (chatTab) fireEvent.click(chatTab);
}

test("changing the visible canvas selector keeps the chat and draft and updates the URL to the exact workflow", async () => {
  HTMLElement.prototype.scrollIntoView = jest.fn();
  messages = [...messages, { id: "another", role: "assistant", artifacts: { workflowId: "other", yaml: source.replace("Report", "Second report") } }];
  jest.spyOn(workflowService, "readiness").mockImplementation(async id => ({ ...record, workflowId: id, yaml: id === "other" ? source.replace("Report", "Second report") : source }));
  jest.spyOn(executionService, "list").mockResolvedValue([]);
  jest.spyOn(chatService, "models").mockResolvedValue({ configured: true, binding: { model: "model-a" }, models: ["model-a"] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={["/chat/chat?workflow=report"]}><Routes><Route path="/chat/:sessionId" element={<><ChatPage /><Location /></>} /></Routes></MemoryRouter></QueryClientProvider>);
  await screen.findByRole("button", { name: "Select step invoices", exact: true });
  fireEvent.change(screen.getByRole("textbox", { name: "Message to workflow assistant" }), { target: { value: "Keep this conversation question" } });
  fireEvent.change(screen.getByRole("combobox", { name: "Workflow draft" }), { target: { value: "workflow:other" } });
  await waitFor(() => expect(screen.getByLabelText("Current route").textContent).toBe("/chat/chat?workflow=other"));
  expect(screen.getByRole("textbox", { name: "Message to workflow assistant" }).value).toBe("Keep this conversation question");
  expect(normalSend).not.toHaveBeenCalled(); client.clear();
});
