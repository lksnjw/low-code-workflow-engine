import { expect, test } from "vitest";
import { toolSchema } from "../src/registry/schemas.js";
import { bridgeTransportSchema, exactBridgeName, matchesBridgeContract, hasReservedBridgeRole } from "../src/tools/erpbridge-contract.js";
import { compareErpbridgeRegistry } from "../src/tools/erpbridge-registry-compatibility.js";
import { discoverTools } from "../src/agent/tool-discovery.js";
import type { RegistryService } from "../src/registry/service.js";
import type { ErpbridgeMcpSession } from "../src/tools/erpbridge-mcp-client.js";
const tool = toolSchema.parse({ tool_id: "reviewed", name: "read", mcp_tool_name: "erp.read", is_read_only: true, allowed_roles: ["Workflow Builder"],
  input_schema: { type: "object", properties: { id: { type: "string" } }, additionalProperties: false },
  bridge_contract: { profile: "toolplane-v1", resource_version: "1.0.0-beta.1+build.4", resource_digest: "a".repeat(64), remote_roles: ["reader", "workflow_builder"], output_schema: { type: "object" } } });
const remote = { name: exactBridgeName(tool), inputSchema: bridgeTransportSchema(tool), outputSchema: { type: "object" }, annotations: { readOnlyHint: true },
  _meta: { "toolplane.resourceDigest": "a".repeat(64), "toolplane.resourceVersion": tool.bridge_contract!.resource_version, "io.erpbridge/allowedRoles": ["workflow_builder", "reader"], "toolplane.serving": false } };
test("exact semver name and optional normalized reserved role match the bridge schema; serving alias is not authority", () => {
  expect(exactBridgeName(tool)).toBe(`erp.read.rev_${Buffer.from("1.0.0-beta.1+build.4").toString("base64url")}`);
  expect(remote.inputSchema).toEqual({ type: "object", properties: { id: { type: "string" }, role: { type: "string", description: "Authorization role used for this tool call", enum: ["reader", "workflow_builder"] } }, additionalProperties: false });
  expect(matchesBridgeContract(tool, remote)).toBe(true);
  expect(matchesBridgeContract(tool, { ...remote, name: "erp.read" })).toBe(false);
  expect(compareErpbridgeRegistry([tool], [remote]).compatible).toBe(true);
  expect(compareErpbridgeRegistry([tool], [{ ...remote, outputSchema: { type: "array" } }]).incompatible[0]?.reason).toContain("output schema");
});
test.each(["digest", "version", "roles", "output", "required-role", "missing-meta"])("contract mismatch %s cannot be admitted", scenario => {
  const changed = structuredClone(remote);
  if (scenario === "digest") changed._meta["toolplane.resourceDigest"] = "b".repeat(64);
  if (scenario === "version") changed._meta["toolplane.resourceVersion"] = "2.0.0";
  if (scenario === "roles") changed._meta["io.erpbridge/allowedRoles"] = ["admin"];
  if (scenario === "output") changed.outputSchema = { type: "array" };
  if (scenario === "required-role") Object.assign(changed.inputSchema, { required: ["role"] });
  if (scenario === "missing-meta") Object.assign(changed, { _meta: {} });
  expect(matchesBridgeContract(tool, changed)).toBe(false);
});
test("open contract role property remains business data; unsupported schema and selector collision are rejected", () => {
  const open = { ...tool, bridge_contract: { ...tool.bridge_contract!, remote_roles: [] }, input_schema: { type: "object", properties: { role: { type: "string" } } } };
  expect(hasReservedBridgeRole(open)).toBe(false); expect(bridgeTransportSchema(open)).toEqual(open.input_schema);
  expect(() => bridgeTransportSchema({ ...tool, input_schema: open.input_schema })).toThrow(/reserve/);
  expect(matchesBridgeContract({ ...tool, input_schema: { type: "object", allOf: [] } }, remote)).toBe(false);
});

test("reviewed read aliases retain the exact digest and schema without inventing a versioned name", () => {
  const alias = toolSchema.parse({ ...tool, bridge_contract: { ...tool.bridge_contract!, selector: "digest-pinned-alias" } });
  const descriptor = { ...remote, name: "erp.read", _meta: { ...remote._meta, "toolplane.serving": true } };
  expect(exactBridgeName(alias)).toBe("erp.read");
  expect(matchesBridgeContract(alias, descriptor)).toBe(true);
  expect(matchesBridgeContract(alias, { ...descriptor, _meta: { ...descriptor._meta, "toolplane.serving": false } })).toBe(false);
  expect(matchesBridgeContract(alias, { ...descriptor, annotations: { readOnlyHint: false } })).toBe(false);
  expect(matchesBridgeContract(alias, { ...descriptor, _meta: { ...descriptor._meta, "toolplane.resourceDigest": "b".repeat(64) } })).toBe(false);
  expect(matchesBridgeContract(alias, { ...descriptor, outputSchema: { type: "array" } })).toBe(false);
});
test("list change generation invalidates the session cache; an in-flight changed inventory is not admitted", async () => {
  let generation = 0, tools = [remote], calls = 0, changeDuringList = false;
  const session = { requiresReviewedRevision: true, get discoveryGeneration() { return generation; }, listTools: async () => { calls++; if (changeDuringList) generation++; return tools; } } as unknown as ErpbridgeMcpSession;
  const registries = { hash: () => "fixture-contract", snapshot: () => ({ tools: [tool] }) } as unknown as RegistryService;
  expect(await discoverTools(session, registries)).toEqual([tool]); expect(await discoverTools(session, registries)).toEqual([tool]); expect(calls).toBe(1);
  generation++; tools = []; expect(await discoverTools(session, registries)).toEqual([]); expect(calls).toBe(2);
  generation++; tools = [remote]; changeDuringList = true; await expect(discoverTools(session, registries)).rejects.toThrow(/discovery failed/);
});
