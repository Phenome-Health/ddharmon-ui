import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { Link } from "wouter";
import { pathForGate, railReachOf } from "@/lib/gate-routes";
import { cn } from "@/lib/utils";
import { formatUsd, type GatePosition, type JobResult } from "@/types";
import { StopRunAction } from "@/components/stop-run-action";
import { GATE_LABELS, GateRail, type GateRailItem } from "@/components/gate/GateRail";
import { HowToPanel } from "@/components/gate/HowToPanel";
import { RunProgress } from "@/components/gate/RunProgress";
import { ResumeBanner } from "@/components/gate/ResumeBanner";
import { ConflictNotice } from "@/components/gate/ConflictNotice";
import { SandboxBanner } from "@/components/gate/SandboxBanner";
import { stopCostSplit } from "@/lib/estimate";
import { railCosts, realizedRailArgs, type RailCostArgs } from "@/lib/gate-rail";
import {
  AUTO_ACCEPTED_LABEL,
  autoPausedReason,
  gateLabel,
  isAutoAccepted,
  isGateLocked,
} from "@/lib/review-mode";
import { isInFlight } from "@/lib/run-state";

/**
 * The universal chrome every gate screen renders inside (UI-SPEC §7.1). One file, so no later screen plan
 * re-implements it and no two gates drift apart.
 *
 * THE FIVE ELEMENTS, and where each actually lives:
 *
 *  1. **App bar.** Split, deliberately. The Phenome Health secondary lockup (icon + wordmark — the brand
 *     rule is that the wordmark never appears without the icon), the divider and the `ddharmon` wordmark
 *     are rendered ONCE by `AppShell`, which wraps every route including these. This component adds only
 *     the run chip (and the stop control). The tagline and its mark were removed on 2026-10-06.
 *  2. **No masthead.** The eyebrow, display title and subhead were removed on 2026-10-06 (Bhargav: "rail
 *     shows this already"). The screen keeps ONE visually hidden h1 — the gate's name — for assistive
 *     technology, and the subhead moved into the how-to panel as its opening line.
 *  3. **Gate rail** — five columns, always, and PINNED to the top of the scroll container so scrolling never
 *     hides where the reviewer is in the flow. See `GateRail`.
 *  4. **How-to panel** — on the ground, above the working surface, OPEN by default. See `HowToPanel`.
 *  5. **Banner slots** — the sandbox banner and the resume banner (rendered here from `resumed`). Plus the
 *     two-tab conflict notice (`ConflictNotice`), which every decision hook on the screen feeds — see
 *     `lib/gate-conflicts.ts`. The sandbox banner is rendered HERE for any run whose config says it is the
 *     shared demo (08-18): one placement, so no screen of the guest walk can forget it. A page may still pass
 *     its own through `sandboxBanner`, which replaces it.
 *
 * PLUS THE STOP CONTROL, and it is HERE rather than on a page on purpose (08-14 Task 4). Before this,
 * no screen under `pages/run/` or `components/gate/` offered a cancel: with a run in flight the only way
 * out of a gate was closing the tab while paid stages kept spending. Gate 0 is the first screen where a
 * reviewer sees a run going wrong, which is why the gap surfaced there — but the fix belongs one level up,
 * so ONE placement serves every screen in the flow rather than each re-adding it. A gate test asserts that
 * single call site, because two implementations of a control that spends or saves real money is the
 * outcome this lift exists to avoid. (Gate 0 was demoted on 2026-08-26 and the flow is now five screens;
 * the placement is unchanged — it simply serves five instead of six.)
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
 * run chip at all; a long run name is clamped to one line with the full value on `title`, so the bar's
 * height can never reflow.
 */

export interface GateShellProps {
  gate: GatePosition;
  /** The screen's (visually hidden) h1. Defaults to the gate's rail label so no screen is unnamed. */
  title?: string;
  /**
   * One sentence: what this screen is for, in the reviewer's terms. Rendered as the how-to panel's opening
   * line. Omit it where another element on the screen already says it.
   */
  subhead?: string;
  /**
   * The five rail columns, for a shell with NO run behind it. With a `job` the shell derives the rail itself
   * (`runRailFor`), because the rail is the RUN's state — what it has spent and how far it has got — and a page
   * computing it from its own screen is how a finished run's past gates came to read "est. pending" (O1).
   */
  rail?: GateRailItem[];
  /** The run's name, or undefined when no run is in progress — in which case NO chip renders. */
  runName?: string;
  /** Realized spend so far, shown on the run chip and the resume banner. */
  costSoFar?: number;
  /** True when this run was REJOINED at a gate rather than walked to — renders the resume banner. */
  resumed?: boolean;
  /**
   * Overrides the shared-demo banner the shell renders by itself for a demo run (R9). Omit it: the shell reads
   * `job.config.demo` and renders `SandboxBanner`, so every gate of the guest walk carries it.
   */
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
  /**
   * The run id, so the rail can navigate backwards (08-16c Task 2). Omit it and the rail renders exactly
   * as before — five columns of plain text — which is what keeps a rail with no run from offering dead
   * links.
   */
  jobId?: string;
  children: ReactNode;
}

