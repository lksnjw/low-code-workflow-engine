import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type HTTPMethods,
} from "fastify";
import {
  fail,
  ok,
} from "../models/schemas.js";
import { ResourceMutations } from "./resource-mutations.js";
import { routeTable, type RouteDefinition } from "./generated-routes.js";
import { isPolicyCheckerEnabled, checkErpPolicy } from "../governance/rbac.js";
import {
  initializeRequestTrace,
  requestTraceId,
} from "../trace/request-trace.js";
import {
  ADMIN_UNHANDLED,
  handleAdministrationRoute,
} from "./handlers/administration.js";
import {
  ANALYTICS_UNHANDLED,
  handleAnalyticsCatalogRoute,
} from "./handlers/analytics-catalog.js";
import { readJobQueue, supportsReadJobs } from "../runner/read-jobs.js";
import { operationJobQueue, supportsOperationJobs } from "../runner/operation-jobs.js";
import { operationReadbackQueue } from "../runner/operation-readback-jobs.js";
import { chatJobQueue, supportsChatJobs } from "../agent/chat-jobs.js";
import { handleExecutionControlRoute, EXECUTION_CONTROL_UNHANDLED } from "./handlers/execution-control.js";
import { handleWorkflowScheduleRoute, WORKFLOW_SCHEDULE_UNHANDLED } from "./handlers/workflow-schedules.js";
import { workflowScheduleRunner } from "../runner/workflow-schedules.js";
import {
  REGISTRY_UNHANDLED,
  handleRegistryRoute,
} from "./handlers/registry.js";
import {
  RESOURCE_UNHANDLED,
  handleResourceRoute,
} from "./handlers/resources.js";
import {
  UPLOAD_EXECUTION_UNHANDLED,
  handleUploadExecutionRoute,
} from "./handlers/uploads-executions.js";
import {
  WORKFLOW_UNHANDLED,
  handleWorkflowRoute,
} from "./handlers/workflows.js";
import {
  HandlerFailure,
} from "./handlers/common.js";
import {
  authenticate,
  login,
  logout,
  publicAuthenticatedUser as publicUser,
  refresh,
  register,
} from "./handlers/authentication.js";
import { INVALID_JSON_BODY } from "./request-body.js";
import type { ApplicationServices } from "./application-services.js";
export type { ApplicationServices } from "./application-services.js";
import {
  createWorkflow,
  getWorkflow,
  listWorkflows,
  runWorkflow,
  validateWorkflowRoute,
} from "./handlers/workflow-runtime.js";
import { routePolicy } from "./route-policy.js";
import { attachSystemHealthSocket } from "./system-health-websocket.js";
import { isMcpConfigured } from "../config/config.js";
import { EXECUTION_QUERY_UNHANDLED, handleExecutionQueryRoute } from "./handlers/execution-queries.js";
import { handleNotificationRoute, NOTIFICATION_UNHANDLED } from "./handlers/notifications.js";
import { handlePipelineGatewayRoute, PIPELINE_GATEWAY_UNHANDLED } from "./handlers/pipeline-gateway.js";
import { handleChatDocumentRoute, CHAT_DOCUMENTS_UNHANDLED } from "./handlers/chat-documents.js";
import { handleRagPolicyRoute, RAG_POLICY_UNHANDLED } from "./handlers/rag-policy.js";
import { bindExecutionHost, type ExecutionHostMode } from "../runner/execution-host.js";

const publicRoutes = new Set([
  "GET /healthz",
  "GET /api/health",
  "POST /api/auth/login",
  "POST /api/auth/register",
  "POST /api/auth/refresh",
  "POST /api/auth/forgot-password",
  "POST /api/auth/reset-password",
  "POST /api/auth/verify-email",
  "GET /api/auth/oauth/:provider/authorize",
  "GET /api/auth/oauth/:provider/callback",
]);

