import { allRolesToolAccess, toolRoleAllowed } from "../governance/tool-access.js";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { canonicalJSONBytes, resolvedParameterHashBytes } from "../core/canonical-json.js";
import { jsonObjectSchema } from "../models/schemas.js";
import { parseWorkflowYAMLStrict, workflowContentHash } from "../parser/workflow.js";
import type { Execution, Repository, RepositoryState } from "../repository/store.js";
import { appendExecutionEvent, assertCurrentRunController } from "./read-checkpoints.js";
import { HandlerFailure, type CurrentUser } from "../http/handlers/common.js";
import { requireResidentExecution } from "./execution-host.js";
import { residentExecutionAllowed } from "./execution-host.js";
import { requireOperationTaskAdmission, completeOperationTaskGeneration, assertOperationTaskLedger, prepareOperationTaskGeneration,
  dispatchOperationTaskOutbox } from "./operation-task-outbox.js";
import { withoutSecretFields } from "../redact/secrets.js";
import { validateToolInput } from "../tools/tool-input-schema.js";
import { capabilityContractHash } from "../registry/capability-admission.js";
import { toolSchema, type ToolDefinition } from "../registry/schemas.js";
import { exactBridgeName } from "../tools/erpbridge-contract.js";
import { resolveReadBinding } from "../workflows/compiled-read.js";
import type { StoredReadCompilation } from "../workflows/read-compilation-lifecycle.js";
import type { StoredOperationCompilation } from "../workflows/operation-compilation-lifecycle.js";
import { assertOperationSelectedNode } from "../workflows/operation-control-flow.js";
import { confirmedProtectedOperationTransition } from "./operation-protected-checkpoints.js";

const id = z.string().min(1).max(256), hash = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const digest = (value: unknown) => resolvedParameterHashBytes(canonicalJSONBytes(value));
function deny(message: string, status = 409): never { throw new HandlerFailure(status, message, { code: "RUNTIME_APPROVAL_DENIED" }); }
export const runtimeApprovalPolicyCommand = z.object({ profile: z.literal("runtime-approval-policy/v1"), baseRevision: z.number().int().nonnegative(),
  enabled: z.boolean(), approverRoleIds: z.array(id).min(1).max(20), ttlSeconds: z.number().int().min(60).max(86400), separationOfDuties: z.literal(true) }).strict();
const policySchema = runtimeApprovalPolicyCommand.omit({ baseRevision: true }).extend({ revision: z.number().int().positive() }).strict();
export type RuntimeApprovalPolicy = z.infer<typeof policySchema>;
const bindingSchema = z.object({ executionId: id, workflowId: id, nodeId: id, invocationId: id, operationKey: id,
  sourceHash: hash, semanticHash: hash, connectionId: id, connectionBinding: z.string().regex(/^[a-f0-9]{64}$/), capabilityId: id,
  capabilityRevision: id, admissionVersion: z.number().int().positive(), contractHash: hash, argumentHash: hash,
  requesterId: id, requesterRoleId: id, workerEpoch: z.number().int().positive(), policyHash: hash }).strict();
export type RuntimeApprovalBinding = z.infer<typeof bindingSchema>;
const recordSchema = z.object({ id, profile: z.literal("runtime-approval/v1"), version: z.number().int().positive(),
  state: z.enum(["PENDING", "APPROVED", "REJECTED", "CONSUMED"]), binding: bindingSchema, arguments: jsonObjectSchema,
  reason: z.string().trim().min(1).max(2000), requestedAt: z.string().datetime(), expiresAt: z.string().datetime(), reviewHash: hash,
  decision: z.object({ actorId: id, roleId: id, decisionKey: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/), fingerprint: hash,
    outcome: z.enum(["APPROVED", "REJECTED"]), note: z.string().max(2000), decidedAt: z.string().datetime() }).strict().optional(),
  consumption: z.object({ intentId: id, consumedAt: z.string().datetime() }).strict().optional() }).strict();
export type RuntimeApprovalRecord = z.infer<typeof recordSchema>;
export type RuntimeApprovalLedger = { profile: "runtime-approvals/v1"; activeId: string; records: Record<string, RuntimeApprovalRecord> };
export const runtimeApprovalDecisionSchema = z.object({ approvalId: id, baseVersion: z.number().int().positive(), reviewHash: hash,
  decisionKey: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/), note: z.string().max(2000).default("") }).strict();
