import { randomUUID } from "node:crypto";
import { z } from "zod";
import { runQueryLoop, type ToolStep } from "../agent/query-loop.js";
import { discoverTools } from "../agent/tool-discovery.js";
import { dispatchReadTool } from "../tools/read-tool-broker.js";
import { capabilityContractHash } from "../registry/capability-admission.js";
import { HandlerFailure, isRecord, type CurrentUser, type HandlerServices } from "../http/handlers/common.js";
import { requestedModel, selectProvider } from "../http/handlers/model-selection.js";
import { promptData } from "../prompts/contracts.js";
import { libraryRequest } from "./library-client.js";
import type { ProviderInvocationContext } from "../analysisprovider/types.js";
import { OpenAICompatibleError } from "../providers/openai-compatible.js";

export type CollectionRoute = { collection: string; schema_id: string; tier: "standard" | "restricted"; document_types: string[]; searchable_documents: number; accepts_uploads: boolean; description: string };
export type EntitySchema = { id: string; revision: number; source_system_id: string; source_entity: string; primary_key: string; collection_routes?: CollectionRoute[];
  lookup_tool?: string; fields: Array<{ name: string; type: string; required?: boolean; generated?: boolean }>; document_types: string[] };
export type RecordChoice = { id: string; schemaId: string; key: string; label: string; readReceipt: { toolName: string; arguments: Record<string, unknown>; contractHash: string } };

/** Only keys in acknowledged read results count. Model prose is never evidence. */
export function recordsInResult(result: unknown, key: string): Array<Record<string, unknown>> {
  const records: Array<Record<string, unknown>> = [], seen = new Set<string>(); let visited = 0;
  const visit = (value: unknown, depth = 0) => {
    if (++visited > 3000 || depth > 10 || records.length >= 30) return;
    if (typeof value === "string" && depth < 4 && value.length < 512_000) { try { visit(JSON.parse(value), depth + 1); } catch {} return; }
    if (Array.isArray(value)) { value.slice(0, 100).forEach(child => visit(child, depth + 1)); return; }
    if (!isRecord(value) || value.isError === true || value.error !== undefined || value.success === false) return;
    const id = value[key];
    if ((typeof id === "string" && id.trim() && id.length <= 200) || typeof id === "number" && Number.isSafeInteger(id)) {
      const identifier = String(id);
      if (!seen.has(identifier)) { seen.add(identifier); records.push(value); }
    }
    for (const child of Object.values(value)) visit(child, depth + 1);
  };
  visit(result); return records;
}

const modelProposal = z.object({ schemaId: z.string().max(200), documentType: z.string().max(128),
  fields: z.record(z.string(), z.union([z.string().max(4000), z.number().finite(), z.boolean(), z.null()])),
  rows: z.array(z.record(z.string(), z.union([z.string().max(4000), z.number().finite(), z.boolean(), z.null()]))).min(1).max(50).optional(), summary: z.string().max(1000) }).strict();

