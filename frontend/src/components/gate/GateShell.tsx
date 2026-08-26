import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatUsd, type GatePosition, type JobResult } from "@/types";
import { PhMark } from "@/components/ph-logo";
import { StopRunAction } from "@/components/stop-run-action";
import { GATE_LABELS, GATE_SEQUENCE, GateRail, type GateRailItem } from "@/components/gate/GateRail";
import { HowToPanel } from "@/components/gate/HowToPanel";
import { ResumeBanner } from "@/components/gate/ResumeBanner";
import { stopCostSplit } from "@/lib/estimate";

/**
 * The universal chrome every gate screen renders inside (UI-SPEC §7.1). One file, so no later screen plan
 * re-implements it and no two gates drift apart.
 *
 * THE FIVE ELEMENTS, and where each actually lives:
 *
 *  1. **App bar.** Split, deliberately. The Phenome Health secondary lockup (icon + wordmark — the brand
 *     rule is that the wordmark never appears without the icon), the divider and the `ddharmon` wordmark
 *     are rendered ONCE by `AppShell`, which wraps every route including these. This component adds the
 *     two parts AppShell does not have: the tagline and the run chip. Rendering a second lockup here would
 *     put two Phenome Health marks on one screen, which is a brand defect, not extra compliance.
 *  2. **Masthead** — eyebrow (`Gate N of 4`), display h1, one-sentence subhead.
 *  3. **Gate rail** — six columns, always. See `GateRail`.
 *  4. **How-to panel** — on the ground, above the working surface. See `HowToPanel`.
 *  5. **Banner slots** — the sandbox banner (passed in by the page, since only it knows whether the run is
 *     the shared demo) and the resume banner (rendered here from `resumed`).
 *
 * PLUS THE STOP CONTROL, and it is HERE rather than on a page on purpose (08-14 Task 4). Before this,
 * no screen under `pages/run/` or `components/gate/` offered a cancel: with a run in flight the only way
 * out of a gate was closing the tab while paid stages kept spending. Gate 0 is the first screen where a
 * reviewer sees a run going wrong, which is why the gap surfaced there — but the fix belongs one level up,
 * so ONE placement serves all six gates and the next five inherit it rather than each re-adding it. A gate
 * test asserts that single call site, because two implementations of a control that spends or saves real
 * money is the outcome this lift exists to avoid.
 *
 * `StopRunAction` is CONSUMED, NOT REBUILT. It is already in production on the dashboard and the runs
 * list, and it already offers both modes behind one confirmation with the committed-versus-avoided cost
 * split — which is exactly the framing the staged gates need. `AppShell` placing `ActiveRunsIndicator`
 * globally is the precedent for shell-level run chrome.
 *
 * NOTHING INTERNAL MAY REACH THIS SURFACE. The guest demo walk makes every gate screen unauthenticated, so
 * no internal research number, no internal cohort specific and no source path may appear in the chrome or
 * in any string it renders (UI-SPEC §7.2). `scripts/leak_scan.py --profile public` gates it.
 *
 * EMPTY AND OVERFLOW STATES are handled here rather than left to each page: no run in progress renders no
 * run chip at all; a long run name and the tagline are both clamped to one line with the full value on
 * `title`, so the bar's height can never reflow.
 */

/** UI-SPEC §7.1.2 — the eyebrow. Setup is not "Gate N", so it says what it is. */
function eyebrowFor(gate: GatePosition): string {
  return gate === "setup" ? "Set up" : `Gate ${gate.slice(4)} of 4`;
}

