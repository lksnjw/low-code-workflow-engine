import { createHash } from "node:crypto";
import { z } from "zod";
import type { ToolDefinition } from "../registry/schemas.js";
import { compileReadWorkflow, resolveReadBinding, type CompiledReadPlan } from "./compiled-read.js";
import { interpretReadPlan, ReadCollectionFailure, type ReadVisit } from "./read-interpreter.js";
import { safeMcpToolResult } from "../tools/mcp-result.js";
import { validateToolInput } from "../tools/tool-input-schema.js";
import { withoutSecretFields } from "../redact/secrets.js";
import { canonicalJSONBytes } from "../core/canonical-json.js";
import { structuralNodes, loopNodes } from "./read-control-flow.js";
import { ReadCompletionEvidence, ReadEvidenceLimit, type CompletedRead } from "./read-completion-evidence.js";

const safeID = (value: string) => /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value) && !["input", "__proto__", "constructor", "prototype"].includes(value);
const safeInvocation = (value: string) => {
  const parts = value.split("/");
  return parts.length <= 17 && parts.length % 2 === 1 && parts.every((part, index) => index % 2 === 0 ? safeID(part) : /^(0|[1-9][0-9]?)$/.test(part));
};
const identity = { baseVersion: z.number().int().min(1), baseHash: z.string().regex(/^sha256:[a-f0-9]{64}$/) };
const fixtureSchema = z.discriminatedUnion("profile", [
  z.object({ profile: z.literal("read-fixtures/v1"), ...identity, outputs: z.record(z.string().refine(safeID), z.unknown()) }).strict(),
  z.object({ profile: z.literal("read-fixtures/v2"), ...identity, outputs: z.record(z.string().refine(safeInvocation), z.unknown()) }).strict(),
]);
export function boundFixtureData(raw: unknown): void {
  let count = 0;
  const bound = (value: unknown, depth: number): void => {
    if (++count > 32768 || depth > 32) throw new Error("Fixture input exceeds structural limits");
    if (value !== null && typeof value === "object") for (const child of Object.values(value)) bound(child, depth + 1);
    else if (value !== null && !["string", "boolean", "number"].includes(typeof value) || typeof value === "number" && !Number.isFinite(value)) throw new Error("Fixture input must be finite JSON");
  };
  bound(raw, 0);
  if (canonicalJSONBytes(raw).length > 512_000) throw new Error("Fixture input exceeds byte limits");
}
export function parseReadFixtures(raw: unknown) {
  boundFixtureData(raw);
  const parsed = fixtureSchema.parse(raw);
  if (Object.keys(parsed.outputs).length > (parsed.profile === "read-fixtures/v2" ? 1000 : 200)) throw new Error("Too many fixture outputs");
  return parsed;
}
export type ReadFixtures = ReturnType<typeof parseReadFixtures>;
export type SimulationEntry = { nodeId: string; kind: "action" | "condition" | "merge" | "return" | "collection-item" | "collection"; outcome: string; sourceIndex: number; arguments?: unknown; output?: unknown; selectedBranch?: "then" | "else"; conditionId?: string; returnId?: string; reason?: string; invocationId?: string; iterations?: ReadVisit["iterations"]; count?: number; loopId?: string };
class SimulationStop extends Error { constructor(readonly code: string) { super(code); } }

/** No live services are accepted. Fixture outputs are supplied test data,
 * never ERP evidence, capability grants or persisted execution checkpoints. */
