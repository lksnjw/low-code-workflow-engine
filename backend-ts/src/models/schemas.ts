import { z } from "zod";
import { namedModelInputSchema } from "./model-input.js";

export const jsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export const jsonObjectSchema = z.record(z.string(), jsonValueSchema);

export const principalSchema = z.object({ id: z.string(), name: z.string() }).strict();
export type Principal = z.infer<typeof principalSchema>;

export const blueprintTriggerSchema = z.object({
  type: z.string(),
  displayName: z.string().optional(),
  config: jsonObjectSchema.optional(),
}).strict();

export const workflowStepBlueprintSchema = z.object({
  id: z.string(),
  kind: z.string().optional(),
  type: z.string().optional(),
  action: z.string().optional(),
  connection_id: z.string().optional(),
  parameters: jsonObjectSchema.optional(),
  instruction: z.string().optional(),
  input: z.union([z.string(), namedModelInputSchema]).optional(),
  output_schema: jsonObjectSchema.optional(),
  allowed_actions: z.array(z.string()).optional(),
  completion_predicate: jsonObjectSchema.optional(),
  data_class: z.enum(["public", "internal", "confidential", "restricted"]).optional(),
  model: z.string().optional(),
  max_input_items: z.number().int().optional(),
  max_input_chars: z.number().int().optional(),
  max_output_tokens: z.number().int().optional(),
  max_total_tokens: z.number().int().optional(),
  max_rounds: z.number().int().optional(),
  max_tool_calls: z.number().int().optional(),
  max_wall_time_ms: z.number().int().optional(),
  max_concurrency: z.number().int().optional(),
  condition: z.string().optional(),
  onError: z.string().optional(),
  retryCount: z.number().int().optional(),
  description: z.string().optional(),
}).strict();

export const workflowBlueprintSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  trigger: blueprintTriggerSchema,
  steps: z.array(workflowStepBlueprintSchema),
  metadata: jsonObjectSchema.optional(),
}).strict();

export type WorkflowBlueprint = z.infer<typeof workflowBlueprintSchema>;
export type WorkflowStepBlueprint = z.infer<typeof workflowStepBlueprintSchema>;

/*******************************************************************************
 * Function: effectiveStepKind
 *
 * Resolves the effective workflow step kind using its default.
 ******************************************************************************/
export function effectiveStepKind(step: WorkflowStepBlueprint): string {
  return step.kind === undefined || step.kind === "" ? "tool" : step.kind;
}

export const workflowSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  owner: principalSchema,
  assignedUserIds: z.array(z.string()).nullable(),
  status: z.string(),
  trigger: jsonObjectSchema.nullable(),
  steps: z.number().int(),
  successRate: z.number(),
  lastRunAt: z.string().datetime().nullable(),
  publishedVersion: z.number().int(),
  draftVersion: z.number().int(),
  tags: z.array(z.string()).nullable(),
  domainTags: z.array(z.string()).nullable(),
  canRun: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();
export type Workflow = z.infer<typeof workflowSchema> & {
  yaml: string;
  archived: boolean;
  canvas?: Record<string, unknown>;
  chatSessionId?: string;
  chatMessageId?: string;
  traceId?: string;
  recoverySource?: { profile: "operation-recovery-source/v1"; sourceExecutionId: string; artifactId: string; artifactHash: string };
  emailDeliverySource?: { profile: "email-delivery-source/v1"; admissionId: string; sessionId: string; draftId: string; draftVersion: number; draftHash: string };
  // Set when the generated workflow contains one or more `kind: approval`
  // steps that have not yet been resolved in chat. While this is set the
  // workflow cannot be run — see the generation-time approval flow in
  // http/handlers/workflows.ts (approveWorkflowGeneration/rejectWorkflowGeneration).
  // Accepting it preserves all runtime checkpoints and does not authorize
  // the transactions of subsequent runs.
  pendingGenerationApproval?: { steps: Array<{ stepId: string; description: string }>; requestedAt: string } | null;
  generationApprovals?: Array<{ approvedBy: { id: string; name: string }; approvedAt: string; note?: string }>;
};

export const deferredCheckSchema = z.object({
  step_index: z.number().int(),
  param_key: z.string(),
  rule_ids: z.array(z.string()),
}).strict();
export type DeferredCheck = z.infer<typeof deferredCheckSchema>;

export const validationTokenSchema = z.object({
  workflow_content_hash: z.string(),
  registry_hash: z.string(),
  passed_at: z.string().datetime(),
  deferred_checks: z.array(deferredCheckSchema).nullable(),
}).strict();
export type PublicValidationToken = z.infer<typeof validationTokenSchema>;

export const runWorkflowRequestSchema = z.object({
  startRevision: z.object({ baseVersion: z.number().int().min(1), baseHash: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).strict().optional(),
  input: jsonObjectSchema.nullable().default(null),
  mode: z.string().default(""),
  dryRun: z.boolean().default(false),
  simulation: z.unknown().optional(),
  idempotencyKey: z.string().default(""),
  expectedActorId: z.string().min(1).max(256).optional(),
  retry: z.object({ sourceExecutionId: z.string().min(1).max(256), acknowledgeUnconfirmed: z.boolean().default(false) }).strict().optional(),
}).strict();

export const loginRequestSchema = z.object({
  email: z.string(),
  password: z.string(),
  rememberMe: z.boolean().default(false),
}).strict();

export const registerRequestSchema = z.object({
  name: z.string(),
  email: z.string(),
  password: z.string(),
  organizationName: z.string().default(""),
}).strict();

export type ApiResponse<T = unknown> = {
  success: boolean;
  data: T | null;
  message: string;
  meta: unknown;
};

/*******************************************************************************
 * Function: ok
 *
 * Builds a successful API response envelope.
 ******************************************************************************/
export function ok<T>(data: T, message = "", meta: unknown = null): ApiResponse<T> {
  return { success: true, data, message: message === "" ? "OK" : message, meta };
}

/*******************************************************************************
 * Function: fail
 *
 * Builds a failed API response envelope.
 ******************************************************************************/
export function fail(message = "", meta: unknown = null): ApiResponse<never> {
  return { success: false, data: null, message: message === "" ? "Request failed" : message, meta };
}
