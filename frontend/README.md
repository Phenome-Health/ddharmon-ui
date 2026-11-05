# ddharmon-ui · frontend

The React/Vite single-page app. Setup, the dev server and the FastAPI backend are covered in the
[repo README](../README.md); this file documents the frontend's own test gates.

## End-to-end gates

Both gates run against a **static build** (`VITE_STATIC=1`), which reads the bundled
`public/static-data/*.json` demo fixtures instead of `/api`. That means **no backend, no Clerk keys and
no paid harmonization run** — which is what makes them cheap enough to run on every UI change.

```bash
npm run typecheck                          # tsc --noEmit
npm run test:e2e                           # everything: smoke + visual regression
npm run test:e2e -- --grep "@visual"       # visual regression only
npm run test:e2e -- --grep-invert "@visual" # smoke only (what CI runs)
```

Playwright builds and serves the bundle itself (`playwright.config.ts` → `webServer`), so there is
nothing to start first. The first run takes ~3 minutes because it builds.

## Visual regression

`tests/e2e/visual.spec.ts` takes **one screenshot per route** and compares it against a committed
baseline in `tests/e2e/visual.spec.ts-snapshots/`. It is the safety net for any change to the design
token layer: a retheme rewrites what every route reads, and without a pre-change baseline there is no
way to review those diffs deliberately.

**What the baseline is**

| Property | Value |
|---|---|
| Coverage | 23 baselines — the 22 routes registered in `src/App.tsx` plus the 404 fallback |
| Route list | `tests/e2e/routes.ts` (`VISUAL_ROUTES`) — the single list the spec iterates |
| Viewport | **1440** wide × 900 layout height, one viewport (the app is desktop-only, ≥1280px) |
| Theme | **one** screenshot per route — the app ships a single theme, so there is no light/dark pair |
| Browser | chromium only |
| Capture | full page. The viewport is grown to the page's content height before capture (900–8000px) |
| Data | the bundled public demo fixtures — `/job/:jobId/*` baselines need `public/static-data/`, and resolve the job id from `jobs.json` at runtime |
| Tolerance | `maxDiffPixels: 100` (absolute, not a ratio — see below) |

A guard test in the same file parses `<Route path="…">` out of `src/App.tsx` and **fails naming any
route that has no baseline**, so a new route cannot silently escape coverage. Add the route to
`tests/e2e/routes.ts` and regenerate.

**Updating baselines**

```bash
npm run test:e2e -- --grep "@visual" --update-snapshots
```

> **Reviewer note — accepting a snapshot diff is a design decision, not a chore.**
> `--update-snapshots` overwrites the baseline for every route it touches. Review each changed PNG
> **image by image** (`git diff --stat` on the snapshot directory tells you which) and confirm the
> change is the one you intended. Never bulk-approve a diff you have not looked at: a regenerated
> baseline is a permanent claim that the new rendering is correct, and it is exactly as easy to
> certify a broken route as a fixed one.
>
> Same rule for the failure artifacts: a failing run writes `*-expected.png`, `*-actual.png` and
> `*-diff.png` under `test-results/`. Look at the diff before deciding it is noise.

**Two things not to do**

- **Do not raise `maxDiffPixels` to make a flaky route green.** The budget is antialiasing headroom
  (measured: all 23 routes re-verify with *zero* differing pixels on a fixed platform). A route that
  will not re-verify is non-deterministic — an animation, a live clock, a random ordering — and the
  route is what needs fixing. It is set as an absolute pixel count rather than
  `maxDiffPixelRatio` on purpose: a ratio scales with page height, so on a 6773px-tall page 0.2%
  would quietly allow a ~19,000-pixel regression.
- **Do not commit a blank or error-boundary baseline.** A blank frame certifies a broken route
  forever, which is the failure this gate exists to prevent. Look at the new PNGs.

**Known limitations**

- **Baselines are platform-specific.** Font rasterisation differs between macOS and Linux, so the
  filenames carry a `{platform}` suffix (`landing-darwin.png`). Only `darwin` baselines are committed
  today, which is why CI runs `--grep-invert "@visual"`; adding `-linux` baselines (generated in the
  official Playwright container) is what would let CI enforce this gate.
- **`/job/:jobId` is capped at 8000px.** Its true content height is ~57,000px because the review queue
  renders un-virtualized; the baseline covers the first 8000px so one route cannot commit a 10MB PNG.
- **Inner scroll panes still clip.** The capture grows the app shell's main scroll container, not
  nested scroll areas inside a page (e.g. the workbench's resizable panels).
