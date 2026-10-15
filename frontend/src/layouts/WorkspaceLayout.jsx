import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { workspaceKey, writeWorkspaceValue } from "../utils/workspaceSession";
import { useAuthContext } from "../context/AuthContext";
import Sidebar from "../components/navigation/Sidebar";
import Topbar from "../components/navigation/Topbar";
import MobileNav from "../components/navigation/MobileNav";
import ServerUnreachableBanner from "../components/shared/ServerUnreachableBanner";

export function isWorkspacePath(pathname) {
  const path = pathname.replace(/\/+$/, "") || "/";
  return path === "/" || path === "/chat" ||
    (/^\/chat\/[^/]+$/.test(path) && path !== "/chat/history");
}

export default function WorkspaceLayout({ children }) {
  const { user } = useAuthContext();
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const location = useLocation();
  const returnKey = workspaceKey(user, "return");
  useEffect(() => {
    writeWorkspaceValue(returnKey, location.pathname + location.search);
  }, [returnKey, location.pathname, location.search]);
  return (
    <div className="fixed inset-0 flex bg-white text-gray-900 dark:bg-darkBackgroundVery dark:text-gray-100">
      <Sidebar isCollapsed={isSidebarCollapsed} onToggle={() => setIsSidebarCollapsed(current => !current)} />
      <div className="flex h-screen min-w-0 flex-1 flex-col overflow-hidden">
        <Topbar />
        <ServerUnreachableBanner />
        <MobileNav />
        <main className="min-h-0 flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  );
}
