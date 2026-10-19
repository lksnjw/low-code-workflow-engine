import { toolRoleAllowed } from "../governance/tool-access.js";
import { createHash } from "node:crypto";
import type { WorkflowBlueprint } from "../models/schemas.js";
import { effectiveStepKind } from "../models/schemas.js";
import { assertProtectedErrorSources, protectedOperationProfile, protectedErrorSourceIssues } from "./protected-operation-profile.js";
import type { ToolDefinition } from "../registry/schemas.js";
import { capabilityContractHash } from "../registry/capability-admission.js";
import { exactBridgeName } from "../tools/erpbridge-contract.js";
import { reviewedReadOutputKey } from "../tools/mcp-result.js";
import { validateToolInput, validateToolSchemaProfile } from "../tools/tool-input-schema.js";
import { canonicalJSONBytes } from "../core/canonical-json.js";
import { parseWorkflowYAMLStrict, workflowContentHash } from "../parser/workflow.js";
import { parseReadControlFlow, validateReadControlFlow, controlNodes, loopNodes, protectedNodes, lexicalSchemaOverrides, assertNoProtectedScopes, structuralNodes, type ReadSequence } from "./read-control-flow.js";
import { checkBinding, schemaAt } from "./read-binding-validation.js";
import { ReadValueBudget } from "./read-value-budget.js";
import { assertOperationReadbackTarget } from "../tools/operation-readback-contract.js";
import type { ModelDataClass } from "../providers/egress-policy.js";
import { connectionToolKey, MCP_CONNECTION_ID_PATTERN } from "../tools/mcp-dispatch-context.js";
import { inspectOperationDecisions } from "./operation-control-flow.js";
import { usesCheckpointedOperationWorkflow } from "./execution-shape.js";
import { modelInputReferences, type CompiledModelInput } from "./model-input.js";
import { safeModelInputName } from "../models/model-input.js";

export type ReadReference = { kind: "ref"; source: "workflowInput" | "nodeOutput"; nodeId?: string; path: string[] };
export type ReadBinding = ReadReference | { kind: "literal"; value: string | number | boolean | null } |
  { kind: "object"; fields: Record<string, ReadBinding> } | { kind: "array"; items: ReadBinding[] } |
  { kind: "template"; parts: Array<string | ReadReference> };
export type ReadAdmissionPin = { connectionId: string; capabilityId: string; revisionId: string; admissionVersion: number; contractHash: string };
export type ReadIR = { schemaVersion: "workflow-read-ir/v1" | "workflow-read-ir/v2" | "workflow-read-ir/v3" | "workflow-read-ir/v4"; compilerVersion: "read-compiler/v1" | "read-compiler/v2" | "read-compiler/v3" | "read-compiler/v4"; trigger: { kind: "manual" }; flow?: ReadSequence;
  inputSchema?: Record<string, unknown>; root: { kind: "sequence"; nodes: Array<{ id: string; kind: "action";
    capability: { toolId: string; action: string; remoteName: string; contractHash: string; admission?: ReadAdmissionPin };
    inputs: ReadBinding }> } };
export type CompiledReadPlan = { ir: ReadIR; semanticHash: string; sourceHash: string };
export type ReadCompilationReceipt = { schemaVersion: ReadIR["schemaVersion"]; compilerVersion: ReadIR["compilerVersion"]; semanticHash: string; sourceHash: string;
  registryHash: string; origin: "PUBLICATION" | "LEGACY_PREFLIGHT"; admissionMode: "reviewed" | "fixture-legacy" };
export function readCompilationReceipt(plan: CompiledReadPlan, registryHash: string, origin: ReadCompilationReceipt["origin"], admissionMode: ReadCompilationReceipt["admissionMode"]): ReadCompilationReceipt {
  return { schemaVersion: plan.ir.schemaVersion, compilerVersion: plan.ir.compilerVersion, semanticHash: plan.semanticHash, sourceHash: plan.sourceHash, registryHash, origin, admissionMode };
}
const reserved = new Set(["__proto__", "constructor", "prototype"]);
const supported = new Set(["id", "kind", "action", "connection_id", "parameters", "description"]);
const analysisSupported = new Set(["id", "kind", "instruction", "input", "output_schema", "max_input_items", "max_input_chars", "max_output_tokens", "data_class", "model", "description"]);
const agentSupported = new Set(["id", "kind", "connection_id", "instruction", "input", "allowed_actions", "output_schema", "completion_predicate", "max_input_items", "max_input_chars",
  "max_output_tokens", "max_total_tokens", "max_rounds", "max_tool_calls", "max_wall_time_ms", "max_concurrency", "data_class", "model", "description"]);
const hashIR = (ir: ReadIR) => `sha256:${createHash("sha256").update(canonicalJSONBytes(ir)).digest("hex")}`;

/** Pure executable projection. YAML/presentation labels are not runtime logic.
 * Missing output/input schemas require concrete runtime guards, not inferred
 * types or model-supplied values. Other control-flow profiles remain explicit
 * compiler errors until their structured semantics are implemented. */
