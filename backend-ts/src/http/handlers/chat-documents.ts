import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { RouteDefinition } from "../generated-routes.js";
import { appendAudit, bodyRecord, HandlerFailure, requestParam, type CurrentUser, type HandlerServices } from "./common.js";
import { assertActorAuthority } from "./model-selection.js";
import { bufferUpload } from "./pipeline-gateway.js";
import { libraryRequest, libraryScope, publicAttachment } from "../../documents/library-client.js";
import { analyseAttachment, verifyChoice, type EntitySchema, type RecordChoice } from "../../documents/attachment-analysis.js";
import { discoverTools } from "../../agent/tool-discovery.js";
import { previewDocument, readPreviewUpload } from "../../documents/model-preview.js";
import { prepareChatAttachment, readChatAttachmentUpload } from "../../documents/chat-attachment.js";
import { nextID, now } from "./common.js";
import { INTERACTIVE_HANDOFF_MS } from "../../core/interactive-handoff.js";

export const CHAT_DOCUMENTS_UNHANDLED = Symbol("chat-documents-unhandled");
const confirmSchema = z.object({ expected_revision: z.number().int().positive(), schema_id: z.string().max(200), schema_revision: z.number().int().positive(),
  document_type: z.string().max(128), create_record: z.boolean(), form_fields: z.record(z.string(), z.unknown()).default({}), form_rows: z.array(z.record(z.string(), z.unknown())).min(1).max(50).optional(), choiceId: z.string().max(200).optional(),
  mode: z.enum(["new", "version"]).default("new"), document_id: z.string().max(200).optional(), document_revision: z.number().int().positive().optional(),
  review_confirmed: z.literal(true), extraction_acknowledged: z.boolean().default(false), share_with_schema_roles: z.boolean().default(false), chat_receipt: z.boolean().optional(), synthetic_source_confirmed: z.boolean().optional() }).strict();

