import { test, expect } from "vitest";
import { discoveredContract, discoveredCapabilityPreview } from "../src/registry/discovered-contract.js";
import { supportedOperation, supportedRead } from "../src/registry/capability-admission.js";
import { exactBridgeName, matchesBridgeContract } from "../src/tools/erpbridge-contract.js";
import { erpnextWriteContract, assertErpnextWriteArguments, assertErpnextWriteReceipt } from "../src/tools/erpnext-document-write.js";
import { safeMcpToolResult } from "../src/tools/mcp-result.js";
import { confirmedOperationResult } from "../src/runner/operation-jobs.js";
import type { ErpbridgeMcpSdkTool } from "../src/tools/erpbridge-mcp-client.js";
import { RegistryService } from "../src/registry/service.js";
import { ruleSchema } from "../src/registry/schemas.js";
import { RegistryValidator } from "../src/validator/registry-validator.js";
import { Repository } from "../src/repository/store.js";
import { resolve } from "node:path";
import { stringify } from "yaml";

const remote = (name = "create_item"): ErpbridgeMcpSdkTool => ({ name, inputSchema: { type: "object" }, outputSchema: { type: "object" },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  _meta: { "toolplane.resourceVersion": "1.1.0", "toolplane.resourceDigest": "a".repeat(64), "toolplane.serving": true } });
const reviewed = (name = "create_item") => ({ ...discoveredContract(remote(name), "erpbridge-default"),
  allowed_roles: ["Platform Admin"], is_read_only: false, risk_level: "medium", side_effects: ["Create or edit an ERP draft record"] });
const args = { item_code: "LCWE-QA-ITEM", item_name: "QA Item", item_group: "Products", stock_uom: "Nos", is_stock_item: 1 };
const document = { ...args, name: args.item_code, doctype: "Item", docstatus: 0 };

