import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { chatService } from "../../services/chat.service";
import ChatHistory from "../../components/chat/ChatHistory";
import ChatWindow from "../../components/chat/ChatWindow";
import ChatCreationState from "../../components/chat/ChatCreationState";
import WorkflowWorkspaceCanvas from "../../components/chat/WorkflowWorkspaceCanvas";
import ChatWorkspaceLayout from "../../components/chat/ChatWorkspaceLayout";
import { useAuthContext } from "../../context/AuthContext";
import { workspaceKey, writeWorkspaceValue } from "../../utils/workspaceSession";
import { useChat } from "../../hooks/useChat";
import { useChatSessions } from "../../hooks/useChatSessions";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { clearWorkflowForChatEdit, peekWorkflowForChatEdit } from "../../utils/workflowCanvas.utils";
import { prepareChatCreation, acknowledgeChatCreation } from "../../utils/chatCreation";
import { authorityScope, captureAuthority, isAuthorityCurrent, staleAuthorityError } from "../../utils/authAuthority";
import { chatQueryKeys } from "../../utils/chatQueryKeys";
import { documentWorkspaceService } from "../../services/document-workspace.service";

/*******************************************************************************
 * Function: ChatPage
 *
 * Performs the Chat Page operation on page for the ChatPage module.
 ******************************************************************************/
function ChatPage({ routeBase = "/chat", historyPath = "/chat/history", workspaceLabel = "", showCanvas = true }) {
  const { user } = useAuthContext();
  return <ChatWorkspace key={`${authorityScope(user)}:${routeBase}`} routeBase={routeBase} historyPath={historyPath} workspaceLabel={workspaceLabel} showCanvas={showCanvas} />;
}

