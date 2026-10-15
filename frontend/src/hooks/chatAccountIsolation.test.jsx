/** @jest-environment jsdom */
import React from "react";
import { jest, expect, test, beforeEach, afterEach } from "@jest/globals";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, act, waitFor, cleanup } from "@testing-library/react";
import { authorityScope, beginAuthorityTransition, captureAuthority, isAuthorityCurrent, transitionAuthority } from "../utils/authAuthority";
import { chatQueryKeys } from "../utils/chatQueryKeys";
import { prepareChatCommand } from "../utils/chatCommand";

const accountA = { id: "account-a", role: "Operator", permissions: ["chat:use"] };
const accountB = { id: "account-b", role: "Operator", permissions: ["chat:use"] };
const privateSession = { id: "a-session", title: "A private payroll chat" };
const privateMessage = { id: "a-message", role: "assistant", text: "A confidential payroll result" };
let identity;
const service = Object.fromEntries(["listSessions", "getSession", "operations", "operation", "createSession", "deleteSession", "updateSession", "sendMessage", "capabilities", "cancelOperation"].map(name => [name, jest.fn()]));
jest.unstable_mockModule("../context/AuthContext", () => ({ useAuthContext: () => { transitionAuthority(identity); return { user: identity }; } }));
jest.unstable_mockModule("../services/chat.service", () => ({ chatService: service }));
const { useChat } = await import("./useChat");
const { useChatSessions } = await import("./useChatSessions");
let client;
function wrapper({ children }) { return <QueryClientProvider client={client}>{children}</QueryClientProvider>; }
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function denied() { return Object.assign(new Error("Forbidden"), { response: { status: 403, data: { message: "Session belongs to another account" } } }); }
function useWorkspace(initialSessionId = "") {
  const sessions = useChatSessions(initialSessionId);
  const chat = useChat(sessions.selectedSessionId);
  return { sessions, chat };
}
async function loadA(initialSessionId = "") {
  const view = renderHook(() => useWorkspace(initialSessionId), { wrapper });
  await waitFor(() => expect(view.result.current.sessions.sessions).toEqual([privateSession]));
  await waitFor(() => expect(view.result.current.chat.messages).toEqual([privateMessage]));
  return view;
}
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  identity = accountA;
  transitionAuthority(identity);
  // Match App's ordinary cache freshness; never clear cache to simulate an account switch.
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 15000 }, mutations: { retry: false } } });
  service.listSessions.mockImplementation(async () => identity.id === accountA.id ? [privateSession] : []);
  service.getSession.mockImplementation(async id => {
    if (identity.id !== accountA.id) throw denied();
    return { id, messages: [privateMessage], hasMoreMessages: true };
  });
  service.operations.mockResolvedValue([]);
});
afterEach(() => { cleanup(); client.clear(); localStorage.clear(); sessionStorage.clear(); beginAuthorityTransition(); Object.values(service).forEach(mock => mock.mockReset()); });

test("older conversation pages append without duplicates and remain loaded after refresh", async () => {
  service.listSessions.mockImplementation(async ({params}) => ({items:Array.from({length:params.page===3?5:20},(_,index)=>({id:`s${(params.page-1)*20+index}`})),meta:{page:params.page,total:45,totalPages:3}}));
  const view=renderHook(()=>useChatSessions(),{wrapper});await waitFor(()=>expect(view.result.current.sessions).toHaveLength(20));
  expect(view.result.current.hasMoreSessions).toBe(true);
  await act(async()=>{await view.result.current.loadMoreSessions();});expect(view.result.current.sessions).toHaveLength(40);
  await act(async()=>{await view.result.current.loadMoreSessions();});expect(view.result.current.sessions).toHaveLength(45);expect(view.result.current.hasMoreSessions).toBe(false);
  await act(async()=>{await view.result.current.reload();});expect(view.result.current.sessions).toHaveLength(45);expect(new Set(view.result.current.sessions.map(s=>s.id)).size).toBe(45);
});
test("older list failure retains the loaded conversations and exposes an explicit retry",async()=>{
  service.listSessions.mockResolvedValueOnce({items:[privateSession],meta:{page:1,total:2,totalPages:2}}).mockRejectedValueOnce(new Error("offline"));
  const view=renderHook(()=>useChatSessions(),{wrapper});await waitFor(()=>expect(view.result.current.sessions).toEqual([privateSession]));
  await act(async()=>{await view.result.current.loadMoreSessions();});expect(view.result.current.sessions).toEqual([privateSession]);expect(view.result.current.loadMoreSessionsError).toMatch(/could not be loaded/);
});

