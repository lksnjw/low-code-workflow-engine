import { useEffect, useRef, useState, useCallback } from "react";
import { Icon } from "@iconify/react";
import ChatMessage from "./ChatMessage";
import ChatWelcome from "./ChatWelcome";
import { settingsService } from "../../services/settings.service";
import { peekWorkflowForChatEdit, clearWorkflowForChatEdit } from "../../utils/workflowCanvas.utils";

/** Animated streaming-style thinking indicator */
/*******************************************************************************
 * Function: ThinkingIndicator
 *
 * Performs the Thinking Indicator operation on indicator for the ChatWindow module.
 ******************************************************************************/
function ThinkingIndicator() {
  return (
    <div className="flex flex-col items-start gap-1 pl-1">
      <div className="mb-0.5 flex items-center gap-1.5">
        <div className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/10">
          <Icon icon="hugeicons:ai-magic" className="h-3 w-3 text-primary" />
        </div>
        <span className="text-[10px] font-semibold text-gray-500 dark:text-gray-400">Workflow Assistant</span>
      </div>
      <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
        <span className="flex gap-0.5">
          {[0, 0.15, 0.3].map((delay, i) => (
            <span
              key={i}
              className="inline-block h-1.5 w-1.5 rounded-full bg-primary"
              style={{ animation: `pulse 1s ${delay}s infinite` }}
            />
          ))}
        </span>
        <span className="text-xs">Thinking…</span>
      </div>
    </div>
  );
}

/** Auto-resizing textarea */
/*******************************************************************************
 * Function: AutoResizeTextarea
 *
 * Performs the Auto Resize Textarea operation on resize textarea for the ChatWindow module.
 ******************************************************************************/
function AutoResizeTextarea({ value, onChange, onKeyDown, disabled, placeholder }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current) {
      ref.current.style.height = "auto";
      ref.current.style.height = `${Math.min(ref.current.scrollHeight, 200)}px`;
    }
  }, [value]);
  return (
    <textarea
      ref={ref}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
      disabled={disabled}
      placeholder={placeholder}
      rows={1}
      className="w-full resize-none bg-transparent text-sm text-gray-900 outline-none placeholder:text-gray-400 dark:text-gray-100 disabled:opacity-50"
      style={{ minHeight: "1.5rem", maxHeight: "200px", overflow: "hidden" }}
    />
  );
}

const QUICK_PROMPTS = [
  { icon: "mdi:invoice-text-outline", label: "Invoice exception workflow", text: "Build a workflow that monitors the ERP for invoice exceptions, routes amounts over $5,000 for approval, and auto-approves smaller ones." },
  { icon: "mdi:database-search-outline", label: "Query open POs", text: "Show me all open purchase orders from the ERP that are pending approval" },
  { icon: "mdi:robot-outline", label: "Self-healing retry", text: "Add a self-healing retry loop to the ERP connector that retries 3 times on failure, waits 30s between attempts, and escalates after all retries fail." },
  { icon: "mdi:account-check-outline", label: "Supplier onboarding", text: "Create a supplier onboarding workflow: verify tax ID, check sanctions list, then approve or reject with an email notification." },
];

/*******************************************************************************
 * Function: ChatWindow
 *
 * Performs the Chat Window operation on window for the ChatWindow module.
 ******************************************************************************/
