import { apiClient } from "../config/axios";
import { unwrap } from "./api";

export const notificationService = {
  async list(params = {}) {
    return unwrap(await apiClient.get("/notifications", { params }), []);
  },
  async markRead(id) {
    return unwrap(await apiClient.patch(`/notifications/${id}/read`));
  },
  async markAllRead() {
    return unwrap(await apiClient.patch("/notifications/read-all"));
  },
};
