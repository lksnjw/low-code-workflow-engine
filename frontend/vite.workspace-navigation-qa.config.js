import { defineConfig } from "vite";
import applicationConfig from "./vite.config.js";
// Isolated local UI verification; no deployment env files or hosted services.
export default defineConfig(environment => ({ ...applicationConfig(environment), envDir: false, envPrefix: "LCWE_WORKSPACE_NAV_QA_",
  server: { host: "127.0.0.1", port: 5198, strictPort: true, proxy: { "/api": { target: "http://127.0.0.1:8081", changeOrigin: true }, "/ws": { target: "ws://127.0.0.1:8081", ws: true, changeOrigin: true } } },
}));
