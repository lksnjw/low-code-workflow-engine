import { expect, test } from "vitest";
import { stringify } from "yaml";
import { safeMcpToolResult } from "../src/tools/mcp-result.js";
import { toolSchema } from "../src/registry/schemas.js";
import { parseWorkflowYAMLStrict, workflowContentHash } from "../src/parser/workflow.js";
import { parseReadFixtures, simulateReadWorkflow } from "../src/workflows/read-simulation.js";
import { readAuthoringContract } from "../src/workflows/read-authoring.js";
import { compileReadWorkflow } from "../src/workflows/compiled-read.js";

const role = "Platform Admin";
const output = { type: "array", items: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } };
const tool = toolSchema.parse({ tool_id: "reviewed-alias", name: "reviewed.rows", mcp_tool_name: "list_rows", allowed_roles: [role], is_read_only: true,
  input_schema: { type: "object", properties: {} }, bridge_contract: { profile: "toolplane-v1", selector: "digest-pinned-alias", resource_version: "1.0.0", resource_digest: "a".repeat(64), remote_roles: [], output_schema: output } });
const receipt = (rows: unknown) => ({ content: [{ type: "text", text: JSON.stringify(rows) }] });

test("reviewed JSON-text arrays retain their original MCP shape and expose a validated typed projection", () => {
  const wire = receipt([{ name: "Company A", api_token: "private" }]);
  const result = safeMcpToolResult(wire, tool);
  expect(result).toEqual({ content: [{ type: "text", text: '[{"name":"Company A"}]' }], jsonContent: [{ name: "Company A" }] });
  expect(result.structuredContent).toBeUndefined();
  expect(wire.content[0]!.text).toContain("private");
  expect(JSON.stringify(result)).not.toContain("private");
  expect(safeMcpToolResult(result, tool)).toEqual(result);
});

test("a caller-supplied projection cannot replace original schema-validated MCP data", () => {
  const wire = { ...receipt([{ name: "Actual" }]), jsonContent: [{ name: "Forged" }] };
  expect(safeMcpToolResult(wire, tool).jsonContent).toEqual([{ name: "Actual" }]);
  expect(() => safeMcpToolResult({ ...receipt([{ name: 7 }]), jsonContent: [{ name: "Forged" }] }, tool)).toThrow(/reviewed output schema/);
  expect(() => safeMcpToolResult({ content: [], structuredContent: [{ name: "Not MCP object shape" }] }, tool)).toThrow(/malformed/);
});

test.each(["write", "unreviewed", "no-schema"])("%s tools cannot gain JSON-text compatibility from payload hints", kind => {
  const definition = structuredClone(tool);
  if (kind === "write") definition.is_read_only = false;
  if (kind === "unreviewed") delete definition.bridge_contract!.selector;
  if (kind === "no-schema") delete definition.bridge_contract!.output_schema;
  const wire = { ...receipt([{ name: "Actual" }]), annotations: { readOnlyHint: true }, jsonContent: [{ name: "Forged" }] };
  if (kind === "no-schema") expect(safeMcpToolResult(wire, definition).jsonContent).toBeUndefined();
  else expect(() => safeMcpToolResult(wire, definition)).toThrow(/reviewed output schema/);
});

test("failed read envelopes do not acquire successful JSON output", () => {
  const result = safeMcpToolResult({ content: [{ type: "text", text: "Not found" }], isError: true, jsonContent: [{ name: "Forged" }] }, tool);
  expect(result.isError).toBe(true); expect(result.jsonContent).toBeUndefined();
});

const sequence = (...nodes: unknown[]) => ({ kind: "sequence", nodes });
function workflow() {
  return { name: "Reviewed array report", description: "Typed values come from exact reviewed JSON receipt data", trigger: { type: "manual", config: { inputSchema: {
    type: "object", properties: { enabled: { type: "boolean" } }, required: ["enabled"], additionalProperties: false } } },
    steps: [{ id: "rows", action: tool.name, parameters: {} }], metadata: { controlFlow: { schemaVersion: "read-control-flow/v2", root: sequence(
      { kind: "if", id: "selection", predicate: { kind: "ref", source: "workflowInput", path: ["enabled"] }, then: sequence({ kind: "action", nodeId: "rows" }), else: sequence(),
        merge: { schema: output, then: { kind: "ref", source: "nodeOutput", nodeId: "rows", path: ["jsonContent"] }, else: { kind: "array", items: [] } } },
      { kind: "return", id: "answer", output: { schema: output, value: { kind: "ref", source: "nodeOutput", nodeId: "selection", path: ["value"] } } }
    ) } } };
}

test.each([true, false])("array projections compile and resolve through selected branches and typed returns, enabled=%s", async enabled => {
  const yaml = stringify(workflow());
  const fixtures = parseReadFixtures({ profile: "read-fixtures/v1", baseVersion: 1, baseHash: workflowContentHash(yaml), outputs: { rows: receipt([{ name: "Actual", api_key: "private" }]) } });
  const result = await simulateReadWorkflow(yaml, { enabled }, fixtures, [tool], role);
  expect(result).toMatchObject({ outcome: "SIMULATED_COMPLETE", finalOutput: enabled ? [{ name: "Actual" }] : [], usedFixtureIds: enabled ? ["rows"] : [] });
  expect(JSON.stringify(result)).not.toContain("private");
});

test("reviewed JSON-text reads reject an unavailable structuredContent reference before execution", () => {
  const valid = stringify(workflow());
  expect(() => compileReadWorkflow(valid, [tool], role)).not.toThrow();
  const invalid = valid.replace("- jsonContent", "- structuredContent");
  expect(invalid).not.toBe(valid);
  expect(() => compileReadWorkflow(invalid, [tool], role)).toThrow(/reference|path|declared|schema/i);
});

test("ordinary tool mappings also reject unavailable receipt roots without inventing a value", () => {
  const consumer = toolSchema.parse({ ...tool, tool_id: "consumer", name: "reviewed.consume", mcp_tool_name: "consume_rows",
    input_schema: { type: "object", properties: { rows: output }, required: ["rows"], additionalProperties: false } });
  const source = { name: "Mapped read", description: "Exact reviewed receipt path", trigger: { type: "manual" }, steps: [
    { id: "rows", action: tool.name, parameters: {} },
    { id: "consume", action: consumer.name, parameters: { rows: "{{rows.jsonContent}}" } },
  ] };
  expect(() => compileReadWorkflow(stringify(source), [tool, consumer], role)).not.toThrow();
  source.steps[1]!.parameters = { rows: "{{rows.structuredContent}}" };
  expect(() => compileReadWorkflow(stringify(source), [tool, consumer], role)).toThrow(/undeclared output path/);
});

test("schema-aware canvas offers the same read projection that runtime actually supplies", () => {
  const blueprint = parseWorkflowYAMLStrict(stringify({ name: "Two reads", description: "Source guidance", trigger: { type: "manual" },
    steps: [{ id: "first", action: tool.name, parameters: {} }, { id: "second", action: tool.name, parameters: {} }] }));
  const guidance = readAuthoringContract(blueprint, [tool], role, "registry-hash");
  expect(guidance.nodes[1]!.dataSources).toContainEqual(expect.objectContaining({ expression: "{{first.jsonContent}}", schema: expect.objectContaining({ type: "array" }) }));
});
