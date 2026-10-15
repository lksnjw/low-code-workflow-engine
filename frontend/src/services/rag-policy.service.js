import { apiClient } from "../config/axios";
import { unwrap } from "./api";
export const ragPolicyService = {
  status: async () => unwrap(await apiClient.get("/settings/rag-policy")),
  test: async (prompt, record) => unwrap(await apiClient.post("/settings/rag-policy/test", { prompt, ...(record || {}) })),
  publish: async policy => unwrap(await apiClient.post("/settings/rag-policy/documents", { policy, reviewConfirmed: true }, { timeout: 45000 })),
};