/**
 * Whether this run has a worker burning money right now.
 *
 * MIGRATED TO `lib/run-state.ts` BY 08-14h. This file used to declare its own set —
 * `["complete", "error", "cancelled", "awaiting_review"]` — and it was one of the FOUR copies of that
 * predicate that existed on 2026-08-31, of which two were wrong. This one was right, which is why
 * 08-14c deliberately left it alone: 08-15/16/17 were rendering this file in parallel and migrating a
 * correct predicate for zero behaviour change would have bought a merge conflict. Those plans have
 * landed and this one is already editing this file, so this is the "later, quieter moment" 08-14c
 * named. The reasoning it carried is preserved on `isInFlight` itself.
 *
 * The subtlety worth keeping in view here: `awaiting_review` is EXCLUDED. It is non-terminal, so a
 * naive "not finished => stoppable" test would offer a stop over a parked run — a false claim about
 * the run, not a harmless extra button, because a pause is an EXIT (08 D-01) and nothing is accruing.
 * `pending` is INCLUDED: the worker has not started, so a stop still avoids the whole cost.
 */

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
  jobId,
  children,
}: GateShellProps) {
  const inFlight = isInFlight(job?.status);
  /**
   * Where the RUN is, which is not where this SCREEN is. A reviewer who has clicked back sits on a past
   * gate while the run stays parked ahead of them, and every question below turns on the run's position.
   */
  const runPosition = (job?.gatePosition ?? null) as GatePosition | null;
  const config = job?.config as Record<string, unknown> | undefined;
  // A record that can no longer change — never on the shared demo, which is there to practise on.
  const frozen = isGateLocked(gate, runPosition, config);
  // Full auto (08-30): a gate the server committed by itself. Nobody reviewed it, so it is not a record of a review —
  // it wears its own banner (what was committed, and what can still be reviewed) instead of the frozen notice.
  const autoAccepted = isAutoAccepted(config, gate);
  const pausedReason = job ? autoPausedReason({ ...job, config }) : null;
  // The shared demo is a client-side replay with no backend to cancel, so a live-looking control there
  // would do nothing. Say so instead.
  const isDemo = !!(job?.config as { demo?: boolean } | undefined)?.demo;
  /**
   * (1) THE RUN LINE, inside the rail (2026-10-06, Bhargav: "move into the rail, should apply to all runs"). The run
   * chip and the stop control used to sit on their own app-bar row; with the tagline gone that row held one chip.
   * They now ride on the rail's navy box, pinned with it, so the run's name and spend stay in view while scrolling.
   * Re-toned for the dark ground. Nothing renders when there is no run and nothing to stop.
   */
  const stopControl =
    inFlight && isDemo ? (
      <span
        data-testid="stop-unavailable"
        className="shrink-0 rounded-pill border border-dashed border-rule-on-chrome px-3 py-1 text-xs text-on-chrome-muted"
      >
        Stopping is not available on the shared sample — it replays in your browser and spends nothing,
        so there is nothing to stop. Start your own run to get the control.
      </span>
    ) : inFlight && !isDemo && onStop && job ? (
      job.stopping ? (
        <span className="flex shrink-0 items-center gap-1.5 text-xs text-on-chrome-muted">
          <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" /> Stopping&hellip;
        </span>
      ) : (
        // THE STOP CONTROL. Offered only while a worker is actually running: absent — not disabled, not an error —
        // when there is nothing to stop. Once a stop is acknowledged the run reports `stopping` until it reaches its
        // checkpoint, so the control is swapped for an indicator and cannot be re-fired.
        <StopRunAction
          labeled
          displayName={job.displayName}
          costNote={stopCostSplit(job.config, job.phase)}
          onKeep={() => onStop("keep")}
          onDiscard={() => onStop("discard")}
        />
      )
    ) : null;
  const runLine =
    runName || stopControl ? (
      <div className="flex min-w-0 items-center justify-between gap-4">
        {/* No run in progress -> no chip. An empty chip is worse than none: it reads as a run with no name. */}
        {runName ? (
          <span data-testid="run-chip" title={runName} className="flex min-w-0 shrink items-center gap-2">
            <span className="max-w-[40rem] truncate text-xs font-semibold text-on-chrome">{runName}</span>
            <span className="shrink-0 text-xs tabular-nums text-on-chrome-muted">
              {costSoFar > 0 ? `spent ${formatUsd(costSoFar)}` : "nothing charged yet"}
            </span>
          </span>
        ) : (
          <span />
        )}
        {stopControl}
      </div>
    ) : null;
  return (
    <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-8">
      {/* The shared-demo banner (UI-SPEC §8.5): persistent, in the flow, never a modal — on every screen. */}
      {sandboxBanner ?? (isDemo && jobId ? <SandboxBanner jobId={jobId} sourceName={job?.displayName} /> : null)}
      {/* Not on the demo: it was BUILT parked at its gate — the guest did not stop anywhere to resume from. */}
      {resumed && !isDemo && <ResumeBanner gate={gate} costSoFar={costSoFar} />}
      {/* The two-tab notice (UI-SPEC §8.4, 08-28 3f): ONE placement, every screen — fixed to the viewport, so it
          renders nothing here in the flow and nothing at all until a save on this run replaced an unseen one. */}
      {jobId && <ConflictNotice jobId={jobId} />}

      {/* (2) No visible masthead: the rail names the screen. One hidden h1 keeps it named for assistive tech. */}
      <h1 className="sr-only">{title ?? GATE_LABELS[gate]}</h1>

      {/* (3) The rail, then (4) the how-to panel — both on the ground, above the working surface. */}
      {/* Reachability reads `railReachOf`, not the raw position: a FINISHED run (the shared demo every guest walks)
          carries none, and has reached every gate (08-18). Freezing above still reads the raw position. */}
      {/* PINNED (2026-10-06): sticky at the top of AppShell's scrolling <main>, on the ground colour, so the
          working surface scrolls beneath it rather than showing around its rounded corners. */}
      <div data-testid="gate-rail-pin" className="sticky top-0 z-30 -my-3 bg-surface-field py-3">
        <GateRail
          current={gate}
          items={job ? runRailFor(gate, job, costSoFar) : (rail ?? railFor(gate))}
          jobId={jobId}
          runPosition={railReachOf(job)}
          header={runLine}
        />
      </div>

      {frozen && !autoAccepted && <FrozenNotice jobId={jobId} runPosition={runPosition} />}
      {autoAccepted && <AutoAcceptedBanner gate={gate} demo={isDemo} />}
      {pausedReason && runPosition && (
        <AutoPausedNotice reason={pausedReason} jobId={jobId} runPosition={runPosition} here={gate === runPosition} />
      )}

      {/* THE RUN'S STATE, while it has one (08-14h). Placed HERE, between the rail and the how-to panel,
          and the position is a judgement rather than an accident. The rail is the run's IDENTITY — where
          it is in the flow and what each stage cost — and this is the run's temporary STATE, so the two
          read together; putting it above the masthead would have made a transient strip the first thing
          on a screen whose subject is the review. It renders NOTHING unless a worker is actually running,
          so on a parked or finished gate the rail and the how-to panel simply sit adjacent as before.

          ONE PLACEMENT, FIVE SCREENS. No gate page implements its own, and `gates.spec.ts` asserts that
          single call site — the same rule and the same reason as the stop control above. */}
      <RunProgress job={job} />

      <HowToPanel gate={gate} lead={subhead} />

      {/* The working surface. */}
      <div className={cn("flex flex-col gap-6")}>{children}</div>
    </div>
  );
}

