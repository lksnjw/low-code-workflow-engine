import { apiClient } from "../config/axios";
import { formatDuration, formatTokens, unwrap } from "./api";
import { recordedModelUsage } from "../utils/recordedModelUsage";
import { runAdmissionService } from "./run-admission.service";
import { validProtectedApprovalReview } from "./protected-approval-review";

const reconciliationId = value => typeof value === "string" && value.length > 0 && value.length <= 256;
const reconciliationDate = value => typeof value === "string" && Number.isFinite(Date.parse(value));
const reconciliationExact = (value, keys) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
const reconciliationOutcomes = ["APPLIED", "NOT_APPLIED", "UNRESOLVED"];
const hash = value => typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
function validReconciliationHistory(records, state) {
  if (!Array.isArray(records) || records.length > 100) return false;
  const ids = new Set();
  for (const record of records) {
    const common = reconciliationId(record?.id) && reconciliationOutcomes.includes(record?.outcome) && reconciliationId(record?.actorId) && reconciliationDate(record?.recordedAt);
    if (!common || ids.has(record.id)) return false;
    ids.add(record.id);
    if (record.basis === "operator-attestation") {
      if (!reconciliationExact(record, ["id", "outcome", "evidence", "actorId", "recordedAt", "basis"]) ||
          !reconciliationExact(record.evidence, ["kind", "reference", "note", "observedAt"]) || !["erp-record", "delivery-audit", "external-support"].includes(record.evidence.kind) ||
          typeof record.evidence.reference !== "string" || !record.evidence.reference || typeof record.evidence.note !== "string" || !record.evidence.note || !reconciliationDate(record.evidence.observedAt)) return false;
    } else if (record.basis === "queried-operation-state") {
      const observation = record.observation;
      if (!reconciliationExact(record, ["id", "outcome", "queryId", "observation", "actorId", "recordedAt", "basis"]) || !reconciliationId(record.queryId) ||
          !reconciliationExact(observation, ["profile", "outcome", "observedAt", "settled", "evidenceMeaning", "canResume", "noReplay", "deliveryVerified"]) ||
          observation.profile !== "operation-readback-evaluation/v1" || observation.outcome !== record.outcome || !["APPLIED", "NOT_APPLIED"].includes(observation.outcome) ||
          !reconciliationDate(observation.observedAt) || observation.settled !== true || observation.evidenceMeaning !== "operation-state" || observation.canResume !== false || observation.noReplay !== true || observation.deliveryVerified !== false) return false;
    } else return false;
  }
  const resolved = records.length > 0 && records.at(-1).outcome !== "UNRESOLVED";
  return resolved === (state === "RESOLVED") && records.slice(0, -1).every(record => record.outcome === "UNRESOLVED");
}

/*******************************************************************************
 * Function: normalizeExecution
 *
 * Normalizes execution for the execution service module.
 ******************************************************************************/
