import { createHmac, timingSafeEqual } from "node:crypto";
import { canonicalJSONBytes, resolvedParameterHashBytes } from "../core/canonical-json.js";
import { decodeEncryptionKey } from "../storage/aes-gcm.js";
import type { Execution, RepositoryState } from "../repository/store.js";
import type { HandlerServices, CurrentUser } from "../http/handlers/common.js";
import { assertCurrentRunController } from "./read-checkpoints.js";
import { authenticatedProtectedOperationPublication, assertStoredProtectedOperationPublicationCurrent, protectedPublicationWorkspaceBinding } from "../workflows/protected-operation-publication.js";
import { ProtectedContinuationCodec } from "./protected-continuation.js";
import { ProtectedMachine } from "../workflows/protected-machine.js";
import { ProtectedInvocationLedger } from "./protected-invocation-ledger.js";
import { assertProtectedInvocationLedger } from "../repository/protected-invocation-records.js";
import { assertProtectedJobShape } from "../repository/protected-job-record.js";
import { assertProtectedAgentRecords } from "../repository/protected-agent-records.js";
import { assertProtectedAgentHistory } from "./protected-agent-protocol.js";
import { assertProtectedApprovalRecords } from "../repository/protected-approval-records.js";
import { assertProtectedApprovalHistory } from "./protected-approval-history.js";
import { assertProtectedReportHistory } from "./protected-report-state.js";

export const protectedHash = (value: unknown) => resolvedParameterHashBytes(canonicalJSONBytes(value));
export type ProtectedJobOwner = { leaseId: string; workerId: string; epoch: number };
/** Current request identity/ACL before any discovery or verification wait. */
export function assertProtectedRequestActor(state: Readonly<RepositoryState>, workflowId: string, user: CurrentUser): void {
  const account = state.users[user.id], role = account && state.roles[account.roleId], workflow = state.workflows[workflowId];
  const permissions = [...new Set([...(role?.permissions ?? []), ...(account?.permissionOverrides ?? [])].filter(Boolean))].sort();
  if (!account || account.status.toLowerCase() !== "active" || account.id !== user.id || account.roleId !== user.roleId || role?.name !== user.role ||
      account.departmentId !== user.departmentId || protectedHash(permissions) !== protectedHash([...new Set(user.permissions)].sort()) ||
      !workflow || workflow.archived || !permissions.includes("workflow:run") && (!permissions.includes("workflow:run_own") ||
        workflow.owner.id !== user.id && !(workflow.assignedUserIds ?? []).includes(user.id))) throw new Error("Protected request actor cannot run this workflow");
}
export function protectedAdmissionSeal(services: HandlerServices, run: Execution): string {
  const job = run.protectedJobSecret!, { admissionSeal: _seal, state: _state, lease: _lease, ...admission } = job;
  return createHmac("sha256", decodeEncryptionKey(services.config.storageEncryptionKey)).update("lcwe/protected-job-admission/v1\0")
    .update(canonicalJSONBytes({ workspace: protectedPublicationWorkspaceBinding(services), id: run.id, workflowId: run.workflowId, startedBy: run.startedBy, snapshot: run.workflowSnapshot, identity: run.protectedInvocationSecret!.identity, admission,
      ...(run.erpCredentialSecret ? { erpCredentialBinding: run.erpCredentialSecret } : {}) })).digest("hex");
}
export function assertProtectedAdmission(services: HandlerServices, run: Execution): void {
  assertProtectedJobShape(run); if (!run.protectedJobSecret) throw new Error("Protected job admission is missing");
  const seal = run.protectedJobSecret.admissionSeal, expected = protectedAdmissionSeal(services, run);
  if (!timingSafeEqual(Buffer.from(seal, "hex"), Buffer.from(expected, "hex"))) throw new Error("Protected job admission changed");
}
export function assertProtectedActor(state: Readonly<RepositoryState>, run: Execution, user?: CurrentUser): void {
  const job = run.protectedJobSecret!, account = state.users[job.actorId], role = account && state.roles[account.roleId];
  const permissions = [...new Set([...(role?.permissions ?? []), ...(account?.permissionOverrides ?? [])].filter(Boolean))].sort();
  assertCurrentRunController(state as RepositoryState, run, job.actorId, job.admittedRole);
  if (!account || account.id !== job.actorId || account.roleId !== job.roleId || role?.id !== job.roleId || account.departmentId !== job.departmentId ||
      protectedHash(permissions) !== job.permissionsHash || user && (user.id !== job.actorId || user.roleId !== job.roleId || user.role !== job.admittedRole ||
        user.departmentId !== job.departmentId || protectedHash([...new Set(user.permissions)].sort()) !== job.permissionsHash)) throw new Error("Protected run actor authority changed");
}
export function protectedCodec(services: HandlerServices) { return new ProtectedContinuationCodec(decodeEncryptionKey(services.config.storageEncryptionKey).toString("base64")); }
export function protectedCursorIdentity(services: HandlerServices, run: Execution) {
  const identity = run.protectedInvocationSecret!.identity;
  return protectedCodec(services).identity({ executionId: run.id, workflowId: run.workflowId, epoch: run.readProgress!.epoch,
    actorId: identity.actorId, roleId: identity.roleId, admittedRole: identity.admittedRole, sourceHash: identity.sourceHash, semanticHash: identity.machineHash }, run.workflowSnapshot!.input);
}
export function protectedEvidence(run: Execution) {
  assertProtectedInvocationLedger(run.protectedInvocationSecret, run.id);
  if (Object.hasOwn(run, "protectedAgentSecret")) assertProtectedAgentRecords(run.protectedAgentSecret, run.protectedInvocationSecret!);
  if (Object.hasOwn(run, "protectedApprovalSecret")) assertProtectedApprovalRecords(run.protectedApprovalSecret, run.protectedInvocationSecret!);
  return { profile: "owned-protected-job-evidence/v1", admissionSeal: run.protectedJobSecret!.admissionSeal,
    ledgerHash: protectedHash(run.protectedInvocationSecret),
    ...(Object.hasOwn(run, "protectedAgentSecret") ? { agentHash: protectedHash(run.protectedAgentSecret) } : {}),
    ...(Object.hasOwn(run, "protectedApprovalSecret") ? { approvalHash: protectedHash(run.protectedApprovalSecret) } : {}),
    ...(Object.hasOwn(run, "reportPageSecret") ? { reportProgressHash: protectedHash(run.reportPageSecret) } : {}),
    ...(Object.hasOwn(run, "reportCoverages") ? { reportCoverageHash: protectedHash(run.reportCoverages) } : {}) };
}
export function sealProtectedCursor(services: HandlerServices, state: RepositoryState, run: Execution, machine: ProtectedMachine): void {
  const codec = protectedCodec(services), identity = protectedCursorIdentity(services, run);
  state.protectedContinuations[run.id] = codec.encode(identity, codec.evidenceBinding(identity, protectedEvidence(run)), machine.snapshot());
}
/** Authenticate complete historical state before current-authority decisions.
 * Restoring pure data alone cannot authorize a handler or an SDK entry. */
