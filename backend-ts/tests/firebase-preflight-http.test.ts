import { beforeEach, expect, test, vi } from "vitest";
import { loadConfig } from "../src/config/config.js";
import { handleFunctionHttp } from "../src/firebase/http.js";
const startup = vi.hoisted(() => ({ runtime: vi.fn(), resources: vi.fn() }));
vi.mock("../src/firebase/invocation.js", () => ({ withFunctionRuntime: startup.runtime, withFunctionResources: startup.resources }));
beforeEach(() => vi.resetAllMocks());
const origin = "https://workspace.example.test";
function input() {
  const config = loadConfig({ APP_ENV: "test", MCP_MODE: "mock" });
  config.corsOrigins = [origin];
  return { config, root: process.cwd(), transport: { timeoutMs: 1000, enqueue: vi.fn() } };
}
const headers = { origin, "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type" };

test.each(["/api/chat/sessions/example/messages", "/api/workflows/example/run", "/api/auth/login", "/api/chat/sessions", "/api/chat/operations/example/cancel"])(
  "preflight %s preserves CORS and opens no storage, model or ERP runtime", async url => {
    startup.runtime.mockRejectedValue(new Error("Writer unavailable")); startup.resources.mockRejectedValue(new Error("Writer unavailable"));
    const result = await handleFunctionHttp(input(), { method: "OPTIONS", url, headers, body: {} });
    expect(result.statusCode).toBe(204); expect(result.body.length).toBe(0);
    expect(result.headers["access-control-allow-origin"]).toBe(origin);
    expect(result.headers["access-control-allow-credentials"]).toBe("true");
    expect(result.headers["access-control-allow-methods"]).toBe("GET, POST, PATCH, PUT, DELETE, OPTIONS");
    expect(result.headers["access-control-allow-headers"]).toBe("Origin, Content-Type, Accept, Authorization");
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(result.headers["x-trace-id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(startup.runtime).not.toHaveBeenCalled(); expect(startup.resources).not.toHaveBeenCalled();
  });

test("unapproved origins receive no cross-origin grant", async () => {
  const result = await handleFunctionHttp(input(), { method: "OPTIONS", url: "/api/chat/sessions/example/messages", headers: { ...headers, origin: "https://unapproved.example.test" } });
  expect(result.headers["access-control-allow-origin"]).toBeUndefined();
  expect(startup.runtime).not.toHaveBeenCalled(); expect(startup.resources).not.toHaveBeenCalled();
});

test("malformed preflight remains invalid and cannot construct runtime services", async () => {
  const result = await handleFunctionHttp(input(), { method: "OPTIONS", url: "/api/chat/sessions/example/messages", headers: { origin } });
  expect(result.statusCode).toBe(400); expect(startup.runtime).not.toHaveBeenCalled(); expect(startup.resources).not.toHaveBeenCalled();
});

test("preflight does not add HEAD, arbitrary methods or caller-supplied headers to the existing allowlist", async () => {
  const result = await handleFunctionHttp(input(), { method: "OPTIONS", url: "/api/workflows/example/run", headers: { ...headers,
    "access-control-request-method": "TRACE", "access-control-request-headers": "x-api-key,x-bypass-approval" } });
  expect(String(result.headers["access-control-allow-methods"])).not.toMatch(/TRACE|HEAD/);
  expect(String(result.headers["access-control-allow-headers"])).not.toMatch(/x-api-key|x-bypass-approval/i);
});

test("actual POST still enters the existing governed runtime, never the transport-only handler", async () => {
  startup.runtime.mockRejectedValue(new Error("No storage authority"));
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const result = await handleFunctionHttp(input(), { method: "POST", url: "/api/chat/sessions/example/messages", headers: { origin, "content-type": "application/json" }, rawBody: Buffer.from("{}") });
    expect(result.statusCode).toBe(503); expect(startup.runtime).toHaveBeenCalledOnce();
    expect(result.headers["access-control-allow-origin"]).toBeUndefined();
  } finally { warning.mockRestore(); }
});
