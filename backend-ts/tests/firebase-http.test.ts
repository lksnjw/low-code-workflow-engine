import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { handleFunctionHttp, isAsyncChatAdmission } from "../src/firebase/http.js";
import { boundedReadFixture, TaskRecords } from "./fixtures/bounded-read-task.js";
import { FirestoreOwnershipFailure } from "../src/storage/firestore-writer-ownership.js";
const fixtures = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../src/firebase/invocation.js", () => ({ withFunctionRuntime: fixtures.invoke }));
const closers: (() => Promise<unknown>)[] = [];
beforeEach(() => vi.resetAllMocks());

test("only an exact async-chat admission may defer the ERP connection",()=>{
  const base={method:"POST",url:"/api/chat/sessions/chat_123/messages",headers:{}};
  const body={delivery:"async-chat",content:"Hello",idempotencyKey:"original_request_0001"};
  expect(isAsyncChatAdmission({...base,rawBody:Buffer.from(JSON.stringify(body))})).toBe(true);
  for(const invalid of [{...body,emailDeliveryCommand:{}},{...body,emailDraftCommand:{}},{...body,delivery:"sync"},{...body,unknown:true}])
    expect(isAsyncChatAdmission({...base,rawBody:Buffer.from(JSON.stringify(invalid))})).toBe(false);
  expect(isAsyncChatAdmission({...base,url:base.url+"?override=true",body})).toBe(false);
  expect(isAsyncChatAdmission({...base,method:"GET",body})).toBe(false);
  expect(isAsyncChatAdmission({...base,rawBody:Buffer.from("{invalid")})).toBe(false);
});

