import { useNavigate } from "react-router-dom";
import ChatHistory from "../../components/chat/ChatHistory";
import { useChatSessions } from "../../hooks/useChatSessions";

function ChatHistoryPage() {
  const navigate = useNavigate();
  const sessions = useChatSessions();

  const createSession = async () => {
    const session = await sessions.createSession("Workflow conversation");
    navigate(`/chat/${encodeURIComponent(session.id)}`);
  };

  const openSession = (sessionId) => {
    sessions.setSelectedSessionId(sessionId);
    navigate(`/chat/${encodeURIComponent(sessionId)}`);
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="page-heading text-gray-950 dark:text-white">Chat History</h1>
        <p className="mt-3 text-sm leading-6 text-gray-500 dark:text-gray-400">
          Open, rename, or remove persisted workflow synthesis conversations.
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
      />
    </div>
  );
}

export default ChatHistoryPage;
