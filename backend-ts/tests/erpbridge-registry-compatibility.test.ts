import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { RegistryService } from "../src/registry/service.js";
import {
  assertErpbridgeRegistryCompatible,
  compareErpbridgeRegistry,
} from "../src/tools/erpbridge-registry-compatibility.js";
import type { ToolDefinition } from "../src/registry/schemas.js";

/*******************************************************************************
 * Function: localTool
 *
 * Builds a local tool definition for registry compatibility tests.
 ******************************************************************************/
function localTool(
  name: string,
  remoteName: string,
  inputSchema: Record<string, unknown>,
): ToolDefinition {
  return {
    tool_id: `TOOL-${name}`,
    name,
    display_name: name,
    erp_system: "ERPBridge",
    module: "test",
    status: "active_mcp_schema_present",
    description: "Reviewed test tool",
    business_capability: "Testing",
    bpi_process_alignment: [],
    endpoint: "/mcp/",
    http_method: "POST",
    mcp_tool_name: remoteName,
    input_schema: inputSchema,
    required_parameters: [],
    optional_parameters: [],
    allowed_roles: [],
    risk_level: "low",
    is_read_only: true,
    side_effects: [],
    preconditions: [],
    postconditions: [],
    failure_modes: [],
    validator_checks: [],
    prompt_usage_guidance: "",
    semantic_search_keywords: [],
    semantic_search_description: "",
    execution_notes: "",
    current_gaps: [],
  };
}

describe("ERPBridge registry compatibility", () => {
  test("accepts exact reviewed names and equivalent JSON schemas", () => {
    const report = compareErpbridgeRegistry(
      [
        localTool("attendance", "hr.attendance", {
          type: "object",
          properties: { employee_id: { type: "string" } },
        }),
      ],
      [
        {
          name: "hr.attendance",
          description: "Attendance",
          inputSchema: {
            properties: { employee_id: { type: "string" } },
            type: "object",
          },
        },
      ],
    );

    expect(report).toEqual({
      compatible: true,
      missing: [],
      incompatible: [],
      unreviewed: [],
      duplicateRemoteNames: [],
    });
    expect(() => assertErpbridgeRegistryCompatible(report)).not.toThrow();
  });

  test("reports missing, incompatible, unreviewed, and duplicate remote tools", () => {
    const report = compareErpbridgeRegistry(
      [
        localTool("attendance", "hr.attendance", { type: "object" }),
        localTool("leave", "hr.leave", { type: "object" }),
      ],
      [
        { name: "hr.attendance", inputSchema: { type: "string" } },
        { name: "hr.attendance", inputSchema: { type: "string" } },
        { name: "hr.unreviewed", inputSchema: { type: "object" } },
      ],
    );

    expect(report.compatible).toBe(false);
    expect(report.missing).toEqual(["hr.leave"]);
    expect(report.incompatible).toEqual([
      { name: "hr.attendance", reason: "input schema differs" },
    ]);
    expect(report.unreviewed).toEqual(["hr.unreviewed"]);
    expect(report.duplicateRemoteNames).toEqual(["hr.attendance"]);
    expect(() => assertErpbridgeRegistryCompatible(report)).toThrow(
      /ERPBridge registry drift/,
    );
    expect(() => assertErpbridgeRegistryCompatible(report)).not.toThrow(
      /token|secret|bearer/i,
    );
  });

  test("does not mutate the authoritative local registry", async () => {
    const registries = await RegistryService.load(
      resolve("tests/fixtures/tools.json"),
      resolve("tests/fixtures/rules.json"),
    );
    const before = {
      snapshot: JSON.stringify(registries.snapshot()),
      hash: registries.hash(),
    };
    const report = compareErpbridgeRegistry(registries.snapshot().tools, []);
    expect(report.compatible).toBe(false);
    expect(JSON.stringify(registries.snapshot())).toBe(before.snapshot);
    expect(registries.hash()).toBe(before.hash);
  });
});
