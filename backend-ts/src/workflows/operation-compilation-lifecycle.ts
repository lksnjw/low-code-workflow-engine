import type { CurrentUser, HandlerServices } from "../http/handlers/common.js";
import { HandlerFailure } from "../http/handlers/common.js";
import type { RepositoryState, StoredRecord } from "../repository/store.js";
import { parseWorkflowYAMLStrict } from "../parser/workflow.js";
import { canonicalJSONBytes } from "../core/canonical-json.js";
import { captureCapabilityAdmissionPin, captureReadAdmissionPin, reviewedCapabilityDataClass } from "../registry/capability-admission.js";
import { discoverTools } from "../agent/tool-discovery.js";
import { compileOperationWorkflow, operationCompilationReceipt, type CompiledOperationPlan, type OperationCompilationReceipt, type ReadAdmissionPin } from "./compiled-read.js";
import { effectiveStepKind, type WorkflowStepBlueprint } from "../models/schemas.js";
import { boundMcpConnection, connectionToolKey, selectedMcpConnectionId, type BoundMcpConnection } from "../tools/mcp-dispatch-context.js";
import { usesCheckpointedOperationWorkflow } from "./execution-shape.js";
import { assertModelDataClassification, ModelDataClassViolation } from "./model-data-classification.js";
import { protectedOperationProfile } from "./protected-operation-profile.js";

/** Never promote collection drafts to once-only action execution. Other
 * protected trees still require exact v8 compilation and owned dispatch. */
function assertProtectedRuntimeQualified(source: { metadata?: Record<string, unknown> | undefined }) {
  if (protectedOperationProfile(source) === "protected-collections-pending")
    throw new HandlerFailure(422, "Protected collections can be saved and edited, but durable operation iteration is not qualified yet", { code: "PROTECTED_COLLECTION_RUNTIME_PENDING" });
}

export type StoredOperationCompilation = { plan: CompiledOperationPlan; receipt: OperationCompilationReceipt; verifiedRole: string; compiledAt: string };
type PreparedConnection = BoundMcpConnection & { generation: number };
export type PreparedOperationCompilation = { stored: StoredOperationCompilation; connections: PreparedConnection[] };

function stepConnection(services: HandlerServices, step: WorkflowStepBlueprint) {
  return selectedMcpConnectionId(services, step.connection_id);
}
function savePin(pins: Map<string, ReadAdmissionPin>, step: WorkflowStepBlueprint, pin: ReadAdmissionPin, toolId: string) {
  pins.set(connectionToolKey(pin.connectionId, toolId), pin);
  if (!step.connection_id) pins.set(toolId, pin);
}
function preparedConnections(services: HandlerServices, steps: readonly WorkflowStepBlueprint[]): PreparedConnection[] {
  const ids = new Set(steps.filter(step => effectiveStepKind(step) !== "analysis").map(step => stepConnection(services, step)));
  return [...ids].sort().map(id => { const bound = boundMcpConnection(services, id); return { ...bound, generation: bound.session.discoveryGeneration ?? 0 }; });
}
function assertConnectionsCurrent(services: HandlerServices, connections: readonly PreparedConnection[]) {
  for (const expected of connections) {
    const current = boundMcpConnection(services, expected.id);
    if (current.session !== expected.session || (current.session.discoveryGeneration ?? 0) !== expected.generation ||
        !canonicalJSONBytes(current.roleMap).equals(canonicalJSONBytes(expected.roleMap))) throw new Error("Operation connection context changed");
  }
}
function compileCurrent(state: Readonly<RepositoryState>, services: HandlerServices, yaml: string, role: string, expected?: CompiledOperationPlan) {
  const source = parseWorkflowYAMLStrict(yaml), tools = services.registries.snapshot().tools, pins = new Map<string, ReadAdmissionPin>();
  assertProtectedRuntimeQualified(source);
  for (const step of source.steps) {
    if (effectiveStepKind(step) === "analysis") continue;
    const connectionId = stepConnection(services, step), { session } = boundMcpConnection(services, connectionId);
    if (!session.requiresReviewedRevision || session.dispatchBoundary !== "sdk-entry/v1" || !session.admissionBinding || session.available === false)
      throw new Error("Operations require a connected reviewed SDK-entry ERPBridge session");
    if (effectiveStepKind(step) === "agent") {
      const expectedNode = expected?.ir.root.nodes.find(node => node.id === step.id);
      for (const action of step.allowed_actions ?? []) {
        const matches = tools.filter(tool => tool.name === action || tool.mcp_tool_name === action);
        if (matches.length !== 1) throw new Error("Agent allow-list action has no unique current tool");
        const tool = matches[0]!, expectedCapability = expectedNode?.kind === "agent" ? expectedNode.allowedCapabilities.find(value => value.toolId === tool.tool_id) : undefined;
        if (expected && (!expectedCapability || expectedCapability.admission.connectionId !== connectionId)) throw new Error("Stored agent node lacks its exact connection capability pin");
        const pin = captureCapabilityAdmissionPin(state, services.registries, tool, session.admissionBinding, expectedCapability?.admission, connectionId);
        savePin(pins, step, pin, tool.tool_id);
      }
      continue;
    }
    const matches = tools.filter(tool => tool.name === step.action || tool.mcp_tool_name === step.action);
    if (matches.length !== 1) throw new Error("Operation action has no unique current tool");
    const expectedNode = expected?.ir.root.nodes.find(node => node.id === step.id), pin = expectedNode?.kind === "action" ? expectedNode.capability.admission : undefined;
    const tool = matches[0]!;
    if (expected && (!pin || pin.connectionId !== connectionId)) throw new Error("Stored operation lacks its exact connection pin");
    const captured = captureCapabilityAdmissionPin(state, services.registries, tool, session.admissionBinding, pin, connectionId);
    savePin(pins, step, captured, tool.tool_id);
    if (tool.operation_contract?.readback) {
      const targets = tools.filter(target => target.tool_id === tool.operation_contract!.readback!.tool_id);
      const readback = expectedNode?.kind === "action" ? expectedNode.readback : undefined;
      if (targets.length !== 1 || expected && (!readback || readback.admission.connectionId !== connectionId)) throw new Error("Operation lacks an exact same-connection reviewed read-back target");
      const readPin = captureReadAdmissionPin(state, services.registries, targets[0]!, session.admissionBinding, readback?.admission, connectionId);
      pins.set(connectionToolKey(connectionId, targets[0]!.tool_id), readPin);
      pins.set(targets[0]!.tool_id, readPin);
    }
  }
  const plan = compileOperationWorkflow(yaml, tools, role, pins);
  assertModelDataClassification(plan, pin => reviewedCapabilityDataClass(state, pin));
  if (expected && !canonicalJSONBytes(expected).equals(canonicalJSONBytes(plan))) throw new Error("Operation source, semantics or admission changed");
  return plan;
}

