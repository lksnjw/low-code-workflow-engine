import { expect, test } from "@jest/globals";
import { dump } from "js-yaml";
import { readCanvasBlueprint, serializeSourceOrderCanvas, sameWorkflowSource, sourceOrderCanvasValidationPayload } from "./builderSerialization";

const blueprint = { name: "Preserved", metadata: { unresolved_requirements: ["recipient"] }, trigger: { type: "schedule", cron: "0 9 * * *", timezone: "Asia/Colombo" }, steps: [
  { id: "first", action: "demo.echo", parameters: { nested: { value: [false, null, 7] } }, condition: "{{input.enabled}}", retryCount: 2 },
  { id: "approval", kind: "approval", description: "Human review" },
  { id: "last", action: "demo.echo", parameters: { value: "tail" } },
] };
const workflow = { yaml: dump(blueprint) };
const nodes = blueprint.steps.map((step) => ({ id: step.id, data: { source: step, action: step.action ?? step.kind, parameters: step.parameters ?? {}, description: step.description ?? "" } }));
const edges = [{ source: "first", target: "approval" }, { source: "approval", target: "last" }];
test("source-order serialization retains typed nested data, approval/control fields, trigger and blockers", () => {
  const output = serializeSourceOrderCanvas(workflow, nodes, edges);
  expect(readCanvasBlueprint(output)).toEqual(blueprint);
  expect(sameWorkflowSource(workflow.yaml, output)).toBe(true);
  expect(readCanvasBlueprint(serializeSourceOrderCanvas(workflow, nodes.map((node) => node.id === "first" ? { ...node, data: { ...node.data, parameters: { value: "changed" } } } : node), edges)).steps[0]).toEqual({ ...blueprint.steps[0], parameters: { value: "changed" } });
});
test("semantic validation projection excludes UI decoration and preserves explicit workflow metadata", () => {
  expect(sourceOrderCanvasValidationPayload({ ...workflow, name: "Preserved" }, nodes.map(node => ({ ...node, position: { x: 1, y: 2 }, data: { ...node.data, status: "idle", label: "UI only" } })), edges)).toEqual({
    profile: "source-order-canvas/v1", name: "Preserved", trigger: blueprint.trigger, metadata: blueprint.metadata,
    nodes: blueprint.steps, edges,
  });
});
test.each([
  [{ source: "first", target: "approval" }, { source: "first", target: "last" }],
  [{ source: "first", target: "last" }, { source: "approval", target: "last" }],
  [],
  [...edges, { source: "last", target: "first" }],
  [{ source: "unknown", target: "first" }],
].map((connections) => ({ connections })))("unsupported branch/disconnection/cycle %j is blocked, never flattened", ({ connections }) => {
  expect(() => serializeSourceOrderCanvas(workflow, nodes, connections)).toThrow();
});
test("formatting/key order comparison does not equate a changed requirement or parameter", () => {
  expect(sameWorkflowSource(workflow.yaml, dump({ ...blueprint, steps: [...blueprint.steps].reverse() }))).toBe(false);
  expect(sameWorkflowSource(workflow.yaml, dump({ ...blueprint, metadata: {} }))).toBe(false);
});
test.each(["steps: not-a-list", "steps: [{id: same}, {id: same}]", "!!js/function 'function(){}'"])("malformed or duplicate import %s is rejected", (yaml) => { expect(() => readCanvasBlueprint(yaml)).toThrow(); });

test("new catalog tools retain exact input types, required fields and choices across save and validation", () => {
  const inputSchema = { type: "object", properties: { customer_name: { type: "string" }, customer_type: { type: "string", enum: ["Company", "Individual"] }, count: { type: "integer" } }, required: ["customer_name", "customer_type", "count"], additionalProperties: false };
  const added = [{ id: "create", data: { action: "real.create_customer", inputSchema, parameters: { customer_name: "{{input.customer_name}}", customer_type: "{{input.customer_type}}", count: "{{input.count}}" } } }];
  const source = readCanvasBlueprint(serializeSourceOrderCanvas({ name: "Reusable" }, added, []));
  expect(source.trigger.config.inputSchema).toEqual(inputSchema);
  expect(source.steps[0].parameters).toEqual(added[0].data.parameters);
  expect(sourceOrderCanvasValidationPayload({ name: "Reusable" }, added, []).trigger).toEqual(source.trigger);
});

test("two tool contracts cannot silently overwrite a shared input with a different type", () => {
  const added = ["string", "integer"].map((type, index) => ({ id: `tool_${index}`, data: { action: `real.${index}`, inputSchema: { type: "object", properties: { value: { type } }, required: ["value"] }, parameters: { value: "{{input.value}}" } } }));
  expect(() => serializeSourceOrderCanvas({ name: "Conflicting" }, added, [{ source: "tool_0", target: "tool_1" }])).toThrow(/Conflicting tool input/);
});
