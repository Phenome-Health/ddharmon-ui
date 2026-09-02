import { expect, test, type Page } from "@playwright/test";
import { RETIRED_GATE } from "@/lib/gate-routes";

/**
 * The Runs page and the run dashboard — the two surfaces the staged flow INHERITED (08-14c).
 *
 * WHAT PROMPTED THESE ASSERTIONS. A reviewer paused a run at a gate, navigated away, and came back
 * through Runs: they landed on a progress-bar dashboard with no way back to the gate, the run claimed
 * **109 hours elapsed** when it had computed for about six seconds, and the header badge read "5 running"
 * over five runs that were parked and spending nothing. Three surfaces, one missing concept.
 *
 *   run: npm run test:e2e -- --grep "@jobs"
 *
 * THE DASHBOARD'S ELAPSED CLOCK IS ASSERTED HERE rather than in a dashboard spec of its own, because it
 * is the same defect as the two on the Runs page — a surface that predates `awaiting_review` treating a
 * parked run as a running one — and splitting one defect across two files is how the third copy of it
 * survives a fix to the first two.
 *
 * Every test drives the STATIC build against a synthetic runs list. The shipped `jobs.json` carries a
 * single COMPLETE demo run, which is the one case that must not change; the parked cases have to be
 * injected, and injecting them is also what keeps the `/jobs` visual baseline still.
 */

/** A parked run as the live backend actually reports one (measured 2026-08-31): `phase` mirrors `status`. */
function parkedRun(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    jobId: "parked-gate2",
    displayName: "Parked at Gate 2",
    status: "awaiting_review",
    phase: "awaiting_review",
    gatePosition: "gate2",
    completed: 0,
    total: 0,
    errorMessage: null,
    config: { mode: "batch" },
    decisions: {},
    createdAt: 1787802198.7035,
    // 6.64s after createdAt — the exact live run the dashboard was rendering as 109 hours.
    updatedAt: 1787802205.341791,
    nRecords: 42,
    ...over,
  };
}

function inFlightRun(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...parkedRun(),
    jobId: "in-flight",
    displayName: "Still clustering",
    status: "clustering",
    phase: "clustering",
    gatePosition: null,
    ...over,
  };
}

function completeRun(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...parkedRun(),
    jobId: "finished",
    displayName: "Finished run",
    status: "complete",
    phase: "complete",
    // A finished run still carries the last gate it passed through — keying off `gatePosition` alone
    // would send it back into the review flow.
    gatePosition: "gate4",
    ...over,
  };
}

/** Serve a synthetic runs list to both the Runs page and the header badge (they share one query). */
async function withJobs(page: Page, jobs: Record<string, unknown>[]): Promise<void> {
  await page.route("**/static-data/jobs.json", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(jobs) }),
  );
}

const row = (page: Page, jobId: string) => page.getByTestId(`job-row-${jobId}`);

test.describe("Runs page — a parked run is not a running run", () => {
  test("@jobs a parked run's name opens the gate it is parked on, not the dashboard", async ({ page }) => {
    await withJobs(page, [parkedRun()]);
    await page.goto("/jobs");
    await page.waitForLoadState("networkidle");
    const link = row(page, "parked-gate2").getByRole("link", { name: "Parked at Gate 2" });
    await expect(link).toHaveAttribute("href", "/run/parked-gate2/gate2");
  });

  test("@jobs a run parked at the retired gate opens Setup, never the retired path", async ({ page }) => {
    // This is not a hypothetical: EVERY parked run on the live backend carries `gate0` (measured
    // 2026-08-31). Linking to the retired route would work and would flicker through a redirect.
    await withJobs(page, [parkedRun({ jobId: "parked-retired", gatePosition: RETIRED_GATE })]);
    await page.goto("/jobs");
    await page.waitForLoadState("networkidle");
    const link = row(page, "parked-retired").getByRole("link", { name: "Parked at Gate 2" });
    await expect(link).toHaveAttribute("href", "/run/parked-retired/setup");
  });

  test("@jobs a parked run with no gate position opens Setup, not a 404", async ({ page }) => {
    await withJobs(page, [parkedRun({ jobId: "parked-nowhere", gatePosition: null })]);
    await page.goto("/jobs");
    await page.waitForLoadState("networkidle");
    const link = row(page, "parked-nowhere").getByRole("link", { name: "Parked at Gate 2" });
    await expect(link).toHaveAttribute("href", "/run/parked-nowhere/setup");
  });

  test("@jobs a complete run still opens its results and an in-flight run still opens the dashboard", async ({
    page,
  }) => {
    await withJobs(page, [completeRun(), inFlightRun()]);
    await page.goto("/jobs");
    await page.waitForLoadState("networkidle");
    await expect(row(page, "finished").getByRole("link", { name: "Finished run" })).toHaveAttribute(
      "href",
      "/job/finished?results=1",
    );
    await expect(row(page, "in-flight").getByRole("link", { name: "Still clustering" })).toHaveAttribute(
      "href",
      "/job/in-flight",
    );
  });

  test("@jobs a parked run reads as awaiting review and names its gate", async ({ page }) => {
    await withJobs(page, [parkedRun()]);
    await page.goto("/jobs");
    await page.waitForLoadState("networkidle");
    const status = row(page, "parked-gate2").getByTestId("job-status");
    // The reviewer-facing word is "awaiting review", never "running" and never "stopped" (which would
    // read as cancelled). Naming the gate is what makes the row actionable rather than merely honest.
    await expect(status).toHaveText(/awaiting review/i);
    await expect(status).toHaveText(/Concepts → CDEs/i);
    await expect(status).not.toHaveText(/awaiting_review/);
  });

  test("@jobs a run parked at the retired gate names the screen it will actually open", async ({ page }) => {
    await withJobs(page, [parkedRun({ jobId: "parked-retired", gatePosition: RETIRED_GATE })]);
    await page.goto("/jobs");
    await page.waitForLoadState("networkidle");
    // Naming "Load & prepare" here would name a screen that no longer exists and is not where the click
    // lands. The label must agree with the destination.
    await expect(row(page, "parked-retired").getByTestId("job-status")).toHaveText(/Set up/i);
  });

  test("@jobs a parked run is offered a resume, not a stop — there is no worker to cancel", async ({ page }) => {
    await withJobs(page, [parkedRun()]);
    await page.goto("/jobs");
    await page.waitForLoadState("networkidle");
    const r = row(page, "parked-gate2");
    await expect(r.getByTestId("resume-review")).toHaveAttribute("href", "/run/parked-gate2/gate2");
    // A stop offers to save money that is not being spent (08 D-01: a pause is an EXIT).
    await expect(r.getByRole("button", { name: "Stop" })).toHaveCount(0);
  });

  test("@jobs an in-flight run keeps its stop and a terminal run keeps its re-run", async ({ page }) => {
    await withJobs(page, [inFlightRun(), completeRun()]);
    await page.goto("/jobs");
    await page.waitForLoadState("networkidle");
    await expect(row(page, "in-flight").getByRole("button", { name: "Stop" })).toHaveCount(1);
    await expect(row(page, "in-flight").getByTestId("resume-review")).toHaveCount(0);
    await expect(row(page, "finished").getByRole("button", { name: "Re-run" })).toHaveCount(1);
    await expect(row(page, "finished").getByRole("button", { name: "Stop" })).toHaveCount(0);
  });

  test("@jobs the shipped demo run is untouched by all of this", async ({ page }) => {
    // No route interception: the real `jobs.json`, exactly as the /jobs baseline renders it.
    await page.goto("/jobs");
    await page.waitForLoadState("networkidle");
    const demo = row(page, "demo-aireadi_aou_clsa_mesa_ukbb");
    await expect(demo.getByRole("link", { name: /^Demo · / })).toHaveAttribute(
      "href",
      "/job/demo-aireadi_aou_clsa_mesa_ukbb?results=1",
    );
    await expect(demo.getByTestId("job-status")).toHaveText("complete");
    await expect(demo.getByTestId("resume-review")).toHaveCount(0);
  });
});

