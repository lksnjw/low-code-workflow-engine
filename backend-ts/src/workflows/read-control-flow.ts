import { z } from "zod";
import type { ReadBinding, ReadReference, ReadIR } from "./compiled-read.js";
import { mergeSchema, returnSchema, protectedOutputSchema, type ReadMerge, type ReadReturn, type ReadProtectedOutput } from "./read-values.js";
import { checkBinding, schemaAt } from "./read-binding-validation.js";

export type ReadSequence = { kind: "sequence"; nodes: ReadControlNode[] };
export type ReadControlNode = { kind: "action"; nodeId: string } | { kind: "if"; id: string; predicate: ReadReference | { kind: "literal"; value: boolean }; then: ReadSequence; else: ReadSequence; merge?: ReadMerge | undefined } | { kind: "return"; id: string; output: ReadReturn } | { kind: "foreach"; id: string; items: ReadReturn; maxItems: number; body: ReadSequence; collect: ReadReturn } |
  { kind: "protect"; id: string; body: ReadSequence; handler: ReadSequence; onError: { code: "ERP_RESOURCE_NOT_FOUND" }; output: ReadProtectedOutput };
export type ReadControlFlow = { schemaVersion: "read-control-flow/v1" | "read-control-flow/v2" | "read-control-flow/v3" | "read-control-flow/v4"; root: ReadSequence };
const identifier = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/).refine(value => !["input", "__proto__", "constructor", "prototype"].includes(value));
const path = z.array(z.string().regex(/^[A-Za-z0-9_-]+$/).refine(value => !["__proto__", "constructor", "prototype"].includes(value))).max(16);
export const readPredicateSchema = z.union([
  z.object({ kind: z.literal("literal"), value: z.boolean() }).strict(),
  z.object({ kind: z.literal("ref"), source: z.literal("workflowInput"), path }).strict(),
  z.object({ kind: z.literal("ref"), source: z.literal("nodeOutput"), nodeId: identifier, path }).strict(),
]);
const sequence: z.ZodType<ReadSequence> = z.lazy(() => z.object({ kind: z.literal("sequence"), nodes: z.array(z.union([
  z.object({ kind: z.literal("action"), nodeId: identifier }).strict(),
  z.object({ kind: z.literal("if"), id: identifier, predicate: readPredicateSchema, then: sequence, else: sequence, merge: mergeSchema.optional() }).strict(),
  z.object({ kind: z.literal("return"), id: identifier, output: returnSchema }).strict(),
  z.object({ kind: z.literal("foreach"), id: identifier, items: returnSchema.refine(value => value.schema.type === "array", "Collection requires an array schema"), maxItems: z.number().int().min(1).max(100), body: sequence, collect: returnSchema }).strict(),
  z.object({ kind: z.literal("protect"), id: identifier, body: sequence.refine(value => value.nodes.length > 0, "Protected body cannot be empty"), handler: sequence,
    onError: z.object({ code: z.literal("ERP_RESOURCE_NOT_FOUND") }).strict(), output: protectedOutputSchema }).strict(),
])).max(200) }).strict());
const flow = z.object({ schemaVersion: z.enum(["read-control-flow/v1", "read-control-flow/v2", "read-control-flow/v3", "read-control-flow/v4"]), root: sequence }).strict();

/** Bound unknown input BEFORE recursive schema parsing. A control-flow record
 * is explicit execution meaning, never inferred from visual edges/layout. */
