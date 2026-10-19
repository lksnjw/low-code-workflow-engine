import { z } from "zod";
import { jsonObjectSchema, jsonValueSchema } from "../models/schemas.js";
import { operationReadbackSchema } from "./operation-readback-schema.js";
import { readErrorContractSchema } from "./read-error-schema.js";

export const toolSchema = z.object({
  tool_id: z.string().default(""),
  name: z.string().default(""),
  display_name: z.string().default(""),
  erp_system: z.string().optional(),
  module: z.string().default(""),
  status: z.string().default(""),
  description: z.string().default(""),
  business_capability: z.string().default(""),
  bpi_process_alignment: z.array(z.string()).default([]),
  endpoint: z.string().default(""),
  http_method: z.string().default(""),
  mcp_tool_name: z.string().default(""),
  // Additive, connection-owned dynamic contract; absence preserves release hashes.
  connection_id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/).optional(),
  input_schema: jsonObjectSchema.default({}),
  // Optional additive admission record; no default changes frozen legacy hashes.
  bridge_contract: z.object({
    profile: z.literal("toolplane-v1"),
    // Absent preserves historical version-qualified contracts and hashes.
    selector: z.enum(["digest-pinned-alias", "digest-pinned-operation-alias", "digest-pinned-mcp-operation-alias"]).optional(),
    resource_version: z.string().min(1).max(128).regex(/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/),
    resource_digest: z.string().regex(/^[a-f0-9]{64}$/),
    remote_roles: z.array(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/)).max(32).refine(roles => new Set(roles).size === roles.length),
    output_schema: jsonObjectSchema.optional(),
    trusted_input: z.union([
      z.object({ actor: jsonObjectSchema, required: z.array(z.string()).max(128) }).strict(),
      z.object({ access_token: jsonObjectSchema }).strict(),
    ]).optional(),
  }).strict().optional(),
  // Additive only: absence preserves historical capability hashes. Adding or
  // changing this mapping requires a new exact capability observation/review.
  read_error_contract: readErrorContractSchema.optional(),
  // Explicit local reviewed outcome contract, never inferred from a tool name
  // or MCP annotations. It does not promise upstream idempotency.
  operation_contract: z.object({
    profile: z.literal("operation-result/v1"),
    effect_class: z.enum(["write", "notification"]),
    retry_policy: z.literal("never"),
    receipt_profile: z.enum(["erpnext-item-create/v1", "erpnext-item-update/v1", "erpnext-stock-receipt-draft/v1", "erpnext-customer-create/v1"]).optional(),
    confirmation: z.object({
      source: z.literal("mcp-envelope").optional(),
      path: z.array(z.string().min(1).max(128).refine(part => !["__proto__", "constructor", "prototype"].includes(part))).min(1).max(12),
      expected: z.union([z.string().min(1).max(256), z.number().finite(), z.boolean()]),
      meaning: z.enum(["operation-accepted", "operation-confirmed"]),
    }).strict(),
    readback: operationReadbackSchema.optional(),
  }).strict().optional(),
  // Optional, explicitly reviewed binding for turning an immutable chat email
  // draft into one notification operation. Parameter names are never inferred
  // from tool names, descriptions, model output or browser input.
  email_delivery_contract: z.object({
    profile: z.literal("email-delivery-input/v1"),
    recipient_parameter: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/),
    subject_parameter: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/),
    body_parameter: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/),
  }).strict().refine(value => new Set([value.recipient_parameter, value.subject_parameter, value.body_parameter]).size === 3,
    "Email delivery parameters must be distinct").optional(),
  // Optional reviewed proof contract for a bounded report read. This is an
  // attestation made by the connector result; it is never inferred from
  // conventional names such as `page`, descriptions, or model output.
  report_coverage_contract: z.object({
    profile: z.literal("report-coverage/v1"),
    // The reviewed business identity is explicit. Agent composition must not
    // infer that a structurally complete report is an invoice/order report
    // from its tool name, description, or model wording.
    business_resource: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/).optional(),
    start_parameter: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/),
    end_parameter: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/),
    covered_start_path: z.array(z.string().min(1).max(128).refine(part => !["__proto__", "constructor", "prototype"].includes(part))).min(1).max(12),
    covered_end_path: z.array(z.string().min(1).max(128).refine(part => !["__proto__", "constructor", "prototype"].includes(part))).min(1).max(12),
    complete_path: z.array(z.string().min(1).max(128).refine(part => !["__proto__", "constructor", "prototype"].includes(part))).min(1).max(12),
    has_more_path: z.array(z.string().min(1).max(128).refine(part => !["__proto__", "constructor", "prototype"].includes(part))).min(1).max(12),
    items_path: z.array(z.string().min(1).max(128).refine(part => !["__proto__", "constructor", "prototype"].includes(part))).min(1).max(12),
    item_count_path: z.array(z.string().min(1).max(128).refine(part => !["__proto__", "constructor", "prototype"].includes(part))).min(1).max(12),
    // Optional exact-key contracts for a two-read scheduled relation. The
    // primary report projects the unique related IDs from every returned
    // item; the related report must return exactly the requested ID set.
    key_projection: z.object({
      profile: z.literal("report-key-projection/v1"),
      relation_name: z.string().trim().min(1).max(80),
      item_key_path: z.array(z.string().min(1).max(128).refine(part => !["__proto__", "constructor", "prototype"].includes(part))).min(1).max(12),
      keys_path: z.array(z.string().min(1).max(128).refine(part => !["__proto__", "constructor", "prototype"].includes(part))).min(1).max(12),
    }).strict().optional(),
    requested_key_coverage: z.object({
      profile: z.literal("report-requested-key-coverage/v1"),
      relation_name: z.string().trim().min(1).max(80),
      keys_parameter: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/),
      item_key_path: z.array(z.string().min(1).max(128).refine(part => !["__proto__", "constructor", "prototype"].includes(part))).min(1).max(12),
    }).strict().optional(),
    pagination: z.discriminatedUnion("profile", [
      z.object({
        profile: z.literal("page-number/v1"),
        page_parameter: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/),
        page_path: z.array(z.string().min(1).max(128).refine(part => !["__proto__", "constructor", "prototype"].includes(part))).min(1).max(12),
        snapshot_path: z.array(z.string().min(1).max(128).refine(part => !["__proto__", "constructor", "prototype"].includes(part))).min(1).max(12),
        total_count_path: z.array(z.string().min(1).max(128).refine(part => !["__proto__", "constructor", "prototype"].includes(part))).min(1).max(12),
        first_page: z.number().int().min(0).max(1),
        max_pages: z.number().int().min(1).max(100),
        max_items: z.number().int().min(1).max(100_000),
      }).strict(),
      z.object({
        profile: z.literal("opaque-cursor/v1"),
        cursor_parameter: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/),
        cursor_path: z.array(z.string().min(1).max(128).refine(part => !["__proto__", "constructor", "prototype"].includes(part))).min(1).max(12),
        next_cursor_path: z.array(z.string().min(1).max(128).refine(part => !["__proto__", "constructor", "prototype"].includes(part))).min(1).max(12),
        snapshot_path: z.array(z.string().min(1).max(128).refine(part => !["__proto__", "constructor", "prototype"].includes(part))).min(1).max(12),
        total_count_path: z.array(z.string().min(1).max(128).refine(part => !["__proto__", "constructor", "prototype"].includes(part))).min(1).max(12),
        initial_cursor: z.string().max(2_048),
        max_pages: z.number().int().min(1).max(100),
        max_items: z.number().int().min(1).max(100_000),
      }).strict(),
    ]).optional(),
  }).strict()
    .refine(value => value.start_parameter !== value.end_parameter, "Report coverage parameters must be distinct")
    .refine(value => !value.pagination || ![value.start_parameter, value.end_parameter].includes(value.pagination.profile === "page-number/v1" ? value.pagination.page_parameter : value.pagination.cursor_parameter), "Report pagination parameter must be distinct from report-window parameters")
    .refine(value => !value.requested_key_coverage || ![value.start_parameter, value.end_parameter,
      value.pagination?.profile === "page-number/v1" ? value.pagination.page_parameter : value.pagination?.cursor_parameter]
      .includes(value.requested_key_coverage.keys_parameter), "Requested related-key input must be distinct from report window and pagination parameters")
    .refine(value => !(value.key_projection && value.requested_key_coverage), "One report tool cannot both project and consume a related-key set")
    .refine(value => new Set([value.covered_start_path, value.covered_end_path, value.complete_path, value.has_more_path, value.items_path, value.item_count_path]
      .concat(value.pagination ? value.pagination.profile === "page-number/v1" ? [value.pagination.page_path, value.pagination.snapshot_path, value.pagination.total_count_path] :
        [value.pagination.cursor_path, value.pagination.next_cursor_path, value.pagination.snapshot_path, value.pagination.total_count_path] : [])
      .concat(value.key_projection ? [value.key_projection.keys_path] : [])
      .map(path => path.join("\u0000"))).size === (value.pagination ? value.pagination.profile === "page-number/v1" ? 9 : 10 : 6) + (value.key_projection ? 1 : 0), "Report coverage selectors must be distinct").optional(),
  required_parameters: z.array(z.string()).default([]),
  optional_parameters: z.array(z.string()).default([]),
  allowed_roles: z.array(z.string()).default([]),
  risk_level: z.string().default(""),
  is_read_only: z.boolean(),
  side_effects: z.array(z.string()).default([]),
  preconditions: z.array(z.string()).default([]),
  postconditions: z.array(z.string()).default([]),
  failure_modes: z.array(z.string()).default([]),
  validator_checks: z.array(z.string()).default([]),
  prompt_usage_guidance: z.string().default(""),
  semantic_search_keywords: z.array(z.string()).default([]),
  semantic_search_description: z.string().default(""),
  execution_notes: z.string().default(""),
  current_gaps: z.array(z.string()).default([]),
  source_file: z.string().optional(),
}).strict();
export type ToolDefinition = z.infer<typeof toolSchema>;

export const ruleConditionSchema = z.object({
  type: z.string().default(""),
  parameter: z.string().default(""),
  operator: z.string().default(""),
  value: jsonValueSchema.default(null),
}).strict();

export const ruleSchema = z.object({
  rule_id: z.string().default(""),
  rule_name: z.string().default(""),
  rule_type: z.string().default(""),
  erp_system: z.string().optional(),
  domain: z.string().default(""),
  description: z.string().default(""),
  applies_to_tools: z.array(z.string()).default([]),
  applies_to_roles: z.array(z.string()).default([]),
  condition: ruleConditionSchema.default({ type: "", parameter: "", operator: "", value: null }),
  enforcement_action: z.string().default(""),
  severity: z.string().default(""),
  validator_message: z.string().default(""),
  llm_prompt_instruction: z.string().default(""),
  healing_guidance: z.string().default(""),
  bpi_alignment: z.array(z.string()).default([]),
  audit_fields_required: z.array(z.string()).default([]),
  enabled: z.boolean().default(false),
  source_file: z.string().optional(),
}).strict();
export type RuleDefinition = z.infer<typeof ruleSchema>;

export const toolArraySchema = z.array(toolSchema);
export const ruleArraySchema = z.array(ruleSchema);
