import { apiClient } from "../config/axios";
import { formatRelativeTime, unwrap } from "./api";

/*******************************************************************************
 * Function: normalizeWorkflow
 *
 * Normalizes workflow for the workflow service module.
 ******************************************************************************/
export function normalizeWorkflow(workflow) {
  if (!workflow) return null;
  const hasRuns = Boolean(workflow.lastRunAt);
  return {
    ...workflow,
    owner: workflow.owner?.name || "Unassigned",
    ownerRecord: workflow.owner,
    trigger:
      workflow.trigger?.displayName || workflow.trigger?.type || workflow.trigger || "Manual",
    successRate: hasRuns ? `${Number(workflow.successRate || 0).toFixed(1)}%` : "—",
    successRateValue: Number(workflow.successRate || 0),
    lastRun: formatRelativeTime(workflow.lastRunAt),
    domainTags: Array.isArray(workflow.domainTags) ? workflow.domainTags : [],
    canRun: Boolean(workflow.canRun),
  };
}

export const workflowService = {
/*******************************************************************************
 * Function: list
 *
 * Lists the application for the workflow service module.
 ******************************************************************************/
  async list(params = {}) {
    const response = await apiClient.get("/workflows", { params });
    return (unwrap(response, []) || []).map(normalizeWorkflow);
  },
/*******************************************************************************
 * Function: getById
 *
 * Gets by id for the workflow service module.
 ******************************************************************************/
  async getById(id) {
    const response = await apiClient.get(`/workflows/${id}`);
    return normalizeWorkflow(unwrap(response));
  },
/*******************************************************************************
 * Function: create
 *
 * Creates the application for the workflow service module.
 ******************************************************************************/
  async create(payload) {
    const response = await apiClient.post("/workflows", payload);
    return normalizeWorkflow(unwrap(response));
  },
/*******************************************************************************
 * Function: update
 *
 * Updates the application for the workflow service module.
 ******************************************************************************/
  async update(id, payload) {
    const response = await apiClient.patch(`/workflows/${id}`, payload);
    return normalizeWorkflow(unwrap(response));
  },
/*******************************************************************************
 * Function: remove
 *
 * Removes the application for the workflow service module.
 ******************************************************************************/
  async remove(id) {
    return unwrap(await apiClient.delete(`/workflows/${id}`));
  },
/*******************************************************************************
 * Function: listTemplates
 *
 * Lists templates for the workflow service module.
 ******************************************************************************/
  async listTemplates() {
    return unwrap(await apiClient.get("/workflows/templates"), []);
  },
/*******************************************************************************
 * Function: useTemplate
 *
 * Provides template for the workflow service module.
 ******************************************************************************/
  async useTemplate(id, name) {
    return normalizeWorkflow(unwrap(await apiClient.post(`/workflows/templates/${id}/use`, { name })));
  },
/*******************************************************************************
 * Function: getCanvas
 *
 * Gets canvas for the workflow service module.
 ******************************************************************************/
  async getCanvas(id) {
    return unwrap(await apiClient.get(`/workflows/${id}/canvas`));
  },
/*******************************************************************************
 * Function: getYAML
 *
 * Gets yaml for the workflow service module.
 ******************************************************************************/
  async getYAML(id) {
    return unwrap(await apiClient.get(`/workflows/${id}/yaml`));
  },
/*******************************************************************************
 * Function: saveYAML
 *
 * Saves yaml for the workflow service module.
 ******************************************************************************/
  async saveYAML(id, yaml) {
    return unwrap(await apiClient.put(`/workflows/${id}/yaml`, { yaml }));
  },
/*******************************************************************************
 * Function: saveCanvas
 *
 * Saves canvas for the workflow service module.
 ******************************************************************************/
  async saveCanvas(id, canvas) {
    return unwrap(await apiClient.put(`/workflows/${id}/canvas`, canvas));
  },
/*******************************************************************************
 * Function: publish
 *
 * Performs the publish operation on the application for the workflow service module.
 ******************************************************************************/
  async publish(id, versionNote = "") {
    return unwrap(await apiClient.post(`/workflows/${id}/publish`, { versionNote }));
  },
/*******************************************************************************
 * Function: run
 *
 * Runs the application for the workflow service module.
 ******************************************************************************/
  async run(id, input = {}, options = {}) {
    return unwrap(
      await apiClient.post(`/workflows/${id}/run`, {
        input,
        dryRun: Boolean(options.dryRun),
        idempotencyKey: options.idempotencyKey,
      }),
    );
  },
/*******************************************************************************
 * Function: assignUser
 *
 * Performs the assign User operation on user for the workflow service module.
 ******************************************************************************/
  async assignUser(id, userId) {
    return normalizeWorkflow(unwrap(await apiClient.post(`/workflows/${id}/assign`, { userId })));
  },
/*******************************************************************************
 * Function: unassignUser
 *
 * Performs the unassign User operation on user for the workflow service module.
 ******************************************************************************/
  async unassignUser(id, userId) {
    return normalizeWorkflow(unwrap(await apiClient.delete(`/workflows/${id}/assign/${encodeURIComponent(userId)}`)));
  },
};
