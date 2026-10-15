import { resolve } from "node:path";
import { defineSecret } from "firebase-functions/params";
import { onRequest } from "firebase-functions/v2/https";
import { onTaskDispatched } from "firebase-functions/v2/tasks";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { loadFunctionConfig } from "../firebase/config.js";
import { openFirebaseReadTaskTransport, openFirebaseChatTaskTransport, openFirebaseReadbackTaskTransport, openFirebaseOperationTaskTransport } from "../firebase/read-task-transport.js";
import { handleFunctionHttp } from "../firebase/http.js";
import { withFunctionResources, withFunctionRuntime } from "../firebase/invocation.js";
import { readJobQueue } from "../runner/read-jobs.js";
import { readTaskCommandSchema, recoverReadTaskOutboxes } from "../runner/read-task-outbox.js";
import { chatJobQueue } from "../agent/chat-jobs.js";
import { executeFunctionChatTask } from "../firebase/chat-task.js";
import { chatTaskCommandSchema, recoverChatTaskOutboxes } from "../agent/chat-task-outbox.js";
import { readbackTaskCommandSchema, recoverReadbackTaskOutboxes } from "../runner/readback-task-outbox.js";
import { operationReadbackQueue } from "../runner/operation-readback-jobs.js";
import { operationTaskCommandSchema, recoverOperationTaskOutboxes } from "../runner/operation-task-outbox.js";
import { operationJobQueue } from "../runner/operation-jobs.js";
import { advanceWorkflowLifecycle as advanceOwnedWorkflowLifecycle } from "../runner/workflow-lifecycle.js";
import { firebaseReadTaskDeadlineMs } from "../firebase/read-task-deadline.js";
import { firebaseChatTaskDeadlineMs } from "../firebase/chat-task-deadline.js";
import { scheduledInvocationNeeded } from "../firebase/scheduled-maintenance.js";

const runtimeSecret = defineSecret("LCWE_RUNTIME_CONFIG");
// Deployment metadata and runtime queue scope must agree. Do not derive this
// from a deploy-shell-only variable that is absent in the deployed instance.
const region = "asia-south1";
const common = { region, timeoutSeconds: 300, concurrency: 1, maxInstances: 2, minInstances: 0, memory: "512MiB" as const, secrets: [runtimeSecret] };
const processing = { ...common, cpu: 2, memory: "4GiB" as const };
const maintenance = { ...common, cpu: 2, memory: "1GiB" as const };
function composition() {
  const root = resolve(import.meta.dirname, "assets"), config = loadFunctionConfig(runtimeSecret.value(), root);
  return { config, root, transport: openFirebaseReadTaskTransport(config.firestoreProjectId!, region),
    chatTransport: openFirebaseChatTaskTransport(config.firestoreProjectId!, region),
    readbackTransport: openFirebaseReadbackTaskTransport(config.firestoreProjectId!, region),
    operationTransport: openFirebaseOperationTaskTransport(config.firestoreProjectId!, region), workflowLifecycle: "workflow-lifecycle/v1" as const };
}

// Only the API edge is public. Existing JWT/RBAC routes remain authoritative.
// No secret lookup, repository/MCP startup, bootstrap or listener at import.
// Give API and processing workers more memory/CPU. Dispatch concurrency still
// follows the qualified database and ERP execution limits.
// Keep one API edge warm for interactive use. Workers remain scale-to-zero;
// increasing their parallelism before removing the namespace writer would
// increase contention, not safe ERP throughput.
export const api = onRequest({ ...processing, minInstances: 1, maxInstances: 4, concurrency: 4, invoker: "public", cors: false }, async (request, response) => {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const disconnected = () => { if (!response.writableEnded) abort(); };
  request.once("aborted", abort); response.once("close", disconnected);
  try {
    const result = await handleFunctionHttp(composition(), { method: request.method, url: request.url, headers: request.headers,
      rawBody: request.rawBody, body: request.body, ip: request.ip, signal: controller.signal });
    response.statusCode = result.statusCode;
    for (const [name, value] of Object.entries(result.headers)) if (value !== undefined) response.setHeader(name, value);
    response.end(result.body);
  } catch {
    response.status(503).json({ success: false, data: null, message: "Functions runtime configuration is unavailable", meta: { code: "FUNCTIONS_CONFIGURATION_UNAVAILABLE" } });
  } finally { request.off("aborted", abort); response.off("close", disconnected); }
});

