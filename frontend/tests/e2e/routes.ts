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

export const VISUAL_ROUTES: VisualRoute[] = [
  { name: "landing", path: "/" },
];
