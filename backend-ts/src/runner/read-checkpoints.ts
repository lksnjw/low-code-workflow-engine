import { randomBytes } from "node:crypto";
import type { Execution, Repository, RepositoryState, ReadRunProgress } from "../repository/store.js";
import type { RunnerLog, RunnerTimelineEntry } from "./executor.js";
import { withoutSecretFields } from "../redact/secrets.js";
import { publicExecutionEventPayload } from "../redact/public-model-usage.js";
import { parseWorkflowYAMLStrict, workflowContentHash } from "../parser/workflow.js";
import type { CompiledReadPlan } from "../workflows/compiled-read.js";
import { assertReadFlowCompletion, assertReadValueBoundary, assertSelectedReadNode, skippedActions, controlNodes, structuralNodes, controlPoint, actionOrder, readFlowOutcomes } from "../workflows/read-control-flow.js";
import { validateToolInput } from "../tools/tool-input-schema.js";
import { canonicalJSONBytes } from "../core/canonical-json.js";

export class ReadRunCancelled extends Error {
  constructor() { super("Cancellation requested; no further read calls will start"); }
}
export class ReadCheckpointFailure extends Error {
  constructor(cause: unknown) { super("Read checkpoint could not be committed; execution stopped without replay", { cause }); }
}
export type ReadExecutionHooks = {
  preparing(index: number, nodeId: string, label: string, startedAt: string): Promise<void>;
  dispatchIntent(index: number, nodeId: string, verifiedRole: string): Promise<void>;
  completed(index: number, entry: RunnerTimelineEntry, log: RunnerLog): Promise<void>;
  failed(index: number, entry: RunnerTimelineEntry, log: RunnerLog, knownToolFailure: boolean): Promise<void>;
  condition?(index: number, nodeId: string, predicate: boolean | undefined, verifiedRole: string): Promise<void>;
  skipped?(index: number, nodeId: string, label: string, conditionId: string, selected: "then" | "else", verifiedRole: string): Promise<void>;
  value?(index: number, nodeId: string, kind: "merge" | "return", value: unknown, valid: boolean, verifiedRole: string): Promise<{ value: unknown } | undefined>;
  terminated?(index: number, nodeId: string, label: string, returnId: string, verifiedRole: string): Promise<void>;
};

/** Event and transition share the repository persistence transaction. No raw
 * arguments/output/remote exceptions enter the journal; payloads are references. */
export function appendExecutionEvent(state: RepositoryState, item: Execution, type: string, payload: Record<string, unknown> = {}, nodeId?: string, attemptId?: string): void {
  const progress = item.readProgress;
  if (!progress) throw new Error("Execution has no checkpoint profile");
  const events = state.executionEvents[item.id] ?? [];
  if ((events.at(-1)?.sequence ?? 0) !== progress.lastSequence) throw new Error("Execution event sequence is inconsistent");
  const sequence = ++progress.lastSequence;
  events.push({ version: 1, executionId: item.id, workflowId: item.workflowId, sequence, timestamp: new Date().toISOString(), type,
    ...(item.traceId === undefined ? {} : { traceId: item.traceId }), ...(nodeId === undefined ? {} : { nodeId }),
    ...(attemptId === undefined ? {} : { attemptId }), payload: publicExecutionEventPayload(type, payload) });
  state.executionEvents[item.id] = events;
}

export function newReadProgress(repository: Repository): ReadRunProgress {
  return { profile: "read-progress-v1", epoch: 1, nextStepIndex: 0, lastSequence: 0, persistence: repository.persistence === null ? "memory-only" : "durable", attempts: {} };
}

function appendRunAudit(state: RepositoryState, item: Execution, action: string, system = false): void {
  state.auditLogs.push({ id: `audit-${randomBytes(8).toString("hex")}`, source: "read-checkpoint-executor", actor: system ? { id: "system", name: "Restart reconciliation" } : item.startedBy,
    action, resource: { type: "execution", id: item.id }, before: null, after: { status: item.status, workflowId: item.workflowId },
    createdAt: new Date().toISOString(), ...(item.traceId === undefined ? {} : { traceId: item.traceId }) });
}

