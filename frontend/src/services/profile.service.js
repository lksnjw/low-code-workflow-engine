import { apiClient } from "../config/axios";
import { unwrap } from "./api";

export const profileService = {
/*******************************************************************************
 * Function: get
 *
 * Gets the application for the profile service module.
 ******************************************************************************/
  async get() {
    return unwrap(await apiClient.get("/profile"), {});
  },
/*******************************************************************************
 * Function: update
 *
 * Updates the application for the profile service module.
 ******************************************************************************/
  async update(payload) {
    return unwrap(await apiClient.patch("/profile", payload), {});
  },
};
