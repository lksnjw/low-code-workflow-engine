import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { deployedQaClient, apiBase, origin } from "../../ops/deployment/firebase/deployed-qa-client.mjs";
const qa = await deployedQaClient(), report = { startedAt: new Date().toISOString(), status: "RUNNING", cases: [], erpWrites: 0, syntheticUserDeleted: false };
const save = () => writeFile(new URL("roles-verification.json", import.meta.url), JSON.stringify(report, null, 2));
const email = `lcwe-role-check-${randomUUID()}@example.test`, password = randomBytes(30).toString("base64url");
let actor, userSession;
async function request(path, method = "GET", body, expected = 200) {
  const response = await fetch(apiBase + path, { method, signal: AbortSignal.timeout(90000), redirect: "error",
    headers: { Origin: origin, "Content-Type": "application/json", ...(userSession ? { Authorization: `Bearer ${userSession.accessToken}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const value = await response.json().catch(() => ({})); assert.equal(response.status, expected, `${method} ${path}: HTTP ${response.status} ${value.meta?.code ?? ""}`);
  return value.data;
}
try {
  const roles = (await qa.request("/roles")).data;
  const baseline = (await qa.request("/tools/catalog")).data.map(tool => tool.tool_id).sort(); assert(baseline.length > 0);
  const source = (await qa.request("/workflows/wf_1722_21d0216c/yaml")).data.yaml; assert(source);
  actor = (await qa.request("/users", "POST", { name: "Disposable role verification", email, password, roleId: "role_client" }, 201)).data;
  for (const role of roles.filter(value => value.id !== "role_admin")) {
    await qa.request(`/users/${actor.id}/role`, "PUT", { roleId: role.id });
    userSession = await request("/auth/login", "POST", { email, password });
    const catalog = await request("/tools/catalog"); assert.deepEqual(catalog.map(tool => tool.tool_id).sort(), baseline);
    const chat = await request("/chat/sessions", "POST", { title: `Role access verification: ${role.name}`, idempotencyKey: randomUUID() }, 201); assert(chat.id);
    const models = await request("/chat/models"); assert(models.configured);
    const library = await request("/pipeline/v1/library/catalog"); assert(library);
    const workflow = await request("/workflows", "POST", { name: `Disposable ${role.name} workflow verification`, yaml: source }, 201);
    const publication = await request(`/workflows/${workflow.id}/publish`, "POST", {}); assert(publication.version);
    const ready = await request(`/workflows/${workflow.id}/readiness`); assert(ready.can_attempt_run); assert.deepEqual(ready.issues, []);
    await request(`/workflows/${workflow.id}/archive`, "POST", {});
    await request("/auth/logout", "POST", { refreshToken: userSession.refreshToken }); userSession = undefined;
    report.cases.push({ role: role.name, toolCount: catalog.length, chat: "PASS", documentCatalog: "PASS", createPublishAndReadiness: "PASS", workflowId: workflow.id, archived: true });
    await save(); console.log(JSON.stringify(report.cases.at(-1)));
  }
  report.status = "PASSED";
} catch (error) { report.status = "FAILED"; report.reason = String(error.message).slice(0, 1000); process.exitCode = 1; }
finally {
  if (actor) { await qa.request(`/users/${actor.id}`, "DELETE"); report.syntheticUserDeleted = true; }
  await qa.close(); await save(); console.log(JSON.stringify({ status: report.status, syntheticUserDeleted: report.syntheticUserDeleted, reason: report.reason }));
}
