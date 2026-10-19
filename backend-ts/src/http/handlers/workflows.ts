import { publishWorkflowSnapshot } from "../../workflows/publication.js";
import type { FastifyReply, FastifyRequest } from "fastify";
import { fail, ok, type Workflow } from "../../models/schemas.js";
import { workflowCanvasSchema } from "../../models/boundary.js";
import { checksum, parseWorkflowYAMLStrict, workflowContentHash } from "../../parser/workflow.js";
import type { RouteDefinition } from "../generated-routes.js";
import { appendAudit, bodyRecord, HandlerFailure, type CurrentUser, type HandlerServices, isRecord, nextID, now, requestParam, stringValue, validateWorkflow } from "./common.js";
import { requestTraceId } from "../../trace/request-trace.js";
import { evaluateOptionalPolicy } from "../../governance/optional-policy.js";
import { handleWorkflowCommand, assertCurrentWorkflowEditor } from "./workflow-commands.js";
import { z } from "zod";
import { assertWorkflowMutable, requireWorkflowBase, workflowRevisionSchema, permittedWorkflow } from "../../workflows/commands.js";
import { historyPage, historyVersion, saveDraftRevision } from "../../workflows/draft-history.js";
import { validateWorkspaceDraft } from "../../workflows/draft-validation.js";
import { assertActorAuthority } from "./model-selection.js";
import { publicWorkflowVersion } from "../../workflows/public-workflow-version.js";

export const WORKFLOW_UNHANDLED = Symbol("workflow-unhandled");

/*******************************************************************************
 * Function: handleWorkflowRoute
 *
 * Dispatches workflow, template, assignment, canvas, and version requests.
 ******************************************************************************/
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
    for (const kind of ["commands", "node-proposals", "readiness"] as const) {
      if (path === `${base}/workflows/:id/${kind}`) return handleWorkflowCommand(kind, request, reply, user, services);
    }
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
    if (path === `${base}/workflows/:id/approve-generation`) return approveWorkflowGeneration(request, reply, user, services);
    if (path === `${base}/workflows/:id/reject-generation`) return rejectWorkflowGeneration(request, reply, user, services);
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

/*******************************************************************************
 * Function: createTemplate
 *
 * Validates and creates a workflow template.
 ******************************************************************************/
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

/*******************************************************************************
 * Function: useTemplate
 *
 * Creates a workflow using the selected template.
 ******************************************************************************/
