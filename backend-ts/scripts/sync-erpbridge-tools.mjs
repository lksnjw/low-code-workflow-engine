/**
 * Fetches all tools from the live ERPBridge MCP endpoint and merges them
 * into the local all_tools_master_registry.json. Existing entries are kept
 * as-is; only genuinely new tools are appended.
 *
 * Usage: node --env-file=.env scripts/sync-erpbridge-tools.mjs
 */
import { createClient } from "@erpbridge/sdk";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const ROOT = process.cwd();
const REGISTRY_PATH = resolve(ROOT, "configs/runtime/all_tools_master_registry.json");

const baseUrl = process.env.ERPBRIDGE_BASE_URL ?? process.env.MCP_BASE_URL;
const token = process.env.ERPBRIDGE_MCP_TOKEN;
if (!baseUrl || !token) {
  console.error("ERPBRIDGE_BASE_URL and ERPBRIDGE_MCP_TOKEN must be set");
  process.exit(1);
}

console.log("Connecting to ERPBridge MCP at", baseUrl);
const client = createClient({
  baseUrl,
  token,
  timeoutMs: 30_000,
  declaredScopes: ["mcp"],
  mcpRetryPolicy: "never",
}).mcp;

await client.connect();
console.log("Connected. Listing tools...");

const erpTools = await client.listTools();
await client.close();
console.log(`Found ${erpTools.length} tools on ERPBridge.`);

// Load existing registry
const existing = JSON.parse(await readFile(REGISTRY_PATH, "utf8"));
const existingNames = new Set(existing.map((t) => t.name));
const existingMcpNames = new Set(existing.map((t) => t.mcp_tool_name));

let added = 0;
for (const erp of erpTools) {
  if (existingNames.has(erp.name) || existingMcpNames.has(erp.name)) continue;

  // Infer read-only from name — getXxx / listXxx / fetchXxx / readXxx are reads
  const isReadOnly = /^(get|list|fetch|read|search|query|find)[\W_]/i.test(erp.name);

  // Infer risk level from name keywords
  let riskLevel = "low";
  if (/cancel|delete|remove|clear|void|reverse|reject/i.test(erp.name)) riskLevel = "high";
  else if (/approve|create|update|submit|post|record|register/i.test(erp.name)) riskLevel = "medium";

  const displayName = (erp.description ?? erp.name)
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .slice(0, 80);

  existing.push({
    tool_id: "",
    name: erp.name,
    display_name: displayName,
    module: "ERPBridge",
    status: "active_mcp_schema_present",
    description: erp.description ?? erp.name,
    business_capability: "",
    bpi_process_alignment: [],
    endpoint: "",
    http_method: "POST",
    mcp_tool_name: erp.name,
    input_schema: erp.inputSchema ?? {},
    required_parameters: [],
    optional_parameters: [],
    allowed_roles: [],
    risk_level: riskLevel,
    is_read_only: isReadOnly,
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
  });
  added++;
  console.log(`  + ${erp.name}`);
}

if (added === 0) {
  console.log("No new tools to add — registry is already up to date.");
} else {
  await writeFile(REGISTRY_PATH, JSON.stringify(existing, null, 2) + "\n", "utf8");
  console.log(`\nAdded ${added} tools. Registry written to:\n  ${REGISTRY_PATH}`);
  console.log("Restart the backend to pick up the new tools.");
}
