import type { AppConfig } from "../config/config.js";
import { openApplicationResources, constructApplicationRuntime, type ApplicationResources } from "../entrypoints/application-runtime.js";
import { bindExecutionHost } from "../runner/execution-host.js";
import { configureReadTaskDispatch, type ReadTaskTransport } from "../runner/read-task-outbox.js";
import { configureChatTaskDispatch, type ChatTaskTransport } from "../agent/chat-task-outbox.js";
import { configureReadbackTaskDispatch, type ReadbackTaskTransport } from "../runner/readback-task-outbox.js";
import { configureOperationTaskDispatch, type OperationTaskTransport } from "../runner/operation-task-outbox.js";
import { buildApp } from "../http/app.js";
import type { ApplicationServices } from "../http/application-services.js";
import type { FastifyInstance } from "fastify";
import { configureWorkflowLifecycle } from "../runner/workflow-lifecycle-host.js";
import { FirestoreOwnershipFailure } from "../storage/firestore-writer-ownership.js";
import { boundedOperation } from "../core/bounded-operation.js";
import { setTimeout as pause } from "node:timers/promises";
import { FirestoreRecordPersistence } from "../storage/firestore-records.js";
import { FirestoreChatCancellation } from "../storage/firestore-chat-cancellation.js";
import { configureChatCancellation } from "../agent/chat-cancellation.js";

export type FunctionComposition = { config: AppConfig; root: string; transport: ReadTaskTransport; chatTransport?: ChatTaskTransport;
  readbackTransport?: ReadbackTaskTransport; operationTransport?: OperationTaskTransport; workflowLifecycle?: "workflow-lifecycle/v1"; signal?: AbortSignal | undefined;
  runtimePurpose?: "chat-admission" | "document-services" };

/** Admission-only contention wait, never a retry wrapper around business work.
 * Storage reports WRITER_HELD/WRITER_HANDOFF only before any lease transition and after the
 * losing client has drained. Unknown ownership/ACK/cleanup errors stay fatal. */
function openInvocationResources(input: FunctionComposition): Promise<ApplicationResources> {
  const open = () => openApplicationResources({ config: input.config, root: input.root, registryPreparation: "existing-only", reuseVerifiedFirestoreImages: true });
  if (input.config.storageDriver !== "firestore-records") return open();
  const timeoutMs = input.config.functionsWriterAdmissionTimeoutMs ?? 30_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60_000)
    return Promise.reject(new Error("Invalid Functions writer admission timeout"));
  const waiting = new AbortController();
  // Minimum pause is 100 ms: this secondary cap cannot prematurely exhaust
  // the configured wait. Backoff reduces contention; the deadline stays final.
  const maxAttempts = Math.ceil(timeoutMs / 100) + 1;
  let abandoned = false;
  return boundedOperation(async () => {
    for (let attempt = 0; ; attempt++) {
      if (abandoned) throw new Error("Function writer admission was cancelled");
      let resources: ApplicationResources;
      try { resources = await open(); }
      catch (error) {
        if (!(error instanceof Error && error.cause instanceof FirestoreOwnershipFailure &&
            ["WRITER_HELD", "WRITER_HANDOFF"].includes(error.cause.reason)) || attempt + 1 >= maxAttempts || abandoned)
          throw error;
        await pause(Math.min(1000, 100 * 2 ** Math.min(attempt, 3)) + Math.floor(Math.random() * 100), undefined, { signal: waiting.signal });
        continue;
      }
      if (abandoned) { await resources.close(); throw new Error("Function writer admission was cancelled"); }
      return resources;
    }
  }, { timeoutMs, label: "Function writer admission", signal: input.signal, onAbandon: () => { abandoned = true; waiting.abort(); } });
}

/** Every invocation owns a freshly loaded, acknowledged namespace writer.
 * Never bootstrap an administrator, reconcile unrelated jobs, or cache an
 * application repository between invocations. Close even if work fails. */
export async function withFunctionResources<T>(input: FunctionComposition, work: (resources: ApplicationResources) => Promise<T>): Promise<T> {
  const resources = await openInvocationResources(input);
  let cancellation: FirestoreChatCancellation | undefined;
  try {
    bindExecutionHost(resources.repository, "bounded-invocation");
    if (resources.repository.persistence instanceof FirestoreRecordPersistence) {
      cancellation = new FirestoreChatCancellation(resources.repository.persistence.records, input.config);
      configureChatCancellation(resources.repository, cancellation);
    }
    configureReadTaskDispatch(resources.repository, input.transport);
    if (input.chatTransport) configureChatTaskDispatch(resources.repository, input.chatTransport);
    if (input.readbackTransport) configureReadbackTaskDispatch(resources.repository, input.readbackTransport);
    if (input.operationTransport) configureOperationTaskDispatch(resources.repository, input.operationTransport);
    if (input.workflowLifecycle !== undefined) {
      if (input.workflowLifecycle !== "workflow-lifecycle/v1") throw new Error("Unsupported workflow lifecycle composition");
      configureWorkflowLifecycle(resources.repository);
    }
    return await work(resources);
  } finally { try { await cancellation?.close(); } finally { await resources.close(); } }
}

/** HTTP/task teardown drains owned queues before MCP/provider/storage disposal.
 * The buffered HTTP response is sent only after this scope fully closes. */
export function withFunctionRuntime<T>(input: FunctionComposition, work: (context: { services: ApplicationServices; app: FastifyInstance }) => Promise<T>): Promise<T> {
  return withFunctionResources(input, async resources => {
    const runtime = await constructApplicationRuntime(resources,{deferMcpConnection:input.runtimePurpose==="chat-admission" || input.runtimePurpose==="document-services"});
    const app = await buildApp(runtime.services, { executionHost: "bounded-invocation" });
    try { return await work({ services: runtime.services, app }); }
    finally { await app.close(); }
  });
}
