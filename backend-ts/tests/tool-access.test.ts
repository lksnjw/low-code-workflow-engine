import { expect, test } from "vitest";
import { loadConfig } from "../src/config/config.js";
import { Repository } from "../src/repository/store.js";
import { allRolesToolAccess, ensureSharedWorkflowAccess, toolRoleAllowed, withToolAccess } from "../src/governance/tool-access.js";
import { createDispatchIdentity } from "../src/tools/registry.js";

test("workspace defaults to full authenticated tool access, with explicit legacy configuration supported", () => {
  expect(loadConfig({})).toMatchObject({ toolAccessMode: "all-authenticated", erpbridgeAdminChatActions: true, erpbridgeAdminEnvironmentAccess: true });
  expect(loadConfig({ APP_ENV: "test" }).toolAccessMode).toBe("configured-roles");
  expect(loadConfig({ TOOL_ACCESS_MODE: "configured-roles" })).toMatchObject({ toolAccessMode: "configured-roles", erpbridgeAdminChatActions: false });
  expect(() => loadConfig({ TOOL_ACCESS_MODE: "arbitrary" })).toThrow();
});

test("full tool access is scoped across concurrent work and retains the real local identity", async () => {
  const check = async (mode: "all-authenticated" | "configured-roles") => withToolAccess(mode, async () => {
    await Promise.resolve();
    expect(allRolesToolAccess()).toBe(mode === "all-authenticated");
    expect(toolRoleAllowed(["Platform Admin"], "Client")).toBe(mode === "all-authenticated");
    expect(toolRoleAllowed(["Platform Admin"], "")).toBe(false);
    return createDispatchIdentity({ id: "actual-client", role: "Client" }, { "Platform Admin": "admin", Client: "client" });
  });
  const [shared, restricted] = await Promise.all([check("all-authenticated"), check("configured-roles")]);
  expect(shared).toEqual({ userId: "actual-client", localRole: "Client", erpbridgeRole: "admin" });
  expect(restricted.erpbridgeRole).toBe("client"); expect(allRolesToolAccess()).toBe(false);
});

test("shared workflow permissions reach existing and newly created roles once without broad settings authority", async () => {
  const repository = new Repository();
  try {
    await ensureSharedWorkflowAccess(repository, "all-authenticated");
    const first = await repository.snapshot();
    for (const role of Object.values(first.roles)) expect(role.permissions).toEqual(expect.arrayContaining(["workflow:write", "pipeline:upload", "workflow:run_own", "execution:approve"]));
    expect(first.roles.role_client!.permissions).not.toContain("settings:manage");
    const count = first.auditLogs.length;
    await ensureSharedWorkflowAccess(repository, "all-authenticated");
    expect((await repository.snapshot()).auditLogs).toHaveLength(count);
    await repository.mutate(state => { state.roles.custom = { id: "custom", name: "Custom role", description: "", permissions: [], createdAt: new Date().toISOString() }; });
    await ensureSharedWorkflowAccess(repository, "all-authenticated");
    const next = await repository.snapshot(); expect(next.roles.custom!.permissions).toContain("workflow:write"); expect(next.auditLogs.length).toBe(count + 1);
    expect(next.roles.custom!.permissions).not.toContain("workflow:read_all");
  } finally { await repository.close(); }
});
