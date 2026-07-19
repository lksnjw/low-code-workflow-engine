import { apiClient } from "../config/axios";
import { unwrap } from "./api";

const normalizeUser = (user) => ({ ...user, role: user.role?.name || user.role || "Unassigned" });

export const userService = {
  async loadAdministration() {
    const [users, roles, matrix, audit] = await Promise.all([
      apiClient.get("/users"),
      apiClient.get("/roles"),
      apiClient.get("/permissions/matrix"),
      apiClient.get("/audit", { params: { limit: 10 } }),
    ]);
    return {
      users: (unwrap(users, []) || []).map(normalizeUser),
      roles: unwrap(roles, []),
      matrix: unwrap(matrix, []),
      audit: unwrap(audit, []),
    };
  },
  async create(payload) {
    return normalizeUser(unwrap(await apiClient.post("/users", payload)));
  },
};
