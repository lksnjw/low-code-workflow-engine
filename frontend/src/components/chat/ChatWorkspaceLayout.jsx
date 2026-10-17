import { forwardRef, useCallback, useEffect, useId, useImperativeHandle, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import { readWorkspaceValue, writeWorkspaceValue } from "../../utils/workspaceSession";
import { ChatWorkspaceContext } from "./ChatWorkspaceContext";

const DEFAULT_RATIO = 45;
const DIVIDER_WIDTH = 12;
const MIN_PANE_WIDTH = 320;
const MODES = [
  { id: "chat", label: "Chat only", icon: "mdi:message-text-outline", title: "Hide canvas and expand chat" },
  { id: "split", label: "Split view", icon: "mdi:view-split-vertical", title: "Show chat and canvas" },
  { id: "canvas", label: "Canvas only", icon: "mdi:vector-square", title: "Expand canvas; keep chat available as a floating window" },
];

function initialLayout(storageKey) {
  try {
    const saved = JSON.parse(readWorkspaceValue(storageKey, "{}"));
    return {
      mode: MODES.some(({ id }) => id === saved?.mode) ? saved.mode : "split",
      ratio: typeof saved?.ratio === "number" && Number.isFinite(saved.ratio) && saved.ratio >= 20 && saved.ratio <= 80 ? saved.ratio : DEFAULT_RATIO,
    };
  } catch { return { mode: "split", ratio: DEFAULT_RATIO }; }
}

function widthBounds(width) {
  const available = width - DIVIDER_WIDTH;
  if (available < MIN_PANE_WIDTH * 2) return { min: 30, max: 70 };
  return { min: Math.max(20, MIN_PANE_WIDTH / available * 100), max: Math.min(80, 100 - MIN_PANE_WIDTH / available * 100) };
}

/** Presentation only: both panes stay mounted so changing the view cannot
 * discard composer text, canvas selection, pending previews or scroll state. */
const ChatWorkspaceLayout = forwardRef(function ChatWorkspaceLayout({ chat, canvas, tools, showCanvas = true, storageKey, onOpenWorkflow }, ref) {
  const [layout, setLayout] = useState(() => initialLayout(storageKey));
  const [width, setWidth] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [floatingOpen, setFloatingOpen] = useState(false);
  const [fullScreen, setFullScreen] = useState(null);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [toolsHost, setToolsHost] = useState(null);
  const [canvasToolsHost, setCanvasToolsHost] = useState(null);
  const [chatReviewHost, setChatReviewHost] = useState(null);
  const [reviewDialogHost, setReviewDialogHost] = useState(null);
  const [toolsTab, setToolsTab] = useState("chat");
  const rootRef = useRef(null), fullScreenButtonRef = useRef(null), toolsButtonRef = useRef(null);
  const containerRef = useRef(null), chatRef = useRef(null), dragRef = useRef(null), launcherRef = useRef(null);
  const ids = useId();
  const mode = showCanvas ? fullScreen || layout.mode : "chat";
  const focusLabel = mode === "split" ? "split view" : mode;
  const floating = mode === "canvas" && floatingOpen;
  const bounds = widthBounds(width);
  const ratio = Math.min(bounds.max, Math.max(bounds.min, layout.ratio));

  useEffect(() => {
    if (showCanvas) writeWorkspaceValue(storageKey, JSON.stringify(layout));
  }, [layout, showCanvas, storageKey]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // Keep the same DOM tree (and drafts/scroll state) while covering app chrome.
  // Make covered navigation unavailable to keyboard and screen-reader users too.
  useEffect(() => {
    if (!fullScreen) return undefined;
    const covered = [];
    let branch = rootRef.current;
    while (branch?.parentElement && branch.parentElement !== document.body) {
      for (const sibling of branch.parentElement.children) {
        if (sibling === branch || !(sibling instanceof HTMLElement)) continue;
        covered.push([sibling, sibling.inert, sibling.style.visibility]);
        sibling.inert = true; sibling.style.visibility = "hidden";
      }
      branch = branch.parentElement;
    }
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      covered.forEach(([element, inert, visibility]) => { element.inert = inert; element.style.visibility = visibility; });
      document.body.style.overflow = overflow;
    };
  }, [fullScreen]);

  const exitFullScreen = () => {
    setFullScreen(null);
    requestAnimationFrame(() => fullScreenButtonRef.current?.focus());
  };
  const closeTools = () => {
    setToolsOpen(false);
    requestAnimationFrame(() => toolsButtonRef.current?.focus());
  };

  const focusChat = useCallback(() => {
    setFloatingOpen(true);
    requestAnimationFrame(() => {
      chatRef.current?.querySelector('textarea[aria-label="Message to workflow assistant"]')?.focus({ preventScroll: true });
    });
  }, []);
  useImperativeHandle(ref, () => ({ focusChat }), [focusChat]);

  const selectView = (value, focus = value === "split") => {
    setFullScreen(focus ? value : null); setFloatingOpen(false);
    if (focus) setToolsOpen(false);
    setToolsTab(value === "canvas" ? "canvas" : "chat");
    setLayout(current => ({ ...current, mode: value }));
  };
  const openCanvasTools = useCallback(() => { setToolsTab("canvas"); setToolsOpen(true); }, []);
  const openChatTools = useCallback(() => { setToolsTab("chat"); setToolsOpen(true); }, []);
  const openWorkflow = useCallback(workflowId => {
    if (!showCanvas || !onOpenWorkflow || !/^[A-Za-z0-9_-]{1,128}$/.test(workflowId)) return;
    onOpenWorkflow(workflowId); setFullScreen(current => current === "chat" ? "split" : current); setFloatingOpen(false); setToolsTab("canvas");
    setLayout(current => current.mode === "chat" ? { ...current, mode: "split" } : current);
  }, [onOpenWorkflow, showCanvas]);
  const minimizeChat = () => {
    setFloatingOpen(false);
    requestAnimationFrame(() => launcherRef.current?.focus());
  };

  const resize = value => setLayout(current => ({ ...current, ratio: Math.round(Math.min(bounds.max, Math.max(bounds.min, value)) * 100) / 100 }));
  const stopDragging = () => { dragRef.current = null; setDragging(false); };
  const handleResizeKey = event => {
    const step = event.shiftKey ? 10 : 2;
    const values = { ArrowLeft: ratio - step, ArrowRight: ratio + step, Home: bounds.min, End: bounds.max, Enter: DEFAULT_RATIO };
    if (!Object.hasOwn(values, event.key)) return;
    event.preventDefault();
    resize(values[event.key]);
  };

  return (
    <ChatWorkspaceContext.Provider value={{ fullScreen: Boolean(fullScreen), toolsHost, canvasToolsHost, chatReviewHost, reviewDialogHost, openCanvasTools, openChatTools, openWorkflow: onOpenWorkflow && showCanvas ? openWorkflow : undefined }}>
    <div ref={rootRef} className={`${fullScreen ? "fixed inset-0 z-40 h-[100dvh]" : "relative h-full min-h-0"} flex min-w-0 bg-white dark:bg-darkBackgroundVery`} data-testid="chat-workspace-layout" data-view={mode} data-full-screen={String(Boolean(fullScreen))} data-floating-chat={floating ? "open" : "closed"}
      onKeyDown={event => {
        if (event.key !== "Escape" || event.defaultPrevented || event.target.closest('[role="dialog"], [role="menu"], [role="listbox"]')) return;
        if (toolsOpen) { event.preventDefault(); closeTools(); }
        else if (fullScreen) { event.preventDefault(); exitFullScreen(); }
      }}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div ref={containerRef} className={`relative flex min-h-0 min-w-0 flex-1 flex-col lg:flex-row ${dragging ? "cursor-col-resize select-none" : ""}`}
        style={{ "--chat-pane-width": `calc((100% - ${DIVIDER_WIDTH}px) * ${ratio / 100})` }}>
        <div ref={chatRef} id={`${ids}-chat`} hidden={mode === "canvas" && !floating} data-testid="workspace-chat-pane"
          role={floating ? "dialog" : undefined} aria-label={floating ? "Floating chat" : undefined} aria-modal={floating ? false : undefined}
          onKeyDown={event => {
            if (floating && event.key === "Escape" && !event.defaultPrevented && event.target.closest('[role="dialog"]') === event.currentTarget) {
              event.preventDefault(); event.stopPropagation(); minimizeChat();
            }
          }}
          className={mode === "canvas" ? floating ? "absolute bottom-4 right-4 z-30 flex h-[min(560px,calc(100%_-_2rem))] min-h-0 w-[min(440px,calc(100%_-_2rem))] min-w-0 flex-col overflow-hidden rounded-xl border border-gray-200 bg-white shadow-2xl dark:border-gray-700 dark:bg-darkBackground" : "hidden" : `flex min-h-0 min-w-0 flex-col ${mode === "split" ? "h-[65svh] min-h-[420px] shrink-0 border-b border-gray-200 dark:border-gray-800 lg:h-full lg:min-h-0 lg:w-[var(--chat-pane-width)] lg:border-b-0" : "h-full flex-1"}`}>
          {floating && <div className="flex shrink-0 items-center justify-between border-b border-gray-200 bg-gray-50 px-3 py-2 dark:border-gray-700 dark:bg-gray-900">
            <span className="text-xs font-semibold text-gray-700 dark:text-gray-200">Chat</span>
            <div className="flex items-center gap-1">
              <button type="button" aria-label="Expand floating chat" title="Expand chat to full width" onClick={() => { selectView("chat"); focusChat(); }} className="rounded p-1 text-gray-500 hover:bg-gray-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary dark:hover:bg-gray-700">
                <Icon icon="mdi:arrow-expand" aria-hidden="true" className="h-4 w-4" />
              </button>
              <button type="button" aria-label="Minimize floating chat" title="Minimize chat · Escape" onClick={minimizeChat} className="rounded p-1 text-gray-500 hover:bg-gray-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary dark:hover:bg-gray-700">
                <Icon icon="mdi:minus" aria-hidden="true" className="h-4 w-4" />
              </button>
            </div>
          </div>}
          <div ref={setChatReviewHost} className="shrink-0" />
          {chat}
        </div>
        {showCanvas && <div role="separator" aria-label="Resize chat and canvas" aria-orientation="vertical" aria-controls={`${ids}-chat ${ids}-canvas`}
          aria-valuemin={Math.round(bounds.min)} aria-valuemax={Math.round(bounds.max)} aria-valuenow={Math.round(ratio)} aria-valuetext={`Chat ${Math.round(ratio)}%, canvas ${100 - Math.round(ratio)}%`}
          tabIndex={mode === "split" ? 0 : -1} hidden={mode !== "split"}
          title="Drag to resize. Use Left/Right arrows, Shift for larger steps, Home/End for limits. Double-click or press Enter to reset widths."
          onKeyDown={handleResizeKey} onDoubleClick={() => resize(DEFAULT_RATIO)}
          onPointerDown={event => {
            if (event.button !== 0 || !event.isPrimary) return;
            const available = containerRef.current.getBoundingClientRect().width - DIVIDER_WIDTH;
            if (available <= 0) return;
            event.preventDefault(); event.currentTarget.focus();
            dragRef.current = { pointerId: event.pointerId, startX: event.clientX, ratio, available };
            event.currentTarget.setPointerCapture(event.pointerId); setDragging(true);
          }}
          onPointerMove={event => {
            const drag = dragRef.current;
            if (drag?.pointerId === event.pointerId) resize(drag.ratio + (event.clientX - drag.startX) / drag.available * 100);
          }}
          onPointerUp={event => {
            if (dragRef.current?.pointerId !== event.pointerId) return;
            stopDragging();
            if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onPointerCancel={stopDragging} onLostPointerCapture={stopDragging}
          className={mode !== "split" ? "hidden" : "group relative hidden w-3 shrink-0 touch-none cursor-col-resize items-center justify-center bg-gray-50 transition-colors hover:bg-primary/10 focus-visible:z-10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary dark:bg-gray-900 dark:hover:bg-primary/20 lg:flex"}>
          <span aria-hidden="true" className={`h-full w-px ${dragging ? "bg-primary" : "bg-gray-200 group-hover:bg-primary/50 dark:bg-gray-700"}`} />
          <span aria-hidden="true" className="absolute flex h-9 w-2 items-center justify-center rounded-full border border-gray-200 bg-white text-gray-400 group-hover:border-primary/40 group-hover:text-primary dark:border-gray-600 dark:bg-gray-800">
            <Icon icon="mdi:drag-vertical" className="h-4 w-3 shrink-0" />
          </span>
        </div>}
        {showCanvas && <div id={`${ids}-canvas`} hidden={mode === "chat"} data-testid="workspace-canvas-pane"
          className={mode === "chat" ? "hidden" : "min-h-0 min-w-0 flex-1 h-[75svh] min-h-[420px] lg:h-full lg:min-h-0"}>
          {canvas}
        </div>}
        {mode === "canvas" && !floating && <button ref={launcherRef} type="button" aria-label="Open floating chat" aria-expanded="false" aria-controls={`${ids}-chat`} onClick={focusChat}
          className="absolute bottom-5 right-5 z-20 inline-flex items-center gap-2 rounded-full bg-primary px-4 py-3 text-sm font-semibold text-white shadow-lg transition-colors hover:bg-primary/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">
          <Icon icon="mdi:message-text-outline" aria-hidden="true" className="h-4 w-4" />Chat
        </button>}
      </div>
      </div>
      <aside id={`${ids}-tools`} hidden={!toolsOpen} aria-label="Workspace tools" className={toolsOpen ? "flex h-full w-80 max-w-[calc(100vw-3.5rem)] shrink-0 flex-col border-l border-gray-200 bg-gray-50 dark:border-gray-800 dark:bg-darkBackgroundVery" : "hidden"}>
        <div className="flex shrink-0 items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-gray-800">
          <h2 className="text-sm font-semibold">Workspace tools</h2>
          <button type="button" aria-label="Close workspace tools" onClick={closeTools} className="rounded p-1 text-gray-500 hover:bg-gray-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary dark:hover:bg-gray-800"><Icon icon="mdi:close" className="h-4 w-4" /></button>
        </div>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4 text-xs">
          {showCanvas && <div role="group" aria-label="Workspace view" className="space-y-1">
            <p className="mb-2 font-semibold text-gray-500">View</p>
            {MODES.map(view => <button key={view.id} type="button" title={view.title} aria-pressed={mode === view.id} onClick={() => selectView(view.id)}
              className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-left font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary ${mode === view.id ? "bg-primary/10 text-primary dark:bg-primary/20" : "text-gray-600 hover:bg-gray-200 dark:text-gray-300 dark:hover:bg-gray-800"}`}>
              <Icon icon={view.icon} aria-hidden="true" className="h-4 w-4" />{view.label}
            </button>)}
            <button type="button" onClick={() => { selectView("split", false); setLayout({ mode: "split", ratio: DEFAULT_RATIO }); }} className="flex items-center gap-2 rounded-md px-3 py-2 text-gray-500 hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"><Icon icon="mdi:restore" aria-hidden="true" />Reset layout</button>
            <p className="px-3 pt-1 text-[11px] text-gray-500">Split view focuses chat and canvas together. Drag the divider to resize; Exit restores navigation.</p>
          </div>}
          {showCanvas && <div role="group" aria-label="Tool panel section" className="flex gap-1 border-b border-gray-200 pb-2 dark:border-gray-700">
            {["chat", "canvas"].map(value => <button key={value} type="button" aria-pressed={toolsTab === value} onClick={() => setToolsTab(value)} className={`flex-1 rounded-md px-2 py-2 font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary ${toolsTab === value ? "bg-primary/10 text-primary" : "text-gray-500 hover:bg-gray-200 dark:hover:bg-gray-800"}`}>{value === "chat" ? "Chat tools" : "Canvas tools"}</button>)}
          </div>}
          <div hidden={showCanvas && toolsTab !== "chat"}>
            {tools}
            <div ref={setToolsHost} />
          </div>
          <div hidden={!showCanvas || toolsTab !== "canvas"} ref={setCanvasToolsHost} />
        </div>
      </aside>
      <div role="toolbar" aria-label="Chat display tools" aria-orientation="vertical" className="flex w-14 shrink-0 flex-col items-center gap-2 border-l border-gray-200 bg-white py-3 dark:border-gray-800 dark:bg-darkBackgroundVery">
        <button ref={fullScreenButtonRef} type="button" aria-label={`${fullScreen ? "Exit full screen" : "Full screen"} ${focusLabel}`} title={fullScreen ? "Exit full screen · Escape" : "Full screen — hide app headings and navigation"} aria-pressed={Boolean(fullScreen)} onClick={() => {
          if (fullScreen) exitFullScreen();
          else { setToolsOpen(false); setFullScreen(mode); }
        }} className="flex w-12 flex-col items-center gap-1 rounded-lg py-2 text-primary transition-colors hover:bg-primary/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
          <Icon icon={fullScreen ? "mdi:fullscreen-exit" : "mdi:fullscreen"} aria-hidden="true" className="h-5 w-5" /><span className="text-[10px]">{fullScreen ? "Exit" : "Focus"}</span>
        </button>
        <button ref={toolsButtonRef} type="button" aria-label="Workspace tools" title="View, chat history, model and documents" aria-expanded={toolsOpen} aria-controls={`${ids}-tools`} onClick={() => setToolsOpen(value => !value)} className={`flex w-12 flex-col items-center gap-1 rounded-lg py-2 transition-colors hover:bg-primary/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary ${toolsOpen ? "bg-primary/10 text-primary" : "text-gray-500 dark:text-gray-400"}`}>
          <Icon icon="mdi:tune-variant" aria-hidden="true" className="h-5 w-5" /><span className="text-[10px]">Tools</span>
        </button>
      </div>
      <div ref={setReviewDialogHost} />
    </div>
    </ChatWorkspaceContext.Provider>
  );
});

export default ChatWorkspaceLayout;
