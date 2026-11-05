import { expect, test } from "@playwright/test";
import {
  COHERENCE_MIN_MEMBERS,
  GATE_LEDGER_KEYS,
  RESPLIT_PER_USE_USD,
  SPLIT_ASSIGN_DIVISION,
  STAGE_SHARES,
  estimateRunCostBreakdown,
  newGroupIdealUsd,
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
    // 08-28 1a: paid actions OUTSIDE a leg bill under their own keys, attributed to the gate they are
    // pressed on (score extraction + re-split at Gate 1, recode regeneration at Gate 3, composite + ideas
    // at Gate 4). backend/billing.py's BILLING_KEYS is pinned to this table by a backend test.
    expect(GATE_LEDGER_KEYS.gate1).toEqual([
      "generating",
      "splitting",
      "judging",
      "kinds",
      "score_components",
      "readjudicate",
    ]);
    // new_group_ideal: 08-28 Wave 2 — a reviewer's New group's one generated ideal, bought by Gate 1's Continue
    expect(GATE_LEDGER_KEYS.gate2).toEqual(["assigning", "gencde", "new_group_ideal"]);
    expect(GATE_LEDGER_KEYS.gate3).toEqual(["specs", "specs_repick", "refine", "concept_gate", "specs_regen"]);
    expect(GATE_LEDGER_KEYS.gate0).toEqual([]);
    expect(GATE_LEDGER_KEYS.gate4).toEqual(["composite", "analysis_ideas"]);
  });

  test("@estimate a New group's ideal is one generate call: the ideal line over the run's clusters", () => {
    // 08-28 Wave 2: each New group a reviewer fills buys ONE generate-ideal call on Gate 1's Continue. It is
    // priced as the run's own ideal line divided across the clusters that line pays for — one call's share.
    const ideal = (mode: "batch" | "sync") =>
      estimateRunCostBreakdown(600, 3, mode, true).lines.find((l) => l.id === "ideal")!.cost;
    expect(newGroupIdealUsd(600, 3, "batch", 40)).toBeCloseTo(ideal("batch") / 40, 10);
    expect(newGroupIdealUsd(600, 3, "sync", 40)).toBeCloseTo(ideal("sync") / 40, 10);
    expect(newGroupIdealUsd(600, 3, "batch", 40)).toBeGreaterThan(0);
    expect(newGroupIdealUsd(600, 3, "batch", 0)).toBeCloseTo(ideal("batch"), 10); // never divides by zero
    expect(newGroupIdealUsd(600, 3, "preview", 40)).toBe(0);
  });

  test("@estimate a paid action outside a leg is attributed to its gate, not left unattributed", () => {
    // Live verify 3 F5: the score extraction's spend reached no figure. It now bills under its own key, and
    // that key must land in Gate 1's realized figure rather than in the unattributed remainder.
    const realized = realizedSpendByGate({
      actualUsd: 0.7102,
      tokens: { input: 0, output: 0 },
      perStage: {
        generating: { usd: 0.127, inputTokens: 0, outputTokens: 0, calls: 1 },
        splitting: { usd: 0.528, inputTokens: 0, outputTokens: 0, calls: 1 },
        judging: { usd: 0.0442, inputTokens: 0, outputTokens: 0, calls: 1 },
        score_components: { usd: 0.011, inputTokens: 0, outputTokens: 0, calls: 1 },
      },
    });
    expect(realized.byGate.gate1).toBeCloseTo(0.7102, 6);
    expect(realized.unattributed).toBe(0);
  });

  test("@estimate the split/assign division follows measured call volume, not an even split", () => {
    const b = estimateRunCostBreakdown(1000, 5, "batch", true);
    const base = 1000 * 0.0026 * 1.32;

    // The division is measured, so neither gate carries an unmeasured-division warning any more.
    expect(b.byGate.gate1.divisionUnmeasured).toBe(false);
    expect(b.byGate.gate2.divisionUnmeasured).toBe(false);
    expect(b.byGate.gate1.note).toMatch(/measured call volume/i);

    // The two halves sum back to the fused share — dividing must not invent or lose money.
    expect(SPLIT_ASSIGN_DIVISION.split + SPLIT_ASSIGN_DIVISION.assign).toBeCloseTo(1, 9);

    // Assign is the LARGER half, which is the whole point: it runs once per post-split group, so it is
    // 2.28 calls per split call. The old even-split assumption had this backwards, and the reasoning that
    // justified fusing (an even split would under-quote SPLIT) pointed the wrong way as a result.
    expect(SPLIT_ASSIGN_DIVISION.assign).toBeGreaterThan(SPLIT_ASSIGN_DIVISION.split);

    const splitShare = STAGE_SHARES.splitAssign * SPLIT_ASSIGN_DIVISION.split * base;
    const assignShare = STAGE_SHARES.splitAssign * SPLIT_ASSIGN_DIVISION.assign * base;
    expect(b.byGate.gate1.forecast).toBeGreaterThanOrEqual(STAGE_SHARES.ideal * base + splitShare);
    expect(b.byGate.gate2.forecast).toBeCloseTo(assignShare + STAGE_SHARES.gencde * base, 9);

    // R8 still holds where it matters: the first charge covers everything reaching Gate 1 buys.
    expect(b.firstCharge).toBe(b.byGate.gate1.forecast);
  });

  test("@estimate the per-gate forecasts sum to the run total — nothing double-counted", () => {
    for (const fields of [200, 1000, 7451]) {
      for (const mode of ["batch", "sync"] as const) {
        for (const { genSpecs, suggestIdeas, conceptGate } of FLAG_COMBINATIONS) {
          const b = estimateRunCostBreakdown(fields, 5, mode, genSpecs, suggestIdeas, { conceptGate });
          const perGate = Object.values(b.byGate).reduce((s, g) => s + g.forecast, 0);
          // `analysisIdeas` is the ONE line deliberately not attributed to a gate: it is an opt-in pass
          // over the finished concept digest, not work any gate's Continue buys. Derived from `lines`
          // rather than hardcoded, so a future unattributed line has to be named HERE instead of
          // silently widening the gap between the gates and the total.
          const unattributed = b.lines.filter((l) => l.id === "analysisIdeas").reduce((s, l) => s + l.cost, 0);
          const label = `${fields}/${mode}/${JSON.stringify({ genSpecs, suggestIdeas, conceptGate })}`;
          expect(perGate, label).toBeCloseTo(b.total.mid - unattributed, 6);
        }
      }
    }
  });

  /**
   * RE-SPLITTING IS ALWAYS AVAILABLE, AND PRICED PER USE (final review round 1, item 2). Setup's opt-in checkbox
   * is gone: the reviewer decides at Gate 1, per group, on a priced proposal. So the quote carries it as a
   * PER-USE term under Gate 1 — never inside a total or a gate figure, because no Continue buys it and a run
   * that never re-splits is never charged for it.
   */
  test("@estimate re-splitting is a per-use term under Gate 1, priced but never added to any total", () => {
    for (const fields of [200, 1000, 7451]) {
      for (const mode of ["batch", "sync"] as const) {
        for (const { genSpecs, suggestIdeas, conceptGate } of FLAG_COMBINATIONS) {
          const b = estimateRunCostBreakdown(fields, 5, mode, genSpecs, suggestIdeas, { conceptGate });
          const label = `${fields}/${mode}/${JSON.stringify({ genSpecs, suggestIdeas, conceptGate })}`;
          const resplit = b.onUse.find((l) => l.id === "resplit");
          expect(resplit, label).toBeDefined();
          expect(resplit!.gate, label).toBe("gate1");
          expect(resplit!.perUse, label).toBeGreaterThan(0);
          // Not a cost line: the total is the sum of the cost lines, and Gate 1's figure is its own lines only.
          expect(b.lines.some((l) => l.id === "resplit"), label).toBe(false);
          expect(b.total.mid, label).toBeCloseTo(b.lines.reduce((s, l) => s + l.cost, 0), 9);
          const gate1Lines = b.lines.filter((l) => l.gate === "gate1").reduce((s, l) => s + l.cost, 0);
          expect(b.byGate.gate1.forecast, label).toBeCloseTo(gate1Lines, 9);
          expect(b.firstCharge, label).toBe(b.byGate.gate1.forecast);
        }
      }
    }
    // Preview runs no coherence judge, so no group is ever flagged and no division is ever proposed.
    expect(estimateRunCostBreakdown(1000, 5, "preview", true).onUse).toEqual([]);
  });

  test("@estimate one re-split is priced at or above a measured split call, at the rates it is billed at", () => {
    // `/readjudicate` calls the provider DIRECTLY (never the Batch API), whatever mode the run uses — so the
    // price is the same in both modes, and at full synchronous rates.
    const batch = estimateRunCostBreakdown(1000, 5, "batch", true).onUse.find((l) => l.id === "resplit")!;
    const sync = estimateRunCostBreakdown(1000, 5, "sync", true).onUse.find((l) => l.id === "resplit")!;
    expect(batch.perUse).toBe(sync.perUse);
    expect(batch.perUse).toBe(RESPLIT_PER_USE_USD);
    // R8: never below the MEASURED mean split call (full-5 stack: 926 calls, 2,652,860 input and 233,695 output
    // tokens) at Sonnet's synchronous $3 / $15 per million.
    const measuredMean = (2_652_860 / 926) * (3 / 1_000_000) + (233_695 / 926) * (15 / 1_000_000);
    expect(RESPLIT_PER_USE_USD).toBeGreaterThanOrEqual(measuredMean);
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