test("a new workspace does not automatically download the most recent saved conversation", async () => {
  const view = renderHook(() => useChatSessions("", { autoSelect: false }), { wrapper });
  await waitFor(() => expect(view.result.current.sessions).toHaveLength(1));
  expect(view.result.current.selectedSessionId).toBe("");
  act(() => view.result.current.setSelectedSessionId(privateSession.id));
  expect(view.result.current.selectedSessionId).toBe(privateSession.id);
});

test("native history pagination sends a keyset cursor instead of an offset or unbounded fetch",async()=>{
  service.listSessions.mockResolvedValueOnce({items:[privateSession],meta:{page:1,total:25,totalPages:2,nextCursor:"page-one-cursor",indexed:true}}).mockResolvedValueOnce({items:[{id:"older"}],meta:{page:2,total:25,totalPages:2,nextCursor:null,indexed:true}});
  const view=renderHook(()=>useChatSessions(),{wrapper});await waitFor(()=>expect(view.result.current.sessions).toHaveLength(1));
  await act(async()=>{await view.result.current.loadMoreSessions();});expect(service.listSessions.mock.calls[1][0].params).toEqual({page:2,limit:20,after:"page-one-cursor"});
  expect(view.result.current.sessions).toHaveLength(2);expect(view.result.current.hasMoreSessions).toBe(false);
});
test("older message pages deduplicate and survive a latest-page refetch",async()=>{
  const view=await loadA(privateSession.id);
  service.getSession.mockImplementation(async(id,options)=>options?.before?{id,messages:[{id:"old",role:"user",text:"Older"},privateMessage],hasMoreMessages:false}:{id,messages:[privateMessage],hasMoreMessages:true});
  await act(async()=>{await view.result.current.chat.loadMore();});expect(view.result.current.chat.messages.map(m=>m.id)).toEqual(["old",privateMessage.id]);
  await act(async()=>{await client.invalidateQueries({queryKey:chatQueryKeys.session(authorityScope(identity),privateSession.id)});});
  expect(view.result.current.chat.messages.map(m=>m.id)).toEqual(["old",privateMessage.id]);expect(view.result.current.chat.hasMoreMessages).toBe(false);
});
test("older message failure preserves saved messages without an unhandled rejection",async()=>{
  const view=await loadA(privateSession.id);service.getSession.mockRejectedValueOnce(new Error("offline"));
  await act(async()=>{await view.result.current.chat.loadMore();});expect(view.result.current.chat.messages).toEqual([privateMessage]);expect(view.result.current.chat.loadMoreError).toMatch(/could not be loaded/);
});

test("a fresh shared cache does not show A's list, auto-selected session or messages on a same-SPA B rerender", async () => {
  const view = await loadA();
  act(() => { identity = accountB; view.rerender(); });
  expect({ sessions: view.result.current.sessions.sessions, selected: view.result.current.sessions.selectedSessionId, messages: view.result.current.chat.messages }).toEqual({ sessions: [], selected: "", messages: [] });
});

test("workflow catalog identities are scoped to the account and disappear immediately on an account switch", async () => {
  const catalog = [{ workflowId: "a-payroll-workflow", name: "Private payroll", lastMessageIndex: 0 }];
  service.getSession.mockImplementation(async id => {
    if (identity.id !== accountA.id) throw denied();
    return { id, messages: [privateMessage], workflowCatalog: catalog, hasMoreMessages: true };
  });
  const view = await loadA();
  expect(view.result.current.chat.workflowCatalog).toEqual(catalog);
  act(() => { identity = accountB; view.rerender(); });
  expect(view.result.current.chat.workflowCatalog).toEqual([]);
});

test("B remount cannot consume A's cached list or message before B's held response", async () => {
  const view = await loadA();
  view.unmount();
  const heldB = deferred();
  service.listSessions.mockReturnValue(heldB.promise);
  identity = accountB;
  const next = renderHook(() => useWorkspace(), { wrapper });
  expect({ sessions: next.result.current.sessions.sessions, messages: next.result.current.chat.messages }).toEqual({ sessions: [], messages: [] });
  await act(async () => { heldB.resolve([]); });
});

test("B's explicit route remains empty and reports ownership denial after the server returns 403", async () => {
  const view = await loadA(privateSession.id);
  act(() => { identity = accountB; view.rerender(); });
  await act(async () => { await client.invalidateQueries(); });
  await waitFor(() => expect(client.getQueryCache().getAll().some(query => query.state.error?.response?.status === 403)).toBe(true));
  expect({ messages: view.result.current.chat.messages, error: view.result.current.chat.error }).toEqual({ messages: [], error: "Session belongs to another account" });
});

