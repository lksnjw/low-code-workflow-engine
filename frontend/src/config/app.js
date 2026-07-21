const env = import.meta.env ?? {};
const browserOrigin = typeof window === "undefined" ? "http://localhost" : window.location.origin;
const websocketOrigin = browserOrigin.replace(/^http/, "ws");

export const appConfig = {
  name: env.VITE_APP_NAME ?? "Agentic Workflow Engine",
  version: "0.1.0",
  apiBaseUrl: env.VITE_API_BASE_URL ?? "/api",
  wsBaseUrl: env.VITE_WS_BASE_URL ?? `${websocketOrigin}/ws`,
  analyticsEnabled: env.VITE_ANALYTICS_ENABLED === "true",
};
