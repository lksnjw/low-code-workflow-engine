import { useState } from "react";
import { Icon } from "@iconify/react";

/*******************************************************************************
 * Function: ChatSessionItem
 *
 * Performs the Chat Session Item operation on session item for the ChatSessionItem module.
 ******************************************************************************/
function ChatSessionItem({ id, title, active, onClick, onDelete, onRename }) {
  const [hovered, setHovered] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(title);

/*******************************************************************************
 * Function: commitRename
 *
 * Performs the commit Rename operation on rename for the ChatSessionItem module.
 ******************************************************************************/
  const commitRename = () => {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== title) {
      onRename?.(id, trimmed);
    }
    setRenaming(false);
  };

/*******************************************************************************
 * Function: handleKeyDown
 *
 * Handles key down for the ChatSessionItem module.
 ******************************************************************************/
  const handleKeyDown = (e) => {
    if (e.key === "Enter") commitRename();
    if (e.key === "Escape") {
      setRenameValue(title);
      setRenaming(false);
    }
  };

  if (renaming) {
    return (
      <div className="flex items-center gap-1 rounded-xl bg-primary/10 px-2 py-1.5">
        <input
          autoFocus
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onBlur={commitRename}
          onKeyDown={handleKeyDown}
          className="flex-1 rounded bg-transparent text-xs font-semibold text-gray-900 outline-none dark:text-white"
        />
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
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        type="button"
        onClick={onClick}
        className="flex-1 truncate px-3 py-2 text-left text-xs font-semibold"
        title={title}
      >
        {title}
      </button>
      {hovered && (
        <div className="flex shrink-0 items-center gap-0.5 pr-1.5">
          <button
            type="button"
            title="Rename"
            onClick={(e) => {
              e.stopPropagation();
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
            onClick={(e) => {
              e.stopPropagation();
              if (window.confirm(`Delete session "${title}"?`)) onDelete?.(id);
            }}
            className={`rounded p-1 transition ${
              active ? "text-red-200 hover:bg-white/20" : "text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20"
            }`}
          >
            <Icon icon="mdi:trash-can-outline" className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}

export default ChatSessionItem;
