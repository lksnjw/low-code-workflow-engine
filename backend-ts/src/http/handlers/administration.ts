import { createHash, randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { hashPassword } from "../../authn/password.js";
import { notificationPreferencesSchema } from "../../models/boundary.js";
import { fail, ok } from "../../models/schemas.js";
import { withoutSecretFields } from "../../redact/secrets.js";
import type { RouteDefinition } from "../generated-routes.js";
import { appendAudit, bodyRecord, HandlerFailure, type CurrentUser, type HandlerServices, initials, isRecord, nextID, now, paginate, publicUser, queryRecord, requestParam, stringValue } from "./common.js";

export const ADMIN_UNHANDLED = Symbol("admin-unhandled");
const builtInRoleIDs = new Set(["role_admin", "role_system_admin", "role_builder", "role_client"]);

/*******************************************************************************
 * Function: handleAdministrationRoute
 *
 * Dispatches user, role, profile, settings, and administration requests.
 ******************************************************************************/
export async function handleAdministrationRoute(route: RouteDefinition, request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown | typeof ADMIN_UNHANDLED> {
  const base = services.config.apiBasePath;
  try {
    if (route.path === `${base}/users` && route.method === "GET") return listUsers(request, reply, services);
    if (route.path === `${base}/users` && route.method === "POST") return createUser(request, reply, user, services);
    if (route.path === `${base}/users/:id` && route.method === "GET") return getUser(request, reply, services);
    if (route.path === `${base}/users/:id` && route.method === "PATCH") return updateUser(request, reply, user, services);
    if (route.path === `${base}/users/:id/role`) return updateUserField(request, reply, user, services, "roleId");
    if (route.path === `${base}/users/:id/status`) return updateUserField(request, reply, user, services, "status");
    if (route.path === `${base}/users/:id/activate`) return setUserStatus(request, reply, user, services, "Active", "User activated");
    if (route.path === `${base}/users/:id/suspend`) return setUserStatus(request, reply, user, services, "Suspended", "User suspended");
    if (route.path === `${base}/users/:id` && route.method === "DELETE") return deleteUser(request, reply, user, services);
    if (route.path === `${base}/roles` && route.method === "GET") return reply.send(ok(await services.repository.read((state) => Object.values(state.roles)), "OK", null));
    if (route.path === `${base}/roles` && route.method === "POST") return createRole(request, reply, user, services);
    if (route.path === `${base}/roles/:id` && route.method === "GET") return getRole(request, reply, services);
    if (route.path === `${base}/roles/:id` && (route.method === "PUT" || route.method === "PATCH")) return updateRole(request, reply, user, services);
    if (route.path === `${base}/roles/:id` && route.method === "DELETE") return deleteRole(request, reply, user, services);
    if (route.path === `${base}/permissions` && route.method === "GET") return reply.send(ok(await services.repository.read((state) => state.permissions), "OK", null));
    if (route.path === `${base}/permissions/matrix`) return permissionMatrix(reply, services);
    if (route.path === `${base}/audit` && route.method === "GET") return listAudit(request, reply, services);
    if (route.path === `${base}/audit/:id`) return getAudit(request, reply, services);
    if (route.path === `${base}/audit/export`) return exportAudit(request, reply, services);
    if (route.path === `${base}/profile` && route.method === "PATCH") return updateProfile(request, reply, user, services);
    if (route.path === `${base}/profile/notifications` && route.method === "GET") return getNotificationPreferences(reply, user, services);
    if (route.path === `${base}/profile/notifications` && route.method === "PATCH") return updateNotificationPreferences(request, reply, user, services);
    if (route.path === `${base}/profile/api-keys` && route.method === "GET") return listAPIKeys(reply, services);
    if (route.path === `${base}/profile/api-keys` && route.method === "POST") return createAPIKey(request, reply, services);
    if (route.path === `${base}/profile/api-keys/:id` && route.method === "DELETE") return deleteAPIKey(request, reply, services);
    if (route.path === `${base}/settings` && route.method === "GET") return getSettings(reply, services);
    if (route.path === `${base}/settings` && route.method === "PATCH") return patchSettings(request, reply, services);
    if (route.path === `${base}/settings/general` && route.method === "GET") return getSettingsGroup(reply, services, "general");
    if (route.path === `${base}/settings/general` && route.method === "PATCH") return patchSettingsGroup(request, reply, services, "general", "General settings updated");
    if (route.path === `${base}/settings/llm` && route.method === "GET") return getSettingsGroup(reply, services, "llm", true);
    if (route.path === `${base}/settings/llm` && route.method === "PATCH") return patchSettingsGroup(request, reply, services, "llm", "LLM settings updated", true);
    if (route.path === `${base}/settings/rbac` && route.method === "GET") return getSettingsGroup(reply, services, "rbac");
    if (route.path === `${base}/settings/rbac` && route.method === "PATCH") return patchSettingsGroup(request, reply, services, "rbac", "RBAC settings updated");
    if (route.path === `${base}/notifications` && route.method === "GET") return listNotifications(request, reply, services);
    if (route.path === `${base}/notifications/read-all`) return markAllNotifications(reply, services);
    if (route.path === `${base}/notifications/:id/read`) return markNotification(request, reply, services);
    if (route.path === `${base}/notifications/:id` && route.method === "DELETE") return deleteNotification(request, reply, services);
  } catch (error) {
    if (error instanceof HandlerFailure) return reply.status(error.status).send(fail(error.message, error.meta));
    throw error;
  }
  return ADMIN_UNHANDLED;
}

/*******************************************************************************
 * Function: listUsers
 *
 * Returns the user list in its public response shape.
 ******************************************************************************/
async function listUsers(request: FastifyRequest, reply: FastifyReply, services: HandlerServices): Promise<unknown> {
  const query = queryRecord(request); const q = stringValue(query.q).trim().toLowerCase(); const role = stringValue(query.role).trim(); const status = stringValue(query.status).trim().toLowerCase();
  const users = await services.repository.read((state) => Object.values(state.users).filter((item) => (q === "" || item.name.toLowerCase().includes(q) || item.email.toLowerCase().includes(q)) && (role === "" || item.roleId === role) && (status === "" || item.status.toLowerCase() === status)).sort((a, b) => a.name.localeCompare(b.name)).map(publicUser));
  const page = paginate(users, request); return reply.send(ok(page.items, "OK", page.meta));
}

/*******************************************************************************
 * Function: createUser
 *
 * Validates and creates a user with the requested role and permissions.
 ******************************************************************************/
async function createUser(request: FastifyRequest, reply: FastifyReply, actor: CurrentUser, services: HandlerServices): Promise<unknown> {
  const body = bodyRecord(request); if (body === null) throw new HandlerFailure(400, "Invalid request body");
  const name = stringValue(body.name).trim(); const email = stringValue(body.email).trim().toLowerCase(); const password = stringValue(body.password); const roleID = stringValue(body.roleId).trim() === "" ? "role_builder" : stringValue(body.roleId).trim();
  if (name === "" || email === "" || password.length < 8) throw new HandlerFailure(400, "Name, email, and a password of at least 8 characters are required");
  const passwordHash = await hashPassword(password);
  const created = await services.repository.mutate((state) => {
    const role = state.roles[roleID]; if (role === undefined) throw new HandlerFailure(400, "Unknown role");
    if (role.permissions.some((permission) => !actor.permissions.includes(permission))) throw new HandlerFailure(403, "Cannot grant permissions the current user does not hold");
    if (Object.values(state.users).some((item) => item.email.toLowerCase() === email)) throw new HandlerFailure(409, "A user with this email already exists");
    const id = nextID(state, "usr"); const user = { id, name, email, roleId: roleID, permissionOverrides: [], status: "Active", initials: initials(name), departmentId: typeof body.departmentId === "string" ? body.departmentId : null, lastLoginAt: null, createdAt: now() };
    state.users[id] = user; state.passwordHashes[id] = passwordHash; appendAudit(state, actor, "user.created", "user", id, null, publicUser(user), request); appendAudit(state, actor, "user.role_assigned", "user", id, null, { roleId: roleID }, request); return user;
  });
  return reply.status(201).send(ok(publicUser(created), "User created", null));
}

/*******************************************************************************
 * Function: getUser
 *
 * Returns the requested user without its password hash.
 ******************************************************************************/
async function getUser(request: FastifyRequest, reply: FastifyReply, services: HandlerServices): Promise<unknown> { const user = await services.repository.read((state) => state.users[requestParam(request, "id")] ?? null); if (user === null) throw new HandlerFailure(404, "User not found"); return reply.send(ok(publicUser(user), "OK", null)); }

/*******************************************************************************
 * Function: updateUser
 *
 * Updates a user after validating the requested account changes.
 ******************************************************************************/
async function updateUser(request: FastifyRequest, reply: FastifyReply, actor: CurrentUser, services: HandlerServices): Promise<unknown> {
  const body = bodyRecord(request); if (body === null) throw new HandlerFailure(400, "Invalid request body"); const id = requestParam(request, "id");
  const updated = await services.repository.mutate((state) => {
    const target = state.users[id]; if (target === undefined) throw new HandlerFailure(404, "User not found"); const before = publicUser(target);
    if (typeof body.name === "string") { target.name = body.name; target.initials = initials(body.name); }
    if (typeof body.departmentId === "string" || body.departmentId === null) target.departmentId = body.departmentId;
    if (typeof body.roleId === "string") applyRoleChange(state, target, body.roleId, actor);
    if (typeof body.status === "string") applyStatus(target, body.status, actor);
    if (target.status.toLowerCase() !== "active") revokeUserSessions(state, target.id);
    appendAudit(state, actor, "user.updated", "user", id, before, publicUser(target), request); return structuredClone(target);
  });
  return reply.send(ok(publicUser(updated), "User updated", null));
}

/*******************************************************************************
 * Function: updateUserField
 *
 * Applies a supported field update to the requested user.
 ******************************************************************************/
async function updateUserField(request: FastifyRequest, reply: FastifyReply, actor: CurrentUser, services: HandlerServices, field: "roleId" | "status"): Promise<unknown> {
  const body = bodyRecord(request); if (body === null || stringValue(body[field]).trim() === "") throw new HandlerFailure(400, `${field} is required`); request.body = { [field]: body[field] }; return updateUser(request, reply, actor, services);
}

/*******************************************************************************
 * Function: setUserStatus
 *
 * Updates a user's status and applies session-revocation rules.
 ******************************************************************************/
async function setUserStatus(request: FastifyRequest, reply: FastifyReply, actor: CurrentUser, services: HandlerServices, status: string, message: string): Promise<unknown> {
  request.body = { status }; const response = await updateUser(request, reply, actor, services); if (!reply.sent) return response;
  return response;
}

/*******************************************************************************
 * Function: deleteUser
 *
 * Deletes a user while enforcing administrator protection rules.
 ******************************************************************************/
async function deleteUser(request: FastifyRequest, reply: FastifyReply, actor: CurrentUser, services: HandlerServices): Promise<unknown> {
  const id = requestParam(request, "id"); if (id === actor.id) throw new HandlerFailure(403, "You cannot delete your own account");
  await services.repository.mutate((state) => { const target = state.users[id]; if (target === undefined) throw new HandlerFailure(404, "User not found"); if (target.roleId === "role_admin" && activeAdminCount(state) <= 1) throw new HandlerFailure(409, "The last active Platform Admin cannot be deleted"); const before = publicUser(target); delete state.users[id]; delete state.passwordHashes[id]; revokeUserSessions(state, id); appendAudit(state, actor, "user.deleted", "user", id, before, null, request); });
  return reply.send(ok({ deleted: true }, "User deleted", null));
}

/*******************************************************************************
 * Function: createRole
 *
 * Validates permissions and creates a role.
 ******************************************************************************/
async function createRole(request: FastifyRequest, reply: FastifyReply, actor: CurrentUser, services: HandlerServices): Promise<unknown> {
  const body = bodyRecord(request); if (body === null) throw new HandlerFailure(400, "Invalid request body"); const name = stringValue(body.name).trim(); const permissions = stringArray(body.permissions); if (name === "") throw new HandlerFailure(400, "Role name is required");
  const role = await services.repository.mutate((state) => { validatePermissions(state, permissions); if (permissions.some((key) => !actor.permissions.includes(key))) throw new HandlerFailure(403, "Cannot grant permissions the current user does not hold"); if (Object.values(state.roles).some((item) => item.name.toLowerCase() === name.toLowerCase())) throw new HandlerFailure(409, "A role with this name already exists"); const id = nextID(state, "role"); const value = { id, name, description: stringValue(body.description), permissions, createdAt: now() }; state.roles[id] = value; appendAudit(state, actor, "role.created", "role", id, null, value, request); return value; });
  return reply.status(201).send(ok(role, "Role created", null));
}

/*******************************************************************************
 * Function: getRole
 *
 * Returns the requested role.
 ******************************************************************************/
async function getRole(request: FastifyRequest, reply: FastifyReply, services: HandlerServices): Promise<unknown> { const role = await services.repository.read((state) => state.roles[requestParam(request, "id")] ?? null); if (role === null) throw new HandlerFailure(404, "Role not found"); return reply.send(ok(role, "OK", null)); }

/*******************************************************************************
 * Function: updateRole
 *
 * Validates and applies changes to an existing role.
 ******************************************************************************/
async function updateRole(request: FastifyRequest, reply: FastifyReply, actor: CurrentUser, services: HandlerServices): Promise<unknown> {
  const body = bodyRecord(request); if (body === null) throw new HandlerFailure(400, "Invalid request body"); const id = requestParam(request, "id");
  const roleName = typeof body.name === "string" ? body.name : undefined;
  const role = await services.repository.mutate((state) => { const item = state.roles[id]; if (item === undefined) throw new HandlerFailure(404, "Role not found"); const before = structuredClone(item); if (roleName !== undefined) { if (roleName.trim() === "") throw new HandlerFailure(400, "Role name is required"); if (Object.values(state.roles).some((other) => other.id !== id && other.name.toLowerCase() === roleName.toLowerCase())) throw new HandlerFailure(409, "A role with this name already exists"); item.name = roleName; } if (typeof body.description === "string") item.description = body.description; if (Array.isArray(body.permissions)) { const permissions = stringArray(body.permissions); validatePermissions(state, permissions); if (permissions.some((key) => !actor.permissions.includes(key))) throw new HandlerFailure(403, "Cannot grant permissions the current user does not hold"); if (id === "role_admin" && state.permissions.some((permission) => !permissions.includes(permission.key))) throw new HandlerFailure(403, "Platform Admin permissions cannot be reduced"); item.permissions = permissions; } appendAudit(state, actor, "role.updated", "role", id, before, item, request); return structuredClone(item); });
  return reply.send(ok(role, "Role updated", null));
}

/*******************************************************************************
 * Function: deleteRole
 *
 * Deletes a role when its protection and assignment rules permit it.
 ******************************************************************************/
async function deleteRole(request: FastifyRequest, reply: FastifyReply, actor: CurrentUser, services: HandlerServices): Promise<unknown> { const id = requestParam(request, "id"); if (builtInRoleIDs.has(id)) throw new HandlerFailure(403, "Built-in roles cannot be deleted"); await services.repository.mutate((state) => { const role = state.roles[id]; if (role === undefined) throw new HandlerFailure(404, "Role not found"); const users = Object.values(state.users).filter((item) => item.roleId === id).length; if (users > 0) throw new HandlerFailure(409, "Role is still assigned to users", { users }); delete state.roles[id]; appendAudit(state, actor, "role.deleted", "role", id, role, null, request); }); return reply.send(ok({ deleted: true }, "Role deleted", null)); }

/*******************************************************************************
 * Function: permissionMatrix
 *
 * Returns the roles and permission data used by the permission editor.
 ******************************************************************************/
async function permissionMatrix(reply: FastifyReply, services: HandlerServices): Promise<unknown> { const data = await services.repository.read((state) => ({ permissions: state.permissions, roles: Object.values(state.roles), matrix: Object.fromEntries(Object.values(state.roles).map((role) => [role.id, Object.fromEntries(state.permissions.map((permission) => [permission.key, role.permissions.includes(permission.key)]))])) })); return reply.send(ok(data, "OK", null)); }

/*******************************************************************************
 * Function: listAudit
 *
 * Returns audit log entries matching the requested filters.
 ******************************************************************************/
async function listAudit(request: FastifyRequest, reply: FastifyReply, services: HandlerServices): Promise<unknown> { const query = queryRecord(request); const action = stringValue(query.action).toLowerCase(); const logs = await services.repository.read((state) => [...state.auditLogs].filter((entry) => action === "" || (isRecord(entry) && stringValue(entry.action).toLowerCase().includes(action))).reverse()); const page = paginate(logs, request); return reply.send(ok(page.items, "OK", page.meta)); }
/*******************************************************************************
 * Function: getAudit
 *
 * Returns an audit log entry by its identifier.
 ******************************************************************************/
async function getAudit(request: FastifyRequest, reply: FastifyReply, services: HandlerServices): Promise<unknown> { const entry = await services.repository.read((state) => state.auditLogs.find((item) => isRecord(item) && item.id === requestParam(request, "id")) ?? null); if (entry === null) throw new HandlerFailure(404, "Audit log not found"); return reply.send(ok(entry, "OK", null)); }
/*******************************************************************************
 * Function: exportAudit
 *
 * Exports audit log entries in the requested response format.
 ******************************************************************************/
async function exportAudit(request: FastifyRequest, reply: FastifyReply, services: HandlerServices): Promise<unknown> { if (stringValue(queryRecord(request).format).toLowerCase() !== "csv") return listAudit(request, reply, services); const logs = await services.repository.read((state) => [...state.auditLogs]); const rows = ["id,actor,action,resourceType,resourceId,createdAt", ...logs.map((entry) => { const value = isRecord(entry) ? entry : {}; const actor = isRecord(value.actor) ? value.actor : {}; const resource = isRecord(value.resource) ? value.resource : {}; return [value.id, actor.name, value.action, resource.type, resource.id, value.createdAt].map(csvCell).join(","); })]; return reply.header("content-type", "text/csv; charset=utf-8").header("content-disposition", "attachment; filename=\"audit.csv\"").send(rows.join("\n") + "\n"); }

/*******************************************************************************
 * Function: updateProfile
 *
 * Updates the current user's profile fields.
 ******************************************************************************/
async function updateProfile(request: FastifyRequest, reply: FastifyReply, actor: CurrentUser, services: HandlerServices): Promise<unknown> { const body = bodyRecord(request); if (body === null) throw new HandlerFailure(400, "Invalid request body"); const updated = await services.repository.mutate((state) => { const user = state.users[actor.id]; if (user === undefined) throw new HandlerFailure(401, "Authenticated user no longer exists"); if (typeof body.name === "string") { user.name = body.name; user.initials = initials(body.name); } if (typeof body.timezone === "string") user.timezone = body.timezone; return structuredClone(user); }); return reply.send(ok(publicUser(updated), "OK", null)); }

const defaultPreferences = { executionFailures: true, healingEvents: true, budgetWarnings: true, weeklyReports: false, channels: { email: true, inApp: true } };
/*******************************************************************************
 * Function: getNotificationPreferences
 *
 * Returns the current user's notification preferences.
 ******************************************************************************/
async function getNotificationPreferences(reply: FastifyReply, actor: CurrentUser, services: HandlerServices): Promise<unknown> { const prefs = await services.repository.read((state) => state.notificationPreferences[actor.id] ?? defaultPreferences); return reply.send(ok(prefs, "OK", null)); }
/*******************************************************************************
 * Function: updateNotificationPreferences
 *
 * Updates the current user's notification preferences.
 ******************************************************************************/
async function updateNotificationPreferences(request: FastifyRequest, reply: FastifyReply, actor: CurrentUser, services: HandlerServices): Promise<unknown> { const parsed = notificationPreferencesSchema.safeParse(request.body ?? {}); if (!parsed.success) throw new HandlerFailure(400, "Invalid request body"); await services.repository.mutate((state) => { state.notificationPreferences[actor.id] = parsed.data; }); return reply.send(ok(parsed.data, "Notification preferences updated", null)); }

/*******************************************************************************
 * Function: listAPIKeys
 *
 * Returns API key metadata for the current user.
 ******************************************************************************/
async function listAPIKeys(reply: FastifyReply, services: HandlerServices): Promise<unknown> { const keys = await services.repository.read((state) => Object.values(state.apiKeys).map(({ keyHash: _hash, ...item }) => item)); return reply.send(ok(keys, "OK", null)); }
/*******************************************************************************
 * Function: createAPIKey
 *
 * Creates an API key and stores its associated metadata.
 ******************************************************************************/
async function createAPIKey(request: FastifyRequest, reply: FastifyReply, services: HandlerServices): Promise<unknown> { const body = request.body === undefined ? {} : bodyRecord(request); if (body === null) throw new HandlerFailure(400, "Invalid request body"); const rawKey = `lcwe_${randomBytes(24).toString("hex")}`; const item = await services.repository.mutate((state) => { const id = nextID(state, "key"); const value = { id, name: stringValue(body.name).trim(), maskedKey: `${rawKey.slice(0, 9)}...${rawKey.slice(-4)}`, scopes: stringArray(body.scopes), createdAt: now(), expiresAt: null, keyHash: createHash("sha256").update(rawKey).digest("hex") }; state.apiKeys[id] = value; return value; }); const { keyHash: _hash, ...visible } = item; return reply.status(201).send(ok({ apiKey: visible, rawKey }, "API key created. Store the key now; it will not be shown again.", null)); }
/*******************************************************************************
 * Function: deleteAPIKey
 *
 * Deletes an API key belonging to the current user.
 ******************************************************************************/
async function deleteAPIKey(request: FastifyRequest, reply: FastifyReply, services: HandlerServices): Promise<unknown> { await services.repository.mutate((state) => { delete state.apiKeys[requestParam(request, "id")]; }); return reply.send(ok({ deleted: true }, "API key revoked", null)); }

/*******************************************************************************
 * Function: getSettings
 *
 * Returns application settings with secret fields removed.
 ******************************************************************************/
async function getSettings(reply: FastifyReply, services: HandlerServices): Promise<unknown> { const settings = await services.repository.read((state) => structuredClone(state.settings)); return reply.send(ok(withoutSecretFields(settings), "OK", null)); }
/*******************************************************************************
 * Function: patchSettings
 *
 * Applies the supplied updates to application settings.
 ******************************************************************************/
async function patchSettings(request: FastifyRequest, reply: FastifyReply, services: HandlerServices): Promise<unknown> { const body = bodyRecord(request); if (body === null) throw new HandlerFailure(400, "Invalid request body"); const settings = await services.repository.mutate((state) => { for (const group of ["general", "llm", "rbac"]) if (isRecord(body[group])) state.settings[group] = { ...(isRecord(state.settings[group]) ? state.settings[group] : {}), ...body[group] }; return structuredClone(state.settings); }); return reply.send(ok(withoutSecretFields(settings), "Settings updated", null)); }
/*******************************************************************************
 * Function: getSettingsGroup
 *
 * Returns a requested settings group with secret fields removed.
 ******************************************************************************/
async function getSettingsGroup(reply: FastifyReply, services: HandlerServices, group: string, redact = false): Promise<unknown> { const value = await services.repository.read((state) => isRecord(state.settings[group]) ? structuredClone(state.settings[group]) : {}); return reply.send(ok(redact ? withoutSecretFields(value) : value, "OK", null)); }
/*******************************************************************************
 * Function: patchSettingsGroup
 *
 * Applies updates to a requested settings group.
 ******************************************************************************/
async function patchSettingsGroup(request: FastifyRequest, reply: FastifyReply, services: HandlerServices, group: string, message: string, redact = false): Promise<unknown> { const body = bodyRecord(request); if (body === null) throw new HandlerFailure(400, "Invalid request body"); const value = await services.repository.mutate((state) => { state.settings[group] = { ...(isRecord(state.settings[group]) ? state.settings[group] : {}), ...body }; return structuredClone(state.settings[group]); }); return reply.send(ok(redact ? withoutSecretFields(value) : value, message, null)); }

/*******************************************************************************
 * Function: listNotifications
 *
 * Returns notifications using this handler's visibility and ordering rules.
 ******************************************************************************/
async function listNotifications(request: FastifyRequest, reply: FastifyReply, services: HandlerServices): Promise<unknown> { const unreadOnly = stringValue(queryRecord(request).unreadOnly).toLowerCase() === "true"; const notifications = await services.repository.read((state) => Object.values(state.notifications).filter((item) => !unreadOnly || item.read !== true).sort((a, b) => stringValue(b.createdAt).localeCompare(stringValue(a.createdAt)))); const page = paginate(notifications, request); return reply.send(ok(page.items, "OK", page.meta)); }
/*******************************************************************************
 * Function: markAllNotifications
 *
 * Marks the current user's notifications as read.
 ******************************************************************************/
async function markAllNotifications(reply: FastifyReply, services: HandlerServices): Promise<unknown> { const updated = await services.repository.mutate((state) => { let count = 0; for (const item of Object.values(state.notifications)) if (item.read !== true) { item.read = true; count += 1; } return count; }); return reply.send(ok({ updated }, "All notifications marked read", null)); }
/*******************************************************************************
 * Function: markNotification
 *
 * Marks the requested notification as read for the current user.
 ******************************************************************************/
async function markNotification(request: FastifyRequest, reply: FastifyReply, services: HandlerServices): Promise<unknown> { const item = await services.repository.mutate((state) => { const value = state.notifications[requestParam(request, "id")]; if (value === undefined) throw new HandlerFailure(404, "Notification not found"); value.read = true; return structuredClone(value); }); return reply.send(ok(item, "Notification marked as read", null)); }
/*******************************************************************************
 * Function: deleteNotification
 *
 * Deletes the requested notification.
 ******************************************************************************/
async function deleteNotification(request: FastifyRequest, reply: FastifyReply, services: HandlerServices): Promise<unknown> { await services.repository.mutate((state) => { delete state.notifications[requestParam(request, "id")]; }); return reply.send(ok({ deleted: true }, "Notification deleted", null)); }

/*******************************************************************************
 * Function: stringArray
 *
 * Keeps only string entries from an array value.
 ******************************************************************************/
function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
/*******************************************************************************
 * Function: validatePermissions
 *
 * Rejects unknown permissions and grants beyond the caller's authority.
 ******************************************************************************/
function validatePermissions(state: { permissions: { key: string }[] }, keys: string[]): void { const known = new Set(state.permissions.map((item) => item.key)); const unknown = keys.find((key) => !known.has(key)); if (unknown !== undefined) throw new HandlerFailure(400, `Unknown permission ${unknown}`); }
/*******************************************************************************
 * Function: applyRoleChange
 *
 * Applies a role change while enforcing administrator protection rules.
 ******************************************************************************/
function applyRoleChange(state: { roles: Record<string, { permissions: string[] }> }, target: { id: string; roleId: string }, roleID: string, actor: CurrentUser): void { const role = state.roles[roleID]; if (role === undefined) throw new HandlerFailure(400, "Unknown role"); if (target.id === actor.id && roleID !== target.roleId) throw new HandlerFailure(403, "You cannot change your own role"); if (role.permissions.some((permission) => !actor.permissions.includes(permission))) throw new HandlerFailure(403, "Cannot grant permissions the current user does not hold"); target.roleId = roleID; }
/*******************************************************************************
 * Function: applyStatus
 *
 * Applies an account status change and its session-revocation rules.
 ******************************************************************************/
function applyStatus(target: { id: string; status: string }, status: string, actor: CurrentUser): void { if (!["active", "suspended"].includes(status.toLowerCase())) throw new HandlerFailure(400, "Status must be Active or Suspended"); if (target.id === actor.id && status.toLowerCase() !== "active") throw new HandlerFailure(403, "You cannot suspend your own account"); target.status = status.toLowerCase() === "active" ? "Active" : "Suspended"; }
/*******************************************************************************
 * Function: revokeUserSessions
 *
 * Removes refresh sessions belonging to a user.
 ******************************************************************************/
function revokeUserSessions(state: { refreshSessions: Record<string, { userId: string }> }, userID: string): void { for (const [key, session] of Object.entries(state.refreshSessions)) if (session.userId === userID) delete state.refreshSessions[key]; }
/*******************************************************************************
 * Function: activeAdminCount
 *
 * Counts active platform administrators, optionally excluding a user.
 ******************************************************************************/
function activeAdminCount(state: { users: Record<string, { roleId: string; status: string }> }): number { return Object.values(state.users).filter((item) => item.roleId === "role_admin" && item.status.toLowerCase() === "active").length; }
/*******************************************************************************
 * Function: csvCell
 *
 * Escapes a value for inclusion in a CSV cell.
 ******************************************************************************/
function csvCell(value: unknown): string { const text = String(value ?? ""); return `"${text.replaceAll('"', '""')}"`; }