test.each(["login", "logout", "register", "refresh"])("authentication %s does not depend on ERP connection initialization", async action => {
  const f = await setup();
  await handleFunctionHttp(f.input, { method: "POST", url: `/api/auth/${action}`, headers: { "content-type": "application/json" }, rawBody: Buffer.from("{}") });
  expect(fixtures.invoke.mock.calls[0]![0].runtimePurpose).toBe("authentication");
});
afterEach(async () => { await Promise.all(closers.splice(0).map(close => close())); });
async function setup(options: Parameters<typeof boundedReadFixture>[0] = {}) {
  const f = await boundedReadFixture(options); closers.push(f.close);
  fixtures.invoke.mockImplementation(async (_input, work) => work({ app: f.app, services: f.services }));
  const input = { config: f.services.config, root: process.cwd(), transport: { enqueue: f.enqueue, timeoutMs: 1000 } };
  return { ...f, input };
}
test("HTTPS adapter uses actual existing authentication instead of inventing a function user", async () => {
  const f = await setup();
  const denied = await handleFunctionHttp(f.input, { method: "GET", url: "/api/workflows", headers: {} });
  expect(denied.statusCode).toBe(401);
  const allowed = await handleFunctionHttp(f.input, { method: "GET", url: "/api/workflows", headers: f.headers });
  expect(allowed.statusCode).toBe(200); expect(JSON.parse(allowed.body.toString()).success).toBe(true);
});
test("native middleware's empty bodyless GET still reaches authentication, without inventing bytes", async () => {
  const f = await setup();
  expect((await handleFunctionHttp(f.input, { method: "GET", url: "/api/workflows", headers: {}, body: {} })).statusCode).toBe(401);
  expect((await handleFunctionHttp(f.input, { method: "GET", url: "/api/workflows", headers: f.headers, body: {} })).statusCode).toBe(200);
  expect((await handleFunctionHttp(f.input, { method: "GET", url: "/api/workflows", headers: { "content-length": "2" }, body: {} })).statusCode).toBe(400);
});
test("native middleware's empty bodyless DELETE reaches routing instead of inventing a missing-body failure", async () => {
  const f = await setup();
  const routed = await handleFunctionHttp(f.input, { method: "DELETE", url: "/api/workflows", headers: f.headers, body: {} });
  expect(routed.statusCode).toBe(404);
  const claimedBody = await handleFunctionHttp(f.input, { method: "DELETE", url: "/api/workflows", headers: { ...f.headers, "content-length": "2" }, body: {} });
  expect(claimedBody.statusCode).toBe(400);
  expect(JSON.parse(claimedBody.body.toString()).meta.code).toBe("FUNCTIONS_RAW_BODY_REQUIRED");
});
test("raw JSON URL/body forwarding preserves validation and original idempotent read admission", async () => {
  const f = await setup(); expect((await f.publish()).statusCode).toBe(200);
  const request = { method: "POST", url: "/api/workflows/workflow/run?source=functions", headers: { ...f.headers, "content-type": "application/json", "content-length": "999" },
    rawBody: Buffer.from(JSON.stringify({ mode: "async-read", idempotencyKey: "native-functions-read-0001", input: {} })), ip: "127.0.0.1" };
  const first = await handleFunctionHttp(f.input, request), again = await handleFunctionHttp(f.input, request);
  expect(first.statusCode).toBe(202); expect(JSON.parse(again.body.toString()).data.id).toBe(JSON.parse(first.body.toString()).data.id);
  expect(f.enqueue).toHaveBeenCalledOnce(); expect(f.sdk.callTool).not.toHaveBeenCalled();
});
test("malformed original JSON stays malformed even when middleware supplied a parsed body", async () => {
  const f = await setup(), result = await handleFunctionHttp(f.input, { method: "POST", url: "/api/workflows/workflow/run", headers: { ...f.headers, "content-type": "application/json" },
    rawBody: Buffer.from("{"), body: { mode: "async-read" } });
  expect(result.statusCode).toBe(400); expect(f.enqueue).not.toHaveBeenCalled();
});
test.each([
  { method: "TRACE", url: "/api/workflows", expected: 405 }, { method: "GET", url: "//foreign.example/api", expected: 400 },
  { method: "GET", url: "/ws/system-health", expected: 426 },
])("unsupported request fails before resource startup: $url", async ({ method, url, expected }) => {
  const f = await setup(); expect((await handleFunctionHttp(f.input, { method, url, headers: {} })).statusCode).toBe(expected);
  expect(fixtures.invoke).not.toHaveBeenCalled();
});
test("missing raw bytes, upgrades and oversized payloads cannot open storage", async () => {
  const f = await setup();
  expect((await handleFunctionHttp(f.input, { method: "POST", url: "/api/workflows", headers: {}, body: {} })).statusCode).toBe(400);
  expect((await handleFunctionHttp(f.input, { method: "GET", url: "/api/workflows", headers: { upgrade: "websocket" } })).statusCode).toBe(426);
  expect((await handleFunctionHttp(f.input, { method: "POST", url: "/api/workflows", headers: {}, rawBody: Buffer.alloc(10 * 1024 * 1024 + 1) })).statusCode).toBe(413);
  expect(fixtures.invoke).not.toHaveBeenCalled();
});
test("unconfirmed invocation cleanup returns actionable 503 without exposing dependency errors", async () => {
  const f = await setup(); fixtures.invoke.mockRejectedValueOnce(new Error("secret upstream token must not escape"));
  const result = await handleFunctionHttp(f.input, { method: "GET", url: "/api/workflows", headers: f.headers });
  expect(result.statusCode).toBe(503); expect(result.body.toString()).not.toContain("upstream token");
  expect(JSON.parse(result.body.toString()).meta.code).toBe("FUNCTIONS_INVOCATION_UNCONFIRMED");
});

test("unconfirmed startup exposes recovery guidance only to the configured web origin", async () => {
  const f = await setup(); f.input.config.corsOrigins = ["https://workflow.example.test"];
  fixtures.invoke.mockRejectedValue(new Error("private failure"));
  const allowed = await handleFunctionHttp(f.input, { method: "GET", url: "/api/registry/status", headers: { ...f.headers, origin: "https://workflow.example.test" } });
  expect(allowed.statusCode).toBe(503); expect(allowed.headers["access-control-allow-origin"]).toBe("https://workflow.example.test");
  expect(allowed.headers["access-control-allow-credentials"]).toBe("true"); expect(allowed.body.toString()).not.toContain("private failure");
  const denied = await handleFunctionHttp(f.input, { method: "GET", url: "/api/registry/status", headers: { ...f.headers, origin: "https://foreign.example.test" } });
  expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
});

