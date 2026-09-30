import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

// Standalone (non-monorepo) Vite app. In dev, /api is proxied to the FastAPI
// backend (default http://localhost:8000) so the EventSource("/api/...") calls
// work without CORS. In prod, FastAPI serves the built dist/ and same-origin /api.
const apiTarget = process.env.API_PROXY_TARGET || "http://localhost:8000";
// A STATIC build (VITE_STATIC=1) is backend-less by definition, so its preview proxies /api NOWHERE. Vite's
// `preview.proxy` defaults to `server.proxy`, which sent the static e2e gate's unrouted /api calls to whatever
// listened on :8000 — on a developer machine, a live rig (08-28). Unproxied, they answer the preview server's
// own 404, which the client reports as the static preview, exactly as on CI where nothing listens there.
const isStatic = process.env.VITE_STATIC === "1";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "src") },
    dedupe: ["react", "react-dom"],
  },
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    port: Number(process.env.PORT) || 5173,
    host: "0.0.0.0",
    proxy: { "/api": { target: apiTarget, changeOrigin: true } },
  },
  preview: { port: Number(process.env.PORT) || 5173, host: "0.0.0.0", proxy: isStatic ? {} : undefined },
});
