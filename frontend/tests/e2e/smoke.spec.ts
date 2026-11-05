import { test, expect } from "@playwright/test";

/**
 * Smoke gate — the app boots and its core user-facing surfaces render from the
 * bundled static demo fixtures. Static mode (VITE_STATIC=1) means no backend,
 * no auth, no API keys, no paid run. If any of these fail, the build is broken
 * in a way a human would have caught by clicking around — which is the point.
 */

test("landing page renders and offers the demo", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: /explore a live demo/i })).toBeVisible();
});

test("the New run nav routes into the staged gated flow, not the legacy form", async ({ page }) => {
  // 08-23b Task 4 (Replace): the "New run" entry sends the user into the staged Setup gate
  // (/run/new/setup), not the legacy /new form (→ /job/:id). The legacy route stays reachable by URL for the
  // demo, but nothing in the nav points at it.
  await page.goto("/");
  await page.getByRole("link", { name: "New run", exact: true }).click();
  await expect(page).toHaveURL(/\/run\/new\/setup$/);
});

test("demo page lists the shipped cohorts", async ({ page }) => {
  await page.goto("/demo");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  // The demo sources list renders one external link per cohort — assert one is
  // present (exact name avoids matching the several other "UK Biobank" texts).
  await expect(page.getByRole("link", { name: "UK Biobank", exact: true })).toBeVisible();
});

test("a completed demo run renders its result from static fixtures", async ({ page }) => {
  // Discover the first complete demo job from the bundled fixtures rather than
  // hardcoding an id — survives fixture renames / demo-set changes.
  await page.goto("/");
  const job = await page.evaluate(async () => {
    const res = await fetch("/static-data/jobs.json");
    if (!res.ok) return null;
    const data = await res.json();
    const jobs = Array.isArray(data) ? data : (data.jobs ?? []);
    return jobs.find((j: { status?: string }) => j.status === "complete") ?? jobs[0] ?? null;
  });
  expect(job, "static-data/jobs.json should ship at least one demo job").toBeTruthy();

  // The dashboard renders an <h1> with the job's displayName once getResult()
  // loads the static result fixture. That proves routing + fixture load + render.
  await page.goto(`/job/${job.jobId}?results=1`);
  await expect(page.getByRole("heading", { level: 1, name: job.displayName })).toBeVisible();
});

/**
 * The ARPA-H funding acknowledgement, VERBATIM (Bhargav, 2026-11-05: "exact language"). It is the funder's
 * required wording, so this pins the whole sentence pair rather than a fragment — a paraphrase must fail.
 * It belongs to every deployment, not just prod, so it is asserted on the default build.
 */
const ARPA_H_ACKNOWLEDGEMENT =
  "This research was, in part, funded by the Advanced Research Projects Agency for Health (ARPA-H). " +
  "The views and conclusions contained in this document are those of the authors and should not be " +
  "interpreted as representing the official policies, either expressed or implied, of the United States Government.";

test("landing page carries the ARPA-H funding acknowledgement, verbatim", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("funding-acknowledgement")).toHaveText(ARPA_H_ACKNOWLEDGEMENT);
});

test("a default build keeps every content page in the nav (hiding pages is opt-in, per deployment)", async ({ page }) => {
  // VITE_HIDDEN_PAGES is unset here, so nothing may disappear: dev and every local build show the full site.
  // The lean (prod) build is exercised by playwright.lean.config.ts.
  await page.goto("/");
  const nav = page.getByTestId("app-nav");
  for (const label of ["Methods", "Benchmarks", "Design", "Roadmap", "Architecture", "Phenome Health"]) {
    await expect(nav.getByRole("link", { name: label, exact: true }), label).toHaveCount(1);
  }
});
