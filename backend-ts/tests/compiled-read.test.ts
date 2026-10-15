import { expect, test } from "vitest";
import { stringify } from "yaml";
import { buildReadIR, compileReadWorkflow, resolveReadBinding, assertCompiledReadMatches, type ReadAdmissionPin } from "../src/workflows/compiled-read.js";
import { toolSchema } from "../src/registry/schemas.js";
import { parseWorkflowYAMLStrict } from "../src/parser/workflow.js";

const tool = toolSchema.parse({ tool_id: "read", name: "read.rows", mcp_tool_name: "read-rows", is_read_only: true, allowed_roles: ["Builder"],
  input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false } });
const source = stringify({ name: "Rows", trigger: { type: "manual" }, steps: [{ id: "first", action: tool.name, parameters: { id: "{{input.id}}" } },
  { id: "second", action: tool.mcp_tool_name, parameters: { id: "{{first.structuredContent.id}}" } }] });
const compile = (yaml = source) => compileReadWorkflow(yaml, [tool], "Builder");

test.each([false, true])("v3 control-flow without a loop compiles as structured reads, withReturn=%s", withReturn => {
  const sequence = (...nodes: unknown[]) => ({ kind: "sequence", nodes });
  const branch = { kind: "if", id: "gate", predicate: { kind: "ref", source: "workflowInput", path: ["proceed"] },
    then: sequence({ kind: "action", nodeId: "first" }), else: sequence({ kind: "action", nodeId: "second" }),
    ...(withReturn ? { merge: { schema: { type: "string" }, then: { kind: "literal", value: "yes" }, else: { kind: "literal", value: "no" } } } : {}) };
  const workflow = { name: "Conditional, not a collection", trigger: { type: "manual", config: { inputSchema: { type: "object", properties: { proceed: { type: "boolean" } }, required: ["proceed"], additionalProperties: false } } },
    steps: ["first", "second"].map(id => ({ id, action: tool.name, parameters: { id } })),
    metadata: { controlFlow: { schemaVersion: "read-control-flow/v3", root: sequence(branch,
      ...(withReturn ? [{ kind: "return", id: "finish", output: { schema: { type: "string" }, value: { kind: "ref", source: "nodeOutput", nodeId: "gate", path: ["value"] } } }] : [])) } } };
  const plan = compile(stringify(workflow));
  expect(plan.ir).toMatchObject({ schemaVersion: "workflow-read-ir/v3", compilerVersion: "read-compiler/v3" });
  const previousFormat = structuredClone(workflow); previousFormat.metadata.controlFlow.schemaVersion = "read-control-flow/v2";
  expect(compile(stringify(previousFormat)).semanticHash).toBe(plan.semanticHash);
  expect(compile(stringify(previousFormat)).sourceHash).not.toBe(plan.sourceHash);
});

test("compiler emits stable ordered actions and structured input/upstream references, not template instructions", () => {
  const plan = compile();
  expect(plan.ir.root.nodes.map(node => [node.id, node.kind, node.capability.action])).toEqual([["first", "action", "read.rows"], ["second", "action", "read.rows"]]);
  expect(plan.ir.root.nodes[0]!.inputs).toEqual({ kind: "object", fields: { id: { kind: "ref", source: "workflowInput", path: ["id"] } } });
  expect(plan.ir.root.nodes[1]!.inputs).toEqual({ kind: "object", fields: { id: { kind: "ref", source: "nodeOutput", nodeId: "first", path: ["structuredContent", "id"] } } });
  expect(resolveReadBinding(plan.ir.root.nodes[1]!.inputs, { first: { structuredContent: { id: "actual" } } })).toEqual({ id: "actual" });
});

