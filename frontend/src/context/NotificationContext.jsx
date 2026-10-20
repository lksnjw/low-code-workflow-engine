import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

const NotificationContext = createContext(null);

/*******************************************************************************
 * Function: NotificationProvider
 *
 * Performs the Notification Provider operation on provider for the NotificationContext module.
 ******************************************************************************/
export function NotificationProvider({ children }) {
  const [notifications, setNotifications] = useState([]);
  const [activity, setActivity] = useState([]);
  const timers = useRef(new Map());
  useEffect(() => {
    const pending = timers.current;
    return () => { pending.forEach(timer => window.clearTimeout(timer)); pending.clear(); };
  }, []);
  const dismiss = useCallback(id => {
    window.clearTimeout(timers.current.get(id)); timers.current.delete(id);
    setNotifications(items => items.filter(item => item.id !== id));
  }, []);
  const markActivityRead = useCallback(id => setActivity(items => items.map(item => !id || item.id === id ? { ...item, read: true } : item)), []);

/*******************************************************************************
 * Function: notify
 *
 * Performs the notify operation on the application for the NotificationContext module.
 ******************************************************************************/
  const notify = useCallback((message, tone = "info", action = null) => {
    const id = crypto.randomUUID?.() ?? `${Date.now()}`;
    const item = { id, message, tone, action, createdAt: new Date().toISOString(), read: false };
    setNotifications(items => [...items.slice(-4), item]);
    setActivity(items => [{ ...item, action: null }, ...items].slice(0, 50));
    // An actionable notice must not disappear before its button can be used.
    // This is supplementary feedback; transaction reviews remain in context.
    if (!action) timers.current.set(id, window.setTimeout(() => dismiss(id), tone === "error" ? 10000 : 6000));
    return id;
  }, [dismiss]);

/*******************************************************************************
 * Function: value
 *
 * Performs the value operation on the application for the NotificationContext module.
 ******************************************************************************/
  const value = useMemo(() => ({ notifications, notify, dismiss, activity, markActivityRead }), [notifications, notify, dismiss, activity, markActivityRead]);

  return (
    <NotificationContext.Provider value={value}>
      {children}
      <div className="fixed right-6 top-20 z-[9999] flex w-[320px] max-w-[calc(100vw-3rem)] flex-col gap-3">
        {notifications.map((item) => (
          <div
            key={item.id}
            role={item.tone === "error" ? "alert" : "status"}
            aria-atomic="true"
            className={`animate-slide-up rounded-xl border bg-white px-4 py-3 text-sm font-medium text-gray-800 shadow-panel dark:bg-darkBackground dark:text-gray-100 ${item.tone === "error" ? "border-red-300 dark:border-red-700" : item.tone === "success" ? "border-emerald-300 dark:border-emerald-700" : "border-gray-200 dark:border-gray-700"}`}
          >
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 flex-1"><p className={`mb-1 text-xs font-bold ${item.tone === "error" ? "text-red-700 dark:text-red-300" : item.tone === "success" ? "text-emerald-700 dark:text-emerald-300" : "text-primary"}`}>{item.tone === "error" ? "Action needs attention" : item.tone === "success" ? "Completed" : "Workspace update"}</p><p className="break-words">{item.message}</p></div>
              <button type="button" aria-label="Dismiss notification" onClick={() => dismiss(item.id)} className="self-start rounded border px-2 py-1 text-xs font-semibold text-gray-600 focus-visible:outline focus-visible:outline-primary dark:text-gray-300">OK</button>
              {item.action && <NotificationAction action={item.action} onDone={() => { dismiss(item.id); markActivityRead(item.id); }} />}
            </div>
          </div>
        ))}
      </div>
    </NotificationContext.Provider>
  );
}

function NotificationAction({ action, onDone }) {
  const pending = useRef(false), mounted = useRef(true);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const invoke = async () => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError("");
    try { await action.onClick?.(); if (mounted.current) onDone(); }
    catch { if (mounted.current) setError("Action was not confirmed. Check its current status before trying again."); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  };
  return <div className="max-w-40"><button type="button" disabled={busy} className="rounded-full bg-primary px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50" onClick={invoke}>{busy ? "Working…" : action.label}</button>{error && <p role="alert" className="mt-2 text-xs text-red-700 dark:text-red-300">{error}</p>}</div>;
}

/*******************************************************************************
 * Function: useNotifications
 *
 * Provides notifications for the NotificationContext module.
 ******************************************************************************/
export function useNotifications() {
  const context = useContext(NotificationContext);
  if (!context) {
    throw new Error("useNotifications must be used within NotificationProvider");
  }
  return context;
}

// Embedded workflow views can still render their inline approval when mounted
// outside the application notification shell.
export function useOptionalNotifications() { return useContext(NotificationContext); }
