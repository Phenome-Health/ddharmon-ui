import { defineConfig, devices } from "@playwright/test";

/**
 * ddharmon-ui end-to-end smoke gate.
 *
 * Runs against a STATIC build (VITE_STATIC=1): the app reads bundled
 * `public/static-data/*.json` fixtures instead of `/api`, and auth is off in
 * static builds — so this gate needs NO backend, NO Clerk keys, and NO paid
 * harmonization run. It exercises the real render path end to end against the
 * shipped demo fixtures, which is exactly what makes it cheap enough to run on
 * every UI change (the trust gate that lets a change go build → green → review).
 *
 * Local:  npm run test:e2e
 * CI:     set CI=1 (uses the github reporter, no server reuse).
 */
export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://localhost:4173",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // Build in static mode, then serve the dist with vite preview on a fixed port.
    command: "VITE_STATIC=1 npm run build && npm run serve -- --port 4173 --strictPort",
    url: "http://localhost:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