function ChatWindow({ messages, onSend, loading, error, hasMoreMessages, loadingMore, onLoadMore }) {
  const [draft, setDraft] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  const [availableModels, setAvailableModels] = useState([]);
  const [editContext, setEditContext] = useState(() => peekWorkflowForChatEdit());
  const bottomRef = useRef(null);
  const inputRef = useRef(null);
  const scrollContainerRef = useRef(null);
  const lastMessageIdRef = useRef(null);

  useEffect(() => {
    settingsService.providers().then((providers) => {
      const active = Array.isArray(providers) ? providers.find((p) => p.active) ?? providers[0] : null;
      if (!active) return;
      const seen = new Set();
      const models = [
        active.model && { id: active.model, label: active.model },
        active.fallbackModel && active.fallbackModel !== active.model && { id: active.fallbackModel, label: `${active.fallbackModel} (fallback)` },
        ...(Array.isArray(active.additionalModels) ? active.additionalModels.map((id) => ({ id, label: id })) : []),
      ].filter((m) => m && m.id && !seen.has(m.id) && seen.add(m.id));
      setAvailableModels(models);
      setSelectedModel(active.model ?? "");
    }).catch(() => {});
  }, []);

  // Only auto-scroll to bottom when a message is actually appended (a new
  // send, or the last message changing) — never when older messages get
  // prepended by "Load earlier messages", which would otherwise yank the
  // view away from the history the user just asked to see.
  useEffect(() => {
    const lastId = messages[messages.length - 1]?.id ?? null;
    if (lastId !== lastMessageIdRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
      lastMessageIdRef.current = lastId;
    }
  }, [messages, loading]);

/*******************************************************************************
 * Function: handleLoadMore
 *
 * Loads the next-older page of messages while preserving the reader's
 * current scroll position (prepending content would otherwise shove
 * everything they were looking at further down the page).
 ******************************************************************************/
  const handleLoadMore = useCallback(async () => {
    const el = scrollContainerRef.current;
    const prevHeight = el?.scrollHeight ?? 0;
    await onLoadMore?.();
    requestAnimationFrame(() => {
      if (el) el.scrollTop += el.scrollHeight - prevHeight;
    });
  }, [onLoadMore]);

/*******************************************************************************
 * Function: handleSend
 *
 * Handles send for the ChatWindow module.
 ******************************************************************************/
  const handleSend = useCallback(async () => {
    const text = draft.trim();
    if (!text || loading) return;
    setDraft("");
    await onSend?.(text, { model: selectedModel || undefined });
    // refocus after send
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [draft, loading, onSend]);

/*******************************************************************************
 * Function: handleKeyDown
 *
 * Handles key down for the ChatWindow module.
 ******************************************************************************/
  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const isEmpty = messages.length === 0 && !loading;

  return (
    <section className="flex h-full flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-darkBackground">
      {/* ── Header ── */}
      <div className="flex items-center gap-3 border-b border-gray-100 px-4 py-3 dark:border-gray-800">
        <div className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/10">
          <Icon icon="hugeicons:ai-magic" className="h-4 w-4 text-primary" />
        </div>
        <div className="min-w-0">
          <h2 className="text-sm font-bold text-gray-950 dark:text-white">Workflow Assistant</h2>
          <p className="text-[10px] text-gray-400">Generate · Query · Validate · Execute</p>
        </div>
        <div className="ml-auto flex items-center gap-1.5 rounded-full border border-gray-200 px-2.5 py-1 dark:border-gray-700">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
          <span className="text-[10px] font-semibold text-gray-500 dark:text-gray-400">Ready</span>
        </div>
      </div>

      {/* ── Workflow edit context banner ── */}
      {editContext && (
        <div className="flex shrink-0 items-center gap-3 border-b border-indigo-100 bg-indigo-50 px-4 py-2.5 dark:border-indigo-900/40 dark:bg-indigo-900/20">
          <Icon icon="mdi:pencil-box-outline" className="h-4 w-4 shrink-0 text-indigo-600 dark:text-indigo-400" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold text-indigo-700 dark:text-indigo-300">
              Editing: <span className="font-bold">{editContext.workflowName || "Workflow"}</span>
            </p>
            <p className="text-[10px] text-indigo-500">Describe your changes — the AI will modify the workflow and save it.</p>
          </div>
          <button
            type="button"
            onClick={() => { clearWorkflowForChatEdit(); setEditContext(null); }}
            className="shrink-0 rounded p-1 text-indigo-400 hover:text-indigo-700 dark:hover:text-indigo-200"
            title="Dismiss"
          >
            <Icon icon="mdi:close" className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* ── Messages ── */}
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto max-w-3xl space-y-5">
          {isEmpty && <ChatWelcome onPrompt={setDraft} prompts={QUICK_PROMPTS} />}

          {hasMoreMessages && (
            <div className="flex justify-center">
              <button
                type="button"
                onClick={handleLoadMore}
                disabled={loadingMore}
                className="flex items-center gap-1.5 rounded-full border border-gray-200 px-3 py-1.5 text-xs font-semibold text-gray-500 transition hover:border-primary hover:text-primary disabled:opacity-50 dark:border-gray-700 dark:text-gray-400"
              >
                {loadingMore
                  ? <Icon icon="mdi:loading" className="h-3.5 w-3.5 animate-spin" />
                  : <Icon icon="mdi:chevron-up" className="h-3.5 w-3.5" />
                }
                {loadingMore ? "Loading…" : "Load earlier messages"}
              </button>
            </div>
          )}

          {messages.map((msg, idx) => (
            <ChatMessage key={msg.id ?? `${msg.role}-${idx}`} message={msg} />
          ))}

          {loading && <ThinkingIndicator />}

          {error && (
            <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800/40 dark:bg-red-900/20 dark:text-red-400">
              <Icon icon="mdi:alert-circle" className="mt-0.5 h-4 w-4 shrink-0" />
              {error}
            </div>
          )}

          <div ref={bottomRef} />
        </div>
      </div>

      {/* ── Input area ── */}
      <div className="shrink-0 border-t border-gray-100 p-4 dark:border-gray-800">
        <div className="mx-auto max-w-3xl">
          <div className={`rounded-2xl border bg-white px-4 py-3 transition dark:bg-darkBackgroundVery ${
            loading
              ? "border-gray-200 dark:border-gray-700"
              : "border-gray-300 shadow-sm focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/10 dark:border-gray-600"
          }`}>
            <div ref={inputRef} tabIndex={-1}>
              <AutoResizeTextarea
                value={draft}
                onChange={setDraft}
                onKeyDown={handleKeyDown}
                disabled={loading}
                placeholder="Describe a workflow, query ERP data, or ask anything… (Enter to send, Shift+Enter for newline)"
              />
            </div>
            <div className="mt-2 flex items-center justify-between gap-2">
              <div className="flex flex-wrap gap-1.5">
                {QUICK_PROMPTS.slice(0, 2).map((p) => (
                  <button
                    key={p.label}
                    type="button"
                    onClick={() => setDraft(p.text)}
                    disabled={loading}
                    className="flex items-center gap-1 rounded-full border border-gray-200 px-2.5 py-1 text-[10px] font-semibold text-gray-500 transition hover:border-primary hover:text-primary disabled:opacity-40 dark:border-gray-700 dark:text-gray-400"
                  >
                    <Icon icon={p.icon} className="h-3 w-3" />
                    {p.label}
                  </button>
                ))}
              </div>
              <div className="ml-auto flex items-center gap-2">
                {availableModels.length > 0 && (
                  <div className="flex items-center gap-1.5 rounded-full border border-gray-200 bg-gray-50 px-2.5 py-1 dark:border-gray-700 dark:bg-gray-800/60">
                    <Icon icon="mdi:chip" className="h-3 w-3 shrink-0 text-gray-400" />
                    <select
                      value={selectedModel}
                      onChange={(e) => setSelectedModel(e.target.value)}
                      disabled={loading}
                      className="bg-transparent text-[10px] font-semibold text-gray-600 outline-none disabled:opacity-50 dark:text-gray-300"
                    >
                      {availableModels.map((m) => (
                        <option key={m.id} value={m.id}>{m.label}</option>
                      ))}
                    </select>
                  </div>
                )}
                <button
                  type="button"
                  onClick={handleSend}
                  disabled={loading || !draft.trim()}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-primary text-white transition hover:bg-primary/90 disabled:opacity-40"
                >
                  {loading
                    ? <Icon icon="mdi:loading" className="h-4 w-4 animate-spin" />
                    : <Icon icon="mdi:send" className="h-4 w-4" />
                  }
                </button>
              </div>
            </div>
          </div>
          <p className="mt-1.5 text-center text-[10px] text-gray-400">
            Enter to send · Shift+Enter for newline · Workflows are validated against your policy registry
          </p>
        </div>
      </div>
    </section>
  );
}

export default ChatWindow;
