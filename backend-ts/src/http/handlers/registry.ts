import { createHash, randomBytes } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { FastifyReply, FastifyRequest } from "fastify";
import { fail, ok } from "../../models/schemas.js";
import { ruleArraySchema, toolArraySchema } from "../../registry/schemas.js";
import type { RouteDefinition } from "../generated-routes.js";
import { appendAudit, bodyRecord, HandlerFailure, type CurrentUser, type HandlerServices, isRecord, nextID, now, queryRecord, requestParam, stringValue } from "./common.js";

export const REGISTRY_UNHANDLED = Symbol("registry-unhandled");

type ImportDraft = { id: string; kind: "tools" | "rules"; records: unknown[]; allowUpdates: boolean; createdAt: string };
const importDrafts = new Map<string, ImportDraft>();

export async function handleRegistryRoute(route: RouteDefinition, request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown | typeof REGISTRY_UNHANDLED> {
  const base = services.config.apiBasePath;
  try {
    if (route.path === `${base}/registry/status`) return registryStatus(reply, services);
    if (route.path === `${base}/registry/tools` && route.method === "POST") return createTool(request, reply, user, services);
    if (route.path === `${base}/registry/tools/:id` && route.method === "PUT") return updateTool(request, reply, user, services);
    if (route.path === `${base}/registry/tools/import`) {
      if (request.body === undefined || (isRecord(request.body) && request.body.invalidJSONBody === true)) throw new HandlerFailure(422, "invalid registry import: expected one JSON array: unexpected EOF");
      if (!Array.isArray(request.body)) throw new HandlerFailure(422, "invalid registry import: expected one JSON array: json: cannot unmarshal object into Go value of type []json.RawMessage");
      return importTools(request, reply, user, services);
    }
    if (route.path === `${base}/registry/rules` && route.method === "POST") return createRule(request, reply, user, services);
    if (route.path === `${base}/registry/rules/:id` && route.method === "PUT") return updateRule(request, reply, user, services);
    if (route.path === `${base}/registry/rules/import`) {
      if (request.body === undefined || (isRecord(request.body) && request.body.invalidJSONBody === true)) throw new HandlerFailure(422, "invalid registry import: expected one JSON array: unexpected EOF");
      if (!Array.isArray(request.body)) throw new HandlerFailure(422, "invalid registry import: expected one JSON array: json: cannot unmarshal object into Go value of type []json.RawMessage");
      return importRules(request, reply, user, services);
    }
    if (route.path === `${base}/registry/context` && route.method === "GET") return getContext(reply, services);
    if (route.path === `${base}/registry/context/regenerate`) return regenerateContext(reply, user, services, request);
    if (route.path === `${base}/registry/context/history`) return contextHistory(reply, services);
    if (route.path === `${base}/import/analyse`) return analyseImport(request, reply, services);
    if (route.path === `${base}/import/commit`) return commitImport(request, reply, user, services);
    if (route.path === `${base}/import/history`) return importHistory(reply, services);
  } catch (error) {
    if (error instanceof HandlerFailure) return reply.status(error.status).send(fail(error.message, error.meta));
    const text = errorText(error);
    const status = text.includes("already exists") ? 409 : text.includes("not found") ? 404 : 422;
    return reply.status(status).send(fail(text, null));
  }
  return REGISTRY_UNHANDLED;
}

function requireRegistryWrite(user: CurrentUser, services: HandlerServices): void {
  if (user.role !== "Platform Admin") throw new HandlerFailure(403, "Only Platform Admin can modify the runtime registry");
  for (const path of [services.registries.toolPath, services.registries.rulePath]) if (path.toLowerCase().replaceAll("\\", "/").includes("/configs/registries/")) throw new HandlerFailure(403, "Frozen evaluation registries are read-only");
}

async function registryStatus(reply: FastifyReply, services: HandlerServices): Promise<unknown> { const [toolBytes, ruleBytes] = await Promise.all([readFile(services.registries.toolPath), readFile(services.registries.rulePath)]); return reply.send(ok({ mode: "runtime", writable: true, tools: { path: services.registries.toolPath, sha256: `sha256:${createHash("sha256").update(toolBytes).digest("hex")}` }, rules: { path: services.registries.rulePath, sha256: `sha256:${createHash("sha256").update(ruleBytes).digest("hex")}` } }, "Active registry status loaded", null)); }

async function createTool(request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown> {
  requireRegistryWrite(user, services); const body = registryBody(request, "tool", false); let tool;
  try { tool = await services.registries.upsertTool(body, false); } catch (error) { throw new HandlerFailure(422, `invalid tool schema: ${errorText(error)}`); }
  await auditRegistry(request, user, services, "registry.tool.created", tool.tool_id); return reply.status(201).send(ok(tool, "Registry tool created", null));
}
async function updateTool(request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown> {
  requireRegistryWrite(user, services); const body = registryBody(request, "tool", true); body.tool_id = requestParam(request, "id"); let tool;
  try { tool = await services.registries.upsertTool(body, true); } catch (error) { throw new HandlerFailure(422, `invalid tool schema: ${errorText(error)}`); }
  await auditRegistry(request, user, services, "registry.tool.updated", tool.tool_id); return reply.send(ok(tool, "Registry tool updated", null));
}
async function createRule(request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown> {
  requireRegistryWrite(user, services); const body = registryBody(request, "rule", false); let rule;
  try { rule = await services.registries.upsertRule(body, false); } catch (error) { throw new HandlerFailure(422, `invalid rule: ${errorText(error)}`); }
  await auditRegistry(request, user, services, "registry.rule.created", rule.rule_id); return reply.status(201).send(ok(rule, "Registry rule created", null));
}
async function updateRule(request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown> {
  requireRegistryWrite(user, services); const body = registryBody(request, "rule", true); body.rule_id = requestParam(request, "id"); let rule;
  try { rule = await services.registries.upsertRule(body, true); } catch (error) { throw new HandlerFailure(422, `invalid rule: ${errorText(error)}`); }
  await auditRegistry(request, user, services, "registry.rule.updated", rule.rule_id); return reply.send(ok(rule, "Registry rule updated", null));
}

function registryBody(request: FastifyRequest, kind: "tool" | "rule", updating: boolean): Record<string, unknown> {
  const body = bodyRecord(request); const prefix = kind === "tool" ? "invalid tool schema" : "invalid rule";
  if (body === null) throw new HandlerFailure(422, `${prefix}: unexpected EOF`);
  if (Object.keys(body).length > 0) return body;
  if (kind === "tool") { const fields = updating ? "description, http_method, mcp_tool_name, tool_id, name, display_name, module, status" : "display_name, module, status, description, http_method, mcp_tool_name, tool_id, name"; throw new HandlerFailure(422, `${prefix}: required fields missing: ${fields}`); }
  const fields = updating ? "severity, condition.type, rule_id, rule_name, domain, description, enforcement_action, validator_message, condition.operator, rule_type" : "domain, enforcement_action, severity, validator_message, condition.type, condition.operator, rule_id, rule_name, rule_type, description";
  throw new HandlerFailure(422, `${prefix}: required fields missing: ${fields}`);
}

async function importTools(request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown> { requireRegistryWrite(user, services); const allowUpdates = stringValue(queryRecord(request).allowUpdates).toLowerCase() === "true"; let result; try { result = await services.registries.importTools(request.body, allowUpdates); } catch (error) { throw new HandlerFailure(422, "Tool registry import rejected", { applied: false, count: 0, errors: [errorText(error)] }); } await services.repository.mutate((state) => appendAudit(state, user, "registry.tools.imported", "registry", "tools", { registryHash: result.oldHash }, { registryHash: result.newHash, count: result.tools.length }, request)); return reply.status(201).send(ok({ applied: true, count: result.tools.length, ids: result.tools.map((tool) => tool.tool_id), errors: [], oldHash: result.oldHash, newHash: result.newHash, semanticRebuildSuggested: true }, "Tool registry import applied", null)); }
async function importRules(request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown> { requireRegistryWrite(user, services); const allowUpdates = stringValue(queryRecord(request).allowUpdates).toLowerCase() === "true"; let result; try { result = await services.registries.importRules(request.body, allowUpdates); } catch (error) { throw new HandlerFailure(422, "Rule registry import rejected", { applied: false, count: 0, errors: [errorText(error)] }); } await services.repository.mutate((state) => appendAudit(state, user, "registry.rules.imported", "registry", "rules", { registryHash: result.oldHash }, { registryHash: result.newHash, count: result.rules.length }, request)); return reply.status(201).send(ok({ applied: true, count: result.rules.length, ids: result.rules.map((rule) => rule.rule_id), errors: [], oldHash: result.oldHash, newHash: result.newHash, semanticRebuildSuggested: true }, "Rule registry import applied", null)); }

async function getContext(reply: FastifyReply, services: HandlerServices): Promise<unknown> { if (services.contextAvailable !== true) throw new HandlerFailure(503, "registry generation context is unavailable"); const path = contextPath(services); try { const markdown = await readFile(path, "utf8"); return reply.send(ok({ path, markdown, sha256: `sha256:${createHash("sha256").update(markdown).digest("hex")}` }, "Registry generation context loaded", null)); } catch { throw new HandlerFailure(503, "registry generation context is unavailable"); } }
async function regenerateContext(reply: FastifyReply, user: CurrentUser, services: HandlerServices, request: FastifyRequest): Promise<unknown> { const context = await writeContext(services); await services.repository.mutate((state) => { const entry = { id: nextID(state, "context"), ...context, createdAt: now(), createdBy: { id: user.id, name: user.name } }; state.registryContextHistory.push(entry); appendAudit(state, user, "registry.context.regenerated", "registry_context", stringValue(entry.id), null, { sha256: context.sha256 }, request); }); return reply.send(ok(context, "Registry generation context regenerated", null)); }
async function contextHistory(reply: FastifyReply, services: HandlerServices): Promise<unknown> { const history = await services.repository.read((state) => [...state.registryContextHistory].reverse()); return reply.send(ok(history, "Registry generation context history loaded", { count: history.length })); }

async function writeContext(services: HandlerServices): Promise<Record<string, unknown>> { const snapshot = services.registries.snapshot(); const markdown = renderContext(snapshot.tools, snapshot.rules, services.registries.hash()); const path = contextPath(services); const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`; await writeFile(temp, markdown, "utf8"); await rename(temp, path); return { path, markdown, sha256: `sha256:${createHash("sha256").update(markdown).digest("hex")}`, registryHash: services.registries.hash() }; }
function renderContext(tools: readonly { name: string; description: string; required_parameters: string[]; allowed_roles: string[] }[], rules: readonly { rule_id: string; rule_name: string; validator_message: string; enabled: boolean }[], hash: string): string { const lines = ["---", `registry_hash: ${hash}`, `generated_at: ${now()}`, "---", "", "# Runtime registry context", "", "## Tools", ...tools.flatMap((tool) => [`### ${tool.name}`, "", tool.description, "", `Required parameters: ${tool.required_parameters.join(", ")}`, `Allowed roles: ${tool.allowed_roles.join(", ")}`, ""]), "## Enabled rules", ...rules.filter((rule) => rule.enabled).flatMap((rule) => [`### ${rule.rule_id}: ${rule.rule_name}`, "", rule.validator_message, ""])]; return lines.join("\n") + "\n"; }
function contextPath(services: HandlerServices): string { return resolve(dirname(services.registries.toolPath), "registry_context.md"); }

async function analyseImport(request: FastifyRequest, reply: FastifyReply, services: HandlerServices): Promise<unknown> { let raw = ""; let kind = stringValue(queryRecord(request).kind).toLowerCase(); let allowUpdates = stringValue(queryRecord(request).allowUpdates).toLowerCase() === "true"; if (request.isMultipart()) { const file = await request.file(); if (file === undefined) throw new HandlerFailure(400, "Import file is required"); const bytes = await file.toBuffer(); if (bytes.byteLength > 10 * 1024 * 1024) throw new HandlerFailure(413, "Import file exceeds 10 MiB"); raw = bytes.toString("utf8"); const fields = file.fields as Record<string, { value?: unknown }>; if (kind === "") kind = stringValue(fields.kind?.value).toLowerCase(); if (fields.allowUpdates?.value !== undefined) allowUpdates = stringValue(fields.allowUpdates.value).toLowerCase() === "true"; } else { const body = bodyRecord(request); if (body === null) throw new HandlerFailure(400, "Invalid request body"); raw = typeof body.content === "string" ? body.content : JSON.stringify(body.records ?? body); if (kind === "") kind = stringValue(body.kind).toLowerCase(); if (typeof body.allowUpdates === "boolean") allowUpdates = body.allowUpdates; }
  const decoded: unknown = JSON.parse(raw); if (kind !== "tools" && kind !== "rules") throw new HandlerFailure(400, "Import kind must be tools or rules"); const records = kind === "tools" ? toolArraySchema.parse(decoded) : ruleArraySchema.parse(decoded); if (records.length === 0) throw new HandlerFailure(422, "No importable records were found"); const id = `analysis_${randomBytes(8).toString("hex")}`; const draft: ImportDraft = { id, kind, records, allowUpdates, createdAt: now() }; importDrafts.set(id, draft); const existing = kind === "tools" ? services.registries.snapshot().tools : services.registries.snapshot().rules; const identities = new Set(existing.map((item) => kind === "tools" ? (item as { tool_id: string }).tool_id.toLowerCase() : (item as { rule_id: string }).rule_id.toLowerCase())); const preview = records.map((record, index) => { const value = record as unknown as Record<string, unknown>; const recordID = stringValue(value[kind === "tools" ? "tool_id" : "rule_id"]); return { id: recordID, index, action: identities.has(recordID.toLowerCase()) ? "update" : "create", record: value }; }); return reply.send(ok({ analysisId: id, kind, count: records.length, records: preview, stages: [{ name: "PARSE", passed: true }, { name: "NORMALISE", passed: true }, { name: "VALIDATE", passed: true }, { name: "DIFF", passed: true }] }, "Registry import analysed", null)); }

async function commitImport(request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown> { requireRegistryWrite(user, services); const body = bodyRecord(request); if (body === null) throw new HandlerFailure(400, "Invalid request body"); const analysisID = stringValue(body.analysisId); if (analysisID === "") throw new HandlerFailure(400, "analysisId is required"); const draft = importDrafts.get(analysisID); if (draft === undefined) throw new HandlerFailure(422, "Import analysis was not found or has expired"); const selected = new Set(Array.isArray(body.selectedRecordIds) ? body.selectedRecordIds.filter((item): item is string => typeof item === "string") : []); const idKey = draft.kind === "tools" ? "tool_id" : "rule_id"; const records = selected.size === 0 ? draft.records : draft.records.filter((item) => isRecord(item) && selected.has(stringValue(item[idKey]))); if (records.length === 0) throw new HandlerFailure(422, "No records were selected for import"); const result = draft.kind === "tools" ? await services.registries.importTools(records, draft.allowUpdates) : await services.registries.importRules(records, draft.allowUpdates); const entry = await services.repository.mutate((state) => { const value = { id: nextID(state, "import"), analysisId: analysisID, kind: draft.kind, count: records.length, oldHash: result.oldHash, newHash: result.newHash, committedAt: now(), committedBy: { id: user.id, name: user.name } }; state.importHistory.push(value); appendAudit(state, user, "registry.import.committed", "registry_import", analysisID, { registryHash: result.oldHash }, { registryHash: result.newHash, count: records.length }, request); return value; }); importDrafts.delete(analysisID); return reply.send(ok({ applied: true, ...entry }, "Registry import committed", null)); }
async function importHistory(reply: FastifyReply, services: HandlerServices): Promise<unknown> { const history = await services.repository.read((state) => [...state.importHistory].reverse()); return reply.send(ok(history, "Registry import history loaded", { count: history.length })); }
async function auditRegistry(request: FastifyRequest, user: CurrentUser, services: HandlerServices, action: string, id: string): Promise<void> { await services.repository.mutate((state) => appendAudit(state, user, action, "registry", id, null, { registryHash: services.registries.hash() }, request)); }
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