export async function prepareOperationPublication(services: HandlerServices, yaml: string, user: CurrentUser): Promise<PreparedOperationCompilation | null> {
  const source = parseWorkflowYAMLStrict(yaml), tools = services.registries.snapshot().tools;
  if (!usesCheckpointedOperationWorkflow(source, tools)) return null;
  assertProtectedRuntimeQualified(source);
  let connections: PreparedConnection[];
  try { connections = preparedConnections(services, source.steps); }
  catch { throw new HandlerFailure(503, "Every operation node requires its selected connected reviewed ERPBridge connection"); }
  const registryHash = services.registries.hash();
  try {
    const liveByConnection = new Map(await Promise.all(connections.map(async value => [value.id, await discoverTools(value.session, services.registries)] as const)));
    for (const step of source.steps) {
      if (effectiveStepKind(step) === "analysis") continue;
      const live = liveByConnection.get(stepConnection(services, step)) ?? [];
      const actions = effectiveStepKind(step) === "agent" ? step.allowed_actions ?? [] : [step.action ?? ""];
      if (actions.some(action => live.filter(tool => tool.name === action || tool.mcp_tool_name === action).length !== 1)) throw new Error("Selected connection does not expose every reviewed node capability");
    }
    const plan = await services.repository.readAuthoritative(state => compileCurrent(state, services, yaml, user.role));
    assertConnectionsCurrent(services, connections);
    if (registryHash !== services.registries.hash()) throw new Error("Operation registry changed");
    return { stored: { plan, receipt: operationCompilationReceipt(plan, registryHash), verifiedRole: user.role, compiledAt: new Date().toISOString() }, connections };
  } catch (error) {
    if (error instanceof ModelDataClassViolation) throw new HandlerFailure(422, error.message, { code: "MODEL_DATA_CLASS_DOWNGRADE" });
    throw new HandlerFailure(422, "Operation publication requires supported exact reviewed contracts, immutable node connections and typed sequential bindings", { code: "OPERATION_COMPILATION_REQUIRED" });
  }
}
export function assertOperationPublicationCurrent(prepared: PreparedOperationCompilation, services: HandlerServices, state: Readonly<RepositoryState>, yaml: string, role: string) {
  try { assertConnectionsCurrent(services, prepared.connections); }
  catch { throw new HandlerFailure(409, "Operation connection changed before publication"); }
  if (prepared.stored.receipt.registryHash !== services.registries.hash()) throw new HandlerFailure(409, "Operation registry changed before publication");
  compileCurrent(state, services, yaml, role, prepared.stored.plan);
}
export function prepareOperationExecution(state: Readonly<RepositoryState>, services: HandlerServices, publication: StoredRecord, yaml: string, role: string, expected?: OperationCompilationReceipt): StoredOperationCompilation {
  assertProtectedRuntimeQualified(parseWorkflowYAMLStrict(yaml));
  try {
    const stored = publication.compiledOperation as StoredOperationCompilation | undefined;
    if (!stored || stored.verifiedRole !== role || !Number.isFinite(Date.parse(stored.compiledAt)) || canonicalJSONBytes(stored).length > 1_200_000 ||
        typeof stored.receipt?.registryHash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(stored.receipt.registryHash)) throw new Error("Missing operation compilation");
    // Revalidate the exact saved source, capability pins and connections above
    // every run. The publication's whole-catalog hash is historical provenance:
    // adding an unrelated tool must not require republishing this workflow.
    const plan = compileCurrent(state, services, yaml, role, stored.plan), receipt = operationCompilationReceipt(plan, stored.receipt.registryHash);
    if (!canonicalJSONBytes(stored.receipt).equals(canonicalJSONBytes(receipt)) || expected && !canonicalJSONBytes(expected).equals(canonicalJSONBytes(receipt))) throw new Error("Operation receipt changed");
    return structuredClone(stored);
  } catch { throw new HandlerFailure(409, "This saved workflow's reviewed tool bindings or ERP connection could not be verified. Check the connection and tool access, then check again. Review the workflow if a required contract or its saved source changed.", { code: "PUBLISHED_OPERATION_REQUIRED" }); }
}
