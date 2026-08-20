import { Suspense, lazy } from "react";
import {
  Navigate,
  Outlet,
  createBrowserRouter,
  useLocation,
  useNavigate,
} from "react-router-dom";
import ErrorBoundary from "../components/shared/ui/ErrorBoundary";
import { LoadingState } from "../components/shared/ResourceState";
import { NAVIGATION_GROUPS } from "../constants/navigation";
import { useAuthContext } from "../context/AuthContext";
import { RouteProvider } from "../context/RouteContext";
import usePermissions from "../hooks/usePermissions";
import AppLayout from "../layouts/AppLayout";

export const lazyRouteComponents = {
  DashboardPage: lazy(() => import("../pages/dashboard/DashboardPage")),
  CompanyPage: lazy(() => import("../pages/company/CompanyPage")),
  WorkflowListPage: lazy(() => import("../pages/workflows/WorkflowListPage")),
  WorkflowBuilderPage: lazy(() => import("../pages/workflows/WorkflowBuilderPage")),
  WorkflowTemplatePage: lazy(() => import("../pages/workflows/WorkflowTemplatePage")),
  WorkflowDetailPage: lazy(() => import("../pages/workflows/WorkflowDetailPage")),
  ChatPage: lazy(() => import("../pages/chat/ChatPage")),
  ChatHistoryPage: lazy(() => import("../pages/chat/ChatHistoryPage")),
  ExecutionListPage: lazy(() => import("../pages/executions/ExecutionListPage")),
  ExecutionLogsPage: lazy(() => import("../pages/executions/ExecutionLogsPage")),
  ExecutionDetailPage: lazy(() => import("../pages/executions/ExecutionDetailPage")),
  AnalyticsPage: lazy(() => import("../pages/analytics/AnalyticsPage")),
  UserListPage: lazy(() => import("../pages/users/UserListPage")),
  AuditPage: lazy(() => import("../pages/users/AuditPage")),
  SettingsPage: lazy(() => import("../pages/settings/SettingsPage")),
  ModelsPage: lazy(() => import("../pages/models/ModelsPage")),
  RegistryPage: lazy(() => import("../pages/registry/RegistryPage")),
  RegistryImportPage: lazy(() => import("../pages/registry/RegistryImportPage")),
  RegistryContextPage: lazy(() => import("../pages/registry/RegistryContextPage")),
  McpBridgePage: lazy(() => import("../pages/mcp_bridge/McpBridgePage")),
  DatafeedPage: lazy(() => import("../pages/datafeed/DatafeedPage")),
  VectorMetricsPage: lazy(() => import("../pages/datafeed/VectorMetricsPage")),
  PipelineConfigPage: lazy(() => import("../pages/datafeed/PipelineConfigPage")),
  FinetunePage: lazy(() => import("../pages/finetune/FinetunePage")),
  ProfilePage: lazy(() => import("../pages/profile/ProfilePage")),
  SecurityPage: lazy(() => import("../pages/profile/SecurityPage")),
  LoginPage: lazy(() => import("../pages/auth/LoginPage")),
  RegisterPage: lazy(() => import("../pages/auth/RegisterPage")),
  ForgotPasswordPage: lazy(() => import("../pages/auth/ForgotPasswordPage")),
  UnauthorizedPage: lazy(() => import("../pages/errors/UnauthorizedPage")),
  NotFoundPage: lazy(() => import("../pages/errors/NotFoundPage")),
};

const C = lazyRouteComponents;

