import { apiClient } from "../config/axios";
import { unwrap } from "./api";

export const profileService = {
  async get() {
    return unwrap(await apiClient.get("/profile"), {});
  },
  async update(payload) {
    return unwrap(await apiClient.patch("/profile", payload), {});
  },
};
