import { resolve } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { stringify } from "yaml";
import { loadConfig } from "../src/config/config.js";
import { Repository } from "../src/repository/store.js";
import { RegistryService } from "../src/registry/service.js";
import { discoveredContract } from "../src/registry/discovered-contract.js";
import type { HandlerServices } from "../src/http/handlers/common.js";
import { checkRecordWorkflowPolicy, prepareOperationPolicy } from "../src/governance/record-workflow-policy.js";
import { WORKFLOW_EDIT_SYSTEM_PROMPT, WORKFLOW_DOCUMENT_EDIT_SYSTEM_PROMPT } from "../src/prompts/contracts.js";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
test("natural workflow clarification clears only resolved blockers without erasing mandatory approval", () => {
  expect(WORKFLOW_EDIT_SYSTEM_PROMPT).toContain("Reconcile metadata.unresolved_requirements");
  expect(WORKFLOW_EDIT_SYSTEM_PROMPT).toContain("retain all genuinely unresolved inputs");
  expect(WORKFLOW_EDIT_SYSTEM_PROMPT).toContain("Do not claim automatic duplicate prevention");
  expect(WORKFLOW_EDIT_SYSTEM_PROMPT).toContain("remove runtime approval");
  expect(WORKFLOW_DOCUMENT_EDIT_SYSTEM_PROMPT).toContain("Run dialog supports uploading a new image/PDF/document");
  expect(WORKFLOW_DOCUMENT_EDIT_SYSTEM_PROMPT).toContain("not an executable OCR tool node");
  expect(WORKFLOW_DOCUMENT_EDIT_SYSTEM_PROMPT).toContain("not an earlier message's stale claim");
});
async function fixture() {
  const repository = new Repository(), registries = await RegistryService.load(resolve("tests/fixtures/tools.json"), resolve("tests/fixtures/rules.json"));
  const tool = { ...discoveredContract({ name: "create_customer", inputSchema: { type: "object" }, outputSchema: { type: "object" },
    annotations: { readOnlyHint: false }, _meta: { "toolplane.resourceDigest": "a".repeat(64), "toolplane.resourceVersion": "1.1.0", "toolplane.serving": true } }, "erpbridge-default"),
    allowed_roles: ["Platform Admin"], is_read_only: false, risk_level: "medium" as const, side_effects: ["Create customer"] };
  vi.spyOn(registries, "findTool").mockImplementation(name => name === tool.name ? tool : undefined);
  const original = registries.snapshot(); vi.spyOn(registries, "snapshot").mockReturnValue({ ...original, tools: [...original.tools, tool] });
  await repository.mutate(state => {
    state.users.owner = { id: "owner", name: "Owner", email: "owner@example.test", roleId: "role_admin", status: "Active", permissionOverrides: [], departmentId: null, initials: "O", createdAt: "", lastLoginAt: null };
    state.settings.rbac = { enabled: true, localPolicyAgentEnabled: false };
  });
  const user = (await repository.effectiveUser("owner"))!;
  const config = loadConfig({ APP_ENV: "test", RAG_POLICY_API_BASE_URL: "https://rag.example.test", RAG_POLICY_API_KEY: "synthetic-test-key" });
  const services = { repository, config, registries } as HandlerServices;
  const args = { customer_name: "Lakeview QA", customer_group: "Demo Customer Group", territory: "Sri Lanka" };
  const yaml = (parameters = args) => stringify({ name: "Register customer", description: "Reviewed form", trigger: { type: "manual" }, steps: [{ id: "create", action: tool.name, parameters }] });
  return { services, user, tool, args, yaml };
}
test.each(["allow", "deny", "review"])("fresh literal record proposal preserves RAG %s and records policy evidence", async decision => {
  const f = await fixture(), transport = vi.fn<typeof fetch>(async () => Response.json({ decision, reason: "Record fields checked", conditions: [] })); vi.stubGlobal("fetch", transport);
  expect(await checkRecordWorkflowPolicy(f.services, f.yaml(), { id: f.user.id, role: f.user.role, department: null }, {})).toMatchObject({ outcome: decision });
  const request = JSON.parse(String(transport.mock.calls[0]![1]!.body));
  expect(request.context.arguments).toEqual(f.args); expect(request.actor.user_id).toBe("owner");
  expect((await f.services.repository.snapshot()).auditLogs).toContainEqual(expect.objectContaining({ action: "optional_policy.evaluated", after: { decision, source: "rag" } }));
});
test("unresolved runtime references require a distinct preparation scope, never a fabricated field allow", async () => {
  const f = await fixture(), transport = vi.fn<typeof fetch>(async () => Response.json({ decision: "deny", scope: "record_workflow_preparation", execution_authorized: false, execution_performed: false, reason: "Missing typed inputs" })); vi.stubGlobal("fetch", transport);
  expect(await checkRecordWorkflowPolicy(f.services, f.yaml({ ...f.args, customer_name: "{{input.customer_name}}" }), { id: "owner", role: f.user.role, department: null }, {})).toMatchObject({ outcome: "deny" });
  expect(JSON.parse(String(transport.mock.calls[0]![1]!.body)).context).toMatchObject({ action: "record_workflow_prepare", recordAction: "create_customer", parameters: { customer_name: "{{input.customer_name}}" } });
  transport.mockClear();
  await f.services.repository.mutate(state => { state.settings.rbac = { enabled: false, localPolicyAgentEnabled: false }; });
  expect(await checkRecordWorkflowPolicy(f.services, f.yaml(), { id: "owner", role: f.user.role, department: null }, {})).toBeNull(); expect(transport).not.toHaveBeenCalled();
});