export async function analyseAttachment(services: HandlerServices, user: CurrentUser, sessionId: string, schemas: EntitySchema[],
  upload: Record<string, any>, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (typeof body.instruction !== "string" || !body.instruction.trim() || body.instruction.length > 2000)
    throw new HandlerFailure(422, "Describe the record to find or the form to review (up to 2000 characters)");
  const provider = selectProvider(services, requestedModel(body.model));
  if (!provider?.configured) throw new HandlerFailure(503, "Configure a model before asking the assistant to review this attachment");
  if (!schemas.length) throw new HandlerFailure(422, "An administrator must import an entity schema first");
  if (schemas.length > 40) throw new HandlerFailure(422, "Choose a specific entity schema before analysis");
  const createRecord = body.createRecord === true, choices: RecordChoice[] = [];
  // Even ERP lookup may involve personal data; do not use a weaker model policy.
  provider.assertEgress({ purpose: "interactive", dataClass: "restricted" });
  let documentAttachment: ProviderInvocationContext["documentAttachment"];
  if (body.preferExtractedText !== true && upload.model_source_available === true && /\.(png|jpe?g|pdf)$/i.test(String(upload.filename)) && Number(upload.size_bytes) <= 4 * 1024 * 1024) {
    if (/\.pdf$/i.test(String(upload.filename)) && provider.configuration?.baseURL.replace(/\/+$/, "") !== "https://openrouter.ai/api/v1") {
      if (upload.status === "EXTRACTING") throw new HandlerFailure(409, "Document text is still being prepared. Continue chatting and review it when ready.", { code: "ATTACHMENT_PROCESSING" });
    } else {
      const source = await libraryRequest(services, user, `/uploads/${encodeURIComponent(String(upload.id))}/source`, { maxResponseBytes: 6 * 1024 * 1024 });
      if (!["image/png", "image/jpeg", "application/pdf"].includes(source.content_type) || source.content_hash !== upload.content_hash ||
          typeof source.data_base64 !== "string" || typeof source.filename !== "string" || source.filename.length > 120)
        throw new HandlerFailure(409, "The attachment source could not be verified. Refresh before model review.");
      documentAttachment = { filename: source.filename, mimeType: source.content_type, dataBase64: source.data_base64, sha256: source.content_hash };
    }
  }
  if (upload.status === "EXTRACTING" && !documentAttachment)
    throw new HandlerFailure(409, "Document text is still being prepared. Continue chatting and review it when ready.", { code: "ATTACHMENT_PROCESSING" });
  if (!documentAttachment && !String(upload.extracted_text ?? "").trim())
    throw new HandlerFailure(422, "No readable source is available for model review. Review the file manually or retry document preparation.", { code: "ATTACHMENT_NO_READABLE_SOURCE" });
  if (!createRecord) {
    const tools = (await discoverTools(services.erpbridgeSession ?? null, services.registries)).filter(tool => tool.is_read_only && tool.allowed_roles.includes(user.role) &&
      schemas.some(schema => schema.lookup_tool && [tool.name, tool.mcp_tool_name].includes(schema.lookup_tool)));
    if (!tools.length) throw new HandlerFailure(422, "No role-granted, reviewed ERPBridge lookup tool matches these schemas. Use a pipeline form record or ask an administrator to register a lookup.");
    const result = await runQueryLoop({ userMessage: `Find existing records for this attachment request. Read only; do not create or modify records. Request: ${body.instruction}\nEntity keys: ${promptData(schemas.map(schema => ({ id: schema.id, entity: schema.source_entity, key: schema.primary_key, lookup: schema.lookup_tool })))}`,
      chatHistory: [], sessionId, actorId: user.id, actorRole: user.role }, tools,
      (name, args) => dispatchReadTool(services, user.id, name, args, { sessionId }), provider);
    for (const step of result.toolSteps.filter((step: ToolStep) => step.status === "SUCCEEDED")) {
      const tool = tools.find(tool => [tool.name, tool.mcp_tool_name].includes(step.toolName)); if (!tool) continue;
      for (const schema of schemas.filter(schema => [tool.name, tool.mcp_tool_name].includes(schema.lookup_tool ?? ""))) {
        for (const record of recordsInResult(step.result, schema.primary_key)) {
          const key = String(record[schema.primary_key]);
          if (choices.some(choice => choice.schemaId === schema.id && choice.key === key) || choices.length >= 30) continue;
          const name = ["name", "full_name", "display_name", "employee_name"].map(field => record[field]).find(value => typeof value === "string");
          choices.push({ id: randomUUID(), schemaId: schema.id, key, label: `${typeof name === "string" ? name.slice(0, 120) + " — " : ""}${schema.source_entity}: ${key}`,
            readReceipt: { toolName: step.toolName, arguments: step.arguments, contractHash: capabilityContractHash(tool) } });
        }
      }
    }
    if (!choices.length) throw new HandlerFailure(422, "No ERP record with the declared primary key was confirmed. Refine the name or ID; nothing was associated.");
  }
  const generate = () => provider.generate(promptData({ request: body.instruction, createPipelineRecord: createRecord,
    schemas, verifiedChoices: choices.map(({ readReceipt: _private, ...choice }) => choice), extractedText: String(upload.extracted_text ?? "").slice(0, 24_000),
    source: { contentHash: upload.content_hash, independentExtractionPending: upload.status === "EXTRACTING", modelSourceAttached: Boolean(documentAttachment) },
    output: { schemaId: "one offered id", documentType: "one declared type", fields: "single form: declared fields and typed values only; omit missing values; empty object for batch",
      rows: "optional: when asked to add multiple members, return 1-50 complete source rows using the selected schema; never silently discard rows; flag partial coverage in summary", summary: "short review summary including missing values, duplicate keys or partial coverage" },
    routing: "Use the offered schema collection_routes and their permitted counts/purposes to select a schema and declared documentType from the actual document and request. Fill observed schema fields automatically, including a supplied registration/reference key; leave missing values absent. Never invent a collection, source system, reference or ERP id. If no offered schema fits, or multiple source systems fit without evidence to distinguish them, return empty schemaId/documentType and explain what the person needs to choose. The server derives the destination, and a human must confirm it." }),
    "prompt/document-attachment/v1", undefined, "", { actor: { id: user.id, role: user.role }, sessionId, maxOutputTokens: 2048,
      ...(documentAttachment ? { documentAttachment } : {}), egress: { purpose: "interactive", dataClass: "restricted" } });
  let response;
  try { response = await generate(); }
  catch (error) {
    if (!documentAttachment || !(error instanceof OpenAICompatibleError) || ![400, 415, 422].includes(error.statusCode ?? 0)) throw error;
    // Do not switch models or invoke a third-party OCR plugin implicitly.
    // The same selected model can still review independently extracted text.
    if (!String(upload.extracted_text ?? "").trim()) throw new HandlerFailure(409,
      "The selected model cannot read this file directly. Document text is still being prepared; you can continue chatting.", { code: "ATTACHMENT_PROCESSING" });
    documentAttachment = undefined;
    response = await generate();
  }
  let proposal: z.infer<typeof modelProposal>;
  try { proposal = modelProposal.parse(JSON.parse(response.text)); }
  catch { throw new HandlerFailure(422, "The assistant returned an invalid field proposal. Nothing was confirmed; try again or review manually.", { code: "ATTACHMENT_PROPOSAL_INVALID" }); }
  const schema = schemas.find(schema => schema.id === proposal.schemaId);
  if (!schema || !schema.document_types.includes(proposal.documentType) || [proposal.fields, ...(proposal.rows ?? [])].some(row => Object.keys(row).some(key => !schema.fields.some(field => field.name === key))) || proposal.rows && !createRecord)
    throw new HandlerFailure(422, "The field proposal does not match an imported schema. Nothing was confirmed.");
  const destination = schema.collection_routes?.find(route => route.accepts_uploads && route.document_types.includes(proposal.documentType));
  if (schema.collection_routes && !destination) throw new HandlerFailure(409, "The schema has no valid document destination. Reload its collection catalog.");
  return { ...proposal, ...(destination ? { destination } : {}), schemaRevision: schema.revision, createRecord, choices, reviewedAt: new Date().toISOString(), model: response.model,
    sourceContentHash: upload.content_hash, sourceMethod: documentAttachment ? "model_document" : "extracted_text", requiresHumanReview: true,
    textCoverage: documentAttachment ? "model document interpretation; verify every field against the source" : String(upload.extracted_text ?? "").length > 24_000 ? "partial; first 24000 characters" : "extracted content" };
}

export async function verifyChoice(services: HandlerServices, user: CurrentUser, sessionId: string, schema: EntitySchema, choice: RecordChoice) {
  const tools = await discoverTools(services.erpbridgeSession ?? null, services.registries);
  const tool = tools.find(tool => [tool.name, tool.mcp_tool_name].includes(choice.readReceipt.toolName));
  if (!tool || !tool.is_read_only || !tool.allowed_roles.includes(user.role) || ![tool.name, tool.mcp_tool_name].includes(schema.lookup_tool ?? "") || capabilityContractHash(tool) !== choice.readReceipt.contractHash)
    throw new HandlerFailure(409, "The reviewed ERP lookup changed. Analyse the attachment again.");
  const result = await dispatchReadTool(services, user.id, choice.readReceipt.toolName, choice.readReceipt.arguments, { sessionId });
  if (!recordsInResult(result, schema.primary_key).some(record => String(record[schema.primary_key]) === choice.key))
    throw new HandlerFailure(409, "The selected ERP record was not confirmed by a fresh lookup. Analyse again.");
  return { kind: "verified_erp_record", business_key_name: schema.primary_key, business_key_value: choice.key };
}
