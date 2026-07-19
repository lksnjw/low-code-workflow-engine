import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { DEFAULT_ROUTE, getNavigationGroup } from "../constants/navigation";

const RouteContext = createContext(null);

function getInitialRoute() {
  const savedMain = localStorage.getItem("workflow.activeMain");
  const savedSub = localStorage.getItem("workflow.activeSub");
  const group = savedMain ? getNavigationGroup(savedMain) : null;

  if (group?.id === savedMain) {
    return {
      main: savedMain,
      sub: group.subMenu.some((item) => item.id === savedSub)
        ? savedSub
        : group.subMenu[0]?.id,
    };
  }

  return DEFAULT_ROUTE;
}

export function RouteProvider({ children }) {
  const [initialRoute] = useState(getInitialRoute);
  const [activeMain, setActiveMain] = useState(initialRoute.main);
  const [activeSub, setActiveSub] = useState(initialRoute.sub);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState(() => localStorage.getItem("workflow.selectedWorkflowId"));

  useEffect(() => {
    localStorage.setItem("workflow.activeMain", activeMain);
    localStorage.setItem("workflow.activeSub", activeSub);
  }, [activeMain, activeSub]);

  const navigateTo = useCallback((main, sub) => {
    const group = getNavigationGroup(main);
    setActiveMain(group.id);
    setActiveSub(sub ?? group.subMenu[0]?.id);
  }, []);

  const openWorkflow = useCallback((workflowId) => {
    setSelectedWorkflowId(workflowId);
    localStorage.setItem("workflow.selectedWorkflowId", workflowId);
    navigateTo("workflows", "detail");
  }, [navigateTo]);

  const value = useMemo(
    () => ({
      activeMain,
      activeSub,
      setActiveMain,
      setActiveSub,
      navigateTo,
      selectedWorkflowId,
      openWorkflow,
    }),
    [activeMain, activeSub, navigateTo, selectedWorkflowId, openWorkflow]
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
