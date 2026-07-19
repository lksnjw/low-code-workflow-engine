const env = import.meta.env ?? {};

export const appConfig = {
  name: env.VITE_APP_NAME ?? "Agentic Workflow Engine",
  version: "0.1.0",
  apiBaseUrl: env.VITE_API_BASE_URL ?? "http://localhost:8080/api",
  wsBaseUrl: env.VITE_WS_BASE_URL ?? "ws://localhost:8080/ws",
  analyticsEnabled: env.VITE_ANALYTICS_ENABLED === "true",
};
