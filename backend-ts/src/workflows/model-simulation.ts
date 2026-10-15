import { createHash } from "node:crypto";
import { z } from "zod";
import type { ToolDefinition } from "../registry/schemas.js";
import { compileModelFixtureWorkflow, resolveReadBinding, type CompiledReadPlan } from "./compiled-read.js";
import { interpretReadPlan, type ReadVisit } from "./read-interpreter.js";
import { boundFixtureData, type SimulationEntry } from "./read-simulation.js";
import { modelInputItemCount } from "./model-input.js";
import { validateToolInput } from "../tools/tool-input-schema.js";
import { safeMcpToolResult } from "../tools/mcp-result.js";
import { withoutSecretFields } from "../redact/secrets.js";
import { canonicalJSONBytes } from "../core/canonical-json.js";
import type { CompletedRead } from "./read-completion-evidence.js";
import { structuralNodes } from "./read-control-flow.js";

const safeID = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/).refine(value => !["input", "__proto__", "constructor", "prototype"].includes(value));
const fixturesSchema = z.object({ profile: z.literal("model-fixtures/v1"), baseVersion: z.number().int().min(1),
  baseHash: z.string().regex(/^sha256:[a-f0-9]{64}$/), outputs: z.record(safeID, z.unknown()) }).strict();
export function parseModelFixtures(raw: unknown) {
  boundFixtureData(raw);
  const value = fixturesSchema.parse(raw);
  if (Object.keys(value.outputs).length > 200) throw new Error("Too many model fixtures");
  return value;
}
export type ModelFixtures = ReturnType<typeof parseModelFixtures>;
type ModelSimulationEntry = Omit<SimulationEntry, "kind"> & { kind: SimulationEntry["kind"] | "analysis" | "agent" };
class SimulationStop extends Error { constructor(readonly code: string) { super(code); } }

/** Only supplied finite JSON is interpreted. No runtime services, admission,
 * provider or broker can be passed; test answers never become run evidence. */
