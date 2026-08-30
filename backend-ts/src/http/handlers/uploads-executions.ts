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
import { runWorkflowFor } from "../app.js";
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
  const gate = await validateWorkflow(services, "ImportWorkflow", yaml, user, { traceId });
  if (!gate.result.passed)
    throw new HandlerFailure(422, "Workflow validation failed", { ...gate.result, traceId, ...(gate.gateExplanation !== undefined ? { gateExplanation: gate.gateExplanation } : {}) }); // SAFETY: the strict workflow parser guarantees trigger.config is JSON-compatible; Workflow stores the same value as a generic object.
  const workflow = await services.repository.mutate((state) => {
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
      canRun: true,
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

async function executionLogs(
  request: FastifyRequest,
  reply: FastifyReply,
  user: CurrentUser,
  services: HandlerServices,
): Promise<unknown> {
  const id = requestParam(request, "id");
  await requireExecution(id, user, services);
  const logs = await services.repository.read((state) =>
    (state.executionLogs[id] ?? []).map((item) => withoutSecretFields(item)),
  );
  return reply.send(ok(logs, "OK", { nextCursor: null }));
}
async function executionTimeline(
  request: FastifyRequest,
  reply: FastifyReply,
  user: CurrentUser,
  services: HandlerServices,
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
  const workflow = await services.repository.read(
    (state) => state.workflows[prior.workflowId] ?? null,
  );
  if (workflow === null) throw new HandlerFailure(404, "Workflow not found");
  // Retry reuses the exact same self-healing execution path as POST /workflows/:id/run
  // (runWorkflowFor in app.ts) — there is only one workflow execution implementation.
  return runWorkflowFor(workflow, request, reply, user, services);
}

async function requireExecution(
  id: string,
  user: CurrentUser,
  services: HandlerServices,
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
async function approveExecution(
  request: FastifyRequest,
  reply: FastifyReply,
  user: CurrentUser,
  services: HandlerServices,
): Promise<unknown> {
  const execution = await requireExecution(requestParam(request, "id"), user, services);
  const updated = await services.repository.mutate((state) => {
    const item = state.executions[execution.id];
    if (item === undefined) throw new HandlerFailure(404, "Execution not found");
    item.status = "DONE";
    appendAudit(state, user, "execution.approved", "execution", item.id, null, { status: item.status }, request);
    return structuredClone(item);
  });
  return reply.send(ok(updated, "Execution approved", null));
}

async function rejectExecution(
  request: FastifyRequest,
  reply: FastifyReply,
  user: CurrentUser,
  services: HandlerServices,
): Promise<unknown> {
  const execution = await requireExecution(requestParam(request, "id"), user, services);
  const body = bodyRecord(request);
  const reason = body !== null ? stringValue(body.reason) : "Rejected by user";
  const updated = await services.repository.mutate((state) => {
    const item = state.executions[execution.id];
    if (item === undefined) throw new HandlerFailure(404, "Execution not found");
    item.status = "FAILED";
    item.failure = { failureCategory: "REJECTED", failedStepId: "approval", failedToolName: "human_approval", toolWasCalled: false };
    appendAudit(state, user, "execution.rejected", "execution", item.id, null, { status: item.status, reason }, request);
    return structuredClone(item);
  });
  return reply.send(ok(updated, "Execution rejected", null));
}

function publicWorkflow(workflow: Workflow): Record<string, unknown> {
  const {
    yaml: _yaml,
    archived: _archived,
    canvas: _canvas,
    ...item
  } = workflow;
  return item;
}
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
