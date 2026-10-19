import { useEffect, useLayoutEffect, useRef, useState, useCallback } from "react";
import { Icon } from "@iconify/react";
import ChatMessage from "./ChatMessage";
import ChatWelcome from "./ChatWelcome";
import ChatOperationProgress from "./ChatOperationProgress";
import ChatAttachments from "./ChatAttachments";
import { chatService } from "../../services/chat.service";
import { readWorkspaceValue, writeWorkspaceValue } from "../../utils/workspaceSession";
import { clearWorkflowForChatEdit } from "../../utils/workflowCanvas.utils";
import { createPortal } from "react-dom";
import { useChatWorkspace } from "./ChatWorkspaceContext";
import { documentWorkflowRequest, modelPreviewRequest } from "./documentWorkflowRequest";

/** Animated streaming-style thinking indicator */
/*******************************************************************************
 * Function: ThinkingIndicator
 *
 * Performs the Thinking Indicator operation on indicator for the ChatWindow module.
 ******************************************************************************/
function ThinkingIndicator() {
  return (
    <div role="status" aria-live="polite" aria-label="Thinking…" className="rounded-xl border border-primary/20 bg-primary/[0.035] p-3.5 dark:border-primary/25 dark:bg-primary/[0.06]">
      <div className="flex items-start gap-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10">
          <Icon icon="hugeicons:ai-magic" className="h-4 w-4 animate-pulse text-primary" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold text-gray-950 dark:text-white">Thinking…</p>
          <p className="mt-0.5 text-[11px] text-gray-600 dark:text-gray-300">Sending your request securely…</p>
          <div className="mt-3 grid grid-cols-4 gap-1" aria-hidden="true">
            {["Request", "Checks", "Work", "Answer"].map((label, index) => <div key={label} className="min-w-0">
              <div className={`h-1 rounded-full ${index === 0 ? "animate-pulse bg-primary" : "bg-gray-200 dark:bg-gray-700"}`} />
              <span className={`mt-1 block truncate text-[10px] ${index === 0 ? "font-semibold text-primary" : "text-gray-500 dark:text-gray-400"}`}>{label}</span>
            </div>)}
          </div>
        </div>
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
      aria-label="Message to workflow assistant"
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
  { icon: "mdi:invoice-text-outline", label: "Daily invoice report", text: "Draft a daily invoice and order report for my manager. Identify the ERP tools, delivery channel, recipient and timezone needed, and ask me for any missing details before execution." },
  { icon: "mdi:database-search-outline", label: "Query open POs", text: "Show me all open purchase orders from the ERP that are pending approval" },
  { icon: "mdi:robot-outline", label: "Review failure handling", text: "Review this workflow's failure handling. Identify which operations are safe to retry and which require reconciliation or human approval. Do not execute it." },
  { icon: "mdi:account-check-outline", label: "Supplier onboarding draft", text: "Draft a supplier onboarding workflow using available ERP tools. Identify unsupported capabilities and required approvals; do not execute it." },
];
const INDEXED_PROMPTS = [
  { icon: "mdi:account-search-outline", label: "Find a document", text: "Find the indexed documents for a person. Ask for the source system, entity and exact ID or person name if missing. Return only details supported by the retrieved text." },
  { icon: "mdi:file-search-outline", label: "Search stored text", text: "Search my saved document text and show the matching details. Ask me which person or document if the request is ambiguous." },
];

/*******************************************************************************
 * Function: ChatWindow
 *
 * Performs the Chat Window operation on window for the ChatWindow module.
 ******************************************************************************/
function ChatWindow({ messages, onSend, onRevise, loading, readOnly = false, unavailable = false, sessionLoading = false, sessionRefreshing = false, onReloadConversation, error, hasMoreMessages, loadingMore, onLoadMore, loadMoreError, totalMessages, draftStorageKey, savedModel, modelCatalog, nodeContext, workflowContext = null, onClearNodeContext, onChatChanged, operation, operationEvents, operationError, reconnecting, onCancelOperation, cancelling, onRefreshOperation, variant = "workflow", documentSessionId, canUploadDocuments = false, canAuthorWorkflows = false, onCreateDocumentChat, canManageErpAccess = false }) {
  const workspace = useChatWorkspace();
  const inTools = (content, key) => workspace ? workspace.toolsHost ? createPortal(content, workspace.toolsHost, key) : null : content;
  const indexed = variant === "indexed";
  const quickPrompts = indexed ? INDEXED_PROMPTS : QUICK_PROMPTS;
  const [draft, setDraft] = useState(() => readWorkspaceValue(draftStorageKey));
  const [sendError, setSendError] = useState("");
  const [documentContext, setDocumentContext] = useState(null);
  const [usingModelPreview, setUsingModelPreview] = useState(false);
  const [documentOpenRequest, setDocumentOpenRequest] = useState(0);
  const [attachment, setAttachment] = useState(null);
  const [attachmentProgress, setAttachmentProgress] = useState("");
  const attachmentPicker = useRef(null);
  const attachmentScope = useRef(draftStorageKey);
  useEffect(() => { attachmentScope.current = draftStorageKey; setAttachment(null); setAttachmentProgress(""); }, [draftStorageKey]);
  const [submitting, setSubmitting] = useState(false);
  const submissionPending = useRef(false);
  const busy = loading || submitting || sessionLoading;
  const scopePending = Boolean(nodeContext?.pending || nodeContext?.unavailableReason);
  const handledComposerRequest = useRef(null);
  const composerRequest = workspace?.composerRequest;
  useEffect(() => {
    if (!composerRequest || handledComposerRequest.current === composerRequest.id || busy || readOnly || unavailable || nodeContext || workflowContext?.pending || workflowContext?.unavailableReason || workflowContext?.workflowId !== composerRequest.workflowId) return;
    handledComposerRequest.current = composerRequest.id;
    setDraft(current => [current.trim(), composerRequest.text].filter(Boolean).join("\n\n"));
    setDocumentContext(null); setUsingModelPreview(false); setDismissedContextKey(undefined);
    workspace.acknowledgeComposerRequest?.(composerRequest.id);
    workspace.focusChat?.();
  }, [composerRequest, workspace, busy, readOnly, unavailable, nodeContext, workflowContext]);
  useEffect(() => { writeWorkspaceValue(draftStorageKey, draft); }, [draftStorageKey, draft]);
  const modelStorageKey = draftStorageKey ? `${draftStorageKey}.model` : undefined;
  const [selectedModel, setSelectedModel] = useState(() => readWorkspaceValue(modelStorageKey) || savedModel || "");
  const [availableModels, setAvailableModels] = useState([]);
  const [modelError, setModelError] = useState("");
  const [catalogRetry, setCatalogRetry] = useState(0);
  const catalogKey = JSON.stringify([modelStorageKey, savedModel, catalogRetry]);
  const [settledCatalogKey, setSettledCatalogKey] = useState("");
  const modelsLoading = modelCatalog ? modelCatalog.isPending || modelCatalog.isFetching : settledCatalogKey !== catalogKey;
  const cachedCatalog = modelCatalog?.data, catalogError = modelCatalog?.error, hasCatalogQuery = Boolean(modelCatalog);
  const reloadModels = () => modelCatalog ? void modelCatalog.refetch() : setCatalogRetry(value => value + 1);
  const modelChosenByUser = useRef(false);
  const contextKey = workflowContext ? workflowContext.workflowId || workflowContext.workflowName || "workflow" : null;
  const [dismissedContextKey, setDismissedContextKey] = useState(undefined);
  const editContext = indexed || dismissedContextKey === contextKey ? null : workflowContext;
  const bottomRef = useRef(null);
  const inputRef = useRef(null);
  const scrollContainerRef = useRef(null);
  const lastMessageIdRef = useRef(null);
  const olderPending = useRef(false), lastScrollTop = useRef(0);
  const olderViewport = useRef(null);
  useLayoutEffect(() => {
    const saved = olderViewport.current, el = scrollContainerRef.current;
    if (saved && el && messages[0]?.id !== saved.oldestId) {
      el.scrollTop = saved.top + el.scrollHeight - saved.height;
      lastScrollTop.current = el.scrollTop;
      olderViewport.current = null;
    }
  }, [messages]);

  useEffect(() => {
    let current = true;
    if (hasCatalogQuery) {
      if (cachedCatalog && !catalogError) {
        setAvailableModels((Array.isArray(cachedCatalog.models) ? cachedCatalog.models : []).map(id => ({ id, label: id })));
        setSelectedModel(currentModel => modelChosenByUser.current ? currentModel : readWorkspaceValue(modelStorageKey) || savedModel || cachedCatalog.binding?.model || "");
        setModelError(cachedCatalog.configured ? "" : "No model provider is configured.");
      } else if (catalogError) { setAvailableModels([]); setModelError("Could not load configured models. Your draft is kept."); }
      return undefined;
    }
    chatService.models().then((catalog) => {
      if (!current) return;
      const models = (Array.isArray(catalog.models) ? catalog.models : []).map((id) => ({ id, label: id }));
      setAvailableModels(models);
      setSelectedModel((currentModel) => modelChosenByUser.current ? currentModel : readWorkspaceValue(modelStorageKey) || savedModel || catalog.binding?.model || "");
      setModelError(catalog.configured ? "" : "No model provider is configured.");
      setSettledCatalogKey(catalogKey);
    }).catch(() => { if (current) { setAvailableModels([]); setModelError("Could not load configured models. Your draft is kept."); setSettledCatalogKey(catalogKey); } });
    return () => { current = false; };
  }, [savedModel, modelStorageKey, catalogRetry, catalogKey, cachedCatalog, catalogError, hasCatalogQuery]);
  // Store explicit user intent only. An automatically displayed default must
  // not overwrite a late saved-session binding or an unsent model choice.

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
    if (olderPending.current || loadingMore || !hasMoreMessages || !onLoadMore) return;
    olderPending.current = true;
    const el = scrollContainerRef.current;
    olderViewport.current = { height: el?.scrollHeight ?? 0, top: el?.scrollTop ?? 0, oldestId: messages[0]?.id };
    try {
      await onLoadMore();
    } catch { /* The hook reports a visible pagination error; never replay automatically. */ }
    finally { olderPending.current = false; }
  }, [onLoadMore, loadingMore, hasMoreMessages, messages]);
  const handleHistoryScroll = event => {
    const top = event.currentTarget.scrollTop, movingUp = top < lastScrollTop.current;
    lastScrollTop.current = top;
    if (movingUp && top <= 24 && !loadMoreError) void handleLoadMore();
  };

