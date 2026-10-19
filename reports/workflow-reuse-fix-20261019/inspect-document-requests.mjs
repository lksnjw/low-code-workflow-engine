import { createRequire } from "node:module";
const require = createRequire(import.meta.url), root = "C:/Users/LKsnj/AppData/Roaming/npm/node_modules/firebase-tools/lib/";
const auth = require(root + "auth.js"), account = auth.getProjectDefaultAccount(process.cwd());
if (account?.user.email !== "lakshan.b.sanjeewa@gmail.com") throw new Error("Unexpected account");
auth.setActiveAccount({}, account);
const entries = await require(root + "gcp/cloudlogging.js").listEntries("workflow-automation-44201", 'resource.type="cloud_run_revision" AND resource.labels.service_name="api" AND timestamp>="2026-10-19T14:13:00Z" AND httpRequest.requestMethod="POST"', 30, "desc");
console.log(JSON.stringify(entries.map(entry => ({ timestamp: entry.timestamp, status: entry.httpRequest?.status, latency: entry.httpRequest?.latency,
  route: entry.httpRequest?.requestUrl?.includes("/attachments/") ? "attachment preparation" : entry.httpRequest?.requestUrl?.includes("/auth/") ? "authentication" : entry.httpRequest?.requestUrl?.includes("/capabilities/") ? "catalog activation" : "other application command" }))));
