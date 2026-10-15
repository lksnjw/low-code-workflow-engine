import { apiClient } from "../config/axios";
import { unwrap } from "./api";
const path = id => `/profile/erp-connections/${encodeURIComponent(id)}`;
export const userErpService = {
  async list() { return unwrap(await apiClient.get("/profile/erp-connections"), {}); },
  async save(id, body) { return unwrap(await apiClient.put(path(id), body), {}); },
  async remove(id, body) { return unwrap(await apiClient.delete(path(id), { data: body }), {}); },
  async test(id, body) { return unwrap(await apiClient.post(`${path(id)}/test`, body), {}); },
};
