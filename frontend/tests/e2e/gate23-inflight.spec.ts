import { expect, test, type Page } from "@playwright/test";
import type { JobResult } from "@/types";
import { PAUSED_JOB, servePaused } from "./gate23-fixture";

/**
 * 08-28 F4 — while a paid leg is still running, Gates 2 and 3 say so; they never claim nothing was passed to them.
 *
 * Live verify 3 caught Gate 2 reading "Nothing was passed from Gate 1 … Go back to Gate 1 and tick at least one
 * group" while eight groups were in flight — a false claim with a call to action pointing at a gate that was
 * already frozen. Mid-leg the result the screen holds is the PREVIOUS checkpoint (Gate 1's carries no records),
 * so an empty list is not evidence of an empty scope. The live half of this is `tests/live/inflight.live.spec.ts`
 * (I12); this static half constructs the in-flight state from the paused fixture, visibly.
 *
 *   run: E2E_PORT=4205 npx playwright test gate23-inflight
 */

/** The paused (zero-record) run, re-stated as a leg in progress: the status IS the phase name mid-leg. */
function running(phase: string) {
  return (run: JobResult) => {
    run.status = phase as JobResult["status"];
    run.phase = phase;
  };
}

function finished(run: JobResult) {
  run.status = "complete";
  run.phase = "complete";
}

async function open(page: Page, gate: "gate2" | "gate3"): Promise<void> {
  await page.goto(`/run/${PAUSED_JOB}/${gate}`);
  await page.waitForLoadState("networkidle");
}

const FALSE_EMPTY = [/Nothing was passed from Gate 1/i, /tick at least one group/i, /No transform specs to review/i];

for (const phase of ["pending", "assigning", "specs"]) {
  test(`@gate2 a leg that is ${phase} reads as still running, not as an empty scope`, async ({ page }) => {
    await servePaused(page, running(phase));
    await open(page, "gate2");
    const empty = page.getByTestId("gate-empty-state");
    await expect(empty).toBeVisible();
    await expect(empty).toContainText(/still running/i);
    await expect(page.getByTestId("gate2-running")).toContainText(phase);
    for (const re of FALSE_EMPTY) await expect(empty).not.toContainText(re);
  });

  test(`@gate3 a leg that is ${phase} reads as still running, not as "no specs"`, async ({ page }) => {
    await servePaused(page, running(phase));
    await open(page, "gate3");
    const empty = page.getByTestId("gate-empty-state");
    await expect(empty).toBeVisible();
    await expect(empty).toContainText(/still running/i);
    await expect(page.getByTestId("gate3-running")).toContainText(phase);
    for (const re of FALSE_EMPTY) await expect(empty).not.toContainText(re);
  });
}

test("@gate2 a FINISHED leg that produced nothing keeps the true empty state", async ({ page }) => {
  await servePaused(page, finished);
  await open(page, "gate2");
  await expect(page.getByTestId("gate-empty-state")).toContainText("Nothing was passed from Gate 1");
  await expect(page.getByTestId("gate2-running")).toHaveCount(0);
});

test("@gate3 a FINISHED leg that produced nothing keeps the true empty state", async ({ page }) => {
  await servePaused(page, finished);
  await open(page, "gate3");
  await expect(page.getByTestId("gate-empty-state")).toContainText("No transform specs to review");
  await expect(page.getByTestId("gate3-running")).toHaveCount(0);
});