test("a reusable draft preparation response must not claim execution authority", async () => {
  const f = await fixture();
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ decision: "allow", scope: "record_workflow_preparation", execution_authorized: true, execution_performed: false, reason: "Wrong authority" })));
  expect(await checkRecordWorkflowPolicy(f.services, f.yaml({ ...f.args, customer_name: "{{input.customer_name}}" }), { id: "owner", role: f.user.role, department: null }, {})).toMatchObject({ outcome: "deny" });
});
test.each(["deny", "review", "unavailable"])("operation %s cannot produce an approval/dispatch guard", async decision => {
  const f = await fixture(); vi.stubGlobal("fetch", vi.fn(async () => decision === "unavailable" ? new Response("", { status: 503 }) : Response.json({ decision, reason: "Missing customer fields", conditions: [] })));
  await expect(prepareOperationPolicy(f.services, f.user, "create_customer", {}, new AbortController().signal)).rejects.toThrow("stopped by policy");
});
test("guard rejects policy switch or role revocation before dispatch and does not authorize execution", async () => {
  const f = await fixture(); vi.stubGlobal("fetch", vi.fn(async () => Response.json({ decision: "allow", reason: "Valid fields", conditions: [] })));
  const guard = await prepareOperationPolicy(f.services, f.user, "create_customer", f.args, new AbortController().signal);
  expect(await f.services.repository.read(state => guard(state))).toBeUndefined();
  await f.services.repository.mutate(state => { state.settings.rbac = { enabled: false, localPolicyAgentEnabled: false }; });
  await expect(f.services.repository.read(state => guard(state))).rejects.toThrow("authority changed");
});
test("post-approval worker turn asks the service again instead of reusing the earlier allow", async () => {
  const f = await fixture(), transport = vi.fn().mockResolvedValueOnce(Response.json({ decision: "allow", reason: "First check", conditions: [] }))
    .mockResolvedValueOnce(Response.json({ decision: "deny", reason: "Policy changed", conditions: [] })); vi.stubGlobal("fetch", transport);
  await prepareOperationPolicy(f.services, f.user, "create_customer", f.args, new AbortController().signal);
  await expect(prepareOperationPolicy(f.services, f.user, "create_customer", f.args, new AbortController().signal)).rejects.toThrow("Policy changed"); expect(transport).toHaveBeenCalledTimes(2);
});
