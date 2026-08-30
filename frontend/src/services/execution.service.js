import { apiClient } from "../config/axios";
import { formatDuration, formatTokens, unwrap } from "./api";

/*******************************************************************************
 * Function: normalizeExecution
 *
 * Normalizes execution for the execution service module.
 ******************************************************************************/
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
/*******************************************************************************
 * Function: list
 *
 * Lists the application for the execution service module.
 ******************************************************************************/
  async list(params = {}) {
    const response = await apiClient.get("/executions", { params });
    return (unwrap(response, []) || []).map(normalizeExecution);
  },
/*******************************************************************************
 * Function: listByChatSession
 *
 * Lists by chat session for the execution service module.
 ******************************************************************************/
  async listByChatSession(chatSessionId) {
    return this.list({ chatSessionId });
  },
/*******************************************************************************
 * Function: get
 *
 * Gets the application for the execution service module.
 ******************************************************************************/
  async get(id) {
    return normalizeExecution(unwrap(await apiClient.get(`/executions/${id}`)));
  },
/*******************************************************************************
 * Function: getLogs
 *
 * Gets logs for the execution service module.
 ******************************************************************************/
  async getLogs(id) {
    return unwrap(await apiClient.get(`/executions/${id}/logs`), []);
  },
/*******************************************************************************
 * Function: getTimeline
 *
 * Gets timeline for the execution service module.
 ******************************************************************************/
  async getTimeline(id) {
    return unwrap(await apiClient.get(`/executions/${id}/timeline`), []);
  },
/*******************************************************************************
 * Function: getHealingReport
 *
 * Gets healing report for the execution service module.
 ******************************************************************************/
  async getHealingReport(id) {
    return unwrap(await apiClient.get(`/executions/${id}/healing-report`));
  },
/*******************************************************************************
 * Function: run
 *
 * Runs the application for the execution service module.
 ******************************************************************************/
  async run(workflowId, input = {}, options = {}) {
    // The self-healing LLM agent can take well over the default 30s timeout
    // (multiple tool calls, retries on failure) — give it room to finish
    // instead of the request being treated as a dead server mid-run.
    return normalizeExecution(
      unwrap(await apiClient.post(`/workflows/${workflowId}/run`, { input, ...options }, { timeout: 300000 })),
    );
  },
/*******************************************************************************
 * Function: retry
 *
 * Performs the retry operation on the application for the execution service module.
 ******************************************************************************/
  async retry(id, input = {}) {
    return normalizeExecution(unwrap(await apiClient.post(`/executions/${id}/retry`, { input }, { timeout: 300000 })));
  },
/*******************************************************************************
 * Function: approve
 *
 * Performs the approve operation on the application for the execution service module.
 ******************************************************************************/
  async approve(id, note = "") {
    // Approving resumes the LLM agent from where it stopped — same long-run
    // timeout as run/retry, not the default 30s.
    return normalizeExecution(unwrap(await apiClient.post(`/executions/${id}/approve`, { note }, { timeout: 300000 })));
  },
/*******************************************************************************
 * Function: reject
 *
 * Performs the reject operation on the application for the execution service module.
 ******************************************************************************/
  async reject(id, reason = "") {
    return normalizeExecution(unwrap(await apiClient.post(`/executions/${id}/reject`, { reason })));
  },
};
