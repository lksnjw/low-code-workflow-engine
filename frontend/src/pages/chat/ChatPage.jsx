import { useCallback, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import ChatHistory from "../../components/chat/ChatHistory";
import ChatWindow from "../../components/chat/ChatWindow";
import ChatCreationState from "../../components/chat/ChatCreationState";
import WorkflowWorkspaceCanvas from "../../components/chat/WorkflowWorkspaceCanvas";
import ChatWorkspaceLayout from "../../components/chat/ChatWorkspaceLayout";
import { useAuthContext } from "../../context/AuthContext";
import { workspaceKey, writeWorkspaceValue } from "../../utils/workspaceSession";
import { useChat } from "../../hooks/useChat";
import { useChatSessions } from "../../hooks/useChatSessions";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { clearWorkflowForChatEdit, peekWorkflowForChatEdit } from "../../utils/workflowCanvas.utils";
import { prepareChatCreation, acknowledgeChatCreation } from "../../utils/chatCreation";
import { authorityScope, captureAuthority, isAuthorityCurrent } from "../../utils/authAuthority";
import { chatQueryKeys } from "../../utils/chatQueryKeys";

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
  const sessions = useChatSessions(sessionId);
  const chat = useChat(openingConversation ? "" : sessions.selectedSessionId);
  const { user } = useAuthContext();
  const queryClient = useQueryClient();
  const scope = authorityScope(user);
  // Keep same-authority profile refreshes from replacing workspace callbacks.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const authority = useMemo(() => captureAuthority(user), [scope]);
  const draftKey = workspaceKey(user, `draft.${sessions.selectedSessionId || "new"}`);
  const [pendingDraftKey, setPendingDraftKey] = useState(null);
  const composerKey = pendingDraftKey || draftKey;
  const [nodeContext, setNodeContext] = useState(null);
  const [handoffWorkflowContext] = useState(() => peekWorkflowForChatEdit());
  const requestedWorkflowId = searchParams.get("workflow") || "";
  // Keep only identity in the URL. Source and permissions are reloaded from
  // the backend after a refresh, including when another account opens a link.
  const initialWorkflowContext = showCanvas ? (/^[A-Za-z0-9_-]{1,128}$/.test(requestedWorkflowId) ? { workflowId: requestedWorkflowId } : handoffWorkflowContext) : null;
  const layoutRef = useRef(null);
  const firstCreationRef = useRef(null);
  const focusChat = useCallback(() => {
    layoutRef.current?.focusChat();
  }, []);
  const activeNodeContext = nodeContext?.sessionId === sessions.selectedSessionId ? nodeContext : null;
  const onNodeContext = useCallback(value => { if (isAuthorityCurrent(authority)) setNodeContext(value); }, [authority]);
  const openWorkflowInCanvas = useCallback(workflowId => {
    if (!isAuthorityCurrent(authority) || !/^[A-Za-z0-9_-]{1,128}$/.test(workflowId)) return;
    setNodeContext(null);
    const next = new URLSearchParams(searchParams); next.set("workflow", workflowId);
    navigate(`${sessionId ? `${routeBase}/${encodeURIComponent(sessionId)}` : routeBase}?${next.toString()}`);
  }, [authority, navigate, routeBase, sessionId, searchParams]);
  const onChatChanged = useCallback(async () => {
    if (!isAuthorityCurrent(authority)) return;
    await Promise.all([queryClient.invalidateQueries({ queryKey: chatQueryKeys.session(authority.scope, sessions.selectedSessionId) }), queryClient.invalidateQueries({ queryKey: chatQueryKeys.sessions(authority.scope) }), queryClient.invalidateQueries({ queryKey: ["workflows", authority.scope] })]);
  }, [authority, queryClient, sessions.selectedSessionId]);

  const handleCreateSession = async () => {
    if (!isAuthorityCurrent(authority)) return;
    navigate(`${routeBase}?new=1&creation=${crypto.randomUUID()}`);
  };

  const handleSelectSession = (selId) => {
    if (!isAuthorityCurrent(authority)) return;
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
      const editCtx = showCanvas ? peekWorkflowForChatEdit() : null;
      const sendOptions = editCtx?.yaml
        ? { ...options, workflowContext: { yaml: editCtx.yaml, name: editCtx.workflowName || "Workflow" } }
        : options;
      const result = await chat.send(text, sid, sendOptions);
      if (!isAuthorityCurrent(authority)) return null;
      if (result && isAuthorityCurrent(authority)) writeWorkspaceValue(workspaceKey(user, `draft.${sid}`), "");
      return result;
    } catch (error) {
      if (!isAuthorityCurrent(authority)) return null;
      throw error;
    } finally {
      if (creating && isAuthorityCurrent(authority)) setPendingDraftKey(null);
    }
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
          <p className="mt-1 text-xs leading-5 text-gray-500 dark:text-gray-400">Search and resolve indexed records through reviewed ERPBridge tools. File uploads remain in Files &amp; Documents.</p>
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
        />
      </details>
      </>}
      chat={<>
        <ChatWindow
          variant={showCanvas ? "workflow" : "indexed"}
          onChatChanged={onChatChanged}
          key={composerKey || sessions.selectedSessionId || "new"}
          draftStorageKey={composerKey}
          savedModel={chat.selectedModel}
          messages={chat.messages}
          onSend={handleSend}
          onRevise={handleRevise}
          loading={chat.loading}
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
          nodeContext={activeNodeContext}
          onClearNodeContext={() => activeNodeContext?.clear()}
        />
      </>}
      canvas={showCanvas && <>
        <WorkflowWorkspaceCanvas key={draftKey || sessions.selectedSessionId || "new"} messages={chat.messages} initialWorkflowContext={initialWorkflowContext} sessionId={sessions.selectedSessionId} actorId={user?.id} canEdit={user?.permissions?.includes("workflow:write")} canControl={user?.permissions?.some((key) => ["workflow:run", "workflow:run_own"].includes(key))} onChatChanged={onChatChanged} onNodeContext={onNodeContext} onFocusChat={focusChat} selectionStorageKey={workspaceKey(user, `canvas.${sessions.selectedSessionId || "new"}`)} />
      </>}
    />
  );
}

export default ChatPage;