/**
 * The banner a PAST gate wears (08-16c Task 2).
 *
 * A reviewer must never be stranded in the past, so this does two things and both are required: it says
 * plainly that the screen is a record rather than leaving the reader to infer it from controls that do
 * not respond, and it offers the way back to where the run actually is.
 */
function FrozenNotice({ jobId, runPosition }: { jobId?: string; runPosition: GatePosition | null }) {
  return (
    <p
      role="status"
      data-testid="gate-frozen"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-card bg-surface-raised px-4 py-3 text-sm text-on-raised shadow-card"
    >
      <span className="font-semibold">This run has moved on from here.</span>
      <span className="text-on-raised-muted">
        What it decided at this gate is below, but it is a record now, not a decision — nothing on this
        screen can be changed.
      </span>
      {jobId && runPosition && (
        <Link
          href={pathForGate(jobId, runPosition)}
          data-testid="gate-frozen-back"
          className="font-semibold text-link-on-raised underline underline-offset-2"
        >
          Back to {GATE_LABELS[runPosition]}
        </Link>
      )}
    </p>
  );
}

/**
 * The banner an AUTO-ACCEPTED gate wears (08-30): Full auto committed it with the pipeline's own proposals and nobody
 * reviewed it. Persistent and in the flow, like the frozen notice it replaces — and it says what can still be done
 * here, so the reviewer is neither told the gate is closed nor offered a change the server would refuse. On the shared
 * demo everything can, in the tab only, so it says that instead.
 */
