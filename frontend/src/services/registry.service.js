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
  async create(kind, value) {
    return unwrap(await apiClient.post(`/registry/${kind}`, value), {});
  },
  async update(kind, id, value) {
    return unwrap(await apiClient.put(`/registry/${kind}/${encodeURIComponent(id)}`, value), {});
  },
};