async function useTemplate(request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown> {
  const templateId = requestParam(request, "id");
  const template = await services.repository.readAuthoritative((state) => structuredClone(state.templates[templateId] ?? null));
  if (template === null) throw new HandlerFailure(404, "Template not found");
  const yaml = stringValue(template.yaml);
  let blueprint;
  try { blueprint = parseWorkflowYAMLStrict(yaml); } catch (error) { throw new HandlerFailure(422, "Workflow validation failed", { error: errorText(error) }); }
  const traceId = requestTraceId(request);
  const registryHash = services.registries.hash();
  const gate = await validateWorkflow(services, "UseTemplate", yaml, user, { traceId });
  if (!gate.result.passed) throw new HandlerFailure(422, "Workflow validation failed", { ...gate.result, traceId });
  const validation = validateWorkspaceDraft("UseTemplate", yaml, user.role, services.validator, services.registries.snapshot().tools);
  if (!validation.passed) throw new HandlerFailure(422, "Workflow validation failed", validation);
  const body = request.body === undefined ? {} : bodyRecord(request);
  if (body === null) throw new HandlerFailure(400, "Invalid request body");
  const requestedName = stringValue(body.name).trim();
  const workflow = await services.repository.mutate((state) => {
    const permissions = assertActorAuthority(state, user);
    if (!permissions.includes("workflow:write")) throw new HandlerFailure(403, "Current workflow write authority is required");
    if (services.registries.hash() !== registryHash) throw new HandlerFailure(409, "Registry changed during validation; validate the draft again", { code: "DRAFT_REGISTRY_CHANGED" });
    const current = state.templates[templateId];
    if (!current || stringValue(current.yaml) !== yaml) throw new HandlerFailure(409, "Template changed during validation; reload before creating a workflow", { code: "TEMPLATE_CHANGED" });
    const value = newWorkflow(state, requestedName === "" ? blueprint.name : requestedName, blueprint.description ?? "", yaml, blueprint, user);
    state.workflows[value.id] = value;
    appendAudit(state, user, "workflow.created_from_template", "workflow", value.id, null,
      { sourceTemplateId: templateId, sourceHash: workflowContentHash(yaml), draftVersion: value.draftVersion, canRun: value.canRun }, request);
    return value;
  });
  return reply.status(201).send(ok(publicWorkflow(workflow), "Template converted to workflow", null));
}

/*******************************************************************************
 * Function: updateWorkflow
 *
 * Validates and applies changes to an existing workflow.
 ******************************************************************************/
async function updateWorkflow(request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown> {
  const body = bodyRecord(request);
  if (body === null) throw new HandlerFailure(400, "Invalid request body");
  if (isRecord(body.trigger) && body.trigger.type === "schedule")
    throw new HandlerFailure(422, "Scheduled execution must be configured through the authoritative workflow schedule endpoint", { code: "LEGACY_SCHEDULE_TRIGGER_REJECTED" });
  const id = requestParam(request, "id");
  const current = await services.repository.read((state) => state.workflows[id] ?? null);
  if (current === null) throw new HandlerFailure(404, "Workflow not found");
  assertWorkflowMutable(current);
  const contentHash = workflowContentHash(current.yaml);
  const traceId = requestTraceId(request, current.traceId);
  const gate = await validateWorkflow(services, "UpdateWorkflow", current.yaml, user, { traceId, workflowId: current.id });
  if (!gate.result.passed) throw new HandlerFailure(422, "Workflow validation failed", { ...gate.result, traceId });
  const updated = await services.repository.mutate((state) => {
    const item = state.workflows[id];
    if (item === undefined) throw new HandlerFailure(404, "Workflow not found");
    assertWorkflowMutable(item);
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

/*******************************************************************************
 * Function: deleteWorkflow
 *
 * Deletes the requested workflow.
 ******************************************************************************/
async function deleteWorkflow(request: FastifyRequest, reply: FastifyReply, services: HandlerServices): Promise<unknown> {
  const id = requestParam(request, "id");
  const deleted = await services.repository.mutate((state) => {
    if (state.workflows[id] === undefined) return false;
    assertWorkflowMutable(state.workflows[id]!);
    const scheduleId = `schedule-${id}`;
    delete state.schedules[scheduleId];
    for (const [occurrenceId, occurrence] of Object.entries(state.scheduleOccurrences)) if (occurrence.scheduleId === scheduleId) delete state.scheduleOccurrences[occurrenceId];
    delete state.workflows[id];
    return true;
  });
  if (!deleted) throw new HandlerFailure(404, "Workflow not found");
  return reply.send(ok({ deleted: true }, "Workflow deleted", null));
}

/*******************************************************************************
 * Function: duplicateWorkflow
 *
 * Creates a copy of an existing workflow for the current user.
 ******************************************************************************/
async function duplicateWorkflow(request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown> {
  const body = request.body === undefined ? {} : bodyRecord(request);
  if (body === null) throw new HandlerFailure(400, "Invalid request body");
  const sourceID = requestParam(request, "id");
  const source = await services.repository.readAuthoritative((state) => {
    const value = state.workflows[sourceID];
    if (!value || !permittedWorkflow(value, user, false)) return null;
    assertWorkflowMutable(value);
    return structuredClone(value);
  });
  if (source === null) throw new HandlerFailure(404, "Workflow not found");
  let blueprint;
  try { blueprint = parseWorkflowYAMLStrict(source.yaml); }
  catch (error) { throw new HandlerFailure(422, "Workflow validation failed", { error: errorText(error) }); }
  const traceId = requestTraceId(request);
  const registryHash = services.registries.hash();
  const gate = await validateWorkflow(services, "DuplicateWorkflow", source.yaml, user, { traceId, workflowId: sourceID });
  if (!gate.result.passed) throw new HandlerFailure(422, "Workflow validation failed", { ...gate.result, traceId });
  const validation = validateWorkspaceDraft("DuplicateWorkflow", source.yaml, user.role, services.validator, services.registries.snapshot().tools);
  if (!validation.passed) throw new HandlerFailure(422, "Workflow validation failed", validation);
  const sourceHash = workflowContentHash(source.yaml), sourceVersion = source.draftVersion;
  const copy = await services.repository.mutate((state) => {
    const permissions = assertActorAuthority(state, user);
    if (!permissions.includes("workflow:write")) throw new HandlerFailure(403, "Current workflow write authority is required");
    if (services.registries.hash() !== registryHash) throw new HandlerFailure(409, "Registry changed during validation; validate the draft again", { code: "DRAFT_REGISTRY_CHANGED" });
    const current = state.workflows[sourceID];
    if (!current || !permittedWorkflow(current, user, false)) throw new HandlerFailure(404, "Workflow not found");
    assertWorkflowMutable(current);
    if (current.draftVersion !== sourceVersion || workflowContentHash(current.yaml) !== sourceHash)
      throw new HandlerFailure(409, "Source workflow changed during validation; reload before duplicating", { code: "WORKFLOW_CHANGED" });
    const providedName = stringValue(body.name).trim();
    const value = newWorkflow(state, providedName === "" ? `${source.name} Copy` : providedName, source.description, source.yaml, blueprint, user);
    value.tags = structuredClone(source.tags);
    value.domainTags = structuredClone(source.domainTags);
    state.workflows[value.id] = value;
    appendAudit(state, user, "workflow.duplicated", "workflow", value.id, null,
      { sourceWorkflowId: sourceID, sourceVersion, sourceHash, draftVersion: value.draftVersion, canRun: value.canRun }, request);
    return structuredClone(value);
  });
  return reply.status(201).send(ok(publicWorkflow(copy), "Workflow duplicated", null));
}

/*******************************************************************************
 * Function: publishWorkflow
 *
 * Validates a workflow before publishing it.
 ******************************************************************************/
async function publishWorkflow(request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown> {
  const body = request.body === undefined ? {} : bodyRecord(request);
  if (body === null) throw new HandlerFailure(400, "Invalid request body");
  const version = await publishWorkflowSnapshot(requestParam(request, "id"), body, request, user, services);
  return reply.send(ok(publicWorkflowVersion(version), "Workflow published", null));
}

/*******************************************************************************
 * Function: archiveWorkflow
 *
 * Marks a workflow as archived.
 ******************************************************************************/
async function archiveWorkflow(request: FastifyRequest, reply: FastifyReply, services: HandlerServices): Promise<unknown> {
  const id = requestParam(request, "id");
  const found = await services.repository.mutate((state) => { const item = state.workflows[id]; if (item === undefined) return false; assertWorkflowMutable(item); item.archived = true; item.status = "DONE"; item.updatedAt = now(); return true; });
  if (!found) throw new HandlerFailure(404, "Workflow not found");
  return reply.send(ok({ archived: true }, "Workflow archived", null));
}

/*******************************************************************************
 * Function: assignWorkflow
 *
 * Assigns a workflow to the requested user.
 ******************************************************************************/
async function assignWorkflow(request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown> {
  const body = bodyRecord(request);
  if (body === null || stringValue(body.userId).trim() === "") throw new HandlerFailure(400, "userId is required");
  const workflowID = requestParam(request, "id");
  const targetID = stringValue(body.userId);
  const workflow = await services.repository.mutate((state) => {
    const item = state.workflows[workflowID]; if (item === undefined) throw new HandlerFailure(404, "Workflow not found");
    assertWorkflowMutable(item);
    if (state.users[targetID] === undefined) throw new HandlerFailure(404, "User not found");
    const assigned = item.assignedUserIds ?? [];
    if (!assigned.includes(targetID)) assigned.push(targetID);
    item.assignedUserIds = assigned; item.updatedAt = now();
    appendAudit(state, user, "workflow.user_assigned", "workflow", workflowID, null, { userId: targetID }, request);
    return structuredClone(item);
  });
  return reply.send(ok(publicWorkflow(workflow), "User assigned to workflow", null));
}

/*******************************************************************************
 * Function: unassignWorkflow
 *
 * Removes an assignment from a workflow.
 ******************************************************************************/
async function unassignWorkflow(request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown> {
  const workflowID = requestParam(request, "id"); const targetID = requestParam(request, "userId");
  const workflow = await services.repository.mutate((state) => {
    const item = state.workflows[workflowID]; if (item === undefined) throw new HandlerFailure(404, "Workflow not found");
    assertWorkflowMutable(item);
    item.assignedUserIds = (item.assignedUserIds ?? []).filter((id) => id.toLowerCase() !== targetID.toLowerCase()); item.updatedAt = now();
    appendAudit(state, user, "workflow.user_unassigned", "workflow", workflowID, { userId: targetID }, null, request);
    return structuredClone(item);
  });
  return reply.send(ok(publicWorkflow(workflow), "User unassigned from workflow", null));
}

/*******************************************************************************
 * Function: getWorkflowYAML
 *
 * Returns the workflow's YAML document.
 ******************************************************************************/
export async function getWorkflowYAML(request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: { repository: Pick<HandlerServices["repository"], "read"> }): Promise<unknown> {
  const workflow = await visibleWorkflow(requestParam(request, "id"), user, services);
  if (workflow === null) throw new HandlerFailure(404, "Workflow not found");
  return reply.send(ok(yamlRecord(workflow), "OK", null));
}

/*******************************************************************************
 * Function: putWorkflowYAML
 *
 * Validates and replaces the workflow's YAML document.
 ******************************************************************************/
async function putWorkflowYAML(request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown> {
  const body = bodyRecord(request); if (body === null) throw new HandlerFailure(400, "Invalid request body");
  const raw = stringValue(body.yaml);
  if (raw.length > 200000) throw new HandlerFailure(422, "Workflow source exceeds supported limits");
  let blueprint; try { blueprint = parseWorkflowYAMLStrict(raw); } catch (error) { throw new HandlerFailure(422, "Workflow YAML failed validation", { error: errorText(error) }); }
  const id = requestParam(request, "id"), current = await services.repository.readAuthoritative(state => {
    const item = state.workflows[id]; if (!item) throw new HandlerFailure(404, "Workflow not found");
    assertCurrentWorkflowEditor(state, item, user); return structuredClone(item);
  });
  if (body.baseVersion !== undefined || body.baseHash !== undefined) {
    const revision = z.object(workflowRevisionSchema).safeParse({ baseVersion: body.baseVersion, baseHash: body.baseHash });
    if (!revision.success) throw new HandlerFailure(400, "Invalid draft revision");
    requireWorkflowBase(current, revision.data.baseVersion, revision.data.baseHash);
  }
  const traceId = requestTraceId(request);
  const gate = await validateWorkflow(services, "PutWorkflowYAML", raw, user, { traceId, workflowId: requestParam(request, "id") }); if (!gate.result.passed) throw new HandlerFailure(422, "Workflow YAML failed validation", { ...gate.result, traceId });
  const validation = validateWorkspaceDraft("PutWorkflowYAML", raw, user.role, services.validator, services.registries.snapshot().tools);
  const workflow = await services.repository.mutate((state) => {
    const item = state.workflows[id]; if (item === undefined) throw new HandlerFailure(404, "Workflow not found");
    const editor = assertCurrentWorkflowEditor(state, item, user); requireWorkflowBase(item, current.draftVersion, workflowContentHash(current.yaml));
    saveDraftRevision(state, item, raw, { type: "restoreDraft", yaml: raw }, editor, validation.passed); item.canvas = canvasFromBlueprint(id, blueprint);
    appendAudit(state, editor, "workflow.yaml.updated", "workflow", id, { contentHash: workflowContentHash(current.yaml) }, { contentHash: workflowContentHash(raw), version: item.draftVersion }, request);
    return structuredClone(item);
  });
  return reply.send(ok({ ...yamlRecord(workflow), validation, canRun: workflow.canRun, status: workflow.status }, validation.passed ? "Workflow YAML updated" : "Workflow draft saved with executable validation errors; publishing and running remain blocked", null));
}

// Generation acceptance records review of the proposal. It never removes
// executable approval nodes or grants authorization for future transactions.
/*******************************************************************************
 * Function: approveWorkflowGeneration
 *
 * Records approval of a generated workflow and its validation outcome.
 ******************************************************************************/
async function approveWorkflowGeneration(request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown> {
  const id = requestParam(request, "id");
  const body = request.body === undefined ? {} : bodyRecord(request);
  if (body === null) throw new HandlerFailure(400, "Invalid request body");
  const note = stringValue(body.note).trim();

  const current = await services.repository.read((state) => state.workflows[id] ?? null);
  if (current === null) throw new HandlerFailure(404, "Workflow not found");
  assertWorkflowMutable(current);
  const pending = current.pendingGenerationApproval;
  if (pending === undefined || pending === null || pending.steps.length === 0)
    throw new HandlerFailure(409, "This workflow has no pending generation approval");

  const policy = await evaluateOptionalPolicy(services, user, { action: "approve_workflow_generation",
    prompt: `Accept workflow generation proposal: ${current.name}`, context: { workflowId: id, steps: pending.steps }, signal: request.signal, traceId: requestTraceId(request) });
  if (policy.decision !== "allow") throw new HandlerFailure(403, policy.reason, { policyCheck: policy });

  let blueprint; try { blueprint = parseWorkflowYAMLStrict(current.yaml); } catch (error) { throw new HandlerFailure(422, "Workflow YAML failed validation", { error: errorText(error) }); }
  // Generation acceptance is not permission for future transactions.
  const resolvedSteps = blueprint.steps;
  const newYaml = current.yaml;
  const traceId = requestTraceId(request, current.traceId);
  const gate = await validateWorkflow(services, "ApproveWorkflowGeneration", newYaml, user, { traceId, workflowId: id });
  if (!gate.result.passed) throw new HandlerFailure(422, "Workflow failed validation after resolving approval", { ...gate.result, traceId });

  const approvedAt = now();
  const workflow = await services.repository.mutate((state) => {
    const item = state.workflows[id]; if (item === undefined) throw new HandlerFailure(404, "Workflow not found");
    const before = publicWorkflow(item);
    if (item.yaml !== current.yaml || item.draftVersion !== current.draftVersion)
      throw new HandlerFailure(409, "Workflow changed while accepting the proposal; reload and review it again");
    item.steps = resolvedSteps.length; item.status = "PENDING"; item.updatedAt = now();
    item.canvas = canvasFromBlueprint(id, { ...blueprint, steps: resolvedSteps });
    item.pendingGenerationApproval = null;
    item.generationApprovals = [...(item.generationApprovals ?? []), { approvedBy: { id: user.id, name: user.name }, approvedAt, ...(note ? { note } : {}) }];
    appendAudit(state, user, "workflow.generation_approved", "workflow", id, before, publicWorkflow(item), request);
    if (item.chatSessionId !== undefined) {
      const chat = state.chats[item.chatSessionId];
      if (chat !== undefined) {
        const msg = {
          id: nextID(state, "msg"),
          role: "system",
          text: `**${item.name}** generation proposal accepted. Runtime approval checkpoints remain required for each applicable execution.${note ? `\n\n_Note: ${note}_` : ""}`,
          artifacts: { intent: "GENERATION_APPROVAL_RESOLVED", workflowId: id, resolution: "approved" },
          createdAt: now(),
          traceId,
        };
        chat.messages.push(msg); chat.messageCount = chat.messages.length; chat.updatedAt = now();
      }
    }
    return structuredClone(item);
  });
  return reply.send(ok(publicWorkflow(workflow), "Generation proposal accepted; runtime approval checkpoints are preserved", null));
}

/*******************************************************************************
 * Function: rejectWorkflowGeneration
 *
 * Records rejection of a generated workflow.
 ******************************************************************************/
async function rejectWorkflowGeneration(request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown> {
  const id = requestParam(request, "id");
  const body = request.body === undefined ? {} : bodyRecord(request);
  if (body === null) throw new HandlerFailure(400, "Invalid request body");
  const reason = stringValue(body.reason).trim();

  const current = await services.repository.read((state) => state.workflows[id] ?? null);
  if (current === null) throw new HandlerFailure(404, "Workflow not found");
  assertWorkflowMutable(current);
  const pending = current.pendingGenerationApproval;
  if (pending === undefined || pending === null || pending.steps.length === 0)
    throw new HandlerFailure(409, "This workflow has no pending generation approval");

  const traceId = requestTraceId(request, current.traceId);
  const workflow = await services.repository.mutate((state) => {
    const item = state.workflows[id]; if (item === undefined) throw new HandlerFailure(404, "Workflow not found");
    const before = publicWorkflow(item);
    item.archived = true; item.status = "REJECTED"; item.canRun = false; item.pendingGenerationApproval = null; item.updatedAt = now();
    appendAudit(state, user, "workflow.generation_rejected", "workflow", id, before, publicWorkflow(item), request);
    if (item.chatSessionId !== undefined) {
      const chat = state.chats[item.chatSessionId];
      if (chat !== undefined) {
        const msg = {
          id: nextID(state, "msg"),
          role: "system",
          text: `**${item.name}** was rejected and will not be used.${reason ? `\n\n_Reason: ${reason}_` : ""}`,
          artifacts: { intent: "GENERATION_APPROVAL_RESOLVED", workflowId: id, resolution: "rejected" },
          createdAt: now(),
          traceId,
        };
        chat.messages.push(msg); chat.messageCount = chat.messages.length; chat.updatedAt = now();
      }
    }
    return structuredClone(item);
  });
  return reply.send(ok(publicWorkflow(workflow), "Workflow rejected", null));
}

/*******************************************************************************
 * Function: getWorkflowCanvas
 *
 * Returns stored canvas data or derives it from the workflow blueprint.
 ******************************************************************************/
async function getWorkflowCanvas(request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown> {
  const workflow = await visibleWorkflow(requestParam(request, "id"), user, services); if (workflow === null) throw new HandlerFailure(404, "Workflow not found");
  const canvas = workflow.canvas ?? canvasFromBlueprint(workflow.id, parseWorkflowYAMLStrict(workflow.yaml));
  return reply.send(ok(canvas, "OK", null));
}

/*******************************************************************************
 * Function: putWorkflowCanvas
 *
 * Stores the supplied canvas data for a workflow.
 ******************************************************************************/
async function putWorkflowCanvas(request: FastifyRequest, reply: FastifyReply, services: HandlerServices): Promise<unknown> {
  const id = requestParam(request, "id");
  if (await services.repository.read((state) => state.workflows[id] === undefined)) throw new HandlerFailure(404, "Workflow not found");
  const parsed = workflowCanvasSchema.safeParse(request.body); if (!parsed.success) throw new HandlerFailure(400, "Invalid request body");
  const canvas = { ...parsed.data, workflowId: id };
  await services.repository.mutate((state) => { const item = state.workflows[id]; if (item === undefined) throw new HandlerFailure(404, "Workflow not found"); assertWorkflowMutable(item); const old = item.canvas; item.canvas = canvas as unknown as Record<string, unknown>; if (old !== undefined && executionShape(old) !== executionShape(canvas as unknown as Record<string, unknown>)) item.status = "draft-unvalidated"; item.updatedAt = now(); });
  return reply.send(ok(canvas, "Workflow canvas updated", null));
}

/*******************************************************************************
 * Function: workflowVersions
 *
 * Returns the saved versions of a workflow.
 ******************************************************************************/
async function workflowVersions(request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown> {
  if ((request.query as Record<string, unknown>)?.view === "edit-history") {
    const query = z.object({ view: z.literal("edit-history"), baseVersion: z.coerce.number().int().min(1), baseHash: workflowRevisionSchema.baseHash,
      beforeId: z.string().min(1).max(128).optional(), versionId: z.string().min(1).max(128).optional(), contentHash: workflowRevisionSchema.baseHash.optional() }).strict().safeParse(request.query);
    if (!query.success || Boolean(query.data.versionId) !== Boolean(query.data.contentHash)) throw new HandlerFailure(400, "Invalid edit history request");
    const result = await services.repository.readAuthoritative(state => {
      assertActorAuthority(state, user); const workflow = state.workflows[requestParam(request, "id")];
      if (!workflow || !permittedWorkflow(workflow, user, false)) throw new HandlerFailure(404, "Workflow not found");
      requireWorkflowBase(workflow, query.data.baseVersion, query.data.baseHash);
      if (query.data.versionId && query.data.contentHash) {
        const version = historyVersion(state, workflow, { versionId: query.data.versionId, contentHash: query.data.contentHash });
        return { id: version.id, version: version.version, contentHash: query.data.contentHash, yaml: version.yaml, artifactState: version.artifactState === "PUBLISHED" ? "PUBLISHED" : "DRAFT" };
      }
      return { ...historyPage(state, workflow, query.data.beforeId), persistence: services.repository.persistence ? "server-persisted" : "memory-only" };
    });
    return reply.send(ok(result, "Saved edit history loaded", null));
  }
  const id = requestParam(request, "id"); if (await visibleWorkflow(id, user, services) === null) throw new HandlerFailure(404, "Workflow not found");
  const versions = await services.repository.read((state) => state.versions[id] ?? []);
  return reply.send(ok(versions.map(publicWorkflowVersion), "OK", null));
}

/*******************************************************************************
 * Function: restoreWorkflowVersion
 *
 * Restores a workflow from a selected saved version.
 ******************************************************************************/
async function restoreWorkflowVersion(request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown> {
  const id = requestParam(request, "id"); const versionID = requestParam(request, "versionId");
  const snapshot = await services.repository.read((state) => ({ workflow: state.workflows[id] ?? null, version: (state.versions[id] ?? []).find((item) => item.id === versionID) ?? null }));
  if (snapshot.workflow === null) throw new HandlerFailure(404, "Workflow not found"); if (snapshot.version === null) throw new HandlerFailure(404, "Workflow version not found");
  if (!permittedWorkflow(snapshot.workflow, user, true)) throw new HandlerFailure(404, "Workflow not found");
  const body = request.body === undefined ? {} : bodyRecord(request); if (!body) throw new HandlerFailure(400, "Invalid request body");
  if (body.baseVersion !== undefined || body.baseHash !== undefined) {
    const revision = z.object(workflowRevisionSchema).safeParse({ baseVersion: body.baseVersion, baseHash: body.baseHash });
    if (!revision.success) throw new HandlerFailure(400, "Invalid draft revision");
    requireWorkflowBase(snapshot.workflow, revision.data.baseVersion, revision.data.baseHash);
  }
  const raw = stringValue(snapshot.version.yaml); let blueprint; try { blueprint = parseWorkflowYAMLStrict(raw); } catch (error) { throw new HandlerFailure(422, "Workflow validation failed", { error: errorText(error) }); }
  const traceId = requestTraceId(request, snapshot.workflow.traceId); const expectedHash = workflowContentHash(raw); const gate = await validateWorkflow(services, "RestoreWorkflowVersion", raw, user, { traceId, workflowId: id }); if (!gate.result.passed) throw new HandlerFailure(422, "Workflow validation failed", { ...gate.result, traceId });
  const validation = validateWorkspaceDraft("RestoreWorkflowVersion", raw, user.role, services.validator, services.registries.snapshot().tools);
  const workflow = await services.repository.mutate((state) => {
    const item = state.workflows[id]; if (!item) throw new HandlerFailure(404, "Workflow not found");
    const editor = assertCurrentWorkflowEditor(state, item, user); requireWorkflowBase(item, snapshot.workflow!.draftVersion, workflowContentHash(snapshot.workflow!.yaml));
    const command = { type: "restoreVersion" as const, versionId: versionID, contentHash: expectedHash };
    saveDraftRevision(state, item, raw, command, editor, validation.passed); item.canvas = canvasFromBlueprint(id, blueprint);
    appendAudit(state, editor, "workflow.version.restored", "workflow", id, { contentHash: workflowContentHash(snapshot.workflow!.yaml) }, { versionId: versionID, version: item.draftVersion, contentHash: expectedHash }, request);
    return structuredClone(item);
  });
  return reply.send(ok({ ...publicWorkflow(workflow), validation }, validation.passed ? "Workflow restored" : "Workflow restored as a blocked draft; executable validation errors must be fixed before publishing or running", null));
}

/*******************************************************************************
 * Function: workflowExecutions
 *
 * Returns executions associated with the requested workflow.
 ******************************************************************************/
async function workflowExecutions(request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown> {
  const id = requestParam(request, "id"); if (await visibleWorkflow(id, user, services) === null) throw new HandlerFailure(404, "Workflow not found");
  const executions = await services.repository.read((state) => Object.values(state.executions).filter((item) => item.workflowId === id));
  return reply.send(ok(executions, "OK", { page: 1, limit: 20, total: executions.length, totalPages: executions.length === 0 ? 0 : 1 }));
}

/*******************************************************************************
 * Function: newWorkflow
 *
 * Builds a workflow record with ownership and default metadata.
 ******************************************************************************/
function newWorkflow(state: Parameters<typeof nextID>[0], name: string, description: string, yaml: string, blueprint: ReturnType<typeof parseWorkflowYAMLStrict>, user: CurrentUser): Workflow {
  const id = nextID(state, "wf"); const createdAt = now();
  return { id, name, description, owner: { id: user.id, name: user.name }, assignedUserIds: [], status: "PENDING", trigger: blueprint.trigger as unknown as Record<string, unknown>, steps: blueprint.steps.length, successRate: 0, lastRunAt: null, publishedVersion: 0, draftVersion: 1, tags: [], domainTags: [], canRun: false, createdAt, updatedAt: createdAt, yaml, archived: false, canvas: canvasFromBlueprint(id, blueprint) };
}

/*******************************************************************************
 * Function: canvasFromBlueprint
 *
 * Converts workflow steps into canvas nodes, edges, and viewport data.
 ******************************************************************************/
function canvasFromBlueprint(workflowID: string, blueprint: ReturnType<typeof parseWorkflowYAMLStrict>): Record<string, unknown> {
  const nodes = blueprint.steps.map((step, index) => ({ id: step.id, label: step.description?.trim() === "" || step.description === undefined ? step.action ?? step.id : step.description, type: step.kind === undefined || step.kind === "" ? "tool" : step.kind, position: { x: 80 + index * 260, y: 120 }, status: "idle", config: { action: step.action ?? "", parameters: step.parameters ?? {} } }));
  const edges = nodes.slice(1).map((node, index) => ({ id: `edge_${index + 1}`, source: nodes[index]!.id, target: node.id, type: "default", label: null }));
  return { workflowId: workflowID, nodes, edges, viewport: { x: 0, y: 0, zoom: 1 } };
}

/*******************************************************************************
 * Function: yamlRecord
 *
 * Builds the response metadata for a workflow's YAML document.
 ******************************************************************************/
function yamlRecord(workflow: Workflow): Record<string, unknown> { return { workflowId: workflow.id, version: workflow.draftVersion, publishedVersion: workflow.publishedVersion, contentHash: workflowContentHash(workflow.yaml), yaml: workflow.yaml, checksum: checksum(workflow.yaml), updatedAt: workflow.updatedAt }; }
/*******************************************************************************
 * Function: publicWorkflow
 *
 * Projects workflow data into the response shape for this handler.
 ******************************************************************************/
function publicWorkflow(workflow: Workflow): Record<string, unknown> { const { yaml: _yaml, archived: _archived, canvas: _canvas, ...visible } = workflow; return visible; }
/*******************************************************************************
 * Function: visibleWorkflow
 *
 * Loads a workflow and enforces the current user's visibility rules.
 ******************************************************************************/
async function visibleWorkflow(id: string, user: CurrentUser, services: { repository: Pick<HandlerServices["repository"], "read"> }): Promise<Workflow | null> { return services.repository.read((state) => { const item = state.workflows[id]; return item !== undefined && permittedWorkflow(item, user, false) ? structuredClone(item) : null; }); }
/*******************************************************************************
 * Function: executionShape
 *
 * Projects execution data into the workflow response shape.
 ******************************************************************************/
function executionShape(canvas: Record<string, unknown>): string { const nodes = Array.isArray(canvas.nodes) ? canvas.nodes.map((node) => isRecord(node) ? { id: node.id, type: node.type, config: node.config } : node) : []; const edges = Array.isArray(canvas.edges) ? canvas.edges.map((edge) => isRecord(edge) ? { source: edge.source, target: edge.target, type: edge.type, label: edge.label } : edge) : []; return JSON.stringify({ nodes, edges }); }
/*******************************************************************************
 * Function: errorText
 *
 * Converts an error or other thrown value into a message string.
 ******************************************************************************/
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
