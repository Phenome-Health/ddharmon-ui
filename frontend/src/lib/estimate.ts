import type { GatePosition, RunCost, RunMode } from "@/types";

/**
 * The run cost estimator — extracted from `types.ts` so R8 can be checked as ARITHMETIC.
 *
 * R8, the one prohibition every number here is bound by: **never quote a cost lower than what will be
 * charged.** Over-quoting is permitted; under-quoting obtains the user's consent for a charge they did not
 * agree to. The prohibition is one-directional, and every judgement call below resolves in that direction
 * and says so.
 *
 * Extracted because a promise is not a gate. `tests/e2e/estimate.spec.ts` runs the estimator over every
 * configuration flag combination and asserts the quoted total covers the stages that configuration will
 * actually run — which is only possible because nothing here touches React.
 *
 * WHAT IS PAID TO REACH EACH GATE (UI-SPEC §0.1, reversed at plan review 2026-08-17):
 *
 * | pause point | paid to reach it |
 * |---|---|
 * | Setup   | nothing — "Nothing is charged yet" is TRUE here |
 * | Gate 0  | nothing (local) — but its Continue is the run's FIRST CHARGE |
 * | Gate 1  | `generate(ideal)` + `split` + the coherence judge |
 * | Gate 2  | assign (+ merge / GenCDE synthesis) |
 * | Gate 3  | spec generation (+ `refine`, + the opt-in concept gate) |
 * | Gate 4  | nothing (a terminal read) |
 *
 * REALIZED IS NOT A FORECAST. Gate 1 onward stands DOWNSTREAM of real spend, so it must show what was
 * actually spent. `CostBreakdown.byGate[g].forecast` and `RealizedSpend.byGate[g]` are deliberately
 * different shapes with no field name in common: a screen cannot reach for the wrong key and render a
 * forecast as money already gone.
 */

// --- the price basis ----------------------------------------------------------------------------------

/**
 * Per-variable cost of a full BATCH run, calibrated to an observed run.
 *
 * Its price basis is real: the same Claude Sonnet rates ddharmon's cost accounting prices against
 * (LiteLLM model→price map — $3/1M input, $15/1M output). Calibrated to an observed FULL run (all paid
 * stages: ideal + split + assign + gencde + specs): 769 variables × 5 cohorts, sync = $5.38 realized
 * (~1013 in + 264 out tokens per variable across stages). Back out the ×2 sync and ×1.32 cohort factors →
 * ~$0.0026 per variable for a full batch run. The POST-run `result.cost` supersedes this: it is the real
 * spend, priced from captured tokens.
 *
 * Rough, and knowingly so: the LLM stages scale with clusters / records / novels rather than linearly with
 * variables, and the `full` CDE set costs more than the `endorsed` set this was calibrated on.
 */
export const PER_FIELD_BATCH_USD = 0.0026;

const USD_PER_INPUT_TOKEN = 3 / 1_000_000;
const USD_PER_OUTPUT_TOKEN = 15 / 1_000_000;

/**
 * Per-stage shares of the full LLM total, from the observed run above (fractions of $5.38): gen-ideal ≈6%,
 * split+assign ≈44%, GenCDE synthesis of novel concepts ≈28%, transform spec-gen ≈22%. Embedding and
 * clustering are local → $0. Sum ≈ 1.0 with all stages on.
 *
 * FOUR shares, not the three the SPEC quotes — a generated-element line was added before this phase.
 *
 * `splitAssign` remains ONE share because the calibration run reported the two stages together. The
 * division between them is now MEASURED rather than assumed — see `SPLIT_ASSIGN_DIVISION`.
 */
export const STAGE_SHARES = { ideal: 0.06, splitAssign: 0.44, gencde: 0.28, specgen: 0.22 };