/*******************************************************************************
 * Function: handleSend
 *
 * Handles send for the ChatWindow module.
 ******************************************************************************/
  const handleSend = useCallback(async () => {
    const text = draft.trim();
    if (!text || readOnly || unavailable || loading || submitting || submissionPending.current || sessionLoading || modelsLoading || scopePending) return;
    submissionPending.current = true;
    setSubmitting(true);
    setSendError("");
    try {
      const originScope = draftStorageKey;
      if (attachment) setAttachmentProgress("Reading attachment and checking pipeline storage…");
      const result = await onSend?.(text, { model: selectedModel || undefined, ...(attachment && !nodeContext ? { attachment } : {}), ...(!attachment && documentContext && !nodeContext ? { documentContext } : {}), ...(usingModelPreview && !attachment ? { modelPreviewRequest: true } : {}) });
      if (attachmentScope.current !== originScope) return;
      if (result) {
        setDraft("");
        setDocumentContext(null);
        setUsingModelPreview(false);
        setAttachment(null);
        writeWorkspaceValue(draftStorageKey, "");
        if (nodeContext) { clearWorkflowForChatEdit(); setDismissedContextKey(contextKey); }
      }
    } catch (cause) {
      setSendError(`${cause?.response?.data?.message || "Could not send the message."} Your draft has been kept. Reload the workflow if the selected revision changed.`);
    } finally {
      submissionPending.current = false;
      setSubmitting(false);
      setAttachmentProgress("");
    }
    // refocus after send
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [draft, readOnly, unavailable, loading, submitting, sessionLoading, modelsLoading, scopePending, onSend, selectedModel, draftStorageKey, nodeContext, documentContext, contextKey, usingModelPreview, attachment]);

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

  const isEmpty = messages.length === 0 && !busy;

  return (
    <section aria-label="Workflow chat" aria-busy={Boolean(busy)} className="flex h-full min-h-0 flex-col overflow-hidden bg-white dark:bg-darkBackground">
      {/* ── Header ── */}
      <div hidden={workspace?.fullScreen} className={workspace?.fullScreen ? "hidden" : "flex shrink-0 items-center gap-3 border-b border-gray-100 px-4 py-3 dark:border-gray-800"}>
        <div className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/10">
          <Icon icon="hugeicons:ai-magic" className="h-4 w-4 text-primary" />
        </div>
        <div className="min-w-0">
          <h2 className="text-sm font-bold text-gray-950 dark:text-white">{indexed ? "Indexed data assistant" : "Workflow assistant"}</h2>
          <p className="text-[11px] text-gray-500 dark:text-gray-400">{indexed ? "Retrieves your permitted documents through the backend" : "Plans, checks, and uses approved tools"}</p>
        </div>
        <div className="ml-auto flex items-center gap-1.5 rounded-full border border-gray-200 px-2.5 py-1 dark:border-gray-700">
          <span className={`h-1.5 w-1.5 rounded-full ${busy ? "animate-pulse bg-primary" : "bg-emerald-500"}`} />
          <span className="text-[10px] font-semibold text-gray-500 dark:text-gray-400">{unavailable ? "Unavailable" : readOnly ? "Review only" : busy ? "Working" : "Ready"}</span>
        </div>
      </div>

      {nodeContext && <div aria-label="Chat node editing context" className="flex shrink-0 items-center gap-3 border-b border-primary/20 bg-primary/5 px-4 py-3">
        <div className="min-w-0 flex-1"><p className="text-xs font-semibold">Selected node · {nodeContext.nodeId}</p><p className="mt-1 text-[10px] text-gray-500">{nodeContext.label} · {nodeContext.version ? `draft v${nodeContext.version}` : "saved revision loading"}. Ask about this node or propose a scoped change. Changes still need review.</p></div>
        <button type="button" aria-label="Exit node editing" onClick={onClearNodeContext} disabled={busy} className="rounded p-1 text-gray-500"><Icon icon="lucide:x" /></button>
      </div>}

      {scopePending && <p role="status" className="shrink-0 px-4 py-2 text-xs text-gray-500">{nodeContext?.unavailableReason || "Refreshing selected-node context. Your text is kept; reload the workflow if this does not finish. No unscoped request will be sent."}</p>}

      {/* ── Workflow edit context banner ── */}
      {editContext && !nodeContext && (
        <div className="flex shrink-0 items-center gap-3 border-b border-indigo-100 bg-indigo-50 px-4 py-2.5 dark:border-indigo-900/40 dark:bg-indigo-900/20">
          <Icon icon="mdi:pencil-box-outline" className="h-4 w-4 shrink-0 text-indigo-600 dark:text-indigo-400" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold text-indigo-700 dark:text-indigo-300">
              Workflow context: <span className="font-bold">{editContext.workflowName || "Workflow"}</span>
            </p>
            <p className="text-[10px] text-indigo-500">Ask about this workflow or request changes. Questions do not run it; proposed changes still need review.</p>
          </div>
          <button
            type="button"
            onClick={() => { clearWorkflowForChatEdit(); setDismissedContextKey(contextKey); }}
            className="shrink-0 rounded p-1 text-indigo-400 hover:text-indigo-700 dark:hover:text-indigo-200"
            title="Dismiss"
          >
            <Icon icon="mdi:close" className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* ── Messages ── */}
      <div ref={scrollContainerRef} role="region" aria-label="Conversation messages" onScroll={handleHistoryScroll} style={{ overflowAnchor: "none" }} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className={`mx-auto space-y-5 ${workspace?.fullScreen ? "max-w-5xl" : "max-w-3xl"}`}>
          {sessionLoading && <div role="status" aria-live="polite" className="flex items-center gap-2 py-8 text-sm text-gray-500"><Icon icon="mdi:loading" className="h-4 w-4 animate-spin" />Loading this conversation… Your draft is kept.</div>}
          {sessionRefreshing && !sessionLoading && <p role="status" className="text-xs text-gray-500">Refreshing saved messages…</p>}
          {isEmpty && !sessionLoading && !error && <ChatWelcome onPrompt={setDraft} prompts={quickPrompts} variant={variant} />}

          {hasMoreMessages && (
            <div className="space-y-2 text-center">
              <p className="text-[11px] text-gray-500 dark:text-gray-400">Showing {messages.length}{Number.isInteger(totalMessages) ? ` of ${totalMessages}` : ""} messages · Scroll to the top to load earlier messages.</p>
              <button
                type="button"
                onClick={handleLoadMore}
                disabled={loadingMore}
                className="mx-auto flex items-center gap-1.5 rounded-full border border-gray-200 px-3 py-1.5 text-xs font-semibold text-gray-500 transition hover:border-primary hover:text-primary disabled:opacity-50 dark:border-gray-700 dark:text-gray-400"
              >
                {loadingMore
                  ? <Icon icon="mdi:loading" className="h-3.5 w-3.5 animate-spin" />
                  : <Icon icon="mdi:chevron-up" className="h-3.5 w-3.5" />
                }
                {loadingMore ? "Loading…" : "Load earlier messages"}
              </button>
            </div>
          )}
          {loadMoreError && <p role="alert" className="text-center text-xs text-red-600 dark:text-red-400">{loadMoreError}</p>}
          {!hasMoreMessages && messages.length > 0 && <p className="text-center text-[11px] text-gray-500 dark:text-gray-400">Start of conversation · All earlier messages loaded</p>}

          {messages.map((msg, idx) => (
            <ChatMessage key={msg.id ?? `${msg.role}-${idx}`} message={msg} indexedAttachment={messages.find(item => item.artifacts?.indexedAttachment?.uploadId === msg.artifacts?.chatAttachment?.uploadId && item.artifacts?.indexedAttachment)?.artifacts?.indexedAttachment} onChatChanged={onChatChanged} busy={busy || readOnly} draftStorageKey={draftStorageKey} canManageErpAccess={canManageErpAccess}
                isLatestAssistant={idx === messages.findLastIndex(item => item.role === "assistant")}
                onContinue={!readOnly && !nodeContext && onSend ? text => onSend(text, { model: selectedModel || undefined }) : undefined}
                onUseDocumentForWorkflow={!readOnly && !nodeContext && canAuthorWorkflows ? value => { setDocumentContext(value); setUsingModelPreview(false); setDismissedContextKey(contextKey); setDraft(documentWorkflowRequest("Create a workflow to register the customer or business record described in this reviewed document.")); inputRef.current?.querySelector("textarea")?.focus(); } : undefined}
              onRevise={!readOnly && onRevise ? (message, text) => onRevise(message, text, { model: selectedModel || undefined }) : undefined} />
          ))}

          {(operation || operationError) && <ChatOperationProgress operation={operation} answerIntent={messages.find(message => message.id === operation?.assistantMessageId)?.artifacts?.intent} events={operationEvents} error={operationError} reconnecting={reconnecting} onCancel={onCancelOperation} cancelling={cancelling} onRefresh={onRefreshOperation} />}
          {busy && !operation && !sessionLoading && <ThinkingIndicator />}

          {(error || sendError) && (
            <div role="alert" className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800/40 dark:bg-red-900/20 dark:text-red-400">
              <Icon icon="mdi:alert-circle" className="mt-0.5 h-4 w-4 shrink-0" />
              {error || sendError}
              {error && onReloadConversation && <button type="button" disabled={sessionLoading} onClick={onReloadConversation} className="ml-2 shrink-0 underline">Reload conversation</button>}
            </div>
          )}

          <div ref={bottomRef} />
        </div>
      </div>

      {/* ── Input area ── */}
      {readOnly || unavailable ? <div role="status" className="shrink-0 border-t border-gray-100 p-4 text-sm text-gray-600 dark:border-gray-800 dark:text-gray-300">{unavailable ? "This conversation is unavailable for your account. Open Chat History to choose your own conversation or start a new one." : "Read-only administrative review · Only the owner can send messages or change this conversation."}</div> : (
      <div className={`shrink-0 border-t border-gray-100 dark:border-gray-800 ${workspace ? "px-4 py-3" : "p-4"}`}>
        <div className={`mx-auto ${workspace?.fullScreen ? "max-w-5xl" : "max-w-3xl"}`}>
          {canUploadDocuments && <>
            <input ref={attachmentPicker} type="file" aria-label="Choose message attachment" className="hidden" accept=".pdf,.png,.jpg,.jpeg,.tif,.tiff,.txt,.csv,.tsv,.json,.docx,.xlsx" disabled={busy || Boolean(nodeContext)} onChange={event => {
              const file = event.target.files?.[0]; event.target.value = "";
              if (!file) return;
              if (!file.size || file.size > 16 * 1024 * 1024 || !/\.(pdf|png|jpe?g|tiff?|txt|csv|tsv|json|docx|xlsx)$/i.test(file.name)) { setSendError("Choose a supported, non-empty file up to 16 MiB."); return; }
              setAttachment({ file, idempotencyKey: crypto.randomUUID() }); setDocumentContext(null); setUsingModelPreview(false); setSendError("");
              inputRef.current?.querySelector("textarea")?.focus();
            }} />
            <button type="button" aria-label="Attach file" disabled={busy || Boolean(nodeContext)} onClick={() => attachmentPicker.current?.click()} className="mb-2 inline-flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-1.5 text-xs text-gray-600 hover:border-primary hover:text-primary disabled:opacity-50 dark:border-gray-700 dark:text-gray-300"><Icon icon="mdi:paperclip" aria-hidden="true" />Attach file</button>
            {attachment && <div aria-label="Message attachment" className="mb-2 flex items-center gap-2 rounded-lg bg-primary/5 px-3 py-2 text-xs"><Icon icon="mdi:file-document-outline" aria-hidden="true" /><span className="min-w-0 flex-1 break-all">{attachment.file.name} · {Math.ceil(attachment.file.size / 1024)} KB</span><button type="button" aria-label="Remove message attachment" disabled={busy} onClick={() => setAttachment(null)} className="rounded px-2 py-1 text-primary disabled:opacity-50">Remove</button></div>}
            {attachmentProgress && <p role="status" className="mb-2 text-xs text-gray-500">{attachmentProgress} Supported files can use the selected model if the pipeline takes too long. Storage status will be shown separately.</p>}
          </>}
          {canUploadDocuments && inTools(<button type="button" aria-label="Upload or review workflow documents" disabled={busy || Boolean(nodeContext)} onClick={() => {
            workspace?.openChatTools?.(); setDocumentOpenRequest(value => value + 1);
          }} className="mb-2 inline-flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-1.5 text-xs text-gray-600 transition hover:border-primary hover:text-primary disabled:opacity-50 dark:border-gray-700 dark:text-gray-300"><Icon icon="mdi:folder-outline" aria-hidden="true" />Document library</button>, "document-library-button")}
          {canUploadDocuments && inTools(<ChatAttachments sessionId={documentSessionId} model={selectedModel} openRequestKey={documentOpenRequest} workflowInstruction={draft} disabled={busy || Boolean(nodeContext)} onCreateChat={onCreateDocumentChat} canAuthorWorkflows={canAuthorWorkflows} onUseModelPreview={(preview, options = {}) => {
            setDocumentContext(null); setUsingModelPreview(true); setDismissedContextKey(contextKey);
            setDraft(modelPreviewRequest(preview, options.instruction || "", options.asWorkflow === true, options.prepareSchedule === true));
            inputRef.current?.querySelector("textarea")?.focus();
          }} onUseForWorkflow={canAuthorWorkflows ? (value, options = {}) => {
            setUsingModelPreview(false); setDocumentContext(value); setDismissedContextKey(contextKey); setDraft(documentWorkflowRequest(options.instruction || draft, options.prepareSchedule === true));
          } : undefined} />, "documents")}
          {usingModelPreview && <p role="status" className="mb-2 text-xs text-primary">Using manually reviewed model-preview values, not confirmed OCR or pipeline storage.</p>}
          {documentContext && <p role="status" className="mb-2 text-xs text-primary">{documentContext.documents ? `Using ${documentContext.documents.length} reviewed documents` : `Using reviewed document v${documentContext.version}`} for an ERP workflow proposal. <button type="button" className="underline" disabled={busy} onClick={() => setDocumentContext(null)}>Remove document context</button></p>}
          {canUploadDocuments && nodeContext && <p className="mb-2 text-xs text-gray-500">Exit selected-node editing to review chat documents.</p>}
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
                disabled={busy}
                placeholder={nodeContext ? `Describe the change to ${nodeContext.nodeId}…` : indexed ? "Ask about stored documents. Include a name or ID and source scope…" : workspace ? "Ask anything, query ERP data, or describe a workflow…" : "Describe a workflow, query ERP data, or ask anything… (Enter to send, Shift+Enter for newline)"}
              />
            </div>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              {inTools(<div className={`flex flex-wrap gap-1.5 ${workspace ? "my-4" : ""}`}>
                {!nodeContext && quickPrompts.slice(0, 2).map((p) => (
                  <button
                    key={p.label}
                    type="button"
                    onClick={() => setDraft(p.text)}
                    disabled={busy}
                    className="flex items-center gap-1 rounded-full border border-gray-200 px-2.5 py-1 text-[10px] font-semibold text-gray-500 transition hover:border-primary hover:text-primary disabled:opacity-40 dark:border-gray-700 dark:text-gray-400"
                  >
                    <Icon icon={p.icon} className="h-3 w-3" />
                    {p.label}
                  </button>
                ))}
              </div>, "prompts")}
              <div className="ml-auto flex items-center gap-2">
                {(availableModels.length > 0 || selectedModel) && (
                  inTools(<div className={`flex items-center gap-1.5 rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-1 dark:border-gray-700 dark:bg-gray-800/60 ${workspace ? "my-3" : ""}`}>
                    <Icon icon="mdi:chip" className="h-3 w-3 shrink-0 text-gray-400" />
                    <select
                      aria-label="Requested model"
                      value={selectedModel}
                      onChange={(e) => { modelChosenByUser.current = true; writeWorkspaceValue(modelStorageKey, e.target.value); setSelectedModel(e.target.value); }}
                      disabled={busy}
                      className="min-w-0 flex-1 bg-transparent text-xs font-semibold text-gray-600 outline-none disabled:opacity-50 dark:text-gray-300"
                    >
                      {selectedModel && !availableModels.some((model) => model.id === selectedModel) && <option value={selectedModel}>{selectedModel} · unavailable</option>}
                      {availableModels.map((m) => (
                        <option key={m.id} value={m.id}>{m.label}</option>
                      ))}
                    </select>
                    <button type="button" aria-label="Refresh configured models" title="Refresh configured models" disabled={busy || modelsLoading} onClick={reloadModels} className="rounded p-1 text-gray-500 disabled:opacity-50"><Icon icon="mdi:refresh" className="h-3 w-3" /></button>
                  </div>, "model")
                )}
                <button
                  type="button"
                  aria-label="Send message"
                  onClick={handleSend}
                  disabled={busy || modelsLoading || scopePending || !draft.trim()}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-primary text-white transition hover:bg-primary/90 disabled:opacity-40"
                >
                  {busy
                    ? <Icon icon="mdi:loading" className="h-4 w-4 animate-spin" />
                    : <Icon icon="mdi:send" className="h-4 w-4" />
                  }
                </button>
              </div>
            </div>
            {modelError && <p role="status" className="mt-2 text-xs text-gray-600 dark:text-gray-300">{modelError} <button type="button" disabled={busy || modelsLoading} className="underline" onClick={reloadModels}>Reload models</button></p>}
            {modelsLoading && <p role="status" aria-live="polite" className="mt-2 flex items-center gap-1.5 text-xs text-gray-500"><Icon icon="mdi:loading" className="h-3 w-3 animate-spin" />Loading approved models… You can keep writing.</p>}
            {inTools(<p className="mt-2 text-[11px] leading-5 text-gray-500 dark:text-gray-400">{indexed ? "Answers use retrieved text from reviewed ERPBridge tools, not the original file bytes." : "Chat model applies to new messages and edit proposals. Saved runtime nodes keep their reviewed models."}</p>, "model-help")}
          </div>
          <p className="mt-1.5 text-center text-[10px] text-gray-400">
            {nodeContext ? "Changes are prepared for your review. Nothing runs automatically." : indexed ? "Check the saved tool results for the source evidence." : workspace ? "Enter to send · Shift+Enter for a new line · Drafts never run automatically" : "Follow your request’s progress. Drafts never run automatically."}
          </p>
        </div>
      </div>
      )}
    </section>
  );
}

export default ChatWindow;
