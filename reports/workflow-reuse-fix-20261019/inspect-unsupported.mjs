import { writeFile } from "node:fs/promises";
import { deployedQaClient } from "../../ops/deployment/firebase/deployed-qa-client.mjs";
const qa = await deployedQaClient();
try {
  const tools = [];
  for (const name of process.argv.slice(2)) tools.push((await qa.request(`/registry/tools?source=erpbridge&toolName=${encodeURIComponent(name)}`)).data.tool);
  await writeFile(new URL("unsupported-contracts.json", import.meta.url), JSON.stringify(tools, null, 2));
  console.log(JSON.stringify(tools));
} finally { await qa.close(); }