/**
 * How the fused `splitAssign` share divides between the two stages that actually pay it — Gate 1's
 * Continue buys `split`, Gate 2's buys `assign`.
 *
 * MEASURED, not assumed, and the measurement matters because the obvious guess is wrong. Counted off the
 * frozen prompt/response artifacts of the full-5 stack run (`harmonization_artifacts_full5_stack/`):
 *
 *     stage    calls   input tok   output tok
 *     split      926   2,652,860      233,695
 *     assign   2,109   3,506,350      252,239
 *
 * 2.28 assign calls per split call, because `assign` runs once per POST-SPLIT GROUP and splitting
 * multiplies the work. Cost share is stable under output weighting (43.1/56.9 on input alone, 44.5/55.5
 * with output priced 5x), so rounding to 43/57 is safe in either direction.
 *
 * This corrects the reasoning it replaces. Fusing was justified by the fear that an assumed EVEN split
 * "landing under the true cost of split would under-quote the first charge the user ever sees" — but split
 * measures BELOW half, so an even split would have OVER-quoted it. The under-quote risk was always at
 * Gate 2, not Gate 1. Quoting the full combined share at both gates avoided that, at the price of the two
 * figures overlapping by 44% of the run, which no consumer could sum.
 *
 * TWO CAVEATS, both real:
 *   1. This is a different corpus from the $5.38 run `STAGE_SHARES` came from. It is a ratio, not a
 *      re-measurement of the shares themselves.
 *   2. The ratio moves with how aggressively clusters split — recursive split (M2) raises the group count
 *      and therefore assign's share. Re-derive it when split behaviour changes.
 *
 * Both are cheap to revisit: deriving this costs $0, since it only counts artifacts a completed run has
 * already written. Note what is NOT free — PREDICTING it per-run. `prepare_group_assign` takes
 * `split_responses`, so the number of assign calls is unknowable until split has run and been answered.
 * Hence a historical ratio for the forecast, and the run's own ledger once it passes Gate 1.
 */
export const SPLIT_ASSIGN_DIVISION = { split: 0.43, assign: 0.57 };

/**
 * "Analysis ideas" is ONE LLM pass over the concept digest (not per-variable), so it is a small flat add
 * on top of the run — independent of corpus size and of batch/sync (it always runs synchronously).
 */
export const ANALYSIS_IDEAS_USD = 0.05;

// --- the coherence judge, which the calibration run never paid for -------------------------------------

/**
 * Groups smaller than this are left EXPLICITLY UNJUDGED — core's `COHERENCE_MIN_MEMBERS` (`COHERENCE_K1`
 * of 5, plus one). It is the eligibility rule the estimate counts against, and the reason the coherence
 * line can legitimately read $0.
 */
export const COHERENCE_MIN_MEMBERS = 6;

/**
 * Modelled input tokens for one coherence-judge prompt, derived from the prompt's own structure rather
 * than from the calibration run — which never paid for the judge at all, so its 100% is 100% of a
 * judge-less run. That is also why the coherence line is ADDED on top of the four shares rather than
 * carved out of them: rebalancing the existing shares downward to make room would reduce every other
 * line, and a line reduced to keep a total tidy is an under-quote.
 *
 * The derivation: a 2,472-character system prompt, ~700 characters of two-step framing, and the sampled
 * members at their CEILING count (`COHERENCE_K1` = 5 core plus `COHERENCE_K2_CEILING` = 20 periphery) with
 * each rendered line modelled at ~240 characters (`cohort:var — <lean retrieval text>`), plus a schema
 * allowance. ≈9,500 characters ⇒ ~2,400 tokens at four characters per token.
 *
 * This prices a judge call ABOVE the per-call average implied by the observed run's whole-run figure. The
 * direction is deliberate: the token model is grounded in real prompt sizes at real prices, the whole-run
 * average is not per-call evidence, and R8 is one-directional.
 */
const JUDGE_CALL_INPUT_TOKENS = 2400;
/** The verdict JSON's output allowance — the stage's own `max_tokens`, not a guess at a typical reply. */
const JUDGE_CALL_OUTPUT_TOKENS = 512;

/**
 * Calls priced per JUDGED group: the judge itself, plus the R2 distinct-KINDS second read.
 *
 * Both stages are installed together (the product's `coherence` config gate enables the judge and its
 * second read as a pair) and both carry their own cost-ledger key — `judging` and `kinds`. Core calls the
 * second read only on a `qualify` verdict, so one per judged group is an UPPER BOUND by construction,
 * which is the direction R8 requires.
 */
