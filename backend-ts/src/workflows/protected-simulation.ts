import { createHash } from "node:crypto";
import { z } from "zod";
import type { ToolDefinition } from "../registry/schemas.js";
import { canonicalJSONBytes } from "../core/canonical-json.js";
import { withoutSecretFields } from "../redact/secrets.js";
import { safeMcpToolResult } from "../tools/mcp-result.js";
import { validateToolInput } from "../tools/tool-input-schema.js";
import { assertReadErrorContract } from "../tools/read-business-error.js";
import { readErrorContractSchema } from "../registry/read-error-schema.js";
import { compileProtectedFixtureWorkflow, resolveReadBinding, type ReadBinding } from "./compiled-read.js";
import { actionOrder, childSequences, controlPoint, type ReadSequence } from "./read-control-flow.js";
import { boundFixtureData } from "./read-simulation.js";
import { ReadValueBudget } from "./read-value-budget.js";
import { modelInputItemCount } from "./model-input.js";
import type { ReadVisit } from "./read-interpreter.js";
import type { CompletedRead } from "./read-completion-evidence.js";
import { ScopedInvocationIndex } from "./scoped-invocation.js";

const safeID = (value: string) => /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value) && !["input", "__proto__", "constructor", "prototype"].includes(value);
const address = z.string().refine(value => {
  const parts = value.split("/");
  return parts.length <= 17 && parts.length % 2 === 1 && parts.every((part, index) => index % 2 === 0 ? safeID(part) : /^(0|[1-9][0-9]?)$/.test(part));
});
const fixturesSchema = z.object({ profile: z.literal("protected-fixtures/v1"), baseVersion: z.number().int().min(1),
  baseHash: z.string().regex(/^sha256:[a-f0-9]{64}$/), outputs: z.record(address, z.unknown()),
  failures: z.record(address, z.object({ kind: z.literal("business-read-error"), code: z.literal("ERP_RESOURCE_NOT_FOUND") }).strict()).default({}) }).strict();
export function parseProtectedFixtures(raw: unknown) {
  boundFixtureData(raw); const value = fixturesSchema.parse(raw);
  if (Object.keys(value.outputs).length + Object.keys(value.failures).length > 1000 || Object.keys(value.failures).some(id => Object.hasOwn(value.outputs, id)))
    throw new Error("Protected fixture identities must be bounded and unambiguous");
  return value;
}
export type ProtectedFixtures = ReturnType<typeof parseProtectedFixtures>;
export type ProtectedSimulationEntry = { nodeId: string; invocationId: string; iterations: ReadVisit["iterations"]; sourceIndex: number;
  kind: "action" | "analysis" | "agent" | "condition" | "merge" | "return" | "protect" | "collection" | "collection-item";
  outcome: string; arguments?: unknown; output?: unknown; selectedBranch?: "then" | "else"; reason?: string; failedNodeId?: string; count?: number };
export type ProtectedSimulationResult = {
  outcome: "PLAN_BLOCKED" | "SIMULATED_COMPLETE" | "SIMULATED_STOPPED";
  trace: ProtectedSimulationEntry[];
  stepOutputs: Record<string, unknown>;
  valueOutputs: Record<string, { value: unknown }>;
  usedFixtureIds: string[];
  unusedFixtureIds: string[];
  issues?: string[];
  reason?: string;
  failedNodeId?: string;
  finalOutput?: unknown;
  fixtureHash?: string;
  sourceHash?: string;
  simulationHash?: string;
};
class SimulationStop extends Error { constructor(readonly code: string) { super(code); } }
class FixtureBusinessFailure extends Error { constructor(readonly nodeId: string) { super("Supplied business-read-error fixture"); } }

/** Pure test-data evaluation only. No repository, broker, SDK, provider,
 * approval service, runtime plan or durable checkpoint can be supplied. */
