import { expect, test, vi } from "vitest";
import { createBridgeProtocolAdapter } from "../src/tools/erpbridge-protocol-adapter.js";

function fixture(options: { failure?: number; notification?: boolean; loop?: boolean; exhaust?: boolean; wrongProtocol?: boolean; get?: () => Response; descriptorPatch?: Record<string, unknown> } = {}) {
  const descriptor = { name: "read.rev_MS4wLjA", inputSchema: { type: "object" }, outputSchema: { type: "object" },
    annotations: { readOnlyHint: true }, _meta: { "toolplane.resourceVersion": "1.0.0", "toolplane.resourceDigest": "a".repeat(64), "io.erpbridge/allowedRoles": [] }, ...options.descriptorPatch };
  const calls: { url: string; method: string; headers: Headers; body?: Record<string, any> }[] = [];
  const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: String(url), method: init?.method ?? "GET", headers: new Headers(init?.headers), ...(body ? { body } : {}) });
    if (!body) return options.get?.() ?? new Response(null, { status: 405 });
    if (body.id === undefined) return new Response(null, { status: 202 });
    let result: unknown;
    if (body.method === "initialize") result = { protocolVersion: options.wrongProtocol ? "2026-07-28" : "2025-11-25", capabilities: { tools: { listChanged: true } }, serverInfo: { name: "ERPBridge", version: "1.0.0" } };
    else if (body.method === "tools/list") result = options.exhaust ? { tools: [], nextCursor: String(calls.filter(c => c.body?.method === "tools/list").length) } : options.loop ? { tools: [descriptor], nextCursor: "same" } : body.params?.cursor ? { tools: [{ ...descriptor, name: "alias" }] } : { tools: [descriptor], nextCursor: "page-2" };
    else if (body.method === "tools/call") {
      if (options.failure) return new Response("private-upstream-body-token", { status: options.failure });
      result = { content: [{ type: "text", text: "kept" }], structuredContent: { id: "one" }, _meta: { "com.erpbridge/error": { type: "rate_limit", retryable: true, retryAfterMs: 1000 } } };
    } else throw new Error("Unexpected fixture RPC");
    const response = { jsonrpc: "2.0", id: body.id, result };
    if (options.notification && body.method === "tools/list") return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })}\n\nevent: message\ndata: ${JSON.stringify(response)}\n\n`, { headers: { "content-type": "text/event-stream" } });
    return Response.json(response, { headers: body.method === "initialize" ? { "Mcp-Session-Id": "fixture-session" } : {} });
  });
  const adapter = createBridgeProtocolAdapter({ baseURL: "https://bridge.example.test", token: "fixture-only-token", timeoutMs: 1000, fetch: fetchImplementation });
  return { adapter, calls, descriptor };
}
test("official client uses canonical Streamable HTTP, authenticated session and paginated metadata-complete discovery", async () => {
  const f = fixture();
  try {
    await f.adapter.connect();
    expect(await f.adapter.listTools()).toEqual([f.descriptor, { ...f.descriptor, name: "alias" }]);
    expect(f.calls.filter(c => c.body?.method === "tools/list")).toHaveLength(2);
    expect(f.calls.every(c => c.url === "https://bridge.example.test/mcp/")).toBe(true);
    expect(f.calls.every(c => c.headers.get("authorization") === "Bearer fixture-only-token")).toBe(true);
    const initialized = f.calls.find(c => c.body?.method === "notifications/initialized")!;
    expect(initialized.headers.get("mcp-session-id")).toBe("fixture-session");
    const before = f.calls.length;
    expect(await f.adapter.callTool("read.rev_MS4wLjA", { id: "one" }, { "toolplane.resourceDigest": "a".repeat(64) })).toMatchObject({ structuredContent: { id: "one" }, _meta: { "com.erpbridge/error": { type: "rate_limit" } } });
    expect(f.calls.slice(before).map(c => c.body?.method)).toEqual(["tools/call"]);
    expect(f.calls.at(-1)?.body?.params).toEqual({ name: "read.rev_MS4wLjA", arguments: { id: "one" }, _meta: { "toolplane.resourceDigest": "a".repeat(64) } });
    expect(f.calls.some(c => c.body?.method === "server/discover")).toBe(false);
  } finally { await f.adapter.close(); }
});

test("array-root output schemas and unknown metadata survive discovery exactly without granting execution", async () => {
  const outputSchema = { type: "array", items: { type: "object", properties: { name: { type: "string" } } } };
  const f = fixture({ descriptorPatch: { outputSchema, _meta: { "io.erpbridge/examples": ["List companies"] }, extension: { original: true } } });
  try {
    await f.adapter.connect();
    const tools = await f.adapter.listTools();
    expect(tools).toEqual([f.descriptor, { ...f.descriptor, name: "alias" }]);
    expect(tools[0]!.outputSchema).toEqual(outputSchema);
    expect(tools[0]!._meta).not.toHaveProperty("toolplane.resourceDigest");
    expect(f.calls.filter(call => call.body?.method === "tools/call")).toHaveLength(0);
  } finally { await f.adapter.close(); }
});

test.each([{ inputSchema: [] }, { inputSchema: { type: "array" } }, { outputSchema: [] }, { annotations: "invalid" }, { name: "" }, { name: " padded " }])("malformed discovery stays rejected: %j", async descriptorPatch => {
  const f = fixture({ descriptorPatch });
  try { await f.adapter.connect(); await expect(f.adapter.listTools()).rejects.toThrow(); }
  finally { await f.adapter.close(); }
});
test.each([401, 403, 503])("tool HTTP %s is surfaced once with no replay or OAuth fallback", async status => {
  const f = fixture({ failure: status });
  try { await f.adapter.connect(); await f.adapter.listTools(); const failure = await f.adapter.callTool("read.rev_MS4wLjA", {}).catch(error => error);
    expect(failure).toBeInstanceOf(Error); if (!(failure instanceof Error)) throw new Error("Expected a fixture transport failure");
    expect(failure.message).toMatch(/ERPBridge MCP/); expect(failure.message).not.toMatch(/private-upstream/);
    expect(f.calls.filter(c => c.body?.method === "tools/call")).toHaveLength(1);
  } finally { await f.adapter.close(); }
});
test("list-change notifications reach the engine without a background list RPC", async () => {
  const f = fixture({ notification: true }), listener = vi.fn(), off = f.adapter.onToolsChanged!(listener);
  try { await f.adapter.connect(); await f.adapter.listTools(); expect(listener).toHaveBeenCalledTimes(2);
    expect(f.calls.filter(c => c.body?.method === "tools/list")).toHaveLength(2); off(); await f.adapter.listTools(); expect(listener).toHaveBeenCalledTimes(2);
  } finally { await f.adapter.close(); }
});
test("repeated pagination cursor fails within a bounded discovery", async () => {
  const f = fixture({ loop: true });
  try { await f.adapter.connect(); await expect(f.adapter.listTools()).rejects.toThrow(); expect(f.calls.filter(c => c.body?.method === "tools/list")).toHaveLength(2); }
  finally { await f.adapter.close(); }
});
test("page exhaustion rejects partial discovery, and wrong protocol never downgrades or probes", async () => {
  const exhausted = fixture({ exhaust: true });
  try { await exhausted.adapter.connect(); await expect(exhausted.adapter.listTools()).rejects.toThrow(/page limit/); expect(exhausted.calls.filter(c => c.body?.method === "tools/list")).toHaveLength(16); }
  finally { await exhausted.adapter.close(); }
  const wrong = fixture({ wrongProtocol: true });
  try { await expect(wrong.adapter.connect()).rejects.toThrow(/not supported/); expect(wrong.calls.filter(c => c.body?.method)).toHaveLength(1); }
  finally { await wrong.adapter.close(); }
});
test.each(["https://u:p@example.test", "https://example.test/mcp/", "https://example.test/?token=x", "file:///mcp"])("rejects ambiguous/credential-bearing base URL: %s", baseURL => {
  expect(() => createBridgeProtocolAdapter({ baseURL, token: "fixture", timeoutMs: 1000 })).toThrow(/base URL/);
});

test("actual SDK notification reader invalidates discovery and a malformed stream fences dispatch with safe status", async () => {
  let target!: ReadableStreamDefaultController<Uint8Array>;
  const f = fixture({ get: () => new Response(new ReadableStream({ start(c) { target = c; } }), { headers: { "content-type": "text/event-stream" } }) });
  const changed = vi.fn(); f.adapter.onToolsChanged!(changed);
  try {
    await f.adapter.connect(); await f.adapter.listTools(); await vi.waitFor(() => expect(f.adapter.notificationState?.state).toBe("ACTIVE"));
    target.enqueue(new TextEncoder().encode('event: message\ndata: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n'));
    await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
    target.enqueue(new TextEncoder().encode("data: private-malformed-reply\n\n"));
    await vi.waitFor(() => expect(f.adapter.available).toBe(false));
    expect(f.adapter.notificationState).toEqual({ state: "FAILED", reason: "STREAM_PROTOCOL", recoveryAttempts: 0 });
    await expect(f.adapter.callTool("read.rev_MS4wLjA", {})).rejects.toThrow(/unavailable/);
    await expect(f.adapter.listTools()).rejects.toThrow(/unavailable/);
    expect(f.calls.filter(c => c.body?.method === "tools/call")).toHaveLength(0);
    expect(JSON.stringify(f.adapter.notificationState)).not.toContain("private");
  } finally { await f.adapter.close(); }
});

test("SDK notification GET recovers a gap without reinitializing, background discovery, or business replay", async () => {
  let count = 0; const f = fixture({ get: () => new Response(new ReadableStream({ start(c) {
    c.enqueue(new TextEncoder().encode(`id: event-${++count}\ndata: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n`));
    if (count === 1) c.close();
  } }), { headers: { "content-type": "text/event-stream" } }) });
  const changed = vi.fn(); f.adapter.onToolsChanged!(changed);
  try {
    await f.adapter.connect(); await f.adapter.listTools(); await f.adapter.callTool("read.rev_MS4wLjA", {});
    await vi.waitFor(() => expect(count).toBe(2)); await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(3));
    expect(f.adapter.notificationState).toEqual({ state: "ACTIVE", recoveryAttempts: 1 }); expect(f.adapter.available).toBe(true);
    const gets = f.calls.filter(c => c.method === "GET"); expect(gets).toHaveLength(2); expect(gets[1]!.headers.get("last-event-id")).toBe("event-1");
    expect(gets[1]!.headers.get("mcp-session-id")).toBe("fixture-session");
    expect(f.calls.filter(c => c.body?.method === "initialize")).toHaveLength(1);
    expect(f.calls.filter(c => c.body?.method === "tools/list")).toHaveLength(2);
    expect(f.calls.filter(c => c.body?.method === "tools/call")).toHaveLength(1);
  } finally { await f.adapter.close(); }
});
