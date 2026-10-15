import { afterEach, expect, test, vi } from "vitest";
import jwt from "jsonwebtoken";
import { boundedChatFixture } from "./fixtures/bounded-chat-task.js";
import { FunctionServiceReadRequired, handleFunctionProgress, isFunctionProgressRequest } from "../src/firebase/progress-http.js";
import type { ProgressSnapshotReader } from "../src/storage/firestore-progress-reader.js";
import type { RepositoryState } from "../src/repository/store.js";
import { splitFirestoreState } from "../src/storage/firestore-record-layout.js";
import { nativeRecordIndex } from "../src/storage/firestore-native-fields.js";
import { scopedProgressView } from "../src/storage/firestore-scoped-progress.js";

const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => { await Promise.all(closers.splice(0).map(close => close())); });
async function setup() {
  const f = await boundedChatFixture(); closers.push(f.close);
  expect((await f.publish()).statusCode).toBe(200);
  const admitted = await f.run(), sent = await f.send();
  expect(admitted.statusCode).toBe(202); expect(sent.statusCode).toBe(202);
  const runId = admitted.json().data.id, operationId = sent.json().data.operation.id;
  const config = { ...f.services.config, storageDriver: "firestore-records" as const, firestoreProjectId: "demo-lcwe-records", firestoreDatabaseId: "(default)", firestoreWorkspaceId: "test_progress" };
  const snapshot = vi.fn(async (): Promise<RepositoryState> => f.repository.snapshot()), close = vi.fn(async () => {});
  const open = vi.fn((): ProgressSnapshotReader => ({ snapshot, close }));
  const get = (url: string, headers: Record<string, string> = f.headers, extra: Record<string, unknown> = {}) => handleFunctionProgress(config, { method: "GET", url, headers, ...extra }, open);
  return { ...f, config, runId, operationId, snapshot, closeReader: close, open, get };
}

test("scoped screen reads match resident contracts without a full workspace snapshot",async()=>{
  const f=await setup();
  const scoped=vi.fn(async(actorId,request)=>{
    const records=splitFirestoreState(await f.repository.snapshot()),byKey=new Map(records.map(record=>[JSON.stringify(record.path),record]));
    return scopedProgressView({entries:records.map(record=>({path:record.path,index:nativeRecordIndex(record.path,record.value)})),
      read:async paths=>paths.map(path=>structuredClone(byKey.get(JSON.stringify(path))??null))},actorId,request);
  });
  const full=vi.fn(async()=>{throw new Error("Full workspace must not load");});
  f.open.mockReturnValue({snapshot:full,close:f.closeReader,scoped});
  const state=await f.repository.snapshot(),workflowId=Object.keys(state.workflows)[0]!;
  for(const url of ["/api/auth/me", "/api/workflows?limit=20", "/api/notifications?limit=20", `/api/workflows/${workflowId}`,`/api/workflows/${workflowId}/yaml`,
    `/api/chat/sessions/${f.sessionId}?limit=20`,`/api/chat/sessions/${f.sessionId}/operations`, `/api/chat/operations/${f.operationId}?after=0`,
    `/api/executions/${f.runId}`,`/api/executions/${f.runId}/events?after=0&limit=1`,`/api/executions/${f.runId}/logs`,`/api/executions/${f.runId}/timeline`]){
    const actual=await f.get(url),expected=await f.app.inject({method:"GET",url,headers:f.headers});
    expect(actual.statusCode,url+" "+actual.body.toString()).toBe(expected.statusCode);
    expect(JSON.parse(actual.body.toString()),url).toEqual(expected.json());
  }
  expect(full).not.toHaveBeenCalled();expect(scoped).toHaveBeenCalledTimes(12);
});