export function parseReadControlFlow(raw: unknown): ReadControlFlow {
  let nodes = 0;
  const bound = (value: unknown, depth: number) => {
    if (++nodes > 8192 || depth > 40) throw new Error("Control flow exceeds structural limits");
    if (value && typeof value === "object") for (const child of Object.values(value)) bound(child, depth + 1);
  };
  bound(raw, 0);
  const parsed = flow.parse(raw);
  if (!["read-control-flow/v3", "read-control-flow/v4"].includes(parsed.schemaVersion) && loopNodes(parsed.root).length) throw new Error("Collection loops require read-control-flow/v3");
  if (parsed.schemaVersion !== "read-control-flow/v4" && protectedNodes(parsed.root).length) throw new Error("Protected scopes require read-control-flow/v4");
  if (parsed.schemaVersion === "read-control-flow/v1" && valueNodes(parsed.root).length) throw new Error("Typed values require read-control-flow/v2");
  return parsed;
}
export const readControlFlowSchema = z.unknown().transform((raw, ctx) => {
  try { return parseReadControlFlow(raw); }
  catch { ctx.addIssue({ code: "custom", message: "Invalid or oversized structured read control flow" }); return z.NEVER; }
});

export function actionOrder(root: ReadSequence): string[] {
  return root.nodes.flatMap(node => node.kind === "action" ? [node.nodeId] : childSequences(node).flatMap(actionOrder));
}
export function childSequences(node: ReadControlNode): ReadSequence[] {
  return node.kind === "if" ? [node.then, node.else] : node.kind === "foreach" ? [node.body] : node.kind === "protect" ? [node.body, node.handler] : [];
}
export function controlNodes(root: ReadSequence): Array<Extract<ReadControlNode, { kind: "if" }>> {
  return root.nodes.flatMap(node => [...(node.kind === "if" ? [node] : []), ...childSequences(node).flatMap(controlNodes)]);
}
export function structuralNodes(root: ReadSequence): Array<Exclude<ReadControlNode, { kind: "action" }>> {
  return root.nodes.flatMap(node => node.kind === "action" ? [] : [node, ...childSequences(node).flatMap(structuralNodes)]);
}
export function protectedNodes(root: ReadSequence): Array<Extract<ReadControlNode, { kind: "protect" }>> {
  return structuralNodes(root).filter((node): node is Extract<ReadControlNode, { kind: "protect" }> => node.kind === "protect");
}
/** Fixed redacted handler-local fault, never successful ERP output or prose. */
export const protectedFaultSchema: Record<string, unknown> = { type: "object", properties: { error: { type: "object", properties: {
  code: { type: "string" }, failedNodeId: { type: "string" },
}, required: ["code", "failedNodeId"], additionalProperties: false } }, required: ["error"], additionalProperties: false };
export function handlerScopeIDs(root: ReadSequence): Map<string, string[]> {
  const result = new Map<string, string[]>();
  const visit = (block: ReadSequence, active: string[]) => { for (const node of block.nodes) {
    result.set(node.kind === "action" ? node.nodeId : node.id, [...active]);
    if (node.kind === "protect") { visit(node.body, active); visit(node.handler, [...active, node.id]); }
    else for (const child of childSequences(node)) visit(child, active);
  } };
  visit(root, []); return result;
}
/** Per-node lexical overrides only; final outputs stay in the declaration map.
 * Handler fault and current collection item are not global node answers. */
