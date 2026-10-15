import { expect, test } from "@jest/globals";
import { createAppConfig, validateEndpoint } from "./endpoints";

test("API requests have a longer bounded wait that can be configured for the demo", () => {
  expect(createAppConfig().apiRequestTimeoutMs).toBe(90000);
  expect(createAppConfig({ VITE_API_REQUEST_TIMEOUT_MS: "120000" }).apiRequestTimeoutMs).toBe(120000);
  expect(createAppConfig({ VITE_API_REQUEST_TIMEOUT_MS: "300000" }).apiRequestTimeoutMs).toBe(300000);
});
test.each(["", "0", "999", "300001", "1.5", "NaN", "Infinity", "-1"])("unsafe API wait is rejected: %s", value => {
  expect(() => createAppConfig({ VITE_API_REQUEST_TIMEOUT_MS: value })).toThrow(/VITE_API_REQUEST_TIMEOUT_MS/);
});

test("Functions can explicitly select HTTP polling without a WebSocket endpoint", () => {
  const config = createAppConfig({ VITE_PROGRESS_TRANSPORT: "http-polling", VITE_API_BASE_URL: "https://backend.example.test/api" });
  expect(config.wsBaseUrl).toBeNull();
  expect(() => createAppConfig({ VITE_PROGRESS_TRANSPORT: "unknown" })).toThrow("Unsupported progress transport");
  expect(() => createAppConfig({ VITE_PROGRESS_TRANSPORT: "http-polling", VITE_WS_BASE_URL: "wss://backend.example.test/ws" })).toThrow("HTTP polling cannot advertise");
});

test("local development retains same-origin API and ws routing", () => {
  expect(createAppConfig({ DEV: true }, "http://localhost:5173")).toMatchObject({ apiBaseUrl: "/api", wsBaseUrl: "ws://localhost:5173/ws", pipelineUploadEnabled: true });
  expect(createAppConfig({ DEV: true }, "http://127.0.0.1:5173")).toMatchObject({ apiBaseUrl: "/api", wsBaseUrl: "ws://127.0.0.1:5173/ws", pipelineUploadEnabled: true });
});
test("a separate HTTPS backend supplies the default event origin, not static Hosting", () => {
  expect(createAppConfig({ VITE_API_BASE_URL: "https://backend.example.test/api/", MODE: "hosting" }, "https://site.web.app")).toMatchObject({ apiBaseUrl: "https://backend.example.test/api", wsBaseUrl: "wss://backend.example.test/ws", pipelineUploadEnabled: true });
});
test("explicit event binding and HTTPS same-origin deployments are preserved", () => {
  expect(createAppConfig({ VITE_WS_BASE_URL: "wss://events.example.test/edge/ws/" }, "https://site.web.app").wsBaseUrl).toBe("wss://events.example.test/edge/ws");
  expect(createAppConfig({}, "https://site.web.app").apiBaseUrl).toBe("/api");
  expect(createAppConfig({ DEV: true, MODE: "development" }).pipelineUploadEnabled).toBe(true);
  expect(createAppConfig({ VITE_PIPELINE_UPLOAD_ENABLED: "false" }).pipelineUploadEnabled).toBe(false);
});
test.each(["", "//other.test/api", "https://user:secret@backend.test/api", "https://backend.test/api?token=private", "https://backend.test/api#token", "http://backend.test/api", "javascript:alert(1)", "https://*.test/api", "https://backend.test/a\\pi", " https://backend.test/api", "data:text/plain,test"])("invalid/private API binding fails without printing its value: %s", endpoint => {
  expect(() => validateEndpoint(endpoint, { kind: "API", origin: "https://site.web.app", allowRelative: true })).toThrow("Invalid API endpoint");
});
test.each(["https://backend.test/ws", "ws://backend.test/ws", "wss://user:secret@backend.test/ws", "/ws", "wss://backend.test/ws?token=private"])("invalid event binding fails: %s", endpoint => {
  expect(() => createAppConfig({ VITE_WS_BASE_URL: endpoint })).toThrow("Invalid WebSocket endpoint");
});