export const protectedRouteDefinitions = [
  { id: "dashboard.overview", path: "/", Component: C.DashboardPage, requiredAny: ["workflow:read"], componentProps: { view: "overview" } },
  { id: "dashboard.activity", path: "/activity", Component: C.DashboardPage, requiredAny: ["workflow:read"], componentProps: { view: "activity" } },
  { id: "company.overview", path: "/company", Component: C.CompanyPage, requiredAny: [] },
  { id: "workflows.list", path: "/workflows", Component: C.WorkflowListPage, requiredAny: ["workflow:read", "workflow:read_own"] },
  { id: "workflows.builder", path: "/builder", Component: C.WorkflowBuilderPage, requiredAny: ["workflow:write"] },
  { id: "workflows.builder-detail", path: "/builder/:workflowId", Component: C.WorkflowBuilderPage, requiredAny: ["workflow:write"] },
  { id: "workflows.templates", path: "/workflows/templates", Component: C.WorkflowTemplatePage, requiredAny: ["workflow:read"] },
  { id: "workflows.detail", path: "/workflows/:workflowId", Component: C.WorkflowDetailPage, requiredAny: ["workflow:read", "workflow:read_own"] },
  { id: "chat.session", path: "/chat", Component: C.ChatPage, requiredAny: ["chat:use", "workflow:write"] },
  { id: "chat.session-detail", path: "/chat/:sessionId", Component: C.ChatPage, requiredAny: ["chat:use", "workflow:write"] },
  { id: "chat.history", path: "/chat/history", Component: C.ChatHistoryPage, requiredAny: ["chat:use", "workflow:write"] },
  { id: "executions.history", path: "/executions", Component: C.ExecutionListPage, requiredAny: ["workflow:read", "execution:read_own"] },
  { id: "executions.live", path: "/executions/logs", Component: C.ExecutionLogsPage, requiredAny: ["workflow:read", "execution:read_own"], componentProps: { view: "logs" } },
  { id: "executions.healing", path: "/executions/healing", Component: C.ExecutionLogsPage, requiredAny: ["workflow:read", "execution:read_own"], componentProps: { view: "healing" } },
  { id: "executions.detail", path: "/executions/:executionId", Component: C.ExecutionDetailPage, requiredAny: ["workflow:read", "execution:read_own"] },
  { id: "analytics.performance", path: "/analytics/performance", Component: C.AnalyticsPage, requiredAny: ["workflow:read"], componentProps: { view: "performance" } },
  { id: "analytics.usage", path: "/analytics/usage", Component: C.AnalyticsPage, requiredAny: ["workflow:read"], componentProps: { view: "usage" } },
  { id: "analytics.healing", path: "/analytics/healing", Component: C.AnalyticsPage, requiredAny: ["workflow:read"], componentProps: { view: "healing" } },
  { id: "users.directory", path: "/users", Component: C.UserListPage, requiredAny: ["user:manage"], componentProps: { view: "directory" } },
  { id: "users.roles", path: "/roles", Component: C.UserListPage, requiredAny: ["user:manage"], componentProps: { view: "roles" } },
  { id: "users.audit", path: "/audit", Component: C.AuditPage, requiredAny: ["audit:read"] },
  { id: "settings.general", path: "/settings", Component: C.SettingsPage, requiredAny: ["settings:manage"], componentProps: { view: "general" } },
  { id: "settings.integrations", path: "/settings/integrations", Component: C.SettingsPage, requiredAny: ["settings:manage"], componentProps: { view: "integrations" } },
  { id: "settings.llm", path: "/settings/llm", Component: C.SettingsPage, requiredAny: ["settings:manage"], componentProps: { view: "llm" } },
  { id: "models.overview", path: "/settings/providers", Component: C.ModelsPage, requiredAny: ["provider:manage"] },
  { id: "registry.overview", path: "/registry/tools", Component: C.RegistryPage, requiredAny: ["registry:read"], componentProps: { initialKind: "tools" } },
  { id: "registry.rules", path: "/registry/rules", Component: C.RegistryPage, requiredAny: ["registry:read"], componentProps: { initialKind: "rules" } },
  { id: "registry.import", path: "/registry/import", Component: C.RegistryImportPage, requiredAny: ["registry:write"] },
  { id: "registry.context", path: "/registry/context", Component: C.RegistryContextPage, requiredAny: ["registry:read"] },
  { id: "mcp_bridge.overview", path: "/mcp-bridge", Component: C.McpBridgePage, requiredAny: ["workflow:read"] },
  { id: "datafeed.overview", path: "/datafeed", Component: C.DatafeedPage, requiredAny: ["workflow:read"] },
  { id: "datafeed.metrics", path: "/datafeed/metrics", Component: C.VectorMetricsPage, requiredAny: ["workflow:read"] },
  { id: "datafeed.config", path: "/datafeed/configuration", Component: C.PipelineConfigPage, requiredAny: ["workflow:read"] },
  { id: "finetune.overview", path: "/erp-models", Component: C.FinetunePage, requiredAny: ["workflow:read"] },
  { id: "profile.profile", path: "/profile", Component: C.ProfilePage, requiredAny: [] },
  { id: "profile.security", path: "/profile/security", Component: C.SecurityPage, requiredAny: [] },
];

