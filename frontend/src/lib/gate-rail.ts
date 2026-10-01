import { formatUsd, realizedSpendByGate } from "@/lib/estimate";
import { RAIL_SEQUENCE, nextRailGate } from "@/lib/gate-routes";
import type { GatePosition, RunCost } from "@/types";

/**
 * What each column of the gate rail says it cost, as a pure function (lifted out of `GateShell.tsx`).
 *
 * WHY IT LIVES HERE. `GateShell.tsx` imports React, so the rule could only be asserted by rendering a screen —
 * and the rule is exactly the kind of thing a rendered check misses: every screen looked right on its own.
 * Here it is importable from a spec in Node, the same reason `gate-routes.ts` and `run-state.ts` exist.
 */

export interface RailCost {
  /**
   * `realized` = money already committed; `forecast` = an estimate for work not yet bought; `state` = a
   * non-monetary fact (`local`, `no charge`) — Setup and an unbilled Gate 4 genuinely spend nothing, and
   * quoting them as $0.00 forecasts would be noise.
   */
  kind: "realized" | "forecast" | "state";
  text: string;
}

export interface RailCostArgs {
  /** What the run has committed per gate, from its own ledger. Absent when the run has no per-stage ledger. */
  realizedByGate?: Partial<Record<GatePosition, number>>;
  forecastByGate?: Partial<Record<GatePosition, number>>;
  /** The run's total realized spend. Lands on ONE column when there is no per-gate attribution. */
  totalRealized?: number;
  /**
   * How far the RUN has got (`railReachOf`: a finished run has reached Gate 4). Gates up to it are realized
   * whichever screen is open. Omit it and the screen's own position is the only frontier — a rail with no run.
   */
  runPosition?: GatePosition | null;
}

/**
 * Every rail column's cost, in rail order.
 *
 * The rule: a gate the RUN has reached shows what it actually cost; a gate ahead of it shows an estimate;
 * Setup and Gate 4 show a state rather than a figure, because they genuinely spend nothing and a `$0.00`
 * forecast on them is noise dressed as precision.
 *
 * THE RUN, NOT THE SCREEN (phase-8 final review, O1). This used to split realized from forecast at the SCREEN
 * being viewed, so on a run parked at Gate 4 the reviewer who clicked back to Gate 1 saw Gates 2 and 3 read
 * "est. pending" — money the run had already spent, quoted as an estimate, while the header said the whole run
 * was paid for; from Gate 2, Gate 3 did the same. The rail is the run's identity, so the split is now at the
 * FURTHER of the two: the run's own position, or the screen (a screen ahead of the run — the shared demo's walk,
 * a leg still running toward this gate — is still where the money lands, exactly as before).
 *
 * THE SUM STILL EQUALS THE HEADER. With a per-gate ledger every column reads its own figure. Without one, the
 * whole total lands on ONE column — and that column is now the run's furthest gate rather than whichever screen
 * is open, so looking back can no longer move the money.
 */
export function railCosts(
  current: GatePosition,
  { realizedByGate = {}, forecastByGate = {}, totalRealized = 0, runPosition = null }: RailCostArgs = {},
): { gate: GatePosition; cost: RailCost }[] {
  // A retired or off-rail position indexes -1, which the max simply ignores: the screen's own position stands.
  const frontier = Math.max(RAIL_SEQUENCE.indexOf(current), runPosition ? RAIL_SEQUENCE.indexOf(runPosition) : -1);
  return RAIL_SEQUENCE.map((gate, i) => {
    // Setup is `local` because everything it carries — loading, preparing, embedding and the free pre-flight
    // over the result — calls no model. The run's first charge is attributed to Gate 1, because that is the work
    // it buys — a reviewer who saw the amount twice would think they had been billed twice.
    if (gate === "setup") return { gate, cost: { kind: "state" as const, text: "local" } };
    // Gate 4 runs no pipeline stage, but it hosts two paid ACTIONS (score Match, analysis ideas — 08-28 1a/1f).
    // Once either has billed, the column shows it like any other realized spend, or the rail stops summing to
    // the run's total; until then it is honestly "no charge".
    if (gate === "gate4") {
      const realized = realizedByGate.gate4 ?? (i === frontier ? totalRealized : 0);
      return realized > 0
        ? { gate, cost: { kind: "realized" as const, text: `spent ${formatUsd(realized)}` } }
        : { gate, cost: { kind: "state" as const, text: "no charge" } };
    }
    if (i <= frontier) {
      const realized = realizedByGate[gate] ?? (i === frontier ? totalRealized : 0);
      return { gate, cost: { kind: "realized" as const, text: `spent ${formatUsd(realized)}` } };
    }
    const forecast = forecastByGate[gate];
    return {
      gate,
      cost: { kind: "forecast" as const, text: forecast === undefined ? "est. pending" : `est. ${formatUsd(forecast)}` },
    };
  });
}

/**
 * The realized-cost args for `railCosts`, from the run's OWN ledger. Attributes per gate when the run HAS a
 * per-stage ledger (each gate reads what it actually spent); otherwise it hands back only the total. An
 * unledgered total — an in-flight run, or a DB-hydrated historical one — attributed per gate would be a guess.
 */
export function realizedRailArgs(
  cost?: RunCost | null,
  costSoFar?: number,
): { realizedByGate?: Partial<Record<GatePosition, number>>; totalRealized: number } {
  const spend = realizedSpendByGate(cost, costSoFar);
  const hasLedger = !!cost?.perStage && Object.keys(cost.perStage).length > 0;
  return hasLedger ? { realizedByGate: spend.byGate, totalRealized: spend.total } : { totalRealized: spend.total };
}

/**
 * What a PAST gate's Continue bar says, in place of the purchase it once offered (phase-8 final review, O2).
 *
 * A frozen gate kept its bar reading "Pressing Continue to Gate 3 buys $0.02 of work for 11 concepts, and it is
 * not refundable." under a notice saying nothing on the screen can be changed — an offer the screen cannot make,
 * priced in the present tense for work bought long ago. The bar STAYS (it is where the reviewer looks for what
 * this step cost), but it says what HAPPENED: the step is done, the run went on, and what the work behind the
 * next gate cost.
 *
 * THE AMOUNT IS THE NEXT GATE'S RAIL COLUMN, deliberately: Continue on Gate N buys the work Gate N+1 shows, and
 * quoting that column means the bar and the rail can never state two figures for one step. Without a per-stage
 * ledger nothing is attributable per gate, so no figure is invented. Gate 4 is a free read, so the step from
 * Gate 3 says it bought nothing rather than quoting $0.
 */
export function frozenContinue(
  gate: GatePosition,
  realizedByGate: Partial<Record<GatePosition, number>> | undefined,
): { action: string; note: string } {
  const next = nextRailGate(gate) ?? gate;
  const name = `Gate ${next.slice(4)}`;
  const action = `Continued to ${name}`;
  if (next === "gate4") {
    return {
      action,
      note: `This step is done. The run went on to ${name}, which bought nothing — ${name} is a read of what this run already produced.`,
    };
  }
  const spent = realizedByGate?.[next];
  if (spent === undefined) {
    return { action, note: `This step is done. The run went on to ${name}; what that cost is part of the run's total spend.` };
  }
  return {
    action,
    note: `This step is done. The run went on to ${name}, and the work behind it cost ${formatUsd(spent)} — money already spent, not an estimate.`,
  };
}
