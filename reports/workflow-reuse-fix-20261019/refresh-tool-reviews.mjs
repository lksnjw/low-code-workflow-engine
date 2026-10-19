import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { deployedQaClient } from "../../ops/deployment/firebase/deployed-qa-client.mjs";
assert(process.argv.includes("--apply-approved-fix"), "Current unchanged-contract migration must be explicitly selected");
const qa = await deployedQaClient();
const report = { startedAt: new Date().toISOString(), status: "RUNNING", refreshed: [], skipped: [], erpWrites: 0, workflowRuns: 0 };
const save = () => writeFile(new URL("review-refresh.json", import.meta.url), JSON.stringify(report, null, 2));
const original = JSON.parse(await readFile(new URL("capabilities-verification.json", import.meta.url), "utf8"));
const originallyAvailable = new Set(original.capabilities.filter(value => value.admitted === "AVAILABLE").map(value => value.name));
async function reviewedRequest(path, body) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await qa.request(path, "POST", body); }
    catch (error) { if (attempt === 2 || error.status !== 503) throw error; await new Promise(resolve => setTimeout(resolve, 2000)); }
  }
}
try {
  const first = (await qa.request("/registry/capabilities?connectionId=erpbridge-default")).data;
  const before = [...first.capabilities];
  for (let offset = 10, more = first.hasMoreCapabilities; more && offset < 500; offset += 10) {
    const next = (await qa.request(`/registry/capabilities?connectionId=erpbridge-default&offset=${offset}`)).data;
    before.push(...next.capabilities); more = next.hasMoreCapabilities;
  }
  const scan = (await qa.request("/registry/capabilities/discovery?connectionId=erpbridge-default", "POST", {})).data;
  before.sort((a, b) => Number(/^(?:get_customer_group|get_territory|create_customer)$/.test(b.revision?.definition?.mcp_tool_name ?? "")) - Number(/^(?:get_customer_group|get_territory|create_customer)$/.test(a.revision?.definition?.mcp_tool_name ?? "")));
  for (const old of before) {
    const observation = scan.observations.find(value => value.capabilityId === old.capabilityId);
    const policy = old.revision?.policy, name = old.revision?.definition?.mcp_tool_name;
    // Preserve only already-reviewed semantics and policy. Never enable a
    // disabled tool or accept a changed schema/digest as this migration.
    if (old.effectiveState === "AVAILABLE") { report.skipped.push({ name, reason: "Already current" }); continue; }
    if (!originallyAvailable.has(name) || !["AVAILABLE", "BLOCKED"].includes(old.admission?.state) || old.admission?.state === "BLOCKED" && old.admission.reason !== "CONNECTION_CHANGED" || !observation?.remoteMatches || !policy || observation.contractHash !== old.revision.contractHash) {
      report.skipped.push({ name, reason: "Not an unchanged previously available contract" }); await save(); continue;
    }
    const result = (await reviewedRequest(`/registry/capabilities/${encodeURIComponent(old.capabilityId)}/review?connectionId=erpbridge-default`, {
      ...policy, observationId: observation.id, contractHash: observation.contractHash,
      decisionKey: `stable-connection-20261019-${observation.id}`,
      note: "Owner approved reusable workflows and full authenticated-role tool access. One-time review of the identical existing contract on the stable connection configuration. Existing effect, risk, data classification, exact approval and no-retry policy retained. No business operation performed."
    })).data;
    assert.equal(result.admission.state, "AVAILABLE");
    report.refreshed.push({ name, revisionId: result.revision.id, contractHash: observation.contractHash });
    await save(); console.log(JSON.stringify(report.refreshed.at(-1)));
  }
  report.status = "COMPLETED";
} catch (error) { report.status = "FAILED"; report.reason = String(error.message).slice(0, 600); process.exitCode = 1; }
finally { await qa.close(); await save(); }
