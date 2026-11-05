/**
 * I12 — while a paid leg is still running, the next gate never shows an empty state that tells the reviewer
 * nothing was passed to it (F4: Gate 2 said "Nothing was passed from Gate 1 … tick at least one group" while
 * 8 groups were in flight, with a call to action pointing at a gate that was already frozen).
 *
 * The driver starts this spec right after it presses Continue (`LIVE_STAGE=inflight`), so the checks below run
 * while the worker is busy. Whichever gate the leg is heading to, neither Gate 2 nor Gate 3 may claim to be empty.
 */
import { expect, test } from "@playwright/test";
import { gotoGate, job, onlyAt } from "./live";

const FALSE_EMPTY = [/Nothing was passed from Gate 1/i, /No transform specs to review/i];

test("no false empty state on Gate 2 or Gate 3 while a leg runs", async ({ page, request }) => {
  onlyAt("inflight");
  let looked = 0;
  for (let i = 0; i < 20; i++) {
    const run = await job(request);
    // While a leg runs the status IS the phase name (runner.progress); parked / terminal states end the watch.
    if (!run || ["awaiting_review", "complete", "error", "cancelled"].includes(String(run.status))) break;
    for (const gate of ["gate2", "gate3"]) {
      await gotoGate(page, gate);
      const empty = page.getByTestId("gate-empty-state");
      if (await empty.count()) {
        const text = (await empty.first().textContent()) ?? "";
        for (const re of FALSE_EMPTY) {
          expect.soft(re.test(text), `${gate} claims "${text.slice(0, 90)}" while the leg is ${run.status}`).toBe(false);
        }
      }
      looked += 1;
    }
    await page.waitForTimeout(1500);
  }
  test.skip(looked === 0, "the leg finished before the page could be checked");
});
