import { toolRoleAllowed } from "../governance/tool-access.js";
import { z } from "zod";
import { canonicalJSONBytes, resolvedParameterHashBytes } from "../core/canonical-json.js";
import { assertBoundedFiniteJSON, boundedFiniteJSONBytes } from "../core/bounded-finite-json.js";
import { parseWorkflowYAMLStrict, workflowContentHash } from "../parser/workflow.js";
import type { ToolDefinition } from "../registry/schemas.js";
import { capabilityContractHash, supportedOperation } from "../registry/capability-admission.js";
import { MCP_CONNECTION_ID_PATTERN } from "../tools/mcp-dispatch-context.js";
import { validateToolSchemaProfile } from "../tools/tool-input-schema.js";
import { assertReadErrorContract } from "../tools/read-business-error.js";
import { assertReportCoverageContract } from "../tools/report-coverage-contract.js";
import type { ModelDataClass } from "../providers/egress-policy.js";
import { projectProtectedCollectionDefinitions, type ReadAdmissionPin, type OperationNode } from "./compiled-read.js";
import { protectedErrorSourceIssues } from "./protected-operation-profile.js";
import { protectedMachinePlan } from "./protected-machine.js";
import type { ProtectedMachinePlan } from "./protected-machine-state.js";
import type { ReadSequence } from "./read-control-flow.js";
import { protectedOperationProvenance, type ProtectedOperationProvenance } from "./protected-operation-provenance.js";

const pinSchema = z.object({ connectionId: z.string().regex(MCP_CONNECTION_ID_PATTERN), capabilityId: z.string().min(1).max(256),
  revisionId: z.string().min(1).max(256), admissionVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER - 1),
  contractHash: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).strict();
type Contract = { toolId: string; contractHash: string; inputSchema: Record<string, unknown>; outputSchema?: Record<string, unknown>;
  readErrorContract?: NonNullable<ToolDefinition["read_error_contract"]>; operationContract?: NonNullable<ToolDefinition["operation_contract"]>;
  reportCoverageContract?: NonNullable<ToolDefinition["report_coverage_contract"]> };
export type ProtectedOperationIR = { schemaVersion: "workflow-operation-ir/v9"; compilerVersion: "operation-compiler/v9";
  trigger: { kind: "manual" }; verifiedRole: string; flow: ReadSequence; inputSchema?: Record<string, unknown>;
  root: { kind: "sequence"; nodes: OperationNode[] }; contracts: Record<string, Contract>;
  capabilityClasses: Array<{ pin: ReadAdmissionPin; dataClass: ModelDataClass }>; provenance: ProtectedOperationProvenance };
export type CompiledProtectedOperationPlan = { ir: ProtectedOperationIR; sourceHash: string; semanticHash: string; machine: ProtectedMachinePlan };

/** Separate original-definition compiler, NOT a publication/admission receipt.
 * The old compiler and normal HTTP lifecycle remain closed for collections.
 * Pins/classes must be freshly derived from authoritative reviews by the future
 * lifecycle. This pure API never discovers, dispatches, approves or resumes. */