export type RuntimeApprovalDecision = z.infer<typeof runtimeApprovalDecisionSchema>;
function requireApprovalStorage(repository: Repository): void {
  if (repository.persistence !== null && (repository.persistence.readQueueDurability !== "encrypted-single-writer" ||
      repository.persistence.executionCheckpointDurability !== "encrypted-record-transactions/v1" || !repository.persistence.saveExecutionCheckpoint))
    deny("Runtime approvals require qualified encrypted scoped transactions; legacy durable storage cannot authorize decisions", 503);
  repository.assertAuthority();
}

/** Called only by the authenticated settings command, including bundle PATCH.
 * This policy is mandatory and independent of the advisory enabled toggle. */
export function updateRuntimeApprovalPolicy(state: RepositoryState, user: CurrentUser, raw: unknown): RuntimeApprovalPolicy {
  const parsed = runtimeApprovalPolicyCommand.safeParse(raw);
  if (!parsed.success) deny("Invalid exact runtime approval policy command", 422);
  const actor = state.users[user.id], role = actor && state.roles[actor.roleId];
  if (!actor || actor.status.toLowerCase() !== "active" || role?.name !== user.role || role.name !== "Platform Admin" ||
      ![...role.permissions, ...actor.permissionOverrides].includes("settings:manage")) deny("Current Platform Admin settings authority is required", 403);
  const old = (state.settings.rbac as Record<string, unknown> | undefined)?.runtimeApprovalPolicy;
  const previous = old === undefined ? null : policySchema.safeParse(old);
  if (previous && !previous.success) deny("Stored runtime approval policy requires repair");
  const revision = previous?.success ? previous.data.revision : 0;
  if (parsed.data.baseRevision !== revision) deny("Runtime approval policy changed; reload before updating");
  if (new Set(parsed.data.approverRoleIds).size !== parsed.data.approverRoleIds.length || parsed.data.approverRoleIds.some(key => !state.roles[key]?.permissions.includes("execution:approve")))
    deny("Approver roles must be distinct existing roles with explicit execution:approve authority", 422);
  const { baseRevision: _base, ...config } = parsed.data;
  const policy = { ...config, revision: revision + 1 };
  state.settings.rbac = { ...(state.settings.rbac as Record<string, unknown> ?? {}), runtimeApprovalPolicy: policy };
  state.auditLogs.push({ id: `approval-policy-${randomBytes(8).toString("hex")}`, actor: { id: actor.id, name: actor.name }, action: "runtime_approval.policy_changed",
    resource: { type: "runtime-approval-policy", id: "workspace" }, before: previous?.success ? { revision } : null, after: { revision: policy.revision, hash: digest(policy), enabled: policy.enabled }, createdAt: new Date().toISOString() });
  return policy;
}
/** Code-owned exception for the canonical administrator, never a model-supplied
 * role label or permission override. This permits an explicit exact decision,
 * not automatic approval, ERP access or retry authority. */
