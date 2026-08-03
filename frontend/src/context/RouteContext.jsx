import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { generatePath, matchPath, useLocation, useNavigate } from "react-router-dom";
import { DEFAULT_ROUTE, NAVIGATION_GROUPS, filterNavigationGroups, getNavigationGroup } from "../constants/navigation";
import usePermissions from "../hooks/usePermissions";

const RouteContext = createContext(null);

function routeFromPath(pathname) {
  for (const group of NAVIGATION_GROUPS) {
    for (const item of group.subMenu) {
      if (matchPath({ path: item.path, end: true }, pathname)) {
        return { main: group.id, sub: item.id };
      }
    }
  }
  if (matchPath("/builder/:workflowId", pathname)) return { main: "workflows", sub: "builder" };
  if (matchPath("/chat/:sessionId", pathname)) return { main: "chat", sub: "session" };
  if (matchPath("/executions/:executionId", pathname)) return { main: "executions", sub: "history" };
  if (pathname === "/registry/rules") return { main: "registry", sub: "overview" };
  return DEFAULT_ROUTE;
}

function workflowIDFromPath(pathname) {
  return (
    matchPath("/workflows/:workflowId", pathname)?.params.workflowId ||
    matchPath("/builder/:workflowId", pathname)?.params.workflowId ||
    ""
  );
}

export function RouteProvider({ children }) {
  const location = useLocation();
  const navigate = useNavigate();
  const route = routeFromPath(location.pathname);
  const pathWorkflowID = workflowIDFromPath(location.pathname);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState(
    () => pathWorkflowID || localStorage.getItem("workflow.selectedWorkflowId") || ""
  );

  const { hasAny, roleId } = usePermissions();

  // The landing path "/" is the dashboard, which not every role may open. Send
  // those roles to their first permitted destination instead of showing them
  // Access denied the moment they sign in. Only the landing is redirected: a
  // directly-typed forbidden URL must still be denied explicitly.
  useEffect(() => {
    if (location.pathname !== "/") return;
    const dashboard = NAVIGATION_GROUPS.find((group) => group.id === DEFAULT_ROUTE.main);
    if (!dashboard?.requiredAny?.length || hasAny(dashboard.requiredAny)) return;
    const permitted = filterNavigationGroups(NAVIGATION_GROUPS, hasAny, roleId)[0]?.subMenu?.[0]?.path;
    if (permitted && permitted !== "/") navigate(permitted, { replace: true });
  }, [location.pathname, hasAny, roleId, navigate]);

  useEffect(() => {
    localStorage.setItem("workflow.activeMain", route.main);
    localStorage.setItem("workflow.activeSub", route.sub);
  }, [route.main, route.sub]);

  useEffect(() => {
    if (!pathWorkflowID) return;
    localStorage.setItem("workflow.selectedWorkflowId", pathWorkflowID);
  }, [pathWorkflowID]);

  const currentWorkflowID = pathWorkflowID || selectedWorkflowId;

  const pathFor = useCallback(
    (main, sub) => {
      const group = getNavigationGroup(main);
      const item = group.subMenu.find((candidate) => candidate.id === sub) || group.subMenu[0];
      if (!item) return "/";
      if (item.path.includes(":workflowId")) {
        return currentWorkflowID
          ? generatePath(item.path, { workflowId: currentWorkflowID })
          : "/workflows";
      }
      if (main === "workflows" && item.id === "builder" && currentWorkflowID) {
        return generatePath("/builder/:workflowId", { workflowId: currentWorkflowID });
      }
      return item.path;
    },
    [currentWorkflowID]
  );

  const navigateTo = useCallback(
    (main, sub) => navigate(pathFor(main, sub)),
    [navigate, pathFor]
  );

  const setActiveMain = useCallback(
    (main) => navigateTo(main, getNavigationGroup(main).subMenu[0]?.id),
    [navigateTo]
  );

  const setActiveSub = useCallback(
    (sub) => navigateTo(route.main, sub),
    [navigateTo, route.main]
  );

  const openWorkflow = useCallback(
    (workflowId) => {
      setSelectedWorkflowId(workflowId);
      localStorage.setItem("workflow.selectedWorkflowId", workflowId);
      navigate(generatePath("/workflows/:workflowId", { workflowId }));
    },
    [navigate]
  );

  const startWorkflow = useCallback(() => {
    setSelectedWorkflowId("");
    localStorage.removeItem("workflow.selectedWorkflowId");
    navigate("/builder");
  }, [navigate]);

  const value = useMemo(
    () => ({
      activeMain: route.main,
      activeSub: route.sub,
      setActiveMain,
      setActiveSub,
      navigateTo,
      selectedWorkflowId: currentWorkflowID,
      openWorkflow,
      startWorkflow,
    }),
    [
      route.main,
      route.sub,
      setActiveMain,
      setActiveSub,
      navigateTo,
      currentWorkflowID,
      openWorkflow,
      startWorkflow,
    ]
  );

  return <RouteContext.Provider value={value}>{children}</RouteContext.Provider>;
}

export function useRoute() {
  const context = useContext(RouteContext);
  if (!context) {
    throw new Error("useRoute must be used within RouteProvider");
  }
  return context;
}
