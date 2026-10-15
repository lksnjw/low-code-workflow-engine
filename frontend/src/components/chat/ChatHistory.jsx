import ChatSessionItem from "./ChatSessionItem";
import Button from "../shared/ui/Button";
import { Icon } from "@iconify/react";
import { useRef, useState } from "react";

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
  hasMore = false,
  loadingMore = false,
  loadMoreError = "",
  onLoadMore,
  total,
}) {
  const creating = useRef(false);
  const [createPending, setCreatePending] = useState(false), [createError, setCreateError] = useState("");
  const listChanged = !hasMore && Number.isInteger(total) && total > sessions.length;
  const create = async () => {
    if (creating.current) return;
    creating.current = true; setCreatePending(true); setCreateError("");
    try { await onCreate?.(); }
    catch (failure) { setCreateError(failure?.response?.data?.message || "Could not start a conversation. Try again; existing chats are unchanged."); }
    finally { creating.current = false; setCreatePending(false); }
  };
  return (
    <aside className="rounded-2xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-darkBackground">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-bold text-gray-950 dark:text-white">Sessions</h2>
        <button
          id="new-chat-session-btn"
          type="button"
          aria-label="New conversation"
          disabled={createPending}
          onClick={create}
          className="flex items-center gap-1 rounded-lg bg-primary/10 px-2.5 py-1.5 text-xs font-semibold text-primary transition hover:bg-primary/20 disabled:cursor-wait disabled:opacity-50"
        >
          <Icon icon="mdi:plus" className="h-3.5 w-3.5" />
          {createPending ? "Starting…" : "New"}
        </button>
      </div>
      {createError && <p role="alert" className="mt-3 text-xs text-red-600 dark:text-red-400">{createError}</p>}

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
              summary={session.summary}
              canManage={session.access?.canManage !== false}
              active={session.id === activeSessionId}
              onClick={() => onSelect?.(session.id)}
              onDelete={onDelete}
              onRename={onRename}
            />
          ))
        )}
      </div>
      {!loading && sessions.length > 0 && <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">Showing {sessions.length}{Number.isInteger(total) ? ` of ${Math.max(total, sessions.length)}` : ""} conversations{!hasMore && !listChanged ? " · All conversations loaded" : ""}</p>}
      {!loading && listChanged && <div role="status" className="mt-3 text-xs text-gray-500"><p>The conversation list changed while loading. Refresh it to load the remaining conversations.</p>{onRetry && <button type="button" onClick={onRetry} className="mt-2 font-semibold underline">Refresh conversation list</button>}</div>}
      {loadMoreError && <p role="alert" className="mt-3 text-xs text-red-600 dark:text-red-400">{loadMoreError}</p>}
      {hasMore && <Button className="mt-3" variant="secondary" disabled={loadingMore} onClick={onLoadMore}>{loadingMore ? "Loading older conversations…" : "Load older conversations"}</Button>}
    </aside>
  );
}

export default ChatHistory;
