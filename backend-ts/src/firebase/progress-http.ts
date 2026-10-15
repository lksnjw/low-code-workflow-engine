import Fastify from "fastify";
import cors from "@fastify/cors";
import { isMcpConfigured, type AppConfig } from "../config/config.js";
import { effectiveUserFromState, type RepositoryState } from "../repository/store.js";
import { openFirestoreProgressReader, type ProgressSnapshotReader } from "../storage/firestore-progress-reader.js";
import { authenticate, publicAuthenticatedUser } from "../http/handlers/authentication.js";
import { chatSummary, getChat, listChats } from "../http/handlers/chat-sessions.js";
import { getWorkflow, listWorkflows } from "../http/handlers/workflow-runtime.js";
import { getWorkflowYAML } from "../http/handlers/workflows.js";
import { projectChatProgress, projectSessionOperations } from "../agent/chat-progress.js";
import { executionLogs, executionTimeline } from "../http/handlers/uploads-executions.js";
import { projectExecutionList, projectExecutionProgress } from "../http/handlers/execution-queries.js";
import { projectExecutionEventPage, progressInteger } from "../http/handlers/execution-events.js";
import { HandlerFailure, type CurrentUser } from "../http/handlers/common.js";
import { routePolicy } from "../http/route-policy.js";
import { initializeRequestTrace, requestTraceId } from "../trace/request-trace.js";
import { fail, ok } from "../models/schemas.js";
import type { FunctionHttpRequest, FunctionHttpResponse } from "./http.js";
import { setTimeout as pause } from "node:timers/promises";
import { configuredModelCatalog } from "../providers/catalog.js";
import { listNotifications } from "../http/handlers/notifications.js";
import { canReviewChat, chatAccess } from "../http/chat-scope.js";
import { borrowProgressReader } from "./progress-reader-pool.js";
import { libraryRequest, publicAttachment } from "../documents/library-client.js";
import { executionReviewInbox } from "../runner/execution-review-inbox.js";
import { projectPersonalDashboard } from "../http/handlers/personal-dashboard.js";
import { supportsScopedProgress, type ScopedProgressView } from "../storage/firestore-scoped-progress.js";

const paths = ["/api/executions/:id", "/api/executions/:id/events", "/api/executions/:id/logs", "/api/executions/:id/timeline",
  "/api/chat/operations/:id", "/api/chat/sessions/:id/operations", "/api/chat/sessions/:id",
  "/api/workflows/:id", "/api/workflows/:id/yaml", "/api/chat/models", "/api/chat/capabilities", "/api/chat/sessions", "/api/workflows", "/api/auth/me", "/api/notifications",
  "/api/pipeline/v1/library/catalog", "/api/pipeline/v1/library/inventory", "/api/chat/sessions/:id/attachments", "/api/chat/sessions/:id/attachments/:uploadId",
  "/api/health", "/api/executions", "/api/execution-reviews", "/api/dashboard/tasks"] as const;
const patterns = paths.map(path => new RegExp(`^${path.replace(/:[A-Za-z]+/g, "[^/?#]+")}/?$`));
const active = new Set(["PENDING", "RUNNING", "AWAITING_APPROVAL"]);
const ACTIVE_CHAT_STATUSES = new Set(["QUEUED", "RUNNING"]);

/** Only an internal fallback to the existing service-backed read, never a
 * grant of mutation/approval authority to this snapshot projection. */
export class FunctionServiceReadRequired extends Error {}

/** Fixed safe route inventory, never an alternate dispatcher for arbitrary GETs.
 * Exact approval/reconciliation views retain their service-backed authority path. */
export function isFunctionProgressRequest(config: AppConfig, request: FunctionHttpRequest): boolean {
  if (config.storageDriver !== "firestore-records" || config.apiBasePath !== "/api" || !["GET", "HEAD", "OPTIONS"].includes(request.method)) return false;
  const [path, search] = request.url.split("?", 2);
  // Reserved static routes are not workflow IDs or committed-source views.
  if (/^\/api\/workflows\/(templates|assignable-users)\/?$/.test(path!)) return false;
  if (!patterns.some(pattern => pattern.test(path!))) return false;
  if (patterns[0]!.test(path!)) {
    const views = new URLSearchParams(search).getAll("view");
    if (views.length === 1 && ["approval", "reconciliation"].includes(views[0]!)) return false;
  }
  return true;
}