export function buildReadIR(blueprint: WorkflowBlueprint, tools: readonly ToolDefinition[], role: string, pins: ReadonlyMap<string, ReadAdmissionPin> = new Map()):
  { ir: ReadIR; semanticHash: string; issues: string[] } {
  return buildActionBindingsIR(blueprint, tools, role, pins, false);
}
/** Shared bounded binding compiler, not an execution/admission switch. The
 * operation compiler has a different IR/receipt and mandatory reviewed pins. */
function buildActionBindingsIR(blueprint: WorkflowBlueprint, tools: readonly ToolDefinition[], role: string, pins: ReadonlyMap<string, ReadAdmissionPin>, operations: boolean, purpose: "publication" | "draft-inspection" | "protected-operation" | "protected-collection-operation" = "publication"):
  { ir: ReadIR; semanticHash: string; issues: string[]; analysisNodes: OperationAnalysisNode[]; agentNodes: OperationAgentNode[]; scopeValidation?: ReturnType<typeof validateReadControlFlow> } {
  const issues: string[] = [], ids = new Set<string>(), outputs = new Map<string, Record<string, unknown>>();
  const analysisNodes: OperationAnalysisNode[] = [];
  const agentNodes: OperationAgentNode[] = [];
  const modelBindings = new Map<string, ReadBinding>();
  let bindingNodes = 0;
  const inputSchema = blueprint.trigger.config?.inputSchema;
  if (blueprint.trigger.type !== "manual" || Object.keys(blueprint.trigger.config ?? {}).some(key => key !== "inputSchema")) issues.push("Compiled read workflows require a manual trigger and supported input configuration");
  if (inputSchema !== undefined && ((inputSchema as Record<string, unknown> | null)?.type !== "object" || validateToolSchemaProfile(inputSchema).length)) issues.push("Workflow input schema is unsupported");
  const ir: ReadIR = { schemaVersion: "workflow-read-ir/v1", compilerVersion: "read-compiler/v1", trigger: { kind: "manual" },
    ...(inputSchema === undefined ? {} : { inputSchema: structuredClone(inputSchema) as Record<string, unknown> }), root: { kind: "sequence", nodes: [] } };
  const mergedIDs = new Set<string>();
  const admissionFor = (connectionId: string | undefined, toolId: string) => {
    const explicit = connectionId?.trim();
    const pin = explicit ? pins.get(connectionToolKey(explicit, toolId)) ?? pins.get(toolId) : pins.get(toolId);
    return pin && (!explicit || pin.connectionId === explicit) ? pin : undefined;
  };
  if (blueprint.metadata?.controlFlow !== undefined) {
    ir.schemaVersion = "workflow-read-ir/v2"; ir.compilerVersion = "read-compiler/v2";
    try {
      const parsed = parseReadControlFlow(blueprint.metadata.controlFlow); ir.flow = parsed.root;
      if (parsed.schemaVersion === "read-control-flow/v4" && purpose !== "draft-inspection" && purpose !== "protected-operation" && purpose !== "protected-collection-operation") issues.push("Protected workflow publication requires the separately qualified durable handler profile");
      // v3 permits collections but does not require one. Select the driver by
      // actual semantics: an if/return-only flow has no iteration ledger.
      if (parsed.schemaVersion === "read-control-flow/v2" || parsed.schemaVersion === "read-control-flow/v3") {
        const collection = loopNodes(parsed.root).length > 0;
        ir.schemaVersion = collection ? "workflow-read-ir/v4" : "workflow-read-ir/v3";
        ir.compilerVersion = collection ? "read-compiler/v4" : "read-compiler/v3";
      }
      for (const node of controlNodes(ir.flow)) if (node.merge) { mergedIDs.add(node.id); outputs.set(node.id, { type: "object", properties: { value: node.merge.schema }, required: ["value"], additionalProperties: false }); }
      for (const node of loopNodes(ir.flow)) { mergedIDs.add(node.id); outputs.set(node.id, { type: "object", properties: { value: { type: "array", items: node.collect.schema } }, required: ["value"], additionalProperties: false }); }
      for (const node of protectedNodes(ir.flow)) { mergedIDs.add(node.id); outputs.set(node.id, { type: "object", properties: { value: node.output.schema }, required: ["value"], additionalProperties: false }); }
    } catch { issues.push("Structured control flow is malformed or exceeds supported limits"); }
  }
  const lexicalSchemas = ir.flow ? lexicalSchemaOverrides(ir.flow) : new Map<string, Map<string, Record<string, unknown>>>();
  if (blueprint.steps.length < 1 || blueprint.steps.length > 200) issues.push("Read workflows require 1–200 steps");
  for (const step of blueprint.steps.slice(0, 200)) {
    let localNodes = 0;
    const kind = effectiveStepKind(step);
    const sourceSchema = (ref: ReadReference) => {
      const schema = ref.source === "workflowInput" ? ir.inputSchema : lexicalSchemas.get(step.id)?.get(ref.nodeId!) ?? outputs.get(ref.nodeId!);
      if (schema?.additionalProperties === false && ref.path.length && !Object.hasOwn((schema.properties ?? {}) as object, ref.path[0]!))
        issues.push(`Step ${step.id} references an undeclared output path`);
      return schema;
    };
    if (step.connection_id !== undefined && !MCP_CONNECTION_ID_PATTERN.test(step.connection_id)) issues.push(`Step ${step.id} has an unsupported ERPBridge connection ID`);
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(step.id) || step.id === "input" || reserved.has(step.id) || ids.has(step.id)) issues.push("Step IDs must be unique, reference-safe and non-reserved");
    if (kind !== "tool" && !(operations && (kind === "analysis" || kind === "agent")) || Object.keys(step).some(key => !(kind === "analysis" ? analysisSupported : kind === "agent" ? agentSupported : supported).has(key))) issues.push(`Step ${step.id} uses unsupported execution semantics`);
    const matches = kind === "tool" ? tools.filter(tool => tool.name === step.action || tool.mcp_tool_name === step.action) : [], tool = matches.length === 1 ? matches[0] : undefined;
    if (kind === "tool") {
      if (!tool || !tool.tool_id || !tool.mcp_tool_name || (!tool.is_read_only && !operations) || !toolRoleAllowed(tool.allowed_roles, role)) issues.push(`Step ${step.id} requires a unique role-granted registered ${operations ? "operation" : "read"} tool`);
      else issues.push(...validateToolSchemaProfile(tool.input_schema));
    }
    const reference = (expression: string): ReadReference => {
      const path = expression.trim().split("."), root = path.shift()!;
      if (!/^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*$/.test(expression.trim()) || [root, ...path].some(part => reserved.has(part))) issues.push(`Step ${step.id} has an unsupported data reference`);
      if (root !== "input" && !ids.has(root) && !mergedIDs.has(root)) issues.push(`Step ${step.id} has an unavailable or forward data reference`);
      return root === "input" ? { kind: "ref", source: "workflowInput", path } : { kind: "ref", source: "nodeOutput", nodeId: root, path };
    };
    const binding = (value: unknown, depth: number): ReadBinding => {
      if (++localNodes > 4096 || ++bindingNodes > 32768 || depth > 16) { issues.push("Read parameters exceed supported limits"); return { kind: "literal", value: null }; }
      if (typeof value === "string") {
        const exact = /^\{\{([^{}]*?)\}\}$/.exec(value.trim()); if (exact) return reference(exact[1]!);
        const parts: Array<string | ReadReference> = []; let end = 0;
        for (const match of value.matchAll(/\{\{([\s\S]*?)\}\}/g)) { parts.push(value.slice(end, match.index), reference(match[1]!)); end = match.index + match[0].length; }
        parts.push(value.slice(end));
        if (parts.some(part => typeof part === "string" && (part.includes("{{") || part.includes("}}")))) issues.push(`Step ${step.id} has a malformed data reference`);
        return parts.length > 1 ? { kind: "template", parts } : { kind: "literal", value };
      }
      if (Array.isArray(value)) return { kind: "array", items: value.slice(0, 4097).map(child => binding(child, depth + 1)) };
      if (value !== null && typeof value === "object") {
        const entries = Object.entries(value); if (entries.some(([key]) => reserved.has(key))) issues.push("Read parameters contain reserved keys");
        return { kind: "object", fields: Object.fromEntries(entries.slice(0, 4097).map(([key, child]) => [key, binding(child, depth + 1)])) };
      }
      if (value !== null && !(typeof value === "boolean" || typeof value === "number" && Number.isFinite(value))) { issues.push("Read parameters must be finite JSON values"); return { kind: "literal", value: null }; }
      return { kind: "literal", value: value as number | boolean | null };
    };
    const validateModelInput = (input: ReadBinding, label: string): input is CompiledModelInput => {
      const refs = modelInputReferences(input);
      if (!refs || input.kind === "object" && !Object.keys(input.fields).every(safeModelInputName)) {
        issues.push(`Step ${step.id} ${label} input must be one exact prior-output reference or 1–8 named exact prior-output references`); return false;
      }
      for (const ref of refs) {
        if (ref.source !== "nodeOutput") issues.push(`Step ${step.id} ${label} input must come from an acknowledged prior node output`);
        else if (schemaAt(sourceSchema(ref), ref.path) === undefined) issues.push(`Step ${step.id} ${label} input must select a declared prior output`);
      }
      return true;
    };
    if (kind === "analysis" && operations) {
      const instruction = (step.instruction ?? "").trim(), input = binding(step.input ?? "", 0), outputSchema = step.output_schema;
      modelBindings.set(step.id, input);
      if (instruction === "" || instruction.length > 4_000) issues.push(`Step ${step.id} requires a bounded analysis instruction`);
      const validInput = validateModelInput(input, "analysis");
      if (!outputSchema || outputSchema.type !== "object") issues.push(`Step ${step.id} requires an object output_schema`);
      else issues.push(...validateToolSchemaProfile(outputSchema));
      if (!step.data_class) issues.push(`Step ${step.id} requires an explicit analysis data_class`);
      if ((step.model ?? "").length > 256 || (step.model ?? "").includes(":latest")) issues.push(`Step ${step.id} requires a bounded pinned model ID`);
      const maxInputItems = step.max_input_items ?? 200, maxInputChars = step.max_input_chars ?? 20_000;
      const maxOutputTokens = step.max_output_tokens ?? 2_048;
      if (!Number.isInteger(maxInputItems) || maxInputItems < 1 || maxInputItems > 10_000 || !Number.isInteger(maxInputChars) || maxInputChars < 1 || maxInputChars > 200_000)
        issues.push(`Step ${step.id} analysis limits are unsupported`);
      if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 8_192) issues.push(`Step ${step.id} analysis output limit is unsupported`);
      if (validInput && outputSchema && step.data_class) analysisNodes.push({ id: step.id, kind: "analysis", instruction, input: input as CompiledModelInput,
        outputSchema: structuredClone(outputSchema), dataClass: step.data_class as ModelDataClass, model: (step.model ?? "").trim(), maxInputItems, maxInputChars, maxOutputTokens,
        ...((step.description ?? "").trim() ? { description: step.description!.trim() } : {}) });
      if (outputSchema) outputs.set(step.id, { type: "object", properties: { structuredContent: outputSchema }, required: ["structuredContent"], additionalProperties: false });
      ids.add(step.id); continue;
    }
    if (kind === "agent" && operations) {
      const instruction = (step.instruction ?? "").trim(), input = binding(step.input ?? "", 0), outputSchema = step.output_schema;
      modelBindings.set(step.id, input);
      if (instruction === "" || instruction.length > 4_000) issues.push(`Step ${step.id} requires a bounded agent instruction`);
      const validInput = validateModelInput(input, "agent");
      if (!outputSchema || outputSchema.type !== "object") issues.push(`Step ${step.id} requires an object output_schema`);
      else issues.push(...validateToolSchemaProfile(outputSchema));
      const predicate = step.completion_predicate as Record<string, unknown> | undefined;
      const predicatePath = predicate?.path, predicateKeys = predicate ? Object.keys(predicate) : [];
      if (!predicate || predicateKeys.some(key => key !== "path" && key !== "equals") || !Array.isArray(predicatePath) || predicatePath.length < 1 || predicatePath.length > 16 ||
          predicatePath.some(part => typeof part !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(part) || reserved.has(part)) || !Object.hasOwn(predicate, "equals") ||
          predicate.equals !== null && !["string", "number", "boolean"].includes(typeof predicate.equals) || typeof predicate.equals === "number" && !Number.isFinite(predicate.equals))
        issues.push(`Step ${step.id} requires an exact bounded completion_predicate`);
      else if (outputSchema && schemaAt(outputSchema, predicatePath as string[]) === undefined) issues.push(`Step ${step.id} completion predicate must select a declared output field`);
      if (!step.data_class) issues.push(`Step ${step.id} requires an explicit agent data_class`);
      if ((step.model ?? "").length > 256 || (step.model ?? "").includes(":latest")) issues.push(`Step ${step.id} requires a bounded pinned model ID`);
      const allowedActions = step.allowed_actions ?? [];
      if (allowedActions.length < 1 || allowedActions.length > 8 || new Set(allowedActions).size !== allowedActions.length || allowedActions.some(value => !value.trim()))
        issues.push(`Step ${step.id} requires 1–8 unique reviewed allowed_actions`);
      const capabilities: OperationAgentCapability[] = [];
      for (const action of allowedActions.slice(0, 8)) {
        const matches = tools.filter(tool => tool.name === action || tool.mcp_tool_name === action), allowed = matches.length === 1 ? matches[0] : undefined;
        if (!allowed || !allowed.tool_id || !allowed.mcp_tool_name || !allowed.is_read_only || !toolRoleAllowed(allowed.allowed_roles, role)) {
          issues.push(`Step ${step.id} allowed action ${action} must be one unique role-granted read-only tool`); continue;
        }
        issues.push(...validateToolSchemaProfile(allowed.input_schema));
        const admission = admissionFor(step.connection_id, allowed.tool_id);
        if (!admission) { if (purpose === "publication") issues.push(`Step ${step.id} allowed action ${action} requires a reviewed capability pin`); continue; }
        capabilities.push({ toolId: allowed.tool_id, action: allowed.name, remoteName: exactBridgeName(allowed), contractHash: capabilityContractHash(allowed), admission: structuredClone(admission) });
      }
      const maxInputItems = step.max_input_items ?? 200, maxInputChars = step.max_input_chars ?? 20_000, maxOutputTokens = step.max_output_tokens ?? 1_024;
      const maxTotalTokens = step.max_total_tokens ?? 4_096, maxRounds = step.max_rounds ?? 4, maxToolCalls = step.max_tool_calls ?? 8;
      const maxWallTimeMs = step.max_wall_time_ms ?? 30_000, maxConcurrency = step.max_concurrency ?? 1;
      if (!Number.isInteger(maxInputItems) || maxInputItems < 1 || maxInputItems > 10_000 || !Number.isInteger(maxInputChars) || maxInputChars < 1 || maxInputChars > 200_000)
        issues.push(`Step ${step.id} agent input limits are unsupported`);
      if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 8_192 || !Number.isInteger(maxTotalTokens) || maxTotalTokens < maxOutputTokens || maxTotalTokens > 32_768)
        issues.push(`Step ${step.id} agent token limits are unsupported`);
      if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 8 || !Number.isInteger(maxToolCalls) || maxToolCalls < 0 || maxToolCalls > 16 ||
          !Number.isInteger(maxWallTimeMs) || maxWallTimeMs < 1_000 || maxWallTimeMs > 120_000 || maxConcurrency !== 1)
        issues.push(`Step ${step.id} agent execution limits are unsupported`);
      if (validInput && outputSchema && predicate && (capabilities.length === allowedActions.length || purpose === "draft-inspection") && step.data_class) agentNodes.push({ id: step.id, kind: "agent", instruction, input: input as CompiledModelInput,
        allowedCapabilities: capabilities, outputSchema: structuredClone(outputSchema), completionPredicate: { path: [...predicatePath as string[]], equals: structuredClone(predicate.equals) as string | number | boolean | null },
        dataClass: step.data_class as ModelDataClass, model: (step.model ?? "").trim(), maxInputItems, maxInputChars, maxOutputTokens, maxTotalTokens, maxRounds, maxToolCalls, maxWallTimeMs,
        ...((step.description ?? "").trim() ? { description: step.description!.trim() } : {}) });
      if (outputSchema) outputs.set(step.id, { type: "object", properties: { structuredContent: outputSchema }, required: ["structuredContent"], additionalProperties: false });
      ids.add(step.id); continue;
    }
    const inputs = binding(step.parameters ?? {}, 0);
    if (tool) {
      checkBinding(inputs, tool.input_schema, `Step ${step.id}`, issues, ref => {
        const schema = sourceSchema(ref);
        return schemaAt(schema, ref.path);
      });
      const admission = admissionFor(step.connection_id, tool.tool_id);
      ir.root.nodes.push({ id: step.id, kind: "action", capability: { toolId: tool.tool_id, action: tool.name, remoteName: exactBridgeName(tool), contractHash: capabilityContractHash(tool),
        ...(admission ? { admission: structuredClone(admission) } : {}) }, inputs });
      if (tool.bridge_contract?.output_schema) {
        issues.push(...validateToolSchemaProfile(tool.bridge_contract.output_schema));
        const dataKey = reviewedReadOutputKey(tool);
        // A reviewed JSON-text receipt guarantees jsonContent, not an MCP
        // structuredContent object. Do not advertise a path absent at runtime.
        outputs.set(step.id, { type: "object", properties: { [dataKey]: tool.bridge_contract.output_schema }, required: [dataKey], additionalProperties: false });
      }
    }
    ids.add(step.id);
  }
  // Bound the projection as well as its source: reference expansion/metadata
  // cannot turn a bounded YAML file into an unbounded saved artifact.
  let scopeValidation: ReturnType<typeof validateReadControlFlow> | undefined;
  if (ir.flow) {
    const projected = operations ? blueprint.steps.flatMap(step => {
      const tool = ir.root.nodes.find(node => node.id === step.id), modelInput = modelBindings.get(step.id);
      return tool ? [{ id: tool.id, inputs: tool.inputs }] : modelInput ? [{ id: step.id, inputs: modelInput }] : [];
    }) : [];
    const inputSchemas = new Map(ir.root.nodes.map(node => [node.id, tools.find(tool => tool.tool_id === node.capability.toolId)?.input_schema ?? {}]));
    const validation = operations ? inspectOperationDecisions(ir.flow, projected, ir.inputSchema, outputs, inputSchemas, purpose === "protected-collection-operation" || purpose === "draft-inspection" && protectedNodes(ir.flow).length > 0) :
      validateReadControlFlow(ir.flow, ir, outputs, new Map(ir.root.nodes.map(node => [node.id, tools.find(tool => tool.tool_id === node.capability.toolId)?.input_schema ?? {}])));
    issues.push(...validation.issues); scopeValidation = validation;
  }
  if (canonicalJSONBytes(ir).length > 1_000_000) issues.push("Compiled read artifact exceeds supported size");
  return { ir, semanticHash: hashIR(ir), issues: [...new Set(issues)], analysisNodes, agentNodes, ...(scopeValidation ? { scopeValidation } : {}) };
}

