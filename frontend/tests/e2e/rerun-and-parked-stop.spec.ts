import { expect, test, type Page } from "@playwright/test";
import { RETIRED_GATE, rerunSetupPathFor, runPathFor } from "@/lib/gate-routes";

/**
 * Re-run opens a PREFILLED Setup, and a parked run is never offered a Stop (08-28).
 *
 *   run: npm run test:e2e -- --grep "@rerun"
 *
 * TWO DEFECTS, ONE ROOT: the legacy one-shot run page (`/job/:id`) and the controls that lead to it
 * predate the staged flow, and treat a parked run as a running one.
 *
 *  1. **Stop on a parked run.** The dashboard offered Stop while a run sat at a gate. A pause is an EXIT
 *     (08 D-01) — there is no worker to stop — and the flag the Stop left behind killed the NEXT Continue:
 *     its fresh worker raised on it and the run ended `cancelled`. The backend half is pinned in
 *     `tests/test_stop_parked_and_rerun.py`; this file pins that no surface OFFERS the control.
 *  2. **Re-run fired a paid run and landed off the gates.** The Runs list's re-run started a PAID run at
 *     once, in the old run's mode, and sent the reviewer to `/job/:id`, which has no gate link. Re-run is
 *     "start a new run, here is your last setup filled in": it opens Setup prefilled with the same
 *     dictionaries, column roles and options, and the reviewer starts it — choosing the mode consciously.
 *
 * Every browser test drives the STATIC build against synthetic runs, the same way `jobs.spec.ts` does.
 */

// --- the pure half ---------------------------------------------------------------------------------

test.describe("Where a run's links go — as functions", () => {
  test("@rerun a re-run is Setup for a NEW run, naming the run it copies", () => {
    expect(rerunSetupPathFor("abc-123")).toBe("/run/new/setup?rerun=abc-123");
    // An id is carried as data, never as path: it cannot turn the URL into another route.
    expect(rerunSetupPathFor("a/b?c")).toBe("/run/new/setup?rerun=a%2Fb%3Fc");
  });

  test("@rerun a staged run is linked into the gates; only an ENDED run goes to the legacy page", () => {
    const run = (over: Record<string, unknown>) => ({ jobId: "r", status: "complete", gatePosition: null, ...over });
    // Parked: the gate it waits at.
    expect(runPathFor(run({ status: "awaiting_review", gatePosition: "gate2" }))).toBe("/run/r/gate2");
    expect(runPathFor(run({ status: "awaiting_review", gatePosition: RETIRED_GATE }))).toBe("/run/r/setup");
    // In flight: the gate its leg is running TOWARD. A first leg carries no position yet; a resumed leg
    // still carries the one it left (the resume route does not clear it).
    expect(runPathFor(run({ status: "clustering" }))).toBe("/run/r/gate1");
    expect(runPathFor(run({ status: "pending", gatePosition: RETIRED_GATE }))).toBe("/run/r/gate1");
    expect(runPathFor(run({ status: "assigning", gatePosition: "gate1" }))).toBe("/run/r/gate2");
    expect(runPathFor(run({ status: "generating_specs", gatePosition: "gate2" }))).toBe("/run/r/gate3");
    // Ended: the legacy page, which is where the finished result and the error/stop recovery live.
    expect(runPathFor(run({ status: "complete", gatePosition: "gate4" }))).toBe("/job/r?results=1");
    expect(runPathFor(run({ status: "error" }))).toBe("/job/r");
    expect(runPathFor(run({ status: "cancelled", gatePosition: "gate1" }))).toBe("/job/r");
    // The shipped demo is a client-side replay with no gates to enter: unchanged.
    expect(runPathFor(run({ status: "clustering", config: { demo: true } }))).toBe("/job/r?results=1");
  });
});

// --- fixtures ----------------------------------------------------------------------------------------

function baseRun(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    jobId: "parked-gate2",
    displayName: "Parked at Gate 2",
    status: "awaiting_review",
    phase: "awaiting_review",
    gatePosition: "gate2",
    completed: 2,
    total: 2,
    errorMessage: null,
    config: { run_mode: "batch" },
    decisions: {},
    createdAt: 1787802198.7035,
    updatedAt: 1787802205.341791,
    nRecords: 42,
    ...over,
  };
}

const inFlight = (over: Record<string, unknown> = {}) =>
  baseRun({ jobId: "in-flight", displayName: "Still clustering", status: "clustering", phase: "clustering", gatePosition: null, ...over });
const finished = (over: Record<string, unknown> = {}) =>
  baseRun({ jobId: "finished", displayName: "Finished run", status: "complete", phase: "complete", gatePosition: "gate4", ...over });
const stopped = (over: Record<string, unknown> = {}) =>
  baseRun({ jobId: "stopped", displayName: "Stopped run", status: "cancelled", phase: "cancelled", gatePosition: null, ...over });

async function withJobs(page: Page, jobs: Record<string, unknown>[]): Promise<void> {
  await page.route("**/static-data/jobs.json", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(jobs) }),
  );
}

