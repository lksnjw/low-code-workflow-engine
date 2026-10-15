import { z } from "zod";
import type { Execution } from "../repository/store.js";
import { HandlerFailure } from "./handlers/common.js";

const filters = z.object({ q: z.string().max(256).optional(), status: z.enum(["", "PENDING", "RUNNING", "AWAITING_APPROVAL", "DONE", "FAILED", "HEALING", "CANCELLED", "REJECTED", "RECOVERY_REQUIRED", "RECONCILIATION_REQUIRED", "RECONCILED", "BLOCKED"]).optional(),
  range: z.enum(["", "24h", "7d", "30d"]).optional(), workflowId: z.string().max(256).optional(), chatSessionId: z.string().max(256).optional(), traceId: z.string().max(128).optional(),
  limit: z.union([z.number(), z.string().regex(/^\d{1,3}$/).transform(Number)]).pipe(z.number().int().min(1).max(200)).optional() }).strict();

/** Call after execution visibility filtering; filters cannot broaden access. */
export function filterExecutions(executions: readonly Execution[], query: unknown, now = Date.now()) {
  return executionListPage(executions, query, now).items;
}

/** Bound and project the page only after the caller applies visibility checks.
 * Legacy callers without a limit retain their existing complete-list behavior. */
export function executionListPage(executions: readonly Execution[], query: unknown, now = Date.now()) {
  const parsed = filters.safeParse(query);
  if (!parsed.success) throw new HandlerFailure(400, "Invalid execution search, status or time range");
  const { q = "", status = "", range = "", workflowId = "", chatSessionId = "", limit } = parsed.data;
  const term = q.trim().toLowerCase(), days = range === "24h" ? 1 : range === "7d" ? 7 : range === "30d" ? 30 : null;
  const matching = executions.filter(run => (!status || run.status === status) && (!workflowId || run.workflowId === workflowId) && (!chatSessionId || run.chatSessionId === chatSessionId) &&
    (!term || `${run.id} ${run.workflowName}`.toLowerCase().includes(term)) &&
    (days === null || Number.isFinite(Date.parse(run.startedAt)) && Date.parse(run.startedAt) >= now - days * 86400000))
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt) || a.id.localeCompare(b.id));
  const pageLimit = limit ?? (matching.length || 20);
  return { items: matching.slice(0, pageLimit), meta: { page: 1, limit: pageLimit, total: matching.length, totalPages: Math.ceil(matching.length / pageLimit) } };
}
