import { writeFile } from "node:fs/promises";
import { stagingCloudClient, projectId } from "../../ops/deployment/firebase/staging-cloud-client.mjs";
import { createBridgeProtocolAdapter } from "../../backend-ts/src/tools/erpbridge-protocol-adapter.ts";
import { validateToolSchemaProfile } from "../../backend-ts/src/tools/tool-input-schema.ts";
const cloud = await stagingCloudClient();
const secret = await cloud.request("GET", `https://secretmanager.googleapis.com/v1/projects/${projectId}/secrets/LCWE_RUNTIME_CONFIG/versions/latest:access`);
const config = JSON.parse(Buffer.from(secret.payload.data, "base64").toString("utf8"));
const sdk = createBridgeProtocolAdapter({ baseURL: config.ERPBRIDGE_BASE_URL, token: config.ERPBRIDGE_MCP_TOKEN, timeoutMs: 30000 });
try {
  await sdk.connect();
  const tools = (await sdk.listTools()).filter(tool => process.argv.slice(2).includes(tool.name));
  const result = tools.map(tool => ({ ...tool, inputIssues: validateToolSchemaProfile(tool.inputSchema), outputIssues: tool.outputSchema ? validateToolSchemaProfile(tool.outputSchema) : ["MISSING"] }));
  await writeFile(new URL("unsupported-contracts.json", import.meta.url), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} catch { process.exitCode = 1; console.error("Exact connected contract discovery could not be confirmed using the system trust store."); }
finally { await sdk.close(); }
