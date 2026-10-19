import { writeFile } from "node:fs/promises";
import { stagingCloudClient, projectId } from "../../ops/deployment/firebase/staging-cloud-client.mjs";
import { createBridgeProtocolAdapter } from "../../backend-ts/src/tools/erpbridge-protocol-adapter.ts";
import { validateToolSchemaProfile } from "../../backend-ts/src/tools/tool-input-schema.ts";
const cloud = await stagingCloudClient();
const secret = await cloud.request("GET", `https://secretmanager.googleapis.com/v1/projects/${projectId}/secrets/LCWE_RUNTIME_CONFIG/versions/latest:access`);
const config = JSON.parse(Buffer.from(secret.payload.data, "base64").toString("utf8"));
const sdk = createBridgeProtocolAdapter({ baseURL: config.ERPBRIDGE_BASE_URL, token: config.ERPBRIDGE_MCP_TOKEN, timeoutMs: 30000 });
try {
  await sdk.connect(); const tools = await sdk.listTools();
  const report = { checkedAt: new Date().toISOString(), count: tools.length, tools: tools.map(tool => ({ name: tool.name, inputSchema: tool.inputSchema, outputSchema: tool.outputSchema,
    annotations: tool.annotations, version: tool._meta?.["toolplane.resourceVersion"], digest: tool._meta?.["toolplane.resourceDigest"], inputIssues: validateToolSchemaProfile(tool.inputSchema) })) };
  await writeFile(new URL("full-catalog-verification.json", import.meta.url), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ count: tools.length, inputsSupported: report.tools.filter(tool => !tool.inputIssues.length).length,
    outputSchemas: report.tools.filter(tool => tool.outputSchema).length, changes: report.tools.filter(tool => tool.annotations?.readOnlyHint !== true).length,
    deleteTools: report.tools.filter(tool => /delete|cancel|remove/.test(tool.name)).map(tool => ({ ...tool })) }));
} finally { await sdk.close(); }