test("a denied operations read hides already cached messages, artifacts, and operation state", async () => {
  const view = await loadA(privateSession.id);
  service.operations.mockRejectedValueOnce(denied());
  const key = chatQueryKeys.operations(authorityScope(accountA), privateSession.id);
  await act(async () => { await client.invalidateQueries({ queryKey: key }); });
  await waitFor(() => expect(client.getQueryCache().find({ queryKey: key }).state.error?.response?.status).toBe(403));
  expect({ messages: view.result.current.chat.messages, artifact: view.result.current.chat.artifact, more: view.result.current.chat.hasMoreMessages, operation: view.result.current.chat.operation }).toEqual({ messages: [], artifact: null, more: false, operation: null });
  expect(view.result.current.chat.error).toBe("Session belongs to another account");
});

test("same-account network failure retains its own cached chat and list", async () => {
  const view = await loadA(privateSession.id);
  service.getSession.mockRejectedValueOnce(Object.assign(new Error("Network Error"), { request: {} }));
  await act(async () => { await client.invalidateQueries({ queryKey: chatQueryKeys.session(authorityScope(accountA), privateSession.id) }); });
  await waitFor(() => expect(client.getQueryCache().find({ queryKey: chatQueryKeys.session(authorityScope(accountA), privateSession.id) }).state.error).toBeDefined());
  expect(view.result.current.chat.messages).toEqual([privateMessage]);
  expect(view.result.current.sessions.sessions).toEqual([privateSession]);
});

test("same A reopening a fresh chat retains its own list and message cache", async () => {
  const view = await loadA();
  const listCalls = service.listSessions.mock.calls.length;
  const readCalls = service.getSession.mock.calls.length;
  view.unmount();
  const reopened = renderHook(() => useWorkspace(), { wrapper });
  expect(reopened.result.current.sessions.sessions).toEqual([privateSession]);
  expect(reopened.result.current.chat.messages).toEqual([privateMessage]);
  expect(service.listSessions).toHaveBeenCalledTimes(listCalls);
  expect(service.getSession).toHaveBeenCalledTimes(readCalls);
});

test("a held A session response resolving after B switches cannot become B's visible messages", async () => {
  const heldA = deferred();
  service.getSession.mockReturnValueOnce(heldA.promise);
  const view = renderHook(() => useWorkspace(privateSession.id), { wrapper });
  await waitFor(() => expect(service.getSession).toHaveBeenCalledWith(privateSession.id, { limit: 20, signal: expect.any(AbortSignal) }));
  act(() => { identity = accountB; view.rerender(); });
  await act(async () => { heldA.resolve({ id: privateSession.id, messages: [privateMessage] }); });
  await waitFor(() => expect(client.isFetching()).toBe(0));
  expect(view.result.current.chat.messages).toEqual([]);
});

test("a held A list response resolving after B switches cannot select A's chat", async () => {
  const heldA = deferred();
  service.listSessions.mockReturnValueOnce(heldA.promise);
  const view = renderHook(() => useWorkspace(), { wrapper });
  await waitFor(() => expect(service.listSessions).toHaveBeenCalled());
  act(() => { identity = accountB; view.rerender(); });
  await act(async () => { heldA.resolve([privateSession]); });
  await waitFor(() => expect(client.isFetching()).toBe(0));
  expect({ sessions: view.result.current.sessions.sessions, selected: view.result.current.sessions.selectedSessionId, messages: view.result.current.chat.messages }).toEqual({ sessions: [], selected: "", messages: [] });
});

test("an A pagination response held across B's switch cannot prepend private older messages", async () => {
  const view = await loadA(privateSession.id);
  const heldOlder = deferred();
  service.getSession.mockImplementation((id, options) => options?.before ? heldOlder.promise : Promise.reject(denied()));
  let loading;
  act(() => { loading = view.result.current.chat.loadMore(); });
  expect(service.getSession.mock.calls.at(-1)[0]).toBe(privateSession.id);
  expect(service.getSession.mock.calls.at(-1)[1]).toMatchObject({ before: privateMessage.id, signal: expect.any(AbortSignal) });
  act(() => { identity = accountB; view.rerender(); });
  await act(async () => { heldOlder.resolve({ id: privateSession.id, messages: [{ id: "a-older", role: "user", text: "A older private prompt" }], hasMoreMessages: false }); await loading; });
  expect(view.result.current.chat.messages).toEqual([]);
});

test("an A create response held across B's switch cannot select or cache A's created chat for B", async () => {
  const view = await loadA();
  const heldCreate = deferred();
  service.createSession.mockReturnValue(heldCreate.promise);
  let creating;
  act(() => { creating = view.result.current.sessions.createSession("A new private chat"); });
  act(() => { identity = accountB; view.rerender(); });
  await act(async () => { heldCreate.resolve({ id: "a-new", title: "A new private chat" }); await expect(creating).rejects.toMatchObject({ code: "ERR_STALE_AUTHORITY" }); });
  expect({ sessions: view.result.current.sessions.sessions, selected: view.result.current.sessions.selectedSessionId }).toEqual({ sessions: [], selected: "" });
});

