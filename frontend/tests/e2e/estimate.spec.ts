import { expect, test } from "@playwright/test";
import {
  COHERENCE_MIN_MEMBERS,
  GATE_LEDGER_KEYS,
  STAGE_SHARES,
  estimateRunCostBreakdown,
  realizedSpendByGate,
} from "@/lib/estimate";

/**
 * The run estimate (08-12 Task 2) — R8's arithmetic, asserted as arithmetic.
 *
 * R8: **never quote a cost lower than what will be charged.** The estimator is a plain function precisely
 * so that claim can be checked without rendering a page: the invariant below runs it over every
 * configuration flag combination and asserts the quoted total covers every stage that configuration will
 * actually run. The two browser tests at the end exercise the Setup estimate end to end, for the case where
 * a group qualifies for the coherence judge and the case where none does.
 *
 *   run: npm run test:e2e -- --grep "@estimate"
 */

/** Every combination of the three configuration flags the quote depends on. */
const FLAG_COMBINATIONS = [false, true].flatMap((genSpecs) =>
  [false, true].flatMap((suggestIdeas) =>
    [false, true].map((conceptGate) => ({ genSpecs, suggestIdeas, conceptGate })),
  ),
);

function csv(rows: number): string {
  const header = "variable_name,description\n";
  return header + Array.from({ length: rows }, (_, i) => `var_${i},a description of variable ${i}`).join("\n");
}

