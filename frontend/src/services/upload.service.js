import { apiClient } from "../config/axios";
import { unwrap } from "./api";

export const uploadService = {
/*******************************************************************************
 * Function: upload
 *
 * Performs the upload operation on the application for the upload service module.
 ******************************************************************************/
  async upload(file) {
    const data = new FormData();
    data.append("file", file);
    return unwrap(await apiClient.post("/upload", data, { headers: { "Content-Type": "multipart/form-data" } }));
  },
};
