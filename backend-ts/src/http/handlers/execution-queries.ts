import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { fail, ok } from "../../models/schemas.js";
import { publicExecution } from "../../redact/public-model-usage.js";
import { getRunAdmissionReceipt } from "./run-admission-receipts.js";
import { executionReviewInbox } from "../../runner/execution-review-inbox.js";
import { operationReconciliationView, hasOperationReconciliation } from "../../runner/operation-reconciliation.js";
import { hasReportPageResolution } from "../../runner/report-page-resolution.js";
import { runtimeApprovalAdministration, runtimeApprovalView } from "../../runner/runtime-approvals.js";
import { protectedApprovalView } from "../../runner/protected-approval-review.js";
import { buildTraceChain } from "../trace-chain.js";
import { visibleExecutions } from "../execution-scope.js";
import type { RouteDefinition } from "../generated-routes.js";
import { isTraceId } from "../../trace/request-trace.js";
import { HandlerFailure, isRecord, requestParam, stringValue, type CurrentUser, type HandlerServices } from "./common.js";
import type { RepositoryState } from "../../repository/store.js";
import { readableExecution } from "./execution-events.js";
import { executionListPage } from "../execution-filters.js";
import { executionRetryView } from "../../runner/execution-retry.js";

export const EXECUTION_QUERY_UNHANDLED = Symbol("execution-query-unhandled");

/** Owns read-only execution lists, details, review inbox and approval policy views. */
export async function handleExecutionQueryRoute(
  route: RouteDefinition,
  request: FastifyRequest,
  reply: FastifyReply,
  user: CurrentUser,
  services: HandlerServices,
): Promise<unknown | typeof EXECUTION_QUERY_UNHANDLED> {
  const base = services.config.apiBasePath;
  if (route.path === `${base}/workflows/:id/run-receipts/:key` && route.method === "GET") return getRunAdmissionReceipt(request, reply, user, services);
  if (route.path === `${base}/executions` && route.method === "GET") return listExecutions(request, reply, user, services);
  if (route.path === `${base}/execution-reviews` && route.method === "GET") return reviewInbox(request, reply, user, services);
  if (route.path === `${base}/settings/runtime-approval-policy` && route.method === "GET") return approvalPolicy(request, reply, user, services);
  if (route.path === `${base}/executions/:id` && route.method === "GET") return getExecution(request, reply, user, services);
  return EXECUTION_QUERY_UNHANDLED;
}

async function listExecutions(request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown> {
  const state = await services.repository.snapshot();
  const result = projectExecutionList(state, user, request.query as Record<string, unknown>);
  return reply.send(ok(result.items, "OK", result.meta));
}

/** Visibility and filtering from one current committed image. No dispatcher,
 * repository authority marker or remote runtime is needed to display a page. */
export function projectExecutionList(state: Readonly<RepositoryState>, user: CurrentUser, query: Record<string, unknown>) {
  const traceId = stringValue(query.traceId).trim();
  if (traceId !== "") {
    if (!isTraceId(traceId)) throw new HandlerFailure(400, "Invalid trace ID");
    const chain = buildTraceChain(state, user, traceId);
    return { items: chain, meta: { traceId, count: chain.length } };
  }
  const page = executionListPage(visibleExecutions(user, Object.values(state.executions)), query);
  return { items: page.items.map(publicExecution), meta: page.meta };
}

async function reviewInbox(request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown> {
  let page;
  try { page = await services.repository.readAuthoritative((state) => executionReviewInbox(state, user, request.query, services.config.jwtSecret, services)); }
  catch (error) {
    try { services.repository.assertAuthority(); }
    catch { throw new HandlerFailure(503, "The review inbox is unavailable until authoritative storage is recovered. No tasks or actions are confirmed."); }
    throw error;
  }
  return reply.send(ok(page, "Current minimum review tasks; no decision or dispatch authority", null));
}

async function approvalPolicy(request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown> {
  if (!isRecord(request.query) || Object.keys(request.query).length) throw new HandlerFailure(400, "Approval settings do not accept query overrides");
  let view;
  try { view = await services.repository.readAuthoritative((state) => runtimeApprovalAdministration(state, user)); }
  catch (error) {
    try { services.repository.assertAuthority(); }
    catch { throw new HandlerFailure(503, "Approval settings are unavailable until authoritative storage is recovered. No policy is confirmed."); }
    throw error;
  }
  return reply.send(ok({ ...view, memoryOnly: services.repository.persistence === null }, "Current exact approval policy; no execution authority", null));
}

async function getExecution(request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown> {
  const id = requestParam(request, "id");
  const query = isRecord(request.query) ? request.query : {};
  if (query.view === "reconciliation") {
    if (Object.keys(query).some((key) => key !== "view")) throw new HandlerFailure(400, "Unsupported reconciliation review query");
    const review = await services.repository.readAuthoritative((state) => operationReconciliationView(state, id, user.id));
    return reply.send(ok(review, "Exact uncertain operation evidence only; no dispatch authority", null));
  }
  if (query.view === "approval") {
    if (Object.keys(query).some((key) => !["view", "approvalId"].includes(key)) ||
        query.approvalId !== undefined && !z.string().min(1).max(256).safeParse(query.approvalId).success)
      throw new HandlerFailure(400, "Unsupported approval review query");
    const review = await services.repository.readAuthoritative((state) => state.executions[id]?.protectedJobSecret || state.executions[id]?.protectedApprovalSecret
      ? protectedApprovalView(state, services, id, user, query.approvalId as string | undefined)
      : runtimeApprovalView(state, id, user.id, query.approvalId as string | undefined));
    return reply.send(ok(review, "Exact transaction review only; approval does not execute", null));
  }
  const item = await services.repository.read(state => projectExecutionProgress(state, user, id));
  return reply.send(ok(item, "OK", null));
}

export function projectExecutionProgress(state: Readonly<RepositoryState>, user: CurrentUser, id: string) {
  const item = readableExecution(state, user, id);
  return { ...publicExecution({ ...item,
    ...(item.runtimeApprovalSecret || item.protectedApprovalSecret ? { hasRuntimeApproval: true } : {}),
    ...(hasOperationReconciliation(item) ? { hasOperationReconciliation: true } : {}),
    ...(hasReportPageResolution(item) ? { hasReportPageResolution: true } : {}),
  }), retryAdmission: executionRetryView(state, user, item) };
}
