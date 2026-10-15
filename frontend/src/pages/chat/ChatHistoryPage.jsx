import { useNavigate } from "react-router-dom";
import ChatHistory from "../../components/chat/ChatHistory";
import { useChatSessions } from "../../hooks/useChatSessions";
import { useAuthContext } from "../../context/AuthContext";
import { authorityScope, captureAuthority, isAuthorityCurrent } from "../../utils/authAuthority";
import { useMemo } from "react";
import { clearWorkflowForChatEdit } from "../../utils/workflowCanvas.utils";

/*******************************************************************************
 * Function: ChatHistoryPage
 *
 * Performs the Chat History Page operation on history page for the ChatHistoryPage module.
 ******************************************************************************/
function ChatHistoryPage() {
  const navigate = useNavigate();
  const { user } = useAuthContext();
  const scope = authorityScope(user);
  // Keep same-authority profile refreshes from replacing route callbacks.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const authority = useMemo(() => captureAuthority(user), [scope]);
  const sessions = useChatSessions();

/*******************************************************************************
 * Function: createSession
 *
 * Creates session for the ChatHistoryPage module.
 ******************************************************************************/
  const createSession = async () => {
    if (!isAuthorityCurrent(authority)) return;
    clearWorkflowForChatEdit();
    let session;
    try { session = await sessions.createSession("Workflow conversation"); }
    catch (error) { if (!isAuthorityCurrent(authority)) return; throw error; }
    if (!isAuthorityCurrent(authority) || !session?.id) return;
    navigate(`/chat/${encodeURIComponent(session.id)}`);
  };

/*******************************************************************************
 * Function: openSession
 *
 * Performs the open Session operation on session for the ChatHistoryPage module.
 ******************************************************************************/
  const openSession = (sessionId) => {
    if (!isAuthorityCurrent(authority)) return;
    sessions.setSelectedSessionId(sessionId);
    navigate(`/chat/${encodeURIComponent(sessionId)}`);
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="page-heading text-gray-950 dark:text-white">Chat History</h1>
        <p className="mt-3 text-sm leading-6 text-gray-500 dark:text-gray-400">
          Find earlier conversations, reopen saved answers, or rename a chat.
        </p>
      </div>
      <ChatHistory
        sessions={sessions.sessions}
        activeSessionId={sessions.selectedSessionId}
        onSelect={openSession}
        onCreate={createSession}
        onDelete={sessions.deleteSession}
        onRename={sessions.renameSession}
        loading={sessions.loading}
        error={sessions.error}
        onRetry={sessions.reload}
        hasMore={sessions.hasMoreSessions} loadingMore={sessions.loadingMoreSessions} loadMoreError={sessions.loadMoreSessionsError} onLoadMore={sessions.loadMoreSessions} total={sessions.totalSessions}
      />
    </div>
  );
}

export default ChatHistoryPage;
