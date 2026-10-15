import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";

export default function WorkflowDialog({ open, title, onClose, busy = false, children }) {
  const panel = useRef(null), host = useRef(null), titleId = useId();
  useEffect(() => {
    if (!open) return undefined;
    const opener = document.activeElement, overflow = document.body.style.overflow;
    const covered = [...document.body.children].filter(item => item !== host.current).map(item => [item, item.inert]);
    covered.forEach(([item]) => { item.inert = true; }); document.body.style.overflow = "hidden";
    panel.current?.focus();
    return () => { covered.forEach(([item, inert]) => { item.inert = inert; }); document.body.style.overflow = overflow; if (opener?.isConnected) opener.focus?.(); };
  }, [open]);
  if (!open) return null;
  return createPortal(<div ref={host} className="fixed inset-0 z-[1100] flex items-center justify-center bg-black/50 p-4" onKeyDown={event => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (!busy) onClose(); }
    if (event.key !== "Tab") return;
    const elements = [...panel.current.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]')].filter(item => !item.closest("details:not([open])") && !item.hidden);
    const first = elements[0], last = elements.at(-1);
    if (!first) { event.preventDefault(); panel.current.focus(); }
    else if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel.current)) { event.preventDefault(); first.focus(); }
  }}>
    <section ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} aria-busy={busy} className="flex max-h-[90dvh] w-full max-w-2xl flex-col rounded-xl bg-white shadow-xl outline-none dark:bg-darkBackground">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-gray-200 px-5 py-4 dark:border-gray-700"><h2 id={titleId} className="text-base font-semibold">{title}</h2><button type="button" aria-label={`Close ${title}`} disabled={busy} onClick={onClose} className="rounded-md px-3 py-1 text-sm text-gray-500 hover:bg-gray-100 disabled:opacity-50 dark:hover:bg-gray-800">×</button></header>
      <div className="min-h-0 overflow-auto p-5">{children}</div>
    </section>
  </div>, document.body);
}
