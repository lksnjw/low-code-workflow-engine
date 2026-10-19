import { expect, test } from "vitest";
import { discoveredContract } from "../src/registry/discovered-contract.js";
import { toolSchema } from "../src/registry/schemas.js";
import { supportedOperation, supportedRead } from "../src/registry/capability-admission.js";
import { safeMcpToolResult, reviewedReadOutputKey } from "../src/tools/mcp-result.js";
import { confirmedOperationResult } from "../src/runner/operation-jobs.js";
import { matchesBridgeContract } from "../src/tools/erpbridge-contract.js";

const raw = { name: "delete_customer", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
  outputSchema: { type: "object" }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  _meta: { "toolplane.serving": true, "toolplane.resourceVersion": "1.0.0", "toolplane.resourceDigest": "d".repeat(64) } };
const definition = () => toolSchema.parse({ ...discoveredContract(raw, "erpbridge-default"), allowed_roles: ["Client"], is_read_only: false, risk_level: "medium", side_effects: ["Explicitly reviewed exact ERP change"] });

test("delete and other live MCP mutations have an exact importable contract without inventing business receipts", () => {
  const tool = definition(); expect(matchesBridgeContract(tool, raw)).toBe(true); expect(() => supportedOperation(tool)).not.toThrow();
  expect(() => supportedRead(tool)).toThrow(); expect(reviewedReadOutputKey(tool)).toBe("jsonContent");
  expect(tool.operation_contract?.confirmation).toEqual({ source: "mcp-envelope", path: ["acknowledged"], expected: true, meaning: "operation-accepted" });
  expect(matchesBridgeContract(tool, { ...raw, _meta: { ...raw._meta, "toolplane.resourceDigest": "e".repeat(64) } })).toBe(false);
});

test("generic confirmation is minted only after a valid MCP return; remote errors or malformed output do not succeed", () => {
  const tool = definition();
  const result = safeMcpToolResult({ content: [{ type: "text", text: '{"message":"Tool returned"}' }], acknowledged: false }, tool);
  expect(result).toMatchObject({ acknowledged: true, jsonContent: { message: "Tool returned" } });
  expect(confirmedOperationResult(tool, result, { name: "CUSTOMER-1" })).toBe(true);
  const failed = safeMcpToolResult({ content: [], isError: true, acknowledged: true }, tool);
  expect(failed.acknowledged).toBe(false); expect(confirmedOperationResult(tool, failed)).toBe(false);
  expect(() => safeMcpToolResult({ content: [{ type: "text", text: "untyped success prose" }] }, tool)).toThrow();
  expect(confirmedOperationResult(tool, { content: [], structuredContent: { acknowledged: true } })).toBe(false);
});

test("generic mutations cannot claim business confirmation or downgrade to ordinary read aliases", () => {
  const tool = definition(); tool.operation_contract!.confirmation.meaning = "operation-confirmed";
  expect(() => supportedOperation(tool)).toThrow();
  const forged = definition(); forged.bridge_contract!.selector = "digest-pinned-alias";
  expect(() => supportedOperation(forged)).toThrow();
});
