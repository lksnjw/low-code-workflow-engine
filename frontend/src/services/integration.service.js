import { apiClient } from "../config/axios";
import { unwrap } from "./api";

export const integrationService = {
  async list() {
    return unwrap(await apiClient.get("/integrations"), []);
  },
  async create(payload) {
    return unwrap(await apiClient.post("/integrations", payload));
  },
  async test(id) {
    return unwrap(await apiClient.post(`/integrations/${id}/test`));
  },
  async connect(id) {
    return unwrap(await apiClient.post(`/integrations/${id}/connect`));
  },
  async disconnect(id) {
    return unwrap(await apiClient.post(`/integrations/${id}/disconnect`));
  },
};