const JUDGE_CALLS_PER_JUDGED_GROUP = 2;

/** One judge call, in BATCH terms (the same basis as `PER_FIELD_BATCH_USD`; sync is ×2). */
const JUDGE_CALL_BATCH_USD =
  0.5 * (JUDGE_CALL_INPUT_TOKENS * USD_PER_INPUT_TOKEN + JUDGE_CALL_OUTPUT_TOKENS * USD_PER_OUTPUT_TOKEN);

/**
 * Judge-eligible groups per source variable, when the groups do not exist yet.
 *
 * MEASURED, $0, on the shipped demo (08-01): 485 post-split concept groups over 1,000 variables, of which
 * **26** clear the ≥6-member floor. The THRIVE-IC snapshot agrees (8 of 156 groups, 5.1% against 5.4%).
 * That gives 0.026 eligible groups per variable, DOUBLED here for headroom, because both measurements are
 * of ~1,000-variable snapshots whose groups average ~2 variables: a larger corpus produces larger groups,
 * which clear the six-member floor far more often, so 5% is a floor for a big run rather than a central
 * estimate. Clamped to the arithmetic ceiling — a judged group needs six variables, so there can never be
 * more than `variables / 6` of them.
 *
 * Pass `groupSizes` once the groups are real (Gate 1 onward) and none of this is used: the count is then
 * exact and `judgeCallsEstimated` is false.
 */
const JUDGE_ELIGIBLE_GROUPS_PER_VARIABLE = 0.052;

/**
 * A concept-gate call, priced like a judge call.
 *
 * The concept gate (STGD-16) is a second model pass asking whether an assigned element measures the same
 * CONCEPT, not merely the same values — one call per concept group. It is OFF by default, so it adds no
 * line and no charge to a normal run; when a run opts in, omitting it would be precisely the prohibited
 * under-quote. Its per-group volume uses the demo-measured group density (485 groups per 1,000 variables),
 * which is the higher of the two measured densities and therefore over-counts a larger corpus.
 */
const CONCEPT_GATE_CALL_BATCH_USD = JUDGE_CALL_BATCH_USD;
const GROUPS_PER_VARIABLE = 0.485;

// --- shapes ------------------------------------------------------------------------------------------

export interface CostEstimate {
  low: number;
  mid: number;
  high: number;
  free: boolean;
}

export interface CostLine {
  /** Stable identifier — what a screen keys a row on, so the label stays free to be rewritten. */
  id: string;
  label: string;
  cost: number;
  note?: string;
}

/** What reaching one gate is FORECAST to cost. Carries no realized figure, deliberately. */
export interface GateForecast {
  gate: GatePosition;
  forecast: number;
  /**
   * True when this figure includes the whole undivided split-and-assign share because the division
   * between the two is unmeasured. The consequence is that the per-gate figures OVERLAP by that share —
   * stated here rather than hidden, since the alternative is a guessed fraction that could land low.
   */
  divisionUnmeasured: boolean;
  note?: string;
}

export interface CostBreakdown {
  free: boolean;
  lines: CostLine[];
  total: CostEstimate;
  /** vs running the same in sync mode (0 unless mode is batch). */
  batchSavings: number;
  /** Forecast per gate. NEVER a realized figure — see `realizedSpendByGate` for that. */
  byGate: Record<GatePosition, GateForecast>;
  /** What Gate 0's Continue buys: the run's first charge (UI-SPEC §8.1). */
  firstCharge: number;
  /** How many coherence-judge calls the quote is priced for — the work behind the money. */
  judgeCalls: number;
  /** False only when real group sizes were supplied, in which case the count is exact. */
  judgeCallsEstimated: boolean;
}

/** Realized spend, attributed by cost-ledger key. Carries no forecast, deliberately. */
export interface RealizedSpend {
  byGate: Record<GatePosition, number>;
  total: number;
  /**
   * Realized USD under a ledger key no gate claims. SURFACED rather than folded into the nearest gate:
   * money whose origin a screen cannot explain is money a screen must not invent an explanation for.
   */
  unattributed: number;
}

