import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { deployedQaClient } from "../../ops/deployment/firebase/deployed-qa-client.mjs";
assert(process.argv.includes("--enable-requested-runtime"), "Explicit requested runtime activation argument required");
const qa = await deployedQaClient();
try {
  const providers = (await qa.request("/providers")).data, current = providers.find(provider => provider.active);
  assert(current); assert.equal(new URL(current.baseUrl).origin, current.egressPolicy.approvedOrigin);
  assert(current.egressPolicy.interactiveDataClasses.includes("restricted"));
  let updated = current;
  if (!current.egressPolicy.runtimeAgentDataClasses.includes("restricted")) {
    updated = (await qa.request(`/providers/${current.id}`, "PUT", { name: current.name, type: current.type, baseUrl: current.baseUrl,
      model: current.model, fallbackModel: current.fallbackModel ?? "", additionalModels: current.additionalModels ?? [], temperature: current.temperature,
      egressPolicy: { approvedOrigin: current.egressPolicy.approvedOrigin, confirmed: true,
        interactiveDataClasses: current.egressPolicy.interactiveDataClasses, runtimeAnalysisDataClasses: current.egressPolicy.runtimeAnalysisDataClasses,
        runtimeAgentDataClasses: [...current.egressPolicy.runtimeAgentDataClasses, "restricted"] } })).data;
  }
  const report = { checkedAt: new Date().toISOString(), providerId: updated.id, model: updated.model, egressPolicy: updated.egressPolicy,
    authorization: "Workspace owner explicitly requested Pi-controlled execution of saved customer form workflows, including checks and tool handling on future runs.", erpWrites: 0 };
  await writeFile(new URL("runtime-model-activation.json", import.meta.url), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} finally { await qa.close(); }
