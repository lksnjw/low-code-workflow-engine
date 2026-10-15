import { ok } from "../../models/schemas.js";
import { identifyChatIntent, type IntentRouting } from "../../agent/intent-router.js";
import { recallConversationHistory } from "../../agent/chat-history-recall.js";
import { runAssistantConversation, selectedDiscussionWorkflow, workflowDiscussionSnapshot, workflowDiscussionStateNote } from "../../agent/workflow-discussion.js";
import { assertActorAuthority, assertChatAuthority } from "./model-selection.js";
import { HandlerFailure, isRecord, nextID, now, stringValue } from "./common.js";
import type { RepositoryState } from "../../repository/store.js";
import type { processStoredChat } from "./chat.js";
import { directLibraryConfigured } from "../../documents/direct-library.js";

type Input = Parameters<typeof processStoredChat>[0];
type ChatMutation = <T>(mutation: (state: RepositoryState) => T) => Promise<T>;

export async function processMissingReadCapability(input: Input, intent: string, chatMutation: ChatMutation) {
  const { services, user, sessionId, traceId, stored } = input;
  const canReview = user.role === "Platform Admin" && user.permissions.includes("registry:write");
  const text = "No currently approved ERP read tool is available for your role and this connection. " +
    (canReview ? "You have tool-review permission: open Registry → ERPBridge capability review, refresh discovery, and review the required read tool and its role access. " :
      "Ask a platform administrator to review the required read tool and your role's access; also check your own ERP connection in Profile. ") +
    "A missing role grant, disabled capability or changed tool contract can cause this. Administrator login alone does not approve an ERP tool. No ERP read or record change was performed.";
  const assistantMessage = await chatMutation(state => {
    const chat = assertChatAuthority(state, user, sessionId);
    const message = { id: nextID(state, "msg"), role: "assistant", text, createdAt: now(), traceId, modelBinding: services.providerRuntime?.binding ?? null,
      artifacts: { intent, blocked: true, code: "NO_APPROVED_READ_TOOLS", toolSteps: [], toolsDispatched: false,
        accessRecovery: { profile: "erp-read-access-recovery/v1", canReview, automaticGrant: false } } };
    chat.messages.push(message); chat.messageCount = chat.messages.length; chat.updatedAt = now(); return message;
  });
  return ok({ session: stored.session, userMessage: stored.userMessage, assistantMessage, answer: text, intent }, "Read capability approval is required; no ERP operation performed", null);
}

/** Classification remains tool-less and is bracketed by current authority
 * checks. The caller must admit this inference and recheck a changed route. */
export async function identifyAdmittedChatIntent(input: Input): Promise<IntentRouting> {
  const { body, content, sessionId, traceId, stored, user, services, signal, hooks } = input;
  const workspace = await services.repository.readAuthoritative(state => {
    hooks?.assertCurrent(state as RepositoryState);
    assertActorAuthority(state, user);
    const raw = isRecord(body.nodeContext) ? { workflowId: body.nodeContext.workflowId, baseVersion: body.nodeContext.baseVersion, baseHash: body.nodeContext.baseHash } : body.workflowContext;
    const selected = selectedDiscussionWorkflow(state, user, sessionId, raw);
    const savedMessageCount = assertChatAuthority(state, user, sessionId).messages.length;
    const attachment = { documentLibraryAvailable: directLibraryConfigured(services),
      ...(body.attachmentTicket !== undefined ? { currentAttachmentIncluded: true, attachmentIsUnreviewedBusinessInput: true } : body.documentContext === undefined ? {} : { reviewedAttachmentSelected: true }) };
    return selected ? { ...attachment, workflowSelected: true, workflowName: selected.workflow.name, draftVersion: selected.workflow.draftVersion,
      publishedVersion: selected.workflow.publishedVersion, canEditWorkflow: user.permissions.includes("workflow:write"), savedMessageCount,
      ...(isRecord(body.nodeContext) ? { selectedNodeId: body.nodeContext.nodeId } : {}) } : { ...attachment, workflowSelected: false, savedMessageCount };
  });
  const routing = await identifyChatIntent({ content, history: stored.priorMessages, workspace, actorId: user.id, role: user.role, sessionId, traceId,
    ...(signal ? { signal } : {}), ...(hooks ? { onTurn: () => hooks.stage("MODEL") } : {}) }, services.providerRuntime!);
  await services.repository.readAuthoritative(state => { hooks?.assertCurrent(state as RepositoryState); assertChatAuthority(state, user, sessionId); });
  return routing;
}