/** Pure draft diagnostics only: no plan, receipt, admission pin or dispatch
 * authority escapes this API. The publication compiler always requires pins. */
export function inspectModelWorkflowDraft(blueprint: WorkflowBlueprint, tools: readonly ToolDefinition[], role: string): string[] {
  if (!blueprint.steps.some(step => ["analysis", "agent"].includes(effectiveStepKind(step)))) return [];
  return buildActionBindingsIR(blueprint, tools, role, new Map(), true, "draft-inspection").issues;
}

export function inspectWorkflowDraft(blueprint: WorkflowBlueprint, tools: readonly ToolDefinition[], role: string) {
  const built = buildActionBindingsIR(blueprint, tools, role, new Map(), usesCheckpointedOperationWorkflow(blueprint, tools), "draft-inspection");
  return { issues: built.issues, ...(built.scopeValidation ? { scopeValidation: built.scopeValidation } : {}) };
}

export type OperationToolNode = ReadIR["root"]["nodes"][number] & { effectClass: "read" | "write" | "notification";
  readback?: { profile: "operation-readback-binding/v1"; toolId: string; contractHash: string; admission: ReadAdmissionPin } };
export type OperationAnalysisNode = { id: string; kind: "analysis"; instruction: string; input: CompiledModelInput; outputSchema: Record<string, unknown>;
  dataClass: ModelDataClass; model: string; maxInputItems: number; maxInputChars: number; maxOutputTokens: number; description?: string };
