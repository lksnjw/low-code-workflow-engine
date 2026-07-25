import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
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
      // Proxy all /api/* and /ws/* requests to the backend — eliminates CORS in dev
      "/api": {
        target: "http://localhost:8080",
        changeOrigin: true,
      },
      "/ws": {
        target: "ws://localhost:8080",
        ws: true,
        changeOrigin: true,
      },
    },
  },
});