function buildProtectedOperationWorkflow(yaml: string, rawTools: readonly ToolDefinition[], role: string,
  rawPins: ReadonlyMap<string, ReadAdmissionPin>, reviewedClass: (pin: ReadAdmissionPin) => ModelDataClass): { plan: CompiledProtectedOperationPlan; irBytes: Buffer } {
  if (typeof yaml !== "string" || Buffer.byteLength(yaml) > 200_000 || typeof role !== "string" || !role.length || role.length > 256)
    throw new Error("Protected operation source/role exceeds supported bounds");
  assertBoundedFiniteJSON(rawTools);
  const tools = structuredClone(rawTools), pins = new Map<string, ReadAdmissionPin>();
  for (const [key, pin] of rawPins) { assertBoundedFiniteJSON(pin); pins.set(key, pinSchema.parse(pin)); }
  const source = parseWorkflowYAMLStrict(yaml), projection = projectProtectedCollectionDefinitions(source, tools, role, pins);
  const contracts: Record<string, Contract> = {}, classes = new Map<string, { pin: ReadAdmissionPin; dataClass: ModelDataClass }>();
  const qualify = (toolId: string, contractHash: string, admission: ReadAdmissionPin | undefined, primary: boolean) => {
    const matches = tools.filter(tool => tool.tool_id === toolId), pin = pinSchema.parse(admission);
    if (matches.length !== 1 || capabilityContractHash(matches[0]!) !== contractHash || pin.contractHash !== contractHash ||
        !matches[0]!.bridge_contract || primary && !toolRoleAllowed(matches[0]!.allowed_roles, role)) throw new Error("Protected operation requires an exact original tool contract/pin/role");
    const tool = matches[0]!;
    if (!tool.is_read_only) supportedOperation(tool);
    else {
      assertReadErrorContract(tool);
      if (tool.risk_level.toLowerCase() !== "low" || tool.side_effects.length || tool.operation_contract ||
          /^system\..*_test$/i.test(tool.name) || /^system\..*_test$/i.test(tool.mcp_tool_name)) throw new Error("Protected reads require supported low-risk effect-free contracts");
      if (tool.report_coverage_contract) assertReportCoverageContract(tool);
    }
    if (!tool.bridge_contract!.output_schema || tool.bridge_contract!.output_schema.type !== "object")
      throw new Error("Protected operation requires an explicit object output schema");
    if (validateToolSchemaProfile(tool.input_schema).length || tool.bridge_contract!.output_schema && validateToolSchemaProfile(tool.bridge_contract!.output_schema).length)
      throw new Error("Protected operation requires supported exact tool schemas");
    // Hash one captured review per exact pin. Do not call a mutable callback
    // differently during provenance and IR construction.
    const key = canonicalJSONBytes(pin).toString("utf8");
    if (!classes.has(key)) {
      const dataClass = reviewedClass(structuredClone(pin));
      if (!["public", "internal", "confidential", "restricted"].includes(dataClass)) throw new Error("Unknown protected capability data classification");
      classes.set(key, { pin: structuredClone(pin), dataClass });
    }
    contracts[toolId] = { toolId, contractHash, inputSchema: structuredClone(tool.input_schema),
      ...(tool.bridge_contract!.output_schema ? { outputSchema: structuredClone(tool.bridge_contract!.output_schema) } : {}),
      ...(tool.read_error_contract ? { readErrorContract: structuredClone(tool.read_error_contract) } : {}),
      ...(tool.operation_contract ? { operationContract: structuredClone(tool.operation_contract) } : {}),
      ...(tool.report_coverage_contract ? { reportCoverageContract: structuredClone(tool.report_coverage_contract) } : {}) };
  };
  for (const node of projection.nodes) {
    if (node.kind === "action") {
      qualify(node.capability.toolId, node.capability.contractHash, node.capability.admission, true);
      if (node.readback) qualify(node.readback.toolId, node.readback.contractHash, node.readback.admission, false);
    } else if (node.kind === "agent") {
      for (const capability of node.allowedCapabilities) qualify(capability.toolId, capability.contractHash, capability.admission, true);
    }
  }
  const sources = projection.nodes.map(node => ({ id: node.id, tools: (node.kind === "action" && node.effectClass === "read" ? [node.capability] :
    node.kind === "agent" ? node.allowedCapabilities : []).map(capability => tools.find(tool => tool.tool_id === capability.toolId)!) }));
  const issues = protectedErrorSourceIssues(projection.flow, sources);
  if (issues.length) throw new Error(issues.join("; "));
  const provenance = protectedOperationProvenance(projection.flow, projection.nodes, pin => {
    const captured = classes.get(canonicalJSONBytes(pin).toString("utf8"));
    if (!captured) throw new Error("Protected provenance has no captured exact review"); return captured.dataClass;
  });
  const sourceHash = workflowContentHash(yaml);
  const machine = protectedMachinePlan(sourceHash, projection.flow, projection.nodes.map(node => ({ id: node.id, input: node.kind === "action" ? node.inputs : node.input })), projection.inputSchema);
  const ir: ProtectedOperationIR = { schemaVersion: "workflow-operation-ir/v9", compilerVersion: "operation-compiler/v9", trigger: { kind: "manual" },
    verifiedRole: role, flow: projection.flow, ...(projection.inputSchema ? { inputSchema: projection.inputSchema } : {}),
    root: { kind: "sequence", nodes: projection.nodes }, contracts, capabilityClasses: [...classes.values()], provenance };
  const irBytes = boundedFiniteJSONBytes(ir);
  if (irBytes.length > 1_000_000) throw new Error("Protected operation artifact exceeds supported size");
  return { plan: { ir, sourceHash, semanticHash: resolvedParameterHashBytes(irBytes), machine }, irBytes };
}

export function compileProtectedOperationWorkflow(yaml: string, tools: readonly ToolDefinition[], role: string,
  pins: ReadonlyMap<string, ReadAdmissionPin>, reviewedClass: (pin: ReadAdmissionPin) => ModelDataClass): CompiledProtectedOperationPlan {
  return buildProtectedOperationWorkflow(yaml, tools, role, pins, reviewedClass).plan;
}

/** Fixed complete plan shape, in canonical sorted-key order. Only freshly
 * built, validated IR bytes are reused; no supplied hash/bytes or cross-call
 * authorization cache is accepted. Other fields use the normative encoder. */
function planBytes(current: { plan: CompiledProtectedOperationPlan; irBytes: Buffer }): Buffer {
  return Buffer.concat([Buffer.from('{"ir":'), current.irBytes, Buffer.from(',"machine":'), canonicalJSONBytes(current.plan.machine),
    Buffer.from(',"semanticHash":'), canonicalJSONBytes(current.plan.semanticHash), Buffer.from(',"sourceHash":'), canonicalJSONBytes(current.plan.sourceHash), Buffer.from("}")]);
}

/** Denial-only fresh re-compilation. Exact equality includes original source,
 * complete IR, classifications and kernel. Caller must separately prove that
 * the source/reviews/provider/principal came from current authoritative state. */
export function assertProtectedOperationPlanCurrent(saved: CompiledProtectedOperationPlan, yaml: string, tools: readonly ToolDefinition[], role: string,
  pins: ReadonlyMap<string, ReadAdmissionPin>, reviewedClass: (pin: ReadAdmissionPin) => ModelDataClass): void {
  const savedBytes = boundedFiniteJSONBytes(saved);
  const current = buildProtectedOperationWorkflow(yaml, tools, role, pins, reviewedClass);
  if (!savedBytes.equals(planBytes(current))) throw new Error("Protected operation source, full semantics, review or kernel changed");
}
