import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { deployedQaClient } from "../../ops/deployment/firebase/deployed-qa-client.mjs";
const qa = await deployedQaClient();
const report = { startedAt: new Date().toISOString(), status: "RUNNING", erpWrites: 0 };
try {
  const snapshot = (await qa.request("/registry/tools?source=erpbridge&limit=all")).data;
  assert.equal(snapshot.total, 163); assert.match(snapshot.catalogHash ?? "", /^sha256:[a-f0-9]{64}$/);
  const body = { profile: "workspace-full-tool-access/v1", catalogHash: snapshot.catalogHash, decisionKey: "owner-full-catalog-20261019-v1", confirmed: true,
    note: "The workspace owner explicitly requested full tool access for every role, including create, update and delete, and approved this preview deployment. Enable the exact current connected catalog. All input validation, business policy checks, fresh exact human approval for mutations, ownership checks and no-replay handling remain enforced. No ERP business action is performed by activation." };
  const previous = process.argv.includes("--resume-last") ? JSON.parse(await readFile(new URL("full-catalog-activation.json", import.meta.url), "utf8")) : null;
  report.pages = previous?.pages ?? []; const tools = [], unsupported = [];
  const previousCount = report.pages.reduce((sum, page) => sum + page.admitted, 0);
  let offset = previous ? report.pages.at(-1).offset + 10 : 0;
  do {
    let result;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { result = (await qa.request("/registry/capabilities/import?connectionId=erpbridge-default", "POST", { ...body, offset, limit: previous ? 1 : 10 })).data; break; }
      catch (error) { if (error.status !== 503 || attempt === 2) throw error; }
    }
    tools.push(...result.tools); unsupported.push(...result.unsupported); assert.equal(result.erpToolsDispatched, 0);
    report.pages.push({ offset, admitted: result.admittedCount, unsupported: result.unsupported });
    console.log(JSON.stringify(report.pages.at(-1))); await writeFile(new URL("full-catalog-activation.json", import.meta.url), JSON.stringify(report, null, 2));
    offset = result.nextOffset;
  } while (offset !== null);
  report.result = { catalogCount: snapshot.total, admittedCount: previousCount + tools.length, tools, unsupported };
  assert.equal(previousCount + tools.length, snapshot.total); assert.equal(unsupported.length, 0);
  report.status = "PASSED";
} catch (error) { report.status = "FAILED"; report.reason = String(error.message).slice(0, 1000); process.exitCode = 1; }
finally { await qa.close(); await writeFile(new URL("full-catalog-activation.json", import.meta.url), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); }