function superAdministrator(state: Readonly<RepositoryState>, actorId?: string): boolean {
  const actor = actorId ? state.users[actorId] : undefined, role = actor && state.roles[actor.roleId];
  if (allRolesToolAccess() && (state.settings.rbac as Record<string, unknown> | undefined)?.runtimeApprovalPolicy === undefined)
    return !!actor && actor.status.toLowerCase() === "active" && !!role && role.permissions.includes("execution:approve");
  return !!actor && actor.status.toLowerCase() === "active" && actor.roleId === "role_admin" && role?.id === "role_admin" &&
    role.name === "Platform Admin" && role.permissions.includes("execution:approve");
}
function currentPolicy(state: Readonly<RepositoryState>, requesterId?: string): RuntimeApprovalPolicy {
  const raw = (state.settings.rbac as Record<string, unknown> | undefined)?.runtimeApprovalPolicy;
  // An absent workspace policy must not prevent the canonical Super Admin
  // reviewing their own transaction. Do not persist a global reviewer grant;
  // a disabled or malformed saved policy still fails closed for everyone.
  if (raw === undefined && superAdministrator(state, requesterId)) return { profile: "runtime-approval-policy/v1", enabled: true,
    approverRoleIds: ["role_admin"], ttlSeconds: 900, separationOfDuties: true, revision: 1 };
  const policy = policySchema.safeParse(raw);
  if (!policy.success || !policy.data.enabled) deny("A current enabled exact runtime approval policy is required", 503);
  return policy.data;
}
export const runtimeApprovalPolicyHash = (state: Readonly<RepositoryState>, requesterId?: string) => {
  const policy = currentPolicy(state, requesterId);
  return digest(superAdministrator(state, requesterId) ? { policy, selfApprovalProfile: allRolesToolAccess() ? "shared-workflow-exact/v1" : "super-administrator-exact/v1" } : policy);
};
/** Minimum settings projection. Role discovery never grants role permissions. */
export function runtimeApprovalAdministration(state: Readonly<RepositoryState>, user: CurrentUser) {
  const actor = state.users[user.id], role = actor && state.roles[actor.roleId];
  if (!actor || actor.status.toLowerCase() !== "active" || !role || role.name !== user.role ||
      ![...role.permissions, ...actor.permissionOverrides].includes("settings:manage")) deny("Current settings authority is required", 403);
  const raw = (state.settings.rbac as Record<string, unknown> | undefined)?.runtimeApprovalPolicy;
  const parsed = raw === undefined ? null : policySchema.safeParse(raw);
  if (parsed && !parsed.success) deny("Stored runtime approval policy requires repair; no editable default is assumed");
  const policy = parsed?.success ? parsed.data : null;
  const selected = new Set(policy?.approverRoleIds ?? []);
  const roleIds = [...new Set([...Object.keys(state.roles).filter(key => state.roles[key]!.permissions.includes("execution:approve")), ...selected])];
  if (roleIds.length > 1000 || roleIds.some(key => !id.safeParse(key).success)) deny("Reviewer role metadata exceeds supported bounds");
  const roles = roleIds.map(key => ({ id: key, name: state.roles[key]?.name.slice(0, 200) || "Unavailable reviewer role",
    eligible: !!state.roles[key]?.permissions.includes("execution:approve") }));
  roles.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return { profile: "runtime-approval-administration/v1" as const, policy, revision: policy?.revision ?? 0, roles,
    canManage: role.name === "Platform Admin", asOf: new Date().toISOString(), canExecute: false as const };
}
function reviewArguments(args: Record<string, unknown>): Record<string, unknown> {
  let count = 0;
  const walk = (value: unknown, depth: number): void => {
    if (++count > 10000 || depth > 16) deny("Approval arguments exceed supported bounds", 422);
    if (value === null || ["string", "boolean"].includes(typeof value) || typeof value === "number" && Number.isFinite(value)) return;
    if (Array.isArray(value)) { value.forEach(item => walk(item, depth + 1)); return; }
    if (!value || typeof value !== "object" || Object.keys(value).some(key => ["__proto__", "constructor", "prototype"].includes(key))) deny("Approval arguments must be finite, reference-safe JSON", 422);
    Object.values(value).forEach(item => walk(item, depth + 1));
  };
  walk(args, 0);
  const captured = jsonObjectSchema.parse(structuredClone(args)), bytes = canonicalJSONBytes(captured);
  if (bytes.length > 64000 || !bytes.equals(canonicalJSONBytes(withoutSecretFields(captured)))) deny("Approval must expose complete bounded business arguments, not hidden credential fields", 422);
  return captured;
}
function ledger(execution: Execution): RuntimeApprovalLedger {
  const value = execution.runtimeApprovalSecret;
  if (!value || value.profile !== "runtime-approvals/v1" || !value.activeId || !value.records || Object.keys(value).some(key => !["profile", "activeId", "records"].includes(key)) || Object.keys(value.records).length > 1000)
    deny("This execution has no exact runtime approval journal");
  return value;
}
function reviewHash(record: Pick<RuntimeApprovalRecord, "id" | "binding" | "arguments" | "reason" | "requestedAt" | "expiresAt">) {
  return digest({ id: record.id, binding: record.binding, arguments: record.arguments, reason: record.reason, requestedAt: record.requestedAt, expiresAt: record.expiresAt });
}
export function runtimeApprovalEvidence(execution: Execution, approvalId: string): RuntimeApprovalRecord {
  const journal = ledger(execution), parsed = recordSchema.safeParse(journal.records[approvalId]);
  if (!parsed.success || parsed.data.id !== approvalId) deny("Stored runtime approval is malformed");
  const record = parsed.data;
  if (record.reviewHash !== reviewHash(record) || record.binding.argumentHash !== digest(record.arguments) ||
      (record.state === "PENDING" ? !!record.decision || !!record.consumption : !record.decision || record.decision.outcome !== (record.state === "REJECTED" ? "REJECTED" : "APPROVED")) ||
      (record.state === "CONSUMED") !== !!record.consumption) deny("Stored runtime approval evidence is inconsistent");
  return record;
}
function active(execution: Execution): RuntimeApprovalRecord { return runtimeApprovalEvidence(execution, ledger(execution).activeId); }
/** Discovery scope only. Never authorizes a decision or exposes its arguments. */
export function runtimeApprovalInboxAuthority(state: Readonly<RepositoryState>, actorId: string): boolean {
  const actor = state.users[actorId], role = actor && state.roles[actor.roleId];
  const policy = policySchema.safeParse((state.settings.rbac as Record<string, unknown> | undefined)?.runtimeApprovalPolicy);
  const raw = (state.settings.rbac as Record<string, unknown> | undefined)?.runtimeApprovalPolicy;
  if (superAdministrator(state, actorId) && (raw === undefined || policy.success && policy.data.enabled)) return true;
  return !!actor && actor.status.toLowerCase() === "active" && !!role && policy.success && policy.data.enabled &&
    policy.data.approverRoleIds.includes(role.id) && [...role.permissions, ...actor.permissionOverrides].includes("execution:approve");
}
function approver(state: Readonly<RepositoryState>, record: RuntimeApprovalRecord, actorId: string) {
  const actor = state.users[actorId], role = actor && state.roles[actor.roleId], policy = currentPolicy(state, record.binding.requesterId);
  const ownAdministratorDecision = actorId === record.binding.requesterId && superAdministrator(state, actorId);
  const scopedFallback = (state.settings.rbac as Record<string, unknown> | undefined)?.runtimeApprovalPolicy === undefined;
  if (!actor || actor.status.toLowerCase() !== "active" || !role || !ownAdministratorDecision && (scopedFallback || actorId === record.binding.requesterId ||
      !policy.approverRoleIds.includes(role.id)) || ![...role.permissions, ...actor.permissionOverrides].includes("execution:approve")) deny("An independent transaction reviewer or the requesting Super Admin is required", 403);
  return { actor, role };
}
function assertBinding(state: RepositoryState, execution: Execution, record: RuntimeApprovalRecord, now: number, consumedIntent = false) {
  const b = record.binding, snapshot = execution.workflowSnapshot, requester = state.users[b.requesterId];
  const receipt = snapshot?.operationCompilation ?? snapshot?.compilation;
  const attempt = execution.readProgress?.attempts[b.nodeId];
  if (execution.id !== b.executionId || execution.workflowId !== b.workflowId || execution.startedBy.id !== b.requesterId || execution.completedAt !== null ||
      !snapshot || snapshot.contentHash !== b.sourceHash || workflowContentHash(snapshot.yaml) !== b.sourceHash || receipt?.semanticHash !== b.semanticHash ||
      receipt.sourceHash !== b.sourceHash || execution.readProgress?.epoch !== b.workerEpoch || execution.readProgress.cancellation ||
      !requester || requester.roleId !== b.requesterRoleId || !attempt || attempt.id !== b.invocationId || attempt.status !== (consumedIntent ? "DISPATCH_INTENT" : "PREPARING") ||
      (consumedIntent ? !attempt.dispatchIntentAt : attempt.dispatchIntentAt !== undefined) || attempt.completedAt !== undefined || execution.readProgress.nextStepIndex !== attempt.stepIndex || attempt.nodeId !== b.nodeId)
    deny("Approval execution, source, invocation or requester changed");
  try { assertCurrentRunController(state, execution, b.requesterId, state.roles[b.requesterRoleId]?.name); } catch { deny("Requester execution authority changed", 403); }
  const publication = (state.versions[b.workflowId] ?? []).findLast(version => version.version === snapshot.version && version.artifactState === "PUBLISHED");
  const compiled = (snapshot.executionProfile === "sequential-operation-v1" ? publication?.compiledOperation : publication?.compiledRead) as StoredReadCompilation | StoredOperationCompilation | undefined;
  const step = parseWorkflowYAMLStrict(snapshot.yaml).steps[attempt.stepIndex];
  if (!publication || publication.yaml !== snapshot.yaml || compiled?.receipt?.semanticHash !== b.semanticHash || compiled.receipt.sourceHash !== b.sourceHash || step?.id !== b.nodeId) deny("Approval is not bound to an immutable published node");
  const node = compiled.plan?.ir.root.nodes[attempt.stepIndex];
  if (snapshot.executionProfile === "sequential-operation-v1") {
    try {
      const plan = (compiled as StoredOperationCompilation).plan;
      if (plan.ir.schemaVersion === "workflow-operation-ir/v8") confirmedProtectedOperationTransition(state, execution, plan);
      assertOperationSelectedNode(plan, execution.readProgress!, b.nodeId, execution.operationSecret?.protectedScopes);
    }
    catch { deny("Approval node is not on the exact confirmed decision path"); }
  }
  if (!node || node.kind !== "action") deny("Approval is only valid for a compiled tool invocation");
  const pin = node.capability.admission;
  if (compiled.plan.sourceHash !== b.sourceHash || compiled.plan.semanticHash !== b.semanticHash || digest(compiled.plan.ir) !== b.semanticHash || node.id !== b.nodeId ||
      node.capability.contractHash !== b.contractHash || !pin || pin.capabilityId !== b.capabilityId || pin.revisionId !== b.capabilityRevision ||
      pin.connectionId !== b.connectionId || pin.admissionVersion !== b.admissionVersion || pin.contractHash !== b.contractHash || compiled.verifiedRole !== state.roles[b.requesterRoleId]!.name ||
      compiled.plan.ir.schemaVersion === "workflow-read-ir/v4") deny("Approval compiled invocation or pinned capability changed; collection approval waits require their own journal adapter");
  let resolved;
  try { resolved = resolveReadBinding(node.inputs, { ...(execution.stepOutputs ?? {}), ...(execution.valueOutputs ?? {}), input: snapshot.input }); }
  catch { deny("Approval arguments cannot be resolved from the pinned current checkpoint"); }
  if (!canonicalJSONBytes(resolved).equals(canonicalJSONBytes(record.arguments))) deny("Resolved transaction facts changed; request a new exact approval");
  const admission = state.capabilityAdmissions[b.capabilityId], revision = state.capabilityRevisions[b.capabilityRevision];
  if (!admission || admission.state !== "AVAILABLE" || admission.revisionId !== b.capabilityRevision || admission.version !== b.admissionVersion ||
      !revision || revision.capabilityId !== b.capabilityId || revision.connectionId !== b.connectionId || revision.connectionBinding !== b.connectionBinding || revision.contractHash !== b.contractHash ||
      !revision.definition || capabilityContractHash(revision.definition as ToolDefinition) !== b.contractHash ||
      !toolRoleAllowed((revision.definition as ToolDefinition).allowed_roles, state.roles[b.requesterRoleId]!.name) ||
      ![(revision.definition as ToolDefinition).name, (revision.definition as ToolDefinition).mcp_tool_name].includes(step.action ?? "") ||
      validateToolInput((revision.definition as Record<string, unknown>).input_schema, record.arguments).length) deny("Approval capability revision, availability or arguments changed");
  if (runtimeApprovalPolicyHash(state, b.requesterId) !== b.policyHash) deny("Approval policy changed; a new exact review is required");
  if (!Number.isFinite(now) || now < Date.parse(record.requestedAt) || now >= Date.parse(record.expiresAt)) deny("Runtime approval expired or its clock is invalid");
}
function event(state: RepositoryState, execution: Execution, record: RuntimeApprovalRecord, type: string) {
  const timestamp = new Date().toISOString();
  appendExecutionEvent(state, execution, type, { approvalId: record.id, version: record.version, state: record.state, reviewHash: record.reviewHash }, record.binding.nodeId, record.binding.invocationId);
  state.auditLogs.push({ id: `runtime-approval-${randomBytes(8).toString("hex")}`, action: type, actor: { id: record.decision?.actorId ?? record.binding.requesterId },
    resource: { type: "execution", id: execution.id }, after: { approvalId: record.id, state: record.state, reviewHash: record.reviewHash }, createdAt: timestamp });
}
/** Server-only checkpoint producer. No HTTP/model request can supply a binding
 * or replace the review payload. Operation workers produce these waits;
 * read-only workers do not acquire effect authority. */
