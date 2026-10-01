import { expect, test, type Page } from "@playwright/test";
import { railCosts } from "@/lib/gate-rail";
import type { GatePosition, JobResult } from "@/types";
import { FINISHED_JOB, serveFinished } from "./gate23-fixture";
import { PAUSED_JOB, asOwnedRun, serveRun } from "./gate1-fixture";

/**
 * The gate chrome on a FINISHED run, looked at from its past screens (phase-8 final review, round 1: O1-O3).
 *
 * The review was done on a run parked at Gate 4 — every paid leg bought, every gate behind it a frozen record.
 * Three things in the shared chrome described the SCREEN being viewed instead of the RUN:
 *
 *  - O1  the rail read later gates as "est. pending" depending on which past screen was open, while the header
 *        said the whole run had been paid for. The rail is the run's identity: every gate the run has passed
 *        shows what it actually cost, from any screen, and the columns still sum to the header.
 *  - O2  a frozen gate's Continue bar still offered the purchase ("Pressing Continue to Gate 3 buys $0.02 …
 *        not refundable"). The bar stays, but on a past gate it says what happened.
 *  - O3  Gate 1 showed "Paused at Gate 1 · resume any time" on a run parked at Gate 4. The resume banner is the
 *        gate the run is actually parked at, and nowhere else.
 *
 *   run: npm run test:e2e -- --grep "@finished-chrome"
 */

/** A realistic per-stage ledger: Gate 1 $0.26, Gate 2 $0.14, Gate 3 $0.02, Gate 4 (a score match) $0.06. */
const LEDGER: Record<string, number> = {
  generating: 0.2,
  splitting: 0.06,
  assigning: 0.1,
  gencde: 0.04,
  specs: 0.02,
  composite: 0.06,
};
const TOTAL = 0.48;

function withLedger(run: JobResult): void {
  const perStage = Object.fromEntries(
    Object.entries(LEDGER).map(([k, usd]) => [k, { usd, inputTokens: 0, outputTokens: 0, calls: 1 }]),
  );
  run.result!.cost = { actualUsd: TOTAL, tokens: { input: 0, output: 0 }, perStage };
  // The header's figure: the live frame's own total when it carries one (the paused fixture does, as 0).
  run.costSoFar = TOTAL;
}

/** The reviewed state: an owned run, parked at Gate 4, with a ledger. */
function parkAtGate4(run: JobResult): JobResult {
  run.status = "awaiting_review";
  run.gatePosition = "gate4";
  if (run.result) (run.result as { gatePosition?: GatePosition }).gatePosition = "gate4";
  withLedger(run);
  return asOwnedRun(run);
}

/** Gate 1 needs the concept groups the paused fixture carries; Gates 2-4 need the finished demo's records. */
async function openParkedAtGate4(page: Page, gate: GatePosition): Promise<void> {
  if (gate === "gate1" || gate === "setup") {
    await serveRun(page, parkAtGate4);
    await page.goto(`/run/${PAUSED_JOB}/${gate}`);
  } else {
    await serveFinished(page, parkAtGate4);
    await page.goto(`/run/${FINISHED_JOB}/${gate}`);
  }
  await page.waitForLoadState("networkidle");
  await expect(page.locator("[data-testid='gate-rail']")).toBeVisible();
}

function usd(text: string | null): number {
  const m = /\$([0-9.]+)/.exec(text ?? "");
  return m ? Number(m[1]) : 0;
}

// --- O1: the rail is the RUN's state -------------------------------------------------------------------------

