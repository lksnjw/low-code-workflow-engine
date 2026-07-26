import { apiClient } from "../config/axios";
import { unwrap } from "./api";

export const registryService = {
  async load() {
    const [tools, rules] = await Promise.all([
      apiClient.get("/registry/tools"),
      apiClient.get("/registry/rules"),
    ]);
    return { tools: unwrap(tools, []), rules: unwrap(rules, []) };
  },
  async status() {
    return unwrap(await apiClient.get("/registry/status"), {});
  },
  async context() {
    return unwrap(await apiClient.get("/registry/context"), {});
  },
  async regenerateContext() {
    return unwrap(await apiClient.post("/registry/context/regenerate"), {});
  },
  async contextHistory() {
    return unwrap(await apiClient.get("/registry/context/history"), []);
  },
  async create(kind, value) {
    return unwrap(await apiClient.post(`/registry/${kind}`, value), {});
  },
  async update(kind, id, value) {
    return unwrap(await apiClient.put(`/registry/${kind}/${encodeURIComponent(id)}`, value), {});
  },
  async analyseImport({ file, kind, prefix, allowUpdates }) {
    const body = new FormData();
    body.append("file", file);
    body.append("kind", kind);
    body.append("prefix", prefix || "");
    body.append("allowUpdates", String(Boolean(allowUpdates)));
    return unwrap(await apiClient.post("/import/analyse", body, { headers: { "Content-Type": "multipart/form-data" } }), {});
  },
  async commitImport(analysisId, selectedRecordIds) {
    return unwrap(await apiClient.post("/import/commit", { analysisId, selectedRecordIds }), {});
  },
  async importHistory() {
    return unwrap(await apiClient.get("/import/history"), []);
  },
};
