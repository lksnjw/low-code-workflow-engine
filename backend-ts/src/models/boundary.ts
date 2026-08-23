import { z } from "zod";
import { jsonObjectSchema, jsonValueSchema, principalSchema } from "./schemas.js";

const timestamp = z.string().datetime({ offset: true });

export const departmentSchema = z.object({
  id: z.string().default(""),
  name: z.string().default(""),
  domains: z.array(z.string()).nullable().default([]),
}).strict();

export const costCentreSchema = z.object({
  code: z.string().default(""),
  name: z.string().default(""),
  ownerUserId: z.string().default(""),
  budgetAmount: z.number().default(0),
  currency: z.string().default(""),
}).strict();

export const approvalTierSchema = z.object({
  label: z.string().default(""),
  maxAmount: z.number().default(0),
  approverRoleId: z.string().default(""),
}).strict();

export const companyProfileSchema = z.object({
  name: z.string().default(""),
  legalName: z.string().default(""),
  industry: z.string().default(""),
  timezone: z.string().default(""),
  currency: z.string().default(""),
  fiscalYearStart: z.string().default(""),
  contactEmail: z.string().default(""),
  erpSystemName: z.string().default(""),
  erpVersion: z.string().default(""),
  notes: z.string().default(""),
  departments: z.array(departmentSchema).nullable().default([]),
  costCentres: z.array(costCentreSchema).nullable().default([]),
  approvalTiers: z.array(approvalTierSchema).nullable().default([]),
}).strict();
export type CompanyProfile = z.infer<typeof companyProfileSchema>;

export const workflowNodeSchema = z.object({
  id: z.string(),
  label: z.string(),
  type: z.string(),
  icon: z.string().optional(),
  position: z.record(z.string(), z.number()),
  status: z.string(),
  config: jsonObjectSchema,
}).strict();

export const workflowEdgeSchema = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  type: z.string(),
  label: z.string().nullable(),
}).strict();

export const workflowCanvasSchema = z.object({
  workflowId: z.string(),
  nodes: z.array(workflowNodeSchema).nullable(),
  edges: z.array(workflowEdgeSchema).nullable(),
  viewport: jsonObjectSchema.nullable(),
}).strict();
export type WorkflowCanvas = z.infer<typeof workflowCanvasSchema>;

export const workflowYAMLSchema = z.object({
  workflowId: z.string(),
  version: z.number().int(),
  yaml: z.string(),
  checksum: z.string(),
  updatedAt: timestamp,
}).strict();

export const workflowVersionSchema = z.object({
  id: z.string(),
  workflowId: z.string(),
  version: z.number().int(),
  versionNote: z.string(),
  yaml: z.string().optional(),
  createdAt: timestamp,
  createdBy: principalSchema,
}).strict();

export const workflowTemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  category: z.string(),
  tags: z.array(z.string()).nullable(),
  yaml: z.string(),
  steps: z.number().int(),
  createdAt: timestamp,
}).strict();

export const executionFailureSchema = z.object({
  failureCategory: z.string(),
  failedStepId: z.string(),
  failedToolName: z.string(),
  ruleId: z.string().optional(),
  ruleMessage: z.string().optional(),
  blockedParameter: z.string().optional(),
  toolWasCalled: z.boolean(),
}).strict();

export const executionLogSchema = z.object({
  id: z.string(),
  executionId: z.string(),
  timestamp,
  level: z.string(),
  nodeId: z.string(),
  message: z.string(),
  metadata: jsonObjectSchema.nullable(),
}).strict();

export const executionStepSchema = z.object({
  id: z.string(),
  nodeId: z.string(),
  label: z.string(),
  status: z.string(),
  startedAt: timestamp,
  completedAt: timestamp.nullable(),
  durationMs: z.number().int().nullable(),
  failure: executionFailureSchema.optional(),
  sideEffect: z.boolean().optional(),
  output: jsonValueSchema.optional(),
}).strict();

export const notificationPreferencesSchema = z.object({
  executionFailures: z.boolean().default(false),
  healingEvents: z.boolean().default(false),
  budgetWarnings: z.boolean().default(false),
  weeklyReports: z.boolean().default(false),
  channels: z.record(z.string(), z.boolean()).default({}),
}).strict();

export const providerConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  baseUrl: z.string().optional(),
  model: z.string(),
  temperature: z.number(),
  active: z.boolean(),
  createdAt: timestamp,
}).strict();

export const integrationSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  status: z.string(),
  icon: z.string(),
  config: jsonObjectSchema,
  lastTestedAt: timestamp.nullable(),
  createdAt: timestamp,
}).strict();

export const webhookSchema = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string(),
  events: z.array(z.string()).nullable(),
  enabled: z.boolean(),
  secretPreview: z.string(),
  createdAt: timestamp,
}).strict();

export const chatMessageSchema = z.object({
  id: z.string(),
  role: z.string(),
  text: z.string(),
  artifacts: jsonObjectSchema.optional(),
  createdAt: timestamp,
}).strict();

export const chatSessionSchema = z.object({
  id: z.string(),
  ownerId: z.string(),
  title: z.string(),
  createdAt: timestamp,
  updatedAt: timestamp,
  messageCount: z.number().int(),
}).strict();

export const notificationSchema = z.object({
  id: z.string(),
  message: z.string(),
  tone: z.string(),
  type: z.string(),
  read: z.boolean(),
  resource: jsonObjectSchema.nullable(),
  createdAt: timestamp,
}).strict();

export const apiKeySchema = z.object({
  id: z.string(),
  name: z.string(),
  maskedKey: z.string(),
  scopes: z.array(z.string()).nullable(),
  createdAt: timestamp,
  expiresAt: timestamp.nullable(),
}).strict();

export const uploadedFileSchema = z.object({
  id: z.string(),
  name: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int(),
  url: z.string(),
  checksum: z.string(),
  createdAt: timestamp,
}).strict();

export const settingsBundleSchema = z.object({
  general: jsonObjectSchema,
  llm: jsonObjectSchema,
  rbac: jsonObjectSchema,
}).strict();
