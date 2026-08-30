import { apiClient } from "../config/axios";
import { unwrap } from "./api";

export const integrationService = {
/*******************************************************************************
 * Function: list
 *
 * Lists the application for the integration service module.
 ******************************************************************************/
  async list() {
    return unwrap(await apiClient.get("/integrations"), []);
  },
/*******************************************************************************
 * Function: create
 *
 * Creates the application for the integration service module.
 ******************************************************************************/
  async create(payload) {
    return unwrap(await apiClient.post("/integrations", payload));
  },
/*******************************************************************************
 * Function: test
 *
 * Performs the test operation on the application for the integration service module.
 ******************************************************************************/
  async test(id) {
    return unwrap(await apiClient.post(`/integrations/${id}/test`));
  },
/*******************************************************************************
 * Function: connect
 *
 * Performs the connect operation on the application for the integration service module.
 ******************************************************************************/
  async connect(id) {
    return unwrap(await apiClient.post(`/integrations/${id}/connect`));
  },
/*******************************************************************************
 * Function: disconnect
 *
 * Performs the disconnect operation on the application for the integration service module.
 ******************************************************************************/
  async disconnect(id) {
    return unwrap(await apiClient.post(`/integrations/${id}/disconnect`));
  },
};