export type OperationAgentCapability = { toolId: string; action: string; remoteName: string; contractHash: string; admission: ReadAdmissionPin };
export type OperationAgentNode = { id: string; kind: "agent"; instruction: string; input: CompiledModelInput; allowedCapabilities: OperationAgentCapability[];
  outputSchema: Record<string, unknown>; completionPredicate: { path: string[]; equals: string | number | boolean | null }; dataClass: ModelDataClass; model: string;
  maxInputItems: number; maxInputChars: number; maxOutputTokens: number; maxTotalTokens: number; maxRounds: number; maxToolCalls: number; maxWallTimeMs: number; description?: string };
export type OperationNode = OperationToolNode | OperationAnalysisNode | OperationAgentNode;

export type ModelFixtureNode = ReadIR["root"]["nodes"][number] | OperationAnalysisNode | (Omit<OperationAgentNode, "allowedCapabilities"> & { allowedActions: string[] });
/** Non-authorizing fixture projection: no admission pins, provider binding,
 * publication receipt or durable runtime plan are produced. */
export function compileModelFixtureWorkflow(yaml: string, tools: readonly ToolDefinition[], role: string) {
  if (Buffer.byteLength(yaml) > 200_000) throw new Error("Model simulation source exceeds supported bounds");
  const blueprint = parseWorkflowYAMLStrict(yaml), built = buildActionBindingsIR(blueprint, tools, role, new Map(), true, "draft-inspection");
  if (built.ir.flow) assertNoProtectedScopes(built.ir.flow);
  const definitions = new Map<string, ModelFixtureNode>([...built.ir.root.nodes, ...built.analysisNodes].map(node => [node.id, node]));
  for (const node of built.agentNodes) {
    const { allowedCapabilities: _privateCapabilities, ...fields } = node;
    definitions.set(node.id, { ...fields, allowedActions: [...(blueprint.steps.find(step => step.id === node.id)!.allowed_actions ?? [])] });
  }
  if (!blueprint.steps.some(step => ["analysis", "agent"].includes(effectiveStepKind(step)))) built.issues.push("Model simulation requires a model node");
  for (const node of built.ir.root.nodes) if (!tools.find(tool => tool.tool_id === node.capability.toolId)?.is_read_only)
    built.issues.push("Model fixture simulation does not evaluate effects or runtime approvals");
  const nodes = blueprint.steps.map(step => definitions.get(step.id));
  if (nodes.some(node => !node)) built.issues.push("Model simulation has an unsupported node");
  if (built.issues.length) throw new Error("Model fixture projection is unsupported");
  const projection = { profile: "model-fixture-plan/v1" as const, nodes: nodes as ModelFixtureNode[],
    ...(built.ir.flow ? { flow: structuredClone(built.ir.flow) } : {}), ...(built.ir.inputSchema ? { inputSchema: structuredClone(built.ir.inputSchema) } : {}) };
  return { ...projection, sourceHash: workflowContentHash(yaml), simulationHash: `sha256:${createHash("sha256").update(canonicalJSONBytes(projection)).digest("hex")}` };
}

