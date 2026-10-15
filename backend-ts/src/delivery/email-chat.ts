import { createHash } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { canonicalJSONBytes } from "../core/canonical-json.js";
import { discoverTools } from "../agent/tool-discovery.js";
import { runQueryLoop, type QueryLoopResult } from "../agent/query-loop.js";
import { dispatchReadTool } from "../tools/read-tool-broker.js";
import type { RepositoryState } from "../repository/store.js";
import { appendAudit, HandlerFailure, isRecord, nextID, now, type CurrentUser, type HandlerServices } from "../http/handlers/common.js";
import { createEmailDraft, deliveryIntent, draftRequirements, emailDraftCommandSchema, emailDraftHash, emailDraftMessage, type EmailDraft } from "./email-draft.js";
import { resolveRecipientReference } from "./recipient-resolution.js";
import type { ChatProcessingHooks } from "../agent/chat-context.js";

function assertOwner(state: RepositoryState, sessionId: string, user: CurrentUser) {
  const chat = state.chats[sessionId];
  const actor = state.users[user.id];
  const permissions = actor ? [...(state.roles[actor.roleId]?.permissions ?? []), ...actor.permissionOverrides] : [];
  if (!actor || actor.status.toLowerCase() !== "active" || !permissions.includes("chat:use") || state.roles[actor.roleId]?.name !== user.role) throw new HandlerFailure(403, "Chat authority is no longer available");
  if (!chat || chat.ownerId !== user.id) throw new HandlerFailure(404, "Chat session not found");
  return chat;
}

// Saving is not approval or delivery. No SDK or provider is reachable here.
export async function editEmailDraft(services: HandlerServices, user: CurrentUser, sessionId: string, rawCommand: unknown, request: FastifyRequest) {
  const parsed = emailDraftCommandSchema.safeParse(rawCommand);
  if (!parsed.success) throw new HandlerFailure(400, "Invalid email draft edit; provide one valid recipient, subject, body and revision");
  const command = parsed.data;
  const fingerprint = createHash("sha256").update(canonicalJSONBytes(command)).digest("hex");
  return services.repository.mutate((state) => {
    const chat = assertOwner(state, sessionId, user);
    const prior = chat.messages.find((message) => isRecord(message.artifacts) && isRecord(message.artifacts.emailDraftCommand) && message.artifacts.emailDraftCommand.id === command.commandId);
    if (prior) {
      const receipt = (prior.artifacts as Record<string, unknown>).emailDraftCommand as Record<string, unknown>;
      if (receipt.fingerprint !== fingerprint) throw new HandlerFailure(409, "This edit identifier was already used for different changes");
      return { assistantMessage: prior, answer: prior.text, intent: "EMAIL_DELIVERY", operation: { success: false, code: "EMAIL_NOT_SENT" } };
    }
    const latest = [...chat.messages].reverse().find((message) => isRecord(message.artifacts) && isRecord(message.artifacts.emailDraft) && message.artifacts.emailDraft.id === command.draftId);
    const original = latest && isRecord(latest.artifacts) ? latest.artifacts.emailDraft as EmailDraft : undefined;
    if (!original || original.profile !== "email-draft-v1" || original.ownerId !== user.id || original.sessionId !== sessionId) throw new HandlerFailure(404, "Email draft not found");
    if (Object.values(state.emailDeliveryAdmissions).some(item => item.sessionId === sessionId && item.draftId === original.id))
      throw new HandlerFailure(409, "This exact draft already has an approval request and is immutable");
    if (original.version !== command.baseVersion || original.contentHash !== command.baseHash) throw new HandlerFailure(409, "The email draft changed. Reload the conversation before editing");
    const recipientChanged = command.patch.to !== original.to;
    const draft: EmailDraft = { ...structuredClone(original), ...command.patch,
      ...(recipientChanged ? { recipientResolution: null } : {}), version: original.version + 1, updatedAt: now(), state: "DRAFT_NOT_SENT", reportStatus: "USER_EDITED" };
    draft.requirements = draftRequirements(draft); draft.contentHash = emailDraftHash(draft);
    const userMessage = { id: nextID(state, "msg"), role: "user", text: "Save email draft changes", createdAt: now() };
    const message = { id: nextID(state, "msg"), role: "assistant", text: emailDraftMessage(draft), artifacts: { intent: "EMAIL_DELIVERY", emailDraft: draft, can_execute: false,
      emailDraftCommand: { id: command.commandId, fingerprint } }, createdAt: now() };
    chat.messages.push(userMessage, message); chat.messageCount = chat.messages.length; chat.updatedAt = now();
    appendAudit(state, user, "email_draft.updated", "email_draft", draft.id, { version: original.version, contentHash: original.contentHash }, { version: draft.version, contentHash: draft.contentHash, state: draft.state }, request);
    return { userMessage, assistantMessage: message, answer: message.text, intent: "EMAIL_DELIVERY", operation: { success: false, code: "EMAIL_NOT_SENT" } };
  });
}

