import { apiClient } from "../config/axios";
import { unwrap } from "./api";

export const auditService = {
  async list(params = {}) {
    return unwrap(await apiClient.get("/audit", { params }), []);
  },
};
