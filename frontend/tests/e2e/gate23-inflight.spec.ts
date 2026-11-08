import { expect, test, type Page } from "@playwright/test";
import type { JobResult } from "@/types";
import { FINISHED_JOB, PAUSED_JOB, serveFinished, servePaused } from "./gate23-fixture";

/**
 * 08-28 F4 — while a paid leg is still running, Gates 2 and 3 say so; they never claim nothing was passed to them.
 *
 * Live verify 3 caught Gate 2 reading "Nothing was passed from Gate 1 … Go back to Gate 1 and tick at least one
 * group" while eight groups were in flight — a false claim with a call to action pointing at a gate that was
 * already frozen. Mid-leg the result the screen holds is the PREVIOUS checkpoint (Gate 1's carries no records),
 * so an empty list is not evidence of an empty scope. The live half of this is `tests/live/inflight.live.spec.ts`
 * (I12); this static half constructs the in-flight state from the paused fixture, visibly.
 *
 * HOW IT SAYS SO CHANGED ON 2026-11-08 (Bhargav: "while a gate is mid-run, remove the other gate elements on screen
 * (how to use, etc)"). A gate the run has not reached yet is now its PROGRESS ALONE — the run title, the rail and
 * `RunProgress` naming the stage — and neither its how-to nor its working surface renders, so the old in-surface
 * "still running" notice is gone with it. The protection is unchanged: a running leg must never read as an empty
 * scope, "no specs", or a populated gate — so each test asserts the progress and the stage, and that no empty-state,
 * no false-empty copy and none of the gate's working surface is on the page.
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

/**
 * The screen of a gate the run is still producing: the run's progress, naming the leg's stage — and nothing that could
 * read as the gate itself, empty or full: no how-to, no empty state, no false-empty copy, no in-surface notice.
 */
async function expectProducing(page: Page, stage: string, runningNotice: string): Promise<void> {
  await expect(page.getByTestId("run-progress")).toBeVisible();
  await expect(page.getByTestId("run-progress-stage")).toContainText(stage);
  await expect(page.getByTestId("gate-rail-pin")).toBeVisible();
  await expect(page.getByTestId("how-to")).toHaveCount(0);
  await expect(page.getByTestId("gate-empty-state")).toHaveCount(0);
  await expect(page.getByTestId(runningNotice)).toHaveCount(0);
  for (const re of FALSE_EMPTY) await expect(page.locator("body")).not.toContainText(re);
}

for (const phase of ["pending", "assigning", "specs"]) {
  test(`@gate2 a leg that is ${phase} reads as still running, not as an empty scope`, async ({ page }) => {
    await servePaused(page, running(phase));
    await open(page, "gate2");
    await expectProducing(page, phase, "gate2-running");
  });

  test(`@gate3 a leg that is ${phase} reads as still running, not as "no specs"`, async ({ page }) => {
    await servePaused(page, running(phase));
    await open(page, "gate3");
    await expectProducing(page, phase, "gate3-running");
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

/*
 * Bhargav, live Haiku run 67cac032 (2026-10-15): "gate 3 seems to show as populated while the specs step is still in
 * progress?" The running state keyed on an EMPTY list, but mid-leg the screen holds Gate 2's checkpoint, whose records
 * already carry value-mapping rows, so the gate rendered as if its specs were written. What decides it is whether the
 * run has REACHED Gate 3, not whether the earlier result happens to have rows.
 */
test("@gate3 a leg still running toward Gate 3 reads as running even when the earlier result carries rows", async ({
  page,
}) => {
  await serveFinished(page, (run) => {
    run.status = "specs" as JobResult["status"];
    run.phase = "specs";
    run.gatePosition = "gate2";
  });
  await page.goto(`/run/${FINISHED_JOB}/gate3`);
  await page.waitForLoadState("networkidle");
  await expectProducing(page, "specs", "gate3-running");
  // Gate 2's checkpoint carries value-mapping rows, and none of them is drawn as if Gate 3's specs were written.
  await expect(page.getByTestId("spec-row")).toHaveCount(0);
  await expect(page.getByTestId("value-mapping")).toHaveCount(0);
});

test("@gate3 a leg running PAST Gate 3 keeps showing what Gate 3 holds", async ({ page }) => {
  await serveFinished(page, (run) => {
    run.status = "refine" as JobResult["status"];
    run.phase = "refine";
    run.gatePosition = "gate3";
  });
  await page.goto(`/run/${FINISHED_JOB}/gate3`);
  await page.waitForLoadState("networkidle");
  await expect(page.getByTestId("gate-empty-state")).toHaveCount(0);
  await expect(page.getByTestId("gate3-running")).toHaveCount(0);
  // A gate the run has REACHED keeps its whole screen while the run works ahead (2026-11-08): not progress alone.
  await expect(page.getByTestId("run-progress")).toBeVisible();
  await expect(page.getByTestId("how-to")).toBeVisible();
  await expect(page.getByTestId("spec-row").first()).toBeVisible();
});
