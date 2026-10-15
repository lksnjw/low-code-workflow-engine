import { useRef, useState } from "react";
import { Icon } from "@iconify/react";

/*******************************************************************************
 * Function: ChatSessionItem
 *
 * Performs the Chat Session Item operation on session item for the ChatSessionItem module.
 ******************************************************************************/
function ChatSessionItem({ id, title, summary, active, onClick, onDelete, onRename, canManage = true }) {
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(title);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const pending = useRef(false), cancelled = useRef(false);

/*******************************************************************************
 * Function: commitRename
 *
 * Performs the commit Rename operation on rename for the ChatSessionItem module.
 ******************************************************************************/
  const commitRename = async () => {
    if (pending.current || cancelled.current) return;
    const trimmed = renameValue.trim();
    if (!trimmed || trimmed === title) { setRenaming(false); return; }
    pending.current = true; setBusy(true); setError("");
    try { await onRename?.(id, trimmed); setRenaming(false); }
    catch (failure) { setError(failure?.response?.data?.message || "Could not rename this conversation. Your entered title is kept; try again."); }
    finally { pending.current = false; setBusy(false); }
  };

  const remove = async () => {
    if (pending.current || !window.confirm(`Delete session "${title}"?`)) return;
    pending.current = true; setBusy(true); setError("");
    try { await onDelete?.(id); }
    catch (failure) { setError(failure?.response?.data?.message || "Could not delete this conversation. Reload history to confirm its saved state before trying again."); }
    finally { pending.current = false; setBusy(false); }
  };

/*******************************************************************************
 * Function: handleKeyDown
 *
 * Handles key down for the ChatSessionItem module.
 ******************************************************************************/
  const handleKeyDown = (e) => {
    if (e.key === "Enter") { e.preventDefault(); void commitRename(); }
    if (e.key === "Escape") {
      e.preventDefault(); cancelled.current = true;
      setRenameValue(title);
      setRenaming(false);
      setError("");
    }
  };

  if (renaming) {
    return (
      <div className="rounded-xl bg-primary/10 px-2 py-1.5">
        <input
          autoFocus
          aria-label="Conversation title"
          disabled={busy}
          aria-invalid={Boolean(error)}
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onBlur={commitRename}
          onKeyDown={handleKeyDown}
          className="w-full min-w-0 rounded bg-transparent text-xs font-semibold text-gray-900 outline-none focus-visible:ring-2 focus-visible:ring-primary dark:text-white"
        />
        <p className="mt-1 text-[10px] text-gray-500">{busy ? "Saving title…" : "Enter to save · Escape to cancel"}</p>
        {error && <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
      </div>
    );
  }

  return (
    <div
      className={`group relative flex items-center rounded-xl transition ${
        active
          ? "bg-primary text-white"
          : "bg-backgroundLight text-gray-600 hover:text-primary dark:bg-darkBackgroundVery dark:text-gray-300"
      }`}
    >
      <button
        type="button"
        onClick={onClick}
        className="min-w-0 flex-1 truncate px-3 py-2 text-left text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        title={title}
      >
        <span className="block truncate">{title}</span>
        {summary && <span className={`mt-1 block truncate text-[11px] font-normal ${active ? "text-white/80" : "text-gray-500 dark:text-gray-400"}`}>{summary}</span>}
      </button>
        {canManage && <div className="flex shrink-0 items-center gap-0.5 pr-1.5 opacity-0 focus-within:opacity-100 group-hover:opacity-100">
          <button
            type="button"
            title="Rename"
            disabled={busy}
            onClick={(e) => {
              e.stopPropagation();
              cancelled.current = false; setError(""); setRenameValue(title);
              setRenaming(true);
            }}
            className={`rounded p-1 transition ${
              active ? "hover:bg-white/20" : "hover:bg-gray-200 dark:hover:bg-gray-700"
            }`}
          >
            <Icon icon="mdi:pencil-outline" className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            title="Delete"
            disabled={busy}
            onClick={(e) => {
              e.stopPropagation();
              void remove();
            }}
            className={`rounded p-1 transition ${
              active ? "text-red-200 hover:bg-white/20" : "text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20"
            }`}
          >
            <Icon icon="mdi:trash-can-outline" className="h-3.5 w-3.5" />
          </button>
        </div>}
      {error && <p role="alert" className="absolute left-0 right-0 top-full z-10 mt-1 rounded-lg border border-red-200 bg-white p-2 text-xs text-red-600 shadow dark:border-red-900 dark:bg-gray-900 dark:text-red-400">{error}</p>}
    </div>
  );
}

export default ChatSessionItem;
