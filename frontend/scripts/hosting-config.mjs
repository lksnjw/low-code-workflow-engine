import { createAppConfig, validateEndpoint } from "../src/config/endpoints.js";

export const PUBLIC_KEYS = new Set(["VITE_APP_NAME", "VITE_API_BASE_URL", "VITE_WS_BASE_URL", "VITE_ANALYTICS_ENABLED", "VITE_API_REQUEST_TIMEOUT_MS", "VITE_PROGRESS_TRANSPORT"]);
const ICON_ORIGINS = ["https://api.iconify.design", "https://api.simplesvg.com", "https://api.unisvg.com"];

export function hostingBindings(env) {
  for (const key of Object.keys(env)) if (key.startsWith("VITE_") && !PUBLIC_KEYS.has(key) && env[key] !== "") throw new Error("Unreviewed public Vite variable: hosting build refused");
  const emulatorOnly = env.LCWE_HOSTING_EMULATOR === "1";
  const projectId = env.LCWE_FIREBASE_PROJECT_ID || (emulatorOnly ? "demo-lcwe-hosting" : "");
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId) || emulatorOnly !== projectId.startsWith("demo-")) throw new Error("Explicit matching Firebase project identity required");
  const apiBaseUrl = validateEndpoint(env.VITE_API_BASE_URL, { kind: "API", allowLoopback: emulatorOnly });
  const pollingOnly = env.VITE_PROGRESS_TRANSPORT === "http-polling";
  if (pollingOnly && env.VITE_WS_BASE_URL) throw new Error("HTTP polling cannot advertise a WebSocket endpoint");
  const wsBaseUrl = pollingOnly ? null : validateEndpoint(env.VITE_WS_BASE_URL, { kind: "WebSocket", allowLoopback: emulatorOnly });
  if (!new URL(apiBaseUrl).pathname.endsWith("/api") || wsBaseUrl && !new URL(wsBaseUrl).pathname.endsWith("/ws")) throw new Error("Expected backend /api and, when applicable, /ws bindings");
  if (emulatorOnly && (![apiBaseUrl, wsBaseUrl].filter(Boolean).every(value => new Set(["127.0.0.1", "localhost", "[::1]"]).has(new URL(value).hostname)))) throw new Error("Emulator artifacts require loopback backends only");
  if (env.VITE_APP_NAME && (env.VITE_APP_NAME.length > 128 || /[\r\n]/.test(env.VITE_APP_NAME))) throw new Error("Invalid public app name");
  if (env.VITE_ANALYTICS_ENABLED && !["true", "false"].includes(env.VITE_ANALYTICS_ENABLED)) throw new Error("Invalid public analytics flag");
  const publicEnv = Object.fromEntries([...PUBLIC_KEYS].filter(key => env[key] !== undefined).map(key => [key, env[key]]));
  publicEnv.VITE_API_BASE_URL = apiBaseUrl;
  if (wsBaseUrl) publicEnv.VITE_WS_BASE_URL = wsBaseUrl;
  else delete publicEnv.VITE_WS_BASE_URL;
  return { profile: "firebase-hosting-bindings/v1", projectId, emulatorOnly, publicEnv, config: createAppConfig({ ...publicEnv, MODE: "hosting", DEV: false }) };
}

export function generateHostingConfig(base, bindings) {
  const config = structuredClone(base);
  if (config.hosting.public !== "frontend/dist" || config.hosting.rewrites.length !== 1 || config.hosting.rewrites[0].destination !== "/index.html") throw new Error("Unexpected reviewed hosting template");
  config.hosting.public = "public";
  config.hosting.predeploy = ["node ../scripts/verify-hosting-artifact.mjs"];
  const origins = [...new Set([...ICON_ORIGINS, new URL(bindings.config.apiBaseUrl).origin,
    ...(bindings.config.wsBaseUrl ? [new URL(bindings.config.wsBaseUrl).origin] : [])])];
  const csp = config.hosting.headers[0].headers.find(header => header.key === "Content-Security-Policy");
  csp.value = csp.value.replace(/connect-src [^;]+/, `connect-src 'self' ${origins.join(" ")}`);
  return config;
}