/** Separate, non-authorizing projection for supplied protected-path tests.
 * Never a read/operation publication, provider binding or admission receipt. */
export function compileProtectedFixtureWorkflow(yaml: string, tools: readonly ToolDefinition[], role: string) {
  if (Buffer.byteLength(yaml) > 200_000) throw new Error("Protected simulation source exceeds supported bounds");
  const blueprint = parseWorkflowYAMLStrict(yaml), built = buildActionBindingsIR(blueprint, tools, role, new Map(), true, "draft-inspection");
  if (!built.ir.flow || !protectedNodes(built.ir.flow).length) throw new Error("Protected simulation requires explicit protected scopes");
  const definitions = new Map<string, ModelFixtureNode>([...built.ir.root.nodes, ...built.analysisNodes].map(node => [node.id, node]));
  for (const node of built.agentNodes) {
    const { allowedCapabilities: _private, ...fields } = node;
    definitions.set(node.id, { ...fields, allowedActions: [...(blueprint.steps.find(step => step.id === node.id)!.allowed_actions ?? [])] });
  }
  built.issues.push(...protectedErrorSourceIssues(built.ir.flow, built.ir.root.nodes.map(node => ({ id: node.id,
    tools: tools.filter(tool => tool.tool_id === node.capability.toolId) }))));
  const nodes = blueprint.steps.map(step => definitions.get(step.id));
  if (nodes.some(node => !node)) built.issues.push("Protected simulation has an unsupported node");
  if (built.issues.length) throw new Error("Protected fixture projection is unsupported");
  const projection = { profile: "protected-fixture-plan/v1" as const, nodes: nodes as ModelFixtureNode[], flow: structuredClone(built.ir.flow),
    ...(built.ir.inputSchema ? { inputSchema: structuredClone(built.ir.inputSchema) } : {}) };
  return { ...projection, sourceHash: workflowContentHash(yaml), simulationHash: `sha256:${createHash("sha256").update(canonicalJSONBytes(projection)).digest("hex")}` };
}
export function isOperationToolNode(node: OperationNode): node is OperationToolNode { return node.kind === "action"; }
export type OperationIR = { schemaVersion: "workflow-operation-ir/v1" | "workflow-operation-ir/v2" | "workflow-operation-ir/v3" | "workflow-operation-ir/v4" | "workflow-operation-ir/v5" | "workflow-operation-ir/v6" | "workflow-operation-ir/v7" | "workflow-operation-ir/v8"; compilerVersion: "operation-compiler/v1" | "operation-compiler/v2" | "operation-compiler/v3" | "operation-compiler/v4" | "operation-compiler/v5" | "operation-compiler/v6" | "operation-compiler/v7" | "operation-compiler/v8"; trigger: { kind: "manual" }; flow?: ReadSequence;
  inputSchema?: Record<string, unknown>; root: { kind: "sequence"; nodes: OperationNode[] } };