test("durably recorded stop requests remain visible before the owning worker consumes them", async () => {
  const f = await setup(), before = await f.repository.snapshot(), cancellationRequested = vi.fn(async () => true);
  f.open.mockReturnValue({ snapshot: f.snapshot, close: f.closeReader, cancellationRequested });
  const progress = await f.get(`/api/chat/operations/${f.operationId}`);
  expect(progress.statusCode).toBe(200); expect(JSON.parse(progress.body.toString()).data.operation).toMatchObject({ status: "QUEUED", cancellationRequested: true });
  const listing = await f.get(`/api/chat/sessions/${f.sessionId}/operations`);
  expect(listing.statusCode).toBe(200); expect(JSON.parse(listing.body.toString()).data[0].cancellationRequested).toBe(true);
  expect(cancellationRequested).toHaveBeenCalledTimes(2); expect(await f.repository.snapshot()).toEqual(before);
  expect(f.sdk.callTool).not.toHaveBeenCalled(); expect(f.fetchImplementation).not.toHaveBeenCalled();
});

test("unknown stop-control read is not disguised as an uncancelled operation or retried work", async () => {
  const f = await setup(), cancellationRequested = vi.fn(async () => { throw new Error("Private packet mismatch"); });
  f.open.mockReturnValue({ snapshot: f.snapshot, close: f.closeReader, cancellationRequested });
  const progress = await f.get(`/api/chat/operations/${f.operationId}`);
  expect(progress.statusCode).toBe(503); expect(progress.body.toString()).not.toContain("Private packet");
  expect(f.sdk.callTool).not.toHaveBeenCalled(); expect(f.fetchImplementation).not.toHaveBeenCalled();
});
test("all seven progress contracts match the resident API without SDK, model, enqueue or state mutations", async () => {
  const f = await setup(), before = await f.repository.snapshot();
  f.sdk.callTool.mockClear(); f.fetchImplementation.mockClear(); f.enqueue.mockClear();
  for (const url of [`/api/executions/${f.runId}`, `/api/executions/${f.runId}/events?after=0&limit=1`, `/api/executions/${f.runId}/logs`, `/api/executions/${f.runId}/timeline`,
    `/api/chat/operations/${f.operationId}?after=0`, `/api/chat/sessions/${f.sessionId}/operations`, `/api/chat/sessions/${f.sessionId}?limit=10`]) {
    const actual = await f.get(url), expected = await f.app.inject({ method: "GET", url, headers: f.headers });
    expect(actual.statusCode, actual.body.toString()).toBe(200);
    expect(JSON.parse(actual.body.toString())).toEqual(expected.json());
    expect(actual.headers["cache-control"]).toBe("no-store"); expect(actual.headers["x-trace-id"]).toBeTruthy();
    expect(actual.body.toString()).not.toMatch(/inputCiphertext|taskDispatchSecret|revisionContextCiphertext|argumentHash|idempotencyScope/);
  }
  expect(await f.repository.snapshot()).toEqual(before);
  expect(f.sdk.callTool).not.toHaveBeenCalled(); expect(f.fetchImplementation).not.toHaveBeenCalled(); expect(f.enqueue).not.toHaveBeenCalled();
  expect(f.closeReader).toHaveBeenCalledTimes(7);
});

test("saved workflow metadata and source use the same authenticated read-only contracts as the resident builder", async () => {
  const f = await setup(), state = await f.repository.snapshot(), workflowId = Object.keys(state.workflows)[0]!;
  f.sdk.callTool.mockClear(); f.fetchImplementation.mockClear(); f.enqueue.mockClear();
  for (const suffix of ["", "/yaml"]) {
    const url = `/api/workflows/${workflowId}${suffix}`, actual = await f.get(url), expected = await f.app.inject({ method: "GET", url, headers: f.headers });
    expect(actual.statusCode, actual.body.toString()).toBe(200); expect(JSON.parse(actual.body.toString())).toEqual(expected.json());
    expect(actual.headers["cache-control"]).toBe("no-store");
    const head = await handleFunctionProgress(f.config, { method: "HEAD", url, headers: f.headers }, f.open);
    expect(head.statusCode).toBe(200); expect(head.body.length).toBe(0);
  }
  expect(await f.repository.snapshot()).toEqual(state); expect(f.sdk.callTool).not.toHaveBeenCalled();
  expect(f.fetchImplementation).not.toHaveBeenCalled(); expect(f.enqueue).not.toHaveBeenCalled(); expect(f.closeReader).toHaveBeenCalledTimes(4);
});

