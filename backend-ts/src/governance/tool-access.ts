import { AsyncLocalStorage } from "node:async_hooks";
import type { Repository } from "../repository/store.js";

export type ToolAccessMode = "configured-roles" | "all-authenticated";
const context = new AsyncLocalStorage<ToolAccessMode>();

/** Workspace-owned access policy, never model/tool/user-payload authority.
 * Authentication, account status, ownership, schema checks, business policy
 * and exact transaction approval are enforced separately. Immutable tool
 * contracts and publication pins are not rewritten to grant shared access. */
export function withToolAccess<T>(mode: ToolAccessMode | undefined, work: () => T): T {
  return context.run(mode ?? "configured-roles", work);
}
export function allRolesToolAccess(): boolean { return context.getStore() === "all-authenticated"; }
export function toolRoleAllowed(allowed: readonly string[], role: string): boolean {
  if (!role.trim()) return false;
  if (allRolesToolAccess()) return true;
  return allowed.includes(role);
}

const sharedWorkflowPermissions = ["chat:use", "workflow:write", "workflow:read_own", "workflow:run_own", "execution:read_own", "execution:approve", "pipeline:upload", "registry:read"];
/** Explicit workspace configuration grants workflow use to each real stored
 * role, without impersonating an administrator or exposing another user's
 * chats, credentials, settings or workflows. Changes are audited once. */
export async function ensureSharedWorkflowAccess(repository: Repository, mode: ToolAccessMode | undefined): Promise<void> {
  if (mode !== "all-authenticated") return;
  const needsUpdate = await repository.readAuthoritative(state => Object.values(state.roles).some(role => sharedWorkflowPermissions.some(permission => !role.permissions.includes(permission))));
  if (!needsUpdate) return;
  await repository.mutate(state => {
    for (const role of Object.values(state.roles)) {
      const added = sharedWorkflowPermissions.filter(permission => !role.permissions.includes(permission));
      if (!added.length) continue;
      role.permissions = [...new Set([...role.permissions, ...added])];
      state.auditLogs.push({ id: `shared-tool-access-${crypto.randomUUID()}`, actor: { id: "workspace-configuration", name: "Workspace configuration" },
        action: "role.shared_workflow_access.enabled", resource: { type: "role", id: role.id },
        after: { mode, addedPermissions: added }, createdAt: new Date().toISOString() });
    }
  });
}