export function assertCurrentRunController(state: RepositoryState, execution: Execution, actorId: string, verifiedRole?: string): { id: string; name: string } {
  const actor = state.users[actorId];
  const role = actor && state.roles[actor.roleId];
  const permissions = actor ? [...(role?.permissions ?? []), ...actor.permissionOverrides] : [];
  const workflow = state.workflows[execution.workflowId];
  if (!actor || actor.status.toLowerCase() !== "active" || (verifiedRole !== undefined && role?.name !== verifiedRole) || !workflow || workflow.archived ||
      (!permissions.includes("workflow:run") && (!permissions.includes("workflow:run_own") || execution.startedBy.id !== actorId ||
        (workflow.owner.id !== actorId && !(workflow.assignedUserIds ?? []).includes(actorId)))))
    throw new Error("Current actor cannot control this execution");
  return { id: actor.id, name: actor.name };
}

export class ReadCheckpoints implements ReadExecutionHooks {
  private readonly contentHash: string;
  constructor(readonly repository: Repository, readonly executionId: string, readonly epoch: number, readonly yaml: string, readonly signal?: AbortSignal, readonly semanticHash?: string, readonly compiledPlan?: CompiledReadPlan) { this.contentHash = workflowContentHash(yaml); }
  private current(state: RepositoryState): Execution & { readProgress: ReadRunProgress } {
    const item = state.executions[this.executionId];
    if (!item || item.status !== "RUNNING" || item.readProgress?.profile !== "read-progress-v1" || item.readProgress.epoch !== this.epoch ||
        item.workflowSnapshot?.yaml !== this.yaml || item.workflowSnapshot.contentHash !== this.contentHash || this.semanticHash !== undefined && item.workflowSnapshot.compilation?.semanticHash !== this.semanticHash)
      throw new Error("Read execution is no longer owned by this worker generation");
    if (this.compiledPlan?.ir.schemaVersion === "workflow-read-ir/v4" || item.workflowSnapshot.compilation?.schemaVersion === "workflow-read-ir/v4")
      throw new Error("Collection drafts require durable iteration checkpoints; the legacy worker cannot advance or complete them");
    return item as Execution & { readProgress: ReadRunProgress };
  }
  private async commit<T>(mutation: (state: RepositoryState) => T): Promise<T> {
    try { return await this.repository.mutateExecution(this.executionId, mutation); }
    catch (cause) { if (cause instanceof ReadRunCancelled) throw cause; throw new ReadCheckpointFailure(cause); }
  }
  async preparing(index: number, nodeId: string, label: string, startedAt: string): Promise<void> {
    await this.commit((state) => {
      const item = this.current(state), progress = item.readProgress;
      if (progress.cancellation || this.signal?.aborted) throw new ReadRunCancelled();
      if (progress.nextStepIndex !== index || Object.hasOwn(progress.attempts, nodeId)) throw new Error("Read node cannot be replayed");
      if (Object.values(progress.values ?? {}).some(receipt => receipt.kind === "return" && receipt.status === "DONE")) throw new Error("Workflow already returned");
      if (this.compiledPlan?.ir.flow) assertSelectedReadNode(this.compiledPlan.ir.flow, nodeId, progress.decisions ?? {});
      const attempt = { id: `attempt-${randomBytes(8).toString("hex")}`, nodeId, stepIndex: index, status: "PREPARING" as const, startedAt };
      progress.attempts[nodeId] = attempt;
      (state.timelines[item.id] ??= []).push({ id: `tl_${index + 1}`, nodeId, label, attemptId: attempt.id, status: "RUNNING", phase: "PREPARING", startedAt, completedAt: null, durationMs: 0, sideEffect: false });
      appendExecutionEvent(state, item, "node.preparing", { stepIndex: index }, nodeId, attempt.id);
    });
  }
  async dispatchIntent(index: number, nodeId: string, verifiedRole: string): Promise<void> {
    await this.commit((state) => {
      const item = this.current(state), progress = item.readProgress;
      if (progress.cancellation || this.signal?.aborted) throw new ReadRunCancelled();
      assertCurrentRunController(state, item, item.startedBy.id, verifiedRole);
      if (this.compiledPlan?.ir.flow) assertSelectedReadNode(this.compiledPlan.ir.flow, nodeId, progress.decisions ?? {});
      if (Object.values(progress.values ?? {}).some(receipt => receipt.kind === "return" && receipt.status === "DONE" || receipt.status === "FAILED")) throw new Error("Workflow cannot dispatch after a return or failed typed value");
      const attempt = progress.attempts[nodeId];
      if (!attempt || attempt.stepIndex !== index || attempt.status !== "PREPARING" || progress.nextStepIndex !== index) throw new Error("Invalid dispatch checkpoint");
      attempt.status = "DISPATCH_INTENT"; attempt.dispatchIntentAt = new Date().toISOString();
      const entry = state.timelines[item.id]?.find((entry) => entry.attemptId === attempt.id);
      if (!entry) throw new Error("Missing attempt timeline");
      entry.phase = "DISPATCH_INTENT";
      appendExecutionEvent(state, item, "node.dispatch_intent", { stepIndex: index, outcome: "not_yet_recorded" }, nodeId, attempt.id);
    });
  }
  async completed(index: number, entry: RunnerTimelineEntry, log: RunnerLog): Promise<void> {
    await this.record(index, entry, log, true);
  }
  async failed(index: number, entry: RunnerTimelineEntry, log: RunnerLog, knownToolFailure: boolean): Promise<void> {
    await this.record(index, entry, log, false, knownToolFailure);
  }
  async condition(index: number, nodeId: string, predicate: boolean | undefined, verifiedRole: string): Promise<void> {
    await this.commit(state => {
      const item = this.current(state), progress = item.readProgress, flow = this.compiledPlan?.ir.flow;
      if (progress.cancellation || this.signal?.aborted) throw new ReadRunCancelled();
      assertCurrentRunController(state, item, item.startedBy.id, verifiedRole);
      if (!flow || !controlNodes(flow).some(node => node.id === nodeId) || progress.nextStepIndex !== index || Object.hasOwn(progress.decisions ?? {}, nodeId)) throw new Error("Invalid condition checkpoint");
      if (Object.values(progress.values ?? {}).some(receipt => receipt.kind === "return" && receipt.status === "DONE")) throw new Error("Workflow already returned");
      assertSelectedReadNode(flow, nodeId, progress.decisions ?? {});
      const evaluatedAt = new Date().toISOString(), selected = predicate === undefined ? undefined : predicate ? "then" as const : "else" as const;
      (progress.decisions ??= {})[nodeId] = { status: selected ? "DONE" : "FAILED", ...(selected ? { selected } : {}), evaluatedAt, stepIndex: index };
      (state.timelines[item.id] ??= []).push({ id: `control_${nodeId}`, nodeId, label: `If ${nodeId}`, status: selected ? "DONE" : "FAILED", startedAt: evaluatedAt, completedAt: evaluatedAt, durationMs: 0, sideEffect: false,
        outcome: selected ? "CONDITION_SELECTED" : "NOT_DISPATCHED", ...(selected ? { output: { selectedBranch: selected === "then" ? "If yes" : "If no" } } : {}) });
      appendExecutionEvent(state, item, selected ? "condition.selected" : "condition.failed", { stepIndex: index, selectedBranch: selected ?? null, outcome: "NO_TOOL_DISPATCH" }, nodeId);
    });
  }
  async skipped(index: number, nodeId: string, label: string, conditionId: string, selected: "then" | "else", verifiedRole: string): Promise<void> {
    await this.commit(state => {
      const item = this.current(state), progress = item.readProgress, flow = this.compiledPlan?.ir.flow;
      if (progress.cancellation || this.signal?.aborted) throw new ReadRunCancelled();
      assertCurrentRunController(state, item, item.startedBy.id, verifiedRole);
      const decision = progress.decisions?.[conditionId];
      if (!flow || decision?.status !== "DONE" || decision.selected !== selected || !skippedActions(flow, conditionId, selected).includes(nodeId) || progress.nextStepIndex !== index || Object.hasOwn(progress.attempts, nodeId)) throw new Error("Invalid branch skip checkpoint");
      const timestamp = new Date().toISOString(), id = `attempt-${randomBytes(8).toString("hex")}`;
      progress.attempts[nodeId] = { id, nodeId, stepIndex: index, status: "SKIPPED", startedAt: timestamp, completedAt: timestamp };
      (state.timelines[item.id] ??= []).push({ id: `tl_${index + 1}`, nodeId, label, attemptId: id, status: "SKIPPED", outcome: "NOT_SELECTED", startedAt: timestamp, completedAt: timestamp, durationMs: 0, sideEffect: false, conditionId, selectedBranch: selected });
      progress.nextStepIndex = index + 1;
      appendExecutionEvent(state, item, "node.skipped", { stepIndex: index, conditionId, selectedBranch: selected, outcome: "NOT_DISPATCHED" }, nodeId, id);
    });
  }
  async value(index: number, nodeId: string, kind: "merge" | "return", value: unknown, valid: boolean, verifiedRole: string): Promise<{ value: unknown } | undefined> {
    return this.commit(state => {
      const item = this.current(state), progress = item.readProgress, flow = this.compiledPlan?.ir.flow;
      if (progress.cancellation || this.signal?.aborted) throw new ReadRunCancelled();
      assertCurrentRunController(state, item, item.startedBy.id, verifiedRole);
      const node = flow && structuralNodes(flow).find(node => node.id === nodeId);
      if (!flow || !node || kind === "merge" && (node.kind !== "if" || !node.merge || progress.decisions?.[nodeId]?.status !== "DONE") || kind === "return" && node.kind !== "return" ||
          progress.nextStepIndex !== index || controlPoint(flow, nodeId, kind === "merge") !== index || Object.hasOwn(progress.values ?? {}, nodeId) ||
          Object.values(progress.values ?? {}).some(receipt => receipt.kind === "return" && receipt.status === "DONE" || receipt.status === "FAILED") || Object.values(progress.attempts).some(attempt => !["DONE", "SKIPPED"].includes(attempt.status))) throw new Error("Invalid typed value checkpoint");
      assertSelectedReadNode(flow, nodeId, progress.decisions ?? {});
      if (node.kind === "if" && [...actionOrder(node.then), ...actionOrder(node.else)].some(id => !progress.attempts[id])) throw new Error("Merge lacks branch checkpoints");
      assertReadValueBoundary(flow, nodeId, kind, progress.decisions ?? {}, progress.attempts, progress.values ?? {});
      if (node.kind !== "return" && node.kind !== "if") throw new Error("Value requires its separately qualified checkpoints");
      const schema = node.kind === "return" ? node.output.schema : node.merge!.schema;
      if (valid && validateToolInput(schema, value).length) throw new Error("Typed value does not match its contract");
      let safe = valid ? withoutSecretFields({ value }) as { value: unknown } : undefined;
      if (safe && validateToolInput(schema, safe.value).length) { valid = false; safe = undefined; }
      const timestamp = new Date().toISOString();
      (progress.values ??= {})[nodeId] = { kind, status: valid ? "DONE" : "FAILED", stepIndex: index, completedAt: timestamp };
      if (safe) { (item.valueOutputs ??= {})[nodeId] = safe; if (kind === "return") item.finalOutput = safe.value; }
      (state.timelines[item.id] ??= []).push({ id: `value_${nodeId}`, nodeId, label: `${kind === "merge" ? "Merge" : "Return"} ${nodeId}`, status: valid ? "DONE" : "FAILED", outcome: valid ? kind === "merge" ? "VALUE_MERGED" : "WORKFLOW_RETURNED" : "VALUE_INVALID", sideEffect: false, startedAt: timestamp, completedAt: timestamp, durationMs: 0, ...(safe ? { output: safe } : {}) });
      appendExecutionEvent(state, item, valid ? `value.${kind}_completed` : "value.failed", { stepIndex: index, kind, outcome: "NO_TOOL_DISPATCH", outputRef: safe ? nodeId : null }, nodeId);
      return safe;
    });
  }
  async terminated(index: number, nodeId: string, label: string, returnId: string, verifiedRole: string): Promise<void> {
    await this.commit(state => {
      const item = this.current(state), progress = item.readProgress, flow = this.compiledPlan?.ir.flow, receipt = progress.values?.[returnId];
      if (progress.cancellation || this.signal?.aborted) throw new ReadRunCancelled();
      assertCurrentRunController(state, item, item.startedBy.id, verifiedRole);
      if (!flow || receipt?.kind !== "return" || receipt.status !== "DONE" || !actionOrder(flow).includes(nodeId) || progress.nextStepIndex !== index || index < controlPoint(flow, returnId) || Object.hasOwn(progress.attempts, nodeId)) throw new Error("Invalid return skip checkpoint");
      const expected = readFlowOutcomes(flow, progress.decisions ?? {}, progress.values ?? {}).skipped.get(nodeId);
      if (expected?.kind !== "return" || expected.returnId !== returnId) throw new Error("Action was not skipped by this return");
      const timestamp = new Date().toISOString(), id = `attempt-${randomBytes(8).toString("hex")}`;
      progress.attempts[nodeId] = { id, nodeId, stepIndex: index, status: "SKIPPED", startedAt: timestamp, completedAt: timestamp };
      (state.timelines[item.id] ??= []).push({ id: `tl_${index + 1}`, nodeId, label, attemptId: id, status: "SKIPPED", outcome: "AFTER_RETURN", returnId, startedAt: timestamp, completedAt: timestamp, durationMs: 0, sideEffect: false });
      progress.nextStepIndex = index + 1;
      appendExecutionEvent(state, item, "node.skipped", { stepIndex: index, returnId, outcome: "NOT_DISPATCHED" }, nodeId, id);
    });
  }
  private async record(index: number, entry: RunnerTimelineEntry, log: RunnerLog, done: boolean, knownToolFailure = false): Promise<void> {
    await this.commit((state) => {
      const item = this.current(state), progress = item.readProgress, attempt = progress.attempts[entry.nodeId];
      if (!attempt || attempt.stepIndex !== index || progress.nextStepIndex !== index || !["PREPARING", "DISPATCH_INTENT"].includes(attempt.status)) throw new Error("Invalid completion checkpoint");
      if (done && attempt.status !== "DISPATCH_INTENT") throw new Error("Completed read lacks a dispatch checkpoint");
      attempt.status = done ? "DONE" : attempt.status === "DISPATCH_INTENT" && !knownToolFailure ? "UNKNOWN" : "FAILED";
      attempt.completedAt = entry.completedAt;
      const entries = state.timelines[item.id] ?? [], position = entries.findIndex((value) => value.attemptId === attempt.id);
      if (position < 0) throw new Error("Missing attempt timeline");
      entries[position] = { ...withoutSecretFields(entry) as Record<string, unknown>, status: attempt.status === "UNKNOWN" ? "UNKNOWN" : entry.status, attemptId: attempt.id, outcome: attempt.status, ...(item.traceId === undefined ? {} : { traceId: item.traceId }) };
      const logs = state.executionLogs[item.id] ??= [];
      logs.push({ ...log, id: `log_${logs.length + 1}`, executionId: item.id, attemptId: attempt.id, ...(item.traceId === undefined ? {} : { traceId: item.traceId }) });
      if (done) {
        (item.stepOutputs ??= {})[entry.nodeId] = withoutSecretFields(entry.output);
        item.finalOutput = withoutSecretFields(entry.output);
        progress.nextStepIndex = index + 1;
      }
      appendExecutionEvent(state, item, done ? "node.completed" : attempt.status === "UNKNOWN" ? "node.outcome_unknown" : "node.failed", { stepIndex: index, outcome: attempt.status, outputRef: done ? entry.nodeId : null }, entry.nodeId, attempt.id);
    });
  }
  async finish(failed: boolean, preflightDiagnostic?: { code: string; stage: string; message: string; retryable: boolean }): Promise<Execution> {
    return this.commit((state) => {
      const item = this.current(state), progress = item.readProgress;
      const unknown = Object.values(progress.attempts).find((attempt) => attempt.status === "UNKNOWN");
      const stopped = Object.values(progress.attempts).findLast((attempt) => attempt.status === "FAILED");
      item.status = unknown ? "RECOVERY_REQUIRED" : progress.cancellation || this.signal?.aborted ? "CANCELLED" : failed ? "FAILED" : "DONE";
      if (item.status === "DONE" && (progress.nextStepIndex !== parseWorkflowYAMLStrict(this.yaml).steps.length || Object.values(progress.attempts).some((attempt) => !["DONE", ...(this.compiledPlan?.ir.flow ? ["SKIPPED"] : [])].includes(attempt.status))))
        throw new Error("Cannot complete a read run with missing or unconfirmed node checkpoints");
      if (item.status === "DONE" && this.compiledPlan?.ir.flow) assertReadFlowCompletion(this.compiledPlan.ir.flow, progress.decisions ?? {}, progress.attempts, progress.values ?? {});
      if (item.status === "DONE" && this.compiledPlan?.ir.flow) {
        const flow = this.compiledPlan.ir.flow, outcomes = readFlowOutcomes(flow, progress.decisions ?? {}, progress.values ?? {});
        if (Object.keys(item.valueOutputs ?? {}).some(id => !outcomes.valueIDs.has(id))) throw new Error("Unexpected typed output");
        for (const id of outcomes.valueIDs) {
          const node = structuralNodes(flow).find(node => node.id === id), output = item.valueOutputs?.[id];
          const schema = node?.kind === "return" ? node.output.schema : node?.kind === "if" ? node.merge?.schema : undefined;
          if (!schema || !output || !Object.hasOwn(output, "value") || validateToolInput(schema, output.value).length || !state.timelines[item.id]?.some(entry => entry.nodeId === id && entry.status === "DONE" && entry.outcome === (node?.kind === "return" ? "WORKFLOW_RETURNED" : "VALUE_MERGED"))) throw new Error("Typed checkpoint lacks a confirmed contract-valid saved output");
          if (node?.kind === "return" && (!Object.hasOwn(item, "finalOutput") || canonicalJSONBytes(item.finalOutput).toString() !== canonicalJSONBytes(output.value).toString())) throw new Error("Final output does not match the confirmed return");
        }
      }
      if (item.status === "DONE" && this.compiledPlan?.ir.flow) for (const [nodeId, reason] of readFlowOutcomes(this.compiledPlan.ir.flow, progress.decisions ?? {}, progress.values ?? {}).skipped) {
        const entry = state.timelines[item.id]?.find(entry => entry.nodeId === nodeId && entry.status === "SKIPPED");
        if (reason.kind === "empty-collection") throw new Error("Collection completion requires iteration checkpoints");
        if (!entry || (reason.kind === "return" ? entry.outcome !== "AFTER_RETURN" || entry.returnId !== reason.returnId : entry.outcome !== "NOT_SELECTED" || entry.conditionId !== reason.conditionId || entry.selectedBranch !== reason.selected)) throw new Error("Skip receipt does not match the confirmed structural reason");
      }
      if (item.status === "DONE" && ["workflow-read-ir/v2", "workflow-read-ir/v3"].includes(item.workflowSnapshot?.compilation?.schemaVersion ?? "") && !this.compiledPlan?.ir.flow) throw new Error("Structured completion requires the pinned compiled flow");
      item.completedAt = new Date().toISOString(); item.durationMs = Math.max(0, Date.parse(item.completedAt) - Date.parse(item.startedAt));
      if (item.status === "CANCELLED") {
        for (const attempt of Object.values(progress.attempts)) if (attempt.status === "PREPARING") {
          attempt.status = "CANCELLED"; attempt.completedAt = item.completedAt;
          const entry = state.timelines[item.id]?.find((entry) => entry.attemptId === attempt.id);
          if (entry) { entry.status = "CANCELLED"; entry.completedAt = item.completedAt; entry.durationMs = Math.max(0, Date.parse(item.completedAt) - Date.parse(attempt.startedAt)); entry.outcome = "NOT_DISPATCHED"; }
          appendExecutionEvent(state, item, "node.cancelled", { outcome: "NOT_DISPATCHED" }, attempt.nodeId, attempt.id);
        }
        item.agentSummary = "Cancellation was observed at a read boundary. No further reads will start; confirmed saved answers are retained. This does not confirm that remote processing stopped.";
      } else item.agentSummary = item.status === "DONE" ? "Published read workflow completed with deterministic execution." : "Read workflow stopped. No automatic replay was performed; saved completed answers are retained.";
      if (item.status === "RECOVERY_REQUIRED") progress.recoveryReason = "READ_OUTCOME_UNKNOWN";
      if (failed || unknown) item.failure = { failureCategory: unknown ? "READ_OUTCOME_UNKNOWN" : "READ_EXECUTION_FAILED", failedStepId: unknown?.nodeId ?? stopped?.nodeId ?? Object.entries(progress.values ?? {}).findLast(([, value]) => value.status === "FAILED")?.[0] ?? Object.entries(progress.decisions ?? {}).findLast(([, decision]) => decision.status === "FAILED")?.[0] ?? "preflight" };
      if (item.failure) {
        const log = (state.executionLogs[item.id] ?? []).findLast(log => log.nodeId === item.failure!.failedStepId && log.level === "error");
        const metadata = log?.metadata as { action?: string; diagnostic?: { code: string; stage: string; message: string; retryable: boolean } } | undefined;
        const diagnostic = metadata?.diagnostic ?? preflightDiagnostic;
        if (diagnostic) Object.assign(item.failure, { reason: diagnostic.message, code: diagnostic.code,
          stage: diagnostic.stage, retryable: diagnostic.retryable, ...(metadata?.action ? { failedToolName: metadata.action } : {}),
          timestamp: log?.timestamp ?? item.completedAt, workflowId: item.workflowId, executionId: item.id });
      }
      appendExecutionEvent(state, item, item.status === "RECOVERY_REQUIRED" ? "run.recovery_required" : "run.completed", { status: item.status, nextStepIndex: progress.nextStepIndex });
      appendRunAudit(state, item, "execution.completed");
      return structuredClone(item);
    });
  }
}

