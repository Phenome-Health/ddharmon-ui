import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import { execSync } from "child_process";
import { uiTreeStamp } from "./src/lib/build-stamp";

// Standalone (non-monorepo) Vite app. In dev, /api is proxied to the FastAPI
// backend (default http://localhost:8000) so the EventSource("/api/...") calls
// work without CORS. In prod, FastAPI serves the built dist/ and same-origin /api.
const apiTarget = process.env.API_PROXY_TARGET || "http://localhost:8000";
// A STATIC build (VITE_STATIC=1) is backend-less by definition, so its preview proxies /api NOWHERE. Vite's
// `preview.proxy` defaults to `server.proxy`, which sent the static e2e gate's unrouted /api calls to whatever
// listened on :8000 — on a developer machine, a live rig (08-28). Unproxied, they answer the preview server's
// own 404, which the client reports as the static preview, exactly as on CI where nothing listens there.
const isStatic = process.env.VITE_STATIC === "1";

// The git tree this bundle is built from, `+dirty` when tracked files differ (`src/lib/build-stamp.ts`). Read at build
// time so the dev box's build and the Lavish review build each name the content they were made from. Null outside git.
function gitTree(): string | null {
  try {
    const tree = execSync("git rev-parse HEAD^{tree}", { cwd: import.meta.dirname, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    const dirty =
      execSync("git status --porcelain --untracked-files=no", { cwd: import.meta.dirname, stdio: ["ignore", "pipe", "ignore"] })
        .toString()
        .trim() !== "";
    return uiTreeStamp(tree, dirty);
  } catch {
    return null;
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: { __UI_TREE__: JSON.stringify(gitTree()) },
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