test("semantic identity ignores YAML layout, comments, labels and presentation metadata while retaining source audit identity", () => {
  const edited = parseWorkflowYAMLStrict(source); edited.name = "Renamed"; edited.description = "UI label"; edited.steps[0]!.description = "New node label"; edited.metadata = { positions: { first: { x: 999, y: 1 } }, selectedNode: "second" };
  const first = compile(), cosmetic = compile(stringify(edited) + "\n# comment\n");
  expect(cosmetic.semanticHash).toBe(first.semanticHash); expect(cosmetic.sourceHash).not.toBe(first.sourceHash);
  const alias = source.replace("read.rows", "read-rows"); expect(compile(alias).semanticHash).toBe(first.semanticHash);
});

test("literal/mapping/order/tool revision changes invalidate compiled identity", () => {
  const first = compile(), blueprint = parseWorkflowYAMLStrict(source); blueprint.steps[0]!.parameters = { id: "different" };
  expect(compile(stringify(blueprint)).semanticHash).not.toBe(first.semanticHash);
  blueprint.steps = [{ id: "second", action: tool.name, parameters: { id: "different" } }, { id: "first", action: tool.name, parameters: { id: "different" } }];
  const ordered = compile(stringify(blueprint)); blueprint.steps.reverse(); expect(compile(stringify(blueprint)).semanticHash).not.toBe(ordered.semanticHash);
  expect(compileReadWorkflow(source, [{ ...tool, description: "New reviewed contract" }], "Builder").semanticHash).not.toBe(first.semanticHash);
});

test("exact admission revision/version is part of the executable identity", () => {
  const pin: ReadAdmissionPin = { connectionId: "erpbridge-default", capabilityId: "cap_one", revisionId: "rev_one", admissionVersion: 1, contractHash: `sha256:${"a".repeat(64)}` };
  const first = compileReadWorkflow(source, [tool], "Builder", new Map([[tool.tool_id, pin]]));
  const next = compileReadWorkflow(source, [tool], "Builder", new Map([[tool.tool_id, { ...pin, revisionId: "rev_two", admissionVersion: 2 }]]));
  expect(first.semanticHash).not.toBe(next.semanticHash); expect(first.ir.root.nodes.every(node => node.capability.admission?.revisionId === "rev_one")).toBe(true);
  const forged = structuredClone(first); (forged.ir.root.nodes[0]!.inputs as any).fields.id = { kind: "literal", value: "forged" };
  expect(() => assertCompiledReadMatches(forged, first)).toThrow(/identity/);
});

test.each(["cron", "webhook", "unknown-config", "write", "role", "condition", "retry", "required", "type", "forward", "self", "malformed", "reserved", "duplicate"])("unsupported %s is a compiler error, not a runtime reinterpretation", scenario => {
  const blueprint = parseWorkflowYAMLStrict(source); let definition = structuredClone(tool);
  if (scenario === "cron" || scenario === "webhook") blueprint.trigger.type = scenario;
  if (scenario === "unknown-config") blueprint.trigger.config = { url: "ignored" };
  if (scenario === "write") definition.is_read_only = false;
  if (scenario === "role") definition.allowed_roles = [];
  if (scenario === "condition") blueprint.steps[0]!.condition = "true";
  if (scenario === "retry") blueprint.steps[0]!.retryCount = 1;
  if (scenario === "required") blueprint.steps[0]!.parameters = {};
  if (scenario === "type") blueprint.steps[0]!.parameters = { id: ["one"] };
  if (scenario === "forward") blueprint.steps[0]!.parameters = { id: "{{second.structuredContent.id}}" };
  if (scenario === "self") blueprint.steps[0]!.parameters = { id: "{{first.structuredContent.id}}" };
  if (scenario === "malformed") blueprint.steps[0]!.parameters = { id: "{{input.id + 1}}" };
  if (scenario === "reserved") blueprint.steps[0]!.parameters = { id: "{{input.constructor.name}}" };
  if (scenario === "duplicate") blueprint.steps[1]!.id = blueprint.steps[0]!.id;
  expect(buildReadIR(blueprint, [definition], "Builder").issues.length).toBeGreaterThan(0);
});

