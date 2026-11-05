import { expect, test } from "@playwright/test";

/**
 * The static e2e gate is BACKEND-LESS — enforced by config, not by every spec remembering to route (08-28).
 *
 * The gates' paid calls try their request even in a static build (the seam `page.route` fulfils), so an UNROUTED
 * one leaves the page. Vite's `preview.proxy` defaults to `server.proxy`, which forwards /api to :8000 — on a
 * developer machine, possibly a live rig with a server key. Found when Continue gained the seam: a spec that did
 * not route it reached :8000 instead of reporting the static preview. With VITE_STATIC=1 the preview proxies
 * nothing, and the gate's webServer passes VITE_STATIC=1 to the serve step as well as the build.
 *
 * Asserted on the CONFIG in node, not by sending a request: a guard whose failure mode is contacting that port is
 * the wrong guard.
 *
 *   run: E2E_PORT=4213 npx playwright test static-backendless
 */
test("@static a static build's preview proxies /api nowhere, and the e2e gate serves it as static", async () => {
  process.env.VITE_STATIC = "1";
  const { default: vite } = (await import("../../vite.config.ts")) as {
    default: { preview?: { proxy?: unknown }; server?: { proxy?: unknown } };
  };
  expect(vite.preview?.proxy).toEqual({});
  // The dev server keeps its proxy: that one is meant to reach the local backend.
  expect(vite.server?.proxy).toHaveProperty("/api");

  const { default: pw } = (await import("../../playwright.config.ts")) as {
    default: { webServer?: { command?: string } };
  };
  expect(pw.webServer?.command).toMatch(/VITE_STATIC=1 npm run build && VITE_STATIC=1 npm run serve/);
});
