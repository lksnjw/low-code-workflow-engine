import { expect, test } from "vitest";
import { safeMcpResult, mcpResultForModel } from "../src/tools/mcp-result.js";

test("preserves all supported content blocks, human annotations and structured data without credentials or arbitrary metadata", () => {
  const output = safeMcpResult({ content: [
    { type: "text", text: '[{"id":"INV-1","token":"secret-text"}]', annotations: { audience: ["user"], priority: 0.5 } },
    { type: "text", text: "This report is partial." },
    { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
    { type: "audio", mimeType: "audio/wav", data: "YXVkaW8=" },
    { type: "resource_link", name: "Report", uri: "https://u:secret@example.test/report?token=secret#secret", description: "Generated report", size: 10 },
    { type: "resource", resource: { uri: "erp://invoices/1", text: '{"id":"INV-1","password":"secret-resource"}' } },
    { type: "resource", resource: { uri: "erp://reports/1", blob: "YmxvYg==", mimeType: "application/octet-stream" } },
  ], structuredContent: { id: "INV-1", api_key: "secret-data", nested: { ok: false } }, _meta: { arbitrary: "secret-meta", "com.erpbridge/error": { type: "rate_limit", retryable: true, retryAfterMs: 1000, token: "secret-error" } } });
  expect((output.content as unknown[])).toHaveLength(7);
  expect(JSON.stringify(output)).not.toContain("secret");
  expect(output).toMatchObject({ structuredContent: { id: "INV-1", nested: { ok: false } }, _meta: { "com.erpbridge/error": { type: "rate_limit", retryable: true, retryAfterMs: 1000 } } });
  expect(output.content).toContainEqual({ type: "text", text: "This report is partial." });
  const model = JSON.stringify(mcpResultForModel(output));
  expect(model).not.toMatch(/aW1hZ2U=|YXVkaW8=|YmxvYg==|priority/);
  expect(model).toContain("not interpreted");
  expect((output.content as any[])[0].annotations.audience).toEqual(["user"]);
});
test.each([
  { content: {}, isError: false }, { content: [], isError: "false" }, { content: [], structuredContent: [] },
  { content: [{ type: "text", text: 1 }] }, { content: [{ type: "image", data: "invalid$", mimeType: "image/png" }] },
  { content: [{ type: "audio", data: "YQ==", mimeType: "text/html\n" }] }, { content: [{ type: "resource_link", name: "x", uri: "not a URI" }] },
  { content: [{ type: "resource", resource: { uri: "erp://x", text: "x", blob: "YQ==" } }] },
  { content: [{ type: "text", text: "x", annotations: { audience: ["admin"] } }] }, { content: [{ type: "unknown", data: "x" }] },
  { content: Array.from({ length: 129 }, () => ({ type: "text", text: "x" })) }, { content: [{ type: "text", text: "界".repeat(171000) }] },
])("malformed/unsupported/oversized result cannot become confirmed success %#", input => expect(() => safeMcpResult(input)).toThrow());
test("reviewed output schema is validated before redaction; tool failures retain their own envelope", () => {
  const schema = { type: "object", properties: { id: { type: "string" }, token: { type: "string" } }, required: ["id", "token"], additionalProperties: false };
  expect(safeMcpResult({ content: [], structuredContent: { id: "one", token: "private" } }, schema)).toEqual({ content: [], structuredContent: { id: "one" } });
  for (const value of [{ content: [] }, { content: [], structuredContent: { id: 1, token: "private" } }]) expect(() => safeMcpResult(value, schema)).toThrow(/reviewed output schema/);
  expect(safeMcpResult({ content: [], isError: true }, schema)).toEqual({ content: [], isError: true });
});

test("explicit read-only text JSON compatibility validates original arrays without relabelling their schema", () => {
  const schema = { type: "array", items: { type: "object", properties: { name: { type: "string" }, token: { type: "string" } }, required: ["name", "token"] } };
  const response = { content: [{ type: "text", text: '[{"name":"Company A","token":"private"}]' }] };
  expect(() => safeMcpResult(response, schema)).toThrow(/reviewed output schema/);
  expect(safeMcpResult(response, schema, { allowReadJsonText: true })).toEqual({ content: [{ type: "text", text: '[{"name":"Company A"}]' }], jsonContent: [{ name: "Company A" }] });
  for (const input of [
    { content: [{ type: "text", text: "not JSON" }] },
    { content: [{ type: "text", text: '[{"name":7,"token":"private"}]' }] },
    { content: [{ type: "text", text: '[{"name":"Company A"}]' }] },
    { content: [{ type: "text", text: "[]" }, { type: "text", text: "another result" }] },
    { content: [], structuredContent: {} },
  ]) expect(() => safeMcpResult(input, schema, { allowReadJsonText: true })).toThrow(/reviewed output schema/);
  expect(safeMcpResult({ content: [{ type: "text", text: "Not found" }], isError: true }, schema, { allowReadJsonText: true })).toMatchObject({ isError: true });
});
