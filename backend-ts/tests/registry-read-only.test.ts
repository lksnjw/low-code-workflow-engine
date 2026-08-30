import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { RegistryService } from "../src/registry/service.js";

const expectedReadOnlyTools = [
  "classify_invoice",
  "policy_check",
  "fetch_attendance",
  "policy.check_policy_limit",
  "procurement.validate_vendor",
  "demo.echo",
];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("read-only registry selection", () => {
  test("returns exactly the six tools explicitly marked read-only and no write tools", async () => {
    const registries = await loadMasterRegistry();
    const selected = registries.readOnlyTools();

    expect(selected.map((tool) => tool.name)).toEqual(expectedReadOnlyTools);
    expect(selected.every((tool) => tool.is_read_only === true)).toBe(true);
    expect(selected.filter((tool) => tool.is_read_only === false)).toHaveLength(
      0,
    );
  });

  test("adding a write tool to the registry does not change the read-only result", async () => {
    const { registries } = await loadTemporaryMasterRegistry();
    const source = registries.snapshot().tools.at(-1)!;
    await registries.upsertTool(
      {
        ...source,
        tool_id: "TOOL-TEST-WRITE-001",
        name: "test.write_operation",
        display_name: "Test write operation",
        mcp_tool_name: "test.write_operation",
        is_read_only: false,
      },
      false,
    );

    expect(registries.snapshot().tools).toHaveLength(18);
    expect(registries.readOnlyTools().map((tool) => tool.name)).toEqual(
      expectedReadOnlyTools,
    );
  });

  test("rejects a registry record missing is_read_only and names the offending tool", async () => {
    const directory = await createTemporaryDirectory();
    const toolPath = join(directory, "tools.json");
    const rulePath = join(directory, "rules.json");
    const source = JSON.parse(
      await readFile(
        resolve("fixtures/parity/http/runtime/all_tools_master_registry.json"),
        "utf8",
      ),
    ) as Array<Record<string, unknown>>;
    const missingFlag = { ...source[0] };
    delete missingFlag.is_read_only;
    await writeFile(toolPath, JSON.stringify([missingFlag]), "utf8");
    await writeFile(rulePath, "[]", "utf8");

    await expect(RegistryService.load(toolPath, rulePath)).rejects.toThrow(
      /tool "classify_invoice" is missing required is_read_only/,
    );
  });
});

async function loadMasterRegistry(): Promise<RegistryService> {
  return RegistryService.load(
    resolve("fixtures/parity/http/runtime/all_tools_master_registry.json"),
    resolve("fixtures/parity/http/runtime/all_rules_master_registry.json"),
  );
}

async function loadTemporaryMasterRegistry(): Promise<{
  registries: RegistryService;
}> {
  const directory = await createTemporaryDirectory();
  const toolPath = join(directory, "tools.json");
  const rulePath = join(directory, "rules.json");
  await Promise.all([
    writeFile(
      toolPath,
      await readFile(
        resolve("fixtures/parity/http/runtime/all_tools_master_registry.json"),
      ),
    ),
    writeFile(
      rulePath,
      await readFile(
        resolve("fixtures/parity/http/runtime/all_rules_master_registry.json"),
      ),
    ),
  ]);
  return { registries: await RegistryService.load(toolPath, rulePath) };
}

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "lcwe-read-only-registry-"));
  temporaryDirectories.push(directory);
  return directory;
}
