import { apiClient } from "../config/axios";
import { formatDuration, formatTokens, unwrap } from "./api";

export function normalizeExecution(execution) {
  return {
    ...execution,
    workflow: execution.workflowName,
    started: execution.startedAt ? new Date(execution.startedAt).toLocaleString() : "—",
    duration: formatDuration(execution.durationMs),
    tokens: formatTokens(execution.tokens?.total || 0),
    cost: `$${Number(execution.costUsd || 0).toFixed(2)}`,
  };
}

export const executionService = {
  async list(params = {}) {
    const response = await apiClient.get("/executions", { params });
    return (unwrap(response, []) || []).map(normalizeExecution);
  },
  async listByChatSession(chatSessionId) {
    return this.list({ chatSessionId });
  },
  async get(id) {
    return normalizeExecution(unwrap(await apiClient.get(`/executions/${id}`)));
  },
  async getLogs(id) {
    return unwrap(await apiClient.get(`/executions/${id}/logs`), []);
  },
  async getTimeline(id) {
    return unwrap(await apiClient.get(`/executions/${id}/timeline`), []);
  },
  async getHealingReport(id) {
    return unwrap(await apiClient.get(`/executions/${id}/healing-report`));
  },
  async run(workflowId, input = {}, options = {}) {
    return normalizeExecution(
      unwrap(await apiClient.post(`/workflows/${workflowId}/run`, { input, ...options })),
    );
  },
  async retry(id, input = {}) {
    return normalizeExecution(unwrap(await apiClient.post(`/executions/${id}/retry`, { input })));
  },
  async approve(id, note = "") {
    return normalizeExecution(unwrap(await apiClient.post(`/executions/${id}/approve`, { note })));
  },
  async reject(id, reason = "") {
    return normalizeExecution(unwrap(await apiClient.post(`/executions/${id}/reject`, { reason })));
  },
};