export function lexicalSchemaOverrides(root: ReadSequence): Map<string, Map<string, Record<string, unknown>>> {
  const result = new Map<string, Map<string, Record<string, unknown>>>();
  const visit = (block: ReadSequence, active: Map<string, Record<string, unknown>>) => { for (const node of block.nodes) {
    result.set(node.kind === "action" ? node.nodeId : node.id, new Map(active));
    if (node.kind === "protect") {
      visit(node.body, active); visit(node.handler, new Map([...active, [node.id, protectedFaultSchema]]));
    } else if (node.kind === "foreach") {
      const item = { type: "object", properties: { item: node.items.schema.items, index: { type: "integer" } }, required: ["item", "index"], additionalProperties: false };
      visit(node.body, new Map([...active, [node.id, item]]));
    } else for (const child of childSequences(node)) visit(child, active);
  } };
  visit(root, new Map()); return result;
}
export function assertNoProtectedScopes(root: ReadSequence): void {
  if (protectedNodes(root).length) throw new Error("Protected scopes require their separately qualified durable handler profile");
}
export function loopNodes(root: ReadSequence) { return structuralNodes(root).filter((node): node is Extract<ReadControlNode, { kind: "foreach" }> => node.kind === "foreach"); }
export function valueNodes(root: ReadSequence) { return structuralNodes(root).filter(node => node.kind === "return" || node.kind === "if" && node.merge); }
export function assertNoLiveReadLoops(root: ReadSequence): void { if (loopNodes(root).length) throw new Error("Durable per-iteration collection checkpoints are required before live loop execution"); }
export function skippedActions(root: ReadSequence, conditionId: string, selected: "then" | "else"): string[] {
  const node = controlNodes(root).find(value => value.id === conditionId);
  if (!node) throw new Error("Unknown condition");
  return actionOrder(selected === "then" ? node.else : node.then);
}
export function assertSelectedReadNode(root: ReadSequence, nodeId: string, decisions: Record<string, { status: string; selected?: "then" | "else" }>) {
  assertNoProtectedScopes(root);
  assertNoLiveReadLoops(root);
  let found = false;
  const visit = (block: ReadSequence, pathSelected: boolean) => {
    for (const node of block.nodes) {
      if ((node.kind === "action" ? node.nodeId : node.id) === nodeId) {
        found = true; if (!pathSelected) throw new Error("Node is not on a confirmed selected branch");
      }
      if (node.kind === "if") {
        const decision = decisions[node.id];
        visit(node.then, pathSelected && decision?.status === "DONE" && decision.selected === "then");
        visit(node.else, pathSelected && decision?.status === "DONE" && decision.selected === "else");
      }
    }
  };
  visit(root, true);
  if (!found) throw new Error("Node is not in the compiled flow");
}
function references(binding: ReadBinding): ReadReference[] {
  return binding.kind === "ref" ? [binding] : binding.kind === "object" ? Object.values(binding.fields).flatMap(references) : binding.kind === "array" ? binding.items.flatMap(references) : binding.kind === "template" ? binding.parts.filter((part): part is ReadReference => typeof part !== "string") : [];
}

/** Every action has one structural owner. Branch-local outputs cannot escape
 * to siblings/parent scope; an explicit merge primitive is still required. */
