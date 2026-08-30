import { apiClient } from "../config/axios";
import { unwrap } from "./api";

/*******************************************************************************
 * Function: normalizeUser
 *
 * Normalizes user for the user service module.
 ******************************************************************************/
const normalizeUser = (user) => ({ ...user, role: user.role?.name || user.role || "Unassigned" });

export const userService = {
/*******************************************************************************
 * Function: loadAdministration
 *
 * Loads administration for the user service module.
 ******************************************************************************/
  async loadAdministration() {
    const [users, roles, permissions, matrix, departments] = await Promise.all([
      apiClient.get("/users"),
      apiClient.get("/roles"),
      apiClient.get("/permissions"),
      apiClient.get("/permissions/matrix"),
      apiClient.get("/company/departments"),
    ]);
    return {
      users: (unwrap(users, []) || []).map(normalizeUser),
      roles: unwrap(roles, []),
      permissions: unwrap(permissions, []),
      matrix: unwrap(matrix, []),
      departments: unwrap(departments, []),
    };
  },
/*******************************************************************************
 * Function: loadAudit
 *
 * Loads audit for the user service module.
 ******************************************************************************/
  async loadAudit(params = { limit: 20 }) {
    const response = await apiClient.get("/audit", { params });
    return {
      logs: unwrap(response, []),
      meta: response?.data?.meta ?? null,
    };
  },
/*******************************************************************************
 * Function: create
 *
 * Creates the application for the user service module.
 ******************************************************************************/
  async create(payload) {
    return normalizeUser(unwrap(await apiClient.post("/users", payload)));
  },
/*******************************************************************************
 * Function: updateRole
 *
 * Updates role for the user service module.
 ******************************************************************************/
  async updateRole(userId, roleId) {
    return normalizeUser(unwrap(await apiClient.put(`/users/${userId}/role`, { roleId })));
  },
/*******************************************************************************
 * Function: updateStatus
 *
 * Updates status for the user service module.
 ******************************************************************************/
  async updateStatus(userId, status) {
    return normalizeUser(unwrap(await apiClient.put(`/users/${userId}/status`, { status })));
  },
/*******************************************************************************
 * Function: updateDepartment
 *
 * Updates department for the user service module.
 ******************************************************************************/
  async updateDepartment(userId, departmentId) {
    return normalizeUser(unwrap(await apiClient.patch(`/users/${userId}`, { departmentId: departmentId || null })));
  },
/*******************************************************************************
 * Function: updateRoleDefinition
 *
 * Updates role definition for the user service module.
 ******************************************************************************/
  async updateRoleDefinition(roleId, payload) {
    return unwrap(await apiClient.put(`/roles/${roleId}`, payload));
  },
/*******************************************************************************
 * Function: createRole
 *
 * Creates role for the user service module.
 ******************************************************************************/
  async createRole(payload) {
    return unwrap(await apiClient.post("/roles", payload));
  },
/*******************************************************************************
 * Function: deleteRole
 *
 * Deletes role for the user service module.
 ******************************************************************************/
  async deleteRole(roleId) {
    return unwrap(await apiClient.delete(`/roles/${roleId}`));
  },
/*******************************************************************************
 * Function: assignable
 *
 * Performs the assignable operation on the application for the user service module.
 ******************************************************************************/
  async assignable() {
    return unwrap(await apiClient.get("/workflows/assignable-users"), []);
  },
};