/**
 * Which cost-ledger keys each gate's spend is attributed by.
 *
 * Ledger keys, not progress phases. An advisory stage reports progress under an EXISTING phase — the
 * judge under `splitting`, the concept gate under `specs` — because adding a phase to `PHASES_RUN` would
 * invalidate the shipped demo artifact and the Methods manifest (WINDOWS id20). Per-stage cost
 * attribution rides `ledger_key` instead, which is why this table names those and not phases.
 */
export const GATE_LEDGER_KEYS: Record<GatePosition, string[]> = {
  setup: [],
  gate0: [], // load → preprocess → embed: local, no provider call
  gate1: ["generating", "splitting", "judging", "kinds"],
  gate2: ["assigning", "gencde"],
  gate3: ["specs", "refine", "concept_gate"],
  gate4: [], // a terminal read
};

// --- the estimate ------------------------------------------------------------------------------------

export function estimateRunCost(totalFields: number, nCohorts: number, mode: RunMode): CostEstimate {
  if (mode === "preview" || totalFields <= 0) return { low: 0, mid: 0, high: 0, free: true };
  const modeFactor = mode === "sync" ? 2 : 1; // batch is ~half of sync
  const cohortFactor = 1 + 0.08 * Math.max(0, nCohorts - 1); // cross-cohort assign work grows with cohorts
  const mid = totalFields * PER_FIELD_BATCH_USD * modeFactor * cohortFactor;
  return { low: mid * 0.6, mid, high: mid * 1.6, free: false };
}

export function formatUsd(x: number): string {
  if (x === 0) return "$0";
  if (x < 0.01) return "<$0.01";
  if (x < 1) return `$${x.toFixed(2)}`;
  return `$${x.toFixed(x < 10 ? 2 : 0)}`;
}

/** How many groups the coherence judge will be asked about. Exact when the groups are known. */
export function judgeEligibleGroups(totalFields: number, groupSizes?: number[]): number {
  if (groupSizes) return groupSizes.filter((n) => n >= COHERENCE_MIN_MEMBERS).length;
  const ceiling = Math.floor(Math.max(0, totalFields) / COHERENCE_MIN_MEMBERS);
  return Math.min(ceiling, Math.round(Math.max(0, totalFields) * JUDGE_ELIGIBLE_GROUPS_PER_VARIABLE));
}

