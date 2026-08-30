import { apiClient } from "../config/axios";
import { unwrap } from "./api";

export const synthesisService = {
/*******************************************************************************
 * Function: synthesize
 *
 * Performs the synthesize operation on the application for the synthesis service module.
 ******************************************************************************/
  async synthesize(prompt, options = {}) {
    return unwrap(await apiClient.post("/synthesis", { prompt, ...options }));
  },
/*******************************************************************************
 * Function: semanticSearch
 *
 * Performs the semantic Search operation on search for the synthesis service module.
 ******************************************************************************/
  async semanticSearch(query, options = {}) {
    return unwrap(await apiClient.post("/semantic-search", { query, ...options }));
  },
};
