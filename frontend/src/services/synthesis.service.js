import { apiClient } from "../config/axios";
import { unwrap } from "./api";

export const synthesisService = {
  async synthesize(prompt, options = {}) {
    return unwrap(await apiClient.post("/synthesis", { prompt, ...options }));
  },
  async semanticSearch(query, options = {}) {
    return unwrap(await apiClient.post("/semantic-search", { query, ...options }));
  },
};