export type CompiledOperationPlan = { ir: OperationIR; semanticHash: string; sourceHash: string };
export type OperationCompilationReceipt = { schemaVersion: OperationIR["schemaVersion"]; compilerVersion: OperationIR["compilerVersion"]; semanticHash: string; sourceHash: string;
  registryHash: string; origin: "PUBLICATION"; admissionMode: "reviewed" };
function projectOperationDefinitions(blueprint: WorkflowBlueprint, built: ReturnType<typeof buildActionBindingsIR>, tools: readonly ToolDefinition[], pins: ReadonlyMap<string, ReadAdmissionPin>): OperationNode[] {
  const toolNodes = new Map(built.ir.root.nodes.map(node => [node.id, node]));
  const analysisNodes = new Map(built.analysisNodes.map(node => [node.id, node]));
  const agentNodes = new Map(built.agentNodes.map(node => [node.id, node]));
  return blueprint.steps.map(step => {
    const analysis = analysisNodes.get(step.id); if (analysis) return analysis;
    const agent = agentNodes.get(step.id); if (agent) return agent;
    const node = toolNodes.get(step.id); if (!node) { built.issues.push(`Step ${step.id} has no compiled operation node`); return null; }
    const tool = tools.find(tool => tool.tool_id === node.capability.toolId)!;
    if (!node.capability.admission || !tool.bridge_contract) built.issues.push("Every operation action requires a reviewed capability pin");
    if (!tool.is_read_only && (!tool.operation_contract || !["low", "medium"].includes(tool.risk_level.toLowerCase()))) built.issues.push("Write actions require an explicit supported operation contract");
    let readback: OperationToolNode["readback"];
    if (tool.operation_contract?.readback) {
      try {
        const contract = tool.operation_contract.readback, targets = tools.filter(target => target.tool_id === contract.tool_id);
        if (targets.length !== 1) throw new Error("Read-back target has no unique exact local contract");
        assertOperationReadbackTarget(tool, targets[0]!);
        const admission = pins.get(connectionToolKey(node.capability.admission!.connectionId, contract.tool_id)) ?? pins.get(contract.tool_id);
        if (!admission || admission.contractHash !== contract.contract_hash || admission.connectionId !== node.capability.admission?.connectionId)
          throw new Error("Read-back target requires a current read admission on the same ERP connection");
        readback = { profile: "operation-readback-binding/v1", toolId: contract.tool_id, contractHash: contract.contract_hash, admission: { ...admission } };
      } catch (error) { built.issues.push(error instanceof Error ? error.message : "Invalid operation read-back binding"); }
    }
    return { ...node, effectClass: tool.is_read_only ? "read" as const : tool.operation_contract?.effect_class ?? "write" as const, ...(readback ? { readback } : {}) };
  }).filter((node): node is OperationNode => node !== null);
}

