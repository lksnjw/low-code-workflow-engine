import { toolRoleAllowed } from "../governance/tool-access.js";
import { createHash, randomBytes } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { stringify } from "yaml";
import { z } from "zod";
import { canonicalJSONBytes } from "../core/canonical-json.js";
import { HandlerFailure, isRecord, nextID, type CurrentUser, type HandlerServices } from "../http/handlers/common.js";
import type { Workflow } from "../models/schemas.js";
import { capabilityContractHash, supportedOperation } from "../registry/capability-admission.js";
import type { ToolDefinition } from "../registry/schemas.js";
import type { EmailDeliveryAdmission, Execution, RepositoryState } from "../repository/store.js";
import { appendExecutionEvent, assertCurrentRunController, newReadProgress } from "../runner/read-checkpoints.js";
import { operationJobQueue } from "../runner/operation-jobs.js";
import { requireResidentExecution } from "../runner/execution-host.js";
import { runtimeApprovalPolicyHash } from "../runner/runtime-approvals.js";
import { resolveReadBinding } from "../workflows/compiled-read.js";
import { assertOperationPublicationCurrent, prepareOperationPublication } from "../workflows/operation-compilation-lifecycle.js";
import { emailDraftHash, type EmailDraft } from "./email-draft.js";
import { recipientResolutionIsCurrent } from "./recipient-resolution.js";

const id = z.string().min(1).max(128);
const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const sourceSchema = z.object({ profile: z.literal("email-delivery-source/v1"), admissionId: id, sessionId: id, draftId: id,
  draftVersion: z.number().int().positive(), draftHash: hash }).strict();
const admissionSchema = z.object({ profile: z.literal("email-delivery-admission-private/v1"), id, sessionId: id, draftId: id,
  draftVersion: z.number().int().positive(), draftHash: hash, actorId: id, toolId: id, contractHash: hash, keyHash: hash,
  requestFingerprint: hash, workflowId: id, executionId: id, createdAt: z.string().datetime() }).strict();
export const emailDeliveryCommandSchema = z.object({
  profile: z.literal("email-delivery-admission-command/v1"),
  draftId: id,
  baseVersion: z.number().int().positive(),
  baseHash: hash,
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
  sharingConfirmed: z.literal(true),
}).strict();

