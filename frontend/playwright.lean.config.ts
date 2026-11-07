import { defineConfig, devices } from "@playwright/test";

/**
 * The LEAN-SITE gate: the smoke gate's static build, built with VITE_HIDDEN_PAGES set to prod's list.
 *
 * Prod (ddharmon.io) runs dev's code with six content pages left out at BUILD time (`src/lib/hidden-pages.ts`).
 * A build flag cannot be flipped inside one bundle, so this is its own config with its own build — into
 * `dist-lean`, so it never overwrites the default gate's `dist` — on its own port.
 *
 * `reuseExistingServer: false`, unlike the default gate: attaching to a server someone else left on this port
 * would test THEIR bundle, with or without the flag, and report green either way.
 *
 * Run:  npm run test:lean
 */
const PORT = Number(process.env.E2E_LEAN_PORT) || 4193;
// Keep in step with prod's frontend/.env on the box.
const HIDDEN_PAGES = "methods,benchmarks,design,roadmap,architecture,phenome";

export default defineConfig({
  testDir: "./tests/lean",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL: `http://localhost:${PORT}`, colorScheme: "light" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
  webServer: {
    command:
      `VITE_STATIC=1 VITE_HIDDEN_PAGES=${HIDDEN_PAGES} npx vite build --outDir dist-lean && ` +
      `VITE_STATIC=1 npx vite preview --outDir dist-lean --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
