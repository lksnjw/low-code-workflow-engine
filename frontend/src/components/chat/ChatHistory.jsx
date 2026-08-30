import ChatSessionItem from "./ChatSessionItem";
import Button from "../shared/ui/Button";
import { Icon } from "@iconify/react";

/*******************************************************************************
 * Function: ChatHistory
 *
 * Performs the Chat History operation on history for the ChatHistory module.
 ******************************************************************************/
function ChatHistory({
  sessions,
  activeSessionId,
  onSelect,
  onCreate,
  onDelete,
  onRename,
  loading,
  error,
  onRetry,
}) {
  return (
    <aside className="rounded-2xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-darkBackground">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-bold text-gray-950 dark:text-white">Sessions</h2>
        <button
          id="new-chat-session-btn"
          type="button"
          onClick={() => onCreate?.()}
          className="flex items-center gap-1 rounded-lg bg-primary/10 px-2.5 py-1.5 text-xs font-semibold text-primary transition hover:bg-primary/20"
        >
          <Icon icon="mdi:plus" className="h-3.5 w-3.5" />
          New
        </button>
      </div>

      {error ? (
        <div className="mt-3 rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-700">
          <p className="font-semibold">Could not load chat sessions.</p>
          {onRetry ? <button type="button" onClick={onRetry} className="mt-2 font-bold underline">Try again</button> : null}
        </div>
      ) : null}

      <div className="mt-4 space-y-1.5">
        {loading ? (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="h-8 animate-pulse rounded-xl bg-gray-100 dark:bg-darkBackgroundVery"
              />
            ))}
          </div>
        ) : sessions.length === 0 ? (
          <p className="py-4 text-center text-xs text-gray-400">
            No sessions yet. Start a conversation!
          </p>
        ) : (
          sessions.map((session) => (
            <ChatSessionItem
              key={session.id}
              id={session.id}
              title={session.title}
              active={session.id === activeSessionId}
              onClick={() => onSelect?.(session.id)}
              onDelete={onDelete}
              onRename={onRename}
            />
          ))
        )}
      </div>
    </aside>
  );
}

export default ChatHistory;
