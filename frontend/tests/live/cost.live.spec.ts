/**
 * I2 (display half) — every place a gate screen states money spent agrees with every other, and with the run.
 *
 * The header chip, the rail's per-gate realized amounts, and Gate 3/4's "Already spent to reach this gate" are
 * three views of one number. The walk found them disagreeing (F3 header reset mid-leg, F14 per-leg totals,
 * F10 a rail value changing after the fact). The server-side half (ledger ⊇, monotonic) is in the driver.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { OUT, STAGE, gotoGate, job, onlyAt, usd } from "./live";

const GATES = ["gate1", "gate2", "gate3", "gate4"] as const;
const RAIL_LOG = OUT ? join(OUT, "rail.json") : "";

async function railByGate(page: Page): Promise<Record<string, number>> {
  const rail = page.getByTestId("gate-rail");
  const out: Record<string, number> = {};
  for (const g of GATES) {
    const cell = rail.locator(`li[data-gate="${g}"] [data-cost="realized"]`);
    if (await cell.count()) out[g] = usd(await cell.first().textContent());
  }
  return out;
}

test.describe("I2 spend display", () => {
  test("header chip == the run's cost == rail realized sum == 'already spent'", async ({ page, request }) => {
    onlyAt("gate1", "gate2", "gate3", "gate4");
    const run = await job(request);
    await gotoGate(page, STAGE);
    const chip = page.getByTestId("run-chip");
    await expect(chip).toBeVisible();
    const header = usd(await chip.textContent());
    expect.soft(header, "the header chip shows the run's cost").toBeCloseTo(Number(run.costSoFar ?? 0), 3);

    const byGate = await railByGate(page);
    const railSum = Object.values(byGate)
      .filter((v) => Number.isFinite(v))
      .reduce((s, v) => s + v, 0);
    expect.soft(railSum, `rail realized ${JSON.stringify(byGate)} sums to the header`).toBeCloseTo(header, 2);

    const spentHere = page.getByText(/Already spent to reach this gate/);
    if (await spentHere.count()) {
      const said = usd(await spentHere.first().textContent());
      if (Number.isFinite(said)) expect.soft(said, "'Already spent' == header").toBeCloseTo(header, 2);
    }

    if (RAIL_LOG) {
      const log = existsSync(RAIL_LOG) ? JSON.parse(readFileSync(RAIL_LOG, "utf8")) : {};
      log[STAGE] = byGate;
      writeFileSync(RAIL_LOG, JSON.stringify(log, null, 1));
    }
  });

  test("a past gate's rail amount does not change after the run moves on", async ({ page }) => {
    onlyAt("gate2", "gate3", "gate4");
    test.skip(!RAIL_LOG || !existsSync(RAIL_LOG), "no earlier rail reading recorded this iteration");
    const log = JSON.parse(readFileSync(RAIL_LOG, "utf8"));
    await gotoGate(page, STAGE);
    const now = await railByGate(page);
    const here = GATES.indexOf(STAGE as (typeof GATES)[number]);
    for (const past of GATES.slice(0, here)) {
      // What this gate's rail cell read on the screen AFTER it: the moment its own leg's spend was final.
      const next = GATES[GATES.indexOf(past) + 1];
      const then = log[next]?.[past];
      if (then === undefined || !Number.isFinite(then)) continue;
      expect.soft(now[past], `${past}'s realized amount read ${then} at ${next}, now ${now[past]}`).toBeCloseTo(then, 3);
    }
  });
});
