import { toolRoleAllowed } from "../../governance/tool-access.js";
import { randomBytes } from "node:crypto";
import { reviewedDocumentChatContext, documentContextSchema, documentProposalFailure, documentRetrievalReview } from "../../documents/chat-document-context.js";
import { readAttachmentTicket, attachmentChatContext } from "../../documents/chat-attachment.js";
import { directLibraryConfigured, dispatchDirectLibraryRead } from "../../documents/direct-library.js";
import { LIBRARY_READ_TOOLS } from "../../documents/library-client.js";
import type { FastifyReply, FastifyRequest } from "fastify";
import { ok } from "../../models/schemas.js";
import { requestTraceId } from "../../trace/request-trace.js";
import type { RouteDefinition } from "../generated-routes.js";
import { appendAudit, bodyRecord, HandlerFailure, type CurrentUser, type HandlerServices, isRecord, nextID, now, requestParam, stringValue } from "./common.js";
import { classifyIntent } from "../../agent/intent-classifier.js";
import type { IntentRouting } from "../../agent/intent-router.js";
import { identifyAdmittedChatIntent, processConversationalChat, processMissingReadCapability } from "./chat-assistant.js";
import { administratorChatEnabled, administratorChatRoleEnabled, chatErpActionRoute, processAdministratorCapabilities, processBackendAgentChat } from "./chat-erp-actions.js";
import { editEmailDraft, prepareEmailDraft } from "../../delivery/email-chat.js";
import { deliveryIntent } from "../../delivery/email-draft.js";
import { admitEmailDelivery } from "../../delivery/email-operation.js";
import { resolveRecipientReference } from "../../delivery/recipient-resolution.js";
import { hasRecurringCompositionCapability, inspectRecurringAutomationCandidate, recurringAutomationCandidateContext,
  recurringAutomationShell, recurringDeliveryRequest, type RecurringAutomationComposition, type RecurringDeliveryRequest } from "../../delivery/recurring-automation.js";
import { runQueryLoop } from "../../agent/query-loop.js";
import { queryChatHistory, queryChatPresentation } from "../../agent/query-chat-presentation.js";
import { runActionLoop } from "../../agent/action-loop.js";
import { discoverTools, ToolDiscoveryError } from "../../agent/tool-discovery.js";
import { checkErpPolicy } from "../../governance/rbac.js";
import { type PolicyDecision } from "../../governance/optional-policy.js";
import { evaluateChatPolicy } from "../../governance/chat-policy.js";
import { checkDirectRagPolicy, directRagConfigured } from "../../governance/direct-rag.js";
import { dispatchReadTool, ReadAdmissionUnavailableError } from "../../tools/read-tool-broker.js";
import { processWorkflowProposal } from "../../agent/workflow-proposals.js";
import { processWorkflowControl } from "../../agent/workflow-controls.js";
import { parseWorkflowYAMLStrict } from "../../parser/workflow.js";
import { stringify as yamlStringify } from "yaml";
import { assertActorAuthority, assertChatAuthority, requestedModel, selectProvider, withSelectedProvider } from "./model-selection.js";
import { activeChatStatus, chatJobQueue } from "../../agent/chat-jobs.js";
import { processNodeProposal } from "../../agent/node-proposals.js";
import { chatSummary, createChat, deleteChat, getChat, listChats, updateChat } from "./chat-sessions.js";
import { revisionPriorContext } from "../../agent/chat-request-revisions.js";
import { buildCapabilitiesResponse, compactWorkflowArtifacts, errorText } from "./chat-artifacts.js";
import { reviewedModelSourceContext } from "../../synthesis/reviewed-model-sources.js";
import { chatWorkspaceStatus, workspaceStatusAnswer } from "../../agent/chat-workspace-status.js";
export const CHAT_UNHANDLED = Symbol("chat-unhandled");

/*******************************************************************************
 * Function: handleChatRoute
 *
 * Dispatches saved chat sessions, model catalog, and chat messages.
 ******************************************************************************/