export async function simulateReadWorkflow(yaml: string, input: Record<string, unknown>, fixtures: ReadFixtures, tools: readonly ToolDefinition[], role: string,
  validateSelected?: (nodeId: string, args: Record<string, unknown>, prior: readonly CompletedRead[], visit: ReadVisit) => boolean) {
  const trace: SimulationEntry[] = [], stepOutputs: Record<string, unknown> = {}, valueOutputs: Record<string, { value: unknown }> = {}, used = new Set<string>();
  boundFixtureData({ input, outputs: fixtures.outputs });
  let plan: CompiledReadPlan;
  try { plan = compileReadWorkflow(yaml, tools, role); }
  catch { return { outcome: "PLAN_BLOCKED", issues: ["Workflow does not meet the supported compiled read profile"], trace, stepOutputs, valueOutputs, usedFixtureIds: [], unusedFixtureIds: Object.keys(fixtures.outputs) }; }
  const loops = plan.ir.flow ? loopNodes(plan.ir.flow) : [];
  const completed = new ReadCompletionEvidence(plan);
  if (loops.length && fixtures.profile !== "read-fixtures/v2") throw new Error("Collection fixtures require explicit per-iteration read-fixtures/v2 identities");
  const owners = new Map<string, string[]>();
  const visitOwners = (block: NonNullable<typeof plan.ir.flow>, outer: string[]) => { for (const node of block.nodes) {
    if (node.kind === "action") owners.set(node.nodeId, outer);
    else if (node.kind === "foreach") visitOwners(node.body, [...outer, node.id]);
    else if (node.kind === "if") { visitOwners(node.then, outer); visitOwners(node.else, outer); }
  } };
  if (plan.ir.flow) visitOwners(plan.ir.flow, []); else plan.ir.root.nodes.forEach(node => owners.set(node.id, []));
  if (Object.keys(fixtures.outputs).some(id => {
    const parts = id.split("/"), owner = owners.get(parts.at(-1)!);
    return !owner || parts.length !== owner.length * 2 + 1 || owner.some((loopId, index) => parts[index * 2] !== loopId || Number(parts[index * 2 + 1]) >= loops.find(loop => loop.id === loopId)!.maxItems);
  })) throw new Error("Fixture names must match declared action IDs and exact iteration scope");
  const valueSchemas = new Map(plan.ir.flow ? structuralNodes(plan.ir.flow).map(node => [node.id, node.kind === "return" ? node.output.schema : node.kind === "foreach" ? node.collect.schema : node.kind === "if" ? node.merge?.schema : undefined] as const) : []);
  const location = (visit: ReadVisit) => fixtures.profile === "read-fixtures/v2" ? { invocationId: visit.invocationId, iterations: visit.iterations } : {};
  const key = (visit: ReadVisit, id: string) => fixtures.profile === "read-fixtures/v2" ? visit.invocationId : id;
  const fixtureHash = `sha256:${createHash("sha256").update(canonicalJSONBytes({ input, fixtures: fixtures.outputs })).digest("hex")}`;
  let bytes = 0, failedNodeId: string | undefined, finalOutput: unknown, hasFinal = false;
  const append = (entry: SimulationEntry) => {
    bytes += canonicalJSONBytes(entry).length;
    if (trace.length >= (fixtures.profile === "read-fixtures/v2" ? 5000 : 400) || bytes > 1_000_000) throw new SimulationStop("SIMULATION_OUTPUT_LIMIT");
    trace.push(entry);
  };
  const fail = (entry: SimulationEntry, code: string): never => { append({ ...entry, outcome: code }); throw new SimulationStop(code); };
  const state: Record<string, unknown> = { input: structuredClone(input) };
  try {
    if (plan.ir.inputSchema && validateToolInput(plan.ir.inputSchema, input).length) throw new SimulationStop("WORKFLOW_INPUT_INVALID");
    await interpretReadPlan(plan, state, {
      action: async (node, sourceIndex, visit) => {
        failedNodeId = node.id;
        const entry: SimulationEntry = { nodeId: node.id, kind: "action", sourceIndex, outcome: "SIMULATED", ...location(visit) };
        let args: Record<string, unknown>;
        try { args = resolveReadBinding(node.inputs, state) as Record<string, unknown>; } catch { return fail(entry, "BINDING_UNAVAILABLE_OR_LIMITED"); }
        const tool = tools.find(tool => tool.tool_id === node.capability.toolId)!;
        if (validateToolInput(tool.input_schema, args).length) return fail(entry, "ARGUMENTS_INVALID");
        entry.arguments = withoutSecretFields(args);
        const prior = completed.prior(node.id, visit);
        if (validateSelected && !validateSelected(node.id, args, prior, visit)) return fail(entry, "SELECTED_PATH_RULE_BLOCKED");
        const fixtureID = key(visit, node.id);
        if (!Object.hasOwn(fixtures.outputs, fixtureID)) return fail(entry, "MISSING_FIXTURE");
        let output: Record<string, unknown>;
        try { output = safeMcpToolResult(fixtures.outputs[fixtureID], tool); } catch { return fail(entry, "FIXTURE_OUTPUT_INVALID"); }
        used.add(fixtureID);
        if (output.isError === true) return fail({ ...entry, output }, "FIXTURE_TOOL_ERROR");
        completed.actionCompleted(node.id, args, visit);
        append({ ...entry, output }); stepOutputs[fixtureID] = output; finalOutput = output; hasFinal = true;
        return output;
      },
      condition: async (sourceIndex, id, predicate, visit) => {
        failedNodeId = id;
        const entry: SimulationEntry = { nodeId: id, kind: "condition", sourceIndex, outcome: "SIMULATED_DECISION", ...location(visit) };
        if (predicate === undefined) return fail(entry, "PREDICATE_INVALID");
        append({ ...entry, selectedBranch: predicate ? "then" : "else" });
      },
      skipped: async (sourceIndex, id, reason, visit) => { failedNodeId = id; append({ nodeId: id, kind: "action", sourceIndex, outcome: reason.kind === "return" ? "AFTER_RETURN" : reason.kind === "empty-collection" ? "EMPTY_COLLECTION" : "NOT_SELECTED", ...location(visit), ...(reason.kind === "return" ? { returnId: reason.returnId } : reason.kind === "empty-collection" ? { loopId: reason.loopId } : { conditionId: reason.conditionId, selectedBranch: reason.selected }) }); },
      collectionStarted: async (sourceIndex, id, count, valid, visit) => {
        failedNodeId = id;
        const entry: SimulationEntry = { nodeId: id, kind: "collection", sourceIndex, outcome: "SIMULATED_COLLECTION_STARTED", ...location(visit), ...(count === undefined ? {} : { count }) };
        if (!valid) return fail(entry, count !== undefined && count > loops.find(loop => loop.id === id)!.maxItems ? "COLLECTION_LIMIT_EXCEEDED" : "COLLECTION_INPUT_INVALID");
        completed.collectionStarted(id, count!, visit);
        append(entry);
      },
      value: async (sourceIndex, id, kind, value, valid, visit) => {
        failedNodeId = id;
        const entry: SimulationEntry = { nodeId: id, kind, sourceIndex, outcome: "SIMULATED_VALUE", ...location(visit) };
        if (!valid) return fail(entry, "VALUE_INVALID");
        const safe = withoutSecretFields({ value }) as { value: unknown };
        const schema = kind === "collection" ? { type: "array", items: valueSchemas.get(id) } : valueSchemas.get(id);
        if (!schema || validateToolInput(schema, safe.value).length) return fail(entry, "VALUE_INVALID");
        if (kind === "collection-item") completed.itemCompleted(id, visit);
        if (kind === "collection") completed.collectionCompleted(id, visit);
        append({ ...entry, output: safe.value }); valueOutputs[key(visit, id)] = safe;
        if (kind === "return") { finalOutput = safe.value; hasFinal = true; }
        return safe;
      },
    });
    return { outcome: "SIMULATED_COMPLETE", trace, stepOutputs, valueOutputs, ...(hasFinal ? { finalOutput } : {}), usedFixtureIds: [...used], unusedFixtureIds: Object.keys(fixtures.outputs).filter(id => !used.has(id)), fixtureHash, sourceHash: plan.sourceHash, semanticHash: plan.semanticHash };
  } catch (error) {
    return { outcome: "SIMULATED_STOPPED", reason: error instanceof SimulationStop || error instanceof ReadCollectionFailure ? error.code : error instanceof ReadEvidenceLimit ? "SIMULATION_EVIDENCE_LIMIT" : "SIMULATION_EVALUATION_FAILED", ...(failedNodeId ? { failedNodeId } : {}), trace, stepOutputs, valueOutputs, ...(hasFinal ? { finalOutput } : {}), usedFixtureIds: [...used], unusedFixtureIds: Object.keys(fixtures.outputs).filter(id => !used.has(id)), fixtureHash, sourceHash: plan.sourceHash, semanticHash: plan.semanticHash };
  }
}
