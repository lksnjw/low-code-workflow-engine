import { createHash } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  fail,
  ok,
  runWorkflowRequestSchema,
  type Workflow,
} from "../../models/schemas.js";
import { parseWorkflowYAMLStrict } from "../../parser/workflow.js";
import { withoutSecretFields } from "../../redact/secrets.js";
import type { RouteDefinition } from "../generated-routes.js";
import { canReadExecution } from "../execution-scope.js";
import { requestTraceId } from "../../trace/request-trace.js";
import { runWorkflowFor, resumeWorkflowApproval } from "./workflow-runtime.js";
import { decideRuntimeApproval } from "../../runner/runtime-approvals.js";
import { executionRetryView } from "../../runner/execution-retry.js";
import { decideOwnedProtectedApproval } from "../../runner/protected-approval-review.js";
import { assertCurrentRunController } from "../../runner/read-checkpoints.js";
import { validateWorkspaceDraft } from "../../workflows/draft-validation.js";
import { assertActorAuthority } from "./model-selection.js";
import {
  appendAudit,
  bodyRecord,
  HandlerFailure,
  type CurrentUser,
  type HandlerServices,
  isRecord,
  nextID,
  now,
  requestParam,
  stringValue,
  validateWorkflow,
} from "./common.js";

export const UPLOAD_EXECUTION_UNHANDLED = Symbol("upload-execution-unhandled");

/*******************************************************************************
 * Function: handleUploadExecutionRoute
 *
 * Dispatches upload, workflow import, and execution-detail requests.
 ******************************************************************************/
export async function handleUploadExecutionRoute(
  route: RouteDefinition,
  request: FastifyRequest,
  reply: FastifyReply,
  user: CurrentUser,
  services: HandlerServices,
): Promise<unknown | typeof UPLOAD_EXECUTION_UNHANDLED> {
  const base = services.config.apiBasePath;
  try {
    if (route.path === `${base}/upload` && route.method === "POST")
      return uploadFile(request, reply, services);
    if (route.path === `${base}/upload/:id` && route.method === "GET")
      return getUpload(request, reply, services);
    if (route.path === `${base}/upload/:id/download`)
      return downloadUpload(request, reply, services);
    if (route.path === `${base}/upload/:id` && route.method === "DELETE")
      return deleteUpload(request, reply, services);
    if (route.path === `${base}/upload/workflow-import`) {
      if (
        !request.isMultipart() &&
        (request.body === undefined ||
          (isRecord(request.body) &&
            stringValue(request.body.yaml).trim() === ""))
      )
        throw new HandlerFailure(400, "yaml is required");
      return importWorkflow(request, reply, user, services);
    }
    if (route.path === `${base}/executions/:id/logs`)
      return executionLogs(request, reply, user, services);
    if (route.path === `${base}/executions/:id/timeline`)
      return executionTimeline(request, reply, user, services);
    if (route.path === `${base}/executions/:id/healing-report`)
      return executionHealing(request, reply, user, services);
    if (route.path === `${base}/executions/:id/retry`)
      return retryExecution(request, reply, user, services);
    if (route.path === `${base}/executions/:id/approve` && route.method === "POST")
      return approveExecution(request, reply, user, services);
    if (route.path === `${base}/executions/:id/reject` && route.method === "POST")
      return rejectExecution(request, reply, user, services);
  } catch (error) {
    if (error instanceof HandlerFailure)
      return reply.status(error.status).send(fail(error.message, error.meta));
    throw error;
  }
  return UPLOAD_EXECUTION_UNHANDLED;
}

/*******************************************************************************
 * Function: uploadFile
 *
 * Stores an uploaded file and its metadata.
 ******************************************************************************/
async function uploadFile(
  request: FastifyRequest,
  reply: FastifyReply,
  services: HandlerServices,
): Promise<unknown> {
  if (!request.isMultipart()) throw new HandlerFailure(400, "file is required");
  const file = await request.file();
  if (file === undefined) throw new HandlerFailure(400, "file is required");
  let bytes: Buffer;
  try {
    bytes = await file.toBuffer();
  } catch {
    throw new HandlerFailure(400, "Could not read uploaded file");
  }
  const item = await services.repository.mutate((state) => {
    const id = nextID(state, "upload");
    const value = {
      id,
      name: file.filename,
      mimeType: file.mimetype,
      sizeBytes: bytes.byteLength,
      url: `${services.config.apiBasePath}/upload/${id}/download`,
      checksum: createHash("sha256").update(bytes).digest("hex"),
      createdAt: now(),
    };
    state.uploads[id] = value;
    state.uploadContents[id] = bytes.toString("base64");
    return value;
  });
  return reply.status(201).send(ok(item, "File uploaded", null));
}
/*******************************************************************************
 * Function: getUpload
 *
 * Returns metadata for the requested upload.
 ******************************************************************************/