export async function prepareEmailDraft(services: HandlerServices, user: CurrentUser, sessionId: string, content: string, request: FastifyRequest | undefined, context: { signal?: AbortSignal; traceId?: string; hooks?: ChatProcessingHooks } = {}) {
  const signal = context.signal ?? request?.signal;
  const hooks = context.hooks;
  const intent = deliveryIntent(content);
  if (!intent) throw new HandlerFailure(400, "Delivery request is unresolved");
  await services.repository.read((state) => assertOwner(state, sessionId, user));
  let report: QueryLoopResult | undefined;
  let reason = intent.reportRequested ? "REPORT_NOT_PREPARED" : "MESSAGE_REQUIRED";
  if (intent.reportRequested) {
    if (!services.erpbridgeSession) reason = "ERPBRIDGE_NOT_CONNECTED";
    else if (!services.providerRuntime?.configured) reason = "PROVIDER_NOT_CONFIGURED";
    else {
      try {
        const tools = (await discoverTools(services.erpbridgeSession, services.registries)).filter((tool) => tool.is_read_only && tool.allowed_roles.includes(user.role));
        if (!tools.length) reason = "NO_ADMITTED_READ_TOOLS";
        else {
          // No prior model-produced draft is a source of ERP facts. Sending is
          // never delegated to the query loop, even when requested in the text.
          report = await runQueryLoop({ userMessage: `Prepare only the report requested below using confirmed reads. Never send email, resolve a person's address by guessing, or activate a schedule. If the report scope or reporting period is unclear, ask for it instead of assuming.\n\nOriginal request:\n${content}`,
            chatHistory: [], sessionId, actorId: user.id, actorRole: user.role, ...(context.traceId ? { traceId: context.traceId } : {}), ...(signal ? { signal } : {}), ...(hooks ? { onTurn: () => hooks.stage("MODEL") } : {}) }, tools,
            (name, args) => hooks ? hooks.read(name, args, beforeDispatch => dispatchReadTool(services, user.id, name, args, { signal, sessionId, traceId: context.traceId, beforeDispatch })) : dispatchReadTool(services, user.id, name, args, { signal, sessionId, traceId: context.traceId }), services.providerRuntime, true);
          reason = report.stopReason === "PROVIDER_FAILED" || report.stopReason === "CANCELLED" ? report.stopReason : report.readOutcome ?? "REPORT_NOT_PREPARED";
        }
      } catch { reason = "REPORT_PREPARATION_FAILED"; }
    }
  }
  return services.repository.mutate((state) => {
    hooks?.assertCurrent(state);
    const chat = assertOwner(state, sessionId, user);
    const recipientResolution = intent.recipientReference ? resolveRecipientReference(state, user.id, intent.recipientReference) : null;
    const draft = createEmailDraft(nextID(state, "email_draft"), sessionId, user.id, content, intent, report, recipientResolution);
    const questions = report?.clarification?.questions ?? [];
    const text = emailDraftMessage(draft) + (questions.length ? `\n\nTo prepare this email, please answer in chat:\n${questions.map(question => `- ${question}`).join("\n")}` : "");
    const message = { id: nextID(state, "msg"), role: "assistant", text, modelBinding: services.providerRuntime?.binding ?? null, ...(context.traceId ? { traceId: context.traceId } : {}), artifacts: { intent: "EMAIL_DELIVERY", emailDraft: draft, can_execute: false, reportReason: reason,
      ...(questions.length ? { emailPreparation: { status: "NEEDS_DETAILS", questions } } : {}),
      ...(report ? { sources: report.toolCallLog, toolSteps: report.toolSteps, readOutcome: report.readOutcome, boundHit: report.boundHit, stopReason: report.stopReason } : {}) }, createdAt: now() };
    chat.messages.push(message); chat.messageCount = chat.messages.length; chat.updatedAt = now();
    hooks?.saved(state, message);
    appendAudit(state, user, "email_draft.created", "email_draft", draft.id, null, { version: draft.version, contentHash: draft.contentHash, state: draft.state, reportStatus: draft.reportStatus }, request);
    return { assistantMessage: message, answer: text, intent: "EMAIL_DELIVERY", operation: { success: false, code: "EMAIL_NOT_SENT" } };
  });
}