test("initialization diagnostic is a bounded authority category, not raw error, identity or credentials", async () => {
  const f = await setup(), warning = vi.spyOn(console, "warn").mockImplementation(() => {}), controller = new AbortController();
  try {
    fixtures.invoke.mockRejectedValueOnce(new Error("private-raw-upstream-credential", { cause: new FirestoreOwnershipFailure("ANCHOR_CHANGED") }));
    const result = await handleFunctionHttp(f.input, { method: "GET", url: "/api/workflows", headers: f.headers, signal: controller.signal });
    expect(result.statusCode).toBe(503);
    expect(JSON.parse(warning.mock.calls[0]![0])).toEqual({ severity: "WARNING", message: "Functions invocation unconfirmed", phase: "initialization", authorityReason: "ANCHOR_CHANGED" });
    expect(warning.mock.calls.flat().join(" ")).not.toContain("private-raw"); expect(result.body.toString()).not.toContain("ANCHOR_CHANGED");
    expect(fixtures.invoke.mock.calls[0]![0].signal).toBe(controller.signal);
  } finally { warning.mockRestore(); }
});
test("storage ACK loss becomes explicit original-key recovery guidance, without unconfirmed enqueue", async () => {
  const storage = new TaskRecords(), f = await setup({ storage }); expect((await f.publish()).statusCode).toBe(200);
  storage.commitBeforeFailure = true; storage.failWhen = state => Object.values(state.readJobs).some(job => job.taskDispatchSecret?.state === "PREPARED");
  const result = await handleFunctionHttp(f.input, { method: "POST", url: "/api/workflows/workflow/run", headers: { ...f.headers, "content-type": "application/json" },
    rawBody: Buffer.from(JSON.stringify({ mode: "async-read", idempotencyKey: "functions-storage-ack-loss-0001", input: {} })) });
  expect(result.statusCode).toBe(503); expect(JSON.parse(result.body.toString()).meta.code).toBe("FUNCTIONS_INVOCATION_UNCONFIRMED");
  expect(f.enqueue).not.toHaveBeenCalled(); expect(f.sdk.callTool).not.toHaveBeenCalled();
});
test("bounded registry assets are reported immutable and cannot accept ephemeral edits", async () => {
  const f = await setup(), status = await handleFunctionHttp(f.input, { method: "GET", url: "/api/registry/status", headers: f.headers });
  expect(status.statusCode).toBe(200); expect(JSON.parse(status.body.toString()).data).toMatchObject({ writable: false, mode: "release-immutable" });
  const changed = await handleFunctionHttp(f.input, { method: "POST", url: "/api/registry/tools", headers: { ...f.headers, "content-type": "application/json" }, rawBody: Buffer.from("{}") });
  expect(changed.statusCode).toBe(403); expect(JSON.parse(changed.body.toString()).message).toContain("release-managed and immutable");
});

test.each([
  { path: "/api/registry/context/regenerate", status: 403, message: "release-managed and immutable" },
  { path: "/api/semantic-index/rebuild", status: 503, message: "semantic search service is not configured" },
])("explicit JSON action bytes preserve authentication and the truthful bounded outcome: $path", async ({ path, status, message }) => {
  const f = await setup();
  const before = await f.services.repository.snapshot();
  const request = { method: "POST", url: path, headers: { "content-type": "application/json" }, rawBody: Buffer.from("{}") };
  expect((await handleFunctionHttp(f.input, request)).statusCode).toBe(401);
  const result = await handleFunctionHttp(f.input, { ...request, headers: { ...request.headers, ...f.headers } });
  expect(result.statusCode).toBe(status);
  expect(JSON.parse(result.body.toString())).toMatchObject({ success: false, message: expect.stringContaining(message) });
  expect(await f.services.repository.snapshot()).toEqual(before);
  expect(f.enqueue).not.toHaveBeenCalled(); expect(f.sdk.callTool).not.toHaveBeenCalled();
  const missingBytes = await handleFunctionHttp(f.input, { method: "POST", url: path, headers: { ...request.headers, ...f.headers }, body: {} });
  expect(missingBytes.statusCode).toBe(400);
  expect(JSON.parse(missingBytes.body.toString()).meta.code).toBe("FUNCTIONS_RAW_BODY_REQUIRED");
});
