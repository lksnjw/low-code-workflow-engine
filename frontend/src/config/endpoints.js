const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

// Public routing identifiers only. Never accept credentials, query tokens,
// fragments, wildcard origins, or protocol-relative URLs in a browser build.
export function validateEndpoint(value, { kind, origin, allowRelative = false, allowLoopback = true } = {}) {
  if (typeof value !== "string" || !value.trim() || value.length > 2048 || /[\\\s*]/.test(value)) throw new Error(`Invalid ${kind} endpoint`);
  const relative = value.startsWith("/");
  if (relative && (!allowRelative || value.startsWith("//"))) throw new Error(`Invalid ${kind} endpoint`);
  let url;
  try { url = new URL(value, origin); } catch { throw new Error(`Invalid ${kind} endpoint`); }
  const secure = kind === "API" ? "https:" : "wss:";
  const insecure = kind === "API" ? "http:" : "ws:";
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== secure && !(url.protocol === insecure && allowLoopback && LOOPBACK.has(url.hostname))) ||
      (relative && url.origin !== new URL(origin).origin)) throw new Error(`Invalid ${kind} endpoint`);
  return relative ? url.pathname.replace(/\/$/, "") || "/" : url.href.replace(/\/$/, "");
}

export function createAppConfig(env = {}, browserOrigin = "http://localhost") {
  const apiRequestTimeoutMs = Number(env.VITE_API_REQUEST_TIMEOUT_MS ?? 90000);
  if (!Number.isInteger(apiRequestTimeoutMs) || apiRequestTimeoutMs < 1000 || apiRequestTimeoutMs > 300000)
    throw new Error("VITE_API_REQUEST_TIMEOUT_MS must be between 1000 and 300000 ms");
  const apiBaseUrl = validateEndpoint(env.VITE_API_BASE_URL ?? "/api", { kind: "API", origin: browserOrigin, allowRelative: true });
  const apiOrigin = new URL(apiBaseUrl, browserOrigin).origin;
  const pollingOnly = env.VITE_PROGRESS_TRANSPORT === "http-polling";
  if (env.VITE_PROGRESS_TRANSPORT && !pollingOnly) throw new Error("Unsupported progress transport");
  if (pollingOnly && env.VITE_WS_BASE_URL) throw new Error("HTTP polling cannot advertise a WebSocket endpoint");
  const wsBaseUrl = pollingOnly ? null : validateEndpoint(env.VITE_WS_BASE_URL ?? `${apiOrigin.replace(/^http/, "ws")}/ws`, { kind: "WebSocket", origin: browserOrigin });
  return Object.freeze({
    name: env.VITE_APP_NAME ?? "Agentic Workflow Engine",
    version: "0.1.0", apiBaseUrl, wsBaseUrl, apiRequestTimeoutMs,
    analyticsEnabled: env.VITE_ANALYTICS_ENABLED === "true",
    // This controls only route visibility. Every request still terminates at
    // the authenticated backend and requires the server-side pipeline:upload
    // permission; no pipeline endpoint or credential enters the browser build.
    pipelineUploadEnabled: env.VITE_PIPELINE_UPLOAD_ENABLED !== "false",
  });
}