/** General explanations and workflow discussions have no ERP dispatch path. */
export async function processConversationalChat(input: Input, intent: "CONVERSATION" | "WORKFLOW_DISCUSSION", intentRouting: IntentRouting | undefined, chatMutation: ChatMutation) {
  const { body, content, sessionId, traceId, stored, user, services, signal, hooks } = input, provider = services.providerRuntime;
  const historyRecall = intent === "CONVERSATION" && intentRouting?.historyRecall ? await services.repository.readAuthoritative(state => {
    hooks?.assertCurrent(state as RepositoryState);
    return recallConversationHistory(state, user, sessionId, intentRouting!.historyRecall, stringValue(stored.userMessage.id));
  }) : undefined;
  const nodeReference = isRecord(body.nodeContext) ? { workflowId: body.nodeContext.workflowId, baseVersion: body.nodeContext.baseVersion, baseHash: body.nodeContext.baseHash } : undefined;
  const reference = nodeReference ?? body.workflowContext;
  const snapshot = intent === "WORKFLOW_DISCUSSION" ? await services.repository.readAuthoritative(state => {
    assertActorAuthority(state, user);
    return workflowDiscussionSnapshot(state, user, sessionId, reference, services.registries.snapshot().tools);
  }) : null;
  const explanation = intentRouting?.needsClarification ? { text: intentRouting.clarification!, explanationAvailable: false, usage: { inputTokens: 0, outputTokens: 0, measured: false } } :
    (snapshot || intent === "CONVERSATION") && provider?.configured ? await runAssistantConversation({ kind: intent, content, history: stored.priorMessages, ...(historyRecall ? { historyRecall } : {}),
    ...(snapshot ? { snapshot: { ...snapshot, ...(isRecord(body.nodeContext) ? { selectedNodeId: body.nodeContext.nodeId } : {}) } } : {}), actorId: user.id, role: user.role,
    sessionId, traceId, ...(signal ? { signal } : {}), ...(hooks ? { onTurn: () => hooks.stage("MODEL") } : {}) }, provider) : null;
  const assistantMessage = await chatMutation(state => {
    assertActorAuthority(state, user);
    const chat = assertChatAuthority(state, user, sessionId);
    const fresh = snapshot ? workflowDiscussionSnapshot(state, user, sessionId, { workflowId: snapshot.workflowId, baseVersion: snapshot.draftVersion, baseHash: snapshot.contentHash }, services.registries.snapshot().tools) : null;
    const text = intent === "CONVERSATION" ? explanation?.text ?? "I can help with questions, planning and workflow explanations. Configure an approved chat model to continue the conversation." : fresh ? `${explanation?.text ?? "I can explain this saved workflow. Configure an approved chat model for a conversational walkthrough."}\n\n${workflowDiscussionStateNote(fresh)}` :
      "Which workflow would you like me to explain? Select it in the canvas, or open its Edit in chat page, then ask your question. I have not fetched ERP data or changed anything.";
    const message = { id: nextID(state, "msg"), role: "assistant", text, createdAt: now(), traceId,
      modelBinding: explanation ? { ...provider!.binding, ...(explanation.modelRouting ? { model: explanation.modelRouting.model, requestedModel: explanation.modelRouting.requestedModel, fallbackUsed: explanation.modelRouting.fallbackUsed } : {}) } : null,
      artifacts: { intent, ...(fresh && intent === "WORKFLOW_DISCUSSION" ? { discussion: { profile: fresh.profile, workflowId: fresh.workflowId, name: fresh.name,
        draftVersion: fresh.draftVersion, publishedVersion: fresh.publishedVersion, nodeCount: fresh.nodeCount, contentHash: fresh.contentHash } } : {}),
        ...(historyRecall ? { conversationRecall: { profile: historyRecall.profile, messageIds: historyRecall.messages.map(message => message.id), limitedSelection: historyRecall.limitedSelection } } : {}),
        toolsDispatched: false, explanationAvailable: explanation?.explanationAvailable === true } };
    chat.messages.push(message); chat.messageCount = chat.messages.length; chat.updatedAt = now(); return message;
  });
  return ok({ session: stored.session, userMessage: stored.userMessage, assistantMessage, answer: assistantMessage.text, intent,
    ...(explanation ? { usage: explanation.usage } : {}) }, "Conversation saved; no ERP operation performed", null);
}
