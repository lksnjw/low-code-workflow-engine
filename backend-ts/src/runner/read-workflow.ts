import { type WorkflowBlueprint } from "../models/schemas.js";
import type { ToolDefinition } from "../registry/schemas.js";
import { parseWorkflowYAMLStrict } from "../parser/workflow.js";
import { buildReadIR, compileReadWorkflow, resolveReadBinding, assertCompiledReadMatches, type CompiledReadPlan } from "../workflows/compiled-read.js";
import { validateToolInput } from "../tools/tool-input-schema.js";
import { acknowledgedReadToolFailure, dispatchReadTool, type ReadDispatchContext } from "../tools/read-tool-broker.js";
import type { HandlerServices } from "../http/handlers/common.js";
import type { ValidationToken } from "../validator/registry-validator.js";
import type { RunnerResult } from "./executor.js";
import { ReadCheckpointFailure, ReadRunCancelled, type ReadExecutionHooks } from "./read-checkpoints.js";
import { valueNodes } from "../workflows/read-control-flow.js";
import { interpretReadPlan } from "../workflows/read-interpreter.js";
import { ReadWorkerLeaseFailure } from "./read-worker-lease.js";
import { connectionToolKey } from "../tools/mcp-dispatch-context.js";
import { readFailureReason } from "./read-failure-reason.js";

/** Explicit read profiles: sequential actions and structured boolean branches. Unsupported logic
 * is rejected before any dispatch, never reinterpreted by an agent. */
export function inspectReadWorkflow(blueprint: WorkflowBlueprint, tools: readonly ToolDefinition[], role: string, allowCollections = false): string[] {
  const built = buildReadIR(blueprint, tools, role);
  return [...built.issues, ...(built.ir.schemaVersion === "workflow-read-ir/v4" && !allowCollections ? ["Collection execution requires reviewed SDK entry and qualified private record storage; fixture simulation remains available"] : [])];
}

