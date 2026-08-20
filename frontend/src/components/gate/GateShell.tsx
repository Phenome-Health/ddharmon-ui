import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { formatUsd, type GatePosition } from "@/types";
import { PhMark } from "@/components/ph-logo";
import { GATE_LABELS, GATE_SEQUENCE, GateRail, type GateRailItem } from "@/components/gate/GateRail";
import { HowToPanel } from "@/components/gate/HowToPanel";
import { ResumeBanner } from "@/components/gate/ResumeBanner";

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
  children: ReactNode;
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
  children,
}: GateShellProps) {
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
