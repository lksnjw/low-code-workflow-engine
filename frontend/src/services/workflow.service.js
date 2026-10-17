import { apiClient } from "../config/axios";
import { formatRelativeTime, unwrap } from "./api";
import { runAdmissionService } from "./run-admission.service";

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
    triggerRaw: workflow.trigger,
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
  async validateCanvas(payload) {
    return unwrap(await apiClient.post("/canvas/validate-workflow", payload));
  },
  async simulate(id, revision, input, outputs, profile = "read-fixtures/v1", failures = {}) {
    if (!["read-fixtures/v1", "read-fixtures/v2", "model-fixtures/v1", "protected-fixtures/v1"].includes(profile)) throw new Error("Unsupported fixture profile");
    if (profile !== "protected-fixtures/v1" && Object.keys(failures).length) throw new Error("Business fault fixtures require the protected fixture profile");
    // Separate from real runs: no mode, approval, retry or idempotency receipt.
    return unwrap(await apiClient.post(`/workflows/${id}/run`, { dryRun: true, input,
      simulation: { profile, baseVersion: revision.version, baseHash: revision.contentHash, outputs, ...(profile === "protected-fixtures/v1" ? { failures } : {}) },
    }, { timeout: 30000 }));
  },
  async readiness(id) {
    return unwrap(await apiClient.get(`/workflows/${id}/readiness`));
  },
  async command(id, revision, command) {
    return unwrap(await apiClient.post(`/workflows/${id}/commands`, { baseVersion: revision.version, baseHash: revision.contentHash, command, ...(revision.proposalId ? { proposalId: revision.proposalId } : {}) }));
  },
  async editHistory(id, revision, beforeId) {
    return unwrap(await apiClient.get(`/workflows/${id}/versions`, { params: { view: "edit-history", baseVersion: revision.version, baseHash: revision.contentHash, ...(beforeId ? { beforeId } : {}) } }));
  },
  async editHistoryVersion(id, revision, entry) {
    return unwrap(await apiClient.get(`/workflows/${id}/versions`, { params: { view: "edit-history", baseVersion: revision.version, baseHash: revision.contentHash, versionId: entry.id, contentHash: entry.contentHash } }));
  },
  async proposeNode(id, revision, nodeId, prompt, sessionId, model) {
    return unwrap(await apiClient.post(`/workflows/${id}/node-proposals`, { baseVersion: revision.version, baseHash: revision.contentHash, nodeId, prompt, ...(sessionId ? { sessionId } : {}), ...(model ? { model } : {}) }, { timeout: 60000 }));
  },
/*******************************************************************************
 * Function: list
 *
 * Lists the application for the workflow service module.
 ******************************************************************************/
  async list(params = {}) {
    const response = await apiClient.get("/workflows", { params });
    return (unwrap(response, []) || []).map(normalizeWorkflow);
  },
  async listPage(params = {}, signal) {
    const response = await apiClient.get("/workflows", { params: { limit: 20, ...params }, signal });
    return { items: (unwrap(response, []) || []).map(normalizeWorkflow), meta: response.data.meta };
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
 * Function: approveGeneration
 *
 * Resolves a generation-time approval checkpoint for the workflow module.
 * Accepts a build proposal only; preserves authored runtime approval nodes.
 ******************************************************************************/
  async approveGeneration(id, note = "") {
    return normalizeWorkflow(unwrap(await apiClient.post(`/workflows/${id}/approve-generation`, { note }, { timeout: 60000 })));
  },
/*******************************************************************************
 * Function: rejectGeneration
 *
 * Rejects a generation-time approval checkpoint for the workflow module.
 ******************************************************************************/
  async rejectGeneration(id, reason = "") {
    return normalizeWorkflow(unwrap(await apiClient.post(`/workflows/${id}/reject-generation`, { reason })));
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
  async publish(id, versionNote = "", revision) {
    return unwrap(await apiClient.post(`/workflows/${id}/publish`, { versionNote, ...(revision ? { baseVersion: revision.version, baseHash: revision.contentHash } : {}) }));
  },
/*******************************************************************************
 * Function: run
 *
 * Runs the application for the workflow service module.
 ******************************************************************************/
  async run(id, input = {}, options = {}) {
    if (!options.dryRun) return runAdmissionService.admit(id, input, options);
    // Dry-run validation cannot dispatch. Real runs use the shared queued
    // admission path above; a request timeout alone never proves cancellation.
    return unwrap(
      await apiClient.post(`/workflows/${id}/run`, {
        input,
        ...(options.mode ? { mode: options.mode } : {}),
        dryRun: Boolean(options.dryRun),
        idempotencyKey: options.idempotencyKey,
      }, { timeout: 300000 }),
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