test.describe("Dashboard — elapsed freezes at the park", () => {
  /** Serve one run's payload to the dashboard's own fetch as well as to the runs list. */
  async function withRun(page: Page, job: Record<string, unknown>): Promise<void> {
    await page.route(`**/static-data/result-${job.jobId}.json`, (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify({ ...job, result: null }) }),
    );
    await withJobs(page, [job]);
  }

  test("@jobs a parked run shows the seconds it ran, labelled as paused", async ({ page }) => {
    await withRun(page, parkedRun());
    await page.goto("/job/parked-gate2");
    await page.waitForLoadState("networkidle");
    const readout = page.getByTestId("run-elapsed");
    // 6.64s of real compute (updatedAt − createdAt, the exact live run). The defect rendered
    // `now − createdAt`, which on 2026-08-31 was 109 hours for this very run.
    await expect(readout).toHaveText(/\b7s\b/);
    await expect(readout).not.toHaveText(/\dh\b/);
    // A number that stops moving with no explanation reads as a hung page; naming the gate makes the
    // frozen figure legible as a fact rather than a failure.
    await expect(readout).toHaveText(/Paused/i);
    await expect(readout).toHaveText(/Concepts → CDEs/i);
    await expect(readout).not.toHaveText(/Elapsed/);
  });

  test("@jobs the frozen readout does not advance while the page is open", async ({ page }) => {
    await withRun(page, parkedRun());
    await page.goto("/job/parked-gate2");
    await page.waitForLoadState("networkidle");
    const readout = page.getByTestId("run-elapsed");
    const first = await readout.textContent();
    await page.waitForTimeout(2500);
    expect(await readout.textContent()).toBe(first);
  });

  test("@jobs no ETA is projected over a frozen clock", async ({ page }) => {
    // THE FIXTURE CARRIES A PIPELINE PHASE ON PURPOSE. A live parked run reports `phase:
    // "awaiting_review"`, which is not in PHASE_ORDER, so `phasePercent` already returns 5 and the ETA
    // is suppressed by accident. Depending on that accident would leave the surface one backend field
    // away from projecting a completion time for work that has stopped, so the guard is asserted
    // against the shape the accident does not cover.
    await withRun(page, parkedRun({ jobId: "parked-stalephase", phase: "assigning" }));
    await page.goto("/job/parked-stalephase");
    await page.waitForLoadState("networkidle");
    await expect(page.getByTestId("run-elapsed")).toHaveText(/Paused/i);
    await expect(page.getByTestId("run-eta")).toHaveCount(0);
  });

  test("@jobs an in-flight run still ticks live and still projects an ETA", async ({ page }) => {
    // The control for the two tests above: freezing the clock for a parked run must not freeze it for a
    // running one, which is the regression a "just stop the ticker" fix would introduce.
    const started = Date.now() / 1000 - 8;
    await withRun(page, inFlightRun({ createdAt: started, updatedAt: started + 1 }));
    await page.goto("/job/in-flight");
    await page.waitForLoadState("networkidle");
    const readout = page.getByTestId("run-elapsed");
    await expect(readout).toHaveText(/Elapsed/);
    await expect(readout).not.toHaveText(/Paused/i);
    await expect(page.getByTestId("run-eta")).toHaveCount(1);
    const first = await readout.textContent();
    await expect(async () => {
      expect(await readout.textContent()).not.toBe(first);
    }).toPass({ timeout: 5000 });
  });
});