test("account and paged list reads match resident contracts without writer/MCP startup", async () => {
  const f = await setup(), before = await f.repository.snapshot();
  f.sdk.callTool.mockClear(); f.fetchImplementation.mockClear(); f.enqueue.mockClear();
  for (const url of ["/api/auth/me", "/api/chat/sessions?page=1&limit=20", "/api/workflows?page=1&limit=20", "/api/notifications?unreadOnly=true&limit=20"]) {
    expect(isFunctionProgressRequest(f.config, {method: "GET", url, headers: f.headers})).toBe(true);
    const actual = await f.get(url), expected = await f.app.inject({method: "GET", url, headers: f.headers});
    expect(actual.statusCode).toBe(200); expect(JSON.parse(actual.body.toString())).toEqual(expected.json());
    expect(actual.headers["cache-control"]).toBe("no-store");
  }
  expect(await f.repository.snapshot()).toEqual(before); expect(f.sdk.callTool).not.toHaveBeenCalled();
  expect(f.fetchImplementation).not.toHaveBeenCalled(); expect(f.enqueue).not.toHaveBeenCalled();
});

test("chat admission capability checks need the actual task transport and current authority, not ERP discovery", async () => {
  const f = await setup(), before = await f.repository.snapshot();
  f.sdk.callTool.mockClear(); f.fetchImplementation.mockClear(); f.enqueue.mockClear();
  const request = { method: "GET", url: "/api/chat/capabilities", headers: f.headers };
  expect(isFunctionProgressRequest(f.config, request)).toBe(true);
  const withoutTransport = await handleFunctionProgress(f.config, request, f.open);
  expect(JSON.parse(withoutTransport.body.toString()).data).toMatchObject({ asyncChat: false, nodeProposals: false, requestRevisions: false });
  const installed = await handleFunctionProgress(f.config, request, f.open, { chatTaskAdmissionAvailable: true });
  expect(installed.statusCode).toBe(200);
  expect(JSON.parse(installed.body.toString()).data).toEqual({ profile: "chat-admission-v1", asyncChat: true, nodeProposals: true, requestRevisions: true, localDraftEdits: true });
  expect(installed.body.toString()).toContain("not provider or ERP readiness");
  expect(await f.repository.snapshot()).toEqual(before);
  await f.repository.mutate(state => { state.roles.role_admin!.permissions = []; });
  expect((await handleFunctionProgress(f.config, request, f.open, { chatTaskAdmissionAvailable: true })).statusCode).toBe(403);
  expect(f.sdk.callTool).not.toHaveBeenCalled(); expect(f.fetchImplementation).not.toHaveBeenCalled(); expect(f.enqueue).not.toHaveBeenCalled();
});

test("workflow pages are newest-first, bounded, and filtered before pagination", async () => {
  const f = await setup();
  await f.repository.mutate(state => {
    const sample = Object.values(state.workflows)[0]!; state.workflows = {};
    for (let i = 0; i < 45; i++) state.workflows[`paged-${i}`] = { ...structuredClone(sample), id: `paged-${i}`, name: `Reference ${i}`, updatedAt: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString() };
  });
  const first = JSON.parse((await f.get("/api/workflows?limit=20")).body.toString());
  const second = JSON.parse((await f.get("/api/workflows?limit=20&page=2")).body.toString());
  const third = JSON.parse((await f.get("/api/workflows?limit=20&page=3")).body.toString());
  expect(first.data).toHaveLength(20); expect(first.data[0].id).toBe("paged-44");
  expect(second.data).toHaveLength(20); expect(third.data).toHaveLength(5);
  expect(new Set([...first.data, ...second.data, ...third.data].map(item => item.id)).size).toBe(45);
  expect(first.meta).toMatchObject({page:1,total:45,totalPages:3}); expect(first.data[0]).not.toHaveProperty("yaml");
  const filtered = JSON.parse((await f.get("/api/workflows?q=Reference%2044&limit=20")).body.toString());
  expect(filtered.meta.total).toBe(1);
});

