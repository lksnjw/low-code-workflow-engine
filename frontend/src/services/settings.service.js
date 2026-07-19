import { apiClient } from "../config/axios";
import { unwrap } from "./api";

export const settingsService = {
  async load() {
    const [settings, integrations, webhooks, apiKeys] = await Promise.all([
      apiClient.get("/settings"),
      apiClient.get("/integrations"),
      apiClient.get("/settings/webhooks"),
      apiClient.get("/profile/api-keys"),
    ]);
    return {
      settings: unwrap(settings, { general: {}, llm: {}, rbac: {} }),
      integrations: unwrap(integrations, []),
      webhooks: unwrap(webhooks, []),
      apiKeys: unwrap(apiKeys, []),
    };
  },
  async update(payload) {
    return unwrap(await apiClient.patch("/settings", payload));
  },
  async createWebhook(payload) {
    return unwrap(await apiClient.post("/settings/webhooks", payload));
  },
};
