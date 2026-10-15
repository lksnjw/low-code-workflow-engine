import { randomUUID } from "node:crypto";
import { captureUserMcpBinding } from "../tools/user-mcp-credentials.js";
import type { Execution } from "../repository/store.js";
import type { HandlerServices, CurrentUser } from "../http/handlers/common.js";
import { HandlerFailure, appendAudit, validateWorkflow } from "../http/handlers/common.js";
import { boundedFiniteJSONBytes } from "../core/bounded-finite-json.js";
import { parseWorkflowYAMLStrict, workflowContentHash } from "../parser/workflow.js";
import { assertStoredProtectedOperationPublicationCurrent, type ProtectedOperationPublicationReceipt } from "../workflows/protected-operation-publication.js";
import { protectedOperationConnections, discoverProtectedOperationConnections, assertProtectedConnectionsCurrent, assertProtectedCapabilitiesDiscovered } from "../workflows/protected-operation-bindings.js";
import type { CompiledProtectedOperationPlan } from "../workflows/protected-operation-compiler.js";
import { validateToolInput } from "../tools/tool-input-schema.js";
import { savedGeneratedReturnCoverageIssues } from "../synthesis/return-coverage.js";
import { newReadProgress, appendExecutionEvent } from "./read-checkpoints.js";
import { ProtectedMachine } from "../workflows/protected-machine.js";
import { ProtectedInvocationLedger } from "./protected-invocation-ledger.js";
import { protectedHash as hash, assertProtectedActor, assertProtectedRequestActor, protectedAdmissionSeal, assertProtectedAdmission, sealProtectedCursor } from "./protected-job-state.js";
import { publicExecution } from "../redact/public-model-usage.js";
import { supportsOperationJobs } from "./operation-jobs.js";
import { requireResidentExecution } from "./execution-host.js";

/** Qualification of currently implemented invocation drivers, not the final
 * product scope. Refuse the WHOLE run before any prefix executes if a required
 * effect/report driver has not yet been integrated and qualified. */
export function assertProtectedDriversAvailable(plan: CompiledProtectedOperationPlan): void {
  if (plan.ir.root.nodes.some(node => node.kind === "agent" ? node.allowedCapabilities.some(item => plan.ir.contracts[item.toolId]?.reportCoverageContract) :
      node.kind !== "analysis" && (node.kind !== "action" || node.effectClass !== "read" || plan.ir.contracts[node.capability.toolId]?.reportCoverageContract)))
    throw new HandlerFailure(422, "This protected collection requires approval/effect or report drivers that are still being integrated; no run was admitted", { code: "PROTECTED_INVOCATION_DRIVERS_PENDING" });
}
/** Implemented owned controller support, separate from whole-plan admission
 * qualification. This never opens publication or the public v9 run gate. */
export function assertProtectedOwnedDriversAvailable(plan: CompiledProtectedOperationPlan): void {
  if (plan.ir.root.nodes.some(node => node.kind === "agent" ? node.allowedCapabilities.some(item => plan.ir.contracts[item.toolId]?.reportCoverageContract) :
      node.kind !== "analysis" && (node.kind !== "action" || plan.ir.contracts[node.capability.toolId]?.reportCoverageContract && !plan.ir.contracts[node.capability.toolId]?.reportCoverageContract?.pagination ||
        node.effectClass !== "read" && !plan.ir.contracts[node.capability.toolId]?.operationContract)))
    throw new HandlerFailure(422, "This protected job requires an owned driver that is not implemented", { code: "PROTECTED_INVOCATION_DRIVERS_PENDING" });
}

/** Internal, authenticated durable admission. No normal HTTP route is enabled.
 * Inputs never carry plans, receipts, cursors, actor flags or worker authority. */