test("native chat pages preserve owner authorization and use a 20-item keyset cursor",async()=>{
  const f=await setup();await f.repository.mutate(state=>{
    state.roles.operator={id:"operator",name:"Operator",description:"Owner-scoped chat reader",createdAt:"2026-10-01T00:00:00Z",permissions:["chat:use"]};state.users.owner!.roleId="operator";state.chats={};
    for(let i=0;i<48;i++)state.chats[`chat-${i}`]={id:`chat-${i}`,title:i<45?`Owned ${i}`:"Other private chat",ownerId:i<45?"owner":"other",createdAt:"2026-10-01T00:00:00Z",updatedAt:new Date(Date.UTC(2026,9,1,0,i)).toISOString(),messageCount:0,messages:[]};
  });
  const metadataPage=vi.fn(async(state:RepositoryState,kind:string,ownerId:string|undefined,limit:number,after?:{updatedAt:string;entityId:string})=>{
    expect(kind).toBe("chats");expect(ownerId).toBe("owner");return Object.values(state.chats).filter(chat=>chat.ownerId===ownerId&&(!after||chat.updatedAt<after.updatedAt||chat.updatedAt===after.updatedAt&&chat.id>after.entityId)).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)||a.id.localeCompare(b.id)).slice(0,limit).map(chat=>({profile:"runtime-record/v1" as const,path:["domain","chats",chat.id],value:chat}));
  });
  f.open.mockReturnValue({snapshot:f.snapshot,close:f.closeReader,metadataPage});f.sdk.callTool.mockClear();f.enqueue.mockClear();
  const first=JSON.parse((await f.get("/api/chat/sessions?limit=20")).body.toString());expect(first.data).toHaveLength(20);expect(first.data[0].id).toBe("chat-44");expect(first.meta).toMatchObject({total:45,indexed:true});
  const second=JSON.parse((await f.get(`/api/chat/sessions?limit=20&page=2&after=${first.meta.nextCursor}`)).body.toString());expect(second.data).toHaveLength(20);
  const third=JSON.parse((await f.get(`/api/chat/sessions?limit=20&page=3&after=${second.meta.nextCursor}`)).body.toString());expect(third.data).toHaveLength(5);expect(third.meta.nextCursor).toBeNull();
  expect(new Set([...first.data,...second.data,...third.data].map(item=>item.id)).size).toBe(45);expect(JSON.stringify([first,second,third])).not.toContain("Other private chat");
  const foreign=Buffer.from(JSON.stringify({entityId:"chat-47",updatedAt:new Date(Date.UTC(2026,9,1,0,47)).toISOString()})).toString("base64url");
  expect((await f.get(`/api/chat/sessions?after=${foreign}`)).statusCode).toBe(400);expect(f.sdk.callTool).not.toHaveBeenCalled();expect(f.enqueue).not.toHaveBeenCalled();
});