/** Startup/reconciliation NEVER dispatches or replays. Completed checkpoints
 * stay immutable; an unacknowledged dispatch intent is explicitly uncertain. */
export async function reconcileInterruptedExecutions(repository: Repository, reason = "PROCESS_RESTARTED", onlyId?: string, expectedEpoch?: number): Promise<void> {
  const reconcile = (state: RepositoryState) => {
    const timestamp = new Date().toISOString();
    for (const item of Object.values(state.executions)) {
      if (item.status !== "RUNNING" || (onlyId !== undefined && item.id !== onlyId) || (expectedEpoch !== undefined && item.readProgress?.epoch !== expectedEpoch)) continue;
      reconcileReadExecution(state, item, reason, timestamp);
    }
  };
  if (onlyId !== undefined) await repository.mutateExecution(onlyId, reconcile);
  else await repository.mutate(reconcile);
}

/** Denial-only reconciliation inside an already owned transaction. Never
 * reclaims a lease, deletes a confirmed answer, or starts a tool call. */
export function reconcileReadExecution(state: RepositoryState, item: Execution, reason: string, timestamp: string): void {
      if (item.status !== "RUNNING") return;
      const progress = item.readProgress;
      item.status = "RECOVERY_REQUIRED";
      item.completedAt = timestamp; item.durationMs = Math.max(0, Date.parse(timestamp) - Date.parse(item.startedAt));
      if (progress) {
        progress.epoch += 1; progress.recoveryReason = reason;
        if (item.iterationProgress) { item.iterationProgress.interruptedAt = timestamp; item.iterationProgress.recoveryReason = reason; }
        for (const attempt of Object.values(progress.attempts)) if (attempt.status === "DISPATCH_INTENT" || attempt.status === "PREPARING") {
          const uncertain = attempt.status === "DISPATCH_INTENT";
          attempt.status = uncertain ? "UNKNOWN" : "FAILED"; attempt.completedAt = timestamp;
          const entry = state.timelines[item.id]?.find((entry) => entry.attemptId === attempt.id);
          if (entry) { entry.status = uncertain ? "UNKNOWN" : "FAILED"; entry.completedAt = timestamp; entry.outcome = uncertain ? "UNKNOWN" : "NOT_DISPATCHED"; entry.durationMs = Math.max(0, Date.parse(timestamp) - Date.parse(attempt.startedAt)); }
          appendExecutionEvent(state, item, uncertain ? "node.outcome_unknown" : "node.interrupted", { outcome: uncertain ? "UNKNOWN" : "NOT_DISPATCHED", reason, ...(attempt.invocationId ? { invocationId: attempt.invocationId, iterations: attempt.iterations ?? [] } : {}) }, attempt.nodeId, attempt.id);
        }
        const unknown = Object.values(progress.attempts).find((attempt) => attempt.status === "UNKNOWN");
        const stopped = Object.values(progress.attempts).findLast((attempt) => attempt.status === "FAILED");
        const interrupted = unknown ?? stopped;
        item.failure = { failureCategory: unknown ? "READ_OUTCOME_UNKNOWN" : "READ_INTERRUPTED", failedStepId: interrupted?.nodeId ?? "checkpoint", ...(interrupted?.invocationId ? { failedInvocationId: interrupted.invocationId } : {}), reason };
        appendExecutionEvent(state, item, "run.recovery_required", { status: item.status, reason, nextStepIndex: progress.nextStepIndex });
      } else item.failure = { failureCategory: "LEGACY_OUTCOME_UNKNOWN", failedStepId: "unknown", reason };
      appendRunAudit(state, item, "execution.recovery_required", true);
      item.agentSummary = "Execution was interrupted. Saved completed node answers are retained; unacknowledged attempts are not replayed.";
      (state.executionLogs[item.id] ??= []).push({ id: `log_${(state.executionLogs[item.id]?.length ?? 0) + 1}`, executionId: item.id, timestamp, level: "error", nodeId: "system", message: item.agentSummary, metadata: { reason } });
}
