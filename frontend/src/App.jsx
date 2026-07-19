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
import { ThemeProvider } from "./context/ThemeContext";
import { AuthProvider, useAuthContext } from "./context/AuthContext";
import { RouteProvider, useRoute } from "./context/RouteContext";
import { NotificationProvider } from "./context/NotificationContext";
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import PipelineConfigPage from "./pages/datafeed/PipelineConfigPage";
import VectorMetricsPage from "./pages/datafeed/VectorMetricsPage";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 15_000, retry: 1, refetchOnWindowFocus: false },
  },
});

const routeComponents = {
  "dashboard.overview": DashboardPage,
  "dashboard.activity": DashboardPage,
  "workflows.list": WorkflowListPage,
  "workflows.builder": WorkflowBuilderPage,
  "workflows.templates": WorkflowTemplatePage,
  "workflows.detail": WorkflowDetailPage,
  "chat.session": ChatPage,
  "chat.history": ChatPage,
  "executions.history": ExecutionListPage,
  "executions.live": ExecutionLogsPage,
  "executions.healing": ExecutionLogsPage,
  "analytics.performance": AnalyticsPage,
  "analytics.usage": AnalyticsPage,
  "analytics.healing": AnalyticsPage,
  "users.directory": UserListPage,
  "users.roles": UserListPage,
  "users.audit": UserListPage,
  "settings.general": SettingsPage,
  "settings.integrations": SettingsPage,
  "settings.llm": SettingsPage,
  "profile.profile": ProfilePage,
  "profile.security": ProfilePage,
  "mcp_bridge.overview": McpBridgePage,
  "datafeed.overview": DatafeedPage,
  "datafeed.metrics": VectorMetricsPage,
  "datafeed.config": PipelineConfigPage,
  "finetune.overview": FinetunePage,
};

function ActivePage() {
  const { activeMain, activeSub } = useRoute();
  const Page = routeComponents[`${activeMain}.${activeSub}`] ?? NotFoundPage;
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