function ChatWorkspace({ routeBase, historyPath, workspaceLabel, showCanvas }) {
  const { sessionId = "" } = useParams();
  const [searchParams] = useSearchParams();
  const openingConversation = searchParams.get("new") === "1";
  const navigate = useNavigate();
  const location = useLocation();
  const sessions = useChatSessions(sessionId, { autoSelect: false });
  const chat = useChat(openingConversation ? "" : sessions.selectedSessionId);
  const { user } = useAuthContext();
  const queryClient = useQueryClient();
  const scope = authorityScope(user);
  // Keep same-authority profile refreshes from replacing workspace callbacks.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const authority = useMemo(() => captureAuthority(user), [scope]);
  const modelCatalog = useQuery({
    queryKey: ["chat-model-catalog", scope], staleTime: 60_000,
    enabled: Boolean(user && scope), retry: false,
    queryFn: async ({ signal }) => {
      const data = await chatService.models({ signal });
      if (!isAuthorityCurrent(authority)) throw staleAuthorityError();
      return data;
    },
  });
  const draftKey = workspaceKey(user, `draft.${sessions.selectedSessionId || "new"}`);
  const [pendingDraftKey, setPendingDraftKey] = useState(null);
  const composerKey = pendingDraftKey || draftKey;
  const [nodeContext, setNodeContext] = useState(null);
  const [canvasContext, setCanvasContext] = useState(null);
  const [canvasDismissed, setCanvasDismissed] = useState(false);
  const [handoffWorkflowContext, setHandoffWorkflowContext] = useState(() => peekWorkflowForChatEdit());
  const requestedWorkflowId = searchParams.get("workflow") || "";
  // Keep only identity in the URL. Source and permissions are reloaded from
  // the backend after a refresh, including when another account opens a link.
  const initialWorkflowContext = showCanvas ? (/^[A-Za-z0-9_-]{1,128}$/.test(requestedWorkflowId) ? { workflowId: requestedWorkflowId } : sessionId ? null : handoffWorkflowContext) : null;
  const layoutRef = useRef(null);
  const consumedRunHelp = useRef(null);
  const preparedAttachment = useRef(null);
  useEffect(() => {
    const help = location.state?.workflowRunHelp;
    if (!showCanvas || openingConversation || !layoutRef.current || !isAuthorityCurrent(authority) || !user?.permissions?.includes("chat:use") ||
        !help || typeof help.id !== "string" || consumedRunHelp.current === help.id || help.workflowId !== requestedWorkflowId ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(help.workflowId) || typeof help.text !== "string" || !help.text.trim() || help.text.length > 32000) return;
    consumedRunHelp.current = help.id;
    layoutRef.current.requestWorkflowHelp(help.workflowId, help.text);
  }, [location.state, showCanvas, openingConversation, authority, user?.permissions, requestedWorkflowId]);
  const firstCreationRef = useRef(null);
  const focusChat = useCallback(() => {
    layoutRef.current?.focusChat();
  }, []);
  const activeNodeContext = (!canvasDismissed || requestedWorkflowId) && nodeContext?.sessionId === sessions.selectedSessionId ? nodeContext : null;
  const onNodeContext = useCallback(value => { if (isAuthorityCurrent(authority)) setNodeContext(value); }, [authority]);
  const onWorkflowContext = useCallback(value => { if (isAuthorityCurrent(authority)) setCanvasContext(value); }, [authority]);
  const openWorkflowInCanvas = useCallback(workflowId => {
    if (!isAuthorityCurrent(authority) || !/^[A-Za-z0-9_-]{1,128}$/.test(workflowId)) return;
    setNodeContext(null);
    setCanvasDismissed(false);
    const next = new URLSearchParams(searchParams); next.set("workflow", workflowId);
    navigate(`${sessionId ? `${routeBase}/${encodeURIComponent(sessionId)}` : routeBase}?${next.toString()}`);
  }, [authority, navigate, routeBase, sessionId, searchParams]);
  const closeWorkflow = useCallback(() => {
    if (!isAuthorityCurrent(authority)) return;
    setCanvasDismissed(true); setNodeContext(null); setCanvasContext(null);
    clearWorkflowForChatEdit(); setHandoffWorkflowContext(null);
    const next = new URLSearchParams(searchParams); next.delete("workflow");
    navigate({ pathname: location.pathname, search: next.toString() ? `?${next}` : "" }, { replace: true, state: null });
    layoutRef.current?.continueChatOnly();
  }, [authority, searchParams, navigate, location.pathname]);
  const selectedWorkflowContext = (!canvasDismissed || requestedWorkflowId) && canvasContext?.sessionId === sessions.selectedSessionId ? canvasContext : null;
  const onChatChanged = useCallback(async () => {
    if (!isAuthorityCurrent(authority)) return;
    await Promise.all([queryClient.invalidateQueries({ queryKey: chatQueryKeys.session(authority.scope, sessions.selectedSessionId) }), queryClient.invalidateQueries({ queryKey: chatQueryKeys.sessions(authority.scope) }), queryClient.invalidateQueries({ queryKey: ["workflows", authority.scope] })]);
  }, [authority, queryClient, sessions.selectedSessionId]);

  const handleCreateSession = async () => {
    if (!isAuthorityCurrent(authority)) return;
    // A plain New conversation is not another Edit-in-chat handoff.
    clearWorkflowForChatEdit(); setHandoffWorkflowContext(null); setNodeContext(null); setCanvasContext(null); setCanvasDismissed(false);
    layoutRef.current?.continueChatOnly();
    navigate(`${routeBase}?new=1&creation=${crypto.randomUUID()}`);
  };

  const handleSelectSession = (selId) => {
    if (!isAuthorityCurrent(authority)) return;
    clearWorkflowForChatEdit(); setHandoffWorkflowContext(null); setNodeContext(null); setCanvasDismissed(false);
    sessions.setSelectedSessionId(selId);
    navigate(`${routeBase}/${encodeURIComponent(selId)}`);
  };

  const handleDeleteSession = async (delId) => {
    if (!isAuthorityCurrent(authority)) return;
    try { await sessions.deleteSession(delId); }
    catch (error) { if (!isAuthorityCurrent(authority)) return; throw error; }
    if (!isAuthorityCurrent(authority)) return;
    if (delId === sessionId) navigate(routeBase);
  };

  const handleSend = async (text, options = {}) => {
    if (!isAuthorityCurrent(authority)) return null;
    let sid = sessions.selectedSessionId;
    const creating = !sid;
    if (creating) setPendingDraftKey(draftKey);
    try {
      if (activeNodeContext?.unavailableReason) throw new Error(activeNodeContext.unavailableReason);
      if (activeNodeContext?.pending) throw new Error("Selected-node context is refreshing. Reload the workflow before sending.");
      if (activeNodeContext && sid) {
        const result = await chat.send(text, sid, { ...(options.model ? { model: options.model } : {}), nodeContext: {
          workflowId: activeNodeContext.workflowId, nodeId: activeNodeContext.nodeId,
          baseVersion: activeNodeContext.version, baseHash: activeNodeContext.contentHash,
        } });
        if (!isAuthorityCurrent(authority)) return null;
        if (result && isAuthorityCurrent(authority)) { writeWorkspaceValue(workspaceKey(user, `draft.${sid}`), ""); clearWorkflowForChatEdit(); }
        return result;
      }
      if (creating) {
        const creationKey = workspaceKey(user, "chat.firstMessageCreation");
        const creation = firstCreationRef.current?.storageKey === creationKey ? firstCreationRef.current.request
          : prepareChatCreation(creationKey, text.slice(0, 64) || "Workflow conversation");
        firstCreationRef.current = { storageKey: creationKey, request: creation };
        const session = await sessions.createSession(creation.title, { idempotencyKey: creation.idempotencyKey });
        if (!isAuthorityCurrent(authority)) return null;
        if (!session?.id) throw new Error("The new conversation was not confirmed. Retry to recover the same conversation.");
        acknowledgeChatCreation(creationKey, creation);
        firstCreationRef.current = null;
        sid = session.id;
        writeWorkspaceValue(workspaceKey(user, `draft.${sid}`), text);
        if (options.model) writeWorkspaceValue(`${workspaceKey(user, `draft.${sid}`)}.model`, options.model);
        navigate(`${routeBase}/${encodeURIComponent(sid)}`);
      }
      const editCtx = showCanvas && !sessionId ? handoffWorkflowContext : null;
      // Model previews are ordinary user-reviewed prompt text, never pipeline
      // evidence. Drop this presentation hint before HTTP admission and avoid
      // accidentally binding a new document request to an old canvas.
      const { modelPreviewRequest: previewRequest, attachment, ...requestOptions } = options;
      if (attachment) {
        if (!user.permissions?.includes("pipeline:upload")) throw new Error("Your role cannot upload documents.");
        const identity = JSON.stringify([sid, attachment.idempotencyKey, text, options.model]);
        if (preparedAttachment.current?.identity !== identity) {
          const prepared = await documentWorkspaceService.prepare(sid, attachment.file, { instruction: text, model: options.model, idempotencyKey: attachment.idempotencyKey });
          if (!isAuthorityCurrent(authority)) return null;
          if (!prepared?.attachmentTicket) throw new Error("Attachment preparation was not confirmed. Check its saved upload before retrying.");
          preparedAttachment.current = { identity, ticket: prepared.attachmentTicket };
        }
        requestOptions.attachmentTicket = preparedAttachment.current.ticket;
      }
      const documentRequest = Boolean(options.documentContext || previewRequest || attachment);
      if (!documentRequest && selectedWorkflowContext?.unavailableReason) throw new Error(selectedWorkflowContext.unavailableReason);
      if (!documentRequest && selectedWorkflowContext?.pending) throw new Error("The selected workflow is loading. Your draft is kept; wait for the canvas or reload it.");
      const sendOptions = !documentRequest && selectedWorkflowContext?.workflowId
        ? { ...requestOptions, workflowContext: { workflowId: selectedWorkflowContext.workflowId,
          baseVersion: selectedWorkflowContext.baseVersion, baseHash: selectedWorkflowContext.baseHash } }
        : !documentRequest && editCtx?.yaml
        ? { ...requestOptions, workflowContext: { yaml: editCtx.yaml, name: editCtx.workflowName || "Workflow" } }
        : requestOptions;
      const result = await chat.send(text, sid, sendOptions);
      if (!isAuthorityCurrent(authority)) return null;
      if (result && isAuthorityCurrent(authority)) { writeWorkspaceValue(workspaceKey(user, `draft.${sid}`), ""); if (attachment) preparedAttachment.current = null; }
      return result;
    } catch (error) {
      if (!isAuthorityCurrent(authority)) return null;
      throw error;
    } finally {
      if (creating && isAuthorityCurrent(authority)) setPendingDraftKey(null);
    }
  };

  const handleCreateDocumentChat = async () => {
    if (!isAuthorityCurrent(authority)) return;
    const creationKey = workspaceKey(user, "chat.firstMessageCreation");
    const creation = firstCreationRef.current?.request ?? prepareChatCreation(creationKey, "Document conversation");
    firstCreationRef.current = { storageKey: creationKey, request: creation };
    const session = await sessions.createSession(creation.title, { idempotencyKey: creation.idempotencyKey });
    if (!isAuthorityCurrent(authority)) return;
    if (!session?.id) throw new Error("The document conversation was not confirmed. Retry to recover it.");
    acknowledgeChatCreation(creationKey, creation); firstCreationRef.current = null;
    navigate(`${routeBase}/${encodeURIComponent(session.id)}`);
  };

  const handleRevise = async (message, text, options = {}) => {
    if (!isAuthorityCurrent(authority)) return null;
    const source = message.revisionSource, sid = sessions.selectedSessionId;
    if (!sid || source?.messageId !== message.id) throw new Error("Reload this saved conversation before revising.");
    // Use the ORIGINAL scope, never the currently selected canvas node or a
    // legacy Edit-in-Chat context. The backend authenticates and rechecks it.
    const result = await chat.send(text, sid, { ...options, requestRevision: { messageId: source.messageId, sourceHash: source.sourceHash },
      ...(source.nodeContext ? { nodeContext: source.nodeContext } : {}) });
    return isAuthorityCurrent(authority) ? result : null;
  };

  if (openingConversation) return <ChatCreationState
    key={`${user?.id || ""}:${searchParams.get("creation") || "handoff"}`}
    createSession={sessions.createSession}
    storageKey={workspaceKey(user, "chat.pendingCreation")}
    requestId={searchParams.get("creation") || ""}
    workflowId={initialWorkflowContext?.workflowId || ""}
    title={initialWorkflowContext ? `Edit: ${initialWorkflowContext.workflowName || "Workflow"}` : "New conversation"}
    routeBase={routeBase}
    historyPath={historyPath}
  />;

  return (
    <ChatWorkspaceLayout ref={layoutRef} showCanvas={showCanvas} onOpenWorkflow={openWorkflowInCanvas} storageKey={workspaceKey(user, `chat.layout.${routeBase}`)} tools={<>
      {workspaceLabel && (
        <div className="shrink-0 border-b border-primary/15 bg-primary/[0.04] px-4 py-3">
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-primary">{workspaceLabel}</p>
          <p className="mt-1 text-xs leading-5 text-gray-500 dark:text-gray-400">Upload and review documents in this conversation. Search confirmed content through the backend document library.</p>
        </div>
      )}
      <details className="shrink-0 border-b border-gray-200 px-4 py-2 text-xs dark:border-gray-700">
        <summary className="cursor-pointer text-gray-500">Chats · {sessions.sessions.length}</summary>
        <ChatHistory
          sessions={sessions.sessions}
          activeSessionId={sessions.selectedSessionId}
          onSelect={handleSelectSession}
          onCreate={handleCreateSession}
          onDelete={handleDeleteSession}
          onRename={sessions.renameSession}
          loading={sessions.loading}
          error={sessions.error}
          onRetry={sessions.reload}
          hasMore={sessions.hasMoreSessions} loadingMore={sessions.loadingMoreSessions} loadMoreError={sessions.loadMoreSessionsError} onLoadMore={sessions.loadMoreSessions} total={sessions.totalSessions}
        />
      </details>
      </>}
      chat={<>
        <ChatWindow
          modelCatalog={modelCatalog}
          documentSessionId={sessions.selectedSessionId}
          canUploadDocuments={!chat.readOnly && user?.permissions?.includes("pipeline:upload")}
          canAuthorWorkflows={showCanvas && !chat.readOnly && user?.permissions?.includes("workflow:write")}
          canManageErpAccess={user?.role === "Platform Admin" && user?.permissions?.includes("registry:write") === true}
          onCreateDocumentChat={handleCreateDocumentChat}
          variant={showCanvas ? "workflow" : "indexed"}
          onChatChanged={onChatChanged}
          key={composerKey || sessions.selectedSessionId || "new"}
          draftStorageKey={composerKey}
          savedModel={chat.selectedModel}
          messages={chat.messages}
          readOnly={chat.readOnly}
          unavailable={chat.accessDenied}
          onSend={handleSend}
          onRevise={handleRevise}
          loading={chat.loading}
          sessionLoading={chat.sessionLoading}
          sessionRefreshing={chat.sessionRefreshing}
          onReloadConversation={chat.reloadConversation}
          error={chat.error}
          operation={chat.operation}
          operationEvents={chat.operationEvents}
          operationError={chat.operationError}
          reconnecting={chat.reconnecting}
          onCancelOperation={chat.cancelOperation}
          cancelling={chat.cancelling}
          onRefreshOperation={chat.refreshOperation}
          hasMoreMessages={chat.hasMoreMessages}
          loadingMore={chat.loadingMore}
          onLoadMore={chat.loadMore}
          loadMoreError={chat.loadMoreError}
          totalMessages={chat.totalMessages}
          nodeContext={activeNodeContext}
          workflowContext={selectedWorkflowContext || initialWorkflowContext}
          onClearNodeContext={() => activeNodeContext?.clear()}
        />
      </>}
      canvas={showCanvas && <>
        <WorkflowWorkspaceCanvas key={draftKey || sessions.selectedSessionId || "new"} messages={chat.messages} workflowCatalog={chat.workflowCatalog} initialWorkflowContext={initialWorkflowContext} sessionId={sessions.selectedSessionId} actorId={user?.id} canEdit={!chat.readOnly && user?.permissions?.includes("workflow:write")} canControl={!chat.readOnly && user?.permissions?.some((key) => ["workflow:run", "workflow:run_own"].includes(key))} onChatChanged={onChatChanged} onNodeContext={onNodeContext} onWorkflowContext={onWorkflowContext} onFocusChat={focusChat} onCloseWorkflow={closeWorkflow} onStartNewWorkflow={handleCreateSession} selectionStorageKey={workspaceKey(user, `canvas.${sessions.selectedSessionId || "new"}`)} />
      </>}
    />
  );
}

export default ChatPage;
