import type { FastifyReply, FastifyRequest } from "fastify";
import { fail, ok, type Workflow } from "../../models/schemas.js";
import { workflowCanvasSchema } from "../../models/boundary.js";
import { checksum, parseWorkflowYAMLStrict, workflowContentHash } from "../../parser/workflow.js";
import type { RouteDefinition } from "../generated-routes.js";
import { appendAudit, bodyRecord, HandlerFailure, type CurrentUser, type HandlerServices, isRecord, nextID, now, publicUser, requestParam, stringValue, validateWorkflow } from "./common.js";

export const WORKFLOW_UNHANDLED = Symbol("workflow-unhandled");

export async function handleWorkflowRoute(
  route: RouteDefinition,
  request: FastifyRequest,
  reply: FastifyReply,
  user: CurrentUser,
  services: HandlerServices,
): Promise<unknown | typeof WORKFLOW_UNHANDLED> {
  const base = services.config.apiBasePath;
  const path = route.path;
  try {
    if (path === `${base}/workflows/templates` && route.method === "GET") {
      const templates = await services.repository.read((state) => Object.values(state.templates));
      return reply.send(ok(templates, "OK", null));
    }
    if (path === `${base}/workflows/templates` && route.method === "POST") return createTemplate(request, reply, services);
    if (path === `${base}/workflows/templates/:id/use`) return useTemplate(request, reply, user, services);
    if (path === `${base}/workflows/assignable-users`) {
      const users = await services.repository.read((state) => Object.values(state.users).filter((item) => item.status.toLowerCase() === "active").map((item) => ({ id: item.id, name: item.name, email: item.email, role: state.roles[item.roleId]?.name ?? "" })));
      return reply.send(ok(users, "Assignable users loaded", { count: users.length }));
    }
    if (path === `${base}/workflows/:id` && route.method === "PATCH") return updateWorkflow(request, reply, user, services);
    if (path === `${base}/workflows/:id` && route.method === "DELETE") return deleteWorkflow(request, reply, services);
    if (path === `${base}/workflows/:id/duplicate`) return duplicateWorkflow(request, reply, user, services);
    if (path === `${base}/workflows/:id/publish`) return publishWorkflow(request, reply, user, services);
    if (path === `${base}/workflows/:id/archive`) return archiveWorkflow(request, reply, services);
    if (path === `${base}/workflows/:id/assign`) return assignWorkflow(request, reply, user, services);
    if (path === `${base}/workflows/:id/assign/:userId`) return unassignWorkflow(request, reply, user, services);
    if (path === `${base}/workflows/:id/yaml` && route.method === "GET") return getWorkflowYAML(request, reply, user, services);
    if (path === `${base}/workflows/:id/yaml` && route.method === "PUT") return putWorkflowYAML(request, reply, user, services);
    if (path === `${base}/workflows/:id/canvas` && route.method === "GET") return getWorkflowCanvas(request, reply, user, services);
    if (path === `${base}/workflows/:id/canvas` && route.method === "PUT") return putWorkflowCanvas(request, reply, services);
    if (path === `${base}/workflows/:id/versions`) return workflowVersions(request, reply, user, services);
    if (path === `${base}/workflows/:id/restore/:versionId`) return restoreWorkflowVersion(request, reply, user, services);
    if (path === `${base}/workflows/:id/executions`) return workflowExecutions(request, reply, user, services);
  } catch (error) {
    if (error instanceof HandlerFailure) return reply.status(error.status).send(fail(error.message, error.meta));
    throw error;
  }
  return WORKFLOW_UNHANDLED;
}

async function createTemplate(request: FastifyRequest, reply: FastifyReply, services: HandlerServices): Promise<unknown> {
  const body = bodyRecord(request);
  if (body === null) throw new HandlerFailure(400, "Invalid request body");
  const template = await services.repository.mutate((state) => {
    const id = nextID(state, "tpl");
    const value = { id, name: stringValue(body.name), description: stringValue(body.description), category: stringValue(body.category), tags: Array.isArray(body.tags) ? body.tags.filter((item): item is string => typeof item === "string") : null, yaml: stringValue(body.yaml), steps: typeof body.steps === "number" ? Math.trunc(body.steps) : 0, createdAt: now() };
    state.templates[id] = value;
    return value;
  });
  return reply.status(201).send(ok(template, "Template created", null));
}

