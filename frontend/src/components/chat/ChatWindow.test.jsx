/** @jest-environment jsdom */
import React from "react";
import "@testing-library/jest-dom/jest-globals";
import { expect, jest, test, afterEach } from "@jest/globals";
import { render, screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react";
import { ChatWorkspaceContext } from "./ChatWorkspaceContext";
jest.unstable_mockModule("./ChatMessage", () => ({ default: () => null }));
const loadModels = jest.fn().mockResolvedValue({ configured: true, binding: { model: "model-a" }, models: ["model-a", "model-b"] });
const documentService = Object.fromEntries(["catalog", "inventory", "list", "get", "stage", "analyse", "confirm", "recover"].map(name => [name, jest.fn()]));
jest.unstable_mockModule("../../services/document-workspace.service", () => ({ documentWorkspaceService: documentService }));
jest.unstable_mockModule("../../services/chat.service", () => ({ chatService: { models: loadModels } }));
jest.unstable_mockModule("../../utils/workflowCanvas.utils", () => ({ peekWorkflowForChatEdit: () => null, clearWorkflowForChatEdit: () => {} }));
const { default: ChatWindow } = await import("./ChatWindow");
const { default: ChatWorkspaceLayout } = await import("./ChatWorkspaceLayout");
HTMLElement.prototype.scrollIntoView = jest.fn();
afterEach(() => { cleanup(); sessionStorage.clear(); });

test("attach chooses a local file and sends it with the normal prompt only when Send is pressed", async () => {
  const onSend = jest.fn().mockResolvedValue({ operation: { id: "saved" } });
  render(<ChatWindow messages={[]} onSend={onSend} canUploadDocuments documentSessionId="chat" draftStorageKey="attach.normal" />);
  const file = new File(["customer_name: Client A"], "customer.txt");
  fireEvent.change(screen.getByLabelText("Choose message attachment"), { target: { files: [file] } });
  expect(screen.getByLabelText("Message attachment")).toHaveTextContent("customer.txt");
  expect(documentService.stage).not.toHaveBeenCalled(); expect(onSend).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole("textbox", { name: "Message to workflow assistant" }), { target: { value: "Register this customer" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "Send message" })).not.toBeDisabled());
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(onSend).toHaveBeenCalledWith("Register this customer", expect.objectContaining({ attachment: { file, idempotencyKey: expect.any(String) } })));
  await waitFor(() => expect(screen.queryByLabelText("Message attachment")).toBeNull());
});

test("attachment survives an unconfirmed send and is cleared when switching conversations", async () => {
  const onSend = jest.fn().mockResolvedValue(null);
  const view = render(<ChatWindow messages={[]} onSend={onSend} canUploadDocuments draftStorageKey="attach.first" />);
  fireEvent.change(screen.getByLabelText("Choose message attachment"), { target: { files: [new File(["form"], "form.txt")] } });
  fireEvent.change(screen.getByRole("textbox", { name: "Message to workflow assistant" }), { target: { value: "Read this form" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "Send message" })).not.toBeDisabled());
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Send message" })).not.toBeDisabled());
  expect(screen.getByLabelText("Message attachment")).toHaveTextContent("form.txt");
  view.rerender(<ChatWindow messages={[]} onSend={onSend} canUploadDocuments draftStorageKey="attach.second" />);
  await waitFor(() => expect(screen.queryByLabelText("Message attachment")).toBeNull());
});

