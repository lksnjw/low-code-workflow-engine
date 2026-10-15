import type { WorkflowBlueprint } from "../models/schemas.js";
import { effectiveStepKind } from "../models/schemas.js";
import type { ToolDefinition } from "../registry/schemas.js";
import { validateToolSchemaProfile } from "../tools/tool-input-schema.js";
import { capabilityContractHash } from "../registry/capability-admission.js";
import { canonicalJSONBytes } from "../core/canonical-json.js";
import { inspectWorkflowDraft, type ReadReference } from "./compiled-read.js";
import { controlNodes, structuralNodes, loopNodes, protectedNodes, protectedFaultSchema, handlerScopeIDs, type ReadSequence } from "./read-control-flow.js";
import { draftFlow } from "./draft-control-edits.js";
import { isSecretField } from "../redact/secrets.js";
import { usesCheckpointedOperationWorkflow } from "./execution-shape.js";
import { protectedErrorSourceIssues, protectedOperationProfile } from "./protected-operation-profile.js";
import { assertReadErrorContract } from "../tools/read-business-error.js";
import { readErrorContractSchema } from "../registry/read-error-schema.js";
import { reviewedReadOutputKey } from "../tools/mcp-result.js";

type Schema = Record<string, unknown>;
type Source = { label: string; expression: string; binding: ReadReference; schema: Schema };
const reserved = new Set(["__proto__", "constructor", "prototype"]);
const safeID = (id: string) => /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id) && id !== "input" && !reserved.has(id);

/** Offline authoring hints, never discovery or dispatch authority. Schema
 * annotations/defaults/examples can contain business data or credentials and
 * are deliberately omitted. No result samples or connection secrets enter it. */
