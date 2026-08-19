/**
 * The single source of truth for which routes the visual-regression baseline covers.
 *
 * `visual.spec.ts` iterates this list — it hardcodes no paths — and a guard test in the same file
 * reads `src/App.tsx` and fails naming any registered route missing from here. So adding a route to
 * the app without a baseline is a visible omission in ONE file, not a silent gap.
 */

export interface VisualRoute {
  /** Stable snapshot filename stem. Renaming this orphans the committed baseline — don't. */
  name: string;
  /**
   * The route template EXACTLY as registered in `src/App.tsx` (including `:jobId`), so the coverage
   * guard can string-match it. `registered: false` entries carry a literal unregistered path instead.
   */
  path: string;
  /** Query string appended when navigating (not part of the coverage match). */
  query?: string;
  /** `:jobId` is substituted with the first complete demo job from `/static-data/jobs.json`. */
  needsJobFixture?: boolean;
  /**
   * Present in `App.tsx`'s `<Switch>` route table. Defaults to true; only the 404 fallback is false —
   * it is reached by a path registered nowhere, which is the whole point of the test.
   */
  registered?: boolean;
}

/**
 * 22 routes + the 404 fallback = 23 baselines, taken from `src/App.tsx`'s `<Switch>` — NOT from
 * CONTEXT.md's stale 15-route list. 08-UI-SPEC §12 names `/roadmap/staged-review`; on this branch the
 * staged-review preview is registered at `/preview/staged-review`, so that is what is baselined.
 */
export const VISUAL_ROUTES: VisualRoute[] = [
  { name: "landing", path: "/" },
  // Required by §12: the only route with <select>/<input> controls on a paper card, so a wrong
  // `color-scheme` value shows up as a native-control diff here and nowhere else.
  { name: "new-run", path: "/new" },
  { name: "guide", path: "/guide" },
  { name: "methods", path: "/methods" },
  { name: "benchmarks", path: "/benchmarks" },
  { name: "design", path: "/design" },
  { name: "demo", path: "/demo" },
  { name: "related", path: "/related" },
  { name: "roadmap", path: "/roadmap" },
  { name: "architecture", path: "/architecture" },
  { name: "preview-restructure", path: "/preview/restructure" },
  { name: "preview-payoff", path: "/preview/payoff" },
  { name: "preview-composite", path: "/preview/composite" },
  { name: "preview-reproducibility", path: "/preview/reproducibility" },
  { name: "preview-knowledge-graph", path: "/preview/knowledge-graph" },
  { name: "preview-staged-review", path: "/preview/staged-review" },
  { name: "phenome", path: "/phenome" },
  // The /job/:jobId/* family baselines against the bundled static demo fixture, so the suite needs no
  // paid harmonization run. The sub-pages pass `instant` to useHarmonizeStream and settle on the full
  // result immediately; the dashboard replays the run unless `?results=1` skips to the finished state —
  // without that query the capture would race a client-side animation.
  { name: "job-workbench", path: "/job/:jobId/workbench", needsJobFixture: true },
  { name: "job-analysis", path: "/job/:jobId/analysis", needsJobFixture: true },
  { name: "job-composite", path: "/job/:jobId/composite", needsJobFixture: true },
  { name: "job-dashboard", path: "/job/:jobId", query: "?results=1", needsJobFixture: true },
  { name: "jobs", path: "/jobs" },
  // Registered nowhere on purpose — this is how the fallback branch of the <Switch> is reached. It must
  // produce a baselined screenshot, not a test error.
  { name: "not-found", path: "/__no_such_route__", registered: false },
];

/**
 * Resolve a route template to a navigable URL, substituting the `:jobId` of the first complete
 * demo job from the bundled static fixtures. Lives here rather than in a spec because three
 * suites now walk the same route list (visual, typography, the rebrand drill's leak scan) and a
 * second copy of this is how one of them silently starts covering a different set of pages.
 */
export async function routeUrl(route: VisualRoute, baseURL: string | undefined): Promise<string> {
  if (!route.needsJobFixture) return `${route.path}${route.query ?? ""}`;
  const { request } = await import("@playwright/test");
  const ctx = await request.newContext({ baseURL });
  try {
    const res = await ctx.get("/static-data/jobs.json");
    const data: unknown = await res.json();
    const jobs = (Array.isArray(data) ? data : ((data as { jobs?: unknown[] }).jobs ?? [])) as {
      jobId?: string;
      status?: string;
    }[];
    const jobId = (jobs.find((j) => j.status === "complete") ?? jobs[0])!.jobId!;
    return `${route.path.replace(":jobId", jobId)}${route.query ?? ""}`;
  } finally {
    await ctx.dispose();
  }
}