export async function executeReadWorkflow(services: HandlerServices, actorId: string, yaml: string, input: Record<string, unknown>, token: ValidationToken,
  context: Omit<ReadDispatchContext, "plan" | "beforeDispatch">, hooks?: ReadExecutionHooks, expectedPlan?: CompiledReadPlan): Promise<RunnerResult> {
  if (yaml.length > 200_000) throw new Error("Read workflow exceeds supported source size");
  const blueprint = parseWorkflowYAMLStrict(yaml);
  const actor = await services.repository.effectiveUser(actorId);
  if (actor === null || inspectReadWorkflow(blueprint, services.registries.snapshot().tools, actor.role).length > 0)
    throw new Error("Read workflow does not meet the supported execution profile");
  const pins = new Map<string, NonNullable<CompiledReadPlan["ir"]["root"]["nodes"][number]["capability"]["admission"]>>();
  expectedPlan?.ir.root.nodes.forEach((node, index) => { const pin = node.capability.admission; if (!pin) return;
    pins.set(connectionToolKey(pin.connectionId, node.capability.toolId), pin); if (!blueprint.steps[index]?.connection_id) pins.set(node.capability.toolId, pin); });
  const currentPlan = compileReadWorkflow(yaml, services.registries.snapshot().tools, actor.role, pins);
  if (services.erpbridgeSession?.requiresReviewedRevision && !expectedPlan) throw new Error("Modern workflow execution requires a published compiled artifact");
  if (expectedPlan) assertCompiledReadMatches(expectedPlan, currentPlan);
  const plan = expectedPlan ?? currentPlan;
  if (plan.ir.flow && valueNodes(plan.ir.flow).length && (!hooks?.value || !hooks?.terminated)) throw new Error("Typed read values require checkpointed execution");
  if (plan.ir.inputSchema && validateToolInput(plan.ir.inputSchema, input).length) throw new Error("Workflow input does not meet the declared schema");
  const result: RunnerResult = { state: { input: structuredClone(input) }, timeline: [], logs: [], tokens: { input: 0, output: 0, total: 0 } };
  async function runAction(node: CompiledReadPlan["ir"]["root"]["nodes"][number], index: number) {
    const step = blueprint.steps[index]!; // Labels only; executable order/inputs come from IR.
    const started = new Date();
    try {
      if (context.signal?.aborted) throw new ReadRunCancelled();
      await hooks?.preparing(index, step.id, step.description ?? step.action!, started.toISOString());
      const args = resolveReadBinding(node.inputs, result.state) as Record<string, unknown>;
      const admissionPin = node.capability.admission;
      const output = await dispatchReadTool(services, actorId, node.capability.action, args, { ...context, plan: { yaml, stepIndex: index, token, contractHash: node.capability.contractHash, toolId: node.capability.toolId, ...(admissionPin ? { admissionPin } : {}) },
        ...(hooks === undefined ? {} : { beforeDispatch: (role: string) => hooks.dispatchIntent(index, step.id, role) }) });
      const completed = new Date();
      const entry = { id: `tl_${index + 1}`, nodeId: step.id, label: step.description ?? step.action!, status: "DONE" as const, startedAt: started.toISOString(), completedAt: completed.toISOString(), durationMs: completed.getTime() - started.getTime(), sideEffect: false, output };
      const log = { timestamp: completed.toISOString(), level: "info" as const, nodeId: step.id, message: "Verified read completed", metadata: { action: step.action!, sideEffect: false } };
      // A result is not exposed to the next node until its checkpoint commits.
      await hooks?.completed(index, entry, log);
      result.timeline.push(entry); result.logs.push(log);
      return output;
    } catch (cause) {
      if (cause instanceof ReadCheckpointFailure || cause instanceof ReadRunCancelled || cause instanceof ReadWorkerLeaseFailure) {
        Object.defineProperty(cause, "runnerResult", { value: result }); throw cause;
      }
      const completed = new Date();
      // Do not reflect arbitrary remote exception strings/credentials to users.
      const error = new Error(`Read step ${step.id} failed or was blocked; no automatic replay was performed`, { cause });
      const failure = acknowledgedReadToolFailure(cause);
      // A failure receipt belongs to this attempt, never stepOutputs/finalOutput
      // or a dependent node's successful data bindings.
      const entry = { id: `tl_${index + 1}`, nodeId: step.id, label: step.description ?? step.action!, status: "FAILED" as const, startedAt: started.toISOString(), completedAt: completed.toISOString(), durationMs: completed.getTime() - started.getTime(), sideEffect: false,
        ...(failure ? { output: failure.result } : {}) };
      const log = { timestamp: completed.toISOString(), level: "error" as const, nodeId: step.id, message: error.message,
        metadata: { action: step.action!, sideEffect: false, failureCode: readFailureReason(cause) } };
      await hooks?.failed(index, entry, log, failure !== undefined);
      result.timeline.push(entry); result.logs.push(log);
      Object.defineProperty(error, "runnerResult", { value: result });
      throw error;
    }
  }
  await interpretReadPlan(plan, result.state, {
    beforeNode: () => { if (context.signal?.aborted) throw new ReadRunCancelled(); },
    action: runAction,
    condition: async (index, id, value) => {
      if (hooks && !hooks.condition) throw new Error("Conditional execution requires decision checkpoints");
      await hooks?.condition?.(index, id, value, actor.role);
    },
    skipped: async (index, id, reason) => {
      const step = blueprint.steps[index]!;
      if (reason.kind === "empty-collection") throw new Error("Collection skips require iteration checkpoints");
      if (reason.kind === "return") await hooks!.terminated!(index, id, step.description ?? step.action!, reason.returnId, actor.role);
      else {
        if (hooks && !hooks.skipped) throw new Error("Conditional execution requires skip checkpoints");
        await hooks?.skipped?.(index, id, step.description ?? step.action!, reason.conditionId, reason.selected, actor.role);
      }
    },
    value: (index, id, kind, value, valid) => {
      if (kind === "collection" || kind === "collection-item") throw new Error("Collection values require iteration checkpoints");
      return hooks!.value!(index, id, kind, value, valid, actor.role);
    },
  });
  return result;
}
