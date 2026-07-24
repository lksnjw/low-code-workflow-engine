export const NAVIGATION_GROUPS = [
  {
    id: "dashboard",
    label: "Dashboard",
    description: "Operational overview",
    icon: "mdi:chart-pie",
		requiredAny: ["workflow:read"],
    subMenu: [
      { id: "overview", label: "Overview" },
      { id: "activity", label: "Activity" },
    ],
  },
  {
    id: "workflows",
    label: "Workflows",
    description: "Blueprints and builder",
    icon: "tabler:git-branch",
		clientLabel: "My Workflows",
		requiredAny: ["workflow:read", "workflow:read_own"],
    subMenu: [
      { id: "list", label: "All Workflows", clientLabel: "My Workflows", requiredAny: ["workflow:read", "workflow:read_own"] },
      { id: "builder", label: "Flow Builder", requiredAny: ["workflow:write"] },
      { id: "templates", label: "Templates", requiredAny: ["workflow:read"] },
      { id: "detail", label: "Runbook Detail", requiredAny: ["workflow:read", "workflow:read_own"] },
    ],
  },
  {
    id: "chat",
    label: "Agent Chat",
    description: "Natural language synthesis",
    icon: "hugeicons:ai-magic",
		clientLabel: "Chat",
		requiredAny: ["chat:use", "workflow:write"],
    subMenu: [
      { id: "session", label: "Synthesis Chat" },
      { id: "history", label: "Chat History" },
    ],
  },
  {
    id: "executions",
    label: "Executions",
    description: "Runs, logs, and healing",
    icon: "mdi:play-circle-outline",
		clientLabel: "My Executions",
		requiredAny: ["workflow:read", "execution:read_own"],
    subMenu: [
      { id: "history", label: "Run History" },
      { id: "live", label: "Live Logs", hasNotification: true },
      { id: "healing", label: "Healing Events" },
    ],
  },
  {
    id: "analytics",
    label: "Analytics",
    description: "Performance and cost",
    icon: "mdi:chart-bar",
		requiredAny: ["workflow:read"],
    subMenu: [
      { id: "performance", label: "Performance" },
      { id: "usage", label: "Usage & Cost" },
      { id: "healing", label: "Self-Healing" },
    ],
  },
  {
    id: "users",
    label: "Users",
    description: "Roles and audit trails",
    icon: "solar:users-group-rounded-linear",
		requiredAny: ["user:manage", "audit:read"],
    subMenu: [
      { id: "directory", label: "Directory" },
      { id: "roles", label: "Roles" },
      { id: "audit", label: "Audit Logs" },
    ],
  },
  {
    id: "settings",
    label: "Settings",
    description: "Platform configuration",
    icon: "mdi:cog-outline",
		requiredAny: ["settings:manage"],
    subMenu: [
      { id: "general", label: "General" },
      { id: "integrations", label: "Integrations" },
      { id: "llm", label: "LLM Policy" },
    ],
  },
  {
    id: "models",
    label: "Models",
    description: "Runtime generation providers",
    icon: "mdi:brain",
    requiredAny: ["provider:manage"],
    subMenu: [{ id: "overview", label: "Provider Configs" }],
  },
  {
    id: "registry",
    label: "Registry",
    description: "Tool schemas and policy rules",
    icon: "mdi:book-cog-outline",
    requiredAny: ["registry:read"],
    subMenu: [{ id: "overview", label: "Tools & Rules" }],
  },
  {
    id: "mcp_bridge",
    label: "MCP Bridge",
    description: "ERP bridge integration",
    icon: "mdi:lan-connect",
		requiredAny: ["workflow:read"],
    subMenu: [{ id: "overview", label: "Bridge Overview", path: "/mcp-bridge" }],
  },
  {
    id: "datafeed",
    label: "Datafeed",
    description: "Vector DB & Pipeline",
    icon: "mdi:database-sync-outline",
		requiredAny: ["workflow:read"],
    subMenu: [
      { id: "overview", label: "Pipeline Status" },
      { id: "metrics", label: "Vector Metrics" },
      { id: "config", label: "Configuration" }
    ],
  },
  {
    id: "finetune",
    label: "ERP Models",
    description: "ERP data & queries",
    icon: "mdi:robot-industrial",
		requiredAny: ["workflow:read"],
    subMenu: [{ id: "overview", label: "Model Integration", path: "/finetune" }],
  },
  {
    id: "profile",
    label: "Profile",
    description: "Account and security",
    icon: "solar:user-linear",
    subMenu: [
      { id: "profile", label: "My Profile" },
      { id: "security", label: "Security" },
    ],
  },
];

export const DEFAULT_ROUTE = {
  main: "dashboard",
  sub: "overview",
};

export const getNavigationGroup = (id) =>
  NAVIGATION_GROUPS.find((group) => group.id === id) ?? NAVIGATION_GROUPS[0];

export function filterNavigationGroups(groups, hasAny, roleId) {
  return groups
    .filter((group) => !group.requiredAny?.length || hasAny(group.requiredAny))
    .map((group) => {
      const subMenu = group.subMenu.filter(
        (item) => !item.requiredAny?.length || hasAny(item.requiredAny)
      );
      return {
        ...group,
        label: roleId === "role_client" && group.clientLabel ? group.clientLabel : group.label,
        subMenu: subMenu.map((item) => ({
          ...item,
          label: roleId === "role_client" && item.clientLabel ? item.clientLabel : item.label,
        })),
      };
    })
    .filter((group) => group.subMenu.length > 0);
}

export function resolvePermittedRoute(groups, hasAny, roleId, requested = DEFAULT_ROUTE) {
  const visibleGroups = filterNavigationGroups(groups, hasAny, roleId);
  const requestedGroup = visibleGroups.find((group) => group.id === requested?.main);
  const requestedSub = requestedGroup?.subMenu.find((item) => item.id === requested?.sub);
  if (requestedGroup && requestedSub) {
    return { main: requestedGroup.id, sub: requestedSub.id };
  }

  const fallbackGroup = visibleGroups[0];
  const fallbackSub = fallbackGroup?.subMenu[0];
  if (!fallbackGroup || !fallbackSub) return null;
  return { main: fallbackGroup.id, sub: fallbackSub.id };
}
