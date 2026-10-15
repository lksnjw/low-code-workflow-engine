import { defineConfig } from "vite";
import applicationConfig from "./vite.config.js";
// Isolated local UI verification; never inherits deployment .env files.
export default defineConfig(environment => {
  const base = applicationConfig(environment);
  return { ...base, envDir: false, envPrefix: "LCWE_USER_ERP_QA_", server: { host: "127.0.0.1", port: 5197, strictPort: true,
    proxy: { "/api": { target: "http://127.0.0.1:18196", changeOrigin: true }, "/ws": { target: "ws://127.0.0.1:18196", ws: true, changeOrigin: true } } } };
});