function AutoAcceptedBanner({ gate, demo }: { gate: GatePosition; demo: boolean }) {
  // On the demo the sandbox banner says what can be done here (anything, in the tab), so this says nothing more.
  const what = demo
    ? null
    : gate === "gate1"
      ? "You can still rename its groups. The groups themselves stay as committed — every one was sent on — because changing them would need those groups re-run, which is not available yet."
      : "You can still review it: what you change here is recorded and goes into the export, though nothing is re-run.";
  return (
    <p
      role="status"
      data-testid="auto-accepted-banner"
      data-gate={gate}
      className="flex flex-col gap-1 rounded-card border border-rule-warn bg-surface-warn px-4 py-3 text-sm text-on-warn"
    >
      <span className="font-semibold">{AUTO_ACCEPTED_LABEL}.</span>
      <span>
        This run was set to Full auto, so {gateLabel(gate)} was committed with the pipeline&rsquo;s own proposals and
        nobody reviewed it first. Every flag is still on the rows below. {what}
      </span>
    </p>
  );
}

/**
 * A Full-auto run waiting short of Gate 4 (08-30): it stopped going on by itself — a Stop, a step that failed, no key,
 * or a server restart (the key lives in memory only). Says why, and that it now goes on gate by gate, by hand.
 */
function AutoPausedNotice({
  reason,
  jobId,
  runPosition,
  here,
}: {
  reason: string;
  jobId?: string;
  runPosition: GatePosition;
  here: boolean;
}) {
  return (
    <p
      role="status"
      data-testid="auto-paused"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-card bg-surface-raised px-4 py-3 text-sm text-on-raised shadow-card"
    >
      <span className="font-semibold">Full auto is waiting at {gateLabel(runPosition)} for you.</span>
      <span className="text-on-raised-muted">
        {reason} From here the run stops at each gate like a guided run: review it and press Continue to go on.
      </span>
      {!here && jobId && (
        <Link
          href={pathForGate(jobId, runPosition)}
          data-testid="auto-paused-go"
          className="font-semibold text-link-on-raised underline underline-offset-2"
        >
          Go to {GATE_LABELS[runPosition]}
        </Link>
      )}
    </p>
  );
}

/**
 * The five rail columns: `railCosts` (lib/gate-rail.ts — the rule, asserted in Node) plus each gate's label.
 *
 * Pulled out of the pages so the realized/forecast split is decided ONCE. Absent entries on a PASSED gate
 * fall back to "spent", never to a forecast — quoting committed money as an estimate is the exact confusion
 * UI-SPEC §7.1.3 asks the rail to prevent.
 *
 * Pass `runPosition` and every gate the run has reached reads realized, whichever screen is open. The shell does
 * that itself for any screen with a run (`runRailFor`); a bare call is a rail with no run behind it.
 *
 * NOTHING MAY PASS THE RETIRED POSITION AS `current`. It is no longer in the rail's sequence, so it indexes -1
 * and every column would render as a forecast — including gates the run has already paid for. There is no call
 * site left that can: the route redirects before a page mounts.
 */
export function railFor(current: GatePosition, args: RailCostArgs = {}): GateRailItem[] {
  return railCosts(current, args).map(({ gate, cost }) => ({ gate, label: GATE_LABELS[gate], cost }));
}

/** The rail for a screen with a run behind it: the run's own ledger, and how far the run has got. */
export function runRailFor(current: GatePosition, job: JobResult, costSoFar?: number): GateRailItem[] {
  return railFor(current, { ...realizedRailArgs(job.result?.cost, costSoFar), runPosition: railReachOf(job) });
}

// Re-exported so the five pages that imported it from here keep resolving; the rule itself lives in lib.
export { realizedRailArgs };