/** Serve one run to the dashboard's own fetch as well as to the runs list. */
async function withRun(page: Page, job: Record<string, unknown>): Promise<void> {
  await page.route(`**/static-data/result-${job.jobId}.json`, (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ ...job, result: null }) }),
  );
  await withJobs(page, [job]);
}

const row = (page: Page, jobId: string) => page.getByTestId(`job-row-${jobId}`);

// --- the Runs list -----------------------------------------------------------------------------------

test.describe("Runs list — re-run opens Setup, and staged runs are linked into the gates", () => {
  test("@rerun a finished run's re-run opens Setup prefilled for a NEW run, and starts nothing", async ({ page }) => {
    const writes: string[] = [];
    page.on("request", (req) => {
      if (req.method() !== "GET") writes.push(`${req.method()} ${req.url()}`);
    });
    await withJobs(page, [finished()]);
    await page.goto("/jobs");
    await page.waitForLoadState("networkidle");
    const rerun = row(page, "finished").getByRole("link", { name: "Re-run" });
    await expect(rerun).toHaveAttribute("href", "/run/new/setup?rerun=finished");
    await rerun.click();
    await expect(page).toHaveURL(/\/run\/new\/setup\?rerun=finished$/);
    // No run was created on the way: re-run no longer buys anything by itself, and no key was asked for.
    expect(writes).toEqual([]);
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("@rerun an in-flight run's name opens the gate its leg is running toward, not the legacy page", async ({
    page,
  }) => {
    await withJobs(page, [inFlight(), inFlight({ jobId: "leg-two", displayName: "Leg two", gatePosition: "gate1" })]);
    await page.goto("/jobs");
    await page.waitForLoadState("networkidle");
    await expect(row(page, "in-flight").getByRole("link", { name: "Still clustering" })).toHaveAttribute(
      "href",
      "/run/in-flight/gate1",
    );
    await expect(row(page, "leg-two").getByRole("link", { name: "Leg two" })).toHaveAttribute(
      "href",
      "/run/leg-two/gate2",
    );
  });
});

// --- the legacy dashboard ----------------------------------------------------------------------------

test.describe("Dashboard — a parked run is offered its gate, never a Stop", () => {
  test("@rerun a parked run's dashboard offers no Stop, and offers the resume at its gate", async ({ page }) => {
    await withRun(page, baseRun());
    await page.goto("/job/parked-gate2");
    await page.waitForLoadState("networkidle");
    await expect(page.getByTestId("run-elapsed")).toHaveText(/Paused/i);
    // THE DEFECT: a labelled, full-width Stop for a run with no worker. Pressing it left the flag that
    // ended the next Continue `cancelled`.
    await expect(page.getByRole("button", { name: /Stop/ })).toHaveCount(0);
    await expect(page.getByTestId("resume-review")).toHaveAttribute("href", "/run/parked-gate2/gate2");
    // The heading says it in words, not as the wire token "Awaiting_review".
    await expect(page.getByText(/awaiting_review/i)).toHaveCount(0);
    await expect(page.getByTestId("run-phase")).toHaveText(/Awaiting review · Concepts → CDEs/);
  });

  test("@rerun an in-flight run keeps its Stop, and gains a link to the gate it is heading for", async ({
    page,
  }) => {
    const started = Date.now() / 1000 - 8;
    await withRun(page, inFlight({ createdAt: started, updatedAt: started + 1 }));
    await page.goto("/job/in-flight");
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("button", { name: /Stop/ })).toHaveCount(1);
    await expect(page.getByTestId("resume-review")).toHaveCount(0);
    await expect(page.getByTestId("open-at-gate")).toHaveAttribute("href", "/run/in-flight/gate1");
  });

  test("@rerun a stopped run's re-run opens Setup prefilled rather than firing a run", async ({ page }) => {
    await withRun(page, stopped());
    await page.goto("/job/stopped");
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("link", { name: /Re-run/ })).toHaveAttribute("href", "/run/new/setup?rerun=stopped");
    await expect(page.getByRole("button", { name: /Re-run/ })).toHaveCount(0);
  });
});

// --- Setup, prefilled ----------------------------------------------------------------------------------

/** Headers that are NOT role names, so a prefilled role can only have come from the earlier run. */
const HEADERS = ["varname", "desc", "unit"];
const ROLES = { variable_name: "varname", description: "desc", units: "unit" };
const dictionaryCsv = (prefix: string, n: number) =>
  [HEADERS.join(","), ...Array.from({ length: n }, (_, i) => `${prefix}_${i},describes ${prefix}_${i},kg`)].join("\n");

const SOURCE = {
  ...stopped({ jobId: "src-run", displayName: "Spring run" }),
  // `endorsed`, not the default (`full`, 08-28 Decision 7): only a NON-default catalog proves the prefill copied
  // the source run's choice rather than landing on the default by itself.
  config: { run_mode: "sync", cde_set: "endorsed", readjudication: true },
  dictionaries: [
    { filename: "alpha.csv", cohortName: "Cohort Alpha", columnRoles: ROLES },
    { filename: "beta.csv", cohortName: "Cohort Beta", columnRoles: { variable_name: "varname", description: "desc" } },
  ],
};