export async function simulateModelWorkflow(yaml: string, input: Record<string, unknown>, fixtures: ModelFixtures, tools: readonly ToolDefinition[], role: string,
  validateSelected?: (nodeId: string, args: Record<string, unknown>, prior: readonly CompletedRead[], visit: ReadVisit) => boolean) {
  const trace: ModelSimulationEntry[] = [], stepOutputs: Record<string, unknown> = {}, valueOutputs: Record<string, { value: unknown }> = {}, used = new Set<string>(), prior: CompletedRead[] = [];
  const empty = { trace, stepOutputs, valueOutputs, usedFixtureIds: [], unusedFixtureIds: Object.keys(fixtures.outputs) };
  boundFixtureData({ input, outputs: fixtures.outputs });
  let projection: ReturnType<typeof compileModelFixtureWorkflow>;
  try { projection = compileModelFixtureWorkflow(yaml, tools, role); }
  catch { return { outcome: "PLAN_BLOCKED", issues: ["Model fixtures require a supported read/model draft without effects or collections"], ...empty }; }
  const definitions = new Map(projection.nodes.map(node => [node.id, node]));
  const values = new Map<string, { kind: "merge" | "return"; schema: Record<string, unknown> }>();
  for (const node of projection.flow ? structuralNodes(projection.flow) : []) {
    if (node.kind === "return") values.set(node.id, { kind: "return", schema: node.output.schema });
    else if (node.kind === "if" && node.merge) values.set(node.id, { kind: "merge", schema: node.merge.schema });
  }
  if (Object.keys(fixtures.outputs).some(id => !definitions.has(id))) throw new Error("Fixture names must match exact declared node IDs");
  // Internal interpreter projection only, never a publication/runtime artifact.
  const plan: CompiledReadPlan = { sourceHash: projection.sourceHash, semanticHash: projection.simulationHash, ir: {
    schemaVersion: "workflow-read-ir/v2", compilerVersion: "read-compiler/v2", trigger: { kind: "manual" },
    ...(projection.inputSchema ? { inputSchema: projection.inputSchema } : {}), ...(projection.flow ? { flow: projection.flow } : {}),
    root: { kind: "sequence", nodes: projection.nodes.map(node => node.kind === "action" ? node : {
      id: node.id, kind: "action", inputs: { kind: "object", fields: {} },
      capability: { toolId: "fixture-model-only", action: "fixture-model-only", remoteName: "fixture-model-only", contractHash: "fixture-model-only" },
    }) },
  } };
  const fixtureHash = `sha256:${createHash("sha256").update(canonicalJSONBytes({ input, outputs: fixtures.outputs })).digest("hex")}`;
  const identity = { fixtureHash, sourceHash: projection.sourceHash, simulationHash: projection.simulationHash };
  let bytes = 0, failedNodeId: string | undefined, finalOutput: unknown, hasFinal = false;
  const append = (entry: ModelSimulationEntry) => {
    bytes += canonicalJSONBytes(entry).length;
    if (trace.length >= 400 || bytes > 1_000_000) throw new SimulationStop("SIMULATION_OUTPUT_LIMIT");
    trace.push(entry);
  };
  const fail = (entry: ModelSimulationEntry, code: string): never => { append({ ...entry, outcome: code }); throw new SimulationStop(code); };
  const state: Record<string, unknown> = { input: structuredClone(input) };
  try {
    if (projection.inputSchema && validateToolInput(projection.inputSchema, input).length) throw new SimulationStop("WORKFLOW_INPUT_INVALID");
    await interpretReadPlan(plan, state, {
      action: async (action, sourceIndex, visit) => {
        const node = definitions.get(action.id)!;
        failedNodeId = node.id;
        const entry: ModelSimulationEntry = { nodeId: node.id, kind: node.kind, sourceIndex, outcome: node.kind === "action" ? "SIMULATED" : "SUPPLIED_MODEL_OUTPUT" };
        let resolved: unknown;
        try { resolved = resolveReadBinding(node.kind === "action" ? node.inputs : node.input, state); }
        catch { return fail(entry, "BINDING_UNAVAILABLE_OR_LIMITED"); }
        let output: Record<string, unknown>;
        if (node.kind === "action") {
          const args = resolved as Record<string, unknown>, tool = tools.find(tool => tool.tool_id === node.capability.toolId)!;
          if (validateToolInput(tool.input_schema, args).length) return fail(entry, "ARGUMENTS_INVALID");
          entry.arguments = withoutSecretFields(args);
          if (validateSelected && !validateSelected(node.id, args, prior, visit)) return fail(entry, "SELECTED_PATH_RULE_BLOCKED");
          if (!Object.hasOwn(fixtures.outputs, node.id)) return fail(entry, "MISSING_FIXTURE");
          try { output = safeMcpToolResult(fixtures.outputs[node.id], tool); }
          catch { return fail(entry, "FIXTURE_OUTPUT_INVALID"); }
          used.add(node.id);
          if (output.isError === true) return fail({ ...entry, output }, "FIXTURE_TOOL_ERROR");
          prior.push({ nodeId: node.id, sourceIndex, args, visit });
        } else {
          try {
            if (modelInputItemCount(node.input, resolved) > node.maxInputItems || [...JSON.stringify(resolved)].length > node.maxInputChars)
              return fail(entry, "MODEL_INPUT_LIMIT_EXCEEDED");
          } catch (error) { if (error instanceof SimulationStop) throw error; return fail(entry, "MODEL_INPUT_LIMIT_EXCEEDED"); }
          entry.arguments = withoutSecretFields(resolved);
          if (!Object.hasOwn(fixtures.outputs, node.id)) return fail(entry, "MISSING_FIXTURE");
          const supplied = fixtures.outputs[node.id];
          if (!supplied || typeof supplied !== "object" || Array.isArray(supplied) || Object.keys(supplied).some(key => key !== "structuredContent") ||
              !Object.hasOwn(supplied, "structuredContent")) return fail(entry, "FIXTURE_OUTPUT_INVALID");
          const answer = (supplied as Record<string, unknown>).structuredContent;
          if (validateToolInput(node.outputSchema, answer).length) return fail(entry, "FIXTURE_OUTPUT_INVALID");
          output = withoutSecretFields({ structuredContent: answer }) as Record<string, unknown>;
          if (validateToolInput(node.outputSchema, output.structuredContent).length) return fail(entry, "FIXTURE_OUTPUT_INVALID");
          used.add(node.id);
          if (node.kind === "agent") {
            let complete: unknown;
            try { complete = resolveReadBinding({ kind: "ref", source: "nodeOutput", nodeId: "fixture", path: node.completionPredicate.path }, { fixture: output.structuredContent }); }
            catch { return fail(entry, "FIXTURE_AGENT_INCOMPLETE"); }
            if (complete !== node.completionPredicate.equals) return fail(entry, "FIXTURE_AGENT_INCOMPLETE");
          }
        }
        append({ ...entry, output }); stepOutputs[node.id] = output; finalOutput = output; hasFinal = true;
        return output;
      },
      condition: async (sourceIndex, id, predicate) => {
        failedNodeId = id;
        const entry: ModelSimulationEntry = { nodeId: id, kind: "condition", sourceIndex, outcome: "SIMULATED_DECISION" };
        if (predicate === undefined) return fail(entry, "PREDICATE_INVALID");
        append({ ...entry, selectedBranch: predicate ? "then" : "else" });
      },
      skipped: async (sourceIndex, id, reason) => { failedNodeId = id; append({ nodeId: id, kind: definitions.get(id)!.kind, sourceIndex, outcome: reason.kind === "return" ? "AFTER_RETURN" : "NOT_SELECTED",
        ...(reason.kind === "branch" ? { conditionId: reason.conditionId, selectedBranch: reason.selected } : reason.kind === "return" ? { returnId: reason.returnId } : {}) }); },
      value: async (sourceIndex, id, kind, value, valid) => {
        failedNodeId = id;
        const definition = values.get(id), entry: ModelSimulationEntry = { nodeId: id, kind: kind === "merge" ? "merge" : "return", sourceIndex, outcome: kind === "merge" ? "SIMULATED_MERGE" : "SIMULATED_RETURN" };
        if (!valid || !definition || definition.kind !== kind) return fail(entry, "VALUE_INVALID");
        const safe = withoutSecretFields({ value }) as { value: unknown };
        if (!Object.hasOwn(safe, "value") || validateToolInput(definition.schema, safe.value).length) return fail(entry, "VALUE_INVALID");
        append({ ...entry, output: safe }); valueOutputs[id] = safe;
        if (kind === "return") { finalOutput = safe.value; hasFinal = true; }
        return safe;
      },
    });
    return { outcome: "SIMULATED_COMPLETE", trace, stepOutputs, valueOutputs, ...(hasFinal ? { finalOutput } : {}),
      usedFixtureIds: [...used], unusedFixtureIds: Object.keys(fixtures.outputs).filter(id => !used.has(id)), ...identity };
  } catch (error) {
    return { outcome: "SIMULATED_STOPPED", reason: error instanceof SimulationStop ? error.code : "SIMULATION_EVALUATION_FAILED", ...(failedNodeId ? { failedNodeId } : {}),
      trace, stepOutputs, valueOutputs, ...(hasFinal ? { finalOutput } : {}), usedFixtureIds: [...used], unusedFixtureIds: Object.keys(fixtures.outputs).filter(id => !used.has(id)), ...identity };
  }
}
