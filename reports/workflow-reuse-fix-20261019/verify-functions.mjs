import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { stagingCloudClient, projectId, projectNumber, region } from "../../ops/deployment/firebase/staging-cloud-client.mjs";
const cloud = await stagingCloudClient(), parent = `projects/${projectId}/locations/${region}`;
const report = { checkedAt: new Date().toISOString(), functions: [], mutations: 0, status: "CHECKING" };
for (const name of ["api", "executeChatTask", "executeReadTask", "executeOperationTask", "executeReadbackTask", "recoverReadTaskDispatch", "advanceWorkflowLifecycle"]) {
  const fn = await cloud.request("GET", `https://cloudfunctions.googleapis.com/v2/${parent}/functions/${name}`);
  const row = { name, state: fn.state, revision: fn.serviceConfig.revision, updateTime: fn.updateTime, sourceHash: fn.labels?.["firebase-functions-hash"] };
  assert.equal(row.state, "ACTIVE"); assert(row.sourceHash);
  if (name.startsWith("execute")) {
    const policy = await cloud.request("GET", `https://run.googleapis.com/v2/${fn.serviceConfig.service}:getIamPolicy`);
    const service = await cloud.request("GET", `https://run.googleapis.com/v2/${fn.serviceConfig.service}`);
    const member = `serviceAccount:${projectNumber}-compute@developer.gserviceaccount.com`;
    row.private = !(policy.bindings ?? []).some(binding => binding.role === "roles/run.invoker" && (binding.members ?? []).some(member => ["allUsers", "allAuthenticatedUsers"].includes(member)));
    row.iamChecksEnabled = service.invokerIamDisabled !== true;
    row.runtimeCanInvoke = (policy.bindings ?? []).some(binding => binding.role === "roles/run.invoker" && !binding.condition && (binding.members ?? []).includes(member));
    const queue = await cloud.request("POST", `https://cloudtasks.googleapis.com/v2/${parent}/queues/${name}:getIamPolicy`, {});
    row.runtimeCanEnqueue = (queue.bindings ?? []).some(binding => binding.role === "roles/cloudtasks.enqueuer" && !binding.condition && (binding.members ?? []).includes(member));
    assert(row.private); assert(row.iamChecksEnabled); assert(row.runtimeCanInvoke); assert(row.runtimeCanEnqueue);
  }
  report.functions.push(row);
}
assert.equal(new Set(report.functions.map(row => row.sourceHash)).size, 1);
report.status = "PASSED";
await writeFile(new URL("functions-verification.json", import.meta.url), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
