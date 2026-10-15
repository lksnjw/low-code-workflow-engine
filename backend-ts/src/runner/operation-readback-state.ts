import { z } from "zod";
import { jsonObjectSchema } from "../models/schemas.js";
import { readbackTaskOutboxSchema } from "./readback-task-outbox.js";

const id = z.string().min(1).max(256), hash = z.string().regex(/^sha256:[a-f0-9]{64}$/), at = z.string().datetime();
export const operationReadbackCommandSchema = z.object({ intentId: id, baseVersion: z.number().int().positive(), factsHash: hash,
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/) }).strict();
export const readbackEvaluationSchema = z.object({ profile: z.literal("operation-readback-evaluation/v1"),
  outcome: z.enum(["APPLIED", "NOT_APPLIED", "UNRESOLVED"]), observedAt: at, settled: z.boolean(),
  evidenceMeaning: z.literal("operation-state"), canResume: z.literal(false), noReplay: z.literal(true), deliveryVerified: z.literal(false) }).strict();
export const operationReadbackJobSchema = z.object({ profile: z.literal("operation-readback-job/v1"), id, executionId: id, intentId: id, nodeId: id,
  erpCredentialSecret: z.object({ profile: z.literal("user-mcp-binding/v1"), actorId: id, revisions: z.record(z.string(), z.number().int().nonnegative()),
    environmentSecret: z.record(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/), z.string().regex(/^[a-f0-9]{64}$/)).optional() }).strict().optional(),
  baseVersion: z.number().int().positive(), factsHash: hash, actorId: id, roleId: id, admittedRole: id, keyHash: hash, requestFingerprint: hash,
  targetId: id, targetHash: hash, connectionBinding: z.string().min(1).max(512), argumentHash: hash,
  admission: z.object({ connectionId: id, capabilityId: id, revisionId: id, admissionVersion: z.number().int().positive(), contractHash: hash }).strict(),
  arguments: jsonObjectSchema, createdAt: at, epoch: z.number().int().positive(),
  taskDispatchSecret: readbackTaskOutboxSchema.optional(),
  state: z.enum(["QUEUED", "RUNNING", "ANSWERED", "FAILED", "CANCELLED", "RECOVERY_REQUIRED"]),
  startedAt: at.optional(), dispatchIntentAt: at.optional(), completedAt: at.optional(),
  lease: z.object({ id, workerId: id, expiresAt: z.number().int().positive() }).strict().optional(),
  cancellation: z.object({ actorId: id, requestedAt: at }).strict().optional(),
  result: z.object({ structuredContent: jsonObjectSchema }).strict().optional(), evaluation: readbackEvaluationSchema.optional(),
  failure: z.enum(["READBACK_BLOCKED_BEFORE_DISPATCH", "READBACK_INTERRUPTED", "READBACK_RESULT_UNQUALIFIED", "READBACK_CANCELLED"]).optional(),
}).strict().superRefine((job, context) => {
  const bad = (message: string) => context.addIssue({ code: "custom", message });
  if (job.admission.contractHash !== job.targetHash) bad("Read-back pin differs from its target");
  if (job.state === "RUNNING" ? !job.lease || !job.startedAt || !!job.completedAt : !!job.lease) bad("Read-back lease/state differs");
  if (["ANSWERED", "FAILED", "CANCELLED", "RECOVERY_REQUIRED"].includes(job.state) !== !!job.completedAt) bad("Read-back completion/state differs");
  if (job.state === "ANSWERED" ? !job.result || !job.evaluation || !job.dispatchIntentAt || !!job.failure : !!job.result || !!job.evaluation) bad("Read-back answer/state differs");
  if (["FAILED", "CANCELLED", "RECOVERY_REQUIRED"].includes(job.state) !== !!job.failure) bad("Read-back failure/state differs");
  if (job.state === "RECOVERY_REQUIRED" && !job.dispatchIntentAt || job.state === "CANCELLED" && (job.dispatchIntentAt || job.failure !== "READBACK_CANCELLED")) bad("Query recovery/cancellation differs from its dispatch evidence");
  if (job.failure === "READBACK_RESULT_UNQUALIFIED" && (job.state !== "FAILED" || !job.dispatchIntentAt)) bad("Unqualified result has no completed query intent");
  if (job.state === "QUEUED" && (job.startedAt || job.dispatchIntentAt || job.cancellation || job.failure)) bad("Queued query has attempt evidence");
  if (job.dispatchIntentAt && (!job.startedAt || Date.parse(job.dispatchIntentAt) < Date.parse(job.startedAt))) bad("Query intent predates its start");
  if (job.startedAt && Date.parse(job.startedAt) < Date.parse(job.createdAt) || job.completedAt && Date.parse(job.completedAt) < Date.parse(job.startedAt ?? job.createdAt)) bad("Query times are inconsistent");
  if (job.completedAt && job.dispatchIntentAt && Date.parse(job.completedAt) < Date.parse(job.dispatchIntentAt) || job.cancellation &&
      (Date.parse(job.cancellation.requestedAt) < Date.parse(job.createdAt) || job.completedAt && Date.parse(job.cancellation.requestedAt) > Date.parse(job.completedAt))) bad("Query completion predates its evidence");
});
export type OperationReadbackJob = z.infer<typeof operationReadbackJobSchema>;