/** Internal reviewed-definition projection for the separate v9 compiler. It
 * cannot issue a publication receipt or enable the old node-key worker. */
export function projectProtectedCollectionDefinitions(blueprint: WorkflowBlueprint, tools: readonly ToolDefinition[], role: string, pins: ReadonlyMap<string, ReadAdmissionPin>) {
  if (protectedOperationProfile(blueprint) !== "protected-collections-pending") throw new Error("Expected an authored protected collection");
  const built = buildActionBindingsIR(blueprint, tools, role, pins, true, "protected-collection-operation");
  const nodes = projectOperationDefinitions(blueprint, built, tools, pins);
  if (built.issues.length) throw new Error(`Protected collection compilation failed: ${built.issues.join("; ")}`);
  return { nodes, flow: built.ir.flow!, ...(built.ir.inputSchema ? { inputSchema: built.ir.inputSchema } : {}) };
}

export function compileOperationWorkflow(yaml: string, tools: readonly ToolDefinition[], role: string, pins: ReadonlyMap<string, ReadAdmissionPin>): CompiledOperationPlan {
  if (Buffer.byteLength(yaml) > 200_000) throw new Error("Operation source exceeds supported bounds");
  const blueprint = parseWorkflowYAMLStrict(yaml), profile = protectedOperationProfile(blueprint);
  if (profile === "protected-collections-pending") throw new Error("Protected collections require durable operation iteration qualification; no flattened execution is allowed");
  const protectedProfile = profile === "protected", built = buildActionBindingsIR(blueprint, tools, role, pins, true, protectedProfile ? "protected-operation" : "publication");
  const nodes = projectOperationDefinitions(blueprint, built, tools, pins);
  if (!protectedProfile && !nodes.some(node => node.kind === "action" && node.effectClass !== "read") && !nodes.some(node => node.kind === "analysis" || node.kind === "agent"))
    built.issues.push("Deterministic read-only workflows must use the read profile");
  if (built.issues.length) throw new Error(`Operation compilation failed: ${built.issues.join("; ")}`);
  const hasAgent = nodes.some(node => node.kind === "agent"), hasAnalysis = nodes.some(node => node.kind === "analysis");
  const namedInputs = nodes.some(node => node.kind !== "action" && node.input.kind === "object");
  const hasReturn = built.ir.flow && structuralNodes(built.ir.flow).some(node => node.kind === "return");
  const hasMerge = built.ir.flow && controlNodes(built.ir.flow).some(node => node.merge);
  const ir: OperationIR = { schemaVersion: protectedProfile ? "workflow-operation-ir/v8" : hasMerge ? "workflow-operation-ir/v7" : hasReturn ? "workflow-operation-ir/v6" : namedInputs ? "workflow-operation-ir/v5" : built.ir.flow ? "workflow-operation-ir/v4" : hasAgent ? "workflow-operation-ir/v3" : hasAnalysis ? "workflow-operation-ir/v2" : "workflow-operation-ir/v1",
    compilerVersion: protectedProfile ? "operation-compiler/v8" : hasMerge ? "operation-compiler/v7" : hasReturn ? "operation-compiler/v6" : namedInputs ? "operation-compiler/v5" : built.ir.flow ? "operation-compiler/v4" : hasAgent ? "operation-compiler/v3" : hasAnalysis ? "operation-compiler/v2" : "operation-compiler/v1", trigger: { kind: "manual" },
    ...(built.ir.flow ? { flow: structuredClone(built.ir.flow) } : {}),
    ...(built.ir.inputSchema ? { inputSchema: built.ir.inputSchema } : {}), root: { kind: "sequence", nodes } };
  const plan = { ir, semanticHash: `sha256:${createHash("sha256").update(canonicalJSONBytes(ir)).digest("hex")}`, sourceHash: workflowContentHash(yaml) };
  assertProtectedErrorSources(plan, tools);
  return plan;
}
export function operationCompilationReceipt(plan: CompiledOperationPlan, registryHash: string): OperationCompilationReceipt {
  return { schemaVersion: plan.ir.schemaVersion, compilerVersion: plan.ir.compilerVersion, semanticHash: plan.semanticHash, sourceHash: plan.sourceHash, registryHash, origin: "PUBLICATION", admissionMode: "reviewed" };
}

