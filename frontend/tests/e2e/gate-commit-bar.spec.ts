import { expect, test } from "@playwright/test";
import type { JobResult } from "@/types";
import { FINISHED_JOB, serveFinished } from "./gate23-fixture";

/**
 * The commit bar carries the reviewer past Gate 2 and Gate 3 (08-23b Task 1). The walk REACHES Gate 4; it
 * does not dead-end at Gate 2 — the defect the 2026-09-16 live test hit.
 *
 *   run: npm run test:e2e -- --grep "@commit-bar"
 *
 * STATIC BUILD — backend-less. This asserts the bar RENDERS the right paid-resume affordance on a run parked
 * at each gate, names the next gate, and is enabled only when the run is parked HERE (not on a gate already
 * behind the reviewer, which must not re-offer a paid continue). The resume POST that actually advances the
 * run is a server round-trip, asserted server-side; this proves the control exists and is correctly gated.
 */

function park(run: JobResult, gate: "gate2" | "gate3"): JobResult {
  run.status = "awaiting_review";
  run.gatePosition = gate;
  return run;
}

test("@commit-bar @gate2 Gate 2 offers a commit bar continuing to Gate 3", async ({ page }) => {
  await serveFinished(page, (run) => park(run, "gate2"));
  await page.goto(`/run/${FINISHED_JOB}/gate2`);
  await page.waitForLoadState("networkidle");

  await expect(page.getByTestId("commit-bar")).toBeVisible();
  const cont = page.getByTestId("gate2-continue");
  await expect(cont).toContainText("Continue to Gate 3");
  await expect(cont).toBeEnabled();
});

test("@commit-bar @gate3 Gate 3 offers a commit bar continuing to Gate 4 as a free read", async ({ page }) => {
  await serveFinished(page, (run) => park(run, "gate3"));
  await page.goto(`/run/${FINISHED_JOB}/gate3`);
  await page.waitForLoadState("networkidle");

  const bar = page.getByTestId("commit-bar");
  await expect(bar).toBeVisible();
  const cont = page.getByTestId("gate3-continue");
  await expect(cont).toContainText("Continue to Gate 4");
  await expect(cont).toBeEnabled();
  // Gate 4 is a pure read — the bar carries no purchase, only the free-read assurance.
  await expect(bar).toContainText("buys nothing");
});

test("@commit-bar a gate already behind the reviewer does not re-offer its paid continue", async ({ page }) => {
  // Parked at Gate 3 → Gate 2 is past, so Gate 2's bar is disabled: revisiting a committed gate must never
  // present a second charge for work already bought.
  await serveFinished(page, (run) => park(run, "gate3"));
  await page.goto(`/run/${FINISHED_JOB}/gate2`);
  await page.waitForLoadState("networkidle");

  await expect(page.getByTestId("gate2-continue")).toBeDisabled();
});
