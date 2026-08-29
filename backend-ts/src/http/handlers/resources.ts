import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { FastifyReply, FastifyRequest } from "fastify";
import { approvalTierSchema, companyProfileSchema, costCentreSchema, departmentSchema } from "../../models/boundary.js";
import { fail, ok } from "../../models/schemas.js";
import { withoutSecretFields } from "../../redact/secrets.js";
import { providerConfigurationFromRecord, validateRuntimeProviderConfiguration } from "../../providers/runtime.js";
import { requestTraceId } from "../../trace/request-trace.js";
import type { RouteDefinition } from "../generated-routes.js";
import { appendAudit, bodyRecord, HandlerFailure, type CurrentUser, type HandlerServices, isRecord, nextID, now, paginate, requestParam, stringValue } from "./common.js";
import { classifyIntent } from "../../agent/intent-classifier.js";
import { runQueryLoop, type ToolStep } from "../../agent/query-loop.js";

function buildWorkflowYamlFromSteps(steps: ToolStep[], userPrompt: string): string {
  const safeName = userPrompt.trim().slice(0, 60).replace(/[^a-zA-Z0-9 ]/g, "").trim() || "Chat Workflow";
  const stepsYaml = steps
    .map((step, i) => {
      const friendlyDesc = step.toolName.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
      const paramsJson = Object.keys(step.arguments).length > 0
        ? "\n    parameters:\n" + Object.entries(step.arguments).map(([k, v]) => `      ${k}: ${JSON.stringify(v)}`).join("\n")
        : "";
      return `  - id: step_${i + 1}\n    action: ${step.toolName}\n    description: "${friendlyDesc}"${paramsJson}`;
    })
    .join("\n");
  return `name: "${safeName}"\ndescription: "Saved from chat session"\nsteps:\n${stepsYaml}`;
}

// ── Workflows catalog (feasibility policy) ──────────────────────────────────
interface CatalogWorkflow {
  id: string;
  name: string;
  description: string;
  keywords: string[];
  allowed_roles: string[];
  requires_write: boolean;
  domain: string;
  doable: boolean;
}
interface WorkflowsCatalog {
  workflows: CatalogWorkflow[];
  globally_blocked: string[];
  role_notes: Record<string, string>;
}

let _catalogCache: WorkflowsCatalog | null = null;
function loadWorkflowsCatalog(): WorkflowsCatalog {
  if (_catalogCache !== null) return _catalogCache;
  try {
    const path = resolve(process.cwd(), "policy/workflows_catalog.json");
    _catalogCache = JSON.parse(readFileSync(path, "utf8")) as WorkflowsCatalog;
  } catch {
    _catalogCache = { workflows: [], globally_blocked: [], role_notes: {} };
  }
  return _catalogCache;
}

function checkFeasibility(request: string, userRole: string): { feasible: boolean; matchedWorkflow?: CatalogWorkflow; reason?: string } {
  const catalog = loadWorkflowsCatalog();
  const normalized = request.toLowerCase();

  // Check globally blocked phrases
  for (const blocked of catalog.globally_blocked) {
    if (normalized.includes(blocked.toLowerCase())) {
      return { feasible: false, reason: `This action ("${blocked}") is globally blocked and cannot be automated in this system.` };
    }
  }

  // Find best matching workflow by keyword scoring
  let bestMatch: CatalogWorkflow | undefined;
  let bestScore = 0;
  for (const workflow of catalog.workflows) {
    const score = workflow.keywords.reduce((acc, kw) => acc + (normalized.includes(kw.toLowerCase()) ? 1 : 0), 0);
    if (score > bestScore) { bestScore = score; bestMatch = workflow; }
  }

  if (bestMatch === undefined || bestScore === 0) {
    // No specific match — allow it to proceed (LLM will figure it out)
    return { feasible: true };
  }

  if (!bestMatch.doable) {
    return { feasible: false, matchedWorkflow: bestMatch, reason: `"${bestMatch.name}" is not supported in this ERP system.` };
  }

  const normalizedRole = userRole.trim();
  const allowed = bestMatch.allowed_roles.some((r) => r.toLowerCase() === normalizedRole.toLowerCase()) || normalizedRole === "Platform Admin";
  if (!allowed) {
    const roleNote = catalog.role_notes[normalizedRole] ?? `Role "${normalizedRole}" does not have access to this workflow.`;
    return {
      feasible: false,
      matchedWorkflow: bestMatch,
      reason: `Your role (**${normalizedRole}**) is not permitted to run "${bestMatch.name}".\n\n${roleNote}`,
    };
  }

  if (bestMatch.requires_write && normalizedRole === "Client") {
    return { feasible: false, matchedWorkflow: bestMatch, reason: `"${bestMatch.name}" requires write access. The **Client** role is read-only.` };
  }

  return { feasible: true, matchedWorkflow: bestMatch };
}

export const RESOURCE_UNHANDLED = Symbol("resource-unhandled");

