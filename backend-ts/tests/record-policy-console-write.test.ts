import { afterEach, expect, test, vi } from "vitest";
import type { FastifyReply, FastifyRequest } from "fastify";
import { Repository } from "../src/repository/store.js";
import { loadConfig } from "../src/config/config.js";
import { handleRagPolicyRoute } from "../src/http/handlers/rag-policy.js";
import { recordPolicyContentHash, recordPolicySchema } from "../src/governance/record-policy-contract.js";
import { routeTable } from "../src/http/generated-routes.js";
import type { HandlerServices } from "../src/http/handlers/common.js";
afterEach(() => vi.unstubAllGlobals());
const policy = recordPolicySchema.parse({ policy_id: "ERP-HASH-001", version: "1.0", title: "Name & <details>", action: "create_customer", kind: "required_fields", required_fields: ["customer_name"], text: "Reviewed සිංහල customer rule & <mandatory> fields." });
const route = routeTable.find(r => r.method === "POST" && r.path === "/api/settings/rag-policy/documents")!;
const reply = { header: vi.fn(), send: (v: unknown) => v } as unknown as FastifyReply;
const request = (body: unknown) => ({ body, headers: {}, ip: "127.0.0.1" }) as FastifyRequest;
async function fixture() {
  const repository = new Repository();
  await repository.mutate(s => { s.users.admin = { id: "admin", name: "Admin", email: "admin@example.test", roleId: "role_admin", status: "Active", initials: "A", permissionOverrides: [], departmentId: null, lastLoginAt: null, createdAt: "" }; });
  return { user: (await repository.effectiveUser("admin"))!, services: { repository, config: loadConfig({ APP_ENV: "test", RAG_POLICY_API_BASE_URL: "https://rag.test", RAG_POLICY_API_KEY: "eval-private", RAG_POLICY_ADMIN_API_KEY: "admin-private" }) } as HandlerServices };
}
test("record-policy content hash matches Python UTF-8 JSON without ERP escaping", () => {
  expect(recordPolicyContentHash(policy)).toBe("d72ab857ed022c7c935af973ab159c550953a1d2be93ea3b5f0a15624bc665be");
});
test("explicit review publishes exact content and requires matching indexed receipt", async () => {
  const { services, user } = await fixture();
  const transport = vi.fn(async () => Response.json({ status: "INDEXED", policy_id: policy.policy_id, version: policy.version, content_hash: recordPolicyContentHash(policy), duplicate: false })); vi.stubGlobal("fetch", transport);
  const result = await handleRagPolicyRoute(route, request({ policy, reviewConfirmed: true }), reply, user, services);
  expect(result).toMatchObject({ data: { status: "INDEXED", executionPerformed: false } });
  expect(transport).toHaveBeenCalledOnce();
  expect(transport.mock.calls[0]).toMatchObject(["https://rag.test/api/policy/documents", { headers: { "X-API-Key": "eval-private", "X-Policy-Admin-Key": "admin-private" } }]);
  expect(JSON.stringify(result)).not.toMatch(/eval-private|admin-private/);
});
test.each([false, undefined])("publication without exact review=%s never dispatches", async reviewConfirmed => {
  const { services, user } = await fixture(), transport = vi.fn(); vi.stubGlobal("fetch", transport);
  await expect(handleRagPolicyRoute(route, { body: { policy, reviewConfirmed } } as FastifyRequest, reply, user, services)).rejects.toMatchObject({ status: 422 });
  expect(transport).not.toHaveBeenCalled();
});
test("evaluation credential alone cannot publish", async () => {
  const { services, user } = await fixture(), transport = vi.fn(); services.config.ragPolicyAdminAPIKey = ""; vi.stubGlobal("fetch", transport);
  await expect(handleRagPolicyRoute(route, { body: { policy, reviewConfirmed: true } } as FastifyRequest, reply, user, services)).rejects.toMatchObject({ status: 503 });
  expect(transport).not.toHaveBeenCalled();
});
test("wrong content receipt is not success and is not retried", async () => {
  const { services, user } = await fixture(); const transport = vi.fn(async () => Response.json({ status: "INDEXED", policy_id: policy.policy_id, version: policy.version, content_hash: "wrong", duplicate: false })); vi.stubGlobal("fetch", transport);
  await expect(handleRagPolicyRoute(route, request({ policy, reviewConfirmed: true }), reply, user, services)).rejects.toMatchObject({ status: 502 });
  expect(transport).toHaveBeenCalledOnce();
});
test("revoked administrator cannot publish", async () => {
  const { services, user } = await fixture(), transport = vi.fn(); vi.stubGlobal("fetch", transport);
  await services.repository.mutate(s => { s.users.admin!.status = "Suspended"; });
  await expect(handleRagPolicyRoute(route, { body: { policy, reviewConfirmed: true } } as FastifyRequest, reply, user, services)).rejects.toMatchObject({ status: 403 });
  expect(transport).not.toHaveBeenCalled();
});
