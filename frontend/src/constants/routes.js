import { features } from "../config/features";

export const ROUTES = {
  dashboard: "/dashboard",
  workflows: "/workflows",
  workflowBuilder: "/workflows/builder",
  chat: "/chat",
  executions: "/executions",
  analytics: "/analytics",
  users: "/users",
  settings: "/settings",
  ...(features.mcpBridge ? { mcpBridge: "/mcp-bridge" } : {}),
  ...(features.datafeed ? { datafeed: "/datafeed" } : {}),
  finetune: "/finetune",
  profile: "/profile",
};
