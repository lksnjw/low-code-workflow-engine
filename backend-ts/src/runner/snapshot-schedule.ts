import { createHash, randomBytes } from "node:crypto";
import { canonicalJSONBytes } from "../core/canonical-json.js";
import type { Execution, RepositoryState, StoredRecord } from "../repository/store.js";
import type { Workflow } from "../models/schemas.js";
import { HandlerFailure, validateWorkflow, type CurrentUser, type HandlerServices } from "../http/handlers/common.js";
import { prepareCompiledExecution } from "../workflows/read-compilation-lifecycle.js";
import { validateToolInput } from "../tools/tool-input-schema.js";
import { workflowContentHash } from "../parser/workflow.js";
import { readJobQueue } from "./read-jobs.js";
import { appendExecutionEvent, assertCurrentRunController, newReadProgress } from "./read-checkpoints.js";
import { dispatchReadTaskOutbox, requireReadTaskAdmission } from "./read-task-outbox.js";
import { residentExecutionAllowed } from "./execution-host.js";
import { assertWorkflowLifecycleScope, type WorkflowLifecycleScope } from "./workflow-lifecycle-host.js";

export function prepareReadSnapshot(state: Readonly<RepositoryState>, services: HandlerServices, publication: StoredRecord,
  workflow: Workflow, role: string, input: Record<string, unknown>) {
  const compiled = prepareCompiledExecution(state, services, publication, workflow.yaml, role);
  if (compiled.plan.ir.schemaVersion === "workflow-read-ir/v4")
    throw new HandlerFailure(422, "Scheduled collection reads are not qualified by the snapshot profile");
  if (compiled.plan.ir.inputSchema && validateToolInput(compiled.plan.ir.inputSchema, input).length)
    throw new HandlerFailure(422, "Snapshot inputs do not match the published workflow", { code: "SCHEDULE_INPUT_INVALID" });
  return compiled;
}

/** Server-only lifecycle admission into the existing governed read queue.
 * No tool dispatch, invented reporting window, effect authority or user-token
 * substitution is introduced by this separate current-state snapshot profile. */
export async function admitReadSnapshot(services: HandlerServices, workflow: Workflow, input: Record<string, unknown>, actor: CurrentUser,
  key: string, source: NonNullable<Execution["snapshotScheduleSource"]>, lifecycleScope?: WorkflowLifecycleScope) {
  const assertReady = () => {
    if (!residentExecutionAllowed(services.repository)) {
      if (!lifecycleScope) throw new Error("Snapshot admission requires the original lifecycle owner");
      assertWorkflowLifecycleScope(services.repository, lifecycleScope);
    }
  };
  assertReady(); requireReadTaskAdmission(services.repository);
  const gate = await validateWorkflow(services, "ScheduledReadSnapshot", workflow.yaml, actor, { workflowId: workflow.id });
  if (!gate.result.passed) throw new HandlerFailure(422, "Snapshot workflow validation no longer passes");
  assertReady();
  const queue = readJobQueue(services), admission = queue.prepare(workflow, input, actor, key, undefined, source);
  const run = await services.repository.mutate(state => {
    assertReady();
    const existing = queue.existing(state, admission, actor);
    if (existing) return existing; // Original committed occurrence; never a new run.
    const schedule = state.schedules[source.scheduleId], occurrence = state.scheduleOccurrences[source.occurrenceId];
    const current = state.workflows[workflow.id];
    if (!schedule || schedule.profile !== "workflow-snapshot-schedule/v1" || schedule.state !== "ACTIVE" ||
      schedule.revision !== source.scheduleRevision || schedule.scheduleHash !== source.scheduleHash || schedule.workflowId !== workflow.id ||
      schedule.workflowVersion !== workflow.publishedVersion || schedule.servicePrincipalId !== actor.id ||
      !occurrence || occurrence.state !== "ADMITTING" || occurrence.scheduleId !== source.scheduleId || occurrence.scheduleRevision !== source.scheduleRevision ||
      occurrence.scheduledFor !== source.scheduledFor || occurrence.idempotencyKey !== key ||
      source.inputHash !== `sha256:${createHash("sha256").update(canonicalJSONBytes(input)).digest("hex")}` ||
      !current || current.archived || current.pendingGenerationApproval?.steps.length || current.yaml !== workflow.yaml ||
      workflowContentHash(current.yaml) !== schedule.workflowHash || current.publishedVersion !== schedule.workflowVersion)
      throw new HandlerFailure(409, "Snapshot schedule or occurrence changed before admission", { code: "SCHEDULE_ADMISSION_CHANGED" });
    const publication = state.versions[workflow.id]?.findLast(v => v.artifactState === "PUBLISHED" && v.version === workflow.publishedVersion && v.yaml === workflow.yaml);
    if (!publication) throw new HandlerFailure(409, "Pinned snapshot publication is unavailable");
    const compiled = prepareReadSnapshot(state, services, publication, workflow, actor.role, input);
    queue.assertCapacity(state);
    const id = `run-${randomBytes(8).toString("hex")}`, startedAt = new Date().toISOString();
    const execution: Execution = { id, workflowId: workflow.id, workflowName: workflow.name, status: "PENDING", startedAt, completedAt: null,
      durationMs: 0, tokens: { input: 0, output: 0, total: 0 }, costUsd: 0, startedBy: { id: actor.id, name: actor.name },
      snapshotScheduleSource: structuredClone(source), readProgress: newReadProgress(services.repository), stepOutputs: {},
      ...(workflow.chatSessionId ? { chatSessionId: workflow.chatSessionId } : {}),
      workflowSnapshot: { version: workflow.publishedVersion, contentHash: compiled.plan.sourceHash, registryHash: services.registries.hash(),
        yaml: workflow.yaml, input: structuredClone(input), compilation: compiled.receipt,
        executionProfile: compiled.plan.ir.schemaVersion === "workflow-read-ir/v3" ? "structured-read-v1" : compiled.plan.ir.flow ? "conditional-read-v1" : "sequential-read-v1" } };
    assertCurrentRunController(state, execution, actor.id, actor.role);
    state.executions[id] = execution; state.timelines[id] = []; state.executionEvents[id] = []; state.executionLogs[id] = [];
    queue.store(state, execution, admission);
    appendExecutionEvent(state, execution, "run.queued", { profile: "read-snapshot-schedule/v1", occurrenceId: source.occurrenceId });
    state.auditLogs.push({ id: `snapshot-audit-${randomBytes(8).toString("hex")}`, actor: execution.startedBy, action: "execution.snapshot_scheduled",
      resource: { type: "execution", id }, after: { workflowId: workflow.id, occurrenceId: source.occurrenceId }, createdAt: startedAt });
    return structuredClone(execution);
  });
  assertReady();
  if (!residentExecutionAllowed(services.repository)) await dispatchReadTaskOutbox(services.repository, run.id);
  assertReady(); queue.kick();
  return { execution: run };
}
