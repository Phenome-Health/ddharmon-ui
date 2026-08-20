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
