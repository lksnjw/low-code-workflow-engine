import { afterEach, expect, test, vi } from "vitest";
import type { FastifyReply, FastifyRequest } from "fastify";
import { Repository } from "../src/repository/store.js";
import { loadConfig } from "../src/config/config.js";
import { handleChatDocumentRoute } from "../src/http/handlers/chat-documents.js";
import { routeTable } from "../src/http/generated-routes.js";
import type { HandlerServices } from "../src/http/handlers/common.js";
afterEach(() => vi.unstubAllGlobals());
const route = (suffix: string) => routeTable.find(r => r.method === "POST" && r.path === `/api/pipeline/v1/library/${suffix}`)!;
const reply = { header: vi.fn(), send: (v: unknown) => v } as unknown as FastifyReply;
async function fixture() {
  const repository = new Repository(); await repository.mutate(s => { s.users.reader = { id: "reader", name: "Reader", email: "reader@example.test", roleId: "role_admin", status: "Active", initials: "R", permissionOverrides: [], departmentId: null, createdAt: "", lastLoginAt: null }; s.roles.role_admin!.permissions = ["chat:use"]; });
  return { user: (await repository.effectiveUser("reader"))!, services: { repository, config: loadConfig({ APP_ENV: "test", PIPELINE_API_BASE_URL: "http://pipeline.test", PIPELINE_API_KEY: "private-key" }) } as HandlerServices };
}
test("reader search uses backend-signed read-only scope without upload permissions", async () => {
  const { services, user } = await fixture(); const transport = vi.fn(async () => Response.json({ items: [], count: 0 })); vi.stubGlobal("fetch", transport);
  await handleChatDocumentRoute(route("search"), { body: { query: "  customer ref  " } } as FastifyRequest, reply, user, services);
  const [url, init] = transport.mock.calls[0]! as unknown as [string, RequestInit]; expect(String(url)).toBe("http://pipeline.test/v1/library/search");
  expect(JSON.parse(String(init.body))).toEqual({ query: "customer ref", limit: 10 });
  const scope = JSON.parse(Buffer.from((init.headers as Record<string,string>)["X-Library-Scope"]!.split(".")[0]!, "base64url").toString());
  expect(scope).toMatchObject({ actorId: "reader", readOnly: true, canManage: false, canUpload: false });
});
test.each([{ query: "x", access_token: "forged" }, { query: "x", collection: "policy_docs" }, { query: "x", limit: 100 }, { query: " " }])("search cannot choose server scope: %j", async body => {
  const { services, user } = await fixture(), transport = vi.fn(); vi.stubGlobal("fetch", transport);
  await expect(handleChatDocumentRoute(route("search"), { body } as FastifyRequest, reply, user, services)).rejects.toMatchObject({ status: 422 }); expect(transport).not.toHaveBeenCalled();
});
test("mismatched document identity is not shown", async () => {
  const { services, user } = await fixture(); vi.stubGlobal("fetch", vi.fn(async () => Response.json({ document_id: "other" })));
  await expect(handleChatDocumentRoute(route("resolve"), { body: { document_id: "wanted" } } as FastifyRequest, reply, user, services)).rejects.toMatchObject({ status: 502 });
});
test("revocation during search suppresses results", async () => {
  const { services, user } = await fixture(); vi.stubGlobal("fetch", vi.fn(async () => { await services.repository.mutate(s => { s.users.reader!.status = "Suspended"; }); return Response.json({ items: [{ document_id: "private" }] }); }));
  await expect(handleChatDocumentRoute(route("search"), { body: { query: "x" } } as FastifyRequest, reply, user, services)).rejects.toMatchObject({ status: 403 });
});