export async function simulateProtectedWorkflow(yaml: string, input: Record<string, unknown>, fixtures: ProtectedFixtures,
  tools: readonly ToolDefinition[], role: string,
  validateSelected?: (nodeId: string, args: Record<string, unknown>, prior: readonly CompletedRead[], visit: ReadVisit) => boolean): Promise<ProtectedSimulationResult> {
  boundFixtureData({ input, outputs: fixtures.outputs, failures: fixtures.failures });
  const trace: ProtectedSimulationEntry[] = [], stepOutputs: Record<string, unknown> = {}, valueOutputs: Record<string, { value: unknown }> = {}, used = new Set<string>();
  const suppliedIDs = [...Object.keys(fixtures.outputs), ...Object.keys(fixtures.failures)];
  let projection: ReturnType<typeof compileProtectedFixtureWorkflow>;
  try { projection = compileProtectedFixtureWorkflow(yaml, tools, role); }
  catch { return { outcome: "PLAN_BLOCKED", issues: ["Protected simulation requires valid explicit scopes, typed bindings and a mapped business-read-error source"], trace, stepOutputs, valueOutputs, usedFixtureIds: [], unusedFixtureIds: suppliedIDs }; }
  const definitions = new Map(projection.nodes.map((node, index) => [node.id, { node, index }]));
  const invocationIndex = new ScopedInvocationIndex(projection.flow);
  for (const id of suppliedIDs) {
    const invocation = invocationIndex.resolveAddress(id);
    if (invocation.kind !== "action" || !definitions.has(invocation.nodeId))
      throw new Error("Protected fixture names must match declared nodes and exact iteration scope");
    if (Object.hasOwn(fixtures.failures, id)) {
      const definition = definitions.get(invocation.nodeId)!.node, tool = definition.kind === "action" ? tools.find(tool => tool.tool_id === definition.capability.toolId) : undefined;
      if (!tool || !readErrorContractSchema.safeParse(tool.read_error_contract).success) throw new Error("Only mapped read nodes accept business-error fixtures");
      assertReadErrorContract(tool);
    }
  }
  const identity = { fixtureHash: `sha256:${createHash("sha256").update(canonicalJSONBytes({ input, outputs: fixtures.outputs, failures: fixtures.failures })).digest("hex")}`,
    sourceHash: projection.sourceHash, simulationHash: projection.simulationHash };
  const state: Record<string, unknown> = { input: structuredClone(input) }, prior: CompletedRead[] = [];
  let iterations: Array<{ loopId: string; index: number }> = [], visits = 0, bytes = 0, failedNodeId: string | undefined, finalOutput: unknown, hasFinal = false;
  const location = (id: string): ReadVisit => ({ invocationId: [...iterations.flatMap(item => [item.loopId, String(item.index)]), id].join("/"), iterations: structuredClone(iterations) });
  const append = (id: string, kind: ProtectedSimulationEntry["kind"], outcome: string, extra: Partial<ProtectedSimulationEntry> = {}) => {
    const entry = { nodeId: id, kind, outcome, sourceIndex: definitions.get(id)?.index ?? controlPoint(projection.flow, id), ...location(id), ...extra };
    bytes += canonicalJSONBytes(entry).length;
    if (trace.length >= 5000 || bytes > 1_000_000) throw new SimulationStop("SIMULATION_OUTPUT_LIMIT");
    trace.push(entry);
  };
  const stop = (id: string, kind: ProtectedSimulationEntry["kind"], code: string, extra: Partial<ProtectedSimulationEntry> = {}): never => {
    failedNodeId = id; append(id, kind, code, extra); throw new SimulationStop(code);
  };
  const restore = (outer: Record<string, unknown>) => { for (const key of Object.keys(state)) delete state[key]; Object.assign(state, outer); };
  const safeTyped = (id: string, kind: ProtectedSimulationEntry["kind"], binding: ReadBinding, schema: Record<string, unknown>, outcome: string) => {
    let raw: unknown;
    try { raw = resolveReadBinding(binding, state); } catch { return stop(id, kind, "BINDING_UNAVAILABLE_OR_LIMITED"); }
    if (validateToolInput(schema, raw).length) return stop(id, kind, "VALUE_INVALID");
    const value = withoutSecretFields({ value: raw }) as { value: unknown };
    if (!Object.hasOwn(value, "value") || validateToolInput(schema, value.value).length) return stop(id, kind, "VALUE_INVALID");
    valueOutputs[location(id).invocationId] = value; append(id, kind, outcome, { output: value.value }); return value;
  };
  const skip = (block: ReadSequence, reason: string, failed?: string) => {
    for (const id of actionOrder(block)) append(id, definitions.get(id)!.node.kind, "NOT_EVALUATED", { reason, ...(failed ? { failedNodeId: failed } : {}) });
  };
  const action = (id: string) => {
    const { node, index } = definitions.get(id)!, visit = location(id), key = visit.invocationId;
    failedNodeId = id;
    let resolved: unknown;
    try { resolved = resolveReadBinding(node.kind === "action" ? node.inputs : node.input, state); }
    catch { return stop(id, node.kind, "BINDING_UNAVAILABLE_OR_LIMITED"); }
    const args = withoutSecretFields(resolved);
    let output: Record<string, unknown>;
    if (node.kind === "action") {
      const tool = tools.find(tool => tool.tool_id === node.capability.toolId)!;
      if (validateToolInput(tool.input_schema, resolved).length) return stop(id, "action", "ARGUMENTS_INVALID");
      if (validateSelected && !validateSelected(id, resolved as Record<string, unknown>, prior, visit)) return stop(id, "action", "SELECTED_PATH_RULE_BLOCKED");
      if (Object.hasOwn(fixtures.failures, key)) {
        used.add(key); append(id, "action", "SUPPLIED_BUSINESS_READ_ERROR", { arguments: args, output: { code: "ERP_RESOURCE_NOT_FOUND", failedNodeId: id } });
        throw new FixtureBusinessFailure(id);
      }
      if (!Object.hasOwn(fixtures.outputs, key)) return stop(id, "action", "MISSING_FIXTURE", { arguments: args });
      try { output = safeMcpToolResult(fixtures.outputs[key], tool); }
      catch { return stop(id, "action", "FIXTURE_OUTPUT_INVALID"); }
      used.add(key);
      if (output.isError === true) return stop(id, "action", "FIXTURE_TOOL_ERROR", { arguments: args });
      prior.push({ nodeId: id, sourceIndex: index, args: resolved as Record<string, unknown>, visit });
      append(id, "action", tool.is_read_only ? "SUPPLIED_READ_OUTPUT" : "SUPPLIED_EFFECT_OUTPUT_NOT_APPROVED", { arguments: args, output });
    } else {
      try { if (modelInputItemCount(node.input, resolved) > node.maxInputItems || [...JSON.stringify(resolved)].length > node.maxInputChars) return stop(id, node.kind, "MODEL_INPUT_LIMIT_EXCEEDED"); }
      catch (error) { if (error instanceof SimulationStop) throw error; return stop(id, node.kind, "MODEL_INPUT_LIMIT_EXCEEDED"); }
      if (!Object.hasOwn(fixtures.outputs, key)) return stop(id, node.kind, "MISSING_FIXTURE", { arguments: args });
      const supplied = fixtures.outputs[key];
      if (!supplied || typeof supplied !== "object" || Array.isArray(supplied) || Object.keys(supplied).some(key => key !== "structuredContent") || !Object.hasOwn(supplied, "structuredContent")) return stop(id, node.kind, "FIXTURE_OUTPUT_INVALID");
      const answer = (supplied as Record<string, unknown>).structuredContent;
      if (validateToolInput(node.outputSchema, answer).length) return stop(id, node.kind, "FIXTURE_OUTPUT_INVALID");
      output = withoutSecretFields({ structuredContent: answer }) as Record<string, unknown>;
      if (validateToolInput(node.outputSchema, output.structuredContent).length) return stop(id, node.kind, "FIXTURE_OUTPUT_INVALID");
      used.add(key);
      if (node.kind === "agent") {
        let complete: unknown;
        try { complete = resolveReadBinding({ kind: "ref", source: "nodeOutput", nodeId: "fixture", path: node.completionPredicate.path }, { fixture: output.structuredContent }); }
        catch { return stop(id, node.kind, "FIXTURE_AGENT_INCOMPLETE"); }
        if (complete !== node.completionPredicate.equals) return stop(id, node.kind, "FIXTURE_AGENT_INCOMPLETE");
      }
      append(id, node.kind, "SUPPLIED_MODEL_OUTPUT", { arguments: args, output });
    }
    stepOutputs[key] = output; state[id] = output; finalOutput = output; hasFinal = true;
  };
  const visit = (block: ReadSequence): string | undefined => {
    let returned: string | undefined;
    for (let at = 0; at < block.nodes.length; at++) {
      const node = block.nodes[at]!;
      if (++visits > 5000) throw new SimulationStop("SIMULATION_VISIT_LIMIT");
      if (returned) { skip({ kind: "sequence", nodes: [node] }, "AFTER_RETURN"); continue; }
      try {
        if (node.kind === "action") { action(node.nodeId); continue; }
        failedNodeId = node.id;
        if (node.kind === "return") {
          const value = safeTyped(node.id, "return", node.output.value, node.output.schema, "SIMULATED_RETURN");
          finalOutput = value.value; hasFinal = true; returned = node.id; continue;
        }
        const outer = { ...state };
        if (node.kind === "if") {
          let predicate: unknown;
          try { predicate = resolveReadBinding(node.predicate, state); } catch { return stop(node.id, "condition", "PREDICATE_INVALID"); }
          if (typeof predicate !== "boolean") return stop(node.id, "condition", "PREDICATE_INVALID");
          const selected = predicate ? "then" : "else";
          append(node.id, "condition", "SIMULATED_DECISION", { selectedBranch: selected });
          if (!predicate) skip(node.then, "NOT_SELECTED"); returned = visit(node[selected]); if (predicate) skip(node.else, "NOT_SELECTED");
          const value = !returned && node.merge ? safeTyped(node.id, "merge", node.merge[selected], node.merge.schema, "SIMULATED_MERGE") : undefined;
          restore(outer); if (value) state[node.id] = value; continue;
        }
        if (node.kind === "foreach") {
          let items: unknown;
          try { items = resolveReadBinding(node.items.value, state); } catch { return stop(node.id, "collection", "COLLECTION_INPUT_INVALID"); }
          if (!Array.isArray(items) || validateToolInput(node.items.schema, items).length) return stop(node.id, "collection", "COLLECTION_INPUT_INVALID");
          if (items.length > node.maxItems) return stop(node.id, "collection", "COLLECTION_LIMIT_EXCEEDED");
          append(node.id, "collection", "SIMULATED_COLLECTION_STARTED", { count: items.length });
          const collected: unknown[] = [], budget = new ReadValueBudget();
          if (!items.length) skip(node.body, "EMPTY_COLLECTION");
          for (let index = 0; index < items.length; index++) {
            iterations.push({ loopId: node.id, index }); state[node.id] = { item: items[index], index };
            try {
              if (visit(node.body)) return stop(node.id, "collection", "COLLECTION_RETURN_INVALID");
              const value = safeTyped(node.id, "collection-item", node.collect.value, node.collect.schema, "SIMULATED_ITEM");
              collected.push(budget.clone(value.value, 0));
            } finally { iterations.pop(); restore(outer); }
          }
          const value = { value: collected }; state[node.id] = value; valueOutputs[location(node.id).invocationId] = value;
          append(node.id, "collection", "SIMULATED_COLLECTION", { output: collected }); continue;
        }
        append(node.id, "protect", "SIMULATED_GROUP_STARTED");
        let handled = false;
        try {
          try { returned = visit(node.body); }
          catch (error) {
            if (!(error instanceof FixtureBusinessFailure)) throw error;
            handled = true; restore(outer); state[node.id] = { error: { code: node.onError.code, failedNodeId: error.nodeId } };
            append(node.id, "protect", "SIMULATED_HANDLER_SELECTED", { failedNodeId: error.nodeId }); returned = visit(node.handler);
          }
          if (!handled) skip(node.handler, returned ? "AFTER_RETURN" : "BODY_SUCCEEDED");
          const value = returned ? undefined : safeTyped(node.id, "protect", node.output[handled ? "handled" : "success"], node.output.schema,
            handled ? "SIMULATED_HANDLED_ERROR" : "SIMULATED_GROUP_SUCCEEDED");
          if (returned) append(node.id, "protect", "SIMULATED_GROUP_RETURNED");
          restore(outer); if (value) { state[node.id] = value; finalOutput = value.value; hasFinal = true; }
        } catch (error) { restore(outer); append(node.id, "protect", handled ? "SIMULATED_HANDLER_FAILED" : "SIMULATED_GROUP_FAILED"); throw error; }
      } catch (error) {
        if (error instanceof FixtureBusinessFailure) skip({ kind: "sequence", nodes: block.nodes.slice(at + 1) }, "BODY_ABORTED", error.nodeId);
        throw error;
      }
    }
    return returned;
  };
  const result = () => ({ trace, stepOutputs, valueOutputs, ...(hasFinal ? { finalOutput } : {}), usedFixtureIds: [...used], unusedFixtureIds: suppliedIDs.filter(id => !used.has(id)), ...identity });
  try {
    if (projection.inputSchema && validateToolInput(projection.inputSchema, input).length) throw new SimulationStop("WORKFLOW_INPUT_INVALID");
    visit(projection.flow); return { outcome: "SIMULATED_COMPLETE", ...result() };
  } catch (error) {
    return { outcome: "SIMULATED_STOPPED", reason: error instanceof SimulationStop ? error.code : error instanceof FixtureBusinessFailure ? "UNHANDLED_FIXTURE_BUSINESS_ERROR" : "SIMULATION_EVALUATION_FAILED",
      ...(failedNodeId ? { failedNodeId } : {}), ...result() };
  }
}