const digest = (value: unknown) => `sha256:${createHash("sha256").update(canonicalJSONBytes(value)).digest("hex")}`;
function deny(message: string, status = 409, code = "EMAIL_DELIVERY_ADMISSION_DENIED"): never {
  throw new HandlerFailure(status, message, { code });
}
function requireStorage(services: HandlerServices): void {
  const storage = services.repository.persistence;
  if (storage && (storage.readQueueDurability !== "encrypted-single-writer" || storage.executionCheckpointDurability !== "encrypted-record-transactions/v1" || !storage.saveExecutionCheckpoint))
    deny("Email delivery requires qualified encrypted durable operation checkpoints", 503, "EMAIL_DELIVERY_STORAGE_UNSUPPORTED");
  services.repository.assertAuthority();
}
function currentActor(state: Readonly<RepositoryState>, user: CurrentUser) {
  const actor = state.users[user.id], role = actor && state.roles[actor.roleId];
  const permissions = actor ? [...(role?.permissions ?? []), ...actor.permissionOverrides] : [];
  if (!actor || !role || actor.status.toLowerCase() !== "active" || role.name !== user.role ||
      (!permissions.includes("workflow:run") && !permissions.includes("workflow:run_own")) || !permissions.includes("chat:use"))
    deny("Current chat and workflow-run authority is required", 403);
  return { actor, role };
}
function latestDraft(state: Readonly<RepositoryState>, sessionId: string, draftId: string, user: CurrentUser): EmailDraft {
  const chat = state.chats[sessionId];
  currentActor(state, user);
  if (!chat || chat.ownerId !== user.id) deny("Chat session not found", 404);
  const message = [...chat.messages].reverse().find(item => isRecord(item.artifacts) && isRecord(item.artifacts.emailDraft) && item.artifacts.emailDraft.id === draftId);
  const draft = message && isRecord(message.artifacts) ? message.artifacts.emailDraft as EmailDraft : undefined;
  if (!draft || draft.profile !== "email-draft-v1" || draft.ownerId !== user.id || draft.sessionId !== sessionId || draft.state !== "DRAFT_NOT_SENT" || emailDraftHash(draft) !== draft.contentHash)
    deny("The exact authoritative email draft is unavailable", 404);
  return draft;
}
function requireCurrentRecipientResolution(state: Readonly<RepositoryState>, draft: EmailDraft, actorId: string): void {
  const resolution = draft.recipientResolution;
  if (resolution?.status === "RESOLVED" && !recipientResolutionIsCurrent(state, actorId, resolution))
    deny("The directory recipient changed or is no longer active. Create a new draft or explicitly confirm a current address", 409, "EMAIL_RECIPIENT_STALE");
}
function binding(tool: ToolDefinition, draft: EmailDraft): Record<string, string> {
  try { supportedOperation(tool); } catch { deny("The email connector does not have a supported reviewed operation contract", 422); }
  const contract = tool.email_delivery_contract;
  if (!contract || tool.operation_contract?.effect_class !== "notification" || tool.operation_contract.retry_policy !== "never")
    deny("The connector lacks an explicit notification email binding", 422);
  const schema = tool.input_schema, properties = isRecord(schema.properties) ? schema.properties : {};
  const names = [contract.recipient_parameter, contract.subject_parameter, contract.body_parameter];
  const required = Array.isArray(schema.required) ? schema.required : [];
  if (required.some(value => typeof value !== "string" || !names.includes(value)) || names.some(name => !required.includes(name) || !isRecord(properties[name]) || properties[name].type !== "string"))
    deny("The connector email binding does not match its required string input schema", 422);
  return { [contract.recipient_parameter]: draft.to, [contract.subject_parameter]: draft.subject, [contract.body_parameter]: draft.body };
}
function candidate(services: HandlerServices, role: string, draft: EmailDraft) {
  const matches = services.registries.snapshot().tools.filter(tool => toolRoleAllowed(tool.allowed_roles, role) && tool.email_delivery_contract !== undefined);
  if (matches.length !== 1) deny(matches.length ? "More than one email connector is eligible; an administrator must leave one explicit binding" : "No explicitly bound email connector is available", 422);
  const tool = matches[0]!, args = binding(tool, draft);
  return { tool, args, contractHash: capabilityContractHash(tool) };
}
function linkedAdmission(state: Readonly<RepositoryState>, user: CurrentUser, draft: EmailDraft, keyHash: string, rawKey: string) {
  const matches = Object.entries(state.emailDeliveryAdmissions).filter(([, item]) => item.sessionId === draft.sessionId && item.draftId === draft.id);
  if (!matches.length) return null;
  if (matches.length !== 1) deny("The stored email approval identity is inconsistent", 503, "EMAIL_DELIVERY_RECORD_INVALID");
  const [mapId, raw] = matches[0]!, parsed = admissionSchema.safeParse(raw);
  if (!parsed.success || mapId !== parsed.data.id) deny("The stored email approval record is invalid", 503, "EMAIL_DELIVERY_RECORD_INVALID");
  const admission = parsed.data;
  if (admission.actorId !== user.id || admission.sessionId !== draft.sessionId || admission.draftId !== draft.id ||
      admission.draftVersion !== draft.version || admission.draftHash !== draft.contentHash) deny("The stored email approval source is inconsistent", 503, "EMAIL_DELIVERY_RECORD_INVALID");
  if (admission.keyHash !== keyHash) deny("This draft already has an approval request under a different key");
  const workflow = state.workflows[admission.workflowId], execution = state.executions[admission.executionId];
  const workflowSource = sourceSchema.safeParse(workflow?.emailDeliverySource), executionSource = sourceSchema.safeParse(execution?.emailDeliverySource);
  const expectedSource = { profile: "email-delivery-source/v1", admissionId: admission.id, sessionId: admission.sessionId, draftId: admission.draftId,
    draftVersion: admission.draftVersion, draftHash: admission.draftHash };
  const fingerprint = digest({ sessionId: admission.sessionId, draftId: admission.draftId, draftVersion: admission.draftVersion, draftHash: admission.draftHash,
    actorId: admission.actorId, toolId: admission.toolId, contractHash: admission.contractHash, sourceHash: execution?.workflowSnapshot?.contentHash, keyHash });
  const scope = digest(["email-delivery-operation/v1", admission.id, user.id, rawKey]);
  if (!workflow || !execution || execution.workflowId !== workflow.id || execution.startedBy.id !== user.id || !workflowSource.success || !executionSource.success ||
      !canonicalJSONBytes(workflowSource.data).equals(canonicalJSONBytes(expectedSource)) || !canonicalJSONBytes(executionSource.data).equals(canonicalJSONBytes(expectedSource)) ||
      execution.workflowSnapshot?.yaml !== workflow.yaml || admission.requestFingerprint !== fingerprint || execution.operationSecret?.requestFingerprint !== fingerprint ||
      execution.operationSecret.idempotencyScope !== scope) deny("The linked email approval execution is invalid", 503, "EMAIL_DELIVERY_RECORD_INVALID");
  return { admission, execution };
}
function publicReceipt(admission: EmailDeliveryAdmission, execution: Execution, replayed: boolean) {
  const bridgeDispatched = Object.values(execution.operationSecret?.intents ?? {}).some(intent => ["DISPATCH_INTENT", "ACKNOWLEDGED", "UNKNOWN"].includes(intent.state));
  return { profile: "email-delivery-admission/v1" as const, admissionId: admission.id, workflowId: admission.workflowId, executionId: admission.executionId,
    draftId: admission.draftId, draftVersion: admission.draftVersion, draftHash: admission.draftHash, status: execution.status, replayed,
    reviewRequested: true as const, freshIndependentApprovalRequired: true as const, bridgeDispatched, deliveryVerified: false as const,
    explanation: "Independent approval was requested for this exact draft. Nothing has been sent; queueing or ERPBridge acceptance is not proof of email delivery." };
}