export function normalizeExecution(execution) {
  const recordedUsage = recordedModelUsage(execution.tokens);
  return {
    ...execution,
    workflow: execution.workflowName,
    started: execution.startedAt ? new Date(execution.startedAt).toLocaleString() : "—",
    duration: formatDuration(execution.durationMs),
    recordedUsage,
    tokens: recordedUsage ? formatTokens(recordedUsage.total) : "Not reported",
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
  async get(id, options = {}) {
    return normalizeExecution(unwrap(await apiClient.get(`/executions/${encodeURIComponent(id)}`, options)));
  },
  async getApproval(id, approvalId, options = {}) {
    const value = unwrap(await apiClient.get(`/executions/${encodeURIComponent(id)}`, { ...options, params: { view: "approval", ...(approvalId ? { approvalId } : {}) } }));
    const protectedReview = value?.runtimeApproval?.profile === "protected-approval/v1";
    if (value?.id !== id || (protectedReview ? !validProtectedApprovalReview(value.runtimeApproval, value.status)
      : value?.runtimeApproval?.profile !== "runtime-approval/v1" || !["PENDING", "APPROVED", "REJECTED", "CONSUMED"].includes(value.runtimeApproval.state)) ||
        !Number.isSafeInteger(value.runtimeApproval.version) || value.runtimeApproval.version < 1 || !/^sha256:[a-f0-9]{64}$/.test(value.runtimeApproval.reviewHash) ||
        typeof value.runtimeApproval.canDecide !== "boolean" || value.runtimeApproval.canResume !== false || approvalId && value.runtimeApproval.id !== approvalId || !value.runtimeApproval.arguments || typeof value.runtimeApproval.arguments !== "object" || Array.isArray(value.runtimeApproval.arguments))
      throw new Error("Exact transaction review is unavailable. Reload before deciding.");
    return value;
  },
  async getReconciliation(id) {
    const value = unwrap(await apiClient.get(`/executions/${encodeURIComponent(id)}`, { params: { view: "reconciliation" } }));
    const review = value?.operationReconciliation;
    if (value?.id !== id || review?.profile !== "operation-reconciliation/v1" || !["OPEN", "RESOLVED"].includes(review.state) ||
        !Number.isSafeInteger(review.version) || review.version < 1 || !/^sha256:[a-f0-9]{64}$/.test(review.factsHash) ||
        typeof review.canRecord !== "boolean" || review.state === "RESOLVED" && review.canRecord || review.canResume !== false || review.noReplay !== true || review.basis !== "operator-attestation" ||
        typeof review.intentId !== "string" || !review.intentId || !validReconciliationHistory(review.history, review.state) ||
        review.version !== review.history.length + 1 ||
        !review.arguments || typeof review.arguments !== "object" || Array.isArray(review.arguments))
      throw new Error("Exact uncertain-operation evidence is unavailable. Reload before recording a decision.");
    return value;
  },
  async reconcile(id, command) {
    return unwrap(await apiClient.post(`/executions/${encodeURIComponent(id)}/reconcile`, command));
  },
  async getReportPageResolution(id) {
    const value = unwrap(await apiClient.get(`/executions/${encodeURIComponent(id)}/report-page-resolutions`));
    const review = value?.reportPageResolution;
    const cursor = review?.continuationProfile === "opaque-cursor/v1";
    if (value?.id !== id || review?.profile !== "report-page-resolution-case/v1" || !["OPEN", "RESOLVED"].includes(review.state) ||
        !["page-number/v1", "opaque-cursor/v1"].includes(review.continuationProfile) || !Number.isSafeInteger(review.pointer) || review.pointer < 1 ||
        cursor !== hash(review.cursorHash) || !Number.isSafeInteger(review.confirmedPages) || review.confirmedPages < 0 ||
        !Number.isSafeInteger(review.confirmedItems) || review.confirmedItems < 0 || ![1, 2].includes(review.version) || !hash(review.factsHash) ||
        typeof review.canRecord !== "boolean" || typeof review.canResume !== "boolean" || review.noReplay !== true ||
        review.state === "OPEN" !== (review.version === 1) || review.state === "OPEN" && (!review.outputSchema || typeof review.outputSchema !== "object" || Array.isArray(review.outputSchema)) ||
        review.state === "RESOLVED" && (review.canRecord || review.outputSchema !== null) || !review.arguments || typeof review.arguments !== "object" || Array.isArray(review.arguments) ||
        !Array.isArray(review.history) || review.history.length > 100 || review.history.some(record => !reconciliationId(record?.id) || !reconciliationId(record.intentId) ||
          record.nodeId !== review.nodeId || !["PAGE_CONFIRMED", "ABANDONED"].includes(record.outcome) || !reconciliationId(record.actorId) ||
          !reconciliationDate(record.recordedAt) || !record.evidence || typeof record.evidence.reference !== "string" || !record.evidence.reference ||
          typeof record.evidence.note !== "string" || !record.evidence.note || !reconciliationDate(record.evidence.observedAt) ||
          record.outputHash !== null && !hash(record.outputHash)))
      throw new Error("Exact uncertain report-page evidence is unavailable. Reload before resolving it.");
    return value;
  },
  async resolveReportPage(id, command) {
    return unwrap(await apiClient.post(`/executions/${encodeURIComponent(id)}/report-page-resolutions`, command));
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
  async getTimeline(id, options = {}) {
    return unwrap(await apiClient.get(`/executions/${encodeURIComponent(id)}/timeline`, options), []);
  },
  async getEvents(id, after = 0, options = {}) {
    const { waitMs = 25000, ...requestOptions } = options;
    return unwrap(await apiClient.get(`/executions/${encodeURIComponent(id)}/events`, { ...requestOptions, params: { after, limit: 100, waitMs } }));
  },
  async cancel(id) {
    // 202 confirms a request, not an interrupted SDK transport or terminal run.
    return normalizeExecution(unwrap(await apiClient.post(`/executions/${encodeURIComponent(id)}/cancel`, {})));
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
    // Real runs share durable admission identity and read-only receipt recovery.
    // Dry-run requests cannot dispatch; their timeout is not a latency guarantee.
    if (options.dryRun) return normalizeExecution(unwrap(await apiClient.post(`/workflows/${workflowId}/run`, { input, ...options }, { timeout: 300000 })));
    return normalizeExecution(await runAdmissionService.admit(workflowId, input, options));
  },
/*******************************************************************************
 * Function: retry
 *
 * Performs the retry operation on the application for the execution service module.
 ******************************************************************************/
  async retry(id, acknowledgeUnconfirmed = false) {
    const original = await this.get(id);
    if (original.retryAdmission?.allowed !== true) throw new Error(original.retryAdmission?.reason || "This execution cannot be safely restarted.");
    return normalizeExecution(await runAdmissionService.admit(original.workflowId, undefined, {
      retry: { sourceExecutionId: id, acknowledgeUnconfirmed },
    }));
  },
/*******************************************************************************
 * Function: approve
 *
 * Performs the approve operation on the application for the execution service module.
 ******************************************************************************/
  async approve(id, command) {
    if (!command || typeof command !== "object") throw new Error("An exact transaction review is required; a note is not approval.");
    return unwrap(await apiClient.post(`/executions/${encodeURIComponent(id)}/approve`, command));
  },
/*******************************************************************************
 * Function: reject
 *
 * Performs the reject operation on the application for the execution service module.
 ******************************************************************************/
  async reject(id, command) {
    if (!command || typeof command !== "object") throw new Error("An exact transaction review is required before rejection.");
    return unwrap(await apiClient.post(`/executions/${encodeURIComponent(id)}/reject`, command));
  },
};
