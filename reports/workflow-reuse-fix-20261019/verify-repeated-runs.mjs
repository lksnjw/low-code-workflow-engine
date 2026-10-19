import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { deployedQaClient } from "../../ops/deployment/firebase/deployed-qa-client.mjs";
const qa = await deployedQaClient(), id = "wf_1722_21d0216c";
const report = { startedAt: new Date().toISOString(), workflowId: id, status: "RUNNING", erpWrites: 0, runs: [] };
const save = () => writeFile(new URL("repeated-runs-verification.json", import.meta.url), JSON.stringify(report, null, 2));
try {
  const ready = (await qa.request(`/workflows/${id}/readiness`)).data;
  assert(ready.validation.passed); assert.deepEqual(ready.issues, []);
  const publication = (await qa.request(`/workflows/${id}/publish`, "POST", { versionNote: "Reviewed reusable customer inputs and exact current tool bindings; policy and human transaction approval remain required." })).data;
  report.publishedVersion = publication.version; await save();
  for (const source of ["IMAGE", "PDF"]) {
    const input = { customer_name: `LCWE OCR RELEASE REVIEW ${source} ${Date.now()}`, customer_type: "Company", customer_group: "Demo Customer Group", territory: "Sri Lanka" };
    const receipt = (await qa.request(`/workflows/${id}/run`, "POST", { mode: "async-operation", idempotencyKey: randomUUID(), input }, 202)).data;
    const row = { id: receipt.id, source, input, status: receipt.status }; report.runs.push(row); await save();
    const deadline = Date.now() + 180000;
    let execution;
    do {
      execution = (await qa.request(`/executions/${receipt.id}?view=approval`)).data;
      if (["AWAITING_APPROVAL", "FAILED", "CANCELLED", "RECOVERY_REQUIRED", "DONE"].includes(execution.status)) break;
      await new Promise(resolve => setTimeout(resolve, 1500));
    } while (Date.now() < deadline);
    row.status = execution.status; row.failure = execution.failure; row.approval = execution.runtimeApproval;
    row.timeline = execution.timeline?.map(step => ({ nodeId: step.nodeId ?? step.id, status: step.status })); await save();
    assert.equal(execution.status, "AWAITING_APPROVAL");
    assert.equal(execution.runtimeApproval.state, "PENDING");
    assert.deepEqual(execution.runtimeApproval.arguments, input);
    const cancellation = await qa.request(`/executions/${receipt.id}/cancel`, "POST", {}, 200);
    row.cancelledAfterReview = Boolean(cancellation); await save();
    const next = (await qa.request(`/workflows/${id}/readiness`)).data;
    assert.equal(next.version, report.publishedVersion); assert(next.can_attempt_run); assert.deepEqual(next.issues, []);
  }
  assert.notEqual(report.runs[0].id, report.runs[1].id);
  assert.notEqual(report.runs[0].approval.id, report.runs[1].approval.id);
  report.status = "PASSED";
} catch (error) { report.status = "FAILED"; report.reason = String(error.message).slice(0, 1200); process.exitCode = 1; }
finally { await qa.close(); report.finishedAt = new Date().toISOString(); await save(); console.log(JSON.stringify(report)); }