/** Admit exactly one immutable draft as a one-node governed notification. No
 * model, browser-selected tool/arguments or SDK call is reachable here. */
export async function admitEmailDelivery(services: HandlerServices, user: CurrentUser, sessionId: string, raw: unknown, traceId: string, _request: FastifyRequest) {
  requireResidentExecution(services.repository);
  requireStorage(services);
  const parsed = emailDeliveryCommandSchema.safeParse(raw);
  if (!parsed.success) deny("Request the exact saved draft revision, confirm sharing and provide a stable idempotency key", 422);
  const command = parsed.data, keyHash = digest(["email-delivery-key/v1", user.id, sessionId, command.idempotencyKey]);
  const initial = await services.repository.readAuthoritative(state => {
    const draft = latestDraft(state, sessionId, command.draftId, user);
    if (draft.version !== command.baseVersion || draft.contentHash !== command.baseHash) deny("The email draft changed. Reload before requesting approval");
    const linked = linkedAdmission(state, user, draft, keyHash, command.idempotencyKey);
    if (linked) return { draft, linked, selected: null };
    requireCurrentRecipientResolution(state, draft, user.id);
    if (draft.recurring) deny("Recurring delivery must be built and reviewed as a scheduled workflow; a chat draft cannot activate recurrence", 422);
    if (draft.channel !== "email" || !z.email().safeParse(draft.to).success || !draft.subject.trim() || !draft.body.trim())
      deny("A complete email channel, recipient, subject and body are required", 422);
    return { draft, linked: null, selected: candidate(services, user.role, draft) };
  });
  if (initial.linked) return { assistantMessage: null, emailDelivery: publicReceipt(initial.linked.admission, initial.linked.execution, true) };
  const selected = initial.selected!;
  const yaml = stringify({ name: `Email approval · ${initial.draft.subject.slice(0, 80)}`, description: `Exact reviewed chat draft ${initial.draft.id}; admission does not imply delivery.`, trigger: { type: "manual" },
    steps: [{ id: "deliver_email", action: selected.tool.name, parameters: selected.args }] });
  const prepared = await prepareOperationPublication(services, yaml, user);
  if (!prepared) deny("The selected email connector is not a governed operation", 422);
  const node = prepared.stored.plan.ir.root.nodes[0], resolved = node?.kind === "action" ? resolveReadBinding(node.inputs, { input: {} }) : null;
  if (prepared.stored.plan.ir.root.nodes.length !== 1 || !node || node.kind !== "action" || node.capability.toolId !== selected.tool.tool_id || node.effectClass !== "notification" ||
      !canonicalJSONBytes(resolved).equals(canonicalJSONBytes(selected.args))) deny("The compiled email action differs from the exact server-derived draft", 409);
  const requestFingerprint = digest({ sessionId, draftId: initial.draft.id, draftVersion: initial.draft.version, draftHash: initial.draft.contentHash,
    actorId: user.id, toolId: selected.tool.tool_id, contractHash: selected.contractHash, sourceHash: prepared.stored.plan.sourceHash, keyHash });
  try {
    const result = await services.repository.mutate(state => {
      const draft = latestDraft(state, sessionId, command.draftId, user), { actor, role } = currentActor(state, user);
      if (draft.version !== command.baseVersion || draft.contentHash !== command.baseHash || draft.recurring || draft.channel !== "email" ||
          !z.email().safeParse(draft.to).success || !draft.subject.trim() || !draft.body.trim()) deny("The exact complete email draft changed before admission");
      const linked = linkedAdmission(state, user, draft, keyHash, command.idempotencyKey);
      if (linked) return { assistantMessage: null, emailDelivery: publicReceipt(linked.admission, linked.execution, true) };
      requireCurrentRecipientResolution(state, draft, user.id);
      const current = candidate(services, role.name, draft);
      if (current.tool.tool_id !== selected.tool.tool_id || current.contractHash !== selected.contractHash || !canonicalJSONBytes(current.args).equals(canonicalJSONBytes(selected.args)))
        deny("The email connector or exact draft binding changed before admission");
      assertOperationPublicationCurrent(prepared, services, state, yaml, role.name); runtimeApprovalPolicyHash(state, user.id);
      const now = new Date().toISOString(), admissionId = `email-admission-${randomBytes(16).toString("hex")}`;
      const workflowId = `email-workflow-${randomBytes(16).toString("hex")}`, executionId = `operation-${randomBytes(16).toString("hex")}`;
      const source = { profile: "email-delivery-source/v1" as const, admissionId, sessionId, draftId: draft.id, draftVersion: draft.version, draftHash: draft.contentHash };
      const workflow: Workflow = { id: workflowId, name: `Email · ${draft.subject.slice(0, 100)}`, description: "Immutable one-time notification created from an exact chat draft.",
        owner: { id: actor.id, name: actor.name }, assignedUserIds: [], status: "Published", trigger: { type: "manual" }, steps: 1, successRate: 0, lastRunAt: null,
        publishedVersion: 1, draftVersion: 1, tags: ["chat-email-delivery"], domainTags: [], canRun: true, createdAt: now, updatedAt: now, yaml, archived: false, emailDeliverySource: source };
      state.workflows[workflowId] = workflow;
      state.versions[workflowId] = [{ id: `email-version-${randomBytes(16).toString("hex")}`, workflowId, version: 1, artifactState: "PUBLISHED", versionNote: "Immutable chat email delivery publication",
        yaml, createdAt: now, createdBy: { id: actor.id, name: actor.name }, emailDeliverySource: source, compiledOperation: prepared.stored, executionReadiness: "COMPILED_OPERATION" }];
      const scope = digest(["email-delivery-operation/v1", admissionId, user.id, command.idempotencyKey]);
      const execution: Execution = { id: executionId, workflowId, workflowName: workflow.name, status: "PENDING", startedAt: now, completedAt: null, durationMs: 0,
        tokens: { input: 0, output: 0, total: 0 }, costUsd: 0, startedBy: { id: actor.id, name: actor.name }, traceId,
        workflowSnapshot: { yaml, version: 1, contentHash: prepared.stored.plan.sourceHash, registryHash: prepared.stored.receipt.registryHash, input: {}, executionProfile: "sequential-operation-v1", operationCompilation: prepared.stored.receipt },
        readProgress: newReadProgress(services.repository), stepOutputs: {}, emailDeliverySource: source,
        operationSecret: { profile: "operation-job/v1", actorId: actor.id, roleId: role.id, admittedRole: role.name, state: "QUEUED", idempotencyScope: scope, requestFingerprint, createdAt: now, intents: {} },
        agentSummary: "Independent approval requested for the exact email draft. No SDK dispatch or delivery has occurred." };
      assertCurrentRunController(state, execution, actor.id, role.name);
      state.executions[executionId] = execution; state.timelines[executionId] = []; state.executionEvents[executionId] = []; state.executionLogs[executionId] = [];
      appendExecutionEvent(state, execution, "run.queued", { profile: "operation-job/v1", source: "chat-email-draft", persistence: execution.readProgress!.persistence });
      const admission: EmailDeliveryAdmission = { profile: "email-delivery-admission-private/v1", id: admissionId, sessionId, draftId: draft.id, draftVersion: draft.version,
        draftHash: draft.contentHash, actorId: actor.id, toolId: selected.tool.tool_id, contractHash: selected.contractHash, keyHash, requestFingerprint, workflowId, executionId, createdAt: now };
      state.emailDeliveryAdmissions[admissionId] = admission;
      const chat = state.chats[sessionId]!, userMessage = { id: nextID(state, "msg"), role: "user", text: "Request independent approval for this exact email draft", createdAt: now };
      const emailDelivery = publicReceipt(admission, execution, false);
      const assistantMessage = { id: nextID(state, "msg"), role: "assistant", text: emailDelivery.explanation, artifacts: { intent: "EMAIL_DELIVERY", emailDraft: structuredClone(draft), emailDelivery, can_execute: false }, createdAt: now };
      chat.messages.push(userMessage, assistantMessage); chat.messageCount = chat.messages.length; chat.updatedAt = now;
      state.auditLogs.push({ id: `email-delivery-${randomBytes(12).toString("hex")}`, actor: { id: actor.id, name: actor.name }, action: "email_delivery.approval_requested",
        resource: { type: "execution", id: executionId }, after: { admissionId, workflowId, draftId: draft.id, draftVersion: draft.version, freshIndependentApprovalRequired: true, deliveryVerified: false }, createdAt: now });
      return { userMessage, assistantMessage, emailDelivery };
    });
    operationJobQueue(services).kick();
    return result;
  } catch (error) {
    try { services.repository.assertAuthority(); } catch {
      throw new HandlerFailure(503, "Email approval-request acknowledgement is unconfirmed. Reload the conversation; do not submit a new key.", { code: "EMAIL_DELIVERY_ACK_UNCONFIRMED" });
    }
    throw error;
  }
}