test("builder snapshot views preserve current workflow ACL and exclude reserved service-backed routes", async () => {
  const f = await setup(), state = await f.repository.snapshot(), workflowId = Object.keys(state.workflows)[0]!;
  await f.repository.mutate(draft => {
    draft.users.other = { ...draft.users.owner!, id: "other", roleId: "own-workflow" };
    draft.roles["own-workflow"] = { ...draft.roles.role_admin!, id: "own-workflow", permissions: ["workflow:read_own"] };
  });
  const headers = { authorization: `Bearer ${jwt.sign({}, f.config.jwtSecret, { subject: "other", expiresIn: 3600 })}` };
  for (const suffix of ["", "/yaml"]) expect((await f.get(`/api/workflows/${workflowId}${suffix}`, headers)).statusCode).toBe(404);
  await f.repository.mutate(draft => { draft.workflows[workflowId]!.assignedUserIds = ["other"]; });
  for (const suffix of ["", "/yaml"]) expect((await f.get(`/api/workflows/${workflowId}${suffix}`, headers)).statusCode).toBe(200);
  await f.repository.mutate(draft => { draft.workflows[workflowId]!.assignedUserIds = []; });
  expect((await f.get(`/api/workflows/${workflowId}/yaml`, headers)).statusCode).toBe(404);
  await f.repository.mutate(draft => { draft.roles["own-workflow"]!.permissions = []; });
  expect((await f.get(`/api/workflows/${workflowId}/yaml`, headers)).statusCode).toBe(403);
  for (const url of ["/api/workflows/templates", "/api/workflows/assignable-users", `/api/workflows/${workflowId}/readiness`, `/api/workflows/${workflowId}/versions`, `/api/workflows/${workflowId}/commands`])
    expect(isFunctionProgressRequest(f.config, { method: "GET", url, headers: {} })).toBe(false);
  expect(isFunctionProgressRequest(f.config, { method: "PUT", url: `/api/workflows/${workflowId}/yaml`, headers: {} })).toBe(false);
  expect((await f.get(`/api/workflows/${workflowId}/yaml?view=private`)).statusCode).toBe(400);
});
test.each(["", "Bearer malformed", `Bearer ${jwt.sign({}, "wrong-secret", { subject: "owner" })}`])("invalid JWT never opens storage: %s", async authorization => {
  const f = await setup(), response = await f.get(`/api/executions/${f.runId}`, { authorization });
  expect(response.statusCode).toBe(401); expect(f.open).not.toHaveBeenCalled();
});
test("fresh current account and permission revocation replace admitted/token authority", async () => {
  const f = await setup();
  await f.repository.mutate(state => { state.roles.role_admin!.permissions = []; });
  expect((await f.get(`/api/executions/${f.runId}`)).statusCode).toBe(403);
  await f.repository.mutate(state => { state.users.owner!.status = "Suspended"; });
  expect((await f.get(`/api/chat/operations/${f.operationId}`)).statusCode).toBe(403);
  await f.repository.mutate(state => { delete state.users.owner; });
  expect((await f.get(`/api/executions/${f.runId}`)).statusCode).toBe(401);
});
test("own-run and own-operation scope deny other actors including email-delivery special scope", async () => {
  const f = await setup();
  await f.repository.mutate(state => {
    state.users.other = { ...state.users.owner!, id: "other", roleId: "own-progress" };
    state.roles["own-progress"] = { ...state.roles.role_admin!, id: "own-progress", permissions: ["execution:read_own", "chat:use"] };
  });
  const headers = { authorization: `Bearer ${jwt.sign({}, f.config.jwtSecret, { subject: "other", expiresIn: 3600 })}` };
  expect((await f.get(`/api/executions/${f.runId}`, headers)).statusCode).toBe(404);
  expect((await f.get(`/api/chat/operations/${f.operationId}`, headers)).statusCode).toBe(404);
  await f.repository.mutate(state => { state.roles["own-progress"]!.permissions.push("workflow:read"); });
  expect((await f.get(`/api/executions/${f.runId}`, headers)).statusCode).toBe(200);
  await f.repository.mutate(state => { state.executions[f.runId]!.emailDeliverySource = { draftId: "synthetic", draftRevision: 1, draftContentHash: "a".repeat(64), recipient: "synthetic@example.test" } as never; });
  expect((await f.get(`/api/executions/${f.runId}`, headers)).statusCode).toBe(404);
});
test.each(["after=-1", "after=1.5", "after=9007199254740992", "limit=101", "waitMs=25001", "after=0&after=1", "tool=send_email"])("invalid execution progress query is denied: %s", async query => {
  const f = await setup(); expect((await f.get(`/api/executions/${f.runId}/events?${query}`)).statusCode).toBe(400);
});
test("chat gap and stale authority are refused, never synthesized as completion", async () => {
  const f = await setup();
  await f.repository.mutate(state => { state.chatOperationEvents[f.operationId]![0]!.sequence = 2; });
  const gap = await f.get(`/api/chat/operations/${f.operationId}`); expect(gap.statusCode).toBe(409);
  expect(JSON.parse(gap.body.toString()).meta.code).toBe("CHAT_EVENT_GAP");
  await f.repository.mutate(state => { state.roles.role_admin!.permissions.push("changed:permission"); });
  expect((await f.get(`/api/chat/operations/${f.operationId}`)).statusCode).toBe(403);
});
test("long poll loads a fresh image after a commit, rechecks authority and delivers terminal status", async () => {
  const f = await setup(), state = await f.repository.snapshot(), last = state.executionEvents[f.runId]!.at(-1)!.sequence;
  f.snapshot.mockImplementationOnce(async () => state).mockImplementationOnce(async () => {
    const next = structuredClone(state); next.executions[f.runId]!.status = "DONE"; return next;
  });
  const result = await f.get(`/api/executions/${f.runId}/events?after=${last}&waitMs=15`);
  expect(result.statusCode).toBe(200); expect(JSON.parse(result.body.toString()).data).toMatchObject({ status: "DONE", waited: true, cursor: last });
  expect(f.snapshot).toHaveBeenCalledTimes(2);
});
test("chat progress long poll refreshes saved Pi evidence without dispatching or replaying work", async () => {
  const f = await setup(), state = await f.repository.snapshot();
  f.sdk.callTool.mockClear(); f.fetchImplementation.mockClear(); f.enqueue.mockClear();
  f.snapshot.mockImplementationOnce(async () => state).mockImplementationOnce(async () => {
    const next = structuredClone(state), operation = next.chatOperations[f.operationId]!;
    operation.status = "ANSWERED"; operation.stage = "ANSWERED"; operation.lastSequence += 1;
    next.chatOperationEvents[f.operationId]!.push({ version: 1, operationId: operation.id, sessionId: operation.sessionId,
      sequence: operation.lastSequence, timestamp: new Date().toISOString(), type: "operation.answered", stage: "ANSWERED", status: "ANSWERED" });
    return next;
  });
  const result = await f.get(`/api/chat/operations/${f.operationId}?after=${state.chatOperations[f.operationId]!.lastSequence}&waitMs=15`);
  expect(result.statusCode).toBe(200); expect(JSON.parse(result.body.toString()).data).toMatchObject({ waited: true, operation: { status: "ANSWERED" } });
  expect(f.sdk.callTool).not.toHaveBeenCalled(); expect(f.fetchImplementation).not.toHaveBeenCalled(); expect(f.enqueue).not.toHaveBeenCalled();
});
test("long poll cannot expose a cached page after committed permission revocation", async () => {
  const f = await setup(), state = await f.repository.snapshot(), last = state.executionEvents[f.runId]!.at(-1)!.sequence;
  f.snapshot.mockImplementationOnce(async () => state).mockImplementationOnce(async () => {
    const next = structuredClone(state); next.roles.role_admin!.permissions = []; return next;
  });
  expect((await f.get(`/api/executions/${f.runId}/events?after=${last}&waitMs=15`)).statusCode).toBe(403);
});
test("read failure and cleanup failure never grant authority or disclose upstream errors", async () => {
  const f = await setup(); f.snapshot.mockRejectedValueOnce(new Error("secret token upstream"));
  const unavailable = await f.get(`/api/executions/${f.runId}`);
  expect(unavailable.statusCode).toBe(503); expect(unavailable.body.toString()).not.toContain("secret token");
  expect(f.closeReader).toHaveBeenCalledOnce();
  f.closeReader.mockRejectedValueOnce(new Error("cleanup uncertainty"));
  await expect(f.get(`/api/executions/${f.runId}`)).rejects.toThrow("cleanup uncertainty");
});
test("abort during event wait releases the owned reader and does not manufacture terminal status", async () => {
  const f = await setup(), controller = new AbortController(), state = await f.repository.snapshot(), after = state.executionEvents[f.runId]!.at(-1)!.sequence;
  f.snapshot.mockImplementation(async () => { controller.abort(); return state; });
  const response = await f.get(`/api/executions/${f.runId}/events?after=${after}&waitMs=25000`, f.headers, { signal: controller.signal });
  expect(response.statusCode).toBe(503); expect(f.closeReader).toHaveBeenCalledOnce();
});
test("CORS preflight and HEAD use no mutation runtime; OPTIONS does not load state", async () => {
  const f = await setup();
  const preflight = await handleFunctionProgress(f.config, { method: "OPTIONS", url: `/api/executions/${f.runId}`, headers: { origin: "http://localhost:5173", "access-control-request-method": "GET" } }, f.open);
  expect(preflight.statusCode).toBe(204); expect(f.open).not.toHaveBeenCalled();
  const head = await handleFunctionProgress(f.config, { method: "HEAD", url: `/api/executions/${f.runId}`, headers: f.headers }, f.open);
  expect(head.statusCode).toBe(200); expect(head.body.length).toBe(0);
});
test("strict route selection leaves commands and exact reviews on the original writer path", async () => {
  const f = await setup();
  for (const url of ["/api/executions/run/approve", "/api/executions/run?view=approval", "/api/executions/run?view=reconciliation", "/api/executions/run/readbacks", "/api/workflows/run/run", "/api/settings/mcp-connections"])
    expect(isFunctionProgressRequest(f.config, { method: "GET", url, headers: {} })).toBe(false);
  expect(isFunctionProgressRequest(f.config, { method: "POST", url: "/api/executions/run", headers: {} })).toBe(false);
  expect(isFunctionProgressRequest(f.config, { method: "GET", url: "/api/executions/run", headers: {} })).toBe(true);
  expect((await f.get(`/api/executions/${f.runId}`, f.headers, { rawBody: Buffer.from("{}") })).statusCode).toBe(400);
});

