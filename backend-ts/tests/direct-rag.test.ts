import { afterEach, expect, test, vi } from "vitest";
import { loadConfig } from "../src/config/config.js";
import { Repository } from "../src/repository/store.js";
import type { HandlerServices } from "../src/http/handlers/common.js";
import { checkDirectRagPolicy } from "../src/governance/direct-rag.js";
import { evaluateOptionalPolicy } from "../src/governance/optional-policy.js";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
const config = () => loadConfig({ APP_ENV: "test", RAG_POLICY_API_BASE_URL: "https://rag.example.test", RAG_POLICY_API_KEY: "test-private-rag-key" });
const request = { prompt: "Approve invoice INV-1", action: "approve_invoice" };
const actor = { id: "owner", role: "Manager" };
const snapshotReads = ["list_companies", "list_departments", "list_suppliers", "list_item_groups", "list_uoms", "list_items", "list_warehouses", "list_bins", "list_sales_orders", "list_sales_invoices", "list_purchase_orders", "get_item", "get_item_group", "get_uom"];

test("record policy identity comes from the authenticated actor, never prompt/context claims", async () => {
  const transport = vi.fn<typeof fetch>(async () => Response.json({ decision: "deny", request_type: "action", reason: "Not approved", conditions: [] }));
  vi.stubGlobal("fetch", transport);
  await checkDirectRagPolicy(config(), { id: "admin", role: "Platform Admin", roleId: "role_admin" }, { prompt: "Delete this", action: "delete_document", context: { actor: { role_id: "forged" }, arguments: { doctype: "Customer", name: "fixture" } } });
  expect(JSON.parse(String(transport.mock.calls[0]?.[1]?.body)).actor).toEqual({ user_id: "admin", role: "Platform Admin", role_id: "role_admin" });
});
test.each(snapshotReads)("%s snapshot uses only its exact caller-enforced read scope", async action => {
  const transport = vi.fn<typeof fetch>(async url => Response.json(String(url).endsWith("/preflight")
    ? { decision: "allow", scope: "caller_scoped_erp_reference_read", execution_authorized: false, execution_performed: false, reason: "Current reviewed role/token read authority remains required" }
    : { decision: "deny", request_type: "action", reason: "No read scope applies", conditions: [] })); vi.stubGlobal("fetch", transport);
  expect((await checkDirectRagPolicy(config(), actor, { prompt: "Read a bounded reference page", action, context: { readOnly: true } })).decision).toBe("allow");
  expect(transport.mock.calls[0]?.[0]).toBe("https://rag.example.test/api/policy/preflight");
  for (const readOnly of [false, "true", 1, null, undefined]) {
    expect((await checkDirectRagPolicy(config(), actor, { prompt: "Read references", action, context: { readOnly } })).decision).toBe("deny");
    expect(transport.mock.calls.at(-1)?.[0]).toBe("https://rag.example.test/api/policy/evaluate");
  }
});
test.each([
  { scope: "preparation_only", execution_authorized: false, execution_performed: false },
  { scope: "caller_scoped_customer_reference_read", execution_authorized: false, execution_performed: false },
  { scope: "caller_scoped_erp_reference_read", execution_authorized: true, execution_performed: false },
  { scope: "caller_scoped_erp_reference_read", execution_authorized: false, execution_performed: true },
])("snapshot preflight never accepts a different scope or execution authority: %j", async extra => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ decision: "allow", reason: "Read policy", ...extra })));
  expect((await checkDirectRagPolicy(config(), actor, { prompt: "Read company", action: "list_companies", context: { readOnly: true } })).decision).toBe("deny");
});
test.each(["get_employee", "list_employees", "resend-email-send", "update_item", "delete_customer", "list_anything"])("unreviewed action %s never gains snapshot routing", async action => {
  const transport = vi.fn<typeof fetch>(async () => Response.json({ decision: "deny", request_type: "action", reason: "Not covered", conditions: [] })); vi.stubGlobal("fetch", transport);
  expect((await checkDirectRagPolicy(config(), actor, { prompt: "Action", action, context: { readOnly: true } })).decision).toBe("deny");
  expect(transport.mock.calls[0]?.[0]).toBe("https://rag.example.test/api/policy/evaluate");
});
test("RAG document preflight is not disclosure authority or ERP execution permission", async () => {
  const transport = vi.fn<typeof fetch>(async () => Response.json({ decision: "allow", scope: "caller_scoped_document_read", execution_authorized: false, execution_performed: false, reason: "Caller must enforce private document scope" })); vi.stubGlobal("fetch", transport);
  expect((await checkDirectRagPolicy(config(), actor, { prompt: "Read my saved registration", action: "pipeline-library-resolve", context: { readOnly: true, arguments: { document_id: "doc" } } })).decision).toBe("allow");
  expect(transport.mock.calls[0]?.[0]).toBe("https://rag.example.test/api/policy/preflight");
});
test.each(["get_customer", "list_customers", "get_customer_group", "get_territory"])("%s prerequisite check requires an exact read scope and never grants an ERP mutation", async action => {
  const transport = vi.fn<typeof fetch>(async url => Response.json(String(url).endsWith("/preflight")
    ? { decision: "allow", scope: "caller_scoped_customer_reference_read", execution_authorized: false, execution_performed: false, reason: "Current role/token and reviewed read contract remain required" }
    : { decision: "deny", request_type: "action", reason: "No exact read preflight applies", conditions: [] })); vi.stubGlobal("fetch", transport);
  expect((await checkDirectRagPolicy(config(), actor, { prompt: "Check customer references", action, context: { readOnly: true } })).decision).toBe("allow");
  expect(transport.mock.calls[0]?.[0]).toBe("https://rag.example.test/api/policy/preflight");
  expect((await checkDirectRagPolicy(config(), actor, { prompt: "Check customer references", action, context: { readOnly: false } })).decision).toBe("deny");
  expect(transport.mock.calls[1]?.[0]).toBe("https://rag.example.test/api/policy/evaluate");
});
test.each(["create_customer", "create_item", "delete_document", "delete_record"])("%s uses the separate exact record-policy contract", async action => {
  const transport = vi.fn<typeof fetch>(async () => Response.json({ decision: "review", request_type: "action", reason: "Missing fields", conditions: [] })); vi.stubGlobal("fetch", transport);
  expect((await checkDirectRagPolicy(config(), actor, { prompt: "Register this customer", action, context: { arguments: {} } })).decision).toBe("review");
  expect(transport.mock.calls[0]?.[0]).toBe("https://rag.example.test/api/policy/records/evaluate");
});
test.each([false, true])("preparation-only response cannot grant execution=%s", async execution_authorized => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ decision: "allow", scope: "preparation_only", execution_authorized, execution_performed: false, reason: "Draft discussion only" })));
  expect((await checkDirectRagPolicy(config(), actor, { prompt: "Hello", action: "chat_request" })).decision).toBe(execution_authorized ? "deny" : "allow");
});
test.each(["allow", "deny", "review", "allow_with_conditions"])("direct RAG preserves %s without any bridge discovery", async decision => {
  const transport = vi.fn<typeof fetch>(async () => Response.json({ decision, request_type: "action", reason: "Grounded policy decision", conditions: [] })); vi.stubGlobal("fetch", transport);
  const result = await checkDirectRagPolicy(config(), actor, { ...request, context: { actor: { user_id: "attacker", role: "Administrator" } } });
  expect(result).toMatchObject({ source: "rag", decision: decision === "allow_with_conditions" ? "review" : decision });
  expect(transport).toHaveBeenCalledOnce(); const [url, init] = transport.mock.calls[0]!;
  expect(url).toBe("https://rag.example.test/api/policy/evaluate");
  expect(init!.redirect).toBe("error");
  expect(JSON.parse(String(init!.body)).actor).toEqual({ user_id: "owner", role: "Manager" });
  expect(JSON.stringify(result)).not.toContain("test-private-rag-key");
});
test.each([{}, { decision: "allow", allowed: false }, { decision: "allow", request_type: "question" }, { decision: "answer", request_type: "question" }, { decision: "allow", conditions: "none" }])("bad or non-action response is not authorization: %j", async body => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(body)));
  expect((await checkDirectRagPolicy(config(), actor, request)).decision).toBe("deny");
});
test("an allow with unsatisfied conditions remains review", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ decision: "allow", conditions: [{ satisfied: false }] })));
  expect((await checkDirectRagPolicy(config(), actor, request)).decision).toBe("review");
});
test.each([401, 403, 400, 422, 500, 429, 502, 503, 504])("HTTP %s is classified without exposing upstream bodies", async status => {
  const transport = vi.fn(async () => new Response("private upstream detail", { status })); vi.stubGlobal("fetch", transport);
  const result = await checkDirectRagPolicy(config(), actor, request);
  expect(result.decision).toBe([429, 502, 503, 504].includes(status) ? "unavailable" : "deny");
  expect(JSON.stringify(result)).not.toContain("private upstream detail"); expect(transport).toHaveBeenCalledOnce();
});
async function fixture(remote: boolean, local: boolean) {
  const repository = new Repository();
  await repository.mutate(state => {
    state.settings.rbac = { enabled: remote, localPolicyAgentEnabled: local };
    state.users.owner = { id: "owner", name: "Owner", email: "owner@example.test", roleId: "role_admin", status: "Active", permissionOverrides: [], initials: "O", departmentId: null, createdAt: "", lastLoginAt: null };
  });
  const generate = vi.fn(async () => ({ text: '{"decision":"allow","reason":"Local policy permitted this action"}', model: "selected-model" }));
  return { user: (await repository.effectiveUser("owner"))!, generate, services: { config: config(), repository, providerRuntime: { configured: true, generate } } as unknown as HandlerServices };
}
test.each([false, true])("ten-second RAG timeout falls back only when local=%s", async local => {
  const s = await fixture(true, local); let finish: ((value: Response) => void) | undefined;
  const transport = vi.fn<typeof fetch>(() => new Promise(resolve => { finish = resolve; })); vi.stubGlobal("fetch", transport); vi.useFakeTimers();
  const pending = evaluateOptionalPolicy(s.services, s.user, request);
  for (let index = 0; index < 60 && !transport.mock.calls.length; index++) await Promise.resolve();
  await vi.advanceTimersByTimeAsync(9999); expect(s.generate).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); const result = await pending;
  expect(result).toMatchObject(local ? { source: "local_model", decision: "allow", fallbackUsed: true } : { source: "rag", decision: "unavailable" });
  expect(transport).toHaveBeenCalledOnce(); finish!(Response.json({ decision: "allow" })); await Promise.resolve();
});
test.each([401, 403])("authentication failure %s never calls local or bridge", async status => {
  const s = await fixture(true, true); vi.stubGlobal("fetch", vi.fn(async () => new Response("secret", { status })));
  expect(await evaluateOptionalPolicy(s.services, s.user, request)).toMatchObject({ source: "rag", decision: "deny" }); expect(s.generate).not.toHaveBeenCalled();
});
test.each([[false, false], [false, true]])("RAG off remote=%s local=%s makes no remote call", async (remote, local) => {
  const s = await fixture(remote, local), transport = vi.fn(); vi.stubGlobal("fetch", transport);
  expect((await evaluateOptionalPolicy(s.services, s.user, request)).source).toBe(local ? "local_model" : "skipped"); expect(transport).not.toHaveBeenCalled();
});
test("cancellation stops the request without fallback", async () => {
  const controller = new AbortController(); controller.abort(); const transport = vi.fn(); vi.stubGlobal("fetch", transport);
  expect((await checkDirectRagPolicy(config(), actor, { ...request, signal: controller.signal })).decision).toBe("deny"); expect(transport).not.toHaveBeenCalled();
});
test.each([
  { RAG_POLICY_API_BASE_URL: "https://rag.example.test" }, { RAG_POLICY_API_KEY: "test" },
  { RAG_POLICY_API_BASE_URL: "https://rag.example.test/path", RAG_POLICY_API_KEY: "test" },
  { RAG_POLICY_API_BASE_URL: "https://user:pass@rag.example.test", RAG_POLICY_API_KEY: "test" },
])("direct RAG configuration is complete and server-owned: %j", env => {
  expect(() => loadConfig({ APP_ENV: "test", ...env })).toThrow(/RAG_POLICY/);
});
