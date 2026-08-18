import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, request as playwrightRequest, test } from "@playwright/test";
import { VISUAL_ROUTES, type VisualRoute } from "./routes";

/**
 * Visual-regression gate — one full-page screenshot per route at 1440x900 in the single shipped theme.
 *
 * This is the retheme's safety net (08 D-08): the baseline is captured and committed BEFORE any design
 * token changes, so every token diff can be reviewed route-by-route instead of shipping blind. It runs
 * against the STATIC build (VITE_STATIC=1), whose only data source is the bundled public demo fixtures —
 * no backend, no Clerk keys, no paid harmonization run, and no internal cohort data in any baseline PNG.
 *
 *   run:     npm run test:e2e -- --grep "@visual"
 *   update:  npm run test:e2e -- --grep "@visual" --update-snapshots
 *
 * Accepting a snapshot diff is a DESIGN DECISION. Review each changed image individually; never bulk-approve.
 */

// Recharts/react-smooth animate in JS, which Playwright's `animations: "disabled"` (CSS-only) cannot stop.
// Settle for longer than the default chart animation before capturing, so charts are baselined at rest.
const SETTLE_MS = 1800;

/** Layout viewport: 1440x900 desktop, matching playwright.config.ts. */
const VIEWPORT_WIDTH = 1440;
const LAYOUT_HEIGHT = 900;
/** Hard ceiling on capture height, so one runaway page cannot commit a 20MB baseline. */
const MAX_CAPTURE_HEIGHT = 8000;

/**
 * Grow the viewport to the page's content height so the baseline covers the WHOLE page, not just the fold.
 *
 * Playwright's `fullPage: true` captures the DOCUMENT's scroll height — but `AppShell` is
 * `h-screen … overflow-hidden` wrapping an inner `<main class="overflow-y-auto">`, so the document is
 * pinned to the viewport and content scrolls INSIDE main. `fullPage` is therefore a no-op here, and a
 * 900px baseline would certify only the top of every long content page — precisely the below-the-fold
 * retheme diff this gate exists to catch. Width stays 1440 (the responsive breakpoints are width-based),
 * so the render is the real desktop layout, just unclipped vertically.
 *
 * @returns the capture height actually used.
 */
async function growViewportToContent(page: import("@playwright/test").Page): Promise<number> {
  const measure = () =>
    page.evaluate(() => {
      const main = document.querySelector("main");
      const doc = document.documentElement;
      if (!main) return doc.scrollHeight;
      // Chrome outside the scroll container (the top bar) + everything inside it.
      return Math.ceil(main.scrollHeight + (doc.scrollHeight - main.clientHeight));
    });

  let height = LAYOUT_HEIGHT;
  // Two passes: growing the viewport can reflow content (charts re-measure), changing the needed height.
  for (let pass = 0; pass < 2; pass++) {
    const wanted = Math.min(Math.max(await measure(), LAYOUT_HEIGHT), MAX_CAPTURE_HEIGHT);
    if (wanted <= height) break;
    height = wanted;
    await page.setViewportSize({ width: VIEWPORT_WIDTH, height });
    await page.waitForTimeout(SETTLE_MS);
  }
  return height;
}

/** Resolved once per worker: the concrete demo job id backing the `/job/:jobId/*` baselines. */
let jobIdPromise: Promise<string> | null = null;

async function resolveJobId(baseURL: string | undefined): Promise<string> {
  if (!jobIdPromise) {
    jobIdPromise = (async () => {
      const ctx = await playwrightRequest.newContext({ baseURL });
      try {
        const res = await ctx.get("/static-data/jobs.json");
        expect(
          res.ok(),
          "frontend/public/static-data/jobs.json must be served by the static build — a missing fixture is a SETUP problem, not a rendering regression",
        ).toBeTruthy();
        const data: unknown = await res.json();
        const jobs = (Array.isArray(data) ? data : ((data as { jobs?: unknown[] }).jobs ?? [])) as {
          jobId?: string;
          status?: string;
        }[];
        const job = jobs.find((j) => j.status === "complete") ?? jobs[0];
        expect(
          job?.jobId,
          "frontend/public/static-data/jobs.json must ship at least one demo job for the /job/:jobId/* baselines",
        ).toBeTruthy();
        return job!.jobId!;
      } finally {
        await ctx.dispose();
      }
    })();
  }
  return jobIdPromise;
}

async function urlFor(route: VisualRoute, baseURL: string | undefined): Promise<string> {
  const resolved = route.needsJobFixture
    ? route.path.replace(":jobId", await resolveJobId(baseURL))
    : route.path;
  return `${resolved}${route.query ?? ""}`;
}

for (const route of VISUAL_ROUTES) {
  test(`@visual ${route.name} (${route.path}) matches its baseline`, async ({ page, baseURL }, testInfo) => {
    await page.goto(await urlFor(route, baseURL));
    // Fonts must be loaded before capture or the first run baselines fallback metrics.
    await page.evaluate(() => document.fonts.ready);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(SETTLE_MS);
    const height = await growViewportToContent(page);
    testInfo.annotations.push({ type: "capture", description: `${VIEWPORT_WIDTH}x${height}` });
    // `fullPage` must be passed HERE: as an `expect.toHaveScreenshot` config key it is silently dropped.
    await expect(page).toHaveScreenshot(`${route.name}.png`, { fullPage: true });
  });
}

test("@visual every route registered in App.tsx has a VISUAL_ROUTES entry", () => {
  // Resolved from THIS spec's own path (frontend/tests/e2e/) rather than cwd or config.rootDir — those
  // point elsewhere depending on where the runner was invoked from.
  const appTsx = path.resolve(path.dirname(test.info().file), "..", "..", "src", "App.tsx");
  expect(existsSync(appTsx), `expected the app route table at ${appTsx}`).toBe(true);

  // Every `<Route path="…">` in the <Switch>. The bare `<Route>` fallback has no path attribute and is
  // covered by the VISUAL_ROUTES entry with `registered: false`.
  const registered = [...readFileSync(appTsx, "utf8").matchAll(/<Route\s+path="([^"]+)"/g)].map((m) => m[1]);
  expect(registered.length, "failed to parse any <Route path=…> out of src/App.tsx").toBeGreaterThan(0);

  const covered = new Set(VISUAL_ROUTES.map((r) => r.path));
  const missing = registered.filter((p) => !covered.has(p));
  expect(
    missing,
    `route(s) registered in src/App.tsx with no visual baseline — add them to tests/e2e/routes.ts: ${missing.join(", ")}`,
  ).toEqual([]);

  // And the reverse: a VISUAL_ROUTES entry claiming to be registered but absent from App.tsx is a stale
  // baseline that would silently keep passing against a dead route.
  const stale = VISUAL_ROUTES.filter((r) => r.registered !== false && !registered.includes(r.path)).map(
    (r) => r.path,
  );
  expect(
    stale,
    `tests/e2e/routes.ts lists route(s) that src/App.tsx no longer registers: ${stale.join(", ")}`,
  ).toEqual([]);
});