export function validateReadControlFlow(root: ReadSequence, ir: ReadIR, outputSchemas: ReadonlyMap<string, Record<string, unknown>>, inputSchemas: ReadonlyMap<string, Record<string, unknown>> = new Map()) {
  const issues: string[] = [], scopes = new Map<string, Set<string>>(), branchScopes = new Map<string, { then: Set<string>; else: Set<string> }>(), collectionScopes = new Map<string, { items: Set<string>; collect: Set<string> }>(), seen = new Set(ir.root.nodes.map(node => node.id));
  const protectedScopes = new Map<string, { success: Set<string>; handled: Set<string> }>();
  const definitions = new Map(ir.root.nodes.map(node => [node.id, node]));
  const order = actionOrder(root);
  if (order.length !== ir.root.nodes.length || order.some((id, index) => id !== ir.root.nodes[index]?.id) || new Set(order).size !== order.length)
    issues.push("Control flow must own every declared action exactly once in source declaration order");
  let controlCount = 0;
  const loops = new Set(loopNodes(root).map(node => node.id));
  const protectedIDs = new Set(protectedNodes(root).map(node => node.id));
  let currentSchemas: ReadonlyMap<string, Record<string, unknown>> = outputSchemas;
  const checkReference = (ref: ReadReference, available: Set<string>, label: string) => {
    if (ref.source === "nodeOutput" && !available.has(ref.nodeId!)) issues.push(`${label} references unavailable branch-local or forward data`);
    const schema = ref.source === "workflowInput" ? ir.inputSchema : currentSchemas.get(ref.nodeId!);
    if (schema?.additionalProperties === false && ref.path.length && !Object.hasOwn((schema.properties ?? {}) as object, ref.path[0]!))
      issues.push(`${label} references an undeclared output path`);
    if (ref.source === "nodeOutput" && loops.has(ref.nodeId!) && available.has(ref.nodeId!) && !schemaAt(currentSchemas.get(ref.nodeId!), ref.path)) issues.push(`${label} references a loop item or collection outside its declared scope`);
    if (protectedIDs.size && !schemaAt(ref.source === "workflowInput" ? ir.inputSchema : currentSchemas.get(ref.nodeId!), ref.path)) issues.push(`${label} must select declared data in its protected lexical scope`);
  };
  const visit = (block: ReadSequence, outer: Set<string>, depth: number, localSchemas: ReadonlyMap<string, Record<string, unknown>> = outputSchemas, inLoop = false): Set<string> => {
    if (depth > 8) { issues.push("Control flow exceeds eight nested scopes"); return new Set(outer); }
    const available = new Set(outer);
    for (const node of block.nodes) {
      currentSchemas = localSchemas;
      if (node.kind === "action") {
        const action = definitions.get(node.nodeId);
        if (!action) { issues.push("Control flow references an unknown action"); continue; }
        scopes.set(node.nodeId, new Set(available));
        for (const ref of references(action.inputs)) checkReference(ref, available, `Step ${node.nodeId}`);
        if (loops.size || protectedIDs.size) checkBinding(action.inputs, inputSchemas.get(node.nodeId), `Step ${node.nodeId}`, issues, ref => schemaAt(ref.source === "workflowInput" ? ir.inputSchema : localSchemas.get(ref.nodeId!), ref.path));
        available.add(node.nodeId);
      } else {
        scopes.set(node.id, new Set(available));
        if (++controlCount > 100 || seen.has(node.id)) issues.push("Structural nodes require unique IDs and at most 100 nodes");
        seen.add(node.id);
        if (node.kind === "return") {
          if (inLoop) issues.push("Collection bodies cannot contain workflow returns; return the collected value after the loop");
          for (const ref of references(node.output.value)) checkReference(ref, available, `Return ${node.id}`);
          checkBinding(node.output.value, node.output.schema, `Return ${node.id}`, issues, ref => schemaAt(ref.source === "workflowInput" ? ir.inputSchema : localSchemas.get(ref.nodeId!), ref.path));
          // Following declarations are still verified; runtime completion must
          // prove they were explicitly skipped after the committed return.
          continue;
        }
        if (node.kind === "foreach") {
          for (const ref of references(node.items.value)) checkReference(ref, available, `Collection ${node.id}`);
          checkBinding(node.items.value, node.items.schema, `Collection ${node.id}`, issues, ref => schemaAt(ref.source === "workflowInput" ? ir.inputSchema : localSchemas.get(ref.nodeId!), ref.path));
          const bodySchemas = new Map(localSchemas);
          bodySchemas.set(node.id, { type: "object", properties: { item: node.items.schema.items, index: { type: "integer" } }, required: ["item", "index"], additionalProperties: false });
          const bodyAvailable = visit(node.body, new Set([...available, node.id]), depth + 1, bodySchemas, true);
          collectionScopes.set(node.id, { items: new Set(available), collect: new Set(bodyAvailable) });
          currentSchemas = bodySchemas;
          for (const ref of references(node.collect.value)) checkReference(ref, bodyAvailable, `Collection result ${node.id}`);
          checkBinding(node.collect.value, node.collect.schema, `Collection result ${node.id}`, issues, ref => schemaAt(ref.source === "workflowInput" ? ir.inputSchema : bodySchemas.get(ref.nodeId!), ref.path));
          available.add(node.id); continue;
        }
        if (node.kind === "protect") {
          const success = visit(node.body, available, depth + 1, localSchemas, inLoop);
          const handlerSchemas = new Map(localSchemas); handlerSchemas.set(node.id, protectedFaultSchema);
          const handled = visit(node.handler, new Set([...available, node.id]), depth + 1, handlerSchemas, inLoop);
          protectedScopes.set(node.id, { success, handled });
          for (const [path, pathAvailable, schemas] of [["success", success, localSchemas], ["handled", handled, handlerSchemas]] as const) {
            currentSchemas = schemas;
            for (const ref of references(node.output[path])) checkReference(ref, pathAvailable, `Protected output ${node.id} ${path}`);
            checkBinding(node.output[path], node.output.schema, `Protected output ${node.id} ${path}`, issues, ref => schemaAt(ref.source === "workflowInput" ? ir.inputSchema : schemas.get(ref.nodeId!), ref.path));
          }
          available.add(node.id); continue;
        }
        if (node.predicate.kind === "ref") {
          checkReference(node.predicate, available, `Condition ${node.id}`);
          let schema = node.predicate.source === "workflowInput" ? ir.inputSchema : localSchemas.get(node.predicate.nodeId!);
          for (const part of node.predicate.path) schema = schema?.type === "array" && /^(0|[1-9][0-9]*)$/.test(part) ? schema.items as Record<string, unknown> : (schema?.properties as Record<string, Record<string, unknown>>)?.[part];
          if (schema && schema.type !== "boolean") issues.push(`Condition ${node.id} requires a boolean predicate, not implicit conversion`);
        }
        const thenAvailable = visit(node.then, available, depth + 1, localSchemas, inLoop), elseAvailable = visit(node.else, available, depth + 1, localSchemas, inLoop);
        branchScopes.set(node.id, { then: thenAvailable, else: elseAvailable });
        currentSchemas = localSchemas;
        if (node.merge) {
          for (const [branch, branchAvailable] of [["then", thenAvailable], ["else", elseAvailable]] as const) {
            for (const ref of references(node.merge[branch])) checkReference(ref, branchAvailable ?? new Set(), `Merge ${node.id} ${branch}`);
            checkBinding(node.merge[branch], node.merge.schema, `Merge ${node.id} ${branch}`, issues, ref => schemaAt(ref.source === "workflowInput" ? ir.inputSchema : localSchemas.get(ref.nodeId!), ref.path));
          }
          available.add(node.id);
        }
      }
    }
    return available;
  };
  visit(root, new Set(), 0);
  const cost = (block: ReadSequence): number => block.nodes.reduce((total, node) => total + (node.kind === "foreach" ? 1 + node.maxItems * (1 + cost(node.body)) : 1 + childSequences(node).reduce((sum, child) => sum + cost(child), 0)), 0);
  if (cost(root) > 2000) issues.push("Collection expansion exceeds the 2000-visit declared execution budget");
  return { issues: [...new Set(issues)], scopes, branchScopes, collectionScopes, protectedScopes };
}