const malformedJSONMessages = new Map<string, string>([
  ...[
    "POST /api/canvas/validate-workflow",
    "POST /api/chat/sessions",
    "PATCH /api/chat/sessions/:id",
    "POST /api/chat/sessions/:id/messages",
    "POST /api/integrations",
    "PATCH /api/integrations/:id",
    "PATCH /api/profile",
    "POST /api/profile/api-keys",
    "POST /api/roles",
    "PATCH /api/roles/:id",
    "PUT /api/roles/:id",
    "PATCH /api/settings",
    "PATCH /api/settings/general",
    "PATCH /api/settings/llm",
    "PATCH /api/settings/rbac",
    "POST /api/settings/webhooks",
    "PATCH /api/settings/webhooks/:id",
    "POST /api/synthesis",
    "POST /api/synthesis/explain",
    "POST /api/synthesis/preview-flow",
    "POST /api/synthesis/validate",
    "POST /api/upload/workflow-import",
    "POST /api/users",
    "PATCH /api/users/:id",
    "PUT /api/users/:id/role",
    "PUT /api/users/:id/status",
    "POST /api/workflows/:id/assign",
    "POST /api/workflows/:id/duplicate",
    "POST /api/workflows/:id/publish",
    "POST /api/workflows/templates",
    "POST /api/workflows/templates/:id/use",
  ].map((key) => [key, "Invalid JSON request body"] as const),
  ...[
    "PUT /api/company",
    "POST /api/company/approval-tiers",
    "PUT /api/company/approval-tiers/:id",
    "POST /api/company/cost-centres",
    "PUT /api/company/cost-centres/:id",
    "POST /api/company/departments",
    "PUT /api/company/departments/:id",
    "POST /api/import/commit",
    "PATCH /api/profile/notifications",
    "POST /api/providers",
    "PUT /api/providers/:id",
    "POST /api/workflows",
    "PATCH /api/workflows/:id",
    "PUT /api/workflows/:id/canvas",
    "POST /api/workflows/:id/run",
    "PUT /api/workflows/:id/yaml",
  ].map((key) => [key, "Invalid request body"] as const),
]);

/*******************************************************************************
 * Function: buildApp
 *
 * Configures the Fastify application, middleware, routes, and websocket
 * handlers.
 ******************************************************************************/
export async function buildApp(
  services: ApplicationServices,
  options: { executionHost?: ExecutionHostMode } = {},
): Promise<FastifyInstance> {
  assertApplicationServices(services);
  // Bind before constructing queues. This cannot be changed by request data,
  // a services spread, or another HTTP host sharing the same repository.
  const residentHost = bindExecutionHost(services.repository, options.executionHost) === "resident-server";
  const app = Fastify({
    logger: process.env.NODE_ENV !== "test",
    bodyLimit: 10 * 1024 * 1024,
  });
  const resourceMutations = new ResourceMutations();
  if (supportsChatJobs(services)) {
    const queue = chatJobQueue(services);
    if (residentHost) app.addHook("onReady", () => queue.start());
    app.addHook("onClose", () => queue.stop());
  }
  if (supportsReadJobs(services)) {
    const queue = readJobQueue(services);
    if (residentHost) app.addHook("onReady", () => queue.start());
    app.addHook("onClose", () => queue.stop());
  }
  if (supportsOperationJobs(services)) {
    const queue = operationJobQueue(services);
    if (residentHost) app.addHook("onReady", () => queue.start());
    app.addHook("onClose", () => queue.stop());
    const readbacks = operationReadbackQueue(services);
    if (residentHost) app.addHook("onReady", () => readbacks.start());
    app.addHook("onClose", () => readbacks.stop());
    const schedules = workflowScheduleRunner(services);
    if (residentHost) app.addHook("onReady", () => schedules.start());
    app.addHook("onClose", () => schedules.stop());
  }
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_request, body, done) => {
      try {
        done(
          null,
          JSON.parse(typeof body === "string" ? body : body.toString("utf8")),
        );
      } catch {
        done(null, INVALID_JSON_BODY);
      }
    },
  );
  await app.register(cors, {
    origin: services.config.corsOrigins,
    credentials: true,
    allowedHeaders: ["Origin", "Content-Type", "Accept", "Authorization"],
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
  });
  await app.register(multipart, { limits: { fileSize: 64 * 1024 * 1024, files: 1, fields: 8, parts: 9 } });
  await app.register(websocket);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HandlerFailure) {
      void reply.status(error.status).send(fail(error.message, error.meta));
      return;
    }
    const normalized = (
      error instanceof Error ? error : new Error(String(error))
    ) as Error & { statusCode?: number; code?: string };
    const status =
      normalized.statusCode !== undefined &&
      normalized.statusCode >= 400 &&
      normalized.statusCode < 600
        ? normalized.statusCode
        : 500;
    if (status === 500) {
      request.log.error(
        { err: normalized, traceId: requestTraceId(request) },
        "Unhandled request error",
      );
    }
    const message =
      status === 400 && normalized.code === "FST_ERR_CTP_INVALID_JSON_BODY"
        ? "Invalid request body"
        : status === 500
          ? "Internal server error"
          : normalized.message;
    void reply.status(status).send(fail(message, null));
  });
  app.addHook("onRequest", async (request) => {
    initializeRequestTrace(request);
  });
  app.addHook("onSend", async (request, reply, payload) => {
    void reply.header("x-trace-id", requestTraceId(request));
    return payload;
  });

  for (const route of routeTable) {
    if (route.path === "/ws/*") {
      app.get(
        route.path,
        {
          websocket: true,
          /*******************************************************************************
           * Function: preValidation
           *
           * Authenticates a websocket request before the connection is accepted.
           ******************************************************************************/
          preValidation: async (request, reply) => {
            const auth = await authenticate(request, reply, services);
            if (auth === null) return reply;
          },
        },
        (socket, request) => attachSystemHealthSocket(socket, request, services),
      );
      continue;
    }
    app.route({
      method: route.method as HTTPMethods,
      url: route.path,
      /*******************************************************************************
       * Function: handler
       *
       * Dispatches the registered HTTP route to its application handler.
       ******************************************************************************/
      handler: async (request, reply) => {
        if (route.method === "GET" || route.path.includes("/settings/mcp-connections") || /\/(commands|node-proposals|run|retry)$/.test(route.path))
          return handleRoute(route, request, reply, services);
        const params = request.params as Record<string, unknown>;
        const family = route.path.split("/")[2] ?? route.path;
        // Attachment storage/OCR and model previews are independent of chat.
        // Keep same-document mutations serialized without holding the chat
        // lane for an upstream upload or a slow inference.
        const key = route.path.includes("/attachments")
          ? `chat-document:${String(params?.id)}:${String(params?.uploadId ?? (route.path.endsWith("/preview") ? "preview" : "uploads"))}`
          : `${family}:${String(params?.id ?? params?.userId ?? "collection")}`;
        return resourceMutations.run(key, () => handleRoute(route, request, reply, services));
      },
    });
  }
  if (routeTable.length !== 233)
    throw new Error(
      `route table has ${routeTable.length} routes, expected 233`,
    );
  return app;
}
/*******************************************************************************
 * Function: assertApplicationServices
 *
 * Checks that the application has the services required to start.
 ******************************************************************************/
