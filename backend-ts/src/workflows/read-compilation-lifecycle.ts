import type { HandlerServices, CurrentUser } from "../http/handlers/common.js";
import { HandlerFailure } from "../http/handlers/common.js";
import type { RepositoryState, StoredRecord } from "../repository/store.js";
import { captureReadAdmissionPin } from "../registry/capability-admission.js";
import { discoverTools } from "../agent/tool-discovery.js";
import { buildReadIR, compileReadWorkflow, assertCompiledReadMatches, readCompilationReceipt, type CompiledReadPlan, type ReadAdmissionPin, type ReadCompilationReceipt } from "./compiled-read.js";
import { parseWorkflowYAMLStrict } from "../parser/workflow.js";
import { canonicalJSONBytes } from "../core/canonical-json.js";
import { supportsCollectionReads } from "../runner/read-collection-admission.js";
import { boundMcpConnection, connectionToolKey, selectedMcpConnectionId, type BoundMcpConnection } from "../tools/mcp-dispatch-context.js";
import type { WorkflowStepBlueprint } from "../models/schemas.js";

export type StoredReadCompilation = { plan: CompiledReadPlan; receipt: ReadCompilationReceipt; verifiedRole: string; compiledAt: string };
type PreparedConnection = BoundMcpConnection & { generation: number };
export type PreparedReadCompilation = { stored: StoredReadCompilation; connections: PreparedConnection[] };

function stepConnection(services: HandlerServices, step: WorkflowStepBlueprint) { return selectedMcpConnectionId(services, step.connection_id); }
function assertConnectionsCurrent(services: HandlerServices, connections: readonly PreparedConnection[]) {
  for (const expected of connections) {
    const current = boundMcpConnection(services, expected.id);
    if (current.session !== expected.session || (current.session.discoveryGeneration ?? 0) !== expected.generation ||
        !canonicalJSONBytes(current.roleMap).equals(canonicalJSONBytes(expected.roleMap))) throw new Error("Read connection context changed");
  }
}

export async function prepareReadPublication(services: HandlerServices, yaml: string, user: CurrentUser): Promise<PreparedReadCompilation | null> {
  const source = parseWorkflowYAMLStrict(yaml), tools = services.registries.snapshot().tools, built = buildReadIR(source, tools, user.role);
  if (built.issues.length || built.ir.schemaVersion === "workflow-read-ir/v4" && !supportsCollectionReads(services)) return null;
  const registryHash = services.registries.hash(), pins = new Map<string, ReadAdmissionPin>(), modern = services.erpbridgeSession?.requiresReviewedRevision === true || services.config.mcpTransport === "erpbridge-mcp" && services.config.mcpMode === "remote";
  const connections: PreparedConnection[] = [];
  if (modern) {
    const ids = [...new Set(source.steps.map(step => stepConnection(services, step)))].sort();
    try {
      for (const id of ids) { const bound = boundMcpConnection(services, id); connections.push({ ...bound, generation: bound.session.discoveryGeneration ?? 0 }); }
    } catch { throw new HandlerFailure(503, "Every read node requires its selected connected reviewed ERPBridge connection", { code: "COMPILATION_CONNECTION_REQUIRED" }); }
    try {
      const liveByConnection = new Map(await Promise.all(connections.map(async value => [value.id, await discoverTools(value.session, services.registries)] as const)));
      for (const step of source.steps) {
        const live = liveByConnection.get(stepConnection(services, step)) ?? [];
        if (live.filter(tool => tool.name === step.action || tool.mcp_tool_name === step.action).length !== 1) throw new Error("Selected connection does not expose the reviewed read capability");
      }
      await services.repository.readAuthoritative(state => {
        for (const step of source.steps) {
          const tool = tools.find(value => value.name === step.action || value.mcp_tool_name === step.action);
          if (!tool) throw new Error("Read tool is unavailable");
          const connectionId = stepConnection(services, step), session = boundMcpConnection(services, connectionId).session;
          if (!session.requiresReviewedRevision || session.dispatchBoundary !== "sdk-entry/v1" || !session.admissionBinding) throw new Error("Reviewed SDK-entry session required");
          const pin = captureReadAdmissionPin(state, services.registries, tool, session.admissionBinding, undefined, connectionId);
          pins.set(connectionToolKey(connectionId, tool.tool_id), pin); if (!step.connection_id) pins.set(tool.tool_id, pin);
        }
      });
    } catch (error) {
      if (error instanceof HandlerFailure) throw error;
      throw new HandlerFailure(409, "Exact connection-scoped capability review changed during compilation", { code: "COMPILATION_ADMISSION_CHANGED" });
    }
  }
  try { assertConnectionsCurrent(services, connections); }
  catch { throw new HandlerFailure(409, "Compilation connection changed", { code: "COMPILATION_CONTEXT_CHANGED" }); }
  if (registryHash !== services.registries.hash()) throw new HandlerFailure(409, "Compilation registry changed", { code: "COMPILATION_CONTEXT_CHANGED" });
  const plan = compileReadWorkflow(yaml, tools, user.role, pins);
  return { stored: { plan, receipt: readCompilationReceipt(plan, registryHash, "PUBLICATION", pins.size ? "reviewed" : "fixture-legacy"), verifiedRole: user.role, compiledAt: new Date().toISOString() }, connections };
}

