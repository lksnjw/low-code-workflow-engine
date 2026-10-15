import { afterEach, expect, test, vi } from "vitest";
import type { FastifyReply, FastifyRequest } from "fastify";
import { Repository } from "../src/repository/store.js";
import { loadConfig } from "../src/config/config.js";
import { handleRagPolicyRoute } from "../src/http/handlers/rag-policy.js";
import { routeTable } from "../src/http/generated-routes.js";
import { routePolicy } from "../src/http/route-policy.js";
import type { HandlerServices } from "../src/http/handlers/common.js";

afterEach(() => vi.unstubAllGlobals());
const health = { status: "ok", policy_collection: "policy_docs", policy_chunks: 21, embed_model: "model", embed_dimension: 3072, fail_closed: true, api_key: "must-not-be-returned" };
const actions = { registry_version: "0.2.0", actions: [{ name: "approve_invoice", description: "Approve an invoice", risk: "high", parameters: { type: "object" } }] };
const route = (method: string) => routeTable.find(item => item.path === `/api/settings/rag-policy${method === "POST" ? "/test" : ""}`)!;
const response = { header: vi.fn(), send: (value: unknown) => value } as unknown as FastifyReply;
async function fixture() {
  const repository = new Repository(); await repository.mutate(state => {
    state.users.admin = { id: "admin", name: "Administrator", email: "admin@example.test", roleId: "role_admin", status: "Active", initials: "A", permissionOverrides: [], departmentId: null, lastLoginAt: null, createdAt: "" };
  });
  return { user: (await repository.effectiveUser("admin"))!, services: { repository, config: loadConfig({ APP_ENV: "test", RAG_POLICY_API_BASE_URL: "https://rag.example.test", RAG_POLICY_API_KEY: "private-fixture-key" }) } as HandlerServices };
}
test("console routes require settings permission", () => {
  expect(routePolicy(route("GET"))).toEqual({ required: ["settings:manage"], any: false });
  expect(routePolicy(route("POST"))).toEqual({ required: ["settings:manage"], any: false });
});
test("RAG console returns health and exact action coverage but no keys or import claim", async () => {
  const { services, user } = await fixture(); const transport = vi.fn<typeof fetch>(async url => Response.json(String(url).endsWith("/health") ? health : actions)); vi.stubGlobal("fetch", transport);
  const result = await handleRagPolicyRoute(route("GET"), {} as FastifyRequest, response, user, services);
  expect(result).toMatchObject({ data: { state: "CONNECTED", policyImportAvailable: false, actions: [{ name: "approve_invoice" }], executionPerformed: false } });
  expect(JSON.stringify(result)).not.toMatch(/private-fixture-key|must-not-be-returned/); expect(transport).toHaveBeenCalledTimes(2);
});
test.each([{ prompt: "read policies", actor: { role: "admin" } }, { prompt: "" }, { prompt: "x".repeat(2001) }, { prompt: "test", apiKey: "spoof" }])("actor and credential input is rejected: %j", async body => {
  const { services, user } = await fixture(), transport = vi.fn(); vi.stubGlobal("fetch", transport);
  await expect(handleRagPolicyRoute(route("POST"), { body } as FastifyRequest, response, user, services)).rejects.toMatchObject({ status: 422 }); expect(transport).not.toHaveBeenCalled();
});
test("policy tests derive the actor and never execute the returned action", async () => {
  const { services, user } = await fixture(); const transport = vi.fn<typeof fetch>(async () => Response.json({ request_id: "test-1", request_type: "action", decision: "review", reason: "Missing approval", conditions: [{ field: "approval", satisfied: false }], citations: [{ policy_id: "POL-1" }], retrieval: { total_unique: 1 }, action: { name: "approve_invoice" } })); vi.stubGlobal("fetch", transport);
  const result = await handleRagPolicyRoute(route("POST"), { body: { prompt: "Approve invoice INV-1" } } as FastifyRequest, response, user, services);
  expect(result).toMatchObject({ data: { decision: "review", executionPerformed: false, actor: { id: "admin", role: "Platform Admin" } } });
  expect(JSON.parse(String(transport.mock.calls[0]![1]!.body)).actor).toEqual({ user_id: "admin", role: "Platform Admin" }); expect(transport).toHaveBeenCalledOnce();
});
test("revoked administrator cannot inspect or evaluate policy", async () => {
  const { services, user } = await fixture(), transport = vi.fn(); vi.stubGlobal("fetch", transport);
  await services.repository.mutate(state => { state.roles.role_admin!.permissions = []; });
  await expect(handleRagPolicyRoute(route("GET"), {} as FastifyRequest, response, user, services)).rejects.toMatchObject({ status: 403 }); expect(transport).not.toHaveBeenCalled();
});
test("missing service configuration is explicit, not connected or imported", async () => {
  const { services, user } = await fixture(); services.config.ragPolicyAPIKey = "";
  expect(await handleRagPolicyRoute(route("GET"), {} as FastifyRequest, response, user, services)).toMatchObject({ data: { configured: false, state: "UNCONFIGURED", policyImportAvailable: false } });
});