function assertApplicationServices(services: ApplicationServices): void {
  if (
    services === null ||
    services === undefined ||
    typeof services !== "object"
  )
    throw new Error("application services are required");
  if (services.config === null || services.config === undefined)
    throw new Error("application config is required");
  if (
    services.repository === null ||
    services.repository === undefined ||
    typeof services.repository.snapshot !== "function" ||
    typeof services.repository.mutate !== "function"
  )
    throw new Error("application repository is invalid");
  if (
    services.registries === null ||
    services.registries === undefined ||
    typeof services.registries.snapshot !== "function"
  )
    throw new Error("application registry service is invalid");
  if (
    services.validator === null ||
    services.validator === undefined ||
    typeof services.validator.validateAndIssueToken !== "function"
  )
    throw new Error("application validator is invalid");
  if (
    services.executor === null ||
    services.executor === undefined ||
    typeof services.executor.run !== "function"
  )
    throw new Error("application executor is invalid");
}

/*******************************************************************************
 * Function: handleRoute
 *
 * Dispatches an HTTP request to the matching backend handler.
 ******************************************************************************/
async function handleRoute(
  route: RouteDefinition,
  request: FastifyRequest,
  reply: FastifyReply,
  services: ApplicationServices,
): Promise<unknown> {
  const routeKey = `${route.method} ${route.path}`;
  if (
    route.path === "/healthz" ||
    route.path === `${services.config.apiBasePath}/health`
  )
    return health(reply, services);
  if (route.path === `${services.config.apiBasePath}/auth/login`)
    return login(request, reply, services);
  if (route.path === `${services.config.apiBasePath}/auth/register`)
    return register(request, reply, services);
  if (route.path === `${services.config.apiBasePath}/auth/refresh`)
    return refresh(request, reply, services);
  if (route.path.includes("/auth/oauth/"))
    return reply
      .status(501)
      .send(fail("OAuth is not configured for this installation", null));
  if (
    route.path.endsWith("/forgot-password") ||
    route.path.endsWith("/reset-password")
  )
    return reply
      .status(501)
      .send(
        fail("Password recovery is not configured for this installation", null),
      );
  if (route.path.endsWith("/verify-email"))
    return reply
      .status(501)
      .send(
        fail(
          "Email verification is not configured for this installation",
          null,
        ),
      );

  // Storage denial must not masquerade as an empty inbox, an expired login or
  // a generic crash. This read-only route never falls back to a stale image.
  if (route.path === `${services.config.apiBasePath}/execution-reviews` || route.path === `${services.config.apiBasePath}/workflows/:id/run-receipts/:key`) {
    try { services.repository.assertAuthority(); }
    catch { return reply.status(503).send(fail("The review inbox is unavailable until authoritative storage is recovered. No tasks or actions are confirmed.", null)); }
  }
  if (route.path === `${services.config.apiBasePath}/settings/runtime-approval-policy`) {
    try { services.repository.assertAuthority(); }
    catch { return reply.status(503).send(fail("Approval settings are unavailable until authoritative storage is recovered. No policy is confirmed.", null)); }
  }
  const auth = publicRoutes.has(routeKey)
    ? null
    : await authenticate(request, reply, services);
  if (!publicRoutes.has(routeKey) && auth === null) return;
  const current = auth?.user ?? null;
  if (current !== null) {
    // Authentication/authorization is mandatory, independent of optional
    // advisory policy checks. Disabling the UI toggle cannot grant access.
    const policy = routePolicy(route);
    if (policy !== null && !policy.required.some((permission) => current.permissions.includes(permission))) {
      const meta = policy.any ? { requiredAny: policy.required } : { required: policy.required[0] };
      return reply.status(403).send(fail("Permission denied", meta));
    }
  }

  return services.userMcpCredentials && current
    ? services.userMcpCredentials.requestScope(current.id, authorizedRoute)
    : authorizedRoute();
  async function authorizedRoute(): Promise<unknown> {
  if (route.path.startsWith(`${services.config.apiBasePath}/profile/erp-connections`)) {
    const credentials = services.userMcpCredentials;
    if (!credentials) return reply.status(503).send(fail("Per-user ERP connections are unavailable on this backend", { code: "ERP_CREDENTIAL_UNAVAILABLE" }));
    const id = String((request.params as Record<string, unknown>).id ?? "");
    const value = route.method === "GET" ? await credentials.list(current!.id)
      : route.method === "PUT" ? await credentials.save(current!.id, id, request.body)
      : route.method === "DELETE" ? await credentials.remove(current!.id, id, request.body)
      : await credentials.test(current!.id, id, request.body);
    return reply.send(ok(value, "Your ERP connection settings were loaded or updated", null));
  }
  if (route.path === `${services.config.apiBasePath}/auth/logout`)
    return logout(request, reply, services);
  if (route.path === `${services.config.apiBasePath}/auth/me`)
    return reply.send(ok(publicUser(current!), "OK", null));
  if (route.path.includes("/auth/2fa/"))
    return reply
      .status(501)
      .send(
        fail(
          "Two-factor authentication is not configured for this installation",
          null,
        ),
      );
  if (
    route.path === `${services.config.apiBasePath}/workflows` &&
    route.method === "GET"
  )
    return listWorkflows(request, reply, current!, services);
  if (
    route.path === `${services.config.apiBasePath}/workflows` &&
    route.method === "POST"
  )
    return createWorkflow(request, reply, current!, services);
  if (
    route.path === `${services.config.apiBasePath}/workflows/:id` &&
    route.method === "GET"
  )
    return getWorkflow(request, reply, current!, services);
  if (route.path === `${services.config.apiBasePath}/workflows/:id/validate`)
    return validateWorkflowRoute(request, reply, current!, services);
  if (route.path === `${services.config.apiBasePath}/workflows/:id/run`)
    return runWorkflow(request, reply, current!, services);
  if (route.path === `${services.config.apiBasePath}/registry/tools` && route.method === "GET")
    return handleRegistryRoute(route, request, reply, current!, services);
  if (
    route.path === `${services.config.apiBasePath}/registry/rules` &&
    route.method === "GET"
  )
    return reply.send(
      ok(services.registries.snapshot().rules, "Rule registry loaded", {
        count: services.registries.snapshot().rules.length,
        registryHash: services.registries.hash(),
      }),
    );
  const executionQuery = await handleExecutionQueryRoute(route, request, reply, current!, services);
  if (executionQuery !== EXECUTION_QUERY_UNHANDLED) return executionQuery;
  const executionControl = await handleExecutionControlRoute(route, request, reply, current!, services);
  if (executionControl !== EXECUTION_CONTROL_UNHANDLED) return executionControl;
  const workflowSchedule = await handleWorkflowScheduleRoute(route, request, reply, current!, services);
  if (workflowSchedule !== WORKFLOW_SCHEDULE_UNHANDLED) return workflowSchedule;
  const notification = await handleNotificationRoute(route, request, reply, current!, services);
  if (notification !== NOTIFICATION_UNHANDLED) return notification;
  const chatDocument = await handleChatDocumentRoute(route, request, reply, current!, services);
  if (chatDocument !== CHAT_DOCUMENTS_UNHANDLED) return chatDocument;
  const ragPolicy = await handleRagPolicyRoute(route, request, reply, current!, services);
  if (ragPolicy !== RAG_POLICY_UNHANDLED) return ragPolicy;
  const pipelineGateway = await handlePipelineGatewayRoute(route, request, reply, current!, services);
  if (pipelineGateway !== PIPELINE_GATEWAY_UNHANDLED) return pipelineGateway;
  if (
    route.path === `${services.config.apiBasePath}/profile` &&
    route.method === "GET"
  )
    return reply.send(ok(publicUser(current!), "OK", null));
  if (route.path === `${services.config.apiBasePath}/users/invite`)
    return reply
      .status(501)
      .send(
        fail("Email invitations is not configured for this installation", null),
      );
  if (route.path === `${services.config.apiBasePath}/profile/security`)
    return reply
      .status(501)
      .send(
        fail(
          "Security preference changes is not configured for this installation",
          null,
        ),
      );
  if (routeKey === "POST /api/import/analyse" && !request.isMultipart())
    return reply
      .status(400)
      .send(fail("Choose a registry file to analyse", null));
  if (request.body === INVALID_JSON_BODY) {
    const message = malformedJSONMessages.get(routeKey);
    if (message !== undefined)
      return reply.status(400).send(fail(message, null));
  }

  const workflowResult = await handleWorkflowRoute(
    route,
    request,
    reply,
    current!,
    services,
  );
  if (workflowResult !== WORKFLOW_UNHANDLED) return workflowResult;
  const adminResult = await handleAdministrationRoute(
    route,
    request,
    reply,
    current!,
    services,
  );
  if (adminResult !== ADMIN_UNHANDLED) return adminResult;
  const resourceResult = await handleResourceRoute(
    route,
    request,
    reply,
    current!,
    services,
  );
  if (resourceResult !== RESOURCE_UNHANDLED) return resourceResult;
  const analyticsResult = await handleAnalyticsCatalogRoute(
    route,
    request,
    reply,
    current!,
    services,
  );
  if (analyticsResult !== ANALYTICS_UNHANDLED) return analyticsResult;
  const registryResult = await handleRegistryRoute(
    route,
    request,
    reply,
    current!,
    services,
  );
  if (registryResult !== REGISTRY_UNHANDLED) return registryResult;
  const uploadExecutionResult = await handleUploadExecutionRoute(
    route,
    request,
    reply,
    current!,
    services,
  );
  if (uploadExecutionResult !== UPLOAD_EXECUTION_UNHANDLED)
    return uploadExecutionResult;

  return genericRoute(route, request, reply, current, services);
  }
}