export async function requestRuntimeApproval(repository: Repository, executionId: string, binding: RuntimeApprovalBinding, args: Record<string, unknown>, reason: string): Promise<string> {
  requireApprovalStorage(repository);
  const captured = bindingSchema.parse(structuredClone(binding)), capturedArgs = reviewArguments(args);
  return repository.mutateExecution(executionId, state => {
    const execution = state.executions[executionId];
    if (!execution || execution.status !== "RUNNING") deny("Only a current running checkpoint may request approval");
    const previous = execution.runtimeApprovalSecret;
    if (previous && active(execution).state !== "CONSUMED") deny("A prior approval still owns this checkpoint");
    if (previous && (Object.keys(previous.records).length >= 1000 || Object.values(previous.records).some(record => record.binding.operationKey === captured.operationKey || record.binding.invocationId === captured.invocationId))) deny("Approval operation or invocation cannot be reused");
    const requestedAt = new Date().toISOString(), policy = currentPolicy(state, captured.requesterId), approvalId = `approval-${randomBytes(16).toString("hex")}`;
    const record = recordSchema.parse({ id: approvalId, profile: "runtime-approval/v1", version: 1, state: "PENDING", binding: captured,
      arguments: capturedArgs, reason, requestedAt, expiresAt: new Date(Date.parse(requestedAt) + policy.ttlSeconds * 1000).toISOString(), reviewHash: digest({}) });
    record.reviewHash = reviewHash(record); assertBinding(state, execution, record, Date.now());
    execution.runtimeApprovalSecret = { profile: "runtime-approvals/v1", activeId: approvalId, records: { ...(previous?.records ?? {}), [approvalId]: record } };
    execution.status = "AWAITING_APPROVAL";
    if (execution.workflowSnapshot?.executionProfile === "sequential-operation-v1" && execution.operationSecret?.profile === "operation-job/v1") {
      execution.operationSecret.state = "WAITING"; delete execution.operationSecret.lease;
    }
    execution.pendingApproval = { stepId: captured.nodeId, description: reason, requestedAt };
    const entry = state.timelines[executionId]?.find(item => item.attemptId === captured.invocationId);
    if (entry) { entry.status = "AWAITING_APPROVAL"; entry.phase = "PREPARING"; }
    execution.agentSummary = superAdministrator(state, captured.requesterId)
      ? "Waiting for explicit confirmation of the exact transaction. The requesting Super Admin may confirm it. Nothing has been dispatched by this checkpoint."
      : "Waiting for an independent decision on exact transaction details. Nothing has been dispatched by this approval checkpoint.";
    event(state, execution, record, "approval.requested"); return approvalId;
  });
}
export async function decideRuntimeApproval(repository: Repository, executionId: string, user: CurrentUser, raw: unknown, outcome: "APPROVED" | "REJECTED") {
  if (outcome === "APPROVED") requireOperationTaskAdmission(repository);
  requireApprovalStorage(repository);
  const parsed = runtimeApprovalDecisionSchema.safeParse(raw);
  if (!parsed.success) deny("Approval requires the exact review ID, version, hash and decision key", 422);
  const command = parsed.data, fingerprint = digest({ ...command, outcome, actorId: user.id });
  try { const decision = await repository.mutateExecution(executionId, state => {
    const execution = state.executions[executionId];
    if (!execution) deny("Approval execution not found", 404);
    const record = active(execution), { actor, role } = approver(state, record, user.id);
    if (role.name !== user.role || !user.permissions.includes("execution:approve")) deny("Request approver authority changed", 403);
    if (record.id !== command.approvalId || record.reviewHash !== command.reviewHash) deny("Approval review changed; reload the exact transaction");
    if (record.decision) {
      if (record.decision.actorId === actor.id && record.decision.roleId === role.id && record.decision.decisionKey === command.decisionKey && record.decision.fingerprint === fingerprint)
        return { replayed: true, approvalId: record.id, state: record.state, version: record.version, executionId, executionStatus: execution.status, canResume: false,
          operationManaged: execution.workflowSnapshot?.executionProfile === "sequential-operation-v1", resumeQueued: execution.operationSecret?.state === "QUEUED" };
      deny("This approval already has a different decision");
    }
    assertBinding(state, execution, record, Date.now());
    if (execution.status !== "AWAITING_APPROVAL" || record.state !== "PENDING" || command.baseVersion !== record.version) deny("Approval checkpoint changed; reload before deciding");
    if (!residentExecutionAllowed(repository) && execution.operationSecret?.taskDispatchSecret) {
      const generation = assertOperationTaskLedger(execution).generations.at(-1)!;
      completeOperationTaskGeneration(state, execution, { profile: "operation-task-delivery/v1", executionId, taskId: generation.taskId });
    } else if (!residentExecutionAllowed(repository) && outcome === "APPROVED") requireResidentExecution(repository);
    record.version++; record.state = outcome;
    record.decision = { actorId: actor.id, roleId: role.id, decisionKey: command.decisionKey, fingerprint, outcome, note: command.note, decidedAt: new Date().toISOString() };
    ledger(execution).records[record.id] = record;
    const resumeQueued = outcome === "APPROVED" && execution.workflowSnapshot?.executionProfile === "sequential-operation-v1" && execution.operationSecret?.profile === "operation-job/v1" && execution.operationSecret.state === "WAITING";
    execution.status = outcome === "APPROVED" ? resumeQueued ? "PENDING" : "BLOCKED" : "FAILED";
    if (execution.operationSecret) { execution.operationSecret.state = resumeQueued ? "QUEUED" : outcome === "REJECTED" ? "FINISHED" : execution.operationSecret.state; delete execution.operationSecret.lease; }
    if (outcome === "REJECTED") { execution.completedAt = record.decision.decidedAt; execution.durationMs = Math.max(0, Date.parse(execution.completedAt) - Date.parse(execution.startedAt)); }
    const attempt = execution.readProgress!.attempts[record.binding.nodeId]!;
    const entry = state.timelines[executionId]?.find(item => item.attemptId === attempt.id);
    if (outcome === "REJECTED") {
      attempt.status = "FAILED"; attempt.completedAt = record.decision.decidedAt;
      execution.failure = { failureCategory: "RUNTIME_APPROVAL_REJECTED", failedStepId: record.binding.nodeId };
      if (entry) Object.assign(entry, { status: "FAILED", outcome: "NOT_DISPATCHED", completedAt: record.decision.decidedAt });
      appendExecutionEvent(state, execution, "node.not_dispatched", { status: "FAILED", outcome: "NOT_DISPATCHED" }, attempt.nodeId, attempt.id);
    } else if (resumeQueued && entry) { entry.status = "RUNNING"; entry.phase = "PREPARING"; }
    delete execution.pendingApproval;
    execution.agentSummary = outcome === "APPROVED" ? resumeQueued ? "Exact approval recorded and the operation is queued for fresh authorization. Approval is not confirmation of execution or delivery." : "Exact approval recorded. Safe effect resume/outbox dispatch is not connected yet; no ERP action or email was sent." : "Transaction rejected. This approval checkpoint did not dispatch its operation.";
    event(state, execution, record, outcome === "APPROVED" ? "approval.granted" : "approval.rejected");
    if (resumeQueued && !residentExecutionAllowed(repository)) prepareOperationTaskGeneration(execution);
    return { replayed: false, approvalId: record.id, state: record.state, version: record.version, executionId, executionStatus: execution.status, canResume: false, resumeQueued,
      operationManaged: execution.workflowSnapshot?.executionProfile === "sequential-operation-v1" };
  });
    if (outcome === "APPROVED" && decision.operationManaged && !residentExecutionAllowed(repository)) return { ...decision,
      taskDispatch: await dispatchOperationTaskOutbox(repository, executionId) };
    return decision;
  } catch (error) {
    if (error instanceof HandlerFailure) throw error;
    throw new HandlerFailure(503, "Approval acknowledgement is unconfirmed. Reload authoritative storage before another decision; do not automatically retry.", { code: "RUNTIME_APPROVAL_SAVE_UNCONFIRMED" });
  }
}
/** Pure transition inside the operation worker's atomic dispatch-intent transaction.
 * Consuming a decision is not a capability, lease, job or SDK authorization. */