// Private IAM boundary; deployment must grant only its trusted task identity.
export const executeReadTask = onTaskDispatched({ ...processing, invoker: "private",
  retryConfig: { maxAttempts: 20, minBackoffSeconds: 15, maxBackoffSeconds: 300, maxDoublings: 4 },
  rateLimits: { maxConcurrentDispatches: 1, maxDispatchesPerSecond: 1 } }, async request => {
  try {
    const command = readTaskCommandSchema.parse(request.data), input = composition();
    await withFunctionRuntime(input, async ({ services }) => {
      await readJobQueue(services).executeTask(command, { timeoutMs: firebaseReadTaskDeadlineMs(services.config.readWorkerLeaseMs) });
    });
  } catch { throw new Error("Read task invocation was not acknowledged; retry the original task, never a replacement ERP execution"); }
});

export const executeChatTask = onTaskDispatched({ ...processing, invoker: "private",
  retryConfig: { maxAttempts: 20, minBackoffSeconds: 15, maxBackoffSeconds: 300, maxDoublings: 4 },
  rateLimits: { maxConcurrentDispatches: 1, maxDispatchesPerSecond: 1 } }, async request => {
  try {
    const command = chatTaskCommandSchema.parse(request.data), input = composition();
    await executeFunctionChatTask(input, command, { timeoutMs: firebaseChatTaskDeadlineMs(input.config.functionsChatTaskTimeoutMs) });
  } catch { throw new Error("Chat task invocation was not acknowledged; retry the original operation, never a replacement chat turn"); }
});

export const executeReadbackTask = onTaskDispatched({ ...processing, invoker: "private",
  retryConfig: { maxAttempts: 20, minBackoffSeconds: 15, maxBackoffSeconds: 300, maxDoublings: 4 },
  rateLimits: { maxConcurrentDispatches: 1, maxDispatchesPerSecond: 1 } }, async request => {
  try {
    const command = readbackTaskCommandSchema.parse(request.data), input = composition();
    await withFunctionRuntime(input, async ({ services }) => {
      await operationReadbackQueue(services).executeTask(command, { timeoutMs: Math.min(60_000, services.config.readWorkerLeaseMs - 100) });
    });
  } catch { throw new Error("Status query task was not acknowledged; retry the original query, never resend its original ERP action"); }
});

export const executeOperationTask = onTaskDispatched({ ...processing, invoker: "private",
  retryConfig: { maxAttempts: 20, minBackoffSeconds: 15, maxBackoffSeconds: 300, maxDoublings: 4 },
  rateLimits: { maxConcurrentDispatches: 1, maxDispatchesPerSecond: 1 } }, async request => {
  try {
    const command = operationTaskCommandSchema.parse(request.data), input = composition();
    await withFunctionRuntime(input, async ({ services }) => {
      await operationJobQueue(services).executeTask(command, { timeoutMs: Math.min(60_000, services.config.readWorkerLeaseMs - 100) });
    });
  } catch { throw new Error("Operation delivery was not acknowledged; retry only its original task, never replace its run, approval or ERP action"); }
});

// This reconciles queue intent only. Business recurrence admission/approval
// remains a separate adapter; this trigger cannot send mail or run ERP tools.
export const recoverReadTaskDispatch = onSchedule({ ...maintenance, schedule: "every 1 minutes", timeZone: "Asia/Colombo",
  retryCount: 3, minBackoffSeconds: 15, maxBackoffSeconds: 300 }, async () => {
  try { const input = composition(); if (!await scheduledInvocationNeeded(input.config, "dispatch")) return;
    await withFunctionResources(input, async resources => {
    await recoverReadTaskOutboxes(resources.repository, 10); await recoverChatTaskOutboxes(resources.repository, 10);
    await recoverReadbackTaskOutboxes(resources.repository, 10);
    await recoverOperationTaskOutboxes(resources.repository, 10);
  }); }
  catch { throw new Error("Task dispatch recovery was not acknowledged; original outbox identities remain authoritative"); }
});

// Business recurrence and denial-only expiry, not an ERP execution trigger.
// Ignore event/browser clock overrides. Each occurrence retains its original
// publication, report window, service identity and task outbox across retries.
export const advanceWorkflowLifecycle = onSchedule({ ...maintenance, schedule: "every 1 minutes", timeZone: "Asia/Colombo",
  retryCount: 3, minBackoffSeconds: 15, maxBackoffSeconds: 300 }, async () => {
  try { const input = composition(); if (!await scheduledInvocationNeeded(input.config, "lifecycle")) return;
    await withFunctionRuntime(input, async ({ services }) => {
    const result = await advanceOwnedWorkflowLifecycle(services, { timeoutMs: 60_000, occurrenceLimit: 10, expiryLimit: 50 });
    if (result.pending) throw new Error("Original occurrence admission remains unconfirmed");
  }); }
  catch { throw new Error("Workflow lifecycle was not acknowledged; retry original occurrences and approval deadlines, never replacement ERP actions"); }
});
