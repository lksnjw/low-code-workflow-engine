import { useState } from "react";
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

  const [showArtifact, setShowArtifact] = useState(true);

  const handleCreateSession = async () => {
    const session = await sessions.createSession("Workflow conversation");
    navigate(`/chat/${encodeURIComponent(session.id)}`);
  };

  const handleSelectSession = (selId) => {
    sessions.setSelectedSessionId(selId);
    navigate(`/chat/${encodeURIComponent(selId)}`);
  };

  const handleDeleteSession = async (delId) => {
    await sessions.deleteSession(delId);
    if (delId === sessionId) navigate("/chat");
  };

  const handleSend = async (text, options = {}) => {
    let sid = sessions.selectedSessionId;
    if (!sid) {
      const session = await sessions.createSession(text.slice(0, 64) || "Workflow conversation");
      sid = session.id;
      navigate(`/chat/${encodeURIComponent(sid)}`);
    }
    return chat.send(text, sid, options);
  };

  return (
    <div className="flex h-full overflow-hidden">
      {/* Session sidebar */}
      <div className="w-52 flex-shrink-0 overflow-y-auto border-r border-gray-200 dark:border-gray-700">
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

      {/* Chat window */}
      <div className="flex min-w-0 flex-1 flex-col">
        <ChatWindow
          messages={chat.messages}
          onSend={handleSend}
          loading={chat.loading}
          error={chat.error}
        />
      </div>

      {/* Artifact panel — only for workflow generation responses */}
      {showArtifact && chat.artifact?.intent === "WORKFLOW" && (
        <div className="w-80 flex-shrink-0 border-l border-gray-200 dark:border-gray-700 overflow-y-auto bg-white dark:bg-darkBackground">
          <div className="p-3">
            <ChatArtifactPanel artifact={chat.artifact} />
          </div>
        </div>
      )}
    </div>
  );
}

export default ChatPage;
