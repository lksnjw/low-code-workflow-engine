import { apiClient } from "../config/axios";
import { unwrap } from "./api";

const normalizeUser = (user) => ({ ...user, role: user.role?.name || user.role || "Unassigned" });

export const userService = {
  async loadAdministration() {
    const [users, roles, permissions, matrix, audit, departments] = await Promise.all([
      apiClient.get("/users"),
      apiClient.get("/roles"),
      apiClient.get("/permissions"),
      apiClient.get("/permissions/matrix"),
      apiClient.get("/audit", { params: { limit: 10 } }).catch(() => null),
      apiClient.get("/company/departments"),
    ]);
    return {
      users: (unwrap(users, []) || []).map(normalizeUser),
      roles: unwrap(roles, []),
      permissions: unwrap(permissions, []),
      matrix: unwrap(matrix, []),
      audit: unwrap(audit, []),
      departments: unwrap(departments, []),
    };
  },
  async create(payload) {
    return normalizeUser(unwrap(await apiClient.post("/users", payload)));
  },
  async updateRole(userId, roleId) {
    return normalizeUser(unwrap(await apiClient.put(`/users/${userId}/role`, { roleId })));
  },
  async updateStatus(userId, status) {
    return normalizeUser(unwrap(await apiClient.put(`/users/${userId}/status`, { status })));
  },
  async updateDepartment(userId, departmentId) {
    return normalizeUser(unwrap(await apiClient.patch(`/users/${userId}`, { departmentId: departmentId || null })));
  },
  async updateRoleDefinition(roleId, payload) {
    return unwrap(await apiClient.put(`/roles/${roleId}`, payload));
  },
  async createRole(payload) {
    return unwrap(await apiClient.post("/roles", payload));
  },
  async deleteRole(roleId) {
    return unwrap(await apiClient.delete(`/roles/${roleId}`));
  },
  async assignable() {
    return unwrap(await apiClient.get("/workflows/assignable-users"), []);
  },
};