export type ReadValueReceipt = { kind: "merge" | "return" | "protect"; status: "DONE" | "FAILED"; stepIndex: number; completedAt: string };
export type ReadSkipReason = { kind: "branch"; conditionId: string; selected: "then" | "else" } | { kind: "return"; returnId: string } | { kind: "empty-collection"; loopId: string };
/** A value boundary may not jump over an earlier decision, merge, return or
 * action. This is a denial-only check over committed evidence, not execution. */
export function assertReadValueBoundary(root: ReadSequence, nodeId: string, kind: "merge" | "return", decisions: Record<string, { status: string; selected?: "then" | "else" }>, attempts: Record<string, { status: string }>, values: Record<string, { kind: string; status: string }>) {
  assertNoProtectedScopes(root);
  assertNoLiveReadLoops(root);
  let found = false;
  const requireValue = (id: string, expected: string) => { if (values[id]?.kind !== expected || values[id]?.status !== "DONE") throw new Error("Earlier typed value is not confirmed"); };
  const visit = (block: ReadSequence): void => {
    for (const node of block.nodes) {
      if (found) return;
      if (node.kind === "action") { if (attempts[node.nodeId]?.status !== "DONE") throw new Error("Earlier selected read is not confirmed"); }
      else if (node.kind === "return") {
        if (node.id === nodeId && kind === "return") { found = true; return; }
        throw new Error("Value boundary follows an earlier return");
      } else {
        if (node.kind !== "if") throw new Error("Value boundary requires its separately qualified checkpoints");
        const decision = decisions[node.id];
        if (decision?.status !== "DONE" || !["then", "else"].includes(decision.selected ?? "")) throw new Error("Earlier condition is not confirmed");
        visit(node[decision.selected!]); if (found) return;
        if (actionOrder(node[decision.selected === "then" ? "else" : "then"]).some(id => attempts[id]?.status !== "SKIPPED")) throw new Error("Unselected branch is not checkpointed");
        if (node.merge) {
          if (node.id === nodeId && kind === "merge") { found = true; return; }
          requireValue(node.id, "merge");
        }
      }
    }
  };
  visit(root); if (!found) throw new Error("Value boundary is not on the confirmed path");
}
export function readFlowOutcomes(root: ReadSequence, decisions: Record<string, { status: string; selected?: "then" | "else" }>, values: Record<string, { kind: string; status: string }> = {}) {
  assertNoProtectedScopes(root);
  assertNoLiveReadLoops(root);
  const visited = new Set<string>(), selected = new Set<string>(), valueIDs = new Set<string>(), skipped = new Map<string, ReadSkipReason>();
  const skip = (block: ReadSequence, reason: ReadSkipReason) => { for (const id of actionOrder(block)) skipped.set(id, reason); };
  const value = (id: string, kind: string) => {
    if (values[id]?.kind !== kind || values[id]?.status !== "DONE") throw new Error("Typed value lacks a confirmed checkpoint");
    valueIDs.add(id);
  };
  const visit = (block: ReadSequence, returned?: string): string | undefined => {
    for (const node of block.nodes) {
      if (returned) { skip({ kind: "sequence", nodes: [node] }, { kind: "return", returnId: returned }); continue; }
      if (node.kind === "action") selected.add(node.nodeId);
      else if (node.kind === "return") { value(node.id, "return"); returned = node.id; }
      else {
        if (node.kind !== "if") throw new Error("Completion requires its separately qualified checkpoints");
        const receipt = decisions[node.id];
        if (!receipt || receipt.status !== "DONE" || !["then", "else"].includes(receipt.selected ?? "")) throw new Error("Condition lacks a confirmed decision");
        visited.add(node.id);
        returned = visit(node[receipt.selected!]);
        skip(node[receipt.selected === "then" ? "else" : "then"], { kind: "branch", conditionId: node.id, selected: receipt.selected! });
        if (!returned && node.merge) value(node.id, "merge");
      }
    }
    return returned;
  };
  const returned = visit(root);
  return { visited, selected, valueIDs, skipped, returned };
}
export function assertReadFlowCompletion(root: ReadSequence, decisions: Record<string, { status: string; selected?: "then" | "else" }>, attempts: Record<string, { status: string }>, values: Record<string, { kind: string; status: string }> = {}) {
  const { visited, selected, valueIDs } = readFlowOutcomes(root, decisions, values);
  const declared = actionOrder(root);
  if (Object.keys(decisions).some(id => !visited.has(id)) || Object.keys(values).some(id => !valueIDs.has(id)) || Object.keys(attempts).some(id => !declared.includes(id)) || declared.some(id => attempts[id]?.status !== (selected.has(id) ? "DONE" : "SKIPPED")))
    throw new Error("Confirmed node outcomes do not match the selected control path");
}
export function controlPoint(root: ReadSequence, nodeId: string, afterBranches = false): number {
  let cursor = 0, result: number | undefined;
  const visit = (block: ReadSequence) => {
    for (const node of block.nodes) {
      const id = node.kind === "action" ? node.nodeId : node.id;
      if (id === nodeId && !afterBranches) result = cursor;
      if (node.kind === "action") cursor++;
      else for (const child of childSequences(node)) visit(child);
      if (id === nodeId && afterBranches) result = cursor;
    }
  };
  visit(root); if (result === undefined) throw new Error("Unknown structural checkpoint"); return result;
}
