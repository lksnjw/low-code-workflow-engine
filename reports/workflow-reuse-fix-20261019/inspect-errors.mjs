import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url), library = "C:/Users/LKsnj/AppData/Roaming/npm/node_modules/firebase-tools/lib/";
const auth = require(library + "auth.js"), account = auth.getProjectDefaultAccount(process.cwd());
assert.equal(account.user.email, "lakshan.b.sanjeewa@gmail.com"); auth.setActiveAccount({}, account);
const logging = require(library + "gcp/cloudlogging.js");
const entries = await logging.listEntries("workflow-automation-44201", 'resource.type="cloud_run_revision" AND resource.labels.service_name="api" AND (severity>=WARNING OR textPayload:"unconfirmed") AND timestamp>="2026-10-19T13:15:00Z"', 30, "desc");
console.log(JSON.stringify(entries.map(entry => {
  let value = entry.jsonPayload;
  if (!value && entry.textPayload?.includes("Functions invocation unconfirmed")) try { value = JSON.parse(entry.textPayload); } catch {}
  return { timestamp: entry.timestamp, severity: entry.severity, message: value?.message === "Functions invocation unconfirmed" ? value.message : "other server warning",
    phase: value?.phase, authorityReason: value?.authorityReason, status: entry.httpRequest?.status };
})));
