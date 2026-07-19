import { useEffect, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import ChatInput from "./ChatInput";
import ChatMessage from "./ChatMessage";
import ChatToolbar from "./ChatToolbar";
import ChatWelcome from "./ChatWelcome";
import SuggestedPrompts from "./SuggestedPrompts";

/** Animated "thinking" dots shown while the backend processes. */
function TypingIndicator() {
  return (
    <div className="flex items-start">
      <div className="rounded-2xl bg-backgroundLight px-4 py-3 dark:bg-darkBackgroundVery">
        <div className="flex items-center gap-1.5">
          <Icon icon="hugeicons:ai-magic" className="h-4 w-4 text-primary" />
          <span className="text-xs font-semibold text-gray-500 dark:text-gray-400">
            The workflow provider is generating a workflow…
          </span>
          <span className="flex gap-0.5">
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className="inline-block h-1.5 w-1.5 rounded-full bg-primary opacity-70"
                style={{ animation: `bounce 1.2s ${i * 0.2}s infinite` }}
              />
            ))}
          </span>
        </div>
      </div>
    </div>
  );
}

function ChatWindow({ messages, onSend, loading, error }) {
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState("generate_workflow");
  const bottomRef = useRef(null);

  // Auto-scroll the messages area to bottom (not the page)
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  const handleSend = async () => {
    if (!draft.trim()) return;
    const text = draft.trim();
    setDraft("");
    await onSend?.(text, { mode });
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    /*
     * KEY FIX: use `h-full` (not min-h) so the section fills its grid cell
     * exactly. The messages div is `flex-1 overflow-y-auto` which scrolls
     * internally. The page itself never grows beyond the viewport.
     */
    <section className="flex h-full flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-darkBackground">
      <ChatToolbar
        mode={mode}
        onModeChange={setMode}
      />

      {/* Scrollable messages area — internal scroll only */}
      <div className="flex-1 overflow-y-auto p-4">
        <div className="space-y-4">
          {messages.length === 0 && !loading && <ChatWelcome />}

          {messages.map((message, index) => (
            <ChatMessage key={message.id ?? `${message.role}-${index}`} message={message} />
          ))}

          {loading && <TypingIndicator />}

          {error && (
            <div className="flex items-start gap-2 rounded-xl bg-red-50 p-3 dark:bg-red-900/20">
              <Icon icon="mdi:alert-circle" className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
              <p className="text-sm text-red-700 dark:text-red-400">{error}</p>
            </div>
          )}

          <div ref={bottomRef} />
        </div>
      </div>

      {/* Fixed footer — always visible */}
      <div className="shrink-0 space-y-3 border-t border-gray-200 p-4 dark:border-gray-800">
        <SuggestedPrompts onSelect={setDraft} />
        <ChatInput
          value={draft}
          onChange={setDraft}
          onSend={handleSend}
          onKeyDown={handleKeyDown}
          disabled={loading}
        />
      </div>
    </section>
  );
}

export default ChatWindow;