test("public health reads committed storage without a writer, secrets or ERP-readiness claims", async () => {
  const f = await setup(), before = await f.repository.snapshot();
  f.sdk.callTool.mockClear(); f.fetchImplementation.mockClear(); f.enqueue.mockClear();
  expect(isFunctionProgressRequest(f.config, { method: "GET", url: "/api/health", headers: {} })).toBe(true);
  const result = await f.get("/api/health", {}), value = JSON.parse(result.body.toString());
  expect(result.statusCode).toBe(200);
  expect(value.data.storage).toMatchObject({ scope: "committed-read", writeReadiness: "not-checked", durable: true });
  expect(value.data.mcpBackend).not.toBe("connected"); expect(result.body.toString()).not.toContain(f.config.jwtSecret);
  expect((await f.get("/api/health?tool=send_email", {})).statusCode).toBe(400);
  f.snapshot.mockRejectedValueOnce(new Error("private database error"));
  const unavailable = await f.get("/api/health", {});
  expect(unavailable.statusCode).toBe(503); expect(unavailable.body.toString()).not.toContain("private database");
  expect(await f.repository.snapshot()).toEqual(before); expect(f.sdk.callTool).not.toHaveBeenCalled();
  expect(f.fetchImplementation).not.toHaveBeenCalled(); expect(f.enqueue).not.toHaveBeenCalled();
});