export async function handleChatRoute(route: RouteDefinition, request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown | typeof CHAT_UNHANDLED> {
  const base = services.config.apiBasePath;
  if (route.path === `${base}/chat/sessions/:id/erp-actions/:actionId`) return chatErpActionRoute(request, reply, user, services, route.method === "POST");
  if (route.path === `${base}/chat/sessions` && route.method === "GET") return listChats(request, reply, user, services);
  if (route.path === `${base}/chat/models` && route.method === "GET") return reply.send(ok(
    services.providerRuntime?.catalog() ?? { configured: false, binding: null, models: [] }, "Configured chat models loaded; remote compatibility is not certified", null));
  if (route.path === `${base}/chat/sessions` && route.method === "POST") return createChat(request, reply, user, services);
  if (route.path === `${base}/chat/sessions/:id` && route.method === "GET") return getChat(request, reply, user, services);
  if (route.path === `${base}/chat/sessions/:id` && route.method === "PATCH") return updateChat(request, reply, user, services);
  if (route.path === `${base}/chat/sessions/:id` && route.method === "DELETE") return deleteChat(request, reply, user, services);
  if (route.path === `${base}/chat/sessions/:id/messages`) return sendChatMessage(request, reply, user, services);
  return CHAT_UNHANDLED;
}

/** Function: sendChatMessage. Admit input into the matching query, action or workflow flow. */
async function sendChatMessage(request: FastifyRequest, reply: FastifyReply, user: CurrentUser, services: HandlerServices): Promise<unknown> {
  const body = bodyRecord(request);
  if (body === null) throw new HandlerFailure(400, "Invalid request body");
  if (body.requestRevision !== undefined && (body.emailDraftCommand !== undefined || body.emailDeliveryCommand !== undefined)) throw new HandlerFailure(400, "Request revisions cannot be combined with delivery or draft commands");
  if (Object.hasOwn(body, "emailDeliveryCommand")) return reply.status(202).send(ok(
    await admitEmailDelivery(services, user, requestParam(request, "id"), body.emailDeliveryCommand, requestTraceId(request), request),
    "Independent approval requested for the exact draft; nothing has been sent", null));
  if (Object.hasOwn(body, "emailDraftCommand")) return reply.send(ok(await editEmailDraft(services, user, requestParam(request, "id"), body.emailDraftCommand, request), "Email draft saved; nothing sent", null));
  if (body.delivery === "async-chat") return reply.status(202).send(ok(
    await chatJobQueue(services).admit(requestParam(request, "id"), user, body, requestTraceId(request)), "Chat operation acknowledged; no business completion is implied", null));
  if (body.delivery !== undefined) throw new HandlerFailure(400, "Unsupported chat delivery mode");
  if (Object.hasOwn(body, "nodeContext") || Object.hasOwn(body, "requestRevision")) throw new HandlerFailure(400, "Node prompts and request revisions require saved asynchronous chat admission");
  const content = stringValue(body.content).trim() === "" ? stringValue(body.message).trim() : stringValue(body.content).trim();
  if (content === "") throw new HandlerFailure(400, "message is required");
  const previousModel = await services.repository.read((state) => state.chats[requestParam(request, "id")]?.selectedModel);
  const provider = selectProvider(services, requestedModel(body.model) ?? previousModel);
  if (provider !== undefined) services = withSelectedProvider(services, provider);
  const intent = body.documentContext === undefined ? classifyIntent(content, { workflowContext: body.workflowContext !== undefined || body.nodeContext !== undefined, nodeContext: body.nodeContext !== undefined }) : "ACTION";
  const traceId = requestTraceId(request);
  const stored = await services.repository.mutate((state) => {
    const id = requestParam(request, "id");
    if (Object.values(state.chatOperations).some(op => op.sessionId === id && activeChatStatus(op.status)))
      throw new HandlerFailure(409, "This conversation has an active operation; wait or cancel before sending another message", { code: "CHAT_OPERATION_ACTIVE" });
    let chat = state.chats[id];
    if (chat === undefined) { const timestamp = now(); chat = { id, ownerId: user.id, title: content.slice(0, 80), createdAt: timestamp, updatedAt: timestamp, messageCount: 0, messages: [] }; state.chats[id] = chat; }
    if (chat.ownerId !== user.id) throw new HandlerFailure(404, "Chat session not found");
    assertChatAuthority(state, user, id);
    if (provider?.binding) chat.selectedModel = provider.binding.model;
    const priorMessages = revisionPriorContext(chat);
    const userMessage = { id: nextID(state, "msg"), role: "user", text: content, createdAt: now(), traceId, ...(provider?.binding ? { modelBinding: provider.binding } : {}) };
    chat.messages.push(userMessage); chat.messageCount = chat.messages.length; chat.updatedAt = now();
    return { session: chatSummary(chat), userMessage, priorMessages };
  });
  return reply.send(await processStoredChat({
    body, content, sessionId: requestParam(request, "id"), traceId, stored,
    user, services, ...(request.signal ? { signal: request.signal } : {}), request,
  }));
}

/** Shared synchronous/queued processing; no HTTP reply or request lifetime is
 * required by the worker. Saved input/context is admitted separately. */
export async function processStoredChat(input: {
  body: Record<string, unknown>; content: string; sessionId: string; traceId: string;
  stored: import("../../agent/chat-context.js").StoredChatInput;
  user: CurrentUser; services: HandlerServices; signal?: AbortSignal;
  request?: FastifyRequest; hooks?: import("../../agent/chat-context.js").ChatProcessingHooks;
  preGeneratedCandidate?: { input: import("../../synthesis/service.js").SynthesisInput; prepared: import("../../synthesis/service.js").PreparedCandidate;
    generated: import("../../analysisprovider/types.js").AnalysisResponse; liveTools: readonly import("../../registry/schemas.js").ToolDefinition[]; admittedPolicy: PolicyDecision };
}) {
  const { body, content, sessionId, traceId, user, services, signal, request, hooks, preGeneratedCandidate } = input;
  const attachment = body.attachmentTicket === undefined ? undefined : readAttachmentTicket(services, user, sessionId, body.attachmentTicket);
  if (attachment && [body.nodeContext, body.documentContext, body.workflowContext].some(value => value !== undefined))
    throw new HandlerFailure(422, "An attachment message cannot replace a workflow or node scope");
  const stored = attachment ? { ...input.stored, priorMessages: [...input.stored.priorMessages, attachmentChatContext(attachment)] } : input.stored;
  input = { ...input, stored };
  const provider = services.providerRuntime;
  // Selecting the reviewed-document workflow handoff is an explicit drafting
  // request, not an instruction for the conversational agent to execute writes.
  const documentWorkflow = body.documentContext === undefined ? undefined : documentContextSchema.safeParse(body.documentContext);
  if (documentWorkflow && (!documentWorkflow.success || body.nodeContext !== undefined || body.workflowContext !== undefined || preGeneratedCandidate))
    throw new HandlerFailure(422, "Document workflow drafting requires one exact reviewed source and no other workflow or node scope");
  let intent = documentWorkflow ? "ACTION" as const : classifyIntent(content, { workflowContext: body.workflowContext !== undefined || body.nodeContext !== undefined, nodeContext: body.nodeContext !== undefined });
  let intentRouting: IntentRouting | undefined;
  const parsedDeliveryIntent = deliveryIntent(content);
  const directoryResolution = parsedDeliveryIntent?.recipientReference ?
    await services.repository.read((state) => resolveRecipientReference(state, user.id, parsedDeliveryIntent.recipientReference!)) : null;
  const automationRequest = recurringDeliveryRequest(content, directoryResolution);
  const bodyWorkflowCtx = isRecord(body.workflowContext) ? body.workflowContext : null;
  const workflowContextYaml = typeof bodyWorkflowCtx?.yaml === "string" && bodyWorkflowCtx.yaml.trim() ? bodyWorkflowCtx.yaml.trim() : null;
  const workflowContextName = typeof bodyWorkflowCtx?.name === "string" && bodyWorkflowCtx.name ? bodyWorkflowCtx.name : "Workflow";
  let policyCheck: PolicyDecision | undefined;
  const chatMutation = async <T>(mutation: (state: import("../../repository/store.js").RepositoryState) => T) => {
    await hooks?.beforeCommit?.();
    return services.repository.mutate((state) => {
      hooks?.assertCurrent(state);
      const value = mutation(state);
      if (isRecord(value) && value.role === "assistant") {
        if (attachment) (value as Record<string, unknown>).artifacts = { ...(isRecord(value.artifacts) ? value.artifacts : {}), chatAttachment: { sessionId, ...attachment } };
        if (intentRouting) (value as Record<string, unknown>).artifacts = { ...(isRecord(value.artifacts) ? value.artifacts : {}), intentRouting };
        if (policyCheck?.source !== "skipped" && policyCheck !== undefined) {
          (value as Record<string, unknown>).artifacts = { ...(isRecord(value.artifacts) ? value.artifacts : {}), policyCheck };
        }
        hooks?.saved(state, value);
      }
      return value;
    });
  };
  const readTool = (name: string, args: Record<string, unknown>) => directLibraryConfigured(services) && LIBRARY_READ_TOOLS.has(name)
    ? hooks ? hooks.read(name, args, checkpoint => dispatchDirectLibraryRead(services, user, sessionId, name, args, { signal, traceId, beforeDispatch: () => checkpoint(user.role) }))
      : dispatchDirectLibraryRead(services, user, sessionId, name, args, { signal, traceId })
    : hooks
    ? hooks.read(name, args, beforeDispatch => dispatchReadTool(services, user.id, name, args, { signal, traceId, sessionId, beforeDispatch }))
    : dispatchReadTool(services, user.id, name, args, { signal, traceId, sessionId });
  await hooks?.stage("PREPARING");
  policyCheck = preGeneratedCandidate?.admittedPolicy ?? await evaluateChatPolicy(services, user, { prompt: content, intent, nodeContext: body.nodeContext, signal, traceId, sessionId, hooks });
  // Policy admits the classification inference first. The model's route is
  // data, not authority: a changed route must pass policy again before use.
  if (policyCheck.decision === "allow" && intent !== "CAPABILITIES" && !preGeneratedCandidate && !documentWorkflow &&
      services.config.chatIntentRouting === "agent" && provider?.configured) {
    intentRouting = await identifyAdmittedChatIntent(input);
    if (intent !== intentRouting.intent) {
      intent = intentRouting.intent;
      policyCheck = await evaluateChatPolicy(services, user, { prompt: content, intent, nodeContext: body.nodeContext, signal, traceId, sessionId, hooks });
    }
  }
  if (policyCheck.decision !== "allow") {
    const text = `**Request ${policyCheck.failureCode ? "stopped: policy check failed" : policyCheck.decision === "review" ? "needs policy review" : "blocked by policy"}.**\n\n${policyCheck.reason}`;
    const assistantMessage = await chatMutation(state => {
      const chat = assertChatAuthority(state, user, sessionId);
      const message = { id: nextID(state, "msg"), role: "assistant", text, artifacts: { intent: "POLICY_DENIAL", policyCheck }, createdAt: now(), traceId };
      chat.messages.push(message); chat.messageCount = chat.messages.length; chat.updatedAt = now();
      return message;
    });
    return ok({ session: stored.session, userMessage: stored.userMessage, assistantMessage, answer: text, intent: "POLICY_DENIAL", policyCheck }, "Policy check stopped this request; no business operation performed", null);
  }
  if (intent === "WORKFLOW_DISCUSSION" || intent === "CONVERSATION") return processConversationalChat(input, intent, intentRouting, chatMutation);
  if (intent === "WORKFLOW_CONTROL") return processWorkflowControl(input, intentRouting, chatMutation, policyCheck);
  // Count/list the current administrator token catalog directly, not a model's
  // keyword-search subset or the separate reviewed-role registry.
  if (intent === "CAPABILITIES" && administratorChatRoleEnabled(services, user) && body.documentContext === undefined) {
    await services.mcpConnectionRuntime?.ensureSession();
    return processAdministratorCapabilities(input, chatMutation);
  }
  if (directLibraryConfigured(services) && provider?.configured && ["QUERY", "AUDIT", "CAPABILITIES"].includes(intent) && body.nodeContext === undefined && body.documentContext === undefined)
    return processBackendAgentChat(input, intent, chatMutation);
  // Other intents may actually require ERP authoring or action capabilities.
  // Restore only the existing enabled connection, never for document-only reads.
  await services.mcpConnectionRuntime?.ensureSession();
  // One-off email is a normal agent task: discover reads/senders and prepare
  // the exact notification for confirmation. Do not divert administrators to
  // the legacy report-only draft path, which cannot resolve live email tools.
  // Recurring delivery remains ACTION and keeps its workflow/schedule gates.
  if (administratorChatEnabled(services, user) && provider?.configured && ["QUERY", "AUDIT", "CAPABILITIES", "TOOL_CALL", "EMAIL_DELIVERY"].includes(intent) &&
      (body.nodeContext === undefined || ["QUERY", "AUDIT", "CAPABILITIES"].includes(intent)) && body.documentContext === undefined)
    return processBackendAgentChat(input, intent, chatMutation);
  if (body.nodeContext !== undefined && intent === "WORKFLOW_MODIFY") {
    if (!hooks) throw new HandlerFailure(400, "Selected node prompts require saved chat operations");
    return processNodeProposal({ context: body.nodeContext, content, sessionId, traceId, user, services, ...(signal ? { signal } : {}), hooks });
  }
  if (intent === "WORKFLOW_MODIFY") return processWorkflowProposal(input, chatMutation);
  if (body.documentContext !== undefined && (body.nodeContext !== undefined || workflowContextYaml || preGeneratedCandidate))
    throw new HandlerFailure(422, "Document-based ERP proposals require a new resident chat generation, without another workflow or node scope");
  let documentContext: string | null = null;
  try {
    if (body.documentContext !== undefined) documentContext = await reviewedDocumentChatContext(services, user, sessionId, body.documentContext, async (name, args) => {
      if (directLibraryConfigured(services)) return readTool(name, args);
      // Check the current offered read before creating a content-read attempt.
      // An advertised MCP name alone is not an admitted document contract.
      let available;
      try { available = await discoverTools(services.erpbridgeSession ?? null, services.registries); }
      catch (error) { if (error instanceof ToolDiscoveryError) throw new ReadAdmissionUnavailableError(); throw error; }
      const matches = available.filter(tool => [tool.name, tool.mcp_tool_name].includes(name) && tool.is_read_only && toolRoleAllowed(tool.allowed_roles, user.role));
      if (matches.length !== 1) throw new ReadAdmissionUnavailableError();
      return readTool(name, args);
    }, intent === "ACTION" ? "workflow" : "chat");
  } catch (error) {
    if (!(error instanceof ReadAdmissionUnavailableError) || body.documentContext === undefined || signal?.aborted) throw error;
    const recovery = documentRetrievalReview(body.documentContext);
    const assistantMessage = await chatMutation(state => {
      const chat = assertChatAuthority(state, user, sessionId);
      const message = { id: nextID(state, "msg"), role: "assistant", ...recovery, createdAt: now(), traceId, modelBinding: services.providerRuntime?.binding ?? null };
      chat.messages.push(message); chat.messageCount = chat.messages.length; chat.updatedAt = now(); return message;
    });
    return ok({ session: stored.session, userMessage: stored.userMessage, assistantMessage, answer: assistantMessage.text, intent: "WORKFLOW_ERROR" }, "Document retrieval needs review; nothing executed", { traceId });
  }
  if (documentContext && intent !== "ACTION" && administratorChatEnabled(services, user) && provider?.configured)
    return processBackendAgentChat(input, intent, chatMutation, documentContext);
  const contextMessages = workflowContextYaml
    ? [`assistant: I have the following workflow loaded for context:\n**${workflowContextName}**\n\`\`\`yaml\n${workflowContextYaml}\n\`\`\``, ...stored.priorMessages]
    : stored.priorMessages;
  const augmentedPriorMessages = [...contextMessages, ...(documentContext ? [documentContext] : []), ...(policyCheck.source === "skipped" ? [] :
    [`assistant: Additional policy preflight (${policyCheck.source}): ${policyCheck.reason}. This is not execution permission; mandatory validation and approvals remain required.`])];
  const preserveRecurringShell = async (requestValue: RecurringDeliveryRequest, compositionFailure?: "COMPOSITION_UNAVAILABLE" | "CAPABILITY_DISCOVERY_UNAVAILABLE" | "NO_REVIEWED_COMPOSITION_CAPABILITY") => {
    await hooks?.stage("GENERATING");
    const yaml = recurringAutomationShell(content, requestValue), timestamp = now();
    const savedAutomation = await chatMutation((state) => {
      const chat = assertChatAuthority(state, user, sessionId);
      let workflowId: string | null = null;
      if (user.permissions.includes("workflow:write")) {
        workflowId = nextID(state, "wf");
        state.workflows[workflowId] = { id: workflowId, name: `${requestValue.cadence === "custom" ? "Recurring" : requestValue.cadence} delivery automation`,
          description: "Incomplete recurring delivery workflow preserved from chat", owner: { id: user.id, name: user.name }, assignedUserIds: [], status: "PENDING",
          trigger: { type: "manual" }, steps: 0, successRate: 0, lastRunAt: null, publishedVersion: 0, draftVersion: 1, tags: [], domainTags: [],
          canRun: false, createdAt: timestamp, updatedAt: timestamp, yaml, archived: false, chatSessionId: sessionId,
          chatMessageId: stringValue(stored.userMessage.id), prompt: content, traceId } as unknown as import("../../models/schemas.js").Workflow;
        hooks?.artifact(state, { type: "workflow-draft", id: workflowId });
      }
      const reason = compositionFailure === undefined ? "The configured model or ERPBridge connection is unavailable." :
        compositionFailure === "NO_REVIEWED_COMPOSITION_CAPABILITY" ? "No exact reviewed report or delivery capability is currently available." :
          compositionFailure === "CAPABILITY_DISCOVERY_UNAVAILABLE" ? "Current ERPBridge capability discovery could not be confirmed." :
            "The generated composition did not satisfy the server-owned recurring-workflow contract.";
      const text = workflowId ? `Recurring automation shell saved in the canvas. ${reason} It is incomplete, has not been published or executed, and no schedule is active. Resolve the listed requirements before publication and activate recurrence only through the scheduler.` :
        `Recurring automation requirements were preserved, but your current role cannot save a workflow. ${reason} Nothing was sent and no schedule is active.`;
      const artifacts = { intent: "WORKFLOW", yaml, selected_workflow_yaml: yaml, ...(workflowId ? { workflowId } : {}), automationRequest: requestValue,
        ...(compositionFailure ? { compositionFailure } : {}), can_execute: false, validation_passed: false,
        validation: { passed: false, failed_rules: ["SCHEMA_INVALID", "UNRESOLVED_REQUIREMENTS"], warnings: [] },
        blocking_errors: requestValue.requirements, next_action: "REVIEW_DRAFT" };
      const assistantMessage = { id: nextID(state, "msg"), role: "assistant", text, artifacts, createdAt: timestamp, traceId };
      chat.messages.push(assistantMessage); chat.messageCount = chat.messages.length; chat.updatedAt = timestamp; hooks?.saved(state, assistantMessage);
      return { workflowId, assistantMessage, text, artifacts };
    });
    return ok({ session: stored.session, userMessage: stored.userMessage, assistantMessage: savedAutomation.assistantMessage, answer: savedAutomation.text,
      intent: "ACTION", workflowDraft: { yaml }, validation: savedAutomation.artifacts.validation }, "Recurring workflow shell preserved; no schedule or delivery occurred", null);
  };
  if (intent === "EMAIL_DELIVERY") {
    const result = await prepareEmailDraft(services, user, sessionId, content, request, { ...(signal ? { signal } : {}), traceId, ...(hooks ? { hooks } : {}) });
    return ok({ session: stored.session, userMessage: stored.userMessage, ...result }, "Email draft prepared; nothing sent", null);
  }
  if (intent === "ACTION" && automationRequest &&
      (services.synthesis === undefined || services.erpbridgeSession === undefined || services.providerRuntime?.configured !== true))
    return preserveRecurringShell(automationRequest);
  if (["QUERY", "AUDIT", "TOOL_CALL"].includes(intent) &&
      (services.erpbridgeSession === undefined || services.providerRuntime?.configured !== true)) {
    const code = services.erpbridgeSession === undefined ? "ERPBRIDGE_NOT_CONNECTED" : "PROVIDER_NOT_CONFIGURED";
    const text = code === "ERPBRIDGE_NOT_CONNECTED"
      ? "ERPBridge is not connected. I cannot retrieve ERP data or execute tools for this request. No ERP operation was performed."
      : "The agent provider is not configured. I cannot plan this request. No ERP operation was performed.";
    const assistantMessage = await chatMutation((state) => {
      const chat = assertChatAuthority(state, user, sessionId);
      const message = { id: nextID(state, "msg"), role: "assistant", text, artifacts: { intent, blocked: true, code }, createdAt: now(), traceId };
      chat.messages.push(message); chat.messageCount = chat.messages.length; chat.updatedAt = now();
      return message;
    });
    return ok({ session: stored.session, userMessage: stored.userMessage, assistantMessage, answer: text,
      intent, blocked: true, operation: { success: false, code } }, "Message processed; ERP operation unavailable", null);
  }
  if (intent === "CAPABILITIES") {
    const liveCapTools = (await discoverTools(services.erpbridgeSession ?? null, services.registries)).filter(tool => toolRoleAllowed(tool.allowed_roles, user.role));
    const capText = services.erpbridgeSession ? buildCapabilitiesResponse(liveCapTools) :
      "The ERPBridge connection is currently unavailable. Check your ERP connection and try again when it is connected. No ERP tools or business operations were invoked.";
    const assistantMessage = await chatMutation((state) => {
      const chat = assertChatAuthority(state, user, sessionId);
      const message = { id: nextID(state, "msg"), role: "assistant", modelBinding: provider?.binding ?? null, text: capText, artifacts: { intent: "CAPABILITIES", capabilities: { offeredCount: liveCapTools.length, readOnlyCount: liveCapTools.filter(tool => tool.is_read_only).length } }, createdAt: now(), traceId };
      chat.messages.push(message); chat.messageCount = chat.messages.length; chat.updatedAt = now();
      return message;
    });
    return ok({ session: stored.session, userMessage: stored.userMessage, assistantMessage, answer: capText, intent }, "Message processed", null);
  }
  if ((intent === "QUERY" || intent === "AUDIT") && services.providerRuntime?.configured === true) {
    // Offer only registered, role-granted read contracts. Optional advisory
    // settings cannot broaden the dispatchable tool pool.
    let readOnlyTools: readonly import("../../registry/schemas.js").ToolDefinition[] = [];
    if (services.erpbridgeSession !== undefined) {
      readOnlyTools = (await discoverTools(services.erpbridgeSession, services.registries))
        .filter((tool) => tool.is_read_only && toolRoleAllowed(tool.allowed_roles, user.role));
    }
    if (services.erpbridgeSession && readOnlyTools.length === 0) return processMissingReadCapability(input, intent, chatMutation);
    const workspaceStatus = await services.repository.readAuthoritative(state => chatWorkspaceStatus(state, user, sessionId));
    const chatHistory = queryChatHistory(body, stored, policyCheck);
    let loopResult;
    try {
      loopResult = await runQueryLoop(
        { userMessage: content, chatHistory, workspaceStatus, sessionId, actorId: user.id, actorRole: user.role, ...(signal ? { signal } : {}), traceId, ...(hooks ? { onTurn: () => hooks.stage("MODEL") } : {}) },
        readOnlyTools,
        readTool,
        services.providerRuntime,
        true,
      );
    } catch (error) {
      throw new HandlerFailure(502, `Query agent failed: ${errorText(error)}`);
    }
    const { workflowDraft, artifacts: queryArtifacts, answerBinding } = queryChatPresentation(intent, content, provider?.binding ?? null, loopResult);
    const assistantMessage = await chatMutation((state) => {
      const chat = assertChatAuthority(state, user, sessionId);
      const message = { id: nextID(state, "msg"), role: "assistant", modelBinding: answerBinding, ...workspaceStatusAnswer(state, user, sessionId, loopResult.text, queryArtifacts), createdAt: now(), traceId };
      chat.messages.push(message); chat.messageCount = chat.messages.length; chat.updatedAt = now();
      return message;
    });
    return ok({
      session: stored.session,
      userMessage: stored.userMessage,
      assistantMessage,
      answer: assistantMessage.text,
      intent,
      sources: loopResult.toolCallLog,
      toolSteps: loopResult.toolSteps,
      ...(loopResult.visualisation !== undefined ? { visualisation: loopResult.visualisation } : {}),
      ...(workflowDraft !== undefined ? { workflowDraft } : {}),
      boundHit: loopResult.boundHit,
      modelBinding: answerBinding,
      usage: { inputTokens: loopResult.totalTokens.input, outputTokens: loopResult.totalTokens.output, measured: loopResult.totalTokens.measured === true },
    }, "Message processed", null);
  }
  if (intent === "TOOL_CALL" && services.erpbridgeSession !== undefined && services.providerRuntime?.configured === true) {
    const bridgeSession = services.erpbridgeSession;
    const allTools = await discoverTools(bridgeSession, services.registries);
    const workspaceStatus = await services.repository.readAuthoritative(state => chatWorkspaceStatus(state, user, sessionId));
    const chatHistory = augmentedPriorMessages.map((line) => {
      const sep = line.indexOf(": ");
      return sep > -1 ? { role: line.slice(0, sep), text: line.slice(sep + 2) } : { role: "user", text: line };
    });
    const governanceUser = { id: user.id, role: user.role, department: user.departmentId };
    let actionResult;
    try {
      actionResult = await runActionLoop(
        { userMessage: content, chatHistory, workspaceStatus, sessionId, actorId: user.id, actorRole: user.role, user: governanceUser, ...(signal ? { signal } : {}), traceId, ...(hooks ? { onTurn: () => hooks.stage("MODEL") } : {}) },
        allTools,
        readTool,
        // Required write authorization cannot be disabled by an advisory toggle.
        async (toolName, toolDef, args, govUser) => {
          if (directRagConfigured(services.config)) {
            const result = await checkDirectRagPolicy(services.config, { id: govUser.id, role: govUser.role }, {
              prompt: `User "${govUser.id}" (${govUser.role}) wants to execute: ${toolDef.display_name ?? toolName}`,
              action: toolName, context: { tool: toolName, arguments: args }, signal,
            });
            return { allowed: result.decision === "allow", decision: result.decision === "unavailable" ? "deny" as const : result.decision, reason: result.reason };
          }
          return checkErpPolicy(bridgeSession, {
                userId: govUser.id,
                userRole: govUser.role,
                action: toolName,
                prompt: `User "${govUser.id}" (${govUser.role}) wants to execute: ${toolDef.display_name ?? toolName}`,
                context: { tool: toolName, arguments: args },
              });
        },
        services.providerRuntime,
      );
    } catch (error) {
      throw new HandlerFailure(502, `Action agent failed: ${errorText(error)}`);
    }
    const actionArtifacts = {
      intent: "TOOL_CALL",
      steps: actionResult.steps,
      ...(actionResult.proposalCorrections?.length ? { proposalCorrections: actionResult.proposalCorrections } : {}),
      blocked: actionResult.blocked,
      ...(actionResult.modelRouting ? { modelRouting: actionResult.modelRouting } : {}),
      toolSteps: actionResult.steps.map((s) => ({ toolName: s.toolName, arguments: s.arguments, result: s.result })),
    };
    const answerBinding = provider?.binding ? { ...provider.binding, ...(actionResult.modelRouting ? { model: actionResult.modelRouting.model,
      requestedModel: actionResult.modelRouting.requestedModel, fallbackUsed: actionResult.modelRouting.fallbackUsed } : {}) } : null;
    const assistantMessage = await chatMutation((state) => {
      const chat = assertChatAuthority(state, user, sessionId);
      const message = { id: nextID(state, "msg"), role: "assistant", modelBinding: answerBinding, ...workspaceStatusAnswer(state, user, sessionId, actionResult.text, actionArtifacts), createdAt: now(), traceId };
      chat.messages.push(message); chat.messageCount = chat.messages.length; chat.updatedAt = now();
      return message;
    });
    return ok({
      session: stored.session,
      userMessage: stored.userMessage,
      assistantMessage,
      answer: assistantMessage.text,
      intent,
      steps: actionResult.steps,
      blocked: actionResult.blocked,
      modelBinding: answerBinding,
      usage: { inputTokens: actionResult.totalTokens.input, outputTokens: actionResult.totalTokens.output, measured: actionResult.totalTokens.measured === true },
    }, "Message processed", null);
  }

  if (intent !== "ACTION") {
    // Non-ACTION intents that reached here (e.g. TOOL_CALL with no bridge) — reply conversationally.
    const fallbackMessage = await chatMutation((state) => {
      const chat = assertChatAuthority(state, user, sessionId);
      const msg = {
        id: nextID(state, "msg"),
        role: "assistant",
        text: "I'm not sure how to help with that. Try asking me to list data from the ERP system, create a workflow, or describe what you need.",
        artifacts: { intent },
        createdAt: now(),
        traceId,
      };
      chat.messages.push(msg); chat.messageCount = chat.messages.length; chat.updatedAt = now();
      return msg;
    });
    return ok({ session: stored.session, userMessage: stored.userMessage, assistantMessage: fallbackMessage, answer: fallbackMessage.text, intent }, "Message processed", null);
  }

  if (services.synthesis === undefined) throw new HandlerFailure(502, "Chat orchestration is not configured");
  let liveToolsForSynthesis: readonly import("../../registry/schemas.js").ToolDefinition[];
  try { liveToolsForSynthesis = preGeneratedCandidate?.liveTools ?? await discoverTools(services.erpbridgeSession ?? null, services.registries); }
  catch (error) {
    if (automationRequest) return preserveRecurringShell(automationRequest, "CAPABILITY_DISCOVERY_UNAVAILABLE");
    throw error;
  }
  if (automationRequest && !hasRecurringCompositionCapability(automationRequest, liveToolsForSynthesis, user.role))
    return preserveRecurringShell(automationRequest, "NO_REVIEWED_COMPOSITION_CAPABILITY");
  if (!liveToolsForSynthesis.some(tool => toolRoleAllowed(tool.allowed_roles, user.role))) {
    const message = await chatMutation(state => {
      const chat = assertChatAuthority(state, user, sessionId);
      const value = { id: nextID(state, "msg"), role: "assistant", createdAt: now(), traceId,
        text: "I checked the current ERP tool connection before building. No reviewed tools are available for your role, so I have not generated or saved an unusable workflow. Check the ERP connection and reviewed tool access, then send this same request again. No ERP action was dispatched.",
        artifacts: { intent: "WORKFLOW_ERROR", code: "WORKFLOW_TOOLS_UNAVAILABLE", can_execute: false, toolsDispatched: false,
          ...(body.documentContext === undefined ? {} : { documentContext: body.documentContext }) } };
      chat.messages.push(value); chat.messageCount = chat.messages.length; chat.updatedAt = now(); return value;
    });
    return ok({ session: stored.session, userMessage: stored.userMessage, assistantMessage: message, answer: message.text, intent: "WORKFLOW_ERROR" }, "Tool preflight needs attention", null);
  }
  let result;
  await hooks?.stage("GENERATING");
  try { result = preGeneratedCandidate
    ? await services.synthesis.validateGeneratedCandidate({ ...preGeneratedCandidate.input, ...(provider === undefined ? {} : { providerRuntime: provider }) }, preGeneratedCandidate.prepared, preGeneratedCandidate.generated)
    : await services.synthesis.synthesize({ prompt: content, userRole: user.role, user: { id: user.id, role: user.role, department: user.departmentId }, ...(provider === undefined ? {} : { providerRuntime: provider }), priorMessages: augmentedPriorMessages,
    modelSourceContext: await reviewedModelSourceContext(services, user, liveToolsForSynthesis),
    ...(automationRequest ? { candidateContext: recurringAutomationCandidateContext(automationRequest),
      candidateValidator: (yaml: string) => { inspectRecurringAutomationCandidate(yaml, automationRequest, liveToolsForSynthesis, user.role); } } : {}),
    ...(signal ? { signal } : {}), traceId, sessionId: sessionId, messageId: stringValue(stored.userMessage.id), liveTools: liveToolsForSynthesis }); }
  catch (error) {
    if (automationRequest) return preserveRecurringShell(automationRequest, "COMPOSITION_UNAVAILABLE");
    const errText = errorText(error);
    const errorDetail = errText.split(":").at(-1)?.trim() || errText;
    const documentFailure = documentContext ? documentProposalFailure(body.documentContext) : null;
    const friendlyText = documentFailure?.text ?? (errText.includes("HTTP 400") || errText.includes("Generation attempt failed") || errText.includes("Candidate generation failed")
      ? "I wasn't able to generate a workflow for this request.\n\nThis usually happens when the request involves capabilities not available in this ERP system (e.g. tax verification, sanctions checking, email notifications), or when the AI model is temporarily unavailable.\n\nTry asking for a simpler workflow, or check **Capabilities** to see what this system supports."
      : `Unable to generate workflow — the generation service encountered an error. Please try again.\n\n_${errorDetail}_`);
    const errMessage = await chatMutation((state) => {
      const chat = assertChatAuthority(state, user, sessionId);
      const msg = { id: nextID(state, "msg"), role: "assistant", modelBinding: provider?.binding ?? null, text: friendlyText, artifacts: documentFailure?.artifacts ?? { intent: "WORKFLOW_ERROR" }, createdAt: now(), traceId };
      chat.messages.push(msg); chat.messageCount = chat.messages.length; chat.updatedAt = now();
      return msg;
    });
    return ok({ session: stored.session, userMessage: stored.userMessage, assistantMessage: errMessage, answer: friendlyText, intent: "WORKFLOW_ERROR" }, "Message processed", null);
  }
  const automationComposition: RecurringAutomationComposition | null = automationRequest ?
    inspectRecurringAutomationCandidate(result.yaml, automationRequest, liveToolsForSynthesis, user.role) : null;
  // Preserve the proposed program exactly. Unknown actions are reported, not
  // renamed by heuristics or silently removed along with their business intent.
  const liveToolNameSet = new Set(liveToolsForSynthesis.flatMap((tool) => [tool.name, tool.mcp_tool_name]));
  let missingTools: string[] = [];
  try {
    missingTools = parseWorkflowYAMLStrict(result.yaml).steps
      .filter((step) => (step.kind === undefined || step.kind === "" || step.kind === "tool") && !liveToolNameSet.has(step.action ?? ""))
      .map((step) => step.action ?? "");
  } catch { /* Invalid proposals remain visible as drafts, never published. */ }
  // Autosave a draft only. Verification and publication are separate actions.
  const chatSessionId = sessionId;
  const chatMessageId = stringValue(stored.userMessage.id);
  let autoSavedWorkflowId: string | null = null;
  let emptyProposal = false;
  // Build acceptance and runtime transaction checkpoints are separate. Saving
  // or accepting this draft never removes or authorizes runtime approval nodes.
  let pendingGenerationApproval: { steps: Array<{ stepId: string; description: string }>; requestedAt: string } | null = null;
  try {
    let blueprint;
    try { blueprint = parseWorkflowYAMLStrict(result.yaml); } catch { blueprint = null; }
    emptyProposal = blueprint !== null && blueprint.steps.length === 0;
    if (blueprint !== null && blueprint.steps.length > 0 && user.permissions.includes("workflow:write")) {
      const approvalSteps = blueprint.steps
        .filter((s) => s.kind === "approval")
        .map((s) => ({ stepId: s.id, description: (s.description ?? "").trim() || `Approval required for step ${s.id}` }));
      const nowTs = new Date().toISOString();
      if (approvalSteps.length > 0) pendingGenerationApproval = { steps: approvalSteps, requestedAt: nowTs };
      autoSavedWorkflowId = await chatMutation((state) => {
        assertChatAuthority(state, user, chatSessionId);
        state.counter += 1;
        const wfId = `wf_${state.counter}_${randomBytes(4).toString("hex")}`;
        const wf = {
          id: wfId,
          name: blueprint!.name || content.slice(0, 60) || "Generated Workflow",
          description: (blueprint as Record<string, unknown>).description as string ?? "",
          owner: { id: user.id, name: user.name },
          assignedUserIds: [],
          status: "PENDING",
          trigger: blueprint!.trigger,
          steps: blueprint!.steps.length,
          successRate: 0,
          lastRunAt: null,
          publishedVersion: 0,
          draftVersion: 1,
          tags: [],
          domainTags: [],
          canRun: false,
          createdAt: nowTs,
          updatedAt: nowTs,
          yaml: result.yaml,
          archived: false,
          chatSessionId,
          chatMessageId: stringValue(stored.userMessage.id),
          prompt: content,
          traceId,
          pendingGenerationApproval,
        };
        state.workflows[wfId] = wf as unknown as import("../../models/schemas.js").Workflow;
        hooks?.artifact(state, { type: "workflow-draft", id: wfId });
        return wfId;
      });
    }
  } catch (error) { if (error instanceof HandlerFailure) throw error; /* Other save failures remain explicit proposals. */ }

  // State claims come from persistence/validation, not an additional model.
  const assistantText = [
    autoSavedWorkflowId ? automationComposition ? "Recurring workflow steps saved as an editable draft. They have not been published, scheduled or executed." : "Workflow draft saved. It has not been published or executed." : "Workflow proposal prepared, but no saved draft was acknowledged.",
    result.validation.passed ? "Structural and registry validation passed; this is not execution readiness." : "Validation failed; review the reported issues before publishing.",
    emptyProposal ? "No executable tool steps were produced, so no empty workflow was saved. Resolve the missing capabilities or fields in chat before building it." : "",
    automationComposition ? `${automationComposition.mappedSteps.length} workflow step${automationComposition.mappedSteps.length === 1 ? " was" : "s were"} mapped. ${automationComposition.remainingRequirements.length} requirement${automationComposition.remainingRequirements.length === 1 ? " remains" : "s remain"}; no schedule is active.` : "",
    missingTools.length ? "Some requested actions have no admitted live ERPBridge contract. The original proposal was preserved." : "",
    pendingGenerationApproval ? "Build acceptance is pending. Runtime approval checkpoints remain required for each transaction." : "",
  ].filter(Boolean).join("\n\n");
  const artifacts = compactWorkflowArtifacts(result, chatSessionId, chatMessageId, traceId, autoSavedWorkflowId, missingTools, pendingGenerationApproval,
    automationRequest, automationComposition);
  const generatedModel = result.candidate.generation_metadata.model;
  const answerBinding = provider?.binding ? { ...provider.binding, model: generatedModel,
    ...(generatedModel !== provider.binding.model ? { requestedModel: provider.binding.model, fallbackUsed: true } : {}) } : null;
  const assistantMessage = await chatMutation((state) => {
    const chat = assertChatAuthority(state, user, sessionId);
    const message = { id: nextID(state, "msg"), role: "assistant", modelBinding: answerBinding, text: assistantText, artifacts, createdAt: now(), traceId };
    chat.messages.push(message); chat.messageCount = chat.messages.length; chat.updatedAt = now();
    return message;
  });
  const retrieval = result.retrieval as { tools?: unknown[]; rules?: unknown[]; global_rules?: unknown[] };
  return ok({
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
  }, "Message processed", null);
}
