import { apiClient } from "../config/axios";
import { formatRelativeTime, unwrap } from "./api";

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
  async list(params = {}) {
    const response = await apiClient.get("/workflows", { params });
    return (unwrap(response, []) || []).map(normalizeWorkflow);
  },
  async getById(id) {
    const response = await apiClient.get(`/workflows/${id}`);
    return normalizeWorkflow(unwrap(response));
  },
  async create(payload) {
    const response = await apiClient.post("/workflows", payload);
    return normalizeWorkflow(unwrap(response));
  },
  async update(id, payload) {
    const response = await apiClient.patch(`/workflows/${id}`, payload);
    return normalizeWorkflow(unwrap(response));
  },
  async remove(id) {
    return unwrap(await apiClient.delete(`/workflows/${id}`));
  },
  async listTemplates() {
    return unwrap(await apiClient.get("/workflows/templates"), []);
  },
  async useTemplate(id, name) {
    return normalizeWorkflow(unwrap(await apiClient.post(`/workflows/templates/${id}/use`, { name })));
  },
  async getCanvas(id) {
    return unwrap(await apiClient.get(`/workflows/${id}/canvas`));
  },
  async getYAML(id) {
    return unwrap(await apiClient.get(`/workflows/${id}/yaml`));
  },
  async saveYAML(id, yaml) {
    return unwrap(await apiClient.put(`/workflows/${id}/yaml`, { yaml }));
  },
  async saveCanvas(id, canvas) {
    return unwrap(await apiClient.put(`/workflows/${id}/canvas`, canvas));
  },
  async publish(id, versionNote = "") {
    return unwrap(await apiClient.post(`/workflows/${id}/publish`, { versionNote }));
  },
  async run(id, input = {}, options = {}) {
    return unwrap(
      await apiClient.post(`/workflows/${id}/run`, {
        input,
        dryRun: Boolean(options.dryRun),
        idempotencyKey: options.idempotencyKey,
      }),
    );
  },
  async assignUser(id, userId) {
    return normalizeWorkflow(unwrap(await apiClient.post(`/workflows/${id}/assign`, { userId })));
  },
  async unassignUser(id, userId) {
    return normalizeWorkflow(unwrap(await apiClient.delete(`/workflows/${id}/assign/${encodeURIComponent(userId)}`)));
  },
};