export const navigationRouteIds = NAVIGATION_GROUPS.flatMap((group) =>
  group.subMenu.map((item) => `${group.id}.${item.id}`)
);

function RouteLoading({ name }) {
  return <LoadingState label={`Loading ${name}…`} />;
}

export function ProtectedScreen({ definition }) {
  const { hasAny } = usePermissions();
  const denied = definition.requiredAny?.length && !hasAny(definition.requiredAny);
  const Screen = denied ? C.UnauthorizedPage : definition.Component;

  return (
    <ErrorBoundary name={definition.id}>
      <Suspense fallback={<RouteLoading name={definition.id} />}>
        <Screen {...definition.componentProps} />
      </Suspense>
    </ErrorBoundary>
  );
}

function AuthenticatedRoute() {
  const { isAuthenticated, loading } = useAuthContext();
  const location = useLocation();

  if (loading) {
    return <LoadingState label="Restoring your authenticated session…" />;
  }
  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }
  return <Outlet />;
}

function AppShell() {
  return (
    <RouteProvider>
      <AppLayout>
        <Outlet />
      </AppLayout>
    </RouteProvider>
  );
}

const authPaths = {
  login: "/login",
  register: "/register",
  "forgot-password": "/forgot-password",
};

function PublicScreen(props) {
  const { name } = props;
  const Screen = props.Component;
  const { isAuthenticated } = useAuthContext();
  const location = useLocation();
  const navigate = useNavigate();
  if (isAuthenticated) {
    return <Navigate to={location.state?.from?.pathname || "/"} replace />;
  }
  return (
    <ErrorBoundary name={name}>
      <Suspense fallback={<RouteLoading name={name} />}>
        <Screen onNavigate={(screen) => navigate(authPaths[screen] || "/login")} />
      </Suspense>
    </ErrorBoundary>
  );
}

function StandaloneScreen(props) {
  const { name } = props;
  const Screen = props.Component;
  return (
    <ErrorBoundary name={name}>
      <Suspense fallback={<RouteLoading name={name} />}>
        <Screen />
      </Suspense>
    </ErrorBoundary>
  );
}

const protectedChildren = protectedRouteDefinitions.map((definition) => ({
  ...(definition.path === "/" ? { index: true } : { path: definition.path.slice(1) }),
  element: <ProtectedScreen definition={definition} />,
}));

export const appRouteObjects = [
  {
    element: (
      <ErrorBoundary name="authenticated route">
        <AuthenticatedRoute />
      </ErrorBoundary>
    ),
    children: [
      {
        element: (
          <ErrorBoundary name="application layout">
            <AppShell />
          </ErrorBoundary>
        ),
        children: protectedChildren,
      },
    ],
  },
  { path: "login", element: <PublicScreen Component={C.LoginPage} name="login" /> },
  { path: "register", element: <PublicScreen Component={C.RegisterPage} name="registration" /> },
  { path: "forgot-password", element: <PublicScreen Component={C.ForgotPasswordPage} name="password recovery" /> },
  { path: "unauthorized", element: <StandaloneScreen Component={C.UnauthorizedPage} name="access denied" /> },
  { path: "*", element: <StandaloneScreen Component={C.NotFoundPage} name="not found" /> },
];

export const appRouter = createBrowserRouter(appRouteObjects);
