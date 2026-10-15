import type { HandlerServices } from "../http/handlers/common.js";
import { assertErpnextWriteReceipt } from "../tools/erpnext-document-write.js";
import { validateWorkflow } from "../http/handlers/common.js";
import type { RepositoryState } from "../repository/store.js";
import type { ValidationToken } from "../validator/registry-validator.js";
import type { ProtectedMachinePoint } from "../workflows/protected-machine-state.js";
import { parseWorkflowYAMLStrict } from "../parser/workflow.js";
import { validateToolInput } from "../tools/tool-input-schema.js";
import { consumeAcknowledgedProtectedEffectResult } from "../tools/erpbridge-mcp-client.js";
import { issueProtectedOperationDispatchPermit, retireProtectedOperationDispatchPermit, type ProtectedOperationDispatchPermit } from "../tools/protected-operation-dispatch-permit.js";
import { exactBridgeName } from "../tools/erpbridge-contract.js";
import { ownedProtectedEffectContext, protectedEffectPrerequisiteYAML } from "./protected-effect-context.js";
import { enterOwnedProtectedEffect } from "./protected-effect-consumption.js";
import { protectedHash as hash, sealProtectedCursor, type ProtectedJobOwner } from "./protected-job-state.js";
import { appendExecutionEvent } from "./read-checkpoints.js";

/** Owned effect driver. No caller-supplied arguments, approval, result or
 * callback can mint SDK evidence. Any entered uncertainty stops the worker. */
