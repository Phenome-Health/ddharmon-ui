import { expect, test, type Page } from "@playwright/test";

/**
 * 08-28 0e — "Finish now with sync", rendered.
 *
 * A batch run spends most of its wall clock in the provider's queue. The run-progress readout offers an
 * escape hatch beside the queue-wait copy: cancel the queued batch, keep whatever it already finished, and
 * run the rest now at the full rate. The state machine is asserted without a browser in
 * `run-progress.spec.ts` (`syncSwitchState`); this file asserts what only a render can show — the control
 * appears ONLY while the in-flight batch is switchable, it states its price, it POSTs the switch for THIS run
 * exactly once, a refusal is said out loud, and a switched leg stops claiming to wait in a queue.
 *
 * Same fixture and seam as the run-progress readout in `gates.spec.ts`: the bundled paused Gate 1 run, put
 * into an in-flight state by rewriting its static payload, and the POST fulfilled with `page.route` — so no
 * backend, no key and no paid call.
 *
 *   run: npm run test:e2e -- --grep "@syncswitch"
 */

const JOB = "demo-staged-gate1";
const GATE1 = `/run/${JOB}/gate1`;
const SWITCH_URL = `**/api/harmonize/jobs/*/switch-to-sync`;

const IN_PROGRESS = { tag: "generate", nItems: 330, status: "in_progress", switchable: true, syncEstimateUsd: 0.42 };

/** The fixture as a live batch leg polling a batch, with the frame fields the caller chooses. */
async function batchLeg(page: Page, over: Record<string, unknown> = {}, mode = "batch"): Promise<void> {
  const res = await page.request.get(`/static-data/result-${JOB}.json`);
  const payload = (await res.json()) as Record<string, unknown>;
  Object.assign(payload, { status: "generating", phase: "generating", stopping: false, transport: "batch" }, over);
  if (!("batch" in over)) payload.batch = IN_PROGRESS;
  const config = payload.config as Record<string, unknown>;
  config.run_mode = mode;
  config.est_fields = 1000;
  config.est_cohorts = 5;
  delete config.demo;
  await page.route("**/static-data/result-*.json", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(payload) }),
  );
}

async function gotoGate(page: Page): Promise<void> {
  await page.goto(GATE1);
  await page.waitForLoadState("networkidle");
}

const control = (page: Page) => page.getByTestId("run-progress-switch-sync");

test.describe("finish now with sync", () => {
  test("@syncswitch a still-queued batch offers to finish now with sync, priced, beside the queue copy", async ({
    page,
  }) => {
    await batchLeg(page);
    await gotoGate(page);

    await expect(page.getByTestId("run-progress-queue")).toBeVisible();
    const button = control(page);
    await expect(button).toBeVisible();
    await expect(button).toHaveText("Finish now with sync (+$0.42)");
    await expect(button).toBeEnabled();
    // The price is stated as what it is: the full rate for everything the batch was sent, at most.
    const caption = page.getByTestId("run-progress-switch-caption");
    await expect(caption).toContainText("330");
    await expect(caption).toContainText(/already finished is kept/i);
    await expect(caption).toContainText(/next Continue/i);
  });

  test("@syncswitch no offer unless the in-flight batch can be switched", async ({ page }) => {
    const cases: Array<[string, Record<string, unknown>, string?]> = [
      ["not switchable (already pressed)", { batch: { ...IN_PROGRESS, switchable: false } }],
      ["ending on its own", { batch: { ...IN_PROGRESS, status: "canceling", switchable: false } }],
      ["no batch in flight", { batch: null }],
      ["a sync run", { transport: "sync", batch: null }, "sync"],
      ["parked at the gate", { status: "awaiting_review", phase: "awaiting_review" }],
    ];
    for (const [name, over, mode] of cases) {
      await page.unrouteAll();
      await batchLeg(page, over, mode);
      await gotoGate(page);
      await expect(page.locator("[data-testid='gate-rail']")).toBeVisible();
      expect(await control(page).count(), name).toBe(0);
    }
  });

  test("@syncswitch pressing it POSTs the switch for THIS run, once, and acknowledges it", async ({ page }) => {
    await batchLeg(page);
    const posts: { url: string; method: string }[] = [];
    await page.route(SWITCH_URL, async (route) => {
      posts.push({ url: route.request().url(), method: route.request().method() });
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ switched: true, alreadyRequested: false }),
      });
    });
    await gotoGate(page);

    await control(page).click();
    await expect(page.getByTestId("run-progress-switch-requested")).toBeVisible();
    expect(posts).toHaveLength(1);
    expect(posts[0].method).toBe("POST");
    expect(new URL(posts[0].url).pathname).toBe(`/api/harmonize/jobs/${JOB}/switch-to-sync`);
    // No second press: the offer is replaced by the acknowledgement, not left live beside it.
    expect(await control(page).count()).toBe(0);
  });

  test("@syncswitch a refused switch says why and the offer stays usable", async ({ page }) => {
    await batchLeg(page);
    await page.route(SWITCH_URL, (route) =>
      route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ detail: "There is no batch in the provider's queue to switch." }),
      }),
    );
    await gotoGate(page);

    await control(page).click();
    const error = page.getByTestId("run-progress-switch-error");
    await expect(error).toBeVisible();
    await expect(error).toContainText("no batch in the provider's queue");
    await expect(control(page)).toBeEnabled();
  });

  test("@syncswitch a pressed switch the stage has not acted on yet reads as requested, from the stream", async ({
    page,
  }) => {
    // Another tab pressed it: the frame says the batch is un-switchable while still in_progress.
    await batchLeg(page, { batch: { ...IN_PROGRESS, switchable: false } });
    await gotoGate(page);
    await expect(page.getByTestId("run-progress-switch-requested")).toBeVisible();
    expect(await control(page).count()).toBe(0);
  });

  test("@syncswitch while the cancelled batch hands back its finished work, the readout says so", async ({
    page,
  }) => {
    await batchLeg(page, { transport: "sync", batch: { ...IN_PROGRESS, status: "canceling", switchable: false } });
    await gotoGate(page);
    await expect(page.getByTestId("run-progress-switching")).toBeVisible();
    // It is no longer waiting in the queue, and it offers nothing further.
    await expect(page.getByTestId("run-progress-queue")).toHaveCount(0);
    expect(await control(page).count()).toBe(0);
  });

  test("@syncswitch once the leg runs sync, the readout stops claiming a queue and shows real progress", async ({
    page,
  }) => {
    await batchLeg(page, { transport: "sync", batch: null });
    await gotoGate(page);
    await expect(page.getByTestId("run-progress-queue")).toHaveCount(0);
    await expect(page.getByTestId("run-progress-bar")).toBeVisible();
  });
});
