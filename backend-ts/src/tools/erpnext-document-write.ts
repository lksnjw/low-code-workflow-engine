import { z } from "zod";
import { canonicalJSONBytes } from "../core/canonical-json.js";
import type { ToolDefinition } from "../registry/schemas.js";

type Contract = NonNullable<ToolDefinition["operation_contract"]>;
const profiles = { create_item: "erpnext-item-create/v1", update_item: "erpnext-item-update/v1", insert_document: "erpnext-stock-receipt-draft/v1", create_customer: "erpnext-customer-create/v1" } as const;
const id = z.string().min(1).max(140).refine(v => v === v.trim() && !["__proto__", "constructor", "prototype"].includes(v));
const item = z.object({ is_stock_item: z.union([z.literal(0), z.literal(1)]), item_code: id, item_group: id, item_name: id, stock_uom: id }).strict();
// Names and references still have to pass the current digest-pinned remote
// schema. Do not copy optional pipeline-only fields into the ERP operation.
const customer = z.object({ customer_name: id, customer_group: id, territory: id,
  customer_type: z.enum(["Company", "Individual"]).optional() }).strict();
const edit = z.object({ name: id, description: z.string().max(10000).optional(), is_stock_item: z.union([z.literal(0), z.literal(1)]).optional(),
  item_group: id.optional(), item_name: id.optional(), stock_uom: id.optional() }).strict().refine(v => Object.keys(v).length > 1);
const receipt = z.object({ doctype: z.literal("Stock Entry"), stock_entry_type: z.literal("Material Receipt"), company: id, docstatus: z.literal(0).optional(),
  posting_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), posting_time: z.string().regex(/^\d{2}:\d{2}:\d{2}(?:\.\d+)?$/).optional(),
  remarks: z.string().max(4000).optional(), items: z.array(z.object({ item_code: id, qty: z.number().finite().positive().max(1000000), t_warehouse: id,
    uom: id.optional(), stock_uom: id.optional(), conversion_factor: z.number().finite().positive().optional(), basic_rate: z.number().finite().nonnegative().optional(),
    allow_zero_valuation_rate: z.union([z.literal(0), z.literal(1)]).optional(), description: z.string().max(2000).optional() }).strict()).min(1).max(100) }).strict();
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** A closed, engine-owned compatibility profile, not permission inferred from a
 * name or annotation. Its exact args, receipt and effect are explicitly reviewed. */
export function erpnextWriteContract(name: string): Contract | undefined {
  if (!Object.hasOwn(profiles, name)) return;
  return { profile: "operation-result/v1", effect_class: "write", retry_policy: "never", receipt_profile: profiles[name as keyof typeof profiles],
    confirmation: { path: ["doctype"], expected: name === "insert_document" ? "Stock Entry" : name === "create_customer" ? "Customer" : "Item", meaning: "operation-confirmed" } };
}
export function isErpnextWriteContract(tool: ToolDefinition): boolean {
  const expected = erpnextWriteContract(tool.mcp_tool_name);
  return Boolean(expected && tool.operation_contract && canonicalJSONBytes(expected).equals(canonicalJSONBytes(tool.operation_contract)));
}
export function erpnextReceiptSchema(tool: ToolDefinition): Record<string, unknown> | undefined {
  if (!isErpnextWriteContract(tool)) return;
  return { type: "object", properties: { name: { type: "string", minLength: 1, maxLength: 140 },
    doctype: { type: "string", enum: [tool.operation_contract!.confirmation.expected] }, docstatus: { type: "integer", enum: [0] } }, required: ["name", "doctype", "docstatus"] };
}
function draft(args: Record<string, unknown>) {
  if (typeof args.doc !== "string" || Buffer.byteLength(args.doc) > 200000 || Object.keys(args).length !== 1) throw new Error("A bounded reviewed draft document is required");
  let value: unknown; try { value = JSON.parse(args.doc); } catch { throw new Error("Draft document must be valid JSON"); }
  return receipt.parse(value);
}
/** Runs before any SDK entry/permit consumption. In particular insert_document
 * cannot submit, transfer, delete or create an unrelated kind of document. */
export function assertErpnextWriteArguments(tool: ToolDefinition, args: Record<string, unknown>): void {
  if (!tool.operation_contract?.receipt_profile) return;
  if (!isErpnextWriteContract(tool) || tool.is_read_only || tool.bridge_contract?.selector !== "digest-pinned-operation-alias") throw new Error("Unsupported reviewed ERPNext write profile");
  switch (tool.operation_contract.receipt_profile) {
    case "erpnext-item-create/v1": item.parse(args); break;
    case "erpnext-item-update/v1": edit.parse(args); break;
    case "erpnext-stock-receipt-draft/v1": draft(args); break;
    case "erpnext-customer-create/v1": customer.parse(args); break;
  }
}
/** A successful HTTP reply alone is insufficient. Correlate the original
 * structured ERP document to every reviewed changed business field. An invalid
 * receipt is an unknown outcome, never permission to replay a mutation. */
export function assertErpnextWriteReceipt(tool: ToolDefinition, args: Record<string, unknown>, value: unknown): void {
  if (!tool.operation_contract?.receipt_profile) return;
  assertErpnextWriteArguments(tool, args);
  const fail = () => { throw new Error("ERPNext write receipt is unconfirmed; reconcile the original operation before any retry"); };
  if (!object(value) || typeof value.name !== "string" || !value.name.trim() || value.name.length > 140 || value.docstatus !== 0 ||
      value.doctype !== tool.operation_contract.confirmation.expected) return fail();
  if (tool.operation_contract.receipt_profile === "erpnext-stock-receipt-draft/v1") {
    const source = draft(args);
    if (value.company !== source.company || value.stock_entry_type !== source.stock_entry_type || !Array.isArray(value.items) || value.items.length !== source.items.length) return fail();
    for (const [index, expected] of source.items.entries()) {
      const actual = value.items[index];
      if (!object(actual) || Object.entries(expected).some(([key, expectedValue]) => actual[key] !== expectedValue)) return fail();
    }
  } else {
    // The reviewed customer tool explicitly uses the trading name as record
    // name. A different ERP naming contract requires a different profile.
    const expectedName = tool.operation_contract.receipt_profile === "erpnext-item-create/v1" ? args.item_code
      : tool.operation_contract.receipt_profile === "erpnext-customer-create/v1" ? args.customer_name : args.name;
    if (value.name !== expectedName || Object.entries(args).some(([key, expectedValue]) => key !== "name" && value[key] !== expectedValue)) return fail();
  }
}