export function estimateRunCostBreakdown(
  totalFields: number,
  nCohorts: number,
  mode: RunMode,
  genSpecs: boolean,
  suggestIdeas = false,
  { conceptGate = false, groupSizes }: { conceptGate?: boolean; groupSizes?: number[] } = {},
): CostBreakdown {
  const noGates: Record<GatePosition, GateForecast> = {
    setup: { gate: "setup", forecast: 0, divisionUnmeasured: false },
    gate0: { gate: "gate0", forecast: 0, divisionUnmeasured: false },
    gate1: { gate: "gate1", forecast: 0, divisionUnmeasured: false },
    gate2: { gate: "gate2", forecast: 0, divisionUnmeasured: false },
    gate3: { gate: "gate3", forecast: 0, divisionUnmeasured: false },
    gate4: { gate: "gate4", forecast: 0, divisionUnmeasured: false },
  };
  if (mode === "preview" || totalFields <= 0) {
    return {
      free: true,
      lines: [],
      total: { low: 0, mid: 0, high: 0, free: true },
      batchSavings: 0,
      byGate: noGates,
      firstCharge: 0,
      judgeCalls: 0,
      judgeCallsEstimated: !groupSizes,
    };
  }

  const cohortFactor = 1 + 0.08 * Math.max(0, nCohorts - 1);
  const modeFactor = mode === "sync" ? 2 : 1; // batch ≈ ½ sync
  const baseBatch = totalFields * PER_FIELD_BATCH_USD * cohortFactor; // full batch run, all shared stages
  const line = (share: number) => baseBatch * share * modeFactor;

  const judgeCalls = judgeEligibleGroups(totalFields, groupSizes);
  const coherenceCost = judgeCalls * JUDGE_CALLS_PER_JUDGED_GROUP * JUDGE_CALL_BATCH_USD * modeFactor;
  const conceptGateCalls = conceptGate ? Math.round(totalFields * GROUPS_PER_VARIABLE) : 0;
  const conceptGateCost = conceptGateCalls * CONCEPT_GATE_CALL_BATCH_USD * modeFactor;

  const lines: CostLine[] = [
    { id: "embedding", label: "Embedding & clustering", cost: 0, note: "local — no API" },
    { id: "ideal", label: "Generate ideal CDEs", cost: line(STAGE_SHARES.ideal) },
    { id: "splitAssign", label: "Split + assign to CDEs", cost: line(STAGE_SHARES.splitAssign) },
    {
      // UNCONDITIONAL, unlike the spec-generation line below it. R8 requires this to read $0 rather than
      // vanish when no group qualifies: a line that disappears is indistinguishable from a line that was
      // never considered, and the reviewer cannot tell that the judge simply had nothing to do.
      id: "coherence",
      label: "Coherence check",
      cost: coherenceCost,
      note:
        judgeCalls > 0
          ? `${judgeCalls} judge ${judgeCalls === 1 ? "call" : "calls"} + a second read each`
          : `no group reaches ${COHERENCE_MIN_MEMBERS} variables, so the judge is not asked`,
    },
    { id: "gencde", label: "Generate CDEs for novel concepts", cost: line(STAGE_SHARES.gencde) },
  ];
  if (genSpecs) lines.push({ id: "specgen", label: "Transform spec-gen", cost: line(STAGE_SHARES.specgen) });
  if (conceptGate) {
    lines.push({
      id: "conceptGate",
      label: "Concept-match check",
      cost: conceptGateCost,
      note: `${conceptGateCalls} extra model calls — you turned this on`,
    });
  }
  if (suggestIdeas) {
    lines.push({ id: "analysisIdeas", label: "Analysis ideas", cost: ANALYSIS_IDEAS_USD, note: "one LLM pass" });
  }

  const mid = lines.reduce((s, l) => s + l.cost, 0);

  // --- per gate. Gate 1's Continue buys `split`, Gate 2's buys `assign`, so the fused share is divided
  // between them by the measured ratio in `SPLIT_ASSIGN_DIVISION`. The two figures no longer overlap,
  // which is what lets a consumer sum them: the per-gate forecasts add up to the run total (less the one
  // line no gate buys), asserted by test.
  const splitShare = line(STAGE_SHARES.splitAssign * SPLIT_ASSIGN_DIVISION.split);
  const assignShare = line(STAGE_SHARES.splitAssign * SPLIT_ASSIGN_DIVISION.assign);
  const divisionNote =
    "the split-and-assign share is divided between this gate and the next by measured call volume, " +
    "not split evenly";
  const gate1 = line(STAGE_SHARES.ideal) + splitShare + coherenceCost;
  const gate2 = assignShare + line(STAGE_SHARES.gencde);
  const gate3 = (genSpecs ? line(STAGE_SHARES.specgen) : 0) + conceptGateCost;
  const byGate: Record<GatePosition, GateForecast> = {
    setup: { gate: "setup", forecast: 0, divisionUnmeasured: false },
    // Gate 0's own stages call no model. Its CONTINUE is the first charge, and that charge buys the work
    // Gate 1 renders — attributed there, so a reviewer never sees the same amount twice.
    gate0: {
      gate: "gate0",
      forecast: 0,
      divisionUnmeasured: false,
      note: "no model call happens here — the first charge is Continue at Gate 0, which buys what Gate 1 shows",
    },
    gate1: { gate: "gate1", forecast: gate1, divisionUnmeasured: false, note: divisionNote },
    gate2: { gate: "gate2", forecast: gate2, divisionUnmeasured: false, note: divisionNote },
    gate3: { gate: "gate3", forecast: gate3, divisionUnmeasured: false },
    gate4: { gate: "gate4", forecast: 0, divisionUnmeasured: false },
  };

  return {
    free: false,
    lines,
    total: { low: mid * 0.6, mid, high: mid * 1.6, free: false },
    batchSavings: mode === "batch" ? mid : 0, // sync would cost ~2×, so batch saves ≈ mid
    byGate,
    firstCharge: gate1,
    judgeCalls,
    judgeCallsEstimated: !groupSizes,
  };
}