test("a held rename response cannot update A's list after switching to B", async () => {
  const view = await loadA();
  const scopeA = authorityScope(accountA);
  const heldRename = deferred();
  service.updateSession.mockReturnValue(heldRename.promise);
  let renaming;
  act(() => { renaming = view.result.current.sessions.renameSession(privateSession.id, "renamed privately"); });
  act(() => { identity = accountB; view.rerender(); });
  await act(async () => { heldRename.resolve({ id: privateSession.id, title: "renamed privately" }); await expect(renaming).rejects.toMatchObject({ code: "ERR_STALE_AUTHORITY" }); });
  expect(client.getQueryData(chatQueryKeys.sessions(scopeA))).toEqual([privateSession]);
  expect(view.result.current.sessions.sessions).toEqual([]);
});

test("a held delete response cannot remove A's cache after switching to B", async () => {
  const view = await loadA();
  const scopeA = authorityScope(accountA);
  const heldDelete = deferred();
  service.deleteSession.mockReturnValue(heldDelete.promise);
  let deleting;
  act(() => { deleting = view.result.current.sessions.deleteSession(privateSession.id); });
  act(() => { identity = accountB; view.rerender(); });
  await act(async () => { heldDelete.resolve({ ok: true }); await expect(deleting).rejects.toMatchObject({ code: "ERR_STALE_AUTHORITY" }); });
  expect(client.getQueryData(chatQueryKeys.sessions(scopeA))).toEqual([privateSession]);
  expect(view.result.current.sessions.sessions).toEqual([]);
});

test("a callback captured for A cannot reauthorize itself after A to B to A", async () => {
  const view = await loadA();
  const oldCreate = view.result.current.sessions.createSession;
  act(() => { identity = accountB; view.rerender(); });
  act(() => { identity = accountA; view.rerender(); });
  await expect(oldCreate("stale A chat")).rejects.toMatchObject({ code: "ERR_STALE_AUTHORITY" });
  expect(service.createSession).not.toHaveBeenCalled();
  await waitFor(() => expect(view.result.current.sessions.sessions).toEqual([privateSession]));
  expect(view.result.current.sessions.sessions).toEqual([privateSession]);
});

test("a held capability response after account switch prevents the send POST", async () => {
  const view = await loadA(privateSession.id);
  const heldCapability = deferred();
  service.capabilities.mockReturnValue(heldCapability.promise);
  let sending;
  act(() => { sending = view.result.current.chat.send("private prompt", privateSession.id, { delivery: "async-chat", emailDraftCommand: { kind: "test" } }); });
  await waitFor(() => expect(service.capabilities).toHaveBeenCalled());
  act(() => { identity = accountB; view.rerender(); });
  await act(async () => { heldCapability.resolve({ profile: "chat-admission-v1", asyncChat: true }); await sending; });
  expect(service.sendMessage).not.toHaveBeenCalled();
});

test("a held command digest cannot write identity after authority changes", async () => {
  const view = await loadA(privateSession.id);
  const authority = captureAuthority(identity);
  const digestGate = deferred();
  const originalCrypto = globalThis.crypto;
  const mockCrypto = { subtle: { digest: jest.fn(() => digestGate.promise) }, getRandomValues: bytes => bytes.fill(9) };
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: mockCrypto });
  const storageKey = "workflow.workspace.account-a.chat-command.a-session";
  try {
    const pending = prepareChatCommand(identity, privateSession.id, "private prompt", {}, () => isAuthorityCurrent(authority)).then(value => ({ value }), error => ({ error }));
    act(() => { identity = accountB; view.rerender(); });
    await act(async () => { digestGate.resolve(new Uint8Array(32).buffer); });
    expect((await pending).error).toMatchObject({ code: "ERR_STALE_AUTHORITY" });
    expect(sessionStorage.getItem(storageKey)).toBeNull();
  } finally {
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: originalCrypto });
  }
});

test("a held send response cannot update A's cache after an A to B to A transition", async () => {
  const view = await loadA(privateSession.id);
  const heldSend = deferred();
  service.sendMessage.mockReturnValue(heldSend.promise);
  let sending;
  act(() => { sending = view.result.current.chat.send("private prompt", privateSession.id, { emailDraftCommand: { kind: "test" } }); });
  await waitFor(() => expect(service.sendMessage).toHaveBeenCalled());
  act(() => { identity = accountB; view.rerender(); });
  act(() => { identity = accountA; view.rerender(); });
  await act(async () => { heldSend.resolve({ session: { id: privateSession.id }, userMessage: { id: "new-u" }, assistantMessage: { id: "new-a" } }); await sending; });
  await waitFor(() => expect(view.result.current.chat.messages).toEqual([privateMessage]));
  expect(client.getQueryData(chatQueryKeys.session(authorityScope(accountA), privateSession.id))?.messages).toEqual([privateMessage]);
});
