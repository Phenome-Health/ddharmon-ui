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
 *
 * It also carries the VISUAL-REGRESSION gate (tests/e2e/visual.spec.ts): one full-page screenshot per
 * route at a single viewport in the single shipped theme. Baselines are platform-specific (font
 * rasterisation differs), so `snapshotPathTemplate` keeps `{platform}` in the filename and CI runs the
 * suite with `--grep-invert "@visual"` until linux baselines exist.
 *   run:    npm run test:e2e -- --grep "@visual"
 *   update: npm run test:e2e -- --grep "@visual" --update-snapshots
 */
export default defineConfig({
  testDir: "./tests/e2e",
  // Full-page captures of the long content pages plus the chart-settle wait need more than the smoke
  // gate's 30s.
  timeout: 90_000,
  expect: {
    timeout: 10_000,
    toHaveScreenshot: {
      // NOTE: `fullPage` is NOT honoured here — it is a per-call option only, and setting it in the config
      // is silently ignored (which is how the first baseline came out viewport-cropped at 900px). It is
      // passed at the toHaveScreenshot() call site in visual.spec.ts instead.
      animations: "disabled",
      caret: "hide",
      // An ABSOLUTE antialiasing budget, deliberately not `maxDiffPixelRatio`: the ratio is taken against
      // the whole image, and these captures run 900-8000px tall, so 0.2% would hand /methods a ~19k-pixel
      // allowance — enough for a small style regression to slip through unnoticed. Measured with a budget
      // of 0, all 23 routes re-verify with ZERO differing pixels on a fixed platform (Playwright's default
      // `threshold: 0.2` already absorbs subpixel antialiasing), so 100 is pure headroom, not slack.
      // Never raise it to silence a genuinely non-deterministic route — fix the route.
      maxDiffPixels: 100,
      timeout: 30_000,
    },
  },
  // Baselines are per-platform: a macOS capture and a linux capture of the same route legitimately differ.
  // Keeping {platform} in the name lets both live side by side instead of one overwriting the other.
  // `{snapshotDir}` (= testDir) must lead the template: `{testFileDir}` is RELATIVE to testDir and is
  // empty for a spec sitting directly in it, which resolves to an absolute "/visual.spec.ts-snapshots".
  snapshotPathTemplate: "{snapshotDir}/{testFileDir}/{testFileName}-snapshots/{arg}-{platform}{ext}",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://localhost:4173",
    trace: "on-first-retry",
    // Desktop-only product (>=1280px), so the visual contract is ONE screenshot per route: one
    // viewport, one browser. Pinned here so every baseline shares it.
    viewport: { width: 1440, height: 900 },
    // PINNED, not inherited. Playwright's default happens to be "light", so every baseline has been an
    // implicitly light capture — harmless while nothing on the page answered the media query. The
    // staged-review preview now ships a light/dark pair driven by `prefers-color-scheme`, so leaving
    // this to a default would let a baseline flip theme because of the ENVIRONMENT rather than because
    // of a change — a screenshot gate that reports the wrong thing. When the SPA itself gains the
    // theme pair, dark gets its own project rather than replacing this one.
    colorScheme: "light",
  },
  // The viewport is re-declared AFTER the device spread: `devices["Desktop Chrome"]` carries its own
  // 1280x720 viewport and project-level `use` outranks the top-level one, so omitting it here would
  // silently baseline every route 160px narrower than the contract.
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
  ],
  webServer: {
    // Build in static mode, then serve the dist with vite preview on a fixed port.
    command: "VITE_STATIC=1 npm run build && npm run serve -- --port 4173 --strictPort",
    url: "http://localhost:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
