import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig } from "../src/config/config.ts";
import { RegistryService } from "../src/registry/service.ts";
import { createErpbridgeMcpSession } from "../src/tools/erpbridge-mcp-client.ts";
import {
  assertErpbridgeRegistryCompatible,
  compareErpbridgeRegistry,
} from "../src/tools/erpbridge-registry-compatibility.ts";
import { Repository } from "../src/repository/store.ts";
import { RegistryValidator } from "../src/validator/registry-validator.ts";

/*******************************************************************************
 * Function: existingOrFallback
 *
 * Returns the requested file path when accessible or its fallback path.
 ******************************************************************************/
async function existingOrFallback(path, fallback) {
  try {
    await access(path);
    return path;
  } catch {
    return fallback;
  }
}

/*******************************************************************************
 * Function: main
 *
 * Loads local and live ERPBridge registries and checks their compatibility.
 ******************************************************************************/
async function main() {
  const config = loadConfig();
  if (config.mcpTransport !== "erpbridge-mcp")
    throw new Error(
      "MCP_TRANSPORT=erpbridge-mcp is required for ERPBridge registry verification",
    );
  const toolPath = await existingOrFallback(
    config.toolRegistryPath,
    resolve("fixtures/parity/http/runtime/all_tools_master_registry.json"),
  );
  const rulePath = await existingOrFallback(
    config.ruleRegistryPath,
    resolve("fixtures/parity/http/runtime/all_rules_master_registry.json"),
  );
  const registries = await RegistryService.load(toolPath, rulePath);
  const validator = new RegistryValidator(registries, new Repository());
  const session = await createErpbridgeMcpSession({
    baseURL: config.erpbridgeBaseURL,
    token: config.erpbridgeMcpToken,
    timeoutMs: config.mcpTimeoutMs,
    validator,
  });
  try {
    const remoteTools = await session.listTools();
    const report = compareErpbridgeRegistry(
      registries.snapshot().tools,
      remoteTools,
    );
    console.log(JSON.stringify(report, null, 2));
    assertErpbridgeRegistryCompatible(report);
  } finally {
    await session.close();
  }
}

try {
  await main();
} catch (error) {
  console.error(
    `ERPBridge registry compatibility check failed: ${error instanceof Error ? error.name : "unknown error"}`,
  );
  process.exitCode = 1;
}