/*******************************************************************************
 * Function: health
 *
 * Returns application and persistence health information.
 ******************************************************************************/
async function health(
  reply: FastifyReply,
  services: ApplicationServices,
): Promise<unknown> {
  const storage = await services.repository.persistenceStatus();
  const data = {
    service: services.config.appName,
    environment: services.config.environment,
    status: storage.healthy ? "healthy" : "degraded",
    storage: {
      driver: services.config.storageDriver,
      durable: storage.durable,
      status: storage.healthy ? "healthy" : "unhealthy",
    },
    mcpMode: services.config.mcpMode,
    mcpBackend: isMcpConfigured(services.config) ? "configured" : "unconfigured",
    time: new Date().toISOString(),
  };
  return storage.healthy
    ? reply.send(ok(data, "OK", null))
    : reply.status(503).send({
        success: false,
        data,
        message: "Storage persistence is degraded",
        meta: null,
      });
}

/*******************************************************************************
 * Function: genericRoute
 *
 * Returns the fallback response for a route without a specific handler.
 ******************************************************************************/
async function genericRoute(
  route: RouteDefinition,
  _request: FastifyRequest,
  reply: FastifyReply,
  _user: unknown,
  services: ApplicationServices,
): Promise<unknown> {
  if (route.method === "GET") {
    if (route.path.endsWith("/:id") || route.path.includes(":id/"))
      return reply.status(404).send(fail("Resource not found", null));
    return reply.send(ok([], "OK", { count: 0 }));
  }
  if (route.method === "DELETE")
    return reply.status(404).send(fail("Resource not found", null));
  if (route.path === `${services.config.apiBasePath}/semantic-index/rebuild`)
    return reply
      .status(503)
      .send(fail("Semantic search service is unavailable", null));
  throw new Error(`Missing route dispatch for ${route.method} ${route.path}`);
}
