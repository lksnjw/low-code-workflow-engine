import { writeFile } from "node:fs/promises";
import { deployedQaClient } from "../../ops/deployment/firebase/deployed-qa-client.mjs";
const qa = await deployedQaClient();
try {
  const caps = (await qa.request("/registry/capabilities?connectionId=erpbridge-default&limit=10")).data;
  for (let offset = 10; caps.hasMoreCapabilities && offset < 500; offset += 10) {
    const next = (await qa.request(`/registry/capabilities?connectionId=erpbridge-default&limit=10&offset=${offset}`)).data;
    caps.capabilities.push(...next.capabilities); caps.hasMoreCapabilities = next.hasMoreCapabilities;
  }
  const tools = (await qa.request("/tools/catalog")).data;
  const report = { checkedAt: new Date().toISOString(), connection: caps.connection, toolCatalogShape: Array.isArray(tools) ? "array" : Object.keys(tools), toolCount: tools.length,
    capabilities: caps.capabilities.map(value => ({ name: value.revision?.definition?.mcp_tool_name ?? value.observation?.mcpToolName,
      state: value.effectiveState, reason: value.reviewReason, remoteMatches: value.observation?.remoteMatches, admitted: value.admission?.state,
      imported: value.revision?.definition?.connection_id, policy: value.revision?.policy })) };
  await writeFile(new URL("capabilities-verification.json", import.meta.url), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, capabilities: report.capabilities.filter(value => /customer|territory/.test(value.name ?? "")),
    states: report.capabilities.reduce((counts, value) => { const key = `${value.state}:${value.reason}`; counts[key] = (counts[key] ?? 0) + 1; return counts; }, {}) }));
} finally { await qa.close(); }