export function restoreProtectedJob(state: Readonly<RepositoryState>, services: HandlerServices, executionId: string) {
  const run = state.executions[executionId]; if (!run) throw new Error("Protected run not found");
  assertProtectedAdmission(services, run);
  const historical = authenticatedProtectedOperationPublication(state, services, run.workflowId, run.protectedJobSecret!.publicationId);
  if (!canonicalJSONBytes(historical.receipt).equals(canonicalJSONBytes(run.workflowSnapshot!.protectedCompilation))) throw new Error("Protected run publication differs from its sealed admission");
  const codec = protectedCodec(services), identity = protectedCursorIdentity(services, run), record = state.protectedContinuations[run.id];
  if (!record) throw new Error("Protected run lacks its authenticated continuation");
  const snapshot = codec.decode(record, identity, codec.evidenceBinding(identity, protectedEvidence(run)));
  const machine = new ProtectedMachine(historical.plan.machine, {}, snapshot), ledger = new ProtectedInvocationLedger(run.protectedInvocationSecret!.identity, historical.plan.machine, machine, run.protectedInvocationSecret);
  assertProtectedAgentHistory(historical.plan, run);
  assertProtectedApprovalHistory(historical.plan, run);
  assertProtectedReportHistory(historical.plan, run, state);
  // Continue the fully checked semantic replay, not canonical JSON's property
  // insertion order. Existing v1 scope arrays/receipt identities stay unchanged.
  return { run, plan: historical.plan, machine: ledger.replayedMachine(), ledger };
}
export function assertProtectedJobCurrent(state: Readonly<RepositoryState>, services: HandlerServices, executionId: string, owner?: ProtectedJobOwner) {
  const saved = restoreProtectedJob(state, services, executionId), { run } = saved, job = run.protectedJobSecret!;
  assertProtectedActor(state, run);
  if (run.readProgress?.cancellation || owner && (run.status !== "RUNNING" || job.state !== "CLAIMED" || job.lease?.id !== owner.leaseId ||
      job.lease.workerId !== owner.workerId || job.lease.expiresAt <= Date.now() || run.readProgress?.epoch !== owner.epoch)) throw new Error("Protected worker ownership changed");
  const current = assertStoredProtectedOperationPublicationCurrent(state, services, job.publicationId, run.workflowId, job.admittedRole);
  if (current.semanticHash !== saved.plan.semanticHash || run.workflowSnapshot!.registryHash !== services.registries.hash()) throw new Error("Protected run reviewed compilation changed");
  return saved;
}