export function consumeRuntimeApproval(state: RepositoryState, executionId: string, expected: RuntimeApprovalBinding, args: Record<string, unknown>, intentId: string): void {
  const execution = state.executions[executionId]; if (!execution) deny("Approval execution not found");
  const record = active(execution);
  const operation = execution.workflowSnapshot?.executionProfile === "sequential-operation-v1" && execution.operationSecret?.profile === "operation-job/v1" && execution.operationSecret.state === "CLAIMED";
  if (!(execution.status === "BLOCKED" || operation && execution.status === "RUNNING") || record.state !== "APPROVED" || !canonicalJSONBytes(bindingSchema.parse(expected)).equals(canonicalJSONBytes(record.binding)) ||
      !canonicalJSONBytes(args).equals(canonicalJSONBytes(record.arguments)) || !id.safeParse(intentId).success) deny("Approval cannot authorize a changed or repeated operation");
  assertBinding(state, execution, record, Date.now());
  const decision = record.decision!, current = approver(state, record, decision.actorId);
  if (current.role.id !== decision.roleId) deny("Approver authority changed since the decision");
  record.state = "CONSUMED"; record.version++; record.consumption = { intentId, consumedAt: new Date().toISOString() };
  ledger(execution).records[record.id] = record; event(state, execution, record, "approval.consumed");
}
/** Fresh denial-only proof at operation SDK entry. A consumed decision alone
 * cannot authorize another intent, changed facts or a revoked approver. */