test("execution pages match the resident API, enforce own scope and reject query overrides", async () => {
  const f = await setup(), before = await f.repository.snapshot();
  f.sdk.callTool.mockClear(); f.enqueue.mockClear();
  for (const url of ["/api/executions?limit=20", "/api/executions?status=PENDING&limit=1"]) {
    const actual = await f.get(url), expected = await f.app.inject({ method: "GET", url, headers: f.headers });
    expect(actual.statusCode).toBe(200); expect(JSON.parse(actual.body.toString())).toEqual(expected.json());
  }
  await f.repository.mutate(state => {
    state.users.other = { ...state.users.owner!, id: "other", roleId: "other" };
    state.roles.other = { ...state.roles.role_admin!, id: "other", permissions: ["execution:read_own"] };
  });
  const other = { authorization: `Bearer ${jwt.sign({}, f.config.jwtSecret, { subject: "other" })}` };
  expect(JSON.parse((await f.get("/api/executions?limit=20", other)).body.toString()).data).toEqual([]);
  expect((await f.get("/api/executions?limit=201")).statusCode).toBe(400);
  expect((await f.get("/api/executions?limit=1&limit=2")).statusCode).toBe(400);
  expect((await f.get("/api/executions?actorId=owner")).statusCode).toBe(400);
  expect(before.executions[f.runId]).toBeDefined(); expect(f.sdk.callTool).not.toHaveBeenCalled(); expect(f.enqueue).not.toHaveBeenCalled();
});

