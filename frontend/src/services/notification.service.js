import { apiClient } from "../config/axios";
import { unwrap } from "./api";

export const notificationService = {
/*******************************************************************************
 * Function: list
 *
 * Lists the application for the notification service module.
 ******************************************************************************/
  async list(params = {}) {
    return unwrap(await apiClient.get("/notifications", { params }), []);
  },
/*******************************************************************************
 * Function: markRead
 *
 * Performs the mark Read operation on read for the notification service module.
 ******************************************************************************/
  async markRead(id) {
    return unwrap(await apiClient.patch(`/notifications/${id}/read`));
  },
/*******************************************************************************
 * Function: markAllRead
 *
 * Performs the mark All Read operation on all read for the notification service module.
 ******************************************************************************/
  async markAllRead() {
    return unwrap(await apiClient.patch("/notifications/read-all"));
  },
};