test.describe("run estimate", () => {
  test("@estimate the coherence line is always present, and zero rather than omitted", () => {
    // A corpus large enough that some group clears the judge's member floor.
    const judged = estimateRunCostBreakdown(1000, 5, "batch", true);
    const coherence = judged.lines.find((l) => /coherence/i.test(l.label));
    expect(coherence).toBeTruthy();
    expect(coherence!.cost).toBeGreaterThan(0);
    // The judge's price is legible as WORK as well as money.
    expect(judged.judgeCalls).toBeGreaterThan(0);
    expect(coherence!.note).toContain(String(judged.judgeCalls));

    // A corpus that cannot produce a single group of the judge's minimum size. The line STILL appears: a
    // line that disappears is indistinguishable from one that was never considered.
    const unjudged = estimateRunCostBreakdown(COHERENCE_MIN_MEMBERS - 2, 1, "batch", true);
    const zero = unjudged.lines.find((l) => /coherence/i.test(l.label));
    expect(zero).toBeTruthy();
    expect(zero!.cost).toBe(0);
    expect(unjudged.judgeCalls).toBe(0);
  });

  test("@estimate exact group sizes replace the estimated judge-call count", () => {
    const sizes = [2, 5, 6, 9, 40]; // three of them clear the >= 6 floor
    const b = estimateRunCostBreakdown(1000, 5, "batch", true, false, { groupSizes: sizes });
    expect(b.judgeCalls).toBe(3);
    expect(b.judgeCallsEstimated).toBe(false);
    expect(estimateRunCostBreakdown(1000, 5, "batch", true).judgeCallsEstimated).toBe(true);
  });

  test("@estimate the quoted total is never lower than the stages that will run", () => {
    // THE PROHIBITION, EXPRESSED AS ARITHMETIC. For every configuration: sum the shares of the stages that
    // configuration will actually run, price them independently of the breakdown, and assert the quote
    // covers them. Over-quoting passes; under-quoting by a cent does not.
    for (const fields of [6, 60, 1000, 22000]) {
      for (const cohorts of [1, 5]) {
        for (const mode of ["batch", "sync"] as const) {
          for (const { genSpecs, suggestIdeas, conceptGate } of FLAG_COMBINATIONS) {
            const b = estimateRunCostBreakdown(fields, cohorts, mode, genSpecs, suggestIdeas, { conceptGate });
            const modeFactor = mode === "sync" ? 2 : 1;
            const base = fields * 0.0026 * (1 + 0.08 * Math.max(0, cohorts - 1)) * modeFactor;
            let willRun = (STAGE_SHARES.ideal + STAGE_SHARES.splitAssign + STAGE_SHARES.gencde) * base;
            if (genSpecs) willRun += STAGE_SHARES.specgen * base;
            expect(b.total.mid + 1e-9).toBeGreaterThanOrEqual(willRun);
            // And every stage that will run is NAMED, not merely covered by a big enough number.
            const labels = b.lines.map((l) => l.label.toLowerCase()).join(" | ");
            expect(labels).toContain("split");
            expect(labels).toContain("coherence");
            if (genSpecs) expect(labels).toContain("spec");
            expect(/concept.match/.test(labels)).toBe(conceptGate);
            if (suggestIdeas) expect(labels).toContain("analysis");
          }
        }
      }
    }
  });

  test("@estimate the per-gate breakdown matches the revised stage spans", () => {
    const b = estimateRunCostBreakdown(1000, 5, "batch", true);
    // UI-SPEC §0.1: reaching Gate 1 pays concept generation, splitting and the judge; Gate 2 pays
    // assignment; Gate 3 pays spec generation. Setup, Gate 0 and Gate 4 call no model.
    expect(b.byGate.setup.forecast).toBe(0);
    expect(b.byGate.gate0.forecast).toBe(0);
    expect(b.byGate.gate4.forecast).toBe(0);
    expect(b.byGate.gate1.forecast).toBeGreaterThan(0);
    expect(b.byGate.gate2.forecast).toBeGreaterThan(0);
    expect(b.byGate.gate3.forecast).toBeGreaterThan(0);
    // Gate 0's Continue is the run's FIRST CHARGE, and it is what reaching Gate 1 costs.
    expect(b.firstCharge).toBeGreaterThan(0);
    expect(b.firstCharge).toBe(b.byGate.gate1.forecast);
    // Each gate's realized cost is attributed by LEDGER KEY, never by inventing a progress phase — the
    // judge reports under an existing phase and carries its own cost key (WINDOWS id20).
    expect(GATE_LEDGER_KEYS.gate1).toEqual(["generating", "splitting", "judging", "kinds"]);
    expect(GATE_LEDGER_KEYS.gate2).toEqual(["assigning", "gencde"]);
    expect(GATE_LEDGER_KEYS.gate3).toEqual(["specs", "refine", "concept_gate"]);
    expect(GATE_LEDGER_KEYS.gate0).toEqual([]);
    expect(GATE_LEDGER_KEYS.gate4).toEqual([]);
  });

  test("@estimate an unmeasured split/assign division quotes the FULL combined share", () => {
    const b = estimateRunCostBreakdown(1000, 5, "batch", true);
    const base = 1000 * 0.0026 * 1.32;
    expect(b.byGate.gate1.divisionUnmeasured).toBe(true);
    expect(b.byGate.gate2.divisionUnmeasured).toBe(true);
    // Gate 1's figure carries the WHOLE combined share, not a guessed fraction of it. An assumed even
    // split landing under the true split cost would under-quote the first charge the user ever sees.
    const idealPlusCombined = (STAGE_SHARES.ideal + STAGE_SHARES.splitAssign) * base;
    expect(b.byGate.gate1.forecast).toBeGreaterThanOrEqual(idealPlusCombined);
    expect(b.byGate.gate2.forecast).toBeGreaterThanOrEqual(STAGE_SHARES.splitAssign * base);
    // Which means the per-gate figures OVERLAP by exactly that share, and say so rather than hiding it.
    const perGate = Object.values(b.byGate).reduce((s, g) => s + g.forecast, 0);
    expect(perGate).toBeGreaterThan(b.total.mid);
    expect(b.byGate.gate1.note).toMatch(/unmeasured/i);
  });

  test("@estimate realized spend and a forecast cannot be read for each other", () => {
    const b = estimateRunCostBreakdown(1000, 5, "batch", true);
    // A forecast entry has no realized field, and a realized entry has no forecast field — so a screen
    // cannot render one as though it were the other by reaching for the wrong key.
    expect(Object.keys(b.byGate.gate1)).not.toContain("realized");
    expect("forecast" in b.byGate.gate2).toBe(true);

    const realized = realizedSpendByGate({
      actualUsd: 3,
      tokens: { input: 0, output: 0 },
      perStage: {
        generating: { usd: 0.5, inputTokens: 0, outputTokens: 0, calls: 1 },
        judging: { usd: 0.25, inputTokens: 0, outputTokens: 0, calls: 1 },
        assigning: { usd: 2, inputTokens: 0, outputTokens: 0, calls: 1 },
        mystery_stage: { usd: 0.25, inputTokens: 0, outputTokens: 0, calls: 1 },
      },
    });
    expect(Object.keys(realized.byGate.gate1 === undefined ? {} : realized.byGate)).toContain("gate1");
    expect(realized.byGate.gate1).toBeCloseTo(0.75, 6);
    expect(realized.byGate.gate2).toBeCloseTo(2, 6);
    expect(realized.byGate.gate0).toBe(0);
    // A ledger key no gate claims is SURFACED, not folded into the nearest gate — money whose origin the
    // screen cannot explain is exactly what a cost screen must not invent an explanation for.
    expect(realized.unattributed).toBeCloseTo(0.25, 6);
    expect(realized.total).toBeCloseTo(3, 6);
    expect("forecast" in realized).toBe(false);
  });

  test("@estimate the Setup estimate shows a non-zero coherence line for a real corpus", async ({ page }) => {
    await page.goto("/new");
    await page.waitForLoadState("networkidle");
    await page.locator("input[type=file]").setInputFiles({
      name: "cohort-a.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(csv(60)),
    });
    const line = page.locator("[data-cost-line='coherence']");
    await expect(line).toBeVisible();
    await expect(line).not.toHaveText(/\$0$/);
    await expect(line).toContainText("judge");
  });

  test("@estimate the Setup estimate shows the coherence line as $0 when no group can qualify", async ({ page }) => {
    await page.goto("/new");
    await page.waitForLoadState("networkidle");
    await page.locator("input[type=file]").setInputFiles({
      name: "tiny.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(csv(3)),
    });
    const line = page.locator("[data-cost-line='coherence']");
    await expect(line).toBeVisible();
    await expect(line).toContainText("$0");
  });
});