async function useTemplate(request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown> {
  const template = await services.repository.read((state) => state.templates[requestParam(request, "id")] ?? null);
  if (template === null) throw new HandlerFailure(404, "Template not found");
  const yaml = stringValue(template.yaml);
  let blueprint;
  try { blueprint = parseWorkflowYAMLStrict(yaml); } catch (error) { throw new HandlerFailure(422, "Workflow validation failed", { error: errorText(error) }); }
  const gate = await validateWorkflow(services, "UseTemplate", yaml, user);
  if (!gate.result.passed) throw new HandlerFailure(422, "Workflow validation failed", gate.result);
  const body = request.body === undefined ? {} : bodyRecord(request);
  if (body === null) throw new HandlerFailure(400, "Invalid request body");
  const requestedName = stringValue(body.name).trim();
  const workflow = await services.repository.mutate((state) => {
    const value = newWorkflow(state, requestedName === "" ? blueprint.name : requestedName, blueprint.description ?? "", yaml, blueprint, user);
    state.workflows[value.id] = value;
    return value;
  });
  return reply.status(201).send(ok(publicWorkflow(workflow), "Template converted to workflow", null));
}

async function updateWorkflow(request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown> {
  const body = bodyRecord(request);
  if (body === null) throw new HandlerFailure(400, "Invalid request body");
  const id = requestParam(request, "id");
  const current = await services.repository.read((state) => state.workflows[id] ?? null);
  if (current === null) throw new HandlerFailure(404, "Workflow not found");
  const contentHash = workflowContentHash(current.yaml);
  const gate = await validateWorkflow(services, "UpdateWorkflow", current.yaml, user);
  if (!gate.result.passed) throw new HandlerFailure(422, "Workflow validation failed", gate.result);
  const updated = await services.repository.mutate((state) => {
    const item = state.workflows[id];
    if (item === undefined) throw new HandlerFailure(404, "Workflow not found");
    if (workflowContentHash(item.yaml) !== contentHash) throw new HandlerFailure(409, "Workflow content changed during validation");
    const before = publicWorkflow(item);
    if (typeof body.name === "string") item.name = body.name;
    if (typeof body.description === "string") item.description = body.description;
    if (typeof body.status === "string") item.status = body.status;
    if (isRecord(body.trigger)) item.trigger = structuredClone(body.trigger);
    if (Array.isArray(body.tags) && body.tags.every((value) => typeof value === "string")) item.tags = [...body.tags] as string[];
    item.updatedAt = now();
    appendAudit(state, user, "workflow.updated", "workflow", id, before, publicWorkflow(item), request);
    return structuredClone(item);
  });
  return reply.send(ok(publicWorkflow(updated), "Workflow updated", null));
}

async function deleteWorkflow(request: FastifyRequest, reply: FastifyReply, services: HandlerServices): Promise<unknown> {
  const id = requestParam(request, "id");
  const deleted = await services.repository.mutate((state) => {
    if (state.workflows[id] === undefined) return false;
    delete state.workflows[id];
    return true;
  });
  if (!deleted) throw new HandlerFailure(404, "Workflow not found");
  return reply.send(ok({ deleted: true }, "Workflow deleted", null));
}

async function duplicateWorkflow(request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown> {
  const body = request.body === undefined ? {} : bodyRecord(request);
  if (body === null) throw new HandlerFailure(400, "Invalid request body");
  const sourceID = requestParam(request, "id");
  const copy = await services.repository.mutate((state) => {
    const source = state.workflows[sourceID];
    if (source === undefined) throw new HandlerFailure(404, "Workflow not found");
    const id = nextID(state, "wf");
    const createdAt = now();
    const providedName = stringValue(body.name).trim();
    const value: Workflow = structuredClone(source);
    value.id = id; value.name = providedName === "" ? `${source.name} Copy` : providedName; value.owner = { id: user.id, name: user.name }; value.status = "PENDING"; value.assignedUserIds = []; value.publishedVersion = 0; value.draftVersion = 1; value.lastRunAt = null; value.createdAt = createdAt; value.updatedAt = createdAt; value.archived = false;
    if (value.canvas !== undefined) value.canvas.workflowId = id;
    state.workflows[id] = value;
    return structuredClone(value);
  });
  return reply.status(201).send(ok(publicWorkflow(copy), "Workflow duplicated", null));
}

async function publishWorkflow(request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown> {
  const body = request.body === undefined ? {} : bodyRecord(request);
  if (body === null) throw new HandlerFailure(400, "Invalid request body");
  const id = requestParam(request, "id");
  const current = await services.repository.read((state) => state.workflows[id] ?? null);
  if (current === null) throw new HandlerFailure(404, "Workflow not found");
  if (current.status === "draft-unvalidated") throw new HandlerFailure(422, "Workflow must be validated before publishing", { status: current.status });
  const expectedHash = workflowContentHash(current.yaml);
  const gate = await validateWorkflow(services, "PublishWorkflow", current.yaml, user);
  if (!gate.result.passed) throw new HandlerFailure(422, "Workflow validation failed", gate.result);
  const version = await services.repository.mutate((state) => {
    const item = state.workflows[id];
    if (item === undefined) throw new HandlerFailure(404, "Workflow not found");
    if (workflowContentHash(item.yaml) !== expectedHash) throw new HandlerFailure(409, "Workflow content changed during validation");
    item.publishedVersion = item.draftVersion; item.updatedAt = now();
    const value = { id: nextID(state, "ver"), workflowId: id, version: item.publishedVersion, versionNote: stringValue(body.versionNote), yaml: item.yaml, createdAt: now(), createdBy: { id: user.id, name: user.name } };
    const versions = state.versions[id] ?? [];
    versions.push(value); state.versions[id] = versions;
    return value;
  });
  return reply.send(ok(version, "Workflow published", null));
}

async function archiveWorkflow(request: FastifyRequest, reply: FastifyReply, services: HandlerServices): Promise<unknown> {
  const id = requestParam(request, "id");
  const found = await services.repository.mutate((state) => { const item = state.workflows[id]; if (item === undefined) return false; item.archived = true; item.status = "DONE"; item.updatedAt = now(); return true; });
  if (!found) throw new HandlerFailure(404, "Workflow not found");
  return reply.send(ok({ archived: true }, "Workflow archived", null));
}

async function assignWorkflow(request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown> {
  const body = bodyRecord(request);
  if (body === null || stringValue(body.userId).trim() === "") throw new HandlerFailure(400, "userId is required");
  const workflowID = requestParam(request, "id");
  const targetID = stringValue(body.userId);
  const workflow = await services.repository.mutate((state) => {
    const item = state.workflows[workflowID]; if (item === undefined) throw new HandlerFailure(404, "Workflow not found");
    if (state.users[targetID] === undefined) throw new HandlerFailure(404, "User not found");
    const assigned = item.assignedUserIds ?? [];
    if (!assigned.includes(targetID)) assigned.push(targetID);
    item.assignedUserIds = assigned; item.updatedAt = now();
    appendAudit(state, user, "workflow.user_assigned", "workflow", workflowID, null, { userId: targetID }, request);
    return structuredClone(item);
  });
  return reply.send(ok(publicWorkflow(workflow), "User assigned to workflow", null));
}

async function unassignWorkflow(request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown> {
  const workflowID = requestParam(request, "id"); const targetID = requestParam(request, "userId");
  const workflow = await services.repository.mutate((state) => {
    const item = state.workflows[workflowID]; if (item === undefined) throw new HandlerFailure(404, "Workflow not found");
    item.assignedUserIds = (item.assignedUserIds ?? []).filter((id) => id.toLowerCase() !== targetID.toLowerCase()); item.updatedAt = now();
    appendAudit(state, user, "workflow.user_unassigned", "workflow", workflowID, { userId: targetID }, null, request);
    return structuredClone(item);
  });
  return reply.send(ok(publicWorkflow(workflow), "User unassigned from workflow", null));
}

async function getWorkflowYAML(request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown> {
  const workflow = await visibleWorkflow(requestParam(request, "id"), user, services);
  if (workflow === null) throw new HandlerFailure(404, "Workflow not found");
  return reply.send(ok(yamlRecord(workflow), "OK", null));
}

async function putWorkflowYAML(request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown> {
  const body = bodyRecord(request); if (body === null) throw new HandlerFailure(400, "Invalid request body");
  const raw = stringValue(body.yaml);
  let blueprint; try { blueprint = parseWorkflowYAMLStrict(raw); } catch (error) { throw new HandlerFailure(422, "Workflow YAML failed validation", { error: errorText(error) }); }
  const gate = await validateWorkflow(services, "PutWorkflowYAML", raw, user); if (!gate.result.passed) throw new HandlerFailure(422, "Workflow YAML failed validation", gate.result);
  const id = requestParam(request, "id");
  const workflow = await services.repository.mutate((state) => {
    const item = state.workflows[id]; if (item === undefined) throw new HandlerFailure(404, "Workflow not found");
    item.yaml = raw; item.steps = blueprint.steps.length; item.draftVersion += 1; item.updatedAt = now(); item.status = item.status === "draft-unvalidated" ? "PENDING" : item.status; item.canvas = canvasFromBlueprint(id, blueprint);
    return structuredClone(item);
  });
  return reply.send(ok(yamlRecord(workflow), "Workflow YAML updated", null));
}

async function getWorkflowCanvas(request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown> {
  const workflow = await visibleWorkflow(requestParam(request, "id"), user, services); if (workflow === null) throw new HandlerFailure(404, "Workflow not found");
  const canvas = workflow.canvas ?? canvasFromBlueprint(workflow.id, parseWorkflowYAMLStrict(workflow.yaml));
  return reply.send(ok(canvas, "OK", null));
}

async function putWorkflowCanvas(request: FastifyRequest, reply: FastifyReply, services: HandlerServices): Promise<unknown> {
  const id = requestParam(request, "id");
  if (await services.repository.read((state) => state.workflows[id] === undefined)) throw new HandlerFailure(404, "Workflow not found");
  const parsed = workflowCanvasSchema.safeParse(request.body); if (!parsed.success) throw new HandlerFailure(400, "Invalid request body");
  const canvas = { ...parsed.data, workflowId: id };
  await services.repository.mutate((state) => { const item = state.workflows[id]; if (item === undefined) throw new HandlerFailure(404, "Workflow not found"); const old = item.canvas; item.canvas = canvas as unknown as Record<string, unknown>; if (old !== undefined && executionShape(old) !== executionShape(canvas as unknown as Record<string, unknown>)) item.status = "draft-unvalidated"; item.updatedAt = now(); });
  return reply.send(ok(canvas, "Workflow canvas updated", null));
}

async function workflowVersions(request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown> {
  const id = requestParam(request, "id"); if (await visibleWorkflow(id, user, services) === null) throw new HandlerFailure(404, "Workflow not found");
  const versions = await services.repository.read((state) => state.versions[id] ?? []); return reply.send(ok(versions, "OK", null));
}

async function restoreWorkflowVersion(request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown> {
  const id = requestParam(request, "id"); const versionID = requestParam(request, "versionId");
  const snapshot = await services.repository.read((state) => ({ workflow: state.workflows[id] ?? null, version: (state.versions[id] ?? []).find((item) => item.id === versionID) ?? null }));
  if (snapshot.workflow === null) throw new HandlerFailure(404, "Workflow not found"); if (snapshot.version === null) throw new HandlerFailure(404, "Workflow version not found");
  const raw = stringValue(snapshot.version.yaml); let blueprint; try { blueprint = parseWorkflowYAMLStrict(raw); } catch (error) { throw new HandlerFailure(422, "Workflow validation failed", { error: errorText(error) }); }
  const expectedHash = workflowContentHash(raw); const gate = await validateWorkflow(services, "RestoreWorkflowVersion", raw, user); if (!gate.result.passed) throw new HandlerFailure(422, "Workflow validation failed", gate.result);
  const workflow = await services.repository.mutate((state) => { const item = state.workflows[id]; const version = (state.versions[id] ?? []).find((value) => value.id === versionID); if (item === undefined || version === undefined) throw new HandlerFailure(404, "Workflow version not found"); if (workflowContentHash(stringValue(version.yaml)) !== expectedHash) throw new HandlerFailure(409, "Workflow version content changed during validation"); item.yaml = raw; item.steps = blueprint.steps.length; item.draftVersion += 1; item.status = "PENDING"; item.updatedAt = now(); item.canvas = canvasFromBlueprint(id, blueprint); return structuredClone(item); });
  return reply.send(ok(publicWorkflow(workflow), "Workflow restored", null));
}

async function workflowExecutions(request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown> {
  const id = requestParam(request, "id"); if (await visibleWorkflow(id, user, services) === null) throw new HandlerFailure(404, "Workflow not found");
  const executions = await services.repository.read((state) => Object.values(state.executions).filter((item) => item.workflowId === id));
  return reply.send(ok(executions, "OK", { page: 1, limit: 20, total: executions.length, totalPages: executions.length === 0 ? 0 : 1 }));
}

function newWorkflow(state: Parameters<typeof nextID>[0], name: string, description: string, yaml: string, blueprint: ReturnType<typeof parseWorkflowYAMLStrict>, user: CurrentUser): Workflow {
  const id = nextID(state, "wf"); const createdAt = now();
  return { id, name, description, owner: { id: user.id, name: user.name }, assignedUserIds: [], status: "PENDING", trigger: blueprint.trigger as unknown as Record<string, unknown>, steps: blueprint.steps.length, successRate: 0, lastRunAt: null, publishedVersion: 0, draftVersion: 1, tags: [], domainTags: [], canRun: true, createdAt, updatedAt: createdAt, yaml, archived: false, canvas: canvasFromBlueprint(id, blueprint) };
}

function canvasFromBlueprint(workflowID: string, blueprint: ReturnType<typeof parseWorkflowYAMLStrict>): Record<string, unknown> {
  const nodes = blueprint.steps.map((step, index) => ({ id: step.id, label: step.description?.trim() === "" || step.description === undefined ? step.action ?? step.id : step.description, type: step.kind === undefined || step.kind === "" ? "tool" : step.kind, position: { x: 80 + index * 260, y: 120 }, status: "idle", config: { action: step.action ?? "", parameters: step.parameters ?? {} } }));
  const edges = nodes.slice(1).map((node, index) => ({ id: `edge_${index + 1}`, source: nodes[index]!.id, target: node.id, type: "default", label: null }));
  return { workflowId: workflowID, nodes, edges, viewport: { x: 0, y: 0, zoom: 1 } };
}

function yamlRecord(workflow: Workflow): Record<string, unknown> { return { workflowId: workflow.id, version: workflow.draftVersion, yaml: workflow.yaml, checksum: checksum(workflow.yaml), updatedAt: workflow.updatedAt }; }
function publicWorkflow(workflow: Workflow): Record<string, unknown> { const { yaml: _yaml, archived: _archived, canvas: _canvas, ...visible } = workflow; return visible; }
async function visibleWorkflow(id: string, user: CurrentUser, services: HandlerServices): Promise<Workflow | null> { return services.repository.read((state) => { const item = state.workflows[id]; if (item === undefined) return null; if (user.permissions.includes("workflow:read") || item.owner.id === user.id || (item.assignedUserIds ?? []).includes(user.id)) return structuredClone(item); return null; }); }
function executionShape(canvas: Record<string, unknown>): string { const nodes = Array.isArray(canvas.nodes) ? canvas.nodes.map((node) => isRecord(node) ? { id: node.id, type: node.type, config: node.config } : node) : []; const edges = Array.isArray(canvas.edges) ? canvas.edges.map((edge) => isRecord(edge) ? { source: edge.source, target: edge.target, type: edge.type, label: edge.label } : edge) : []; return JSON.stringify({ nodes, edges }); }
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
