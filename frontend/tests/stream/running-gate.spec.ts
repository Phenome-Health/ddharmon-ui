import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import type { JobResult } from "@/types";

/**
 * The gate a leg is running toward, walked the way a live server serves it (user test 2026-11-25).
 *
 * Bhargav pressed Continue on Gate 2 and Gate 3's leg ran ("Specs 92 / 819") — but the progress sat on Gate 2's
 * screen, the Gate 3 cell read "est. pending" and could not be clicked. The static half (`tests/e2e/running-gate`)
 * asserts the rail and the panel's placement from a fixed state; this half drives the transitions a static build
 * cannot have: Continue landing on the running gate, clicking back and forward along the rail mid-leg, a reload
 * mid-leg, and a stop.
 *
 * Every `/api` call is answered here — the stream from a mutable `state` (the client reconnects between frames, so a
 * change to it is what the next frame says), `/result` from the same run — and anything unrouted answers 404 in the
 * page, so nothing reaches a backend.
 *
 *   run: E2E_PORT=4420 npx playwright test --project stream running-gate
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const STATIC = resolve(HERE, "../../public/static-data");
const JOB = "demo-aireadi_aou_clsa_mesa_ukbb";

/** The keys the stream frame does not carry (`lib/stream-payload.ts`) — they come from `/result` alone. */
const PAYLOAD_KEYS = ["result", "decisions", "analysisIdeas", "composites", "config", "dictionaries", "demoScore"];

function fixture(): JobResult {
  const run = JSON.parse(readFileSync(resolve(STATIC, `result-${JOB}.json`), "utf8")) as JobResult;
  // Trimmed for speed only (the shape is unchanged); an OWNED run, so Continue is the paid resume, not the demo walk.
  if (run.result?.records) run.result.records = run.result.records.slice(0, 12);
  const { demo: _demo, ...config } = (run.config ?? {}) as Record<string, unknown>;
  run.config = config as JobResult["config"];
  return run;
}

/** Where the run stands; every route below reads it at request time. */
interface Live {
  status: string;
  phase: string;
  gatePosition: string;
  stopping: boolean;
}

async function serveLive(page: Page, state: Live): Promise<{ cancelled: string[] }> {
  const base = fixture();
  const cancelled: string[] = [];
  const run = (): JobResult => ({ ...base, ...state }) as unknown as JobResult;
  const frame = (): Record<string, unknown> => {
    const f: Record<string, unknown> = { ...run(), resultVersion: base.resultVersion || 1 };
    for (const key of PAYLOAD_KEYS) delete f[key];
    return f;
  };

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
  await page.route(`**/api/harmonize/stream/${JOB}*`, (route) =>
    route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      body: `event: progress\ndata: ${JSON.stringify(frame())}\n\n`,
    }),
  );
  await page.route(`**/api/harmonize/result/${JOB}*`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(run()) }),
  );
  await page.route(`**/api/harmonize/resume/${JOB}`, (route) => {
    // The server's resume: the run leaves `awaiting_review` before it answers, still carrying the gate it LEFT.
    Object.assign(state, { status: "pending", phase: "pending", stopping: false });
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ jobId: JOB, resumedFrom: "gate2", target: "gate3" }),
    });
  });
  await page.route(`**/api/harmonize/checkpoint/${JOB}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        jobId: JOB,
        status: state.status,
        gatePosition: state.gatePosition,
        resumeGate: state.gatePosition,
        nextGate: "gate3",
        resultVersion: base.resultVersion || 1,
        costSoFar: 0.35,
      }),
    }),
  );
  await page.route(`**/api/harmonize/jobs/${JOB}/cancel*`, (route) => {
    cancelled.push(new URL(route.request().url()).searchParams.get("mode") ?? "");
    Object.assign(state, { stopping: true });
    return route.fulfill({ status: 200, contentType: "application/json", body: '{"cancelled":true}' });
  });
  return { cancelled };
}

const cell = (page: Page, gate: string) => page.locator(`[data-testid='gate-rail'] li[data-gate='${gate}']`);

test("@running-gate Continue lands on the running gate; the rail walks back and forward mid-leg; a reload stays put", async ({
  page,
}) => {
  const state: Live = { status: "awaiting_review", phase: "awaiting_review", gatePosition: "gate2", stopping: false };
  await serveLive(page, state);
  await page.goto(`/run/${JOB}/gate2`);
  await expect(page.getByTestId("gate2-concept").first()).toBeVisible();

  // CONTINUE: the leg starts, and the reviewer is on the gate it is producing — with the progress there.
  await page.getByTestId("gate2-continue").click();
  state.status = "specs";
  state.phase = "specs";
  await expect(page).toHaveURL(new RegExp(`/run/${JOB}/gate3$`));
  await expect(page.getByTestId("run-progress")).toBeVisible();
  await expect(cell(page, "gate3")).toHaveAttribute("aria-current", "step");
  await expect(cell(page, "gate3")).toContainText("in progress");

  // BACK to Gate 2 on the rail: a read-back of what was decided there, with no progress panel on it…
  await page.getByTestId("rail-link-gate2").click();
  await expect(page).toHaveURL(new RegExp(`/run/${JOB}/gate2$`));
  await expect(page.getByTestId("gate2-concept").first()).toBeVisible();
  await expect(page.getByTestId("run-progress")).toHaveCount(0);
  // …and the running gate is one click away, saying what it is doing.
  const forward = page.getByTestId("rail-link-gate3");
  await expect(forward).toContainText("in progress");
  await forward.click();
  await expect(page).toHaveURL(new RegExp(`/run/${JOB}/gate3$`));
  await expect(page.getByTestId("run-progress")).toBeVisible();

  // A RELOAD mid-leg resolves to the same progress view — not a blank screen, not an error.
  await page.reload();
  await expect(page.getByTestId("run-progress")).toBeVisible();
  await expect(page.getByTestId("run-progress-stage")).toContainText(/specs/i);
  await expect(cell(page, "gate3")).toContainText("in progress");
});

test("@running-gate a stopped leg takes 'in progress' off the rail, and the gate it never reached is no longer a link", async ({
  page,
}) => {
  const state: Live = { status: "specs", phase: "specs", gatePosition: "gate2", stopping: false };
  const { cancelled } = await serveLive(page, state);
  await page.goto(`/run/${JOB}/gate2`);
  await expect(page.getByTestId("rail-link-gate3")).toContainText("in progress");

  // Stop from the run title (it is on every screen; it is a control, not a progress marker).
  await page.getByRole("button", { name: /^Stop/ }).first().click();
  await page.getByRole("button", { name: /Stop & keep results/ }).click();
  await expect.poll(() => cancelled).toEqual(["keep"]);
  // The server ends the leg: a kept stop is `cancelled` with what it finished attached.
  Object.assign(state, { status: "cancelled", phase: "cancelled", stopping: false });

  await expect(cell(page, "gate3")).not.toContainText("in progress", { timeout: 15_000 });
  await expect(page.getByTestId("rail-link-gate3")).toHaveCount(0);
  await expect(page.getByTestId("rail-ahead-gate3")).toBeVisible();
  await expect(page.getByTestId("run-progress")).toHaveCount(0);
  // Gate 2's own content is still there to read.
  await expect(page.getByTestId("gate2-concept").first()).toBeVisible();
});
