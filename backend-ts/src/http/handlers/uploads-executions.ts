import { createHash, randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  fail,
  ok,
  runWorkflowRequestSchema,
  type Workflow,
} from "../../models/schemas.js";
import { parseWorkflowYAMLStrict } from "../../parser/workflow.js";
import { withoutSecretFields } from "../../redact/secrets.js";
import { partialResult } from "../../runner/executor.js";
import type { RouteDefinition } from "../generated-routes.js";
import { createDispatchIdentity } from "../../tools/registry.js";
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
  const gate = await validateWorkflow(services, "ImportWorkflow", yaml, user);
  if (!gate.result.passed)
    throw new HandlerFailure(422, "Workflow validation failed", gate.result); // SAFETY: the strict workflow parser guarantees trigger.config is JSON-compatible; Workflow stores the same value as a generic object.
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
  const parsed = runWorkflowRequestSchema.safeParse(request.body ?? {});
  const runRequest = parsed.success
    ? parsed.data
    : runWorkflowRequestSchema.parse({});
  return executeWorkflow(workflow, runRequest, reply, user, services);
}

async function executeWorkflow(
  workflow: Workflow,
  runRequest: {
    input: Record<string, unknown> | null;
    mode: string;
    dryRun: boolean;
    idempotencyKey: string;
  },
  reply: FastifyReply,
  user: CurrentUser,
  services: HandlerServices,
): Promise<unknown> {
  if (
    !user.permissions.includes("workflow:run") &&
    workflow.owner.id !== user.id &&
    !(workflow.assignedUserIds ?? []).includes(user.id)
  )
    throw new HandlerFailure(404, "Execution not found");
  if (workflow.status === "draft-unvalidated")
    throw new HandlerFailure(
      422,
      "Workflow must be validated before execution",
      { status: workflow.status },
    );
  const gate = await validateWorkflow(
    services,
    "RunWorkflow",
    workflow.yaml,
    user,
  );
  if (!gate.result.passed || gate.token === null)
    throw new HandlerFailure(422, "Workflow validation failed", gate.result);
  const blueprint = parseWorkflowYAMLStrict(workflow.yaml);
  if (runRequest.dryRun)
    return reply.send(
      ok(
        {
          can_execute: true,
          dry_run: true,
          validation: gate.result,
          planned_steps: blueprint.steps,
        },
        "Dry run validation passed",
        null,
      ),
    );
  const execution = await services.repository.mutate((state) => {
    const id = `run-${randomBytes(4).toString("hex")}`;
    const value = {
      id,
      workflowId: workflow.id,
      workflowName: workflow.name,
      status: "RUNNING",
      startedAt: now(),
      completedAt: null,
      durationMs: 0,
      tokens: { input: 0, output: 0, total: 0 },
      costUsd: 0,
      startedBy: { id: user.id, name: user.name },
    };
    state.executions[id] = value;
    return value;
  });
  try {
    const dispatchIdentity = createDispatchIdentity(
      user,
      services.config.erpbridgeRoleMap,
    );
    const result = await services.executor.run(
      execution.id,
      workflow,
      runRequest.input ?? {},
      gate.token,
      dispatchIdentity,
    );
    const completed = await services.repository.mutate((state) => {
      const item = state.executions[execution.id]!;
      item.status = "DONE";
      item.completedAt = now();
      item.durationMs = Date.now() - new Date(item.startedAt).getTime();
      item.tokens = result.tokens;
      item.stepOutputs = Object.fromEntries(
        Object.entries(result.state).filter(([key]) => key !== "input"),
      );
      item.finalOutput = result.timeline.at(-1)?.output;
      state.executionLogs[item.id] = result.logs.map((log, index) => ({
        id: `log_${index + 1}`,
        executionId: item.id,
        ...log,
      }));
      state.timelines[item.id] = result.timeline;
      const storedWorkflow = state.workflows[workflow.id];
      if (storedWorkflow !== undefined) {
        storedWorkflow.lastRunAt = item.completedAt;
        storedWorkflow.status = "DONE";
        storedWorkflow.updatedAt = item.completedAt;
      }
      appendAudit(
        state,
        user,
        "execution.completed",
        "execution",
        item.id,
        null,
        { status: item.status },
        undefined,
      );
      return structuredClone(item);
    });
    return reply.send(
      ok(
        completed,
        `Workflow ${workflow.name} completed successfully in ${result.timeline.length} steps`,
        null,
      ),
    );
  } catch (error) {
    const partial = partialResult(error);
    const failed = await services.repository.mutate((state) => {
      const item = state.executions[execution.id]!;
      item.status = "FAILED";
      item.completedAt = now();
      item.durationMs = Date.now() - new Date(item.startedAt).getTime();
      item.stepOutputs =
        partial === null
          ? {}
          : Object.fromEntries(
              Object.entries(partial.state).filter(([key]) => key !== "input"),
            );
      item.failure = {
        failureCategory: "TOOL_FAILURE",
        failedStepId: partial?.timeline.at(-1)?.nodeId ?? "unknown",
        failedToolName: "unknown",
        toolWasCalled: partial?.timeline.length !== 0,
      };
      state.executionLogs[item.id] = (partial?.logs ?? []).map(
        (log, index) => ({
          id: `log_${index + 1}`,
          executionId: item.id,
          ...log,
        }),
      );
      state.timelines[item.id] = partial?.timeline ?? [];
      state.healing[item.id] = {
        executionId: item.id,
        workflowId: item.workflowId,
        status: "HEALING_NOT_ATTEMPTED",
        summary: "Automatic healing was not attempted",
        events: [],
        metrics: {},
      };
      appendAudit(
        state,
        user,
        "execution.failure.classified",
        "execution",
        item.id,
        null,
        { failure: item.failure },
        undefined,
      );
      return structuredClone(item);
    });
    throw new HandlerFailure(
      422,
      `Workflow execution failed: ${errorText(error)}`,
      { executionId: failed.id, status: failed.status },
    );
  }
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
    execution === null ||
    (!user.permissions.includes("workflow:read") &&
      execution.startedBy.id !== user.id)
  )
    throw new HandlerFailure(404, "Execution not found");
  return execution;
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
