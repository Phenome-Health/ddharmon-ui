import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import type { JobResult } from "@/types";

/**
 * A parked or finished run never shows a gate's EMPTY state while its result is still downloading (2026-11-13).
 *
 * THE DEFECT. A live build reads a run over two channels (`useHarmonizeStream`): a THIN stream frame that says where
 * the run stands, and a separate `/result` fetch for the payload. The frame lands first. Gate 1 read "parked, no
 * groups" as a run that genuinely formed nothing and said "No groups formed — Every variable was left unassigned…"
 * until the payload landed: ~1 s on prod for a cold guest opening the shared demo (its `/result` is ~7 MB), ~2.8 s on
 * a hard load, longer on a conference network. It was the first thing a demo guest saw. Gate 3 made the same claim
 * ("No transform specs to review") for the same window — and before the frame itself, and after a failed download.
 *
 * WHY THIS IS ITS OWN PROJECT, ON A NON-STATIC BUILD. The static build — every other e2e spec's — has no stream: it
 * loads the whole fixture in one fetch, so it never holds a frame without its payload and cannot show this defect at
 * all. This project builds the app as it ships (`playwright.config.ts`, project `stream`) and answers its `/api` here:
 * the stream serves the real fixture's thin frame, and `/result` is HELD until the test releases it. Every unrouted
 * `/api` call answers 404 in the page, so nothing reaches a backend.
 *
 *   run: E2E_PORT=4205 npx playwright test --project stream
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const STATIC = resolve(HERE, "../../public/static-data");

/** A finished run with Gate 2 and 3's records. Its bundled copy predates concept groups, so it is not used on Gate 1. */
const FINISHED_JOB = "demo-aireadi_aou_clsa_mesa_ukbb";
/** A run parked at Gate 1, with its concept groups. */
const PARKED_JOB = "demo-staged-gate1";

/** The parked run, re-stated as finished — what the shared demo is on prod: complete, with its Gate 1 groups. */
function finished(run: JobResult): void {
  run.status = "complete";
  run.phase = "complete";
}

function fixture(jobId: string): JobResult {
  return JSON.parse(readFileSync(resolve(STATIC, `result-${jobId}.json`), "utf8")) as JobResult;
}

/** The keys the stream frame does not carry (`lib/stream-payload.ts`) — they come from `/result` alone. */
const PAYLOAD_KEYS = ["result", "decisions", "analysisIdeas", "composites", "config", "dictionaries", "demoScore"];

/** The run as the stream announces it: live fields and a version token, no payload. */
function thinFrame(run: JobResult): Record<string, unknown> {
  const frame: Record<string, unknown> = { ...run, resultVersion: run.resultVersion || 1 };
  for (const key of PAYLOAD_KEYS) delete frame[key];
  return frame;
}

interface Hold {
  /** Re-state the run before it is served. */
  mutate?: (run: JobResult) => void;
  /** Hold the stream as well, so until the release the page has no frame at all. */
  holdStream?: boolean;
  /** Answer `/result` with a server error once released — a dropped download. */
  failResult?: boolean;
}

/** What a failed `/result` answers; the screen repeats the server's sentence. */
const RESULT_FAILURE = "The result download was dropped.";

/**
 * Serve `jobId` the way a live server does, with its `/result` held. Returns the release: until it is called, the
 * page has the frame and not the payload — the window the defect lived in.
 */
async function serveHeld(
  page: Page,
  jobId: string,
  { mutate, holdStream = false, failResult = false }: Hold = {},
): Promise<() => void> {
  const run = fixture(jobId);
  mutate?.(run);
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));

  // Registered first, so it is the FALLBACK: Playwright tries the most recently registered route first.
  await page.route("**/api/**", (route) =>
    route.fulfill({ status: 404, contentType: "application/json", body: '{"detail":"not routed in this spec"}' }),
  );
  await page.route("**/api/harmonize/jobs", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  );
  await page.route("**/api/harmonize/models", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: readFileSync(resolve(STATIC, "models.json"), "utf8") }),
  );
  await page.route(`**/api/harmonize/stream/${jobId}*`, async (route) => {
    if (holdStream) await released;
    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      body: `event: progress\ndata: ${JSON.stringify(thinFrame(run))}\n\n`,
    });
  });
  await page.route(`**/api/harmonize/result/${jobId}*`, async (route) => {
    await released;
    await route.fulfill(
      failResult
        ? { status: 500, contentType: "application/json", body: JSON.stringify({ detail: RESULT_FAILURE }) }
        : { status: 200, contentType: "application/json", body: JSON.stringify(run) },
    );
  });
  return release;
}

