import { writeFile } from "node:fs/promises";
import { deployedQaClient } from "../../ops/deployment/firebase/deployed-qa-client.mjs";
const qa = await deployedQaClient();
try {
  const inventory = (await qa.request("/registry/tools?source=erpbridge&limit=all")).data;
  const selected = inventory.tools.filter(tool => /^(?:create_customer|create_item|delete_|cancel_|update_)/.test(tool.name));
  const tools = [];
  for (const tool of selected) tools.push((await qa.request(`/registry/tools?source=erpbridge&toolName=${encodeURIComponent(tool.name)}`)).data.tool);
  const report = { checkedAt: new Date().toISOString(), count: inventory.total, inventory: inventory.tools, selectedSchemas: tools };
  await writeFile(new URL("full-catalog-verification.json", import.meta.url), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ count: inventory.total, changes: inventory.tools.filter(tool => tool.effect === "CHANGE_OR_OTHER").length,
    selectedSchemas: tools.map(tool => ({ name: tool.name, inputSchema: tool.inputSchema, outputSchema: tool.outputSchema, annotations: tool.annotations })) }));
} finally { await qa.close(); }