/**
 * Realized spend per gate, from the run's OWN cost ledger. Never an estimate.
 *
 * `costSoFar` is the live counter and is used only as the total when a run carries no per-stage ledger yet
 * (an in-flight run, or a DB-hydrated historical one): a total with no attribution is still true, whereas
 * attributing it to a gate by guesswork would not be.
 */
export function realizedSpendByGate(cost?: RunCost | null, costSoFar?: number): RealizedSpend {
  const perStage = cost?.perStage ?? {};
  const byGate = {} as Record<GatePosition, number>;
  const claimed = new Set<string>();
  for (const gate of Object.keys(GATE_LEDGER_KEYS) as GatePosition[]) {
    byGate[gate] = GATE_LEDGER_KEYS[gate].reduce((sum, key) => {
      claimed.add(key);
      return sum + (perStage[key]?.usd ?? 0);
    }, 0);
  }
  const attributed = Object.values(byGate).reduce((s, v) => s + v, 0);
  const ledgerTotal = Object.values(perStage).reduce((s, v) => s + (v?.usd ?? 0), 0);
  const total = ledgerTotal > 0 ? Math.max(ledgerTotal, cost?.actualUsd ?? 0) : (costSoFar ?? cost?.actualUsd ?? 0);
  return { byGate, total, unattributed: Math.max(0, ledgerTotal - attributed) };
}

/**
 * Fraction of a run's total LLM cost already committed by the time it is IN a given phase — i.e. what a
 * "keep" stop (finish the current stage, skip the rest) would still be billed. Local stages are free; the
 * LLM stages accrue in order. Keys mirror the backend phase labels.
 *
 * NOTE ON `splitting` / `assigning`: this table divides the combined split+assign share EVENLY (0.22 each),
 * The split/assign boundary here now follows the MEASURED ratio in `SPLIT_ASSIGN_DIVISION` rather than
 * the even split it was authored with. Only the `splitting` figure moves (0.28 -> 0.25); every cumulative
 * endpoint after it is unchanged, because the two stages still sum to the same fused share.
 */
const STOP_COMMITTED_BY_PHASE: Record<string, number> = {
  loading: 0,
  embedding: 0,
  clustering: 0,
  generating: 0.06, // gen-ideal done
  splitting: 0.25, // + splitting (0.06 + 0.44*0.43)
  assigning: 0.5, // + assigning (split+assign done; 0.06 + 0.44)
  gencde: 0.78, // + GenCDE synthesis (novels)
  specs: 1, // + transform spec-gen (last paid stage)
  complete: 1,
};

export interface StopCostSplit {
  committed: number; // ≈ USD already committed this run (billed even on a "keep" stop)
  avoided: number; // ≈ USD a stop-now avoids (the skipped downstream stages)
  total: number; // ≈ USD the full run would cost
  hasEstimate: boolean; // false when the run carries no corpus size (older run / API caller)
}

/**
 * Price a mid-run stop for the Stop dialog: how much is already committed vs. avoided by stopping in
 * `phase`. Reads the corpus size the New-Run form persisted onto the run's config (`est_fields` /
 * `est_cohorts`, snake_case) and the run mode. A preview run (or one with no stored counts) yields total 0
 * and `hasEstimate: false`, so the dialog falls back to qualitative wording rather than a bogus "$0".
 */
export function stopCostSplit(config: Record<string, unknown>, phase: string): StopCostSplit {
  const estFields = typeof config.est_fields === "number" ? config.est_fields : 0;
  const estCohorts = typeof config.est_cohorts === "number" ? config.est_cohorts : 0;
  const runMode = (typeof config.run_mode === "string" ? config.run_mode : "batch") as RunMode;
  const total = estFields > 0 ? estimateRunCost(estFields, estCohorts, runMode).mid : 0;
  const frac = STOP_COMMITTED_BY_PHASE[phase] ?? 0.5; // unknown mid-run phase: assume ~half committed
  const committed = total * frac;
  return { committed, avoided: Math.max(0, total - committed), total, hasEstimate: estFields > 0 && total > 0 };
}
