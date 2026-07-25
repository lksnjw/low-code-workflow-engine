import ChatHistory from "../../components/chat/ChatHistory";
import ChatWindow from "../../components/chat/ChatWindow";
import ChatArtifactPanel from "../../components/chat/ChatArtifactPanel";
import { useChat } from "../../hooks/useChat";
import { useChatSessions } from "../../hooks/useChatSessions";
import { useNavigate, useParams } from "react-router-dom";

function ChatPage() {
  const { sessionId = "" } = useParams();
  const navigate = useNavigate();
  const sessions = useChatSessions(sessionId);
  const chat = useChat(sessions.selectedSessionId);

  const handleCreateSession = async () => {
    const session = await sessions.createSession("Workflow conversation");
    navigate(`/chat/${encodeURIComponent(session.id)}`);
  };

  const handleSelectSession = (selectedSessionId) => {
    sessions.setSelectedSessionId(selectedSessionId);
    navigate(`/chat/${encodeURIComponent(selectedSessionId)}`);
  };

  const handleDeleteSession = async (deletedSessionId) => {
    await sessions.deleteSession(deletedSessionId);
    if (deletedSessionId === sessionId) navigate("/chat");
  };

  // options = { model, mode } forwarded from ChatWindow's toolbar
  const handleSend = async (text, options = {}) => {
    let sessionId = sessions.selectedSessionId;
    if (!sessionId) {
      const session = await sessions.createSession(
        text.slice(0, 64) || "Workflow conversation"
      );
      sessionId = session.id;
      navigate(`/chat/${encodeURIComponent(sessionId)}`);
    }
    return chat.send(text, sessionId, options);
  };

  return (
    /*
     * h-full fills the <main> container from AppLayout.
     * Each column is also h-full so children can be flex-col with internal scroll.
     */
    <div className="grid h-full gap-4 xl:grid-cols-[240px_minmax(0,1fr)_320px]">
      {/* ── Session sidebar ── */}
      <div className="overflow-y-auto">
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
      </div>

      {/* ── Main chat — fills height, internal scroll ── */}
      <ChatWindow
        messages={chat.messages}
        onSend={handleSend}
        loading={chat.loading}
        error={chat.error}
      />

      {/* ── Rich artifact panel — independent scroll ── */}
      <div className="overflow-y-auto">
        <ChatArtifactPanel artifact={chat.artifact} />
      </div>
    </div>
  );
}

export default ChatPage;
