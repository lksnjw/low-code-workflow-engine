import { apiClient } from "../config/axios";
import { unwrap } from "./api";

export const registryService = {
/*******************************************************************************
 * Function: load
 *
 * Loads the application for the registry service module.
 ******************************************************************************/
  async load() {
    const [tools, rules] = await Promise.all([
      apiClient.get("/registry/tools"),
      apiClient.get("/registry/rules"),
    ]);
    return { tools: unwrap(tools, []), rules: unwrap(rules, []) };
  },
/*******************************************************************************
 * Function: status
 *
 * Performs the status operation on the application for the registry service module.
 ******************************************************************************/
  async status() {
    return unwrap(await apiClient.get("/registry/status"), {});
  },
/*******************************************************************************
 * Function: context
 *
 * Performs the context operation on the application for the registry service module.
 ******************************************************************************/
  async context() {
    return unwrap(await apiClient.get("/registry/context"), {});
  },
/*******************************************************************************
 * Function: regenerateContext
 *
 * Performs the regenerate Context operation on context for the registry service module.
 ******************************************************************************/
  async regenerateContext() {
    return unwrap(await apiClient.post("/registry/context/regenerate"), {});
  },
/*******************************************************************************
 * Function: contextHistory
 *
 * Performs the context History operation on history for the registry service module.
 ******************************************************************************/
  async contextHistory() {
    return unwrap(await apiClient.get("/registry/context/history"), []);
  },
/*******************************************************************************
 * Function: create
 *
 * Creates the application for the registry service module.
 ******************************************************************************/
  async create(kind, value) {
    return unwrap(await apiClient.post(`/registry/${kind}`, value), {});
  },
/*******************************************************************************
 * Function: update
 *
 * Updates the application for the registry service module.
 ******************************************************************************/
  async update(kind, id, value) {
    return unwrap(await apiClient.put(`/registry/${kind}/${encodeURIComponent(id)}`, value), {});
  },
/*******************************************************************************
 * Function: bulkImport
 *
 * Performs the bulk Import operation on import for the registry service module.
 ******************************************************************************/
  async bulkImport(kind, values, allowUpdates = false) {
    return unwrap(await apiClient.post(`/registry/${kind}/import`, values, { params: { allowUpdates } }), {});
  },
/*******************************************************************************
 * Function: analyseImport
 *
 * Performs the analyse Import operation on import for the registry service module.
 ******************************************************************************/
  async analyseImport({ file, kind, prefix, allowUpdates }) {
    const body = new FormData();
    body.append("file", file);
    body.append("kind", kind);
    body.append("prefix", prefix || "");
    body.append("allowUpdates", String(Boolean(allowUpdates)));
    return unwrap(await apiClient.post("/import/analyse", body, { headers: { "Content-Type": "multipart/form-data" } }), {});
  },
/*******************************************************************************
 * Function: commitImport
 *
 * Performs the commit Import operation on import for the registry service module.
 ******************************************************************************/
  async commitImport(analysisId, selectedRecordIds) {
    return unwrap(await apiClient.post("/import/commit", { analysisId, selectedRecordIds }), {});
  },
/*******************************************************************************
 * Function: importHistory
 *
 * Performs the import History operation on history for the registry service module.
 ******************************************************************************/
  async importHistory() {
    return unwrap(await apiClient.get("/import/history"), []);
  },
};
