import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { discoveredContract } from "../src/registry/discovered-contract.js";
import { supportedOperation, supportedRead } from "../src/registry/capability-admission.js";
import { matchesBridgeContract, bridgeTransportSchema } from "../src/tools/erpbridge-contract.js";
import { validateToolInput } from "../src/tools/tool-input-schema.js";
import { safeMcpToolResult } from "../src/tools/mcp-result.js";
import type { ErpbridgeMcpSdkTool } from "../src/tools/erpbridge-mcp-client.js";
const tools: ErpbridgeMcpSdkTool[] = JSON.parse(readFileSync(new URL("fixtures/connected-tool-schema-extensions.json", import.meta.url), "utf8"));
const remote = (name: string) => tools.find(tool => tool.name === name)!;
const definition = (name: string) => {
  const raw = remote(name), tool = discoveredContract(raw, "erpbridge-default");
  return { ...tool, allowed_roles: ["Client"], is_read_only: raw.annotations?.readOnlyHint === true,
    risk_level: raw.annotations?.readOnlyHint === true ? "low" : "medium", side_effects: raw.annotations?.readOnlyHint === true ? [] : ["Exact confirmed call"] };
};

test.each(tools.map(tool => tool.name))("the real connected %s contract preserves exact discovery and can be admitted", name => {
  const tool = definition(name); expect(matchesBridgeContract(tool, remote(name))).toBe(true);
  expect(bridgeTransportSchema(tool)).toEqual(remote(name).inputSchema);
  expect(() => tool.is_read_only ? supportedRead(tool) : supportedOperation(tool)).not.toThrow();
});

test("advisory review constraints validate const, enum, date-time and minimum length", () => {
  const schema = remote("get_sales_order_with_ai_review").outputSchema!;
  const value = { name: "SO-1", ai_assessment: { model: "@cf/cloudflare/clef-flash", policy_version: "order-review-v1", evaluated_at: "2026-10-19T10:30:00Z",
    status: "assessed", review_queue: "routine", review_priority: "low", requires_human_review: true, advisory_only: true } };
  expect(validateToolInput(schema, value)).toEqual([]);
  for (const patch of [{ advisory_only: false }, { evaluated_at: "tomorrow" }, { review_queue: "invented" }])
    expect(validateToolInput(schema, { ...value, ai_assessment: { ...value.ai_assessment, ...patch } }).length).toBeGreaterThan(0);
  expect(validateToolInput(schema, { ...value, name: "" }).length).toBeGreaterThan(0);
});

test("map schemas and object/array output unions retain their actual constraints", () => {
  const profiles = remote("get_user_details").outputSchema!;
  expect(validateToolInput(profiles, { message: { demo: { name: "demo", image: null, time_zone: "Asia/Colombo" } } })).toEqual([]);
  expect(validateToolInput(profiles, { message: { demo: "invalid profile" } }).length).toBeGreaterThan(0);
  const schema = remote("get_value").outputSchema!;
  for (const message of [{ name: "Customer 1" }, ["Customer 1"]]) expect(validateToolInput(schema, { message })).toEqual([]);
  expect(validateToolInput(schema, { message: 42 }).length).toBeGreaterThan(0);
});

test("undeclared output stays an MCP envelope and never invents business fields", () => {
  const tool = definition("resend-email-send"); expect(tool.bridge_contract?.output_schema).toBeUndefined();
  const result = safeMcpToolResult({ content: [{ type: "text", text: "Actual server acknowledgement" }] }, tool);
  expect(result.acknowledged).toBe(true); expect(result.jsonContent).toBeUndefined(); expect(result.structuredContent).toBeUndefined();
  expect(safeMcpToolResult({ content: [], isError: true }, tool).acknowledged).toBe(false);
});

test("policy identity and document delegation are backend transport fields, absent from authored inputs", () => {
  for (const name of ["rag-policy-assist", "rag-policy-evaluate"]) {
    const tool = definition(name);
    expect(tool.input_schema.properties).not.toHaveProperty("actor"); expect(tool.input_schema.required).not.toContain("actor");
    expect(tool.bridge_contract?.trusted_input).toHaveProperty("actor");
  }
  for (const name of ["pipeline-library-discover", "pipeline-library-resolve", "pipeline-library-search"])
    expect(definition(name).input_schema.properties).not.toHaveProperty("access_token");
});