test("declared input/output types are checked, and unknown sources remain concrete runtime guards", () => {
  const blueprint = parseWorkflowYAMLStrict(source); blueprint.trigger.config = { inputSchema: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] } };
  expect(buildReadIR(blueprint, [tool], "Builder").issues).toContain("Step first has an incompatible typed reference");
  const outputTool = { ...tool, bridge_contract: { profile: "toolplane-v1" as const, resource_version: "1.0.0", resource_digest: "a".repeat(64), remote_roles: [], output_schema: { type: "object", properties: { id: { type: "integer" } } } } };
  expect(buildReadIR(parseWorkflowYAMLStrict(source), [outputTool], "Builder").issues).toContain("Step second has an incompatible typed reference");
  const plan = compile(); expect(() => resolveReadBinding(plan.ir.root.nodes[1]!.inputs, { first: { structuredContent: {} } })).toThrow(/unavailable/);
});

test("explicit string templates never coerce arrays/objects/numbers, unwrap values, or recursively interpret tool output", () => {
  const blueprint = parseWorkflowYAMLStrict(source); blueprint.steps[0]!.parameters = { id: "prefix {{input.id}}" };
  const plan = compile(stringify(blueprint)), binding = plan.ir.root.nodes[0]!.inputs;
  for (const id of [42, ["one"], { id: "one" }, null]) expect(() => resolveReadBinding(binding, { input: { id } })).toThrow(/implicit conversion/);
  expect(resolveReadBinding(binding, { input: { id: "{{second.secret}}" } })).toEqual({ id: "prefix {{second.secret}}" });
  expect(resolveReadBinding(compile().ir.root.nodes[0]!.inputs, { input: { id: ["one"] } })).toEqual({ id: ["one"] }); // Final schema gate rejects; no unwrapping.
});

test("bounded literal object/array/null and indexed references keep JSON shape and return copies", () => {
  const value = { input: { rows: [{ id: "one" }] } };
  const ref = { kind: "ref" as const, source: "workflowInput" as const, path: ["rows", "0"] };
  const result = resolveReadBinding(ref, value) as { id: string }; result.id = "changed"; expect(value.input.rows[0]!.id).toBe("one");
  expect(() => resolveReadBinding({ ...ref, path: ["rows", "constructor"] }, value)).toThrow(/unavailable/);
});

test("nested declared object/array references cannot pass only because their root types match", () => {
  const definition = { ...tool, input_schema: { type: "object", properties: { rows: { type: "array", items: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } } }, required: ["rows"] } };
  const blueprint = parseWorkflowYAMLStrict(source); blueprint.steps = [{ id: "first", action: tool.name, parameters: { rows: "{{input.rows}}" } }];
  blueprint.trigger.config = { inputSchema: { type: "object", properties: { rows: { type: "array", items: { type: "object", properties: { id: { type: "integer" } } } } } } };
  expect(buildReadIR(blueprint, [definition], "Builder").issues).toContain("Step first has an incompatible typed reference");
});

test("source, step, depth, schema and projection budgets reject before execution", () => {
  expect(() => compile(" ".repeat(200001))).toThrow(/source size/);
  const blueprint = parseWorkflowYAMLStrict(source); blueprint.steps = Array.from({ length: 201 }, (_, index) => ({ id: `n${index}`, action: tool.name, parameters: { id: "one" } }));
  expect(buildReadIR(blueprint, [tool], "Builder").issues).toContain("Read workflows require 1–200 steps");
  let nested: any = "one"; for (let depth = 0; depth < 18; depth++) nested = { child: nested };
  blueprint.steps = [{ id: "first", action: tool.name, parameters: { id: nested } }]; expect(buildReadIR(blueprint, [tool], "Builder").issues).toContain("Read parameters exceed supported limits");
  expect(buildReadIR(parseWorkflowYAMLStrict(source), [{ ...tool, input_schema: { ...tool.input_schema, unknown: true } }], "Builder").issues).toContain("Tool schema contains unsupported constraints");
});