export async function executeOwnedProtectedEffect(services: HandlerServices, executionId: string, options: {
  owner: ProtectedJobOwner; token: ValidationToken; signal: AbortSignal; guard: () => void;
  advance: (state: RepositoryState, point: ProtectedMachinePoint, output: Record<string, unknown>) => void;
}): Promise<void> {
  let permit: ProtectedOperationDispatchPermit | undefined;
  try {
    const prepared = await services.repository.readAuthoritative(state => {
      options.guard();
      const value = ownedProtectedEffectContext(state, services, executionId, options.owner, "APPROVED"), { saved, context, record, definition } = value;
      const args = structuredClone(context.point.arguments) as Record<string, unknown>;
      if (validateToolInput(definition.input_schema, args).length || !definition.bridge_contract?.output_schema ||
          saved.plan.ir.contracts[definition.tool_id]?.reportCoverageContract ||
          !services.validator.validatePlan("ProtectedEffectConfirmedPath", protectedEffectPrerequisiteYAML(value), value.identity.localRole).passed)
        throw new Error("Protected effect lacks exact valid arguments and confirmed process prerequisites");
      const yaml = saved.run.workflowSnapshot!.yaml, index = parseWorkflowYAMLStrict(yaml).steps.findIndex(step => step.id === context.point.nodeId);
      if (index < 0) throw new Error("Protected effect source node disappeared");
      return { point: structuredClone(context.point), definition: structuredClone(definition), args, identity: value.identity, session: value.bound.session,
        approvalId: record.id, intentKey: record.binding.intentKey, action: context.node.capability.action, yaml, index, workflowId: saved.run.workflowId, pin: structuredClone(context.node.capability.admission!) };
    });
    const actor = await services.repository.effectiveUser(prepared.identity.userId);
    if (!actor || actor.role !== prepared.identity.localRole || actor.status.toLowerCase() !== "active") throw new Error("Protected effect actor changed");
    const gate = await validateWorkflow(services, "ProtectedEffectBroker", prepared.yaml, actor,
      { workflowId: prepared.workflowId, executionId, signal: options.signal });
    if (!gate.result.passed || !gate.token || !services.validator.verifyToken(gate.token)) throw new Error("Protected effect deterministic verification failed");
    const resolved = await services.validator.evaluateResolvedStep(executionId, prepared.yaml, prepared.index, prepared.args, options.token, prepared.identity,
      { workflowId: prepared.workflowId, executionId, actor: { id: actor.id, role: actor.role } });
    if (!resolved.capability || resolved.violation) throw new Error("Protected effect lacks a genuine exact argument capability");
    await prepared.session.assertAdmission?.(prepared.definition, prepared.pin, options.signal);
    await services.repository.readAuthoritative(state => {
      options.guard();
      const value = ownedProtectedEffectContext(state, services, executionId, options.owner, "APPROVED");
      if (value.record.id !== prepared.approvalId || hash(value.context.point) !== hash(prepared.point) || hash(value.identity) !== hash(prepared.identity) ||
          value.bound.session !== prepared.session || !services.validator.validatePlan("ProtectedEffectConfirmedPath", protectedEffectPrerequisiteYAML(value), value.identity.localRole).passed)
        throw new Error("Protected effect facts changed while verification awaited");
    });
    const ticket = await enterOwnedProtectedEffect(services, executionId, options.owner, options.guard);
    permit = await issueProtectedOperationDispatchPermit(ticket, options.guard);
    options.guard();
    const result = await prepared.session.clientFor(prepared.definition, prepared.pin).execute(prepared.action, resolved.capability,
      prepared.args, prepared.identity, options.signal, undefined, options.guard, permit);
    const evidence = consumeAcknowledgedProtectedEffectResult(result, permit, prepared.definition, prepared.args, prepared.identity);
    if (!evidence || result.isError === true || validateToolInput(prepared.definition.bridge_contract!.output_schema, evidence.result.structuredContent).length)
      throw new Error("Protected effect has no genuine contract-valid governed SDK completion");
    assertErpnextWriteReceipt(prepared.definition, prepared.args, evidence.result.structuredContent);
    let confirmation: unknown = evidence.result.structuredContent;
    for (const part of prepared.definition.operation_contract!.confirmation.path)
      confirmation = confirmation && typeof confirmation === "object" && !Array.isArray(confirmation) && Object.hasOwn(confirmation, part)
        ? (confirmation as Record<string, unknown>)[part] : undefined;
    if (confirmation !== prepared.definition.operation_contract!.confirmation.expected) throw new Error("Protected effect returned no exact operation confirmation");
    await services.repository.mutateExecution(executionId, state => {
      options.guard();
      const value = ownedProtectedEffectContext(state, services, executionId, options.owner, "CONSUMED"), { saved, record } = value;
      if (record.id !== prepared.approvalId || hash(value.context.point) !== hash(prepared.point) || value.bound.session !== prepared.session ||
          hash(value.identity) !== hash(prepared.identity)) throw new Error("Protected effect completion lost its current owned context");
      saved.ledger.acknowledgeOutput(saved.machine, prepared.intentKey, evidence.result, options.owner.epoch);
      saved.run.protectedInvocationSecret = saved.ledger.snapshot();
      record.sdkReceipt = { profile: "protected-sdk-receipt/v1", intentId: record.binding.intentId, epoch: options.owner.epoch,
        outputHash: hash(evidence.result), contractHash: record.binding.admission.contractHash, connectionBinding: record.binding.connectionBinding,
        identity: prepared.identity, remoteName: exactBridgeName(prepared.definition), resourceVersion: prepared.definition.bridge_contract!.resource_version,
        resourceDigest: prepared.definition.bridge_contract!.resource_digest, meaning: prepared.definition.operation_contract!.confirmation.meaning, completedAt: evidence.completedAt };
      const timeline = state.timelines[executionId]?.find(item => item.approvalId === record.id);
      if (timeline) Object.assign(timeline, { status: "DONE", outcome: record.sdkReceipt.meaning, completedAt: evidence.completedAt });
      sealProtectedCursor(services, state, saved.run, saved.machine);
      appendExecutionEvent(state, saved.run, "node.protected_effect_completed", { invocationId: prepared.point.invocationId, approvalId: record.id,
        outcome: record.sdkReceipt.meaning }, prepared.point.nodeId, prepared.point.invocationId);
      options.advance(state, prepared.point, evidence.result);
    });
  } finally { if (permit) retireProtectedOperationDispatchPermit(permit); }
}
