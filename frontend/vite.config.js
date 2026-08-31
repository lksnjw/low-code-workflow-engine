import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  // Empty prefix ("") loads every var in .env/.env.local, not just VITE_-
  // prefixed ones — needed to read ERP_PIPELINE_API_KEY here (Node/config
  // context only) without ever exposing it to browser code via import.meta.env.
  const env = loadEnv(mode, process.cwd(), "");

  return {
    plugins: [react()],
    build: {
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes("node_modules")) return undefined;
            if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return "react";
            if (id.includes("/node_modules/recharts/") || id.includes("\\node_modules\\recharts\\")) return "recharts";
            if (id.includes("/node_modules/@xyflow/") || id.includes("\\node_modules\\@xyflow\\")) return "xyflow";
            if (id.includes("/node_modules/lucide-react/") || id.includes("\\node_modules\\lucide-react\\")) return "lucide";
            return "vendor";
          },
        },
      },
    },
    server: {
      host: "0.0.0.0",
      port: 5173,
      proxy: {
        // Same-origin BFF proxy for the ERP data-transformation pipeline API.
        // The browser never sees the real base URL or the API key — both are
        // injected here, server-side, from .env.local. Must be registered
        // before the generic "/api" rule below so it wins for this prefix.
        "/api/pipeline": {
          target: env.ERP_PIPELINE_API_URL || "https://erp-data-transformation-api-ju0h8k.azurewebsites.net",
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/pipeline/, ""),
          configure: (proxy) => {
            proxy.on("proxyReq", (proxyReq) => {
              if (env.ERP_PIPELINE_API_KEY) proxyReq.setHeader("X-API-Key", env.ERP_PIPELINE_API_KEY);
            });
          },
        },
        // Proxy all other /api/* and /ws/* requests to the backend — eliminates CORS in dev
        "/api": {
          target: "http://localhost:8081",
          changeOrigin: true,
        },
        "/ws": {
          target: "ws://localhost:8081",
          ws: true,
          changeOrigin: true,
        },
      },
    },
  };
});
