import { z } from "zod";
import { jsonObjectSchema, jsonValueSchema } from "../models/schemas.js";

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
  input_schema: jsonObjectSchema.default({}),
  required_parameters: z.array(z.string()).default([]),
  optional_parameters: z.array(z.string()).default([]),
  allowed_roles: z.array(z.string()).default([]),
  risk_level: z.string().default(""),
  is_read_only: z.boolean().default(false),
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
