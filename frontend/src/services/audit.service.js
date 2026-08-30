import { apiClient } from "../config/axios";
import { unwrap } from "./api";

export const auditService = {
/*******************************************************************************
 * Function: list
 *
 * Lists the application for the audit service module.
 ******************************************************************************/
  async list(params = {}) {
    return unwrap(await apiClient.get("/audit", { params }), []);
  },
};