test("personal tasks and ordinary review polling are read-only current-scope projections", async () => {
  const f = await setup();
  await f.repository.mutate(state => { state.roles.role_admin!.permissions.push("execution:approve"); });
  const before = await f.repository.snapshot(); f.sdk.callTool.mockClear(); f.fetchImplementation.mockClear(); f.enqueue.mockClear();
  for (const url of ["/api/dashboard/tasks?month=2026-10&timezone=Asia%2FColombo", "/api/execution-reviews?kind=all&state=open&limit=25"]) {
    const actual = await f.get(url), expected = await f.app.inject({ method: "GET", url, headers: f.headers });
    const value = JSON.parse(actual.body.toString()), resident = expected.json();
    expect(actual.statusCode).toBe(200);
    if (value.data.asOf) { expect(value.data.asOf).toEqual(expect.any(String)); delete value.data.asOf; delete resident.data.asOf; }
    if (value.data.generatedAt) { expect(value.data.generatedAt).toEqual(expect.any(String)); delete value.data.generatedAt; delete resident.data.generatedAt; }
    expect(value).toEqual(resident);
  }
  expect((await f.get("/api/dashboard/tasks?month=2026-10&timezone=invalid-zone")).statusCode).toBe(400);
  expect((await f.get("/api/execution-reviews?actorId=other")).statusCode).toBe(400);
  expect(await f.repository.snapshot()).toEqual(before);
  await f.repository.mutate(state => { state.roles.role_admin!.permissions = ["chat:use"]; });
  expect((await f.get("/api/execution-reviews")).statusCode).toBe(403);
  expect((await f.get("/api/dashboard/tasks?month=2026-10&timezone=UTC")).statusCode).toBe(403);
  expect(f.sdk.callTool).not.toHaveBeenCalled(); expect(f.fetchImplementation).not.toHaveBeenCalled(); expect(f.enqueue).not.toHaveBeenCalled();
});

test("protected inbox evidence keeps its service-backed path rather than weakening review proofs", async () => {
  const f = await setup(); await f.repository.mutate(state => {
    state.roles.role_admin!.permissions.push("execution:approve");
    state.executions[f.runId]!.startedBy.id = "different-requester";
    state.executions[f.runId]!.protectedApprovalSecret = {} as never;
  });
  await expect(f.get("/api/execution-reviews")).rejects.toBeInstanceOf(FunctionServiceReadRequired);
  expect(f.closeReader).toHaveBeenCalledOnce();
  expect(isFunctionProgressRequest(f.config, { method: "POST", url: `/api/executions/${f.runId}/approve`, headers: f.headers })).toBe(false);
});

test("ten concurrent display requests do not call, enqueue or mutate ERP work", async () => {
  const f = await setup(), before = await f.repository.snapshot(); f.sdk.callTool.mockClear(); f.fetchImplementation.mockClear(); f.enqueue.mockClear();
  const replies = await Promise.all(Array.from({ length: 10 }, () => f.get("/api/executions?limit=20")));
  expect(replies.every(reply => reply.statusCode === 200)).toBe(true); expect(f.closeReader).toHaveBeenCalledTimes(10);
  expect(await f.repository.snapshot()).toEqual(before); expect(f.sdk.callTool).not.toHaveBeenCalled();
  expect(f.fetchImplementation).not.toHaveBeenCalled(); expect(f.enqueue).not.toHaveBeenCalled();
});
