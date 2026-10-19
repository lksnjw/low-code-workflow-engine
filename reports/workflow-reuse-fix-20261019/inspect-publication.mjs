import { deployedQaClient } from "../../ops/deployment/firebase/deployed-qa-client.mjs";
const qa = await deployedQaClient();
try {
  console.log(JSON.stringify({ readiness: (await qa.request("/workflows/wf_1722_21d0216c/readiness")).data }));
  console.log(JSON.stringify({ publication: await qa.request("/workflows/wf_1722_21d0216c/publish", "POST", {}, 422) }));
} finally { await qa.close(); }