export async function handleChatDocumentRoute(route: RouteDefinition, request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown | typeof CHAT_DOCUMENTS_UNHANDLED> {
  const catalogBase = `${services.config.apiBasePath}/pipeline/v1/library`;
  const attachmentBase = `${services.config.apiBasePath}/chat/sessions/:id/attachments`;
  if (!route.path.startsWith(catalogBase) && !route.path.startsWith(attachmentBase)) return CHAT_DOCUMENTS_UNHANDLED;
  // Document inspection is not a policy evaluation or an ERP operation. The
  // backend signs a short-lived, read-only owner/role scope; browser-supplied
  // collection names, access tokens and identities are never accepted.
  if ([`${catalogBase}/search`, `${catalogBase}/resolve`].includes(route.path)) {
    const assertReader = () => services.repository.readAuthoritative(state => {
      assertActorAuthority(state, user);
      if (!user.permissions.some(permission => ["chat:use", "workflow:write"].includes(permission))) throw new HandlerFailure(403, "Document read access is required");
      if (request.signal?.aborted) throw new HandlerFailure(409, "Document request cancelled");
    });
    await assertReader();
    const search = route.path.endsWith("/search");
    const parsed = (search ? z.object({ query: z.string().trim().min(1).max(2000), limit: z.number().int().min(1).max(20).default(10) }).strict()
      : z.object({ document_id: z.string().trim().min(1).max(200) }).strict()).safeParse(request.body);
    if (!parsed.success) throw new HandlerFailure(422, "Enter a search phrase or a saved document ID. Access scope is managed by the backend.");
    void reply.header("Cache-Control", "no-store");
    const result = await libraryRequest(services, user, search ? "/search" : "/resolve", { method: "POST", body: parsed.data, readOnly: true, timeoutMs: 15000, signal: request.signal });
    await assertReader();
    if (!search && result.document_id !== (parsed.data as { document_id: string }).document_id) throw new HandlerFailure(502, "The pipeline returned a different document identity");
    return reply.send(result);
  }
  if (route.path === `${catalogBase}/delegation`) {
    await services.repository.readAuthoritative(state => {
      assertActorAuthority(state, user);
      if (!user.permissions.some(permission => ["chat:use", "workflow:write"].includes(permission))) throw new HandlerFailure(403, "Current chat access is required");
    });
    void reply.header("Cache-Control", "no-store");
    return reply.send({ access_token: libraryScope(services.config, user, true), expires_in: 120, scope: "permitted current document reads only", revocation_window_seconds: 120 });
  }
  const sessionId = route.path.startsWith(attachmentBase) ? requestParam(request, "id") : "";
  const assertCurrent = () => services.repository.readAuthoritative(state => {
    assertActorAuthority(state, user);
    if (!user.permissions.includes("pipeline:upload")) throw new HandlerFailure(403, "Your role cannot upload or review documents");
    if (sessionId && (state.chats[sessionId]?.ownerId !== user.id || !user.permissions.some(permission => ["chat:use", "workflow:write"].includes(permission))))
      throw new HandlerFailure(404, "This chat's attachments are not available");
  });
  await assertCurrent();
  if (route.path === `${attachmentBase}/prepare` && route.method === "POST") {
    void reply.header("Cache-Control", "no-store");
    const { source, body } = await readChatAttachmentUpload(request);
    await assertCurrent();
    await services.repository.mutate(state => {
      assertActorAuthority(state, user);
      appendAudit(state, user, "pipeline.chat_attachment.requested", "chat", sessionId, null, { sizeBytes: source.bytes.length }, request);
    });
    const result = await prepareChatAttachment(services, user, sessionId, source, body);
    await assertCurrent();
    if (body.save_to_conversation === "true") await services.repository.mutate(state => {
      assertActorAuthority(state, user);
      const chat = state.chats[sessionId];
      if (!chat || chat.ownerId !== user.id) throw new HandlerFailure(404, "Chat not found");
      // An intake preview is durable discussion context, not a save/index receipt.
      const intakeKey = `${body.idempotency_key}:${result.attachment.sourceHash}`;
      if (chat.messages.some(message => (message.artifacts as any)?.documentIntakeKey === intakeKey)) return;
      chat.messages.push({ id: nextID(state, "msg"), role: "user", text: body.instruction, createdAt: now() });
      chat.messages.push({ id: nextID(state, "msg"), role: "assistant", createdAt: now(), text: result.attachment.summary,
        artifacts: { intent: "DOCUMENT_PREPARATION", documentIntakeKey: intakeKey, chatAttachment: { sessionId, ...result.attachment } } });
      chat.messageCount = chat.messages.length; chat.updatedAt = now();
    });
    return reply.send(result);
  }
  if (route.path === `${attachmentBase}/preview` && route.method === "POST") {
    void reply.header("Cache-Control", "no-store");
    const { source, body } = await readPreviewUpload(request);
    await assertCurrent();
    const result = await previewDocument(services, user, sessionId, source, body, request.signal);
    await assertCurrent();
    await services.repository.mutate(state => {
      assertActorAuthority(state, user);
      if (state.chats[sessionId]?.ownerId !== user.id) throw new HandlerFailure(404, "Chat not found");
      appendAudit(state, user, "document.model_preview.completed", "chat_document_preview", result.sourceContentHash, null,
        { sessionId, model: result.model, pipelineStorageConfirmed: false }, request);
    });
    return reply.send(result);
  }
  if (route.path === `${catalogBase}/catalog`) {
    if (route.method === "GET") return reply.send(await libraryRequest(services, user, "/catalog"));
    if (!user.permissions.includes("registry:write")) throw new HandlerFailure(403, "Only a schema administrator can import entity schemas");
    const body = bodyRecord(request); if (!body) throw new HandlerFailure(422, "Supply an entity schema JSON object");
    if (body.lookup_tool) {
      const tools = await discoverTools(services.erpbridgeSession ?? null, services.registries);
      if (!tools.some(tool => tool.is_read_only && [tool.name, tool.mcp_tool_name].includes(String(body.lookup_tool))))
        throw new HandlerFailure(422, "Choose an available reviewed read-only ERPBridge lookup tool, or omit lookup_tool for pipeline-only forms");
    }
    await assertCurrent();
    await services.repository.mutate(state => { assertActorAuthority(state, user); appendAudit(state, user, "pipeline.schema.requested", "document_schema", "catalog", null, null, request); });
    return reply.send(await libraryRequest(services, user, "/catalog", { method: "POST", body }));
  }
  if (route.path === `${catalogBase}/inventory`)
    return reply.send(await libraryRequest(services, user, "/inventory"));
  if (route.path === `${catalogBase}/migrate`) {
    if (!user.permissions.includes("registry:write")) throw new HandlerFailure(403, "Only a schema administrator can migrate owned document collections");
    const parsed = z.object({ document_id: z.string().min(1).max(200), expected_revision: z.number().int().positive(), review_confirmed: z.literal(true) }).strict().safeParse(bodyRecord(request));
    if (!parsed.success) throw new HandlerFailure(422, "Review the current document revision and explicitly confirm migration. Arbitrary collection names are not accepted.");
    await assertCurrent();
    await services.repository.mutate(state => { assertActorAuthority(state, user); appendAudit(state, user, "pipeline.collection.migration.requested", "chat_document", parsed.data.document_id, null, null, request); });
    const result = await libraryRequest(services, user, "/migrate", { method: "POST", body: parsed.data });
    await assertCurrent(); return reply.send(result);
  }
  if (route.path === attachmentBase && route.method === "GET") {
    const result = await libraryRequest(services, user, `/uploads?session_id=${encodeURIComponent(sessionId)}`);
    await assertCurrent(); return reply.send({ items: (result.items ?? []).map(publicAttachment) });
  }
  const audit = async (action: string, id: string) => services.repository.mutate(state => {
    assertActorAuthority(state, user);
    if (state.chats[sessionId]?.ownerId !== user.id) throw new HandlerFailure(404, "Chat not found");
    appendAudit(state, user, action, "chat_document", id, null, { sessionId }, request);
  });
  if (route.path === attachmentBase && route.method === "POST") {
    if (!request.isMultipart()) throw new HandlerFailure(422, "Choose a file to attach");
    const upload = await bufferUpload(request, new Set(["idempotency_key"]), services.config.jwtSecret);
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(upload.metadata.idempotency_key ?? "")) throw new HandlerFailure(422, "A stable upload request identity is required");
    upload.form.append("session_id", sessionId);
    upload.form.append("defer_extraction", "true");
    await assertCurrent(); await audit("pipeline.attachment.requested", upload.filenameHash);
    // Bound only the upload acknowledgement wait, not OCR lifetime. A timeout
    // is an unknown storage outcome: retain the original idempotency key and
    // reconcile the receipt instead of silently replaying the upload.
    const result = await libraryRequest(services, user, "/uploads", { method: "POST", form: upload.form, timeoutMs: INTERACTIVE_HANDOFF_MS });
    await assertCurrent(); return reply.status(201).send(publicAttachment(result));
  }
  const uploadId = requestParam(request, "uploadId"), path = `/uploads/${encodeURIComponent(uploadId)}`;
  const upload = await libraryRequest(services, user, `${path}?include_text=true`);
  if (upload.session_id !== sessionId) throw new HandlerFailure(404, "This attachment is not in this chat");
  await assertCurrent();
  if (route.method === "GET") return reply.send({ ...publicAttachment(upload), extracted_text: upload.extracted_text });
  if (route.path.endsWith("/recover")) {
    await audit("pipeline.attachment.recovery.requested", uploadId);
    return reply.send(publicAttachment(await libraryRequest(services, user, `${path}/recover`, { method: "POST", body: { expected_revision: bodyRecord(request)?.expected_revision } })));
  }
  const catalog = await libraryRequest(services, user, "/catalog"), schemas = catalog.entities as EntitySchema[];
  if (route.path.endsWith("/analyse")) {
    if (["READY", "SUPERSEDED", "INDEXING"].includes(upload.status)) throw new HandlerFailure(409, "This attachment cannot be analysed in its current state");
    const body = bodyRecord(request) ?? {};
    const selected = body.schemaId ? schemas.filter(schema => schema.id === body.schemaId) : schemas;
    if (!selected.length) throw new HandlerFailure(422, "Choose an available entity schema");
    const proposal = await analyseAttachment(services, user, sessionId, selected, upload, body);
    await assertCurrent();
    // OCR and model work independently. Fetch the latest revision rather than
    // dropping a valid model proposal when OCR completed during inference.
    const current = await libraryRequest(services, user, path);
    if (current.content_hash !== upload.content_hash || current.session_id !== sessionId || ["READY", "INDEXING", "SUPERSEDED"].includes(current.status) ||
        JSON.stringify(current.proposal ?? null) !== JSON.stringify(upload.proposal ?? null))
      throw new HandlerFailure(409, "The attachment changed during review. Refresh before continuing.");
    const saved = await libraryRequest(services, user, `${path}/proposal`, { method: "POST", body: { expected_revision: current.revision, proposal } });
    await assertCurrent(); return reply.send(publicAttachment(saved));
  }
  if (route.path.endsWith("/confirm")) {
    const parsed = confirmSchema.safeParse(bodyRecord(request));
    if (!parsed.success) throw new HandlerFailure(422, "Review the association and fields, then explicitly confirm. Unknown authority fields are not accepted.");
    const { choiceId, chat_receipt, ...body } = parsed.data;
    const schema = schemas.find(schema => schema.id === body.schema_id && schema.revision === body.schema_revision);
    if (!schema) throw new HandlerFailure(409, "The entity schema changed. Reload and review again.");
    let target: Record<string, unknown> | undefined;
    if (!body.create_record) {
      const proposal = upload.proposal, choices = proposal?.choices as RecordChoice[] | undefined;
      const choice = choices?.find(choice => choice.id === choiceId && choice.schemaId === schema.id);
      const reviewedAt = Date.parse(proposal?.reviewedAt ?? "");
      if (!choice || proposal.createRecord !== false || !Number.isFinite(reviewedAt) || Date.now() - reviewedAt > 10 * 60_000)
        throw new HandlerFailure(409, "Choose a current assistant-verified ERP record. Analyse again if the proposal expired.");
      target = await verifyChoice(services, user, sessionId, schema, choice);
    }
    await assertCurrent(); await audit("pipeline.attachment.confirm.requested", uploadId);
    const result = await libraryRequest(services, user, `${path}/confirm`, { method: "POST", body: { ...body, ...(target ? { target } : {}) } });
    await assertCurrent();
    if (chat_receipt && result.status === "READY") await services.repository.mutate(state => {
      assertActorAuthority(state, user);
      const chat = state.chats[sessionId];
      if (!chat || chat.ownerId !== user.id) throw new HandlerFailure(404, "Chat not found");
      if (chat.messages.some(message => (message.artifacts as any)?.indexedAttachment?.uploadId === uploadId)) return;
      chat.messages.push({ id: nextID(state, "msg"), role: "assistant", createdAt: now(),
        text: `Document saved and searchable: ${result.filename ?? upload.filename}. Source: ${schema.source_system_id} / ${schema.source_entity}. Document ID: ${result.document_id}, version ${result.version}. Pipeline record: ${result.pipeline_record_id ?? "none"}. Collection: ${result.vector_collection ?? "not returned"}. No original ERP record was created. Ask in this chat to retrieve these stored details through the backend document library or prepare a reviewed ERP change.`,
        artifacts: { intent: "DOCUMENT_STORAGE", indexedAttachment: { uploadId, documentId: result.document_id, version: result.version, collection: result.vector_collection, pipelineRecordId: result.pipeline_record_id } } });
      chat.messageCount = chat.messages.length; chat.updatedAt = now();
    });
    return reply.send(publicAttachment(result));
  }
  return CHAT_DOCUMENTS_UNHANDLED;
}
