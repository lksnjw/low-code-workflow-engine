import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
const root = new URL("../../", import.meta.url);
const origin = "https://workflow-automation-44201.web.app";
const base = "https://asia-south1-workflow-automation-44201.cloudfunctions.net/api/api";
const report = { startedAt: new Date().toISOString(), status: "CHECKING", erpWrites: 0, cases: [] };
const save = () => writeFile(new URL("hosted-verification.json", import.meta.url), JSON.stringify(report, null, 2));
let session;
async function request(path, method = "GET", body, expected = 200) {
  const form = body instanceof FormData;
  const response = await fetch(base + path, { method, signal: AbortSignal.timeout(180000), redirect: "error",
    headers: { Origin: origin, ...(form ? {} : { "Content-Type": "application/json" }), ...(session ? { Authorization: `Bearer ${session.accessToken}` } : {}) },
    ...(body !== undefined ? { body: form ? body : JSON.stringify(body) } : {}) });
  const value = await response.json().catch(() => ({}));
  assert.equal(response.status, expected, `${method} ${path}: HTTP ${response.status}, ${value.meta?.code ?? ""}`);
  return value.data ?? value;
}
async function check(name, work) {
  try { report.cases.push({ name, status: "PASS", evidence: await work() }); }
  catch (error) { report.cases.push({ name, status: "FAIL", reason: String(error.message).slice(0, 900) }); }
  await save(); console.log(JSON.stringify(report.cases.at(-1)));
}
try {
  const admin = JSON.parse(await readFile(new URL("ops/deployment/firebase/initial-admin.local.json", root), "utf8"));
  assert.equal(admin.projectId, "workflow-automation-44201");
  session = await request("/auth/login", "POST", { email: admin.email, password: admin.password });
  await check("all stored roles have workflow and document access", async () => {
    const response = await request("/roles"), roles = Array.isArray(response) ? response : response.items;
    assert(roles?.length);
    for (const role of roles) for (const permission of ["workflow:write", "workflow:run_own", "pipeline:upload", "execution:approve"]) assert(role.permissions.includes(permission), `${role.name} lacks ${permission}`);
    return { roles: roles.map(role => ({ id: role.id, name: role.name })), allRequiredPermissionsPresent: true };
  });
  await check("catalog role filter includes the same tools for Client and Platform Admin", async () => {
    const admin = await request("/tools/catalog?role=Platform%20Admin"), client = await request("/tools/catalog?role=Client");
    assert(admin.length > 0); assert.deepEqual(admin.map(tool => tool.tool_id).sort(), client.map(tool => tool.tool_id).sort());
    for (const name of ["get_customer_group", "get_territory", "create_customer"]) assert(admin.some(tool => tool.name.includes(name)), `Missing ${name}`);
    assert(admin.every(tool => tool.input_schema?.type === "object"));
    return { toolCount: admin.length, sameCatalog: true, inputSchemasPresent: true };
  });
  await check("saved customer draft uses reviewed runtime fields and real tools", async () => {
    const ready = await request("/workflows/wf_1722_21d0216c/readiness");
    report.readiness = { validation: ready.validation, issues: ready.issues, bridge: ready.bridge, compilation: ready.compilation, published: ready.published, authoring: ready.authoring };
    assert(ready.validation.passed); assert.equal(ready.bridge, "discovery_available"); assert.deepEqual(ready.issues, []);
    return { version: ready.version, published: ready.published, operationAdmission: ready.operation_job_admission, issues: ready.issues };
  });
  if (process.argv.includes("--ocr")) {
    const chat = await request("/chat/sessions", "POST", { title: "Reusable OCR workflow release check", idempotencyKey: `ocr-release-${randomUUID()}` }, 201);
    report.chatId = chat.id;
    const models = await request("/chat/models");
    report.model = models.binding?.model;
    for (const filename of ["customer-registration-complete.png", "customer-registration-complete.pdf"]) await check(`real document preparation: ${filename}`, async () => {
      const path = new URL(`tmp/gemini-demo-20261017/samples/${filename}`, root);
      const form = new FormData(); form.append("file", new Blob([await readFile(path)]), filename);
      form.append("idempotency_key", randomUUID());
      form.append("instruction", "Read this fictional customer registration. Return customer_name, customer_type, customer_group and territory exactly as shown. Do not invent missing fields or perform ERP actions.");
      if (models.binding?.model) form.append("model", models.binding.model);
      form.append("save_to_conversation", "true");
      const result = await request(`/chat/sessions/${chat.id}/attachments/prepare`, "POST", form);
      const fields = result.attachment?.fields; assert(fields?.customer_name); assert.equal(fields.territory, "Sri Lanka");
      assert.equal(fields.customer_group, "Demo Customer Group");
      return { filename, fields, storage: result.attachment.storage, uploadId: result.attachment.uploadId, reviewAvailable: result.attachment.reviewAvailable,
        pipelineStorageConfirmed: result.pipelineStorageConfirmed, vectorIndexConfirmed: result.vectorIndexConfirmed };
    });
  }
  await check("hosted frontend equals the verified release artifact", async () => {
    const response = await fetch(origin + "/", { signal: AbortSignal.timeout(30000) }); assert.equal(response.status, 200);
    assert.equal(await response.text(), await readFile(new URL("frontend/.hosting/public/index.html", root), "utf8"));
    return { artifactMatched: true };
  });
} finally {
  if (session) try { await request("/auth/logout", "POST", { refreshToken: session.refreshToken }); } catch { report.logoutConfirmed = false; }
  report.status = report.cases.some(value => value.status === "FAIL") ? "NEEDS_ATTENTION" : "PASSED";
  report.finishedAt = new Date().toISOString(); await save(); console.log(JSON.stringify({ status: report.status, cases: report.cases.length, erpWrites: report.erpWrites }));
}