async function getUpload(
  request: FastifyRequest,
  reply: FastifyReply,
  services: HandlerServices,
): Promise<unknown> {
  const item = await services.repository.read(
    (state) => state.uploads[requestParam(request, "id")] ?? null,
  );
  if (item === null) throw new HandlerFailure(404, "Upload not found");
  return reply.send(ok(item, "OK", null));
}
/*******************************************************************************
 * Function: downloadUpload
 *
 * Returns the stored upload content with download headers.
 ******************************************************************************/
async function downloadUpload(
  request: FastifyRequest,
  reply: FastifyReply,
  services: HandlerServices,
): Promise<unknown> {
  const item = await services.repository.read((state) => {
    const metadata = state.uploads[requestParam(request, "id")];
    const content = state.uploadContents[requestParam(request, "id")];
    return metadata === undefined || content === undefined
      ? null
      : { metadata, content };
  });
  if (item === null) throw new HandlerFailure(404, "Upload not found");
  return reply
    .header(
      "content-type",
      stringValue(item.metadata.mimeType) === ""
        ? "application/octet-stream"
        : stringValue(item.metadata.mimeType),
    )
    .header(
      "content-disposition",
      `attachment; filename=${JSON.stringify(stringValue(item.metadata.name))}`,
    )
    .send(Buffer.from(item.content, "base64"));
}
/*******************************************************************************
 * Function: deleteUpload
 *
 * Deletes an upload and its stored content.
 ******************************************************************************/
async function deleteUpload(
  request: FastifyRequest,
  reply: FastifyReply,
  services: HandlerServices,
): Promise<unknown> {
  await services.repository.mutate((state) => {
    const id = requestParam(request, "id");
    delete state.uploads[id];
    delete state.uploadContents[id];
  });
  return reply.send(ok({ deleted: true }, "Upload deleted", null));
}

/*******************************************************************************
 * Function: importWorkflow
 *
 * Parses and validates an uploaded workflow before storing it.
 ******************************************************************************/
async function importWorkflow(
  request: FastifyRequest,
  reply: FastifyReply,
  user: CurrentUser,
  services: HandlerServices,
): Promise<unknown> {
  let yaml = "";
  let name = "";
  if (request.isMultipart()) {
    const file = await request.file();
    if (file === undefined)
      throw new HandlerFailure(400, "Workflow YAML is required");
    yaml = (await file.toBuffer()).toString("utf8");
  } else {
    const body = bodyRecord(request);
    if (body === null) throw new HandlerFailure(400, "Invalid request body");
    yaml = stringValue(body.yaml);
    name = stringValue(body.name);
  }
  if (yaml.trim() === "")
    throw new HandlerFailure(400, "Workflow YAML is required");
  let blueprint;
  try {
    blueprint = parseWorkflowYAMLStrict(yaml);
  } catch (error) {
    throw new HandlerFailure(422, "Workflow validation failed", {
      error: errorText(error),
    });
  }
  const traceId = requestTraceId(request);
  const registryHash = services.registries.hash();
  const gate = await validateWorkflow(services, "ImportWorkflow", yaml, user, { traceId });
  if (!gate.result.passed)
    throw new HandlerFailure(422, "Workflow validation failed", { ...gate.result, traceId, ...(gate.gateExplanation !== undefined ? { gateExplanation: gate.gateExplanation } : {}) }); // SAFETY: the strict workflow parser guarantees trigger.config is JSON-compatible; Workflow stores the same value as a generic object.
  const validation = validateWorkspaceDraft("ImportWorkflow", yaml, user.role, services.validator, services.registries.snapshot().tools);
  if (!validation.passed) throw new HandlerFailure(422, "Workflow validation failed", validation);
  const workflow = await services.repository.mutate((state) => {
    const permissions = assertActorAuthority(state, user);
    if (!permissions.includes("workflow:write")) throw new HandlerFailure(403, "Current workflow write authority is required");
    if (services.registries.hash() !== registryHash) throw new HandlerFailure(409, "Registry changed during validation; validate the draft again", { code: "DRAFT_REGISTRY_CHANGED" });
    const id = nextID(state, "wf");
    const createdAt = now();
    const value: Workflow = {
      id,
      name: name.trim() === "" ? blueprint.name : name,
      description: blueprint.description ?? "",
      owner: { id: user.id, name: user.name },
      assignedUserIds: [],
      status: "PENDING",
      trigger: blueprint.trigger as unknown as Record<string, unknown>,
      steps: blueprint.steps.length,
      successRate: 0,
      lastRunAt: null,
      publishedVersion: 0,
      draftVersion: 1,
      tags: [],
      domainTags: [],
      canRun: false,
      createdAt,
      updatedAt: createdAt,
      yaml,
      archived: false,
    };
    state.workflows[id] = value;
    appendAudit(
      state,
      user,
      "workflow.imported",
      "workflow",
      id,
      null,
      publicWorkflow(value),
      request,
    );
    return value;
  });
  return reply
    .status(201)
    .send(ok(publicWorkflow(workflow), "Workflow imported", null));
}

