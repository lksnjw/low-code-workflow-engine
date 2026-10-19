import { deployedQaClient } from "../../ops/deployment/firebase/deployed-qa-client.mjs";
const qa = await deployedQaClient();
try {
  const providers = (await qa.request("/providers")).data;
  console.log(JSON.stringify(providers.map(value => ({ id: value.id, name: value.name, active: value.active, model: value.model, egressPolicy: value.egressPolicy }))));
} finally { await qa.close(); }
