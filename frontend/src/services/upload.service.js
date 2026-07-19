import { apiClient } from "../config/axios";
import { unwrap } from "./api";

export const uploadService = {
  async upload(file) {
    const data = new FormData();
    data.append("file", file);
    return unwrap(await apiClient.post("/upload", data, { headers: { "Content-Type": "multipart/form-data" } }));
  },
};