/*******************************************************************************
 * Function: executionLogs
 *
 * Returns log entries for a visible execution.
 ******************************************************************************/
export async function executionLogs(
  request: FastifyRequest,
  reply: FastifyReply,
  user: CurrentUser,
  services: { repository: Pick<HandlerServices["repository"], "read"> },
): Promise<unknown> {
  const id = requestParam(request, "id");
  await requireExecution(id, user, services);
  const logs = await services.repository.read((state) =>
    (state.executionLogs[id] ?? []).map((item) => withoutSecretFields(item)),
  );
  return reply.send(ok(logs, "OK", { nextCursor: null }));
}
/*******************************************************************************
 * Function: executionTimeline
 *
 * Returns the step timeline for a visible execution.
 ******************************************************************************/
export async function executionTimeline(
  request: FastifyRequest,
  reply: FastifyReply,
  user: CurrentUser,
  services: { repository: Pick<HandlerServices["repository"], "read"> },
): Promise<unknown> {
  const id = requestParam(request, "id");
  await requireExecution(id, user, services);
  return reply.send(
    ok(
      await services.repository.read((state) => state.timelines[id] ?? []),
      "OK",
      null,
    ),
  );
}
/*******************************************************************************
 * Function: executionHealing
 *
 * Returns healing information for a visible execution.
 ******************************************************************************/
async function executionHealing(
  request: FastifyRequest,
  reply: FastifyReply,
  user: CurrentUser,
  services: HandlerServices,
): Promise<unknown> {
  const id = requestParam(request, "id");
  const execution = await requireExecution(id, user, services);
  const report = await services.repository.read(
    (state) =>
      state.healing[id] ?? {
        executionId: id,
        workflowId: execution.workflowId,
        status: "NO_HEALING_REQUIRED",
        summary: "No healing was required for this execution",
        events: [],
        metrics: {},
      },
  );
  return reply.send(ok(report, "OK", null));
}

/*******************************************************************************
 * Function: retryExecution
 *
 * Loads a visible execution and retries its workflow.
 ******************************************************************************/
async function retryExecution(
  request: FastifyRequest,
  reply: FastifyReply,
  user: CurrentUser,
  services: HandlerServices,
): Promise<unknown> {
  const prior = await requireExecution(
    requestParam(request, "id"),
    user,
    services,
  );
  // Preserve the existing no-replay conflict for unsafe historical runs,
  // including callers of the old empty-body retry endpoint. Parsing a new
  // command must not disguise an unresolved effect as a mere input error.
  const admission = await services.repository.readAuthoritative(state => executionRetryView(state, user, state.executions[prior.id]!));
  if (!admission.allowed) throw new HandlerFailure(409, admission.reason, { code: "EXECUTION_RETRY_BLOCKED" });
  const body = runWorkflowRequestSchema.safeParse(request.body);
  if (!body.success || body.data.retry?.sourceExecutionId !== prior.id)
    throw new HandlerFailure(400, "Retry requires an explicit queued restart command and the exact original execution ID");
  const workflow = await services.repository.read(
    (state) => state.workflows[prior.workflowId] ?? null,
  );
  if (workflow === null) throw new HandlerFailure(404, "Workflow not found");
  // Explicit Retry creates a new run through the same governed read path; it
  // does not resume/replay an uncertain attempt or grant transaction approval.
  return runWorkflowFor(workflow, request, reply, user, services);
}

/*******************************************************************************
 * Function: requireExecution
 *
 * Loads an execution or rejects the request when it is unavailable to the
 * user.
 ******************************************************************************/
async function requireExecution(
  id: string,
  user: CurrentUser,
  services: { repository: Pick<HandlerServices["repository"], "read"> },
) {
  const execution = await services.repository.read(
    (state) => state.executions[id] ?? null,
  );
  if (
    execution === null || !canReadExecution(user, execution)
  )
    throw new HandlerFailure(404, "Execution not found");
  return execution;
}
/*******************************************************************************
 * Function: approveExecution
 *
 * Approves a pending execution checkpoint and delegates resumption.
 ******************************************************************************/