export function compileReadWorkflow(yaml: string, tools: readonly ToolDefinition[], role: string, pins?: ReadonlyMap<string, ReadAdmissionPin>): CompiledReadPlan {
  if (Buffer.byteLength(yaml) > 200_000) throw new Error("Read workflow exceeds supported source size");
  const built = buildReadIR(parseWorkflowYAMLStrict(yaml), tools, role, pins);
  if (built.issues.length) throw new Error(`Read compilation failed: ${built.issues.join("; ")}`);
  return { ir: built.ir, semanticHash: built.semanticHash, sourceHash: workflowContentHash(yaml) };
}

export function assertCompiledReadMatches(expected: CompiledReadPlan, actual: CompiledReadPlan) {
  if (expected.sourceHash !== actual.sourceHash || expected.semanticHash !== actual.semanticHash || hashIR(expected.ir) !== expected.semanticHash)
    throw new Error("Compiled workflow source, semantic identity or capability pins changed");
}

export function resolveReadBinding(binding: ReadBinding, state: Record<string, unknown>): unknown {
  const budget = new ReadValueBudget();
  const resolve = (binding: ReadBinding, depth: number): unknown => {
  budget.enter(depth);
  if (binding.kind === "literal") return budget.scalar(binding.value);
  if (binding.kind === "object") { budget.add("{}"); return Object.fromEntries(Object.entries(binding.fields).map(([key, value]) => { budget.add(`${JSON.stringify(key)}:,`); return [key, resolve(value, depth + 1)]; })); }
  if (binding.kind === "array") { budget.add("[]"); return binding.items.map(value => { budget.add(","); return resolve(value, depth + 1); }); }
  if (binding.kind === "template") return binding.parts.map(part => {
    budget.enter(depth + 1);
    if (typeof part === "string") { budget.scalar(part); return part; }
    const value = resolve(part, depth + 1); if (typeof value !== "string") throw new Error("String templates require string references; no implicit conversion is allowed"); return value;
  }).join("");
  const root = binding.source === "workflowInput" ? "input" : binding.nodeId!;
  if (!Object.hasOwn(state, root)) throw new Error("Compiled data reference is unavailable");
  let current: unknown = state[root];
  for (const part of binding.path) {
    if (reserved.has(part) || current === null || typeof current !== "object" || !Object.hasOwn(current, part)) throw new Error("Compiled data reference is unavailable");
    current = (current as Record<string, unknown>)[part];
  }
  if (current === undefined) throw new Error("Compiled data reference is unavailable");
  return budget.clone(current, depth);
  };
  return resolve(binding, 0);
}