test.each(["create_item", "update_item", "insert_document", "create_customer"])("%s is discoverable without authority, and only explicitly reviewable as its exact medium-risk operation", name => {
  const preview = discoveredCapabilityPreview(remote(name), "erpbridge-default");
  expect(preview).toMatchObject({ importable: true, authorityGranted: false, definition: { is_read_only: false, allowed_roles: [] } });
  expect(() => supportedOperation(discoveredContract(remote(name), "erpbridge-default"))).toThrow();
  const tool = reviewed(name); expect(() => supportedOperation(tool)).not.toThrow(); expect(exactBridgeName(tool)).toBe(name);
  expect(matchesBridgeContract(tool, remote(name))).toBe(true);
  expect(matchesBridgeContract(tool, { ...remote(name), _meta: { ...remote(name)._meta, "toolplane.resourceDigest": "b".repeat(64) } })).toBe(false);
  expect(matchesBridgeContract(tool, { ...remote(name), annotations: { readOnlyHint: true } })).toBe(false);
  expect(() => supportedOperation({ ...tool, risk_level: "low" })).toThrow();
  expect(() => supportedRead({ ...tool, is_read_only: true, risk_level: "low", side_effects: [] })).toThrow();
  expect(() => supportedOperation({ ...tool, operation_contract: { ...tool.operation_contract!, confirmation: { path: ["name"], expected: "anything", meaning: "operation-confirmed" } } })).toThrow();
});
test.each(["delete_item", "submit_document", "cancel_document", "create_supplier", "update_document"])("unqualified %s is not silently enabled by the reviewed profiles", name => {
  expect(erpnextWriteContract(name)).toBeUndefined(); expect(discoveredCapabilityPreview(remote(name), "erpbridge-default").importable).toBe(false);
});
test("serving/version/digest are still exact and mandatory", () => {
  for (const key of ["toolplane.serving", "toolplane.resourceVersion", "toolplane.resourceDigest"]) {
    const tool = remote(); delete tool._meta![key]; expect(discoveredCapabilityPreview(tool, "erpbridge-default").importable).toBe(false);
  }
});
test("create receipt must correlate every requested field and identity; missing data is not a success", () => {
  const tool = reviewed(); expect(() => assertErpnextWriteArguments(tool, args)).not.toThrow();
  expect(() => assertErpnextWriteReceipt(tool, args, document)).not.toThrow();
  for (const bad of [{}, { ...document, name: "another" }, { ...document, item_name: "wrong" }, { ...document, docstatus: 1 }, { ...document, doctype: "Customer" }])
    expect(() => assertErpnextWriteReceipt(tool, args, bad)).toThrow();
  expect(() => assertErpnextWriteArguments(tool, { ...args, is_stock_item: 2 })).toThrow();
  expect(() => assertErpnextWriteArguments(tool, { ...args, role: "admin" })).toThrow();
  expect(() => assertErpnextWriteArguments(tool, { ...args, stock_uom: "" })).toThrow();
});
test("customer creation validates mandatory fields and correlates its exact original receipt without granting a retry", () => {
  const tool = reviewed("create_customer"), input = { customer_name: "Source Customer", customer_group: "Commercial", territory: "Sri Lanka", customer_type: "Company" };
  const output = { ...input, name: input.customer_name, doctype: "Customer", docstatus: 0 };
  expect(tool.operation_contract?.retry_policy).toBe("never");
  expect(() => assertErpnextWriteReceipt(tool, input, output)).not.toThrow();
  for (const key of ["customer_name", "customer_group", "territory"]) {
    const missing = { ...input } as Record<string, unknown>; delete missing[key];
    expect(() => assertErpnextWriteArguments(tool, missing)).toThrow();
  }
  for (const bad of [{ ...input, customer_type: "Unknown" }, { ...input, email: "not-an-erp-field@example.test" }, { ...input, role: "admin" }])
    expect(() => assertErpnextWriteArguments(tool, bad)).toThrow();
  for (const bad of [{}, { ...output, name: "Different Customer" }, { ...output, customer_group: "Another group" }, { ...output, territory: "Another territory" }, { ...output, doctype: "Supplier" }, { ...output, docstatus: 1 }])
    expect(() => assertErpnextWriteReceipt(tool, input, bad)).toThrow();
  expect(confirmedOperationResult(tool, safeMcpToolResult({ content: [{ type: "text", text: JSON.stringify(output) }], structuredContent: output }, tool), input)).toBe(true);
  expect(confirmedOperationResult(tool, { structuredContent: { doctype: "Customer" } }, input)).toBe(false);
});
test("update requires at least one exact changed field, never accepts an unrelated record", () => {
  const tool = reviewed("update_item"), edit = { name: args.item_code, item_name: "Updated QA" };
  expect(() => assertErpnextWriteArguments(tool, { name: args.item_code })).toThrow();
  expect(() => assertErpnextWriteReceipt(tool, edit, { ...document, item_name: "Updated QA" })).not.toThrow();
  expect(() => assertErpnextWriteReceipt(tool, edit, document)).toThrow();
  expect(() => assertErpnextWriteArguments(tool, { ...edit, disabled: 1 })).toThrow();
});
test("draft receipt verifies every child and never authorizes posting, a negative receipt or a different DocType", () => {
  const tool = reviewed("insert_document"), doc = { doctype: "Stock Entry", stock_entry_type: "Material Receipt", company: "QA", items: [{ item_code: args.item_code, qty: 1, t_warehouse: "QA Stores" }] };
  const input = { doc: JSON.stringify(doc) }, output = { ...doc, name: "MAT-QA-1", docstatus: 0 };
  expect(() => assertErpnextWriteReceipt(tool, input, output)).not.toThrow();
  for (const bad of [{ ...doc, docstatus: 1 }, { ...doc, doctype: "Sales Invoice" }, { ...doc, stock_entry_type: "Material Issue" },
    { ...doc, items: [{ ...doc.items[0], qty: -1 }] }, { ...doc, items: [] }, { ...doc, owner: "Administrator" }])
    expect(() => assertErpnextWriteArguments(tool, { doc: JSON.stringify(bad) })).toThrow();
  expect(() => assertErpnextWriteReceipt(tool, input, { ...output, items: [{ ...doc.items[0], qty: 2 }] })).toThrow();
  expect(() => assertErpnextWriteArguments(tool, { doc: "not json" })).toThrow();
});
test("operation confirmation cannot accept HTTP success, text-only or fabricated structured content without exact args", () => {
  const tool = reviewed(), raw = { content: [{ type: "text", text: JSON.stringify(document) }], structuredContent: document };
  const output = safeMcpToolResult(raw, tool);
  expect(confirmedOperationResult(tool, output, args)).toBe(true);
  expect(confirmedOperationResult(tool, output)).toBe(false);
  expect(confirmedOperationResult(tool, { ...output, isError: true }, args)).toBe(false);
  expect(confirmedOperationResult(tool, { structuredContent: { doctype: "Item" } }, args)).toBe(false);
  expect(() => safeMcpToolResult({ content: raw.content }, tool)).toThrow();
});
test("new operation profiles cannot be passed as legacy qualified contracts", () => {
  const tool = reviewed(); delete tool.bridge_contract!.selector; expect(() => supportedOperation(tool)).toThrow();
});

test("only exact engine-journaled ERPNext profiles satisfy the legacy external-audit-step rule", async () => {
  const registries = await RegistryService.load(resolve("tests/fixtures/tools.json"), resolve("tests/fixtures/rules.json"));
  const rule = ruleSchema.parse({ rule_id: "AUDIT-REQUIRED", rule_type: "audit", enabled: true });
  const tool = reviewed("create_customer"), input = { customer_name: "A", customer_group: "Commercial", territory: "Sri Lanka" };
  const snapshot = { tools: [tool], rules: [rule], versions: { tools: "test", rules: "test" } };
  const registry = Object.create(registries);
  registry.snapshot = () => snapshot;
  registry.enabledRules = () => snapshot.rules;
  registry.findTool = (name: string) => snapshot.tools.find(t => t.name === name);
  registry.hash = () => "test";
  const validator = new RegistryValidator(registry, new Repository());
  const yaml = stringify({ name: "Registration", description: "Reviewed customer", trigger: { type: "manual" }, steps: [{ id: "create", action: tool.name, parameters: input }] });
  const result = validator.validatePlan("test", yaml, "Platform Admin");
  expect(result.failed_rules).not.toContain("AUDIT-REQUIRED");
  expect(result.metadata.auditMechanism).toContain("dispatch-journal");
  snapshot.tools = [{ ...tool, operation_contract: undefined } as typeof tool];
  expect(validator.validatePlan("test", yaml, "Platform Admin").failed_rules).toContain("AUDIT-REQUIRED");
});
