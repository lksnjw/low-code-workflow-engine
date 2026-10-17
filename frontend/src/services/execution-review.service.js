import { apiClient } from "../config/axios";
import { unwrap } from "./api";

const kinds = ["approval", "reconciliation"];
const validDate = value => typeof value === "string" && Number.isFinite(Date.parse(value));
const bounded = (value, max = 256) => typeof value === "string" && value.length > 0 && value.length <= max;
export function validateReviewInbox(value, params = {}) {
  const kind = params.kind || "all", state = params.state || "open";
  if (value?.profile !== "execution-review-inbox/v1" || value.kind !== kind || value.state !== state ||
      !["all", ...kinds].includes(kind) || !["open", "closed"].includes(state) || value.canResume !== false || value.noReplay !== true ||
      !validDate(value.asOf) || typeof value.scopes?.approval !== "boolean" || typeof value.scopes?.reconciliation !== "boolean" ||
      !Array.isArray(value.items) || value.items.length > (params.limit || 25) || value.items.length > 50 || typeof value.hasMore !== "boolean" ||
      (value.hasMore ? !bounded(value.nextCursor, 2048) || value.items.length === 0 : value.nextCursor !== null))
    throw new Error("The review inbox response is incomplete. Reload before opening a task.");
  const keys = new Set();
  for (const item of value.items) {
    const key = `${item.kind}:${item.executionId}:${item.reviewId}`;
    if (!bounded(item.executionId) || !bounded(item.reviewId) || !kinds.includes(item.kind) || kind !== "all" && item.kind !== kind || item.state !== state ||
        !["approval", "protected-approval", "reconciliation", "report-page"].includes(item.reviewView) || item.kind === "approval" !== (["approval", "protected-approval"].includes(item.reviewView)) ||
        !value.scopes[item.kind] || !bounded(item.workflowName, 200) || !bounded(item.requesterName, 200) || !bounded(item.toolName, 200) ||
        !bounded(item.executionStatus) || !bounded(item.statusLabel, 200) || !bounded(item.detail, 2000) || !validDate(item.requestedAt) ||
        item.scheduledFor !== undefined && item.scheduledFor !== null && !validDate(item.scheduledFor) ||
        item.expiresAt !== null && !validDate(item.expiresAt) || item.nodeId !== null && !bounded(item.nodeId) ||
        typeof item.reviewAvailable !== "boolean" || typeof item.actionable !== "boolean" || item.canResume !== false || item.noReplay !== true ||
        item.actionable && (!item.reviewAvailable || state !== "open") || keys.has(key))
      throw new Error("The review inbox contains inconsistent tasks. Reload before opening a task.");
    keys.add(key);
  }
  return value;
}
export async function getReviewInbox(params = {}, signal) {
  return validateReviewInbox(unwrap(await apiClient.get("/execution-reviews", { params, signal })), params);
}
