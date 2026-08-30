import { apiClient } from "../config/axios";
import { unwrap } from "./api";

export const semanticService = {
/*******************************************************************************
 * Function: health
 *
 * Performs the health operation on the application for the semantic service module.
 ******************************************************************************/
  async health() {
    return unwrap(await apiClient.get("/semantic-index/health"), {});
  },
/*******************************************************************************
 * Function: metadata
 *
 * Performs the metadata operation on the application for the semantic service module.
 ******************************************************************************/
  async metadata() {
    return unwrap(await apiClient.get("/semantic-index/metadata"), {});
  },
/*******************************************************************************
 * Function: status
 *
 * Performs the status operation on the application for the semantic service module.
 ******************************************************************************/
  async status() {
    const [health, metadata] = await Promise.all([this.health(), this.metadata()]);
    return { health, metadata };
  },
/*******************************************************************************
 * Function: rebuild
 *
 * Performs the rebuild operation on the application for the semantic service module.
 ******************************************************************************/
  async rebuild() {
    return unwrap(await apiClient.post("/semantic-index/rebuild"), {});
  },
};
