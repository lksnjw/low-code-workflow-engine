import { apiClient } from "../config/axios";
import { unwrap } from "./api";

export const settingsService = {
/*******************************************************************************
 * Function: load
 *
 * Loads the application for the settings service module.
 ******************************************************************************/
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
/*******************************************************************************
 * Function: update
 *
 * Updates the application for the settings service module.
 ******************************************************************************/
  async update(payload) {
    return unwrap(await apiClient.patch("/settings", payload));
  },
/*******************************************************************************
 * Function: createWebhook
 *
 * Creates webhook for the settings service module.
 ******************************************************************************/
  async createWebhook(payload) {
    return unwrap(await apiClient.post("/settings/webhooks", payload));
  },
/*******************************************************************************
 * Function: providers
 *
 * Performs the providers operation on the application for the settings service module.
 ******************************************************************************/
  async providers() {
    return unwrap(await apiClient.get("/providers"), []);
  },
/*******************************************************************************
 * Function: createProvider
 *
 * Creates provider for the settings service module.
 ******************************************************************************/
  async createProvider(payload) {
    return unwrap(await apiClient.post("/providers", payload), {});
  },
/*******************************************************************************
 * Function: updateProvider
 *
 * Updates provider for the settings service module.
 ******************************************************************************/
  async updateProvider(id, payload) {
    return unwrap(await apiClient.put(`/providers/${encodeURIComponent(id)}`, payload), {});
  },
/*******************************************************************************
 * Function: activateProvider
 *
 * Performs the activate Provider operation on provider for the settings service module.
 ******************************************************************************/
  async activateProvider(id) {
    return unwrap(await apiClient.post(`/providers/${encodeURIComponent(id)}/activate`), {});
  },
/*******************************************************************************
 * Function: testProvider
 *
 * Performs the test Provider operation on provider for the settings service module.
 ******************************************************************************/
  async testProvider(id) {
    return unwrap(await apiClient.post(`/providers/${encodeURIComponent(id)}/test`), {});
  },
};
