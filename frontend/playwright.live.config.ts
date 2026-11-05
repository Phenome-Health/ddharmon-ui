import { defineConfig, devices } from "@playwright/test";

/**
 * The LIVE Playwright project (08-28 Wave 0): the display invariants of the verify loop, asserted against a REAL
 * run on the rig backend — never against the static fixtures, and never starting a server of its own.
 *
 * Separate from `playwright.config.ts` on purpose. That suite builds a STATIC dist into `frontend/dist` as its
 * webServer; run in the rig's worktree it would swap the rig's live UI for fixtures mid-iteration. This config
 * has no webServer at all: it only reads what the rig at `LIVE_BASE_URL` serves.
 *
 *   LIVE_BASE_URL=http://127.0.0.1:8018 LIVE_JOB=<jobId> LIVE_STAGE=gate3 \
 *     npx playwright test --config playwright.live.config.ts
 *
 * `LIVE_STAGE` names where the run is (gate1 | gate2 | gate3 | gate4 | inflight); each spec skips the stages it
 * does not apply to, so the driver (`scripts/live_verify.py --playwright`) runs the whole project at every stop.
 */
export default defineConfig({
  testDir: "./tests/live",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["json", { outputFile: `${process.env.LIVE_OUT ?? "test-results"}/playwright-${process.env.LIVE_STAGE ?? "any"}.json` }]],
  use: {
    baseURL: process.env.LIVE_BASE_URL ?? "http://127.0.0.1:8018",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    viewport: { width: 1440, height: 900 },
    colorScheme: "light",
  },
  outputDir: `${process.env.LIVE_OUT ?? "test-results"}/playwright-${process.env.LIVE_STAGE ?? "any"}`,
  projects: [{ name: "live", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
});