export async function handleResourceRoute(route: RouteDefinition, request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown | typeof RESOURCE_UNHANDLED> {
  const base = services.config.apiBasePath;
  try {
    if (route.path === `${base}/company` && route.method === "GET") return getCompany(reply, user, services);
    if (route.path === `${base}/company` && route.method === "PUT") return updateCompany(request, reply, user, services);
    if (route.path === `${base}/company/departments` && route.method === "GET") return listCompanyCollection(reply, user, services, "departments");
    if (route.path === `${base}/company/departments` && route.method === "POST") return createCompanyItem(request, reply, user, services, "departments");
    if (route.path === `${base}/company/departments/:id` && route.method === "PUT") return updateCompanyItem(request, reply, user, services, "departments");
    if (route.path === `${base}/company/departments/:id` && route.method === "DELETE") return deleteCompanyItem(request, reply, user, services, "departments");
    if (route.path === `${base}/company/cost-centres` && route.method === "GET") return listCompanyCollection(reply, user, services, "costCentres");
    if (route.path === `${base}/company/cost-centres` && route.method === "POST") return createCompanyItem(request, reply, user, services, "costCentres");
    if (route.path === `${base}/company/cost-centres/:id` && route.method === "PUT") return updateCompanyItem(request, reply, user, services, "costCentres");
    if (route.path === `${base}/company/cost-centres/:id` && route.method === "DELETE") return deleteCompanyItem(request, reply, user, services, "costCentres");
    if (route.path === `${base}/company/approval-tiers` && route.method === "GET") return listCompanyCollection(reply, user, services, "approvalTiers");
    if (route.path === `${base}/company/approval-tiers` && route.method === "POST") return createCompanyItem(request, reply, user, services, "approvalTiers");
    if (route.path === `${base}/company/approval-tiers/:id` && route.method === "PUT") return updateCompanyItem(request, reply, user, services, "approvalTiers");
    if (route.path === `${base}/company/approval-tiers/:id` && route.method === "DELETE") return deleteCompanyItem(request, reply, user, services, "approvalTiers");
    if (route.path === `${base}/chat/sessions` && route.method === "GET") return listChats(request, reply, user, services);
    if (route.path === `${base}/chat/sessions` && route.method === "POST") return createChat(request, reply, user, services);
    if (route.path === `${base}/chat/sessions/:id` && route.method === "GET") return getChat(request, reply, user, services);
    if (route.path === `${base}/chat/sessions/:id` && route.method === "PATCH") return updateChat(request, reply, user, services);
    if (route.path === `${base}/chat/sessions/:id` && route.method === "DELETE") return deleteChat(request, reply, user, services);
    if (route.path === `${base}/chat/sessions/:id/messages`) return sendChatMessage(request, reply, user, services);
    if (route.path === `${base}/providers` && route.method === "GET") return listProviders(reply, user, services);
    if (route.path === `${base}/providers` && route.method === "POST") return createProvider(request, reply, user, services);
    if (route.path === `${base}/providers/:id` && route.method === "PUT") return updateProvider(request, reply, user, services);
    if (route.path === `${base}/providers/:id/activate`) return activateProvider(request, reply, user, services);
    if (route.path === `${base}/providers/:id/test`) return testProvider(request, reply, user, services);
    if (route.path === `${base}/settings/webhooks` && route.method === "GET") return reply.send(ok(await services.repository.read((state) => Object.values(state.webhooks)), "OK", null));
    if (route.path === `${base}/settings/webhooks` && route.method === "POST") return createWebhook(request, reply, services);
    if (route.path === `${base}/settings/webhooks/:id` && route.method === "PATCH") return updateWebhook(request, reply, services);
    if (route.path === `${base}/settings/webhooks/:id` && route.method === "DELETE") return deleteWebhook(request, reply, services);
    if (route.path === `${base}/settings/webhooks/:id/test`) return testWebhook(request, reply, services);
    if (route.path === `${base}/integrations` && route.method === "GET") return reply.send(ok(await services.repository.read((state) => Object.values(state.integrations).map((item) => withoutSecretFields(item))), "OK", null));
    if (route.path === `${base}/integrations` && route.method === "POST") return createIntegration(request, reply, services);
    if (route.path === `${base}/integrations/:id` && route.method === "GET") return getIntegration(request, reply, services);
    if (route.path === `${base}/integrations/:id` && route.method === "PATCH") return updateIntegration(request, reply, services);
    if (route.path === `${base}/integrations/:id` && route.method === "DELETE") return deleteIntegration(request, reply, services);
    if (route.path === `${base}/integrations/:id/test`) return testIntegration(request, reply, services, false);
    if (route.path === `${base}/integrations/:id/connect`) return testIntegration(request, reply, services, true);
    if (route.path === `${base}/integrations/:id/disconnect`) return disconnectIntegration(request, reply, services);
  } catch (error) {
    if (error instanceof HandlerFailure) return reply.status(error.status).send(fail(error.message, error.meta));
    throw error;
  }
  return RESOURCE_UNHANDLED;
}

type CompanyCollection = "departments" | "costCentres" | "approvalTiers";

const defaultCompany = { name: "", legalName: "", industry: "", timezone: "UTC", currency: "USD", fiscalYearStart: "", contactEmail: "", erpSystemName: "", erpVersion: "", notes: "", departments: [], costCentres: [], approvalTiers: [] };

function isCompanyAdmin(user: CurrentUser): boolean { return user.role === "Platform Admin" || user.role === "System Admin"; }
function requireCompanyWrite(user: CurrentUser): void { if (!isCompanyAdmin(user)) throw new HandlerFailure(403, "Only Platform Admin and System Admin roles can edit the company profile"); }
function requireCompanyRead(user: CurrentUser): void { if (!isCompanyAdmin(user)) throw new HandlerFailure(403, "Only Platform Admin and System Admin roles can read this company data"); }

async function company(services: HandlerServices): Promise<Record<string, unknown>> { return services.repository.read((state) => state.company === null ? structuredClone(defaultCompany) : structuredClone(state.company)); }

async function getCompany(reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown> { const profile = await company(services); if (isCompanyAdmin(user)) return reply.send(ok(profile, "Company profile loaded", null)); const departments = Array.isArray(profile.departments) ? profile.departments.map((item) => isRecord(item) ? { id: item.id, name: item.name } : item) : []; return reply.send(ok({ name: profile.name, legalName: profile.legalName, industry: profile.industry, timezone: profile.timezone, currency: profile.currency, fiscalYearStart: profile.fiscalYearStart, departments }, "Company profile loaded", null)); }

async function updateCompany(request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown> {
  requireCompanyWrite(user);
  const parsed = companyProfileSchema.safeParse(request.body ?? {});
  if (!parsed.success) throw companyValidation(parsed.error.issues);
  const issues: { path: PropertyKey[]; message: string }[] = [];
  if (parsed.data.currency.length !== 3) issues.push({ path: ["currency"], message: `currency "${parsed.data.currency}" must be a 3-letter code` });
  if (parsed.data.timezone.trim() === "") issues.push({ path: ["timezone"], message: "timezone is required" });
  if (issues.length > 0) throw companyValidation(issues);
  const profile = normalizeCompany(parsed.data as unknown as Record<string, unknown>);
  await services.repository.mutate((state) => { const before = state.company; state.company = profile; appendAudit(state, user, "company.updated", "company", "default", before, profile, request); });
  return reply.send(ok(profile, "Company profile updated", null));
}

async function listCompanyCollection(reply: FastifyReply, user: CurrentUser, services: HandlerServices, collection: CompanyCollection): Promise<unknown> { if (collection !== "departments") requireCompanyRead(user); const profile = await company(services); const values = Array.isArray(profile[collection]) ? profile[collection] as unknown[] : []; const visible = collection === "departments" && !isCompanyAdmin(user) ? values.map((item) => isRecord(item) ? { id: item.id, name: item.name } : item) : values; const title = collection === "departments" ? "Company departments loaded" : collection === "costCentres" ? "Company cost centres loaded" : "Company approval tiers loaded"; return reply.send(ok(visible, title, { count: visible.length })); }

async function createCompanyItem(request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices, collection: CompanyCollection): Promise<unknown> { requireCompanyWrite(user); const input = parseCompanyItem(collection, request.body); const created = await services.repository.mutate((state) => { const profile = state.company === null ? structuredClone(defaultCompany) : state.company; const list = Array.isArray(profile[collection]) ? profile[collection] as Record<string, unknown>[] : []; const identity = itemIdentity(collection, input); if (collection === "departments" && identity === "") input.id = nextID(state, "dept"); const actualID = itemIdentity(collection, input); if (list.some((item) => itemIdentity(collection, item).toLowerCase() === actualID.toLowerCase())) throw new HandlerFailure(409, `${companyItemName(collection)} already exists`); list.push(input); profile[collection] = list; state.company = profile; appendAudit(state, user, `company.${companyActionName(collection)}.created`, companyActionName(collection), actualID, null, input, request); return structuredClone(input); }); return reply.status(201).send(ok(created, `Company ${companyItemLabel(collection)} created`, null)); }

async function updateCompanyItem(request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices, collection: CompanyCollection): Promise<unknown> {
  requireCompanyWrite(user);
  const id = requestParam(request, "id");
  const exists = await services.repository.read((state) => {
    const profile = state.company === null ? defaultCompany : state.company;
    const list = Array.isArray(profile[collection]) ? profile[collection] as Record<string, unknown>[] : [];
    return list.some((item) => itemIdentity(collection, item).toLowerCase() === id.toLowerCase());
  });
  if (!exists) throw new HandlerFailure(404, `${companyItemName(collection)} not found`);
  const input = parseCompanyItem(collection, request.body);
  if (collection === "departments") input.id = id;
  if (collection === "costCentres") input.code = id;
  const updated = await services.repository.mutate((state) => { const profile = state.company === null ? structuredClone(defaultCompany) : state.company; const list = Array.isArray(profile[collection]) ? profile[collection] as Record<string, unknown>[] : []; const index = list.findIndex((item) => itemIdentity(collection, item).toLowerCase() === id.toLowerCase()); if (index < 0) throw new HandlerFailure(404, `${companyItemName(collection)} not found`); const before = list[index]!; list[index] = input; profile[collection] = list; state.company = profile; appendAudit(state, user, `company.${companyActionName(collection)}.updated`, companyActionName(collection), id, before, input, request); return structuredClone(input); });
  return reply.send(ok(updated, `Company ${companyItemLabel(collection)} updated`, null));
}

async function deleteCompanyItem(request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices, collection: CompanyCollection): Promise<unknown> { requireCompanyWrite(user); const id = requestParam(request, "id"); await services.repository.mutate((state) => { const profile = state.company === null ? structuredClone(defaultCompany) : state.company; const list = Array.isArray(profile[collection]) ? profile[collection] as Record<string, unknown>[] : []; const index = list.findIndex((item) => itemIdentity(collection, item).toLowerCase() === id.toLowerCase()); if (index < 0) throw new HandlerFailure(404, `${companyItemName(collection)} not found`); if (collection === "departments") { const users = Object.values(state.users).filter((item) => item.departmentId === id).length; if (users > 0) throw new HandlerFailure(409, `Department is assigned to ${users} user(s)`, { users }); } const before = list[index]!; list.splice(index, 1); profile[collection] = list; state.company = profile; appendAudit(state, user, `company.${companyActionName(collection)}.deleted`, companyActionName(collection), id, before, null, request); }); return reply.send(ok({ deleted: true }, `Company ${companyItemLabel(collection)} deleted`, null)); }

function parseCompanyItem(collection: CompanyCollection, input: unknown): Record<string, unknown> {
  const schema = collection === "departments" ? departmentSchema : collection === "costCentres" ? costCentreSchema : approvalTierSchema;
  const parsed = schema.safeParse(input ?? {});
  if (!parsed.success) throw companyValidation(parsed.error.issues);
  const value = parsed.data as unknown as Record<string, unknown>;
  const issues: { path: PropertyKey[]; message: string }[] = [];
  if (collection === "costCentres") {
    if (stringValue(value.code).trim() === "") issues.push({ path: ["costCentres", 0, "code"], message: "cost centre code is required" });
    if (stringValue(value.currency).length !== 3) issues.push({ path: ["costCentres", 0, "currency"], message: `currency "${stringValue(value.currency)}" must be a 3-letter code` });
  }
  if (collection === "approvalTiers" && stringValue(value.label).trim() === "") issues.push({ path: ["approvalTiers", 0, "label"], message: "approval tier label is required" });
  if (issues.length > 0) throw companyValidation(issues);
  return value;
}
function companyValidation(issues: { path: PropertyKey[]; message: string }[]): HandlerFailure { return new HandlerFailure(422, "Company profile validation failed", { fieldErrors: Object.fromEntries(issues.map((issue) => [issue.path.join("."), issue.message])) }); }
function itemIdentity(collection: CompanyCollection, item: Record<string, unknown>): string { return stringValue(item[collection === "departments" ? "id" : collection === "costCentres" ? "code" : "label"]); }
function companyItemName(collection: CompanyCollection): string { return collection === "departments" ? "Department" : collection === "costCentres" ? "Cost centre" : "Approval tier"; }
function companyItemLabel(collection: CompanyCollection): string { return collection === "departments" ? "department" : collection === "costCentres" ? "cost centre" : "approval tier"; }
function companyActionName(collection: CompanyCollection): string { return collection === "departments" ? "department" : collection === "costCentres" ? "cost_centre" : "approval_tier"; }
function normalizeCompany(profile: Record<string, unknown>): Record<string, unknown> { return { ...profile, timezone: stringValue(profile.timezone).trim() === "" ? "UTC" : profile.timezone, currency: stringValue(profile.currency).trim() === "" ? "USD" : profile.currency, departments: Array.isArray(profile.departments) ? profile.departments : [], costCentres: Array.isArray(profile.costCentres) ? profile.costCentres : [], approvalTiers: Array.isArray(profile.approvalTiers) ? profile.approvalTiers : [] }; }

function chatSummary(chat: { messages: unknown[] } & Record<string, unknown>): Record<string, unknown> { const { messages: _messages, ...summary } = chat; return summary; }
async function listChats(request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown> { const chats = await services.repository.read((state) => Object.values(state.chats).filter((item) => user.permissions.includes("workflow:read") || item.ownerId === user.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((item) => chatSummary(item))); const page = paginate(chats, request); return reply.send(ok(page.items, "OK", page.meta)); }
async function createChat(request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown> { const body = request.body === undefined ? {} : bodyRecord(request); if (body === null) throw new HandlerFailure(400, "Invalid request body"); const chat = await services.repository.mutate((state) => { const id = nextID(state, "chat"); const timestamp = now(); const value = { id, ownerId: user.id, title: stringValue(body.title).trim() === "" ? "New conversation" : stringValue(body.title), createdAt: timestamp, updatedAt: timestamp, messageCount: 0, messages: [] }; state.chats[id] = value; return value; }); return reply.status(201).send(ok(chatSummary(chat), "Chat session created", null)); }
async function getChat(request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown> { const chat = await services.repository.read((state) => { const value = state.chats[requestParam(request, "id")]; return value !== undefined && (user.permissions.includes("workflow:read") || value.ownerId === user.id) ? structuredClone(value) : null; }); if (chat === null) throw new HandlerFailure(404, "Chat session not found"); return reply.send(ok(chat, "OK", null)); }
async function updateChat(request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown> { const body = bodyRecord(request); if (body === null) throw new HandlerFailure(400, "Invalid request body"); const chat = await services.repository.mutate((state) => { const value = state.chats[requestParam(request, "id")]; if (value === undefined || (!user.permissions.includes("workflow:write") && value.ownerId !== user.id)) throw new HandlerFailure(404, "Chat session not found"); value.title = stringValue(body.title); value.updatedAt = now(); return structuredClone(value); }); return reply.send(ok(chatSummary(chat), "Chat session updated", null)); }
async function deleteChat(request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown> { await services.repository.mutate((state) => { const value = state.chats[requestParam(request, "id")]; if (value === undefined || (!user.permissions.includes("workflow:write") && value.ownerId !== user.id)) throw new HandlerFailure(404, "Chat session not found"); delete state.chats[value.id]; }); return reply.send(ok({ deleted: true }, "Chat session deleted", null)); }
async function sendChatMessage(request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown> {
  const body = bodyRecord(request);
  if (body === null) throw new HandlerFailure(400, "Invalid request body");
  const content = stringValue(body.content).trim() === "" ? stringValue(body.message).trim() : stringValue(body.content).trim();
  if (content === "") throw new HandlerFailure(400, "message is required");
  const traceId = requestTraceId(request);
  const stored = await services.repository.mutate((state) => {
    const id = requestParam(request, "id");
    let chat = state.chats[id];
    if (chat === undefined) { const timestamp = now(); chat = { id, ownerId: user.id, title: content.slice(0, 80), createdAt: timestamp, updatedAt: timestamp, messageCount: 0, messages: [] }; state.chats[id] = chat; }
    if (chat.ownerId !== user.id && !user.permissions.includes("workflow:write")) throw new HandlerFailure(404, "Chat session not found");
    const priorMessages = chat.messages.map((message) => `${stringValue(message.role)}: ${stringValue(message.text)}`);
    const userMessage = { id: nextID(state, "msg"), role: "user", text: content, createdAt: now(), traceId };
    chat.messages.push(userMessage); chat.messageCount = chat.messages.length; chat.updatedAt = now();
    return { session: chatSummary(chat), userMessage, priorMessages };
  });
  // ── Feasibility check against workflows catalog ──────────────────────────
  const feasibility = checkFeasibility(content, user.role);
  if (!feasibility.feasible) {
    const denialText = feasibility.matchedWorkflow
      ? `**Request blocked by policy.**\n\n${feasibility.reason}`
      : `**Request blocked.**\n\n${feasibility.reason ?? "This action is not permitted in this system."}`;
    const assistantMessage = await services.repository.mutate((state) => {
      const chat = state.chats[requestParam(request, "id")];
      if (chat === undefined) throw new HandlerFailure(404, "Chat session not found");
      const message = { id: nextID(state, "msg"), role: "assistant", text: denialText, artifacts: { intent: "POLICY_DENIAL", blockedWorkflow: feasibility.matchedWorkflow?.id ?? null }, createdAt: now(), traceId };
      chat.messages.push(message); chat.messageCount = chat.messages.length; chat.updatedAt = now();
      return message;
    });
    return reply.send(ok({ session: stored.session, userMessage: stored.userMessage, assistantMessage, answer: denialText, intent: "POLICY_DENIAL" }, "Message processed", null));
  }
  const intent = classifyIntent(content);
  if (intent === "CAPABILITIES") {
    const capText = buildCapabilitiesResponse(services.registries.snapshot().tools);
    const assistantMessage = await services.repository.mutate((state) => {
      const chat = state.chats[requestParam(request, "id")];
      if (chat === undefined) throw new HandlerFailure(404, "Chat session not found");
      const message = { id: nextID(state, "msg"), role: "assistant", text: capText, artifacts: { intent: "CAPABILITIES" }, createdAt: now(), traceId };
      chat.messages.push(message); chat.messageCount = chat.messages.length; chat.updatedAt = now();
      return message;
    });
    return reply.send(ok({ session: stored.session, userMessage: stored.userMessage, assistantMessage, answer: capText, intent }, "Message processed", null));
  }
  if ((intent === "QUERY" || intent === "AUDIT") && services.erpbridgeSession !== undefined && services.providerRuntime?.configured === true) {
    const allReadOnlyTools = services.registries.readOnlyTools();
    const readOnlyTools = selectRelevantTools(content, allReadOnlyTools, 15);
    if (readOnlyTools.length > 0) {
      const sessionId = requestParam(request, "id");
      const chatHistory = stored.priorMessages.map((line) => {
        const sep = line.indexOf(": ");
        return sep > -1 ? { role: line.slice(0, sep), text: line.slice(sep + 2) } : { role: "user", text: line };
      });
      let loopResult;
      try {
        const bridgeSession = services.erpbridgeSession;
        loopResult = await runQueryLoop(
          { userMessage: content, chatHistory, sessionId, actorId: user.id, actorRole: user.role, signal: request.signal, traceId },
          readOnlyTools,
          async (toolName, args) => bridgeSession.callToolDirect(toolName, args),
          services.providerRuntime,
        );
      } catch (error) {
        throw new HandlerFailure(502, `Query agent failed: ${errorText(error)}`);
      }
      const workflowDraft = loopResult.toolSteps.length > 0
        ? buildWorkflowYamlFromSteps(loopResult.toolSteps, content)
        : undefined;
      const queryArtifacts = {
        intent,
        sources: loopResult.toolCallLog,
        toolSteps: loopResult.toolSteps,
        boundHit: loopResult.boundHit,
        iterationsUsed: loopResult.iterationsUsed,
        latencyMs: loopResult.latencyMs,
        ...(loopResult.visualisation !== undefined ? { visualisation: loopResult.visualisation } : {}),
        ...(workflowDraft !== undefined ? { workflowDraft } : {}),
      };
      const assistantMessage = await services.repository.mutate((state) => {
        const chat = state.chats[requestParam(request, "id")];
        if (chat === undefined) throw new HandlerFailure(404, "Chat session not found");
        const message = { id: nextID(state, "msg"), role: "assistant", text: loopResult.text, artifacts: queryArtifacts, createdAt: now(), traceId };
        chat.messages.push(message); chat.messageCount = chat.messages.length; chat.updatedAt = now();
        return message;
      });
      return reply.send(ok({
        session: stored.session,
        userMessage: stored.userMessage,
        assistantMessage,
        answer: loopResult.text,
        intent,
        sources: loopResult.toolCallLog,
        toolSteps: loopResult.toolSteps,
        ...(loopResult.visualisation !== undefined ? { visualisation: loopResult.visualisation } : {}),
        ...(workflowDraft !== undefined ? { workflowDraft } : {}),
        boundHit: loopResult.boundHit,
        usage: { inputTokens: loopResult.totalTokens.input, outputTokens: loopResult.totalTokens.output, measured: true },
      }, "Message processed", null));
    }
  }
  if (services.synthesis === undefined) throw new HandlerFailure(502, "Chat orchestration is not configured");
  let result;
  try { result = await services.synthesis.synthesize({ prompt: content, userRole: user.role, user: { id: user.id, role: user.role, department: user.departmentId }, model: stringValue(body.model), priorMessages: stored.priorMessages, signal: request.signal, traceId, sessionId: requestParam(request, "id"), messageId: stringValue(stored.userMessage.id) }); }
  catch (error) {
    const errText = errorText(error);
    const errorDetail = errText.split(":").at(-1)?.trim() || errText;
    const friendlyText = errText.includes("HTTP 400") || errText.includes("Generation attempt failed") || errText.includes("Candidate generation failed")
      ? "I wasn't able to generate a workflow for this request.\n\nThis usually happens when the request involves capabilities not available in this ERP system (e.g. tax verification, sanctions checking, email notifications), or when the AI model is temporarily unavailable.\n\nTry asking for a simpler workflow, or check **Capabilities** to see what this system supports."
      : `Unable to generate workflow — the generation service encountered an error. Please try again.\n\n_${errorDetail}_`;
    const errMessage = await services.repository.mutate((state) => {
      const chat = state.chats[requestParam(request, "id")];
      if (chat === undefined) throw new HandlerFailure(404, "Chat session not found");
      const msg = { id: nextID(state, "msg"), role: "assistant", text: friendlyText, artifacts: { intent: "WORKFLOW_ERROR" }, createdAt: now(), traceId };
      chat.messages.push(msg); chat.messageCount = chat.messages.length; chat.updatedAt = now();
      return msg;
    });
    return reply.send(ok({ session: stored.session, userMessage: stored.userMessage, assistantMessage: errMessage, answer: friendlyText, intent: "WORKFLOW_ERROR" }, "Message processed", null));
  }
  // Generate Claude Code-style narrative response
  const assistantText = await generateWorkflowNarrative(content, result, stored.priorMessages, services.providerRuntime, request.signal);
  const chatSessionId = requestParam(request, "id");
  const chatMessageId = stringValue(stored.userMessage.id);
  const artifacts = compactWorkflowArtifacts(result, chatSessionId, chatMessageId, traceId);
  const assistantMessage = await services.repository.mutate((state) => {
    const chat = state.chats[requestParam(request, "id")];
    if (chat === undefined) throw new HandlerFailure(404, "Chat session not found");
    const message = { id: nextID(state, "msg"), role: "assistant", text: assistantText, artifacts, createdAt: now(), traceId };
    chat.messages.push(message); chat.messageCount = chat.messages.length; chat.updatedAt = now();
    return message;
  });
  const retrieval = result.retrieval as { tools?: unknown[]; rules?: unknown[]; global_rules?: unknown[] };
  return reply.send(ok({
    session: stored.session,
    userMessage: stored.userMessage,
    assistantMessage,
    answer: assistantText,
    yaml: result.yaml,
    workflowDraft: { ...result.candidate, chatSessionId, chatMessageId, traceId },
    validation: result.validation,
    flowPreview: null,
    usage: { inputTokens: result.candidate.generation_metadata.inputTokens, outputTokens: result.candidate.generation_metadata.outputTokens, measured: result.candidate.generation_metadata.measured },
    retrieval: result.retrieval,
    toolCandidates: retrieval.tools ?? [],
    ruleCandidates: [...(retrieval.rules ?? []), ...(retrieval.global_rules ?? [])],
  }, "Message processed", null));
}

function compactWorkflowArtifacts(
  result: import("../../synthesis/service.js").SynthesisResult,
  chatSessionId: string,
  chatMessageId: string,
  traceId: string,
): Record<string, unknown> {
  const retrieval = result.retrieval as {
    tools?: unknown[];
    rules?: unknown[];
    global_rules?: unknown[];
    examples?: unknown[];
  };
  return {
    intent: "WORKFLOW",
    chatSessionId,
    chatMessageId,
    traceId,
    validation: result.validation,
    can_execute: result.can_execute,
    selected_candidate_id: result.selected_candidate_id,
    selected_workflow_yaml: result.selected_workflow_yaml,
    ...(result.can_execute ? {} : { yaml: result.yaml }),
    validation_summary: result.validation_summary,
    blocking_errors: result.blocking_errors,
    next_action: result.next_action,
    candidates: result.candidates.map((candidate) => ({
      id: candidate.id,
      candidate_id: candidate.candidate_id,
      status: candidate.status,
      score: candidate.score,
    })),
    retrieval: {
      tools: pickArtifactRecords(retrieval.tools, [
        "tool_id", "name", "display_name", "description", "endpoint",
        "http_method", "risk_level", "erp_system", "bpi_process_alignment",
        "score", "current_gaps", "allowed_roles", "required_parameters",
      ]),
      rules: pickArtifactRecords(retrieval.rules, [
        "rule_id", "rule_name", "rule_type", "description", "enforcement_action",
        "severity", "score",
      ]),
      global_rules: pickArtifactRecords(retrieval.global_rules, [
        "rule_id", "rule_name", "rule_type", "description", "enforcement_action",
        "severity", "score",
      ]),
      examples: pickArtifactRecords(retrieval.examples, [
        "scenario_id", "user_request", "user_role", "risk_level",
        "expected_decision", "expected_domain",
      ]),
    },
  };
}

function pickArtifactRecords(values: unknown[] | undefined, keys: readonly string[]): Record<string, unknown>[] {
  if (!Array.isArray(values)) return [];
  return values.flatMap((value) => {
    if (!isRecord(value)) return [];
    const record: Record<string, unknown> = {};
    for (const key of keys) if (value[key] !== undefined) record[key] = structuredClone(value[key]);
    return [record];
  });
}

async function generateWorkflowNarrative(
  userMessage: string,
  result: import("../../synthesis/service.js").SynthesisResult,
  priorMessages: string[],
  providerRuntime: import("../../providers/runtime.js").ProviderRuntime | undefined,
  signal?: AbortSignal,
): Promise<string> {
  const passed = result.can_execute;
  const failedRules: string[] = Array.isArray(result.validation.failed_rules) ? result.validation.failed_rules as string[] : [];
  const errors: string[] = result.blocking_errors.slice(0, 4);

  // Fallback: deterministic markdown when no LLM is available
  if (providerRuntime === undefined || !providerRuntime.configured) {
    return passed
      ? `## Workflow Generated ✓\n\nI've generated a workflow that passed all policy checks and is ready to execute.\n\nClick **Pass to Canvas** in the panel to review and run it.`
      : `## Workflow Blocked\n\nI generated a workflow, but the validator blocked it.\n\n**Failed rules:** ${failedRules.length ? failedRules.map((r) => `\`${r}\``).join(", ") : "see errors below"}\n\n${errors.length ? "**Errors:**\n" + errors.map((e) => `- ${e}`).join("\n") + "\n\n" : ""}Ask me to fix these issues and I'll regenerate.`;
  }

  const historySection = priorMessages.slice(-6).join("\n");
  const prompt = [
    "You are an AI workflow assistant. The user asked you to build an automation workflow, you generated it, and it was validated.",
    "Respond in clear markdown — like a senior engineer explaining what they built.",
    "",
    historySection.length > 0 ? `CONVERSATION HISTORY:\n${historySection}\n` : "",
    `USER REQUEST: ${userMessage}`,
    "",
    "GENERATED YAML:",
    "```yaml",
    result.yaml,
    "```",
    "",
    `VALIDATION: ${passed ? "PASSED ✓ — the workflow cleared all policy rules" : "BLOCKED ✗"}`,
    !passed && failedRules.length > 0 ? `Failed rules: ${failedRules.join(", ")}` : "",
    !passed && errors.length > 0 ? `Errors:\n${errors.map((e) => `- ${e}`).join("\n")}` : "",
    "",
    "Write a concise markdown response (under 300 words) that:",
    "- Starts with a ## heading naming the workflow",
    "- Explains what it does in 1-2 sentences",
    "- Lists the key steps as short bullets in PLAIN ENGLISH (e.g. 'Fetch all warehouses from ERP', NOT internal function names like list_warehouses_api_resource_warehouse_get)",
    passed
      ? "- Confirms it passed validation and is ready to execute"
      : "- Clearly explains what failed (name the rule IDs with `backticks`) and gives 1-2 concrete fixes",
    "- Ends with a brief next-step line",
    "IMPORTANT: NEVER show internal function names, API paths, or technical identifiers. Describe every action in plain English a business user would understand.",
    "Do NOT include the full YAML. Use `code spans` only for governance rule IDs (e.g. `GLOBAL-AUDIT-001`).",
  ].filter((l) => l !== "").join("\n");

  try {
    const response = await providerRuntime.generate(prompt, "prompt/workflow-narrative/v1", signal);
    return response.text.trim();
  } catch {
    return passed
      ? `## Workflow Generated ✓\n\nI've generated a workflow that passed all policy checks.\n\nClick **Pass to Canvas** in the artifact panel to run it.`
      : `## Workflow Blocked\n\nThe validator blocked the generated workflow.\n\n**Failed rules:** ${failedRules.map((r) => `\`${r}\``).join(", ") || "see panel"}\n\nAsk me to fix these issues.`;
  }
}

function requirePlatformAdmin(user: CurrentUser): void { if (user.role !== "Platform Admin") throw new HandlerFailure(403, "Only Platform Admin can manage providers"); }
async function listProviders(reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown> { requirePlatformAdmin(user); const providers = await services.repository.read((state) => Object.values(state.providers).map((item) => withoutSecretFields(item))); return reply.send(ok(providers, "Provider configurations loaded", null)); }
function providerInput(body: Record<string, unknown>, id: string, existing?: Record<string, unknown>): Record<string, unknown> { const name = stringValue(body.name).trim(); const model = stringValue(body.model).trim(); if (name === "" || model === "") throw new HandlerFailure(422, "Provider name and model are required"); const type = stringValue(body.type).trim(); if (!["gemini", "ollama", "openai_compatible"].includes(type)) throw new HandlerFailure(422, "Provider type must be gemini, ollama, or openai_compatible"); return { id, name, type, ...(stringValue(body.baseUrl).trim() === "" ? {} : { baseUrl: stringValue(body.baseUrl).trim() }), model, temperature: typeof body.temperature === "number" ? body.temperature : 0, apiKey: typeof body.apiKey === "string" && body.apiKey !== "" ? body.apiKey : existing?.apiKey ?? "", active: existing?.active === true, createdAt: stringValue(existing?.createdAt) === "" ? now() : existing!.createdAt }; }
async function createProvider(request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown> { requirePlatformAdmin(user); const body = bodyRecord(request); if (body === null) throw new HandlerFailure(400, "Invalid request body"); const provider = await services.repository.mutate((state) => { if (Object.values(state.providers).some((item) => stringValue(item.name).toLowerCase() === stringValue(body.name).trim().toLowerCase())) throw new HandlerFailure(409, "A provider with this name already exists"); const id = nextID(state, "provider"); const value = providerInput(body, id); state.providers[id] = value; appendAudit(state, user, "provider.created", "provider", id, null, withoutSecretFields(value) as Record<string, unknown>, request); return value; }); return reply.status(201).send(ok(withoutSecretFields(provider), "Provider created", null)); }
async function updateProvider(request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown> { requirePlatformAdmin(user); const body = bodyRecord(request); if (body === null) throw new HandlerFailure(400, "Invalid request body"); const id = requestParam(request, "id"); const provider = await services.repository.mutate((state) => { const existing = state.providers[id]; if (existing === undefined) throw new HandlerFailure(404, "Provider configuration not found"); const value = providerInput(body, id, existing); state.providers[id] = value; appendAudit(state, user, "provider.updated", "provider", id, withoutSecretFields(existing) as Record<string, unknown>, withoutSecretFields(value) as Record<string, unknown>, request); return value; }); return reply.send(ok(withoutSecretFields(provider), "Provider updated", null)); }
async function activateProvider(request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown> { requirePlatformAdmin(user); const id = requestParam(request, "id"); const current = await services.repository.read((state) => state.providers[id] ?? null); if (current === null) throw new HandlerFailure(404, "Provider configuration not found"); const configuration = providerConfigurationFromRecord(current, services.config.generationTimeoutMs ?? 30_000); try { validateRuntimeProviderConfiguration(configuration); } catch (error) { throw new HandlerFailure(422, errorText(error)); } if (services.providerRuntime === undefined) throw new HandlerFailure(503, "Provider runtime is unavailable"); const provider = await services.repository.mutate((state) => { const item = state.providers[id]; if (item === undefined) throw new HandlerFailure(404, "Provider configuration not found"); for (const value of Object.values(state.providers)) value.active = false; item.active = true; appendAudit(state, user, "provider.activated", "provider", id, null, { active: true }, request); return structuredClone(item); }); services.providerRuntime.activate(configuration); return reply.send(ok(withoutSecretFields(provider), "Provider activated", null)); }
async function testProvider(request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown> { requirePlatformAdmin(user); const provider = await services.repository.read((state) => state.providers[requestParam(request, "id")] ?? null); if (provider === null) throw new HandlerFailure(404, "Provider configuration not found"); if (services.providerRuntime === undefined) throw new HandlerFailure(503, "Provider runtime is unavailable"); try { const response = await services.providerRuntime.test(providerConfigurationFromRecord(provider, services.config.generationTimeoutMs ?? 30_000), request.signal); return reply.send(ok({ ok: true, providerId: provider.id, provider: response.provider, model: response.model, measured: response.measured, inputTokens: response.inputTokens, outputTokens: response.outputTokens }, "Provider test completed", null)); } catch (error) { return reply.send(ok({ ok: false, providerId: provider.id, message: errorText(error) }, "Provider test completed", null)); } }

async function createWebhook(request: FastifyRequest, reply: FastifyReply, services: HandlerServices): Promise<unknown> { const body = bodyRecord(request); if (body === null) throw new HandlerFailure(400, "Invalid request body"); const name = stringValue(body.name).trim(); if (name === "") throw new HandlerFailure(400, "Webhook name is required"); const url = validURL(body.url); const events = stringArray(body.events); if (events.length === 0) throw new HandlerFailure(400, "Webhook events are required"); const item = await services.repository.mutate((state) => { const id = nextID(state, "webhook"); const secret = randomBytes(24).toString("hex"); const value = { id, name, url, events, enabled: true, secretPreview: `...${secret.slice(-6)}`, secret, createdAt: now() }; state.webhooks[id] = value; return value; }); return reply.status(201).send(ok(withoutSecretFields(item), "Webhook created", null)); }
async function updateWebhook(request: FastifyRequest, reply: FastifyReply, services: HandlerServices): Promise<unknown> { const body = bodyRecord(request); if (body === null) throw new HandlerFailure(400, "Invalid request body"); const item = await services.repository.mutate((state) => { const value = state.webhooks[requestParam(request, "id")]; if (value === undefined) throw new HandlerFailure(404, "Webhook not found"); if (typeof body.name === "string") value.name = body.name; if (body.url !== undefined) value.url = validURL(body.url); if (Array.isArray(body.events)) value.events = stringArray(body.events); if (typeof body.enabled === "boolean") value.enabled = body.enabled; return structuredClone(value); }); return reply.send(ok(withoutSecretFields(item), "Webhook updated", null)); }
async function deleteWebhook(request: FastifyRequest, reply: FastifyReply, services: HandlerServices): Promise<unknown> { await services.repository.mutate((state) => { delete state.webhooks[requestParam(request, "id")]; }); return reply.send(ok({ deleted: true }, "Webhook deleted", null)); }
async function testWebhook(request: FastifyRequest, reply: FastifyReply, services: HandlerServices): Promise<unknown> { const item = await services.repository.read((state) => state.webhooks[requestParam(request, "id")] ?? null); if (item === null) throw new HandlerFailure(404, "Webhook not found"); try { const response = await fetch(stringValue(item.url), { method: "POST", redirect: "manual", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "webhook.test", timestamp: now() }), signal: AbortSignal.timeout(10_000) }); if (!response.ok) throw new Error(`HTTP ${response.status}`); return reply.send(ok({ ok: true, status: response.status }, "Webhook test succeeded", null)); } catch (error) { throw new HandlerFailure(502, `Webhook test failed: ${errorText(error)}`); } }

async function createIntegration(request: FastifyRequest, reply: FastifyReply, services: HandlerServices): Promise<unknown> { const body = bodyRecord(request); if (body === null) throw new HandlerFailure(400, "Invalid request body"); const name = stringValue(body.name).trim(); const type = stringValue(body.type).trim(); if (name === "" || type === "") throw new HandlerFailure(400, "Integration name and type are required"); const item = await services.repository.mutate((state) => { const id = nextID(state, "integration"); const value = { id, name, type, status: "Disconnected", icon: stringValue(body.icon), config: isRecord(body.config) ? structuredClone(body.config) : {}, lastTestedAt: null, createdAt: now() }; state.integrations[id] = value; return value; }); return reply.status(201).send(ok(withoutSecretFields(item), "Integration created", null)); }
async function getIntegration(request: FastifyRequest, reply: FastifyReply, services: HandlerServices): Promise<unknown> { const item = await services.repository.read((state) => state.integrations[requestParam(request, "id")] ?? null); if (item === null) throw new HandlerFailure(404, "Integration not found"); return reply.send(ok(withoutSecretFields(item), "OK", null)); }
async function updateIntegration(request: FastifyRequest, reply: FastifyReply, services: HandlerServices): Promise<unknown> { const body = bodyRecord(request); if (body === null) throw new HandlerFailure(400, "Invalid request body"); const item = await services.repository.mutate((state) => { const value = state.integrations[requestParam(request, "id")]; if (value === undefined) throw new HandlerFailure(404, "Integration not found"); if (typeof body.name === "string") value.name = body.name; if (typeof body.type === "string") value.type = body.type; if (isRecord(body.config)) value.config = structuredClone(body.config); return structuredClone(value); }); return reply.send(ok(withoutSecretFields(item), "Integration updated", null)); }
async function deleteIntegration(request: FastifyRequest, reply: FastifyReply, services: HandlerServices): Promise<unknown> { await services.repository.mutate((state) => { delete state.integrations[requestParam(request, "id")]; }); return reply.send(ok({ deleted: true }, "Integration deleted", null)); }
async function testIntegration(request: FastifyRequest, reply: FastifyReply, services: HandlerServices, connect: boolean): Promise<unknown> { const id = requestParam(request, "id"); const item = await services.repository.read((state) => state.integrations[id] ?? null); if (item === null) throw new HandlerFailure(404, "Integration not found"); const config = isRecord(item.config) ? item.config : {}; const endpoint = [config.baseUrl, config.url, config.endpoint].map(stringValue).find((value) => value.trim() !== ""); if (endpoint === undefined) throw new HandlerFailure(400, "Integration endpoint is not configured"); try { const response = await fetch(endpoint, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(10_000) }); if (!response.ok) throw new Error(`HTTP ${response.status}`); const tested = await services.repository.mutate((state) => { const value = state.integrations[id]!; value.lastTestedAt = now(); if (connect) value.status = "Connected"; return structuredClone(value); }); if (connect) return reply.send(ok(withoutSecretFields(tested), "Integration connected", null)); return reply.send(ok({ ok: true, status: response.status }, "Integration test succeeded", null)); } catch (error) { throw new HandlerFailure(502, `Integration test failed: ${errorText(error)}`); } }
async function disconnectIntegration(request: FastifyRequest, reply: FastifyReply, services: HandlerServices): Promise<unknown> { const item = await services.repository.mutate((state) => { const value = state.integrations[requestParam(request, "id")]; if (value === undefined) throw new HandlerFailure(404, "Integration not found"); value.status = "Disconnected"; return structuredClone(value); }); return reply.send(ok(withoutSecretFields(item), "Integration disconnected", null)); }

function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function validURL(value: unknown): string { const text = stringValue(value).trim(); try { const parsed = new URL(text); if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("unsupported protocol"); return parsed.toString(); } catch { throw new HandlerFailure(400, "A valid HTTP(S) URL is required"); } }
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }

// Builds a plain-English summary of what the user can do in the ERP, grouped by module.
function buildCapabilitiesResponse(tools: readonly import("../../registry/schemas.js").ToolDefinition[]): string {
  // Group by module
  const groups = new Map<string, { reads: string[]; writes: string[] }>();
  for (const tool of tools) {
    const module = (tool.module ?? "General").trim() || "General";
    if (!groups.has(module)) groups.set(module, { reads: [], writes: [] });
    const display = (tool.display_name ?? tool.name).replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 60);
    if (tool.is_read_only) groups.get(module)!.reads.push(display);
    else groups.get(module)!.writes.push(display);
  }

  const lines: string[] = ["Here's what you can do in the ERP:\n"];
  for (const [module, { reads, writes }] of groups.entries()) {
    lines.push(`## ${module}`);
    if (reads.length > 0) {
      lines.push("**View / Query:**");
      reads.slice(0, 10).forEach((r) => lines.push(`- ${r}`));
    }
    if (writes.length > 0) {
      lines.push("**Create / Update / Action:**");
      writes.slice(0, 10).forEach((w) => lines.push(`- ${w}`));
    }
    lines.push("");
  }
  lines.push("Just ask me in plain language — for example: *\"Show me open purchase orders\"* or *\"Approve the pending request\"*.");
  return lines.join("\n");
}

// Picks the most relevant read-only tools for the user's query, capped at `limit`.
// Scores by how many query words appear in the tool name or description.
function selectRelevantTools(query: string, tools: readonly import("../../registry/schemas.js").ToolDefinition[], limit: number): readonly import("../../registry/schemas.js").ToolDefinition[] {
  if (tools.length <= limit) return tools;
  const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
  if (words.length === 0) return tools.slice(0, limit);
  const scored = tools.map((tool) => {
    const haystack = `${tool.name} ${tool.description}`.toLowerCase();
    const score = words.reduce((n, w) => n + (haystack.includes(w) ? 1 : 0), 0);
    return { tool, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.tool);
}