export function assertConsumedRuntimeApproval(state: RepositoryState, executionId: string, intentId: string): void {
  const execution = state.executions[executionId];
  if (!execution || execution.status !== "RUNNING" || execution.workflowSnapshot?.executionProfile !== "sequential-operation-v1") deny("Operation is not current");
  const record = active(execution), intent = execution.operationSecret?.intents[record.binding.nodeId];
  if (record.state !== "CONSUMED" || record.consumption?.intentId !== intentId || intent?.id !== intentId || intent.state !== "DISPATCH_INTENT" ||
      intent.approvalId !== record.id || intent.operationKey !== record.binding.operationKey || intent.argumentHash !== record.binding.argumentHash) deny("Exact consumed approval does not own this operation intent");
  assertBinding(state, execution, record, Date.now(), true);
  if (approver(state, record, record.decision!.actorId).role.id !== record.decision!.roleId) deny("Approver authority changed");
}
/** Minimum review projection. The private journal is excluded by the common
 * secret redactor on every existing execution/trace/chat serialization path. */
export function runtimeApprovalView(state: RepositoryState, executionId: string, actorId: string, approvalId?: string) {
  if (!runtimeApprovalInboxAuthority(state, actorId)) deny("Current independent transaction approver authority is required", 403);
  const execution = state.executions[executionId]; if (!execution) deny("Approval execution not found", 404);
  const record = approvalId ? runtimeApprovalEvidence(execution, approvalId) : active(execution); const { role } = approver(state, record, actorId);
  const definition = toolSchema.safeParse(state.capabilityRevisions[record.binding.capabilityRevision]?.definition);
  let unavailable: string | null = null;
  // Completed decisions are historical evidence, not new dispatch authority.
  // Their expected consumed/completed invocation must not masquerade as drift.
  // The decision and SDK-entry paths still enforce all current binding checks.
  if (["PENDING", "APPROVED"].includes(record.state)) {
    if (execution.completedAt !== null) unavailable = execution.failure?.failureCategory === "RUNTIME_APPROVAL_EXPIRED"
      ? "Approval expired before dispatch. This checkpoint is closed." : "This execution checkpoint is closed; the approval cannot authorize another operation.";
    else try { assertBinding(state, execution, record, Date.now()); } catch (error) { unavailable = error instanceof Error ? error.message : "Approval context is unavailable"; }
  }
  return { id: execution.id, workflowId: execution.workflowId, workflowName: execution.workflowName, status: execution.status,
    runtimeApproval: { profile: record.profile, id: record.id, version: record.version, state: record.state, reviewHash: record.reviewHash,
      nodeId: record.binding.nodeId, invocationId: record.binding.invocationId, connectionId: record.binding.connectionId, capabilityRevision: record.binding.capabilityRevision,
      toolName: definition.success ? definition.data.name : null, remoteToolName: definition.success ? exactBridgeName(definition.data) : null,
      sourceHash: record.binding.sourceHash, semanticHash: record.binding.semanticHash, reason: record.reason, requestedAt: record.requestedAt, expiresAt: record.expiresAt,
      requesterId: record.binding.requesterId, selfApprovalAllowed: actorId === record.binding.requesterId && superAdministrator(state, actorId),
      arguments: withoutSecretFields(record.arguments), canDecide: !unavailable && record.id === execution.runtimeApprovalSecret!.activeId && execution.status === "AWAITING_APPROVAL" && record.state === "PENDING",
      operationManaged: execution.workflowSnapshot?.executionProfile === "sequential-operation-v1",
      unavailable, approverRole: role.name, decision: record.decision ? { outcome: record.decision.outcome, actorId: record.decision.actorId, decidedAt: record.decision.decidedAt } : null,
      canResume: false, resumeReason: execution.workflowSnapshot?.executionProfile === "sequential-operation-v1" ? "An approved operation is queued automatically for fresh authorization. This decision is not execution or delivery confirmation." : "Safe effect resume/outbox dispatch is not connected yet. Approval alone does not execute or send." } };
}