export interface GateShellProps {
  gate: GatePosition;
  /** Display h1. Defaults to the gate's rail label so a page cannot silently render an unnamed screen. */
  title?: string;
  /** One sentence. What this screen is for, in the reviewer's terms. */
  subhead: string;
  /** The six rail columns. Supplied by the page because only it knows this run's realized spend. */
  rail: GateRailItem[];
  /** The run's name, or undefined when no run is in progress — in which case NO chip renders. */
  runName?: string;
  /** Realized spend so far, shown on the run chip and the resume banner. */
  costSoFar?: number;
  /** True when this run was REJOINED at a gate rather than walked to — renders the resume banner. */
  resumed?: boolean;
  /** The sandbox/demo banner, when the page's run is the shared demo (R9). */
  sandboxBanner?: ReactNode;
  /**
   * The run this gate is showing, or null/undefined when there is none. Read ONLY to decide whether a
   * stop is offered and how it is priced — the shell does not subscribe to the stream itself, because a
   * second subscription beside the page's own is two sources for one run's state.
   */
  job?: JobResult | null;
  /**
   * Perform the stop. Pages pass the stream hook's `cancel`, which is the same path the dashboard and the
   * runs list already use. Omit it and no stop is offered — a control with nothing behind it is worse
   * than a stated absence.
   */
  onStop?: (mode: "keep" | "discard") => Promise<void> | void;
  children: ReactNode;
}

/**
 * Whether this run has a worker burning money right now.
 *
 * `awaiting_review` IS EXCLUDED, and that is the subtle one: it is non-terminal, so a naive
 * "not finished => stoppable" test would offer a stop there. But a pause is an EXIT (08 D-01) — the
 * worker is gone and nothing is accruing — so a stop control on a parked run would offer to save money
 * that is not being spent, which is a false claim about the run rather than a harmless extra button.
 *
 * `pending` IS included: the worker has not started, so stopping avoids the whole cost.
 */
const NOT_IN_FLIGHT = new Set(["complete", "error", "cancelled", "awaiting_review"]);

function isInFlight(job: JobResult | null | undefined): boolean {
  return !!job && !NOT_IN_FLIGHT.has(job.status);
}

export function GateShell({
  gate,
  title,
  subhead,
  rail,
  runName,
  costSoFar = 0,
  resumed = false,
  sandboxBanner,
  job,
  onStop,
  children,
}: GateShellProps) {
  const inFlight = isInFlight(job);
  // The shared demo is a client-side replay with no backend to cancel, so a live-looking control there
  // would do nothing. Say so instead.
  const isDemo = !!(job?.config as { demo?: boolean } | undefined)?.demo;
  return (
    <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-8">
      {/* (1) The gate app bar: the tagline and the run chip. The lockup and wordmark come from AppShell. */}
      <div className="flex h-8 items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-2">
          <PhMark tone="ground" aria-hidden="true" className="h-4 w-4 shrink-0" />
          <span className="truncate text-xs text-on-field-muted" title="Harmonize data dictionaries against common data elements">
            Harmonize data dictionaries against common data elements
          </span>
        </div>
        <div className="flex min-w-0 shrink items-center gap-2">
        {/* No run in progress -> no chip. An empty chip is worse than none: it reads as a run with no name. */}
        {runName && (
          <span
            data-testid="run-chip"
            title={runName}
            className="flex min-w-0 shrink items-center gap-2 rounded-pill border border-rule-on-field bg-on-field/5 px-3 py-1"
          >
            <span className="max-w-[22rem] truncate text-xs font-semibold text-on-field">{runName}</span>
            <span className="shrink-0 text-xs tabular-nums text-on-field-muted">
              {costSoFar > 0 ? `spent ${formatUsd(costSoFar)}` : "nothing charged yet"}
            </span>
          </span>
        )}

        {/* THE STOP CONTROL. Offered only while a worker is actually running: absent — not disabled, not
            an error — when there is nothing to stop, because a dead control implies the run is in a state
            it is not in. Once a stop is acknowledged the run reports `stopping` until it reaches its
            checkpoint, so the control is swapped for an indicator and cannot be re-fired. */}
        {inFlight && isDemo && (
          <span
            data-testid="stop-unavailable"
            className="shrink-0 rounded-pill border border-dashed border-rule-on-field px-3 py-1 text-xs text-on-field-muted"
          >
            Stopping is not available on the shared sample — it replays in your browser and spends nothing,
            so there is nothing to stop. Start your own run to get the control.
          </span>
        )}
        {inFlight && !isDemo && onStop && job && (
          job.stopping ? (
            <span className="flex shrink-0 items-center gap-1.5 text-xs text-on-field-muted">
              <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" /> Stopping&hellip;
            </span>
          ) : (
            <StopRunAction
              labeled
              displayName={job.displayName}
              costNote={stopCostSplit(job.config, job.phase)}
              onKeep={() => onStop("keep")}
              onDiscard={() => onStop("discard")}
            />
          )
        )}
        </div>
      </div>

      {sandboxBanner}
      {resumed && <ResumeBanner gate={gate} costSoFar={costSoFar} />}

      {/* (2) Masthead. */}
      <header className="flex flex-col gap-2">
        <p className="text-xs font-semibold uppercase tracking-eyebrow text-on-field-muted">{eyebrowFor(gate)}</p>
        <h1 className="font-display text-display font-semibold text-on-field">{title ?? GATE_LABELS[gate]}</h1>
        <p className="max-w-[68ch] text-sm text-on-field-muted">{subhead}</p>
      </header>

      {/* (3) The rail, then (4) the how-to panel — both on the ground, above the working surface. */}
      <GateRail current={gate} items={rail} />
      <HowToPanel gate={gate} />

      {/* The working surface. */}
      <div className={cn("flex flex-col gap-6")}>{children}</div>
    </div>
  );
}