test.describe("finished run — the rail", () => {
  test("@finished-chrome @rail a run parked at Gate 4 reads realized on every gate, whichever screen is open", () => {
    const realizedByGate = { gate1: 0.26, gate2: 0.14, gate3: 0.02, gate4: 0.06 };
    for (const viewed of ["setup", "gate1", "gate2", "gate3", "gate4"] as GatePosition[]) {
      const costs = railCosts(viewed, { realizedByGate, totalRealized: TOTAL, runPosition: "gate4" });
      expect(costs.map((c) => c.gate)).toEqual(["setup", "gate1", "gate2", "gate3", "gate4"]);
      expect(
        costs.map((c) => c.cost.kind),
        `viewed from ${viewed}`,
      ).toEqual(["state", "realized", "realized", "realized", "realized"]);
      expect(costs.map((c) => c.cost.text)).toEqual(["local", "spent $0.26", "spent $0.14", "spent $0.02", "spent $0.06"]);
    }
  });

  test("@finished-chrome @rail a run parked at Gate 2, viewed from Gate 1: Gate 2 is spent, Gate 3 is still ahead", () => {
    const costs = railCosts("gate1", { realizedByGate: { gate1: 0.26, gate2: 0.14 }, totalRealized: 0.4, runPosition: "gate2" });
    const byGate = Object.fromEntries(costs.map((c) => [c.gate, c.cost]));
    expect(byGate.gate1).toEqual({ kind: "realized", text: "spent $0.26" });
    expect(byGate.gate2).toEqual({ kind: "realized", text: "spent $0.14" });
    expect(byGate.gate3.kind).toBe("forecast");
  });

  test("@finished-chrome @rail with no run position the rail keeps reading the screen's own position", () => {
    // No run behind the chrome (a draft Setup, a 404 run) — nothing to promote, so the old rule stands.
    const costs = railCosts("gate2", { totalRealized: 0.4 });
    expect(costs.map((c) => c.cost.kind)).toEqual(["state", "realized", "realized", "forecast", "state"]);
  });

  test("@finished-chrome @rail an unledgered total lands on the run's furthest gate, so the columns still sum to it", () => {
    // Viewed from Gate 1 of a run parked at Gate 2 with no per-stage ledger: the total is not attributable per
    // gate, so it sits on the gate the run has reached — never on the screen that happens to be open.
    const costs = railCosts("gate1", { totalRealized: 0.4, runPosition: "gate2" });
    const byGate = Object.fromEntries(costs.map((c) => [c.gate, c.cost]));
    expect(byGate.gate1).toEqual({ kind: "realized", text: "spent $0" });
    expect(byGate.gate2).toEqual({ kind: "realized", text: "spent $0.40" });
    const sum = costs.reduce((s, c) => s + (c.cost.kind === "realized" ? usd(c.cost.text) : 0), 0);
    expect(sum).toBeCloseTo(0.4, 10);
  });

  for (const viewed of ["setup", "gate1", "gate2", "gate3", "gate4"] as GatePosition[]) {
    test(`@finished-chrome @rail viewed from ${viewed}, every passed gate shows its spend and the rail sums to the header`, async ({
      page,
    }) => {
      await openParkedAtGate4(page, viewed);
      const expected: Record<string, string> = {
        gate1: "spent $0.26",
        gate2: "spent $0.14",
        gate3: "spent $0.02",
        gate4: "spent $0.06",
      };
      for (const [gate, text] of Object.entries(expected)) {
        const cost = page.locator(`[data-testid='gate-rail'] li[data-gate='${gate}'] [data-cost]`);
        await expect(cost, `${gate} viewed from ${viewed}`).toHaveAttribute("data-cost", "realized");
        await expect(cost).toHaveText(text);
      }
      await expect(page.locator("[data-testid='gate-rail']")).not.toContainText("est. pending");
      // THE INVARIANT: the rail's realized columns sum to what the header says the run spent.
      const texts = await page
        .locator("[data-testid='gate-rail'] [data-cost='realized']")
        .evaluateAll((els) => els.map((el) => el.textContent ?? ""));
      const sum = texts.reduce((s, t) => s + usd(t), 0);
      const chip = await page.locator("[data-testid='run-chip']").textContent();
      expect(usd(chip)).toBeCloseTo(TOTAL, 10);
      expect(sum).toBeCloseTo(usd(chip), 10);
    });
  }
});