export function assertReadPublicationCurrent(prepared: PreparedReadCompilation, services: HandlerServices, state: Readonly<RepositoryState>, yaml: string, role: string) {
  if (prepared.stored.receipt.registryHash !== services.registries.hash()) throw new HandlerFailure(409, "Compilation registry changed before publication", { code: "COMPILATION_CONTEXT_CHANGED" });
  try { assertConnectionsCurrent(services, prepared.connections); assertCompiledReadMatches(prepared.stored.plan, compileCurrent(state, services, yaml, role, prepared.stored.plan)); }
  catch { throw new HandlerFailure(409, "Compiled source, connection or capability admission changed before publication", { code: "COMPILATION_ADMISSION_CHANGED" }); }
}

export function prepareCompiledExecution(state: Readonly<RepositoryState>, services: HandlerServices, publication: StoredRecord, yaml: string, role: string,
  expectedReceipt?: ReadCompilationReceipt): { plan: CompiledReadPlan; receipt: ReadCompilationReceipt } {
  try {
    const raw = publication.compiledRead as StoredReadCompilation | undefined;
    if (!raw) {
      if (services.erpbridgeSession?.requiresReviewedRevision || services.config.mcpTransport === "erpbridge-mcp" && services.config.mcpMode === "remote") throw new Error("Modern publication has no reviewed compilation");
      const plan = compileReadWorkflow(yaml, services.registries.snapshot().tools, role), receipt = readCompilationReceipt(plan, services.registries.hash(), "LEGACY_PREFLIGHT", "fixture-legacy");
      if (plan.ir.schemaVersion === "workflow-read-ir/v4") throw new Error("Collection executable admission is not qualified");
      if (expectedReceipt && !canonicalJSONBytes(expectedReceipt).equals(canonicalJSONBytes(receipt))) throw new Error("Legacy compilation changed");
      return { plan, receipt };
    }
    if (canonicalJSONBytes(raw).length > 1_200_000 || !Number.isFinite(Date.parse(raw.compiledAt)) || raw.receipt?.origin !== "PUBLICATION" ||
        typeof raw.receipt.registryHash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(raw.receipt.registryHash)) throw new Error("Stored compilation is malformed");
    const plan = compileCurrent(state, services, yaml, role, raw.plan);
    if (plan.ir.schemaVersion === "workflow-read-ir/v4" && (!supportsCollectionReads(services) || raw.receipt.admissionMode !== "reviewed")) throw new Error("Collection executable admission is not qualified");
    assertCompiledReadMatches(raw.plan, plan);
    // Keep the immutable publication receipt, but recompile its own dependencies
    // against current reviewed contracts and permissions. Unrelated catalog
    // changes are not changes to this saved workflow's execution contract.
    const receipt = readCompilationReceipt(plan, raw.receipt.registryHash, "PUBLICATION", plan.ir.root.nodes.some(node => node.capability.admission) ? "reviewed" : "fixture-legacy");
    if (!canonicalJSONBytes(raw.receipt).equals(canonicalJSONBytes(receipt)) || expectedReceipt && !canonicalJSONBytes(expectedReceipt).equals(canonicalJSONBytes(receipt))) throw new Error("Stored compilation receipt changed");
    return { plan, receipt };
  } catch { throw new HandlerFailure(409, "This saved workflow's reviewed tool bindings or ERP connection could not be verified. Check the connection and tool access, then check again. Review the workflow if a required contract or its saved source changed.", { code: "PUBLISHED_COMPILATION_REQUIRED" }); }
}

function compileCurrent(state: Readonly<RepositoryState>, services: HandlerServices, yaml: string, role: string, expected: CompiledReadPlan): CompiledReadPlan {
  const source = parseWorkflowYAMLStrict(yaml), tools = services.registries.snapshot().tools, pins = new Map<string, ReadAdmissionPin>();
  for (let index = 0; index < expected.ir.root.nodes.length; index++) {
    const node = expected.ir.root.nodes[index]!, step = source.steps[index]!, pin = node.capability.admission;
    if ((services.erpbridgeSession?.requiresReviewedRevision || services.config.mcpTransport === "erpbridge-mcp" && services.config.mcpMode === "remote") && !pin) throw new Error("Compiled node has no admission pin");
    if (pin) {
      const connectionId = stepConnection(services, step);
      if (pin.connectionId !== connectionId) throw new Error("Authored and compiled connection differ");
      const tool = tools.find(value => value.tool_id === node.capability.toolId), session = boundMcpConnection(services, connectionId).session;
      if (!tool || !session.admissionBinding || session.dispatchBoundary !== "sdk-entry/v1") throw new Error("Compiled connection unavailable");
      const captured = captureReadAdmissionPin(state, services.registries, tool, session.admissionBinding, pin, connectionId);
      pins.set(connectionToolKey(connectionId, tool.tool_id), captured); if (!step.connection_id) pins.set(tool.tool_id, captured);
    }
  }
  return compileReadWorkflow(yaml, tools, role, pins);
}