/**
 * A rail with every column's cost/state derived from one run's position and realized spend.
 *
 * Pulled out of the pages so the realized/forecast split is decided ONCE. The rule: a gate the reviewer
 * has already passed shows what it actually cost; the gate ahead shows an estimate; Setup and Gate 4 show
 * a state rather than a figure, because they genuinely spend nothing and a `$0.00` forecast on them is
 * noise dressed as precision.
 *
 * `realizedByGate` is what the run has committed per gate. Absent entries on a PASSED gate fall back to
 * "spent" with the run total, never to a forecast — quoting committed money as an estimate is the exact
 * confusion UI-SPEC §7.1.3 asks the rail to prevent.
 */
export function railFor(
  current: GatePosition,
  {
    realizedByGate = {},
    forecastByGate = {},
    totalRealized = 0,
  }: {
    realizedByGate?: Partial<Record<GatePosition, number>>;
    forecastByGate?: Partial<Record<GatePosition, number>>;
    totalRealized?: number;
  } = {},
): GateRailItem[] {
  const currentIndex = GATE_SEQUENCE.indexOf(current);
  return GATE_SEQUENCE.map((gate, i) => {
    const label = GATE_LABELS[gate];
    if (gate === "setup") return { gate, label, cost: { kind: "state" as const, text: "local" } };
    if (gate === "gate4") return { gate, label, cost: { kind: "state" as const, text: "no charge" } };
    if (i <= currentIndex) {
      const realized = realizedByGate[gate] ?? (gate === current ? totalRealized : 0);
      // Gate 0's own stages call no model, so its column has no figure of its own. Its Continue IS the
      // run's first charge — but that charge buys the work Gate 1 renders, so it is attributed there. A
      // reviewer who saw the amount twice would think they had been billed twice.
      if (gate === "gate0") return { gate, label, cost: { kind: "state" as const, text: "local" } };
      return { gate, label, cost: { kind: "realized" as const, text: `spent ${formatUsd(realized)}` } };
    }
    const forecast = forecastByGate[gate];
    return {
      gate,
      label,
      cost: {
        kind: "forecast" as const,
        text: forecast === undefined ? "est. pending" : `est. ${formatUsd(forecast)}`,
      },
    };
  });
}