test("workflow help waits for the matching scope and preserves the unsent message without submitting", async () => {
  const onSend = jest.fn(), acknowledgeComposerRequest = jest.fn();
  const request = { id: "help-1", workflowId: "target", text: "Help me complete this workflow." };
  const workspace = { composerRequest: request, acknowledgeComposerRequest, focusChat: jest.fn() };
  const show = context => <ChatWorkspaceContext.Provider value={workspace}><ChatWindow messages={[]} onSend={onSend} draftStorageKey="help.draft" workflowContext={context} /></ChatWorkspaceContext.Provider>;
  const view = render(show({ workflowId: "other" }));
  const input = screen.getByRole("textbox", { name: "Message to workflow assistant" });
  fireEvent.change(input, { target: { value: "Keep my question" } });
  expect(acknowledgeComposerRequest).not.toHaveBeenCalled();
  view.rerender(show({ workflowId: "target", pending: true }));
  expect(input.value).toBe("Keep my question");
  view.rerender(show({ workflowId: "target", pending: false }));
  await waitFor(() => expect(input.value).toBe("Keep my question\n\nHelp me complete this workflow."));
  view.rerender(show({ workflowId: "target", pending: false }));
  expect(acknowledgeComposerRequest).toHaveBeenCalledTimes(1);
  expect(onSend).not.toHaveBeenCalled();
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

test("shared catalog renders immediately without requesting models again for each conversation", async () => {
  const before = loadModels.mock.calls.length, refetch = jest.fn();
  const catalog = { data: { configured: true, models: ["model-a"], binding: { model: "model-a" } }, isPending: false, isFetching: false, refetch };
  const view = render(<ChatWindow messages={[]} modelCatalog={catalog} draftStorageKey="one" />);
  expect(await screen.findByRole("combobox", { name: "Requested model" })).toBeTruthy();
  view.rerender(<ChatWindow messages={[]} modelCatalog={catalog} draftStorageKey="two" />);
  expect(loadModels.mock.calls.length).toBe(before);
  fireEvent.click(screen.getByRole("button", { name: "Refresh configured models" })); expect(refetch).toHaveBeenCalledTimes(1);
});

test("administrative review hides the composer and cannot send or revise as the owner", async () => {
  const onSend = jest.fn(), onRevise = jest.fn();
  render(<ChatWindow messages={[{ id: "private", role: "user", text: "Saved message" }]} readOnly onSend={onSend} onRevise={onRevise} />);
  expect(screen.getByText(/Read-only administrative review/)).toBeTruthy();
  expect(screen.queryByRole("textbox")).toBeNull(); expect(screen.queryByRole("button", { name: "Send message" })).toBeNull();
  expect(onSend).not.toHaveBeenCalled(); expect(onRevise).not.toHaveBeenCalled();
  await act(async () => {});
});

test("a denied conversation does not offer an unusable composer or misleading administrative review", async () => {
  render(<ChatWindow messages={[]} unavailable error="Chat session not found" />);
  expect(screen.getByText(/Open Chat History to choose your own conversation/)).toBeTruthy();
  expect(screen.queryByRole("textbox")).toBeNull(); expect(screen.queryByText(/Read-only administrative review/)).toBeNull();
  await act(async () => {});
});

test("model loading keeps an editable draft but blocks premature sends until the approved catalog arrives", async () => {
  let finish; loadModels.mockReturnValueOnce(new Promise(resolve => { finish = resolve; })); const onSend = jest.fn().mockResolvedValue({});
  render(<ChatWindow messages={[]} onSend={onSend} draftStorageKey="loading.models" />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Hello" } });
  expect(screen.getByText(/Loading approved models/)).toBeTruthy(); expect(screen.getByRole("textbox").disabled).toBe(false);
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" }); fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  expect(onSend).not.toHaveBeenCalled(); expect(screen.getByRole("button", { name: "Send message" }).disabled).toBe(true);
  await act(async () => finish({ configured: true, binding: { model: "model-a" }, models: ["model-a"] }));
  expect(screen.getByRole("button", { name: "Send message" }).disabled).toBe(false); expect(screen.getByRole("textbox").value).toBe("Hello");
});

test("opening a saved conversation shows its own loading state rather than an empty new-chat screen", async () => {
  sessionStorage.setItem("loading.chat", "My saved draft");
  const view = render(<ChatWindow messages={[]} sessionLoading draftStorageKey="loading.chat" />);
  expect(screen.getByText(/Loading this conversation/)).toBeTruthy(); expect(screen.queryByText("What would you like to do?")).toBeNull();
  expect(screen.getByRole("textbox").disabled).toBe(true); expect(screen.getByRole("region", { name: "Workflow chat" }).getAttribute("aria-busy")).toBe("true");
  view.rerender(<ChatWindow messages={[]} sessionLoading={false} draftStorageKey="loading.chat" />);
  await screen.findByRole("combobox", { name: "Requested model" });
  expect(screen.getByRole("textbox").value).toBe("My saved draft"); expect(screen.getByRole("textbox").disabled).toBe(false);
});

test("rapid Enter/click attempts admit only one send and a failed acknowledgement keeps the draft", async () => {
  let finish; const onSend = jest.fn(() => new Promise(resolve => { finish = resolve; }));
  render(<ChatWindow messages={[]} onSend={onSend} draftStorageKey="loading.pending" />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Keep this draft" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "Send message" }).disabled).toBe(false));
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" }); fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
  expect(onSend).toHaveBeenCalledTimes(1); expect(screen.getByRole("textbox").disabled).toBe(true);
  await act(async () => finish(null));
  expect(screen.getByRole("textbox").value).toBe("Keep this draft"); expect(screen.getByRole("textbox").disabled).toBe(false);
});

test("conversation-load retry only reloads saved state; it does not resend a business request", async () => {
  const reload = jest.fn(), onSend = jest.fn();
  render(<ChatWindow messages={[]} error="Could not load saved messages" onReloadConversation={reload} onSend={onSend} />);
  fireEvent.click(screen.getByRole("button", { name: "Reload conversation" })); expect(reload).toHaveBeenCalledTimes(1); expect(onSend).not.toHaveBeenCalled();
  await screen.findByRole("combobox", { name: "Requested model" });
});

test("scrolling up to the top loads one earlier page and preserves the viewport", async () => {
  const onLoadMore=jest.fn().mockResolvedValue(undefined);
  render(<ChatWindow messages={[{id:"saved",role:"user",text:"Saved"}]} hasMoreMessages totalMessages={60} onLoadMore={onLoadMore}/>);
  const region=screen.getByRole("region",{name:"Conversation messages"});
  Object.defineProperty(region,"scrollHeight",{value:1000,configurable:true});
  fireEvent.scroll(region,{target:{scrollTop:200}});fireEvent.scroll(region,{target:{scrollTop:0}});
  await waitFor(()=>expect(onLoadMore).toHaveBeenCalledTimes(1));
  expect(screen.getByText(/Showing 1 of 60 messages/)).toBeTruthy();
});
test("a pagination failure is visible and does not loop automatically", async () => {
  const onLoadMore=jest.fn();render(<ChatWindow messages={[{id:"saved"}]} hasMoreMessages onLoadMore={onLoadMore} loadMoreError="Older page unavailable"/>);
  const region=screen.getByRole("region",{name:"Conversation messages"});fireEvent.scroll(region,{target:{scrollTop:100}});fireEvent.scroll(region,{target:{scrollTop:0}});
  expect(screen.getByRole("alert").textContent).toBe("Older page unavailable");expect(onLoadMore).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button",{name:"Load earlier messages"}));await waitFor(()=>expect(onLoadMore).toHaveBeenCalledTimes(1));
});
test("the oldest page has a clear end marker instead of a dead pagination button",()=>{
  render(<ChatWindow messages={[{id:"saved"}]} hasMoreMessages={false}/>);expect(screen.getByText(/Start of conversation/)).toBeTruthy();expect(screen.queryByRole("button",{name:"Load earlier messages"})).toBeNull();
});

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
  await waitFor(() => expect(screen.getByRole("button", { name: "Send message" }).disabled).toBe(false));
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

test("Agent Workspace has a visible document shortcut and drafts from a reviewed PDF without auto-sending", async () => {
  const receipt = { id: "upload", status: "READY", revision: 2, filename: "clients.pdf", document_id: "doc", version: 1, session_id: "chat" };
  documentService.catalog.mockResolvedValue({ entities: [] }); documentService.inventory.mockResolvedValue({ searchable_documents: 1, pending_review: 0, as_of: new Date().toISOString(), counts_complete: true });
  documentService.list.mockResolvedValue({ items: [receipt] }); documentService.get.mockResolvedValue(receipt);
  const onSend = jest.fn().mockResolvedValue({});
  render(<ChatWorkspaceLayout storageKey="documents.layout" chat={<ChatWindow messages={[]} documentSessionId="chat" canUploadDocuments canAuthorWorkflows onSend={onSend} draftStorageKey="documents.draft" />} canvas={<p>Workflow canvas</p>} />);
  expect(screen.getByRole("button", { name: "Attach file" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Workspace tools", exact: true }));
  const shortcut = screen.getByRole("button", { name: "Upload or review workflow documents" }); expect(shortcut).toBeVisible();
  fireEvent.click(shortcut);
  const select = await screen.findByRole("combobox", { name: "Uploaded in this conversation" });
  fireEvent.change(select, { target: { value: "upload" } });
  const outcome = await screen.findByRole("textbox", { name: "Workflow request" });
  fireEvent.change(outcome, { target: { value: "Add these clients and check duplicates" } });
  fireEvent.click(screen.getByRole("checkbox", { name: "Also assess scheduling requirements" }));
  fireEvent.click(screen.getByRole("button", { name: "Use reviewed data for ERP workflow" }));
  const composer = screen.getByRole("textbox", { name: "Message to workflow assistant" });
  expect(composer.value).toContain("Add these clients and check duplicates"); expect(composer.value).toContain("eligible for scheduling");
  expect(onSend).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.getByRole("button", { name: "Send message" })).not.toBeDisabled());
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(onSend).toHaveBeenCalledWith(expect.stringContaining("Add these clients and check duplicates"), {
    model: "model-a", documentContext: { uploadId: "upload", documentId: "doc", version: 1, purpose: "erp_record_proposal" },
  }));
});