/** Builds only authentication/projection handlers: no application services,
 * registry startup, writable Repository, worker/outbox or MCP/provider client.
 * Native screens use one coherent scoped auth + target-record transaction.
 * Exceptional legacy/trace contracts retain their original complete image. */
export async function handleFunctionProgress(config: AppConfig, request: FunctionHttpRequest,
  open: () => ProgressSnapshotReader = () => borrowProgressReader(config), options: { chatTaskAdmissionAvailable?: boolean } = {}): Promise<FunctionHttpResponse> {
  if (!isFunctionProgressRequest(config, request)) throw new Error("Not a read-only progress request");
  const app = Fastify({ logger: false, bodyLimit: 1024, exposeHeadRoutes: true });
  let reader: ProgressSnapshotReader | undefined;
  let serviceReadRequired = false;
  const deadline = Date.now() + 60_000;
  try {
    await app.register(cors, { origin: config.corsOrigins, credentials: true,
      allowedHeaders: ["Origin", "Content-Type", "Accept", "Authorization"], methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"] });
    app.addHook("onRequest", async req => { initializeRequestTrace(req); });
    app.addHook("onSend", async (req, reply, payload) => {
      reply.header("cache-control", "no-store"); reply.header("x-trace-id", requestTraceId(req)); return payload;
    });
    app.setErrorHandler((error, req, reply) => {
      if (error instanceof FunctionServiceReadRequired) {
        serviceReadRequired = true;
        return reply.status(503).send(fail("Current service-backed review is required", null));
      }
      if (error instanceof HandlerFailure) return reply.status(error.status).send(fail(error.message, error.meta));
      const status = error instanceof Error ? (error as Error & { statusCode?: number }).statusCode : undefined;
      if (status && status >= 400 && status < 500) return reply.status(status).send(fail("Invalid progress request", null));
      if (req.routeOptions.url === "/api/chat/models") return reply.status(503).send(fail(
        "Configured chat models are unavailable. No provider was activated and no work was submitted.", { code: "FUNCTIONS_MODEL_CATALOG_UNAVAILABLE" }));
      return reply.status(503).send(fail("Committed progress is unavailable. Reconnect to the original run; no work was resubmitted.", { code: "FUNCTIONS_PROGRESS_UNAVAILABLE" }));
    });
    for (const path of paths) app.get(path, async (req, reply) => {
      if (request.rawBody?.length || req.headers["transfer-encoding"] || req.headers["content-length"] && req.headers["content-length"] !== "0")
        throw new HandlerFailure(400, "Progress queries do not accept a body");
      const id = (req.params as { id: string }).id, query = req.query as Record<string, unknown>;
      const allowed = path.endsWith("/events") ? ["after", "limit", "waitMs"] : path === "/api/chat/operations/:id" ? ["after", "waitMs"] : path === "/api/chat/sessions/:id" ? ["limit", "before"] : path === "/api/chat/sessions" ? ["page", "limit", "after"] : path === "/api/workflows" ? ["page", "limit", "q", "status", "relevance", "sort"] : path === "/api/notifications" ? ["page", "limit", "unreadOnly"] : path === "/api/executions" ? ["q", "status", "range", "workflowId", "chatSessionId", "traceId", "limit"] : path === "/api/execution-reviews" ? ["kind", "state", "limit", "cursor"] : path === "/api/dashboard/tasks" ? ["month", "timezone"] : [];
      if (Object.keys(query).some(key => !allowed.includes(key)) || Object.values(query).some(value => typeof value !== "string")) throw new HandlerFailure(400, "Unsupported progress query");
      let state: RepositoryState | undefined;
      let scopedView: ScopedProgressView | undefined;
      if (path === "/api/health") {
        // This public endpoint is a storage-read/liveness probe, not proof of
        // write admission, model availability or a working ERP connection.
        reader ??= open();
        if(reader.probe)await reader.probe();
        else await reader.snapshot({ timeoutMs: Math.min(30_000, deadline - Date.now()), ...(request.signal ? { signal: request.signal } : {}) });
        return reply.send(ok({ service: config.appName, environment: config.environment, status: "healthy",
          storage: { driver: config.storageDriver, durable: true, status: "healthy", scope: "committed-read", writeReadiness: "not-checked" },
          mcpMode: config.mcpMode, mcpBackend: isMcpConfigured(config) ? "configured" : "unconfigured", time: new Date().toISOString(),
        }, "Committed storage is readable; writer admission and remote services were not checked", null));
      }
      // The shared JWT verifier calls this only after a valid signed subject.
      // Permission resolution and target projection then use this same image.
      const loadUser = async () => authenticate(req, reply, { config, repository: { effectiveUser: async subject => {
        if (request.signal?.aborted || Date.now() >= deadline) throw new Error("Progress request ended");
        reader ??= open();
        if(reader.scoped && supportsScopedProgress(path,query)) {
          scopedView=await reader.scoped(subject,{path,id,query},request.signal);
          state=scopedView.state;
        } else state = await reader.snapshot({ timeoutMs: Math.min(30_000, deadline - Date.now()), ...(request.signal ? { signal: request.signal } : {}) });
        return effectiveUserFromState(state, subject);
      } } });
      const authorize = (user: CurrentUser) => {
        const policy = routePolicy({ method: "GET", path });
        if (policy && !policy.required.some(permission => user.permissions.includes(permission))) throw new HandlerFailure(403, "Permission denied", policy.any ? { requiredAny: policy.required } : { required: policy.required[0] });
      };
      const auth = await loadUser(); if (!auth) return reply;
      authorize(auth.user);
      if (path === "/api/executions") {
        const page = projectExecutionList(state!, auth.user, query);
        return reply.send(ok(page.items, "OK", page.meta));
      }
      if (path === "/api/dashboard/tasks") return reply.send(ok(projectPersonalDashboard(state!, auth.user, query),
        "Saved personal tasks and confirmed schedule dates; no execution authority", null));
      if (path === "/api/execution-reviews") {
        // Protected historical proofs require the original current service
        // context. Preserve that route, rather than downgrading its evidence.
        if (Object.values(state!.executions).some(run => run.startedBy.id !== auth.user.id && run.protectedApprovalSecret))
          throw new FunctionServiceReadRequired();
        return reply.send(ok(executionReviewInbox(state!, auth.user, query, config.jwtSecret),
          "Current minimum review tasks; no decision or dispatch authority", null));
      }
      if (path === "/api/pipeline/v1/library/catalog" || path === "/api/pipeline/v1/library/inventory" || path === "/api/chat/sessions/:id/attachments" || path === "/api/chat/sessions/:id/attachments/:uploadId") {
        // Listing documents is not a workflow mutation. Do not contend for the
        // namespace writer while a model or ERP worker is running. Only these
        // fixed reads use this lane; upload, OCR recovery and confirmation stay
        // on their existing audited mutation path.
        const assertDocumentAccess = (user: CurrentUser) => {
          if (!user.permissions.includes("pipeline:upload")) throw new HandlerFailure(403, "Your role cannot upload or review documents");
          if (path.includes("/attachments") && (state!.chats[id]?.ownerId !== user.id || !user.permissions.some(permission => ["chat:use", "workflow:write"].includes(permission))))
            throw new HandlerFailure(404, "This chat's attachments are not available");
        };
        assertDocumentAccess(auth.user);
        const uploadId = (req.params as { uploadId?: string }).uploadId;
        const upstream = uploadId ? `/uploads/${encodeURIComponent(uploadId)}?include_text=true` : path.endsWith("/attachments") ? `/uploads?session_id=${encodeURIComponent(id)}` : path.endsWith("/catalog") ? "/catalog" : "/inventory";
        const result = await libraryRequest({ config, repository: {} }, auth.user, upstream, { readOnly: true, timeoutMs: Math.min(20_000, Math.max(1, deadline - Date.now())) });
        const fresh = await loadUser(); if (!fresh) return reply;
        authorize(fresh.user); assertDocumentAccess(fresh.user);
        if (fresh.user.role !== auth.user.role) throw new HandlerFailure(409, "Your document role changed. Refresh before continuing.");
        if (uploadId && result.session_id !== id) throw new HandlerFailure(404, "This attachment is not in this chat");
        return reply.send(uploadId ? { ...publicAttachment(result), extracted_text: result.extracted_text } : path.endsWith("/attachments") ? { items: (result.items ?? []).map(publicAttachment) } : result);
      }
      if (path === "/api/auth/me") return reply.send(ok(publicAuthenticatedUser(auth.user), "OK", null));
      if (path === "/api/chat/capabilities") {
        // Only the actual Functions composition can attest an installed
        // task transport. This is admission support, never remote readiness.
        if(!auth.user.permissions.some(value=>["chat:use","workflow:write"].includes(value)))throw new HandlerFailure(403,"Chat authority is not available");
        const supported=options.chatTaskAdmissionAvailable===true;
        return reply.send(ok({profile:"chat-admission-v1",asyncChat:supported,nodeProposals:supported,requestRevisions:supported,localDraftEdits:true},"Chat admission capabilities; not provider or ERP readiness",null));
      }
      if (path === "/api/chat/models") return reply.send(ok(configuredModelCatalog(state!, config),
        "Configured chat models loaded; runtime activation and remote compatibility are not certified",
        { source: "committed-configuration", runtimeActivationConfirmed: false }));
      const view = { repository: { read: async <T>(project: (value: Readonly<RepositoryState>) => T): Promise<T> => project(state!) } };
      if (path === "/api/chat/sessions") {
        if(scopedView?.chatPage)return reply.send(ok(scopedView.chatPage.items,"OK",scopedView.chatPage.meta));
        // Numeric pages remain compatible. New clients use a keyset cursor,
        // avoiding Firestore offsets and repeated downloads of older pages.
        if (reader?.metadataPage && (query.after !== undefined || query.page === undefined || query.page === "1")) {
          const limit = query.limit === undefined ? 20 : progressInteger(query.limit,1,200);
          let after: {updatedAt:string;entityId:string}|undefined;
          if (query.after !== undefined) {
            try {
              const raw=String(query.after); if(raw.length>1024) throw new Error();
              const value=JSON.parse(Buffer.from(raw,"base64url").toString("utf8"));
              if(!value || Object.keys(value).sort().join("|")!=="entityId|updatedAt" || typeof value.entityId!=="string" || typeof value.updatedAt!=="string") throw new Error();
              const cursor=state!.chats[value.entityId];
              if(!cursor || !canReviewChat(auth.user,cursor) || cursor.updatedAt!==value.updatedAt) throw new Error();
              after=value;
            } catch { throw new HandlerFailure(400,"Conversation cursor changed. Reload the first page.",{code:"CHAT_LIST_CURSOR_INVALID"}); }
          }
          const all=Object.values(state!.chats).filter(chat=>canReviewChat(auth.user,chat));
          const owner=auth.user.role==="Platform Admin" ? undefined : auth.user.id;
          const records=await reader.metadataPage(state!,"chats",owner,limit+1,after);
          const items=records.slice(0,limit).map(record=> {
            const value=state!.chats[record.path[2]!];
            if(!value || !canReviewChat(auth.user,value)) throw new Error("Native query authorization differs");
            return {...chatSummary(value),access:chatAccess(auth.user,value)};
          });
          const lastRecord=records.slice(0,limit).at(-1), last=lastRecord ? state!.chats[lastRecord.path[2]!] : undefined;
          const nextCursor=records.length>limit && last ? Buffer.from(JSON.stringify({updatedAt:last.updatedAt,entityId:last.id})).toString("base64url") : null;
          const page=query.page===undefined ? 1 : progressInteger(query.page,1,Number.MAX_SAFE_INTEGER);
          return reply.send(ok(items,"OK",{page,limit,total:all.length,totalPages:Math.ceil(all.length/limit),nextCursor,indexed:true}));
        }
        return listChats(req, reply, auth.user, view);
      }
      if (path === "/api/workflows") return listWorkflows(req, reply, auth.user, view);
      if (path === "/api/notifications") return listNotifications(req, reply, auth.user, view);
      if (path === "/api/workflows/:id") return getWorkflow(req, reply, auth.user, view);
      if (path === "/api/workflows/:id/yaml") return getWorkflowYAML(req, reply, auth.user, view);
      if (path === "/api/chat/sessions/:id") return scopedView?.messagePage ? reply.send(ok(scopedView.messagePage,"OK",null)) : getChat(req, reply, auth.user, view);
      const withCancellation = async (operation: ReturnType<typeof projectChatProgress>["operation"]) => {
        const stored = state!.chatOperations[operation.id];
        if (["QUEUED", "RUNNING"].includes(operation.status) && !operation.cancellationRequested && stored?.taskDispatchSecret &&
            await reader?.cancellationRequested?.(stored, request.signal)) return { ...operation, cancellationRequested: true };
        return operation;
      };
      if (path === "/api/chat/sessions/:id/operations") {
        const values = projectSessionOperations(state!, auth.user, id);
        return reply.send(ok(await Promise.all(values.map(withCancellation)), "Saved chat operations loaded", null));
      }
      if (path === "/api/chat/operations/:id") {
        const after = query.after ?? "0", waitMs = query.waitMs === undefined ? 0 : progressInteger(query.waitMs, 0, 25_000);
        const started = Date.now(); let progress = projectChatProgress(state!, auth.user, id, after), waited = false;
        const initial = `${progress.operation.lastSequence}:${progress.operation.status}:${progress.operation.stage}`;
        while (waitMs > 0 && !progress.events.length && !progress.hasMore && ACTIVE_CHAT_STATUSES.has(progress.operation.status) &&
          Date.now() - started < waitMs && `${progress.operation.lastSequence}:${progress.operation.status}:${progress.operation.stage}` === initial) {
          waited = true;
          await pause(Math.min(1000, waitMs - (Date.now() - started)), undefined, request.signal ? { signal: request.signal } : {});
          const fresh = await loadUser(); if (!fresh) return reply; authorize(fresh.user);
          progress = projectChatProgress(state!, fresh.user, id, after);
        }
        return reply.send(ok({ ...progress, operation: await withCancellation(progress.operation), waited, waitedMs: waited ? Date.now() - started : 0 },
          waited ? "Chat progress long poll" : "Chat operation progress loaded", null));
      }
      if (path.endsWith("/logs")) return executionLogs(req, reply, auth.user, view);
      if (path.endsWith("/timeline")) return executionTimeline(req, reply, auth.user, view);
      if (path === "/api/executions/:id") return reply.send(ok(projectExecutionProgress(state!, auth.user, id), "OK", null));
      const after = query.after === undefined ? 0 : progressInteger(query.after, 0, Number.MAX_SAFE_INTEGER);
      const limit = query.limit === undefined ? 100 : progressInteger(query.limit, 1, 100);
      const waitMs = query.waitMs === undefined ? 0 : progressInteger(query.waitMs, 0, 25_000);
      const started = Date.now();
      let page = projectExecutionEventPage(state!, auth.user, id, after, limit), waited = false;
      const initial = `${page.lastSequence}:${page.status}:${page.profile}`;
      while (waitMs > 0 && !page.events.length && !page.hasMore && active.has(page.status) && Date.now() - started < waitMs && `${page.lastSequence}:${page.status}:${page.profile}` === initial) {
        waited = true;
        await pause(Math.min(1000, waitMs - (Date.now() - started)), undefined, request.signal ? { signal: request.signal } : {});
        const fresh = await loadUser(); if (!fresh) return reply;
        authorize(fresh.user);
        page = projectExecutionEventPage(state!, fresh.user, id, after, limit);
      }
      return reply.send(ok({ ...page, waited, waitedMs: waited ? Date.now() - started : 0 }, waited ? "Execution event long poll" : "Execution event replay", null));
    });
    const result = await app.inject({ method: request.method as "GET" | "HEAD" | "OPTIONS", url: request.url, headers: request.headers,
      ...(request.ip ? { remoteAddress: request.ip } : {}) });
    if (serviceReadRequired) throw new FunctionServiceReadRequired();
    return { statusCode: result.statusCode, headers: result.headers, body: result.rawPayload };
  } finally {
    try { await app.close(); } finally { await reader?.close(); }
  }
}
