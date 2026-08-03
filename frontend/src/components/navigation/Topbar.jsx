import { useState, useRef } from "react";
import { Icon } from "@iconify/react";
import { useQuery } from "@tanstack/react-query";
import Breadcrumb from "./Breadcrumb";
import CommandPalette from "./CommandPalette";
import { appConfig } from "../../config/app";
import { useTheme } from "../../context/ThemeContext";
import { useNotifications } from "../../context/NotificationContext";
import { useAuthContext } from "../../context/AuthContext";
import { useClickOutside } from "../../hooks/useClickOutside";
import { notificationService } from "../../services/notification.service";
import { apiClient } from "../../config/axios";

function UserMenu({ user, onLogout }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useClickOutside(ref, () => setOpen(false));

  const initials = user?.name
    ? user.name
        .split(" ")
        .slice(0, 2)
        .map((w) => w[0])
        .join("")
        .toUpperCase()
    : "?";

  return (
    <div className="relative" ref={ref}>
      <button
        id="user-menu-button"
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-xl border border-transparent px-2 py-1.5 transition hover:border-gray-200 hover:bg-gray-50 dark:hover:border-gray-800 dark:hover:bg-darkBackground"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label="User menu"
      >
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-violet-600 text-xs font-bold text-white shadow">
          {initials}
        </div>
        <div className="hidden flex-col items-start sm:flex">
          <span className="text-xs font-semibold leading-tight text-gray-900 dark:text-white">
            {user?.name ?? "User"}
          </span>
          <span className="text-[10px] text-gray-400 dark:text-gray-500">
            {typeof user?.role === 'object' ? user?.role?.name : (user?.role ?? "")}
          </span>
        </div>
        <Icon
          icon={open ? "mdi:chevron-up" : "mdi:chevron-down"}
          className="h-4 w-4 text-gray-400"
        />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-48 rounded-xl border border-gray-200 bg-white py-1 shadow-lg dark:border-gray-800 dark:bg-darkBackground">
          <div className="border-b border-gray-100 px-4 py-3 dark:border-gray-800">
            <p className="truncate text-xs font-semibold text-gray-900 dark:text-white">
              {user?.name}
            </p>
            <p className="truncate text-[11px] text-gray-400">{user?.email}</p>
          </div>
          <button
            type="button"
            className="flex w-full items-center gap-2 px-4 py-2.5 text-xs text-gray-600 transition hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-800"
            onClick={() => {
              setOpen(false);
              // Navigate to profile — use a small timeout to allow menu close
              window.dispatchEvent(new CustomEvent("nav:profile"));
            }}
          >
            <Icon icon="mdi:account-outline" className="h-4 w-4" />
            Profile
          </button>
          <button
            type="button"
            className="flex w-full items-center gap-2 px-4 py-2.5 text-xs text-red-500 transition hover:bg-red-50 dark:hover:bg-red-900/20"
            onClick={() => {
              setOpen(false);
              onLogout();
            }}
          >
            <Icon icon="mdi:logout" className="h-4 w-4" />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

function Topbar() {
  const { isDarkMode, toggleTheme } = useTheme();
  const { notify } = useNotifications();
  const { user, logout } = useAuthContext();
  const notificationQuery = useQuery({
    queryKey: ["notifications", "unread"],
    queryFn: () => notificationService.list({ unreadOnly: true, limit: 100 }),
    refetchInterval: 30_000,
  });
  const environmentQuery = useQuery({
    queryKey: ["runtime-environment"],
    queryFn: async () => (await apiClient.get("/health")).data?.data ?? {},
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  const unreadCount = notificationQuery.data?.length || 0;
  const environment = environmentQuery.data?.environment;
  const mockERP = environmentQuery.data?.mcpBackend === "mock-erp";

  return (
    <header className="flex items-center justify-between gap-4 border-b border-gray-200 bg-white px-4 py-3 transition-colors duration-200 dark:border-darkBackgroundVery dark:bg-darkBackground sm:px-6">
      <div className="min-w-0 flex-1 sm:flex-none">
        <div className="flex items-center gap-4">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-panel">
            <Icon icon="tabler:git-branch" className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-bold text-gray-950 dark:text-white">
                {appConfig.name}
              </span>
              <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-semibold text-darkBackgroundVery dark:bg-darkBackgroundVery dark:text-gray-300">
                v{appConfig.version}
              </span>
              {environment ? (
                <span
                  data-testid="environment-badge"
                  className={`rounded-full px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide ${
                    mockERP
                      ? "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300"
                      : "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300"
                  }`}
                >
                  {environment}{mockERP ? " · Mock ERP" : ""}
                </span>
              ) : null}
            </div>
            <Breadcrumb />
          </div>
        </div>
      </div>

      <CommandPalette />

      <div className="flex shrink-0 items-center gap-3">
        <button
          type="button"
          onClick={toggleTheme}
          className="icon-button"
          aria-label="Toggle theme"
        >
          <Icon
            icon={isDarkMode ? "mdi:weather-sunny" : "mdi:weather-night"}
            className="h-5 w-5"
          />
        </button>
        <button
          type="button"
          className="icon-button relative hidden sm:flex"
          aria-label="Notifications"
          onClick={async () => {
            const result = await notificationQuery.refetch();
            const count = result.data?.length || 0;
            notify(count ? `${count} unread notification${count === 1 ? "" : "s"}.` : "No unread notifications.");
          }}
        >
          <Icon icon="mdi:bell-outline" className="h-5 w-5" />
          {unreadCount ? <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full border-2 border-white bg-red-500 px-1 text-[10px] font-bold text-white dark:border-gray-900">{unreadCount > 99 ? "99+" : unreadCount}</span> : null}
        </button>

        <UserMenu user={user} onLogout={logout} />
      </div>
    </header>
  );
}

export default Topbar;