export function readAuthoringContract(blueprint: WorkflowBlueprint, tools: readonly ToolDefinition[], role: string, registryHash: string,
  connections: readonly { id: string; primary: boolean; dispatchSupported: boolean }[] = []) {
  let schemaNodes = 0, sourceNodes = 0;
  const project = (raw: unknown, runInput = false): Schema | undefined => {
    if (validateToolSchemaProfile(raw).length) return undefined;
    const visit = (schema: Schema, inheritedSensitive = false): Schema => {
      if (++schemaNodes > 4096) throw new Error("Authoring schema budget exceeded");
      const result: Schema = { type: schema.type };
      const sensitive = inheritedSensitive || schema.writeOnly === true;
      if (sensitive) result.writeOnly = true;
      // Run controls need the actual declared choices and bounds. Keep tool
      // hints type-only and never expose defaults, examples or secret enums.
      if (runInput && !sensitive) {
        if (typeof schema.maxItems === "number") result.maxItems = schema.maxItems;
        if (Array.isArray(schema.enum)) result.enum = structuredClone(schema.enum);
      }
      if (schema.type === "object") {
        const entries = Object.entries(schema.properties as Record<string, Schema> ?? {});
        if (entries.some(([key]) => reserved.has(key))) throw new Error("Reserved schema field");
        result.properties = Object.fromEntries(entries.map(([key, child]) => [key, visit(child, sensitive || isSecretField(key))]));
        if (schema.required) result.required = [...schema.required as string[]];
        if (schema.additionalProperties !== undefined) result.additionalProperties = schema.additionalProperties;
      }
      if (schema.type === "array") result.items = visit(schema.items as Schema, sensitive);
      return result;
    };
    try { return visit(raw as Schema); } catch { return undefined; }
  };
  const sources = (schema: Schema | undefined, root: ReadReference, label: string): Source[] => {
    const result: Source[] = [];
    const visit = (value: Schema, path: string[]) => {
      if (value.writeOnly === true || result.length >= 128 || sourceNodes >= 8192) return;
      // Do not suggest a whole object containing fields marked writeOnly.
      const sensitive = (item: Schema): boolean => item.writeOnly === true || Object.values(item.properties as Record<string, Schema> ?? {}).some(sensitive) || !!item.items && sensitive(item.items as Schema);
      if (!sensitive(value)) {
        sourceNodes++;
        const binding = { ...root, path }, expression = `{{${[root.source === "workflowInput" ? "input" : root.nodeId!, ...path].join(".")}}}`;
        const displayPath = root.source === "nodeOutput" ? path.slice(root.path.length) : path;
        result.push({ label: [label, ...displayPath].join(" · "), expression, binding, schema: value });
      }
      if (value.type === "object") for (const [key, child] of Object.entries(value.properties as Record<string, Schema> ?? {}))
        if (/^[A-Za-z0-9_-]+$/.test(key) && !reserved.has(key)) visit(child, [...path, key]);
    };
    if (schema) visit(schema, root.path);
    return result;
  };
  const declaredInput = blueprint.trigger.config?.inputSchema as Schema | undefined;
  const inputSchema = declaredInput?.type === "object" ? project(declaredInput, true) : undefined;
  const upstream = sources(inputSchema, { kind: "ref", source: "workflowInput", path: [] }, "Workflow input");
  const compiled = blueprint.metadata?.controlFlow === undefined ? undefined : inspectWorkflowDraft(blueprint, tools, role);
  const scopes = compiled && !compiled.issues.length ? compiled.scopeValidation?.scopes : undefined;
  let editableFlow: ReadSequence | undefined;
  try { if (blueprint.metadata?.controlFlow !== undefined) editableFlow = draftFlow(blueprint); } catch { /* Invalid ownership is never depicted as executable structure. */ }
  if (editableFlow) for (const node of controlNodes(editableFlow)) if (node.merge)
    upstream.push(...sources(project(node.merge.schema), { kind: "ref", source: "nodeOutput", nodeId: node.id, path: ["value"] }, `Branch ${node.id}`));
  const iterationScopes = new Map<string, Set<string>>();
  const collections = editableFlow ? loopNodes(editableFlow) : [], collectionIDs = new Set(collections.map(node => node.id));
  const protectedGroups = editableFlow ? protectedNodes(editableFlow) : [], protectedIDs = new Set(protectedGroups.map(node => node.id));
  const handlerScopes = editableFlow ? handlerScopeIDs(editableFlow) : new Map<string, string[]>();
  const visitScope = (block: ReadSequence, active: Set<string>) => { for (const node of block.nodes) {
    iterationScopes.set(node.kind === "action" ? node.nodeId : node.id, new Set(active));
    if (node.kind === "if") { visitScope(node.then, active); visitScope(node.else, active); }
    else if (node.kind === "foreach") visitScope(node.body, new Set([...active, node.id]));
    else if (node.kind === "protect") { visitScope(node.body, active); visitScope(node.handler, active); }
  } };
  if (editableFlow) {
    visitScope(editableFlow, new Set());
    for (const node of collections) {
      upstream.push(...sources(project(node.items.schema.items), { kind: "ref", source: "nodeOutput", nodeId: node.id, path: ["item"] }, `Collection ${node.id} · current item`));
      upstream.push(...sources({ type: "integer" }, { kind: "ref", source: "nodeOutput", nodeId: node.id, path: ["index"] }, `Collection ${node.id} · item index`));
      upstream.push(...sources(project({ type: "array", items: node.collect.schema }), { kind: "ref", source: "nodeOutput", nodeId: node.id, path: ["value"] }, `Collection ${node.id} · collected items`));
    }
  }
  for (const node of protectedGroups) {
    upstream.push(...sources(project(node.output.schema), { kind: "ref", source: "nodeOutput", nodeId: node.id, path: ["value"] }, `Protected group ${node.id} · declared output`));
    const errorSchema = (protectedFaultSchema.properties as Record<string, Schema>).error;
    upstream.push(...sources(project(errorSchema), { kind: "ref", source: "nodeOutput", nodeId: node.id, path: ["error"] }, `Protected group ${node.id} · handler error`));
  }
  const scopedSource = (source: Source, nodeId: string) => {
    if (source.binding.source === "nodeOutput" && protectedIDs.has(source.binding.nodeId!)) {
      const active = handlerScopes.get(nodeId)?.includes(source.binding.nodeId!) ?? false;
      return source.binding.path[0] === "error" ? active : !active;
    }
    if (source.binding.source !== "nodeOutput" || !collectionIDs.has(source.binding.nodeId!)) return true;
    const active = iterationScopes.get(nodeId)?.has(source.binding.nodeId!) ?? false;
    return source.binding.path[0] === "value" ? !active : active;
  };
  const nodeSource = (source: Source, nodeId: string) => scopedSource(source, nodeId) && (!compiled || !!scopes &&
    (source.binding.source === "workflowInput" || !!scopes.get(nodeId)?.has(source.binding.nodeId!)));
  let prefix = blueprint.trigger.type === "manual" && Object.keys(blueprint.trigger.config ?? {}).every(key => key === "inputSchema"), seen = new Set<string>();
  const nodes = blueprint.steps.slice(0, 200).map(step => {
    const kind = effectiveStepKind(step);
    if (kind === "analysis") {
      const outputSchema = project(step.output_schema), validScope = prefix && safeID(step.id) && !seen.has(step.id) &&
        Object.keys(step).every(key => ["id", "kind", "description", "instruction", "input", "output_schema", "data_class", "model", "max_input_items", "max_input_chars", "max_output_tokens"].includes(key));
      const result = { nodeId: step.id, sourceAction: "analysis", kind: "analysis", state: outputSchema ? "LOCAL_CONTRACT" : "UNAVAILABLE",
        ...(outputSchema ? { outputSchema } : {}), dataSources: validScope ? upstream.filter(source => nodeSource(source, step.id)).slice(-32).map(source => structuredClone(source)) : [],
        reason: outputSchema ? "Declared structured analysis contract only; provider egress, model admission and runtime validation are separate" : "Analysis requires a supported object output schema" };
      prefix = validScope && !!outputSchema;
      if (prefix) upstream.push(...sources(outputSchema, { kind: "ref", source: "nodeOutput", nodeId: step.id, path: ["structuredContent"] }, `Analysis ${step.id}`));
      seen.add(step.id); return result;
    }
    if (kind === "agent") {
      const outputSchema = project(step.output_schema), allowed = step.allowed_actions ?? [];
      const allowedTools = allowed.map(action => tools.filter(tool => tool.name === action || tool.mcp_tool_name === action)).filter(matches => matches.length === 1).map(matches => matches[0]!)
        .filter(tool => tool.is_read_only && tool.allowed_roles.includes(role));
      const validScope = prefix && safeID(step.id) && !seen.has(step.id) && allowed.length > 0 && allowedTools.length === allowed.length &&
        Object.keys(step).every(key => ["id", "kind", "connection_id", "description", "instruction", "input", "allowed_actions", "output_schema", "completion_predicate", "data_class", "model",
          "max_input_items", "max_input_chars", "max_output_tokens", "max_total_tokens", "max_rounds", "max_tool_calls", "max_wall_time_ms", "max_concurrency"].includes(key));
      const result = { nodeId: step.id, sourceAction: "agent", kind: "agent", ...(step.connection_id || connections.length ? { connectionId: step.connection_id ?? connections.find(item => item.primary)?.id ?? connections[0]!.id } : {}), state: outputSchema && allowedTools.length === allowed.length ? "LOCAL_CONTRACT" : "UNAVAILABLE",
        ...(outputSchema ? { outputSchema } : {}), actions: allowedTools.flatMap(tool => [tool.name, tool.mcp_tool_name]),
        dataSources: validScope ? upstream.filter(source => nodeSource(source, step.id)).slice(-32).map(source => structuredClone(source)) : [],
        reason: outputSchema ? "Declared bounded runtime-agent contract only; reviewed allow-list, egress and per-call gateway checks remain separate" : "Agent requires a supported object output schema" };
      prefix = validScope && !!outputSchema;
      if (prefix) upstream.push(...sources(outputSchema, { kind: "ref", source: "nodeOutput", nodeId: step.id, path: ["structuredContent"] }, `Agent ${step.id}`));
      seen.add(step.id); return result;
    }
    const matches = tools.filter(tool => tool.name === step.action || tool.mcp_tool_name === step.action), tool = matches.length === 1 ? matches[0] : undefined;
    const granted = !!tool && !!tool.tool_id.trim() && !!tool.mcp_tool_name.trim() && tool.input_schema.type === "object" && (tool.is_read_only || !!tool.operation_contract && (!compiled || !!scopes)) && tool.allowed_roles.includes(role) && effectiveStepKind(step) === "tool";
    const schema = granted ? project(tool.input_schema) : undefined;
    const outputSchema = granted && tool?.bridge_contract?.output_schema ? project(tool.bridge_contract.output_schema) : undefined;
    const validScope = prefix && safeID(step.id) && !seen.has(step.id) && Object.keys(step).every(key => ["id", "kind", "action", "connection_id", "parameters", "description"].includes(key));
    let simulatedBusinessReadErrorCodes: string[] = [];
    if (granted && tool && readErrorContractSchema.safeParse(tool.read_error_contract).success) {
      try { assertReadErrorContract(tool); simulatedBusinessReadErrorCodes = ["ERP_RESOURCE_NOT_FOUND"]; } catch { /* Never offer a safeguard as a business-fault fixture. */ }
    }
    const result = { nodeId: step.id, sourceAction: step.action ?? "", ...(step.connection_id || connections.length ? { connectionId: step.connection_id ?? connections.find(item => item.primary)?.id ?? connections[0]!.id } : {}), state: schema ? "LOCAL_CONTRACT" : "UNAVAILABLE",
      simulatedBusinessReadErrorCodes,
      ...(schema && tool ? { inputSchema: schema, ...(outputSchema ? { outputSchema } : {}), contractHash: capabilityContractHash(tool), actions: [tool.name, tool.mcp_tool_name], effectClass: tool.is_read_only ? "read" : tool.operation_contract!.effect_class, requiresIndependentApproval: !tool.is_read_only } : {}),
      dataSources: validScope && (!compiled || scopes) ? upstream.filter(source => scopedSource(source, step.id) && (!scopes || source.binding.source === "workflowInput" || scopes.get(step.id)?.has(source.binding.nodeId!))).slice(-32).map(source => structuredClone(source)) : [],
      reason: schema ? "Local schema guidance only; live admission and runtime checks are separate" : "No supported role-granted local read schema; existing values are preserved" };
    prefix = validScope && granted && !!schema;
    if (prefix && tool?.bridge_contract?.output_schema) {
      upstream.push(...sources(outputSchema, { kind: "ref", source: "nodeOutput", nodeId: step.id, path: [reviewedReadOutputKey(tool)] }, `Node ${step.id}`));
    }
    seen.add(step.id);
    return result;
  });
  const controlScopes = editableFlow ? compiled?.scopeValidation : undefined;
  const dataFor = (scope: Set<string> | undefined, nodeId: string, ownItem = false) => upstream.filter(source =>
    (ownItem && source.binding.source === "nodeOutput" && source.binding.nodeId === nodeId ? source.binding.path[0] !== "value" : scopedSource(source, nodeId)) &&
    (source.binding.source === "workflowInput" || scope?.has(source.binding.nodeId!))).slice(-32).map(source => structuredClone(source));
  const conditions = editableFlow ? controlNodes(editableFlow).map(node => ({ nodeId: node.id, dataSources: dataFor(controlScopes?.scopes.get(node.id), node.id).filter(source => source.schema.type === "boolean"), mergeSources: { then: dataFor(controlScopes?.branchScopes.get(node.id)?.then, node.id), else: dataFor(controlScopes?.branchScopes.get(node.id)?.else, node.id) } })) : [];
  const returns = editableFlow ? structuralNodes(editableFlow).filter(node => node.kind === "return").map(node => ({ nodeId: node.id, dataSources: dataFor(controlScopes?.scopes.get(node.id), node.id) })) : [];
  const collectionGuides = collections.map(node => ({ nodeId: node.id, itemSources: dataFor(controlScopes?.collectionScopes.get(node.id)?.items, node.id),
    collectSources: dataFor(controlScopes?.collectionScopes.get(node.id)?.collect, node.id, true) }));
  const protectedGuides = protectedGroups.map(node => {
    const pathSources = (path: "success" | "handled") => upstream.filter(source => {
      const own = source.binding.source === "nodeOutput" && source.binding.nodeId === node.id;
      return (own ? path === "handled" && source.binding.path[0] === "error" : scopedSource(source, node.id)) &&
        (source.binding.source === "workflowInput" || controlScopes?.protectedScopes.get(node.id)?.[path].has(source.binding.nodeId!));
    }).slice(-32).map(source => structuredClone(source));
    return { nodeId: node.id, patchVersion: "prompt/protected-group-patch/v1" as const,
      outputSources: { success: pathSources("success"), handled: pathSources("handled") } };
  });
  let protectedProfile: ReturnType<typeof protectedOperationProfile> | undefined;
  try { protectedProfile = protectedOperationProfile(blueprint); } catch { /* Malformed draft remains unavailable. */ }
  const protectedIssues = editableFlow ? protectedErrorSourceIssues(editableFlow, blueprint.steps.map(step => {
    const actions = effectiveStepKind(step) === "agent" ? step.allowed_actions ?? [] : effectiveStepKind(step) === "tool" ? [step.action] : [];
    return { id: step.id, tools: actions.flatMap(action => {
      const matches = tools.filter(tool => tool.name === action || tool.mcp_tool_name === action);
      return matches.length === 1 && matches[0]!.allowed_roles.includes(role) ? matches : [];
    }) };
  })) : [];
  const executionProfile = protectedProfile === "protected" && !!compiled && !compiled.issues.length && !protectedIssues.length ? "protected-operation-v1" : protectedGroups.length || protectedProfile === "protected-collections-pending" || (blueprint.metadata?.controlFlow as { schemaVersion?: unknown } | undefined)?.schemaVersion === "read-control-flow/v4" ? "protected-draft-runtime-pending" : blueprint.metadata?.controlFlow !== undefined && usesCheckpointedOperationWorkflow(blueprint, tools) ? !editableFlow || compiled?.issues.length ? "unsupported-operation-control-flow" : "decision-operation-v1" : collections.length ? "collection-simulation-only" :
    editableFlow && structuralNodes(editableFlow).some(node => node.kind === "return" || node.kind === "if" && node.merge) ? "structured-read-v1" : editableFlow ? "conditional-read-v1" : "sequential-read-v1";
  const connectionChoices = connections.filter(item => /^[a-z][a-z0-9_-]{0,63}$/.test(item.id) && item.dispatchSupported).map(item => ({ id: item.id, primary: item.primary }));
  const modelNodesSupported = prefix && blueprint.steps.length > 0 && (!editableFlow || structuralNodes(editableFlow).every(node => node.kind === "return" || node.kind === "if" || node.kind === "protect")) && (!compiled || !compiled.issues.length);
  const returnNodesSupported = prefix && blueprint.trigger.type === "manual" && (!compiled || !compiled.issues.length) && (!editableFlow || structuralNodes(editableFlow).every(node => node.kind === "return" || node.kind === "if" || node.kind === "protect"));
  const mergeNodesSupported = returnNodesSupported;
  const value = { profile: "read-authoring/v1", registryHash, executionProfile, protectedSimulationProfile: protectedGroups.length ? "protected-fixtures/v1" : null, modelNodesSupported, returnNodesSupported, mergeNodesSupported, connectionChoices, ...(inputSchema ? { inputSchema } : {}), nodes, ...(protectedIssues.length ? { protectedIssues } : {}), ...(editableFlow ? { controlFlow: editableFlow, conditions, returns, collections: collectionGuides, protectedGroups: protectedGuides } : {}) };
  if (canonicalJSONBytes(value).length > 1_000_000) return { profile: "read-authoring/v1", registryHash, executionProfile, protectedSimulationProfile: null, nodes: [], conditions: [], returns: [], collections: [], protectedGroups: [], ...(value.controlFlow ? { controlFlow: value.controlFlow } : {}), reason: "Schema guidance exceeds supported size; values remain preserved" };
  return value;
}
