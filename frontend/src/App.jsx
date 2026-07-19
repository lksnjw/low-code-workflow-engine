import AppLayout from "./layouts/AppLayout";
import DashboardPage from "./pages/dashboard/DashboardPage";
import WorkflowListPage from "./pages/workflows/WorkflowListPage";
import WorkflowDetailPage from "./pages/workflows/WorkflowDetailPage";
import WorkflowBuilderPage from "./pages/workflows/WorkflowBuilderPage";
import WorkflowTemplatePage from "./pages/workflows/WorkflowTemplatePage";
import ChatPage from "./pages/chat/ChatPage";
import ExecutionListPage from "./pages/executions/ExecutionListPage";
import ExecutionLogsPage from "./pages/executions/ExecutionLogsPage";
import AnalyticsPage from "./pages/analytics/AnalyticsPage";
import UserListPage from "./pages/users/UserListPage";
import SettingsPage from "./pages/settings/SettingsPage";
import ProfilePage from "./pages/profile/ProfilePage";
import McpBridgePage from "./pages/mcp_bridge/McpBridgePage";
import DatafeedPage from "./pages/datafeed/DatafeedPage";
import FinetunePage from "./pages/finetune/FinetunePage";
import NotFoundPage from "./pages/errors/NotFoundPage";
import LoginPage from "./pages/auth/LoginPage";
import RegisterPage from "./pages/auth/RegisterPage";
import ForgotPasswordPage from "./pages/auth/ForgotPasswordPage";
import UnauthorizedPage from "./pages/errors/UnauthorizedPage";
import { ThemeProvider } from "./context/ThemeContext";
import { AuthProvider, useAuthContext } from "./context/AuthContext";
import { RouteProvider, useRoute } from "./context/RouteContext";
import { NotificationProvider } from "./context/NotificationContext";
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import usePermissions from "./hooks/usePermissions";
import { resolveRouteComponent } from "./utils/permission.utils";

import PipelineConfigPage from "./pages/datafeed/PipelineConfigPage";
import VectorMetricsPage from "./pages/datafeed/VectorMetricsPage";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 15_000, retry: 1, refetchOnWindowFocus: false },
  },
});

export const routeComponents = {
  "dashboard.overview": { Component: DashboardPage, requiredAny: ["workflow:read"] },
  "dashboard.activity": { Component: DashboardPage, requiredAny: ["workflow:read"] },
  "workflows.list": { Component: WorkflowListPage, requiredAny: ["workflow:read", "workflow:read_own"] },
  "workflows.builder": { Component: WorkflowBuilderPage, requiredAny: ["workflow:write"] },
  "workflows.templates": { Component: WorkflowTemplatePage, requiredAny: ["workflow:read"] },
  "workflows.detail": { Component: WorkflowDetailPage, requiredAny: ["workflow:read", "workflow:read_own"] },
  "chat.session": { Component: ChatPage, requiredAny: ["chat:use", "workflow:write"] },
  "chat.history": { Component: ChatPage, requiredAny: ["chat:use", "workflow:write"] },
  "executions.history": { Component: ExecutionListPage, requiredAny: ["workflow:read", "execution:read_own"] },
  "executions.live": { Component: ExecutionLogsPage, requiredAny: ["workflow:read", "execution:read_own"] },
  "executions.healing": { Component: ExecutionLogsPage, requiredAny: ["workflow:read", "execution:read_own"] },
  "analytics.performance": { Component: AnalyticsPage, requiredAny: ["workflow:read"] },
  "analytics.usage": { Component: AnalyticsPage, requiredAny: ["workflow:read"] },
  "analytics.healing": { Component: AnalyticsPage, requiredAny: ["workflow:read"] },
  "users.directory": { Component: UserListPage, requiredAny: ["user:manage"] },
  "users.roles": { Component: UserListPage, requiredAny: ["user:manage"] },
  "users.audit": { Component: UserListPage, requiredAny: ["audit:read"] },
  "settings.general": { Component: SettingsPage, requiredAny: ["settings:manage"] },
  "settings.integrations": { Component: SettingsPage, requiredAny: ["settings:manage"] },
  "settings.llm": { Component: SettingsPage, requiredAny: ["settings:manage"] },
  "profile.profile": { Component: ProfilePage, requiredAny: [] },
  "profile.security": { Component: ProfilePage, requiredAny: [] },
  "mcp_bridge.overview": { Component: McpBridgePage, requiredAny: ["workflow:read"] },
  "datafeed.overview": { Component: DatafeedPage, requiredAny: ["workflow:read"] },
  "datafeed.metrics": { Component: VectorMetricsPage, requiredAny: ["workflow:read"] },
  "datafeed.config": { Component: PipelineConfigPage, requiredAny: ["workflow:read"] },
  "finetune.overview": { Component: FinetunePage, requiredAny: ["workflow:read"] },
};

function ActivePage() {
  const { activeMain, activeSub } = useRoute();
  const { hasAny } = usePermissions();
  const route = routeComponents[`${activeMain}.${activeSub}`];
  const isDenied = route
    ? resolveRouteComponent(route, hasAny, UnauthorizedPage) === UnauthorizedPage
    : false;
  if (isDenied) {
    return <UnauthorizedPage />;
  }
  const Page = route?.Component ?? NotFoundPage;
  return <Page />;
}

// Auth routing: login | register | forgot-password
const AUTH_SCREENS = {
  login: LoginPage,
  register: RegisterPage,
  "forgot-password": ForgotPasswordPage,
};

function AuthRouter() {
  const [screen, setScreen] = useState("login");
  const Screen = AUTH_SCREENS[screen] ?? LoginPage;
  return <Screen onNavigate={setScreen} />;
}

function AppRouter() {
  const { isAuthenticated, loading } = useAuthContext();

  // While validating stored token, show nothing (or a spinner)
  if (loading) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-backgroundLight dark:bg-darkBackgroundVery">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <AuthRouter />;
  }

  return (
    <RouteProvider>
      <AppLayout>
        <ActivePage />
      </AppLayout>
    </RouteProvider>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <NotificationProvider>
          <AuthProvider>
            <AppRouter />
          </AuthProvider>
        </NotificationProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

export default App;
