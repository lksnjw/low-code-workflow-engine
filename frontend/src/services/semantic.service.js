import { apiClient } from "../config/axios";
import { unwrap } from "./api";

export const semanticService = {
  async health() {
    return unwrap(await apiClient.get("/semantic-index/health"), {});
  },
  async metadata() {
    return unwrap(await apiClient.get("/semantic-index/metadata"), {});
  },
  async status() {
    const [health, metadata] = await Promise.all([this.health(), this.metadata()]);
    return { health, metadata };
  },
  async rebuild() {
    return unwrap(await apiClient.post("/semantic-index/rebuild"), {});
  },
};