async function withSource(page: Page, uploads: Record<string, string | null>): Promise<void> {
  // The run is read from the caller's runs list (its summary row), exactly as the Runs page lists it.
  await withJobs(page, [SOURCE]);
  await page.route("**/static-data/uploads/src-run/*", (route) => {
    const name = decodeURIComponent(new URL(route.request().url()).pathname.split("/").pop() ?? "");
    const body = uploads[name];
    return body == null
      ? route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ detail: "gone" }) })
      : route.fulfill({ contentType: "text/csv", body });
  });
}

test.describe("Setup — a re-run opens prefilled, and nothing starts until Start", () => {
  test("@rerun the earlier run's dictionaries, column roles and options are filled in", async ({ page }) => {
    await withSource(page, { "alpha.csv": dictionaryCsv("a", 6), "beta.csv": dictionaryCsv("b", 4) });
    await page.goto(rerunSetupPathFor("src-run"));
    await page.waitForLoadState("networkidle");

    const notice = page.getByTestId("rerun-prefill");
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("Spring run");
    await expect(notice).toContainText(/nothing has started/i);

    // The same dictionaries, READ AS FILES — row counts and the name check work exactly as for a drop.
    const cards = page.getByTestId("dict-card");
    await expect(cards).toHaveCount(2);
    await expect(cards.nth(0)).toHaveAttribute("data-cohort", "Cohort Alpha");
    await expect(cards.nth(1)).toHaveAttribute("data-cohort", "Cohort Beta");
    await expect(cards.nth(0).getByTestId("dict-filename")).toHaveText("alpha.csv");
    await expect(cards.nth(0).getByTestId("name-check")).toHaveAttribute("data-rows", "6");
    // The same column roles. None of these headers is a role name, so nothing else could have mapped them.
    const alpha = cards.nth(0).getByTestId("role-select");
    await expect(alpha.nth(0)).toHaveValue("variable_name");
    await expect(alpha.nth(1)).toHaveValue("description");
    await expect(alpha.nth(2)).toHaveValue("units");
    await expect(cards.nth(1).getByTestId("role-select").nth(2)).toHaveValue("");
    await expect(cards.nth(0).getByTestId("prefill-provenance")).toContainText("Spring run");

    // The same options — every one of them still an editable control, including the run mode.
    await expect(page.getByTestId("run-mode")).toHaveValue("sync");
    await expect(page.getByTestId("run-mode")).toBeEnabled();
    await expect(page.getByTestId("cde-set")).toHaveValue("endorsed");
    // Re-splitting is not an option to copy any more (final review round 1): every new run can re-split, and
    // the reviewer decides per group at Gate 1 — so there is no control here, whatever the source recorded.
    await expect(page.getByTestId("allow-readjudication")).toHaveCount(0);
    await expect(page.getByTestId("run-name")).toHaveValue("Spring run (re-run)");

    // And nothing was started: still on Setup, with Start as the reviewer's own decision.
    await expect(page).toHaveURL(/\/run\/new\/setup\?rerun=src-run$/);
    await expect(page.getByTestId("start-run")).toBeVisible();
  });

  test("@rerun an upload the server no longer has is named with the next step, not silently dropped", async ({
    page,
  }) => {
    await withSource(page, { "alpha.csv": dictionaryCsv("a", 3), "beta.csv": null });
    await page.goto(rerunSetupPathFor("src-run"));
    await page.waitForLoadState("networkidle");
    await expect(page.getByTestId("dict-card")).toHaveCount(1);
    const missing = page.getByTestId("rerun-upload-missing");
    await expect(missing).toHaveCount(1);
    await expect(missing).toContainText("beta.csv");
    await expect(missing).toContainText(/drop it here again/i);
  });

  test("@rerun a run that is not among yours is said to be unloadable, and nothing is filled in", async ({
    page,
  }) => {
    await withJobs(page, []);
    await page.goto(rerunSetupPathFor("someone-elses"));
    await page.waitForLoadState("networkidle");
    await expect(page.getByTestId("rerun-prefill")).toContainText(/could not be loaded/i);
    await expect(page.getByTestId("dict-card")).toHaveCount(0);
    await expect(page.getByTestId("run-name")).toHaveValue("");
  });

  test("@rerun a plain New Run is untouched: no notice, and the usual defaults", async ({ page }) => {
    await page.goto("/run/new/setup");
    await page.waitForLoadState("networkidle");
    await expect(page.getByTestId("rerun-prefill")).toHaveCount(0);
    await expect(page.getByTestId("dict-card")).toHaveCount(0);
    await expect(page.getByTestId("run-mode")).toHaveValue("batch");
    await expect(page.getByTestId("cde-set")).toHaveValue("full"); // 08-28 Decision 7
  });
});