async function approveExecution(
  request: FastifyRequest,
  reply: FastifyReply,
  user: CurrentUser,
  services: HandlerServices,
): Promise<unknown> {
  if (await services.repository.readAuthoritative(state => Boolean(state.executions[requestParam(request, "id")]?.protectedJobSecret || state.executions[requestParam(request, "id")]?.protectedApprovalSecret))) {
    const decision = await decideOwnedProtectedApproval(services, requestParam(request, "id"), user, request.body, "APPROVED");
    return reply.send(ok(decision, "Exact item approval recorded, not execution. The protected effect driver remains unqualified; no operation or email was dispatched.", null));
  }
  if (await services.repository.read(state => Boolean(state.executions[requestParam(request, "id")]?.runtimeApprovalSecret))) {
    const decision = await decideRuntimeApproval(services.repository, requestParam(request, "id"), user, request.body, "APPROVED");
    return reply.send(ok(decision, decision.operationManaged ? "Exact approval recorded. The operation worker must recheck authority before dispatch; this receipt is not execution or delivery confirmation." : "Exact approval recorded, not execution. Safe effect resume/outbox dispatch remains unavailable.", null));
  }
  const execution = await requireExecution(requestParam(request, "id"), user, services);
  const body = bodyRecord(request);
  const note = body !== null ? stringValue(body.note) : "";
  // Legacy decisions cannot authorize exact arguments or resume through a model.
  return resumeWorkflowApproval(execution, note, request, reply, user, services);
}

/*******************************************************************************
 * Function: rejectExecution
 *
 * Rejects a pending execution approval and records the outcome.
 ******************************************************************************/
async function rejectExecution(
  request: FastifyRequest,
  reply: FastifyReply,
  user: CurrentUser,
  services: HandlerServices,
): Promise<unknown> {
  if (await services.repository.readAuthoritative(state => Boolean(state.executions[requestParam(request, "id")]?.protectedJobSecret || state.executions[requestParam(request, "id")]?.protectedApprovalSecret))) {
    const decision = await decideOwnedProtectedApproval(services, requestParam(request, "id"), user, request.body, "REJECTED");
    return reply.send(ok(decision, "Exact item action rejected; this approval checkpoint did not dispatch", null));
  }
  if (await services.repository.read(state => Boolean(state.executions[requestParam(request, "id")]?.runtimeApprovalSecret))) {
    const decision = await decideRuntimeApproval(services.repository, requestParam(request, "id"), user, request.body, "REJECTED");
    return reply.send(ok(decision, "Exact transaction rejected; its approval checkpoint did not dispatch", null));
  }
  const execution = await requireExecution(requestParam(request, "id"), user, services);
  if (execution.status !== "AWAITING_APPROVAL")
    throw new HandlerFailure(409, "This execution is not awaiting approval");
  const body = bodyRecord(request);
  const reason = body !== null ? stringValue(body.reason) : "Rejected by user";
  const updated = await services.repository.mutateExecution(execution.id, (state) => {
    const item = state.executions[execution.id];
    if (item === undefined) throw new HandlerFailure(404, "Execution not found");
    try { assertCurrentRunController(state, item, user.id, user.role); } catch { throw new HandlerFailure(403, "Current execution controller authority is required"); }
    if (item.status !== "AWAITING_APPROVAL" || !item.pendingApproval) throw new HandlerFailure(409, "Approval checkpoint changed");
    item.status = "FAILED";
    item.completedAt = now(); item.durationMs = Math.max(0, Date.parse(item.completedAt) - Date.parse(item.startedAt));
    item.failure = { failureCategory: "REJECTED", failedStepId: item.pendingApproval?.stepId ?? "approval", failedToolName: "human_approval", toolWasCalled: false };
    delete item.pendingApproval;
    appendAudit(state, user, "execution.rejected", "execution", item.id, null, { status: item.status, reason }, request);
    return structuredClone(item);
  });
  return reply.send(ok(updated, "Execution rejected", null));
}

/*******************************************************************************
 * Function: publicWorkflow
 *
 * Projects workflow data into the response shape for this handler.
 ******************************************************************************/
function publicWorkflow(workflow: Workflow): Record<string, unknown> {
  const {
    yaml: _yaml,
    archived: _archived,
    canvas: _canvas,
    ...item
  } = workflow;
  return item;
}
/*******************************************************************************
 * Function: errorText
 *
 * Converts an error or other thrown value into a message string.
 ******************************************************************************/
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