export async function admitProtectedOperation(services: HandlerServices, workflowId: string, user: CurrentUser, rawInput: Record<string, unknown>, key: string) {
  requireResidentExecution(services.repository);
  user = structuredClone(user);
  const validator = services.validator, validationGate = services.validationGate;
  if (!supportsOperationJobs(services)) throw new HandlerFailure(503, "Protected jobs require qualified scoped single-writer storage", { code: "PROTECTED_JOB_STORAGE_UNSUPPORTED" });
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) throw new HandlerFailure(422, "Protected runs require a stable 16–128 character idempotency key");
  try { boundedFiniteJSONBytes(rawInput, 64_000); } catch { throw new HandlerFailure(422, "Protected input must be bounded finite JSON"); }
  if (!rawInput || Array.isArray(rawInput) || typeof rawInput !== "object") throw new HandlerFailure(422, "Protected input must be an object");
  const input = structuredClone(rawInput), scope = hash(["protected-operation-job/v1", user.id, workflowId, key]);
  const initial = await services.repository.readAuthoritative(state => {
    assertProtectedRequestActor(state, workflowId, user);
    const workflow = state.workflows[workflowId];
    if (!workflow || workflow.archived || workflow.emailDeliverySource || workflow.recoverySource || workflow.pendingGenerationApproval?.steps.length || savedGeneratedReturnCoverageIssues(workflow).length)
      throw new HandlerFailure(409, "A current accepted immutable protected publication is required");
    const fingerprint = hash({ workflowId, version: workflow.publishedVersion, sourceHash: workflowContentHash(workflow.yaml), input });
    const matches = Object.values(state.executions).filter(run => run.protectedJobSecret?.idempotencyScope === scope);
    if (matches.length) {
      if (matches.length !== 1 || matches[0]!.protectedJobSecret!.requestFingerprint !== fingerprint) throw new HandlerFailure(409, "Protected run key belongs to different inputs or publication");
      const run = matches[0]!; assertProtectedAdmission(services, run); assertProtectedActor(state, run, user);
      return { existing: publicExecution(run) };
    }
    const publications = (state.versions[workflowId] ?? []).filter(version => version.version === workflow.publishedVersion && version.artifactState === "PUBLISHED");
    if (publications.length !== 1 || publications[0]!.yaml !== workflow.yaml) throw new HandlerFailure(409, "A unique current protected publication is required");
    const version = publications[0]!, plan = assertStoredProtectedOperationPublicationCurrent(state, services, String(version.id), workflowId, user.role);
    assertProtectedDriversAvailable(plan);
    if (plan.ir.inputSchema && validateToolInput(plan.ir.inputSchema, input).length) throw new HandlerFailure(422, "Protected run input does not meet its declared schema");
    return { yaml: workflow.yaml, draftVersion: workflow.draftVersion, versionId: String(version.id), receipt: structuredClone(version.protectedCompilation) as ProtectedOperationPublicationReceipt,
      fingerprint, governanceHash: hash(state.governancePolicy), plan };
  });
  if ("existing" in initial) return { execution: initial.existing!, replayed: true };
  const connections = protectedOperationConnections(services, parseWorkflowYAMLStrict(initial.yaml)), live = await discoverProtectedOperationConnections(services, connections);
  const gate = await validateWorkflow(services, "ProtectedOperationAdmission", initial.yaml, user, { workflowId });
  if (!gate.result.passed || !gate.token || !services.validator.verifyToken(gate.token) || gate.token.workflow_content_hash !== initial.plan.sourceHash || gate.token.registry_hash !== initial.receipt.registryHash)
    throw new HandlerFailure(422, "Protected run validation failed");
  try {
    return await services.repository.mutate(state => {
      assertProtectedRequestActor(state, workflowId, user);
      if (services.validator !== validator || services.validationGate !== validationGate || !gate.token || !validator.verifyToken(gate.token))
        throw new HandlerFailure(409, "Protected validation services changed during admission");
      const current = state.workflows[workflowId];
      if (!current || current.yaml !== initial.yaml || current.draftVersion !== initial.draftVersion || current.publishedVersion !== initial.receipt.version ||
          current.pendingGenerationApproval?.steps.length || savedGeneratedReturnCoverageIssues(current).length || hash(state.governancePolicy) !== initial.governanceHash)
        throw new HandlerFailure(409, "Protected publication, draft or governance changed during admission");
      assertProtectedConnectionsCurrent(services, parseWorkflowYAMLStrict(initial.yaml), connections);
      const plan = assertStoredProtectedOperationPublicationCurrent(state, services, initial.versionId, workflowId, user.role);
      assertProtectedCapabilitiesDiscovered(plan, live); assertProtectedDriversAvailable(plan);
      if (Object.values(state.executions).some(run => run.protectedJobSecret?.idempotencyScope === scope))
        throw new HandlerFailure(409, "Protected admission changed concurrently; reload the existing run before retrying");
      const id = `protected-${randomUUID()}`, createdAt = new Date().toISOString();
      const machine = new ProtectedMachine(plan.machine, input); machine.peek();
      const ledger = new ProtectedInvocationLedger({ executionId: id, workflowId, actorId: user.id, roleId: user.roleId, admittedRole: user.role,
        sourceHash: plan.sourceHash, operationHash: plan.semanticHash, machineHash: plan.machine.semanticHash, inputHash: hash(input) }, plan.machine, machine);
      const run: Execution = { id, workflowId, workflowName: current.name, startedBy: { id: user.id, name: user.name }, status: "PENDING", startedAt: createdAt, completedAt: null, durationMs: 0,
        ...(services.userMcpCredentials ? { erpCredentialSecret: captureUserMcpBinding(services, state, user.id)! } : {}),
        tokens: { input: 0, output: 0, total: 0 }, costUsd: 0, stepOutputs: {}, workflowSnapshot: { yaml: initial.yaml, version: initial.receipt.version,
          contentHash: plan.sourceHash, registryHash: initial.receipt.registryHash, input, executionProfile: "protected-operation-v1", protectedCompilation: initial.receipt },
        readProgress: newReadProgress(services.repository), protectedInvocationSecret: ledger.snapshot(),
        protectedJobSecret: { profile: "protected-operation-job/v1", actorId: user.id, roleId: user.roleId, admittedRole: user.role, departmentId: user.departmentId,
          permissionsHash: hash([...new Set(user.permissions)].sort()), publicationId: initial.versionId, idempotencyScope: scope, requestFingerprint: initial.fingerprint, createdAt,
          state: "QUEUED", admissionSeal: "0".repeat(64) }, agentSummary: "Protected run queued for invocation-based execution; no tool has run." };
      assertProtectedActor(state, run, user); run.protectedJobSecret!.admissionSeal = protectedAdmissionSeal(services, run);
      state.executions[id] = run; sealProtectedCursor(services, state, run, machine);
      state.timelines[id] = []; state.executionLogs[id] = []; state.executionEvents[id] = [];
      appendExecutionEvent(state, run, "run.admitted", { profile: "protected-operation-job/v1" });
      appendAudit(state, user, "workflow.protected_run_admitted", "execution", id, null, { workflowId, version: initial.receipt.version });
      return { execution: publicExecution(run), replayed: false };
    });
  } catch (error) {
    if (error instanceof HandlerFailure) throw error;
    throw new HandlerFailure(503, "Protected admission was not confirmed. Reload the original request key before retrying", { code: "PROTECTED_ADMISSION_UNCONFIRMED" });
  }
}
