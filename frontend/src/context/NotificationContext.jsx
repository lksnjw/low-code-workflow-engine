import { createContext, useContext, useMemo, useState } from "react";

const NotificationContext = createContext(null);

/*******************************************************************************
 * Function: NotificationProvider
 *
 * Performs the Notification Provider operation on provider for the NotificationContext module.
 ******************************************************************************/
export function NotificationProvider({ children }) {
  const [notifications, setNotifications] = useState([]);

/*******************************************************************************
 * Function: notify
 *
 * Performs the notify operation on the application for the NotificationContext module.
 ******************************************************************************/
  const notify = (message, tone = "info", action = null) => {
    const id = crypto.randomUUID?.() ?? `${Date.now()}`;
    setNotifications((items) => [...items, { id, message, tone, action }]);
    window.setTimeout(() => {
      setNotifications((items) => items.filter((item) => item.id !== id));
    }, 3400);
  };

/*******************************************************************************
 * Function: value
 *
 * Performs the value operation on the application for the NotificationContext module.
 ******************************************************************************/
  const value = useMemo(() => ({ notifications, notify }), [notifications]);

  return (
    <NotificationContext.Provider value={value}>
      {children}
      <div className="fixed right-6 top-20 z-[9999] flex w-[320px] max-w-[calc(100vw-3rem)] flex-col gap-3">
        {notifications.map((item) => (
          <div
            key={item.id}
            className="animate-slide-up rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm font-medium text-gray-800 shadow-panel dark:border-gray-800 dark:bg-darkBackground dark:text-gray-100"
          >
            <div className="flex items-center justify-between gap-3">
              <span>{item.message}</span>
              {item.action ? (
                <button
                  type="button"
                  className="shrink-0 rounded-full bg-primary px-3 py-1.5 text-xs font-bold text-white"
                  onClick={() => {
                    item.action.onClick?.();
                    setNotifications((items) => items.filter((candidate) => candidate.id !== item.id));
                  }}
                >
                  {item.action.label}
                </button>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </NotificationContext.Provider>
  );
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