/** Long enough that a screen which reads the bare frame as a finding has rendered that finding. */
const HOLD_MS = 1500;

/** What each gate wrongly claimed about the run while its result was downloading. */
const FALSE_EMPTY = [/No groups formed/i, /Nothing grouped above the threshold/i, /Nothing was passed from Gate 1/i, /No transform specs to review/i];

async function expectNoFalseEmpty(page: Page): Promise<void> {
  for (const re of FALSE_EMPTY) await expect(page.locator("body")).not.toContainText(re);
}

for (const [label, mutate] of [
  ["parked at Gate 1", undefined],
  ["finished", finished],
] as const) {
  test(`@gate1 a run ${label} shows a loading state, not "No groups formed", until its result lands`, async ({ page }) => {
    const release = await serveHeld(page, PARKED_JOB, { mutate });
    await page.goto(`/run/${PARKED_JOB}/gate1`);

    const loading = page.getByTestId("gate1-loading");
    await expect(loading).toBeVisible();
    await expect(page.getByTestId("gate-empty-state")).toContainText("Loading this run");
    await page.waitForTimeout(HOLD_MS);
    await expect(loading).toBeVisible();
    await expectNoFalseEmpty(page);

    release();
    await expect(page.locator("[data-testid='ledger-row']").first()).toBeVisible();
    await expect(loading).toHaveCount(0);
    await expectNoFalseEmpty(page);
  });
}

test("@gate2 a finished run shows a loading state, not an empty scope, until its result lands", async ({ page }) => {
  const release = await serveHeld(page, FINISHED_JOB);
  await page.goto(`/run/${FINISHED_JOB}/gate2`);

  await expect(page.getByTestId("gate-empty-state")).toContainText("Loading this run");
  await page.waitForTimeout(HOLD_MS);
  await expect(page.getByTestId("gate-empty-state")).toContainText("Loading this run");
  await expectNoFalseEmpty(page);

  release();
  await expect(page.getByTestId("gate-empty-state")).toHaveCount(0);
  await expectNoFalseEmpty(page);
});

test('@gate3 a finished run shows a loading state, not "No transform specs to review", until its result lands', async ({
  page,
}) => {
  const release = await serveHeld(page, FINISHED_JOB);
  await page.goto(`/run/${FINISHED_JOB}/gate3`);

  const loading = page.getByTestId("gate3-loading");
  await expect(loading).toBeVisible();
  await page.waitForTimeout(HOLD_MS);
  await expect(loading).toBeVisible();
  await expectNoFalseEmpty(page);

  release();
  await expect(page.locator("[data-testid='spec-row']").first()).toBeVisible();
  await expect(loading).toHaveCount(0);
  await expectNoFalseEmpty(page);
});

test('@gate3 a run whose stream frame has not arrived shows a loading state, not "No transform specs to review"', async ({
  page,
}) => {
  const release = await serveHeld(page, FINISHED_JOB, { holdStream: true });
  await page.goto(`/run/${FINISHED_JOB}/gate3`);

  const loading = page.getByTestId("gate3-loading");
  await expect(loading).toBeVisible();
  await page.waitForTimeout(HOLD_MS);
  await expect(loading).toBeVisible();
  await expectNoFalseEmpty(page);

  release();
  await expect(page.locator("[data-testid='spec-row']").first()).toBeVisible();
  await expect(loading).toHaveCount(0);
  await expectNoFalseEmpty(page);
});

for (const [gate, jobId, testId] of [
  ["gate1", PARKED_JOB, "gate1-result-failed"],
  ["gate2", FINISHED_JOB, null],
  ["gate3", FINISHED_JOB, "gate3-result-failed"],
] as const) {
  test(`@${gate} a run whose result fails to download says it didn't load, not that the run is empty`, async ({
    page,
  }) => {
    const release = await serveHeld(page, jobId, { failResult: true });
    release();
    await page.goto(`/run/${jobId}/${gate}`);

    const emptyState = page.getByTestId("gate-empty-state");
    await expect(emptyState).toContainText("This run's result didn't load");
    await expect(emptyState).toContainText(RESULT_FAILURE);
    if (testId) await expect(page.getByTestId(testId)).toBeVisible();
    await expect(emptyState).not.toContainText("Loading this run");
    await expectNoFalseEmpty(page);
  });
}
