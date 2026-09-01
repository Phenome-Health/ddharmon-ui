import { useEffect, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDuration, type JobResult } from "@/types";
import { isInFlight } from "@/lib/run-state";
import {
  elapsedSeconds,
  etaSeconds,
  isAwaitingProviderQueue,
  phasePercent,
  timelineSegments,
} from "@/lib/run-progress";

/**
 * The run's progress, as components. The arithmetic lives in `lib/run-progress.ts`; this file only
 * renders it.
 *
 * WHY THE SPLIT. A percentage that cannot be imported by a Playwright spec is a percentage that drifts —
 * the rule `lib/run-state.ts` and `lib/gate-routes.ts` already follow, and the reason `run-progress.ts`
 * has no environment reads and no JSX. What is left here is markup, which is asserted by rendering it.
 *
 * `RunTimeline` ARRIVED HERE BY EXTRACTION, NOT BY REWRITING (08-14h Task 1). It was module-local to
 * `pages/dashboard.tsx:130`, on a screen `08-14f` stopped routing anyone through, and its markup is
 * unchanged down to the class strings — the dashboard's visual baseline holding still is the proof. Only
 * the sequence-and-durations computation moved out, into `timelineSegments`, so it could be asserted.
 *
 * `dashboard.tsx` IS 1,246 LINES AND 08-17 OWNS ITS FUTURE. Nothing else was tidied on the way past.
 */

/**
 * Verbose per-stage timeline for a live run: each reached stage with how long it ran.
 *
 * Hidden gracefully when no timings are streamed (e.g. a DB-hydrated historical run) — an empty timeline
 * would claim the run had no stages, which is a different thing from this run not having reported them.
 */
export function RunTimeline({
  phaseStartedAt,
  currentPhase,
  now,
}: {
  phaseStartedAt?: Record<string, number>;
  currentPhase: string;
  now: number;
}) {
  const segments = timelineSegments({ phaseStartedAt, currentPhase, now });
  if (!segments.length) return null;
  return (
    <div className="space-y-1 border-t border-rule-on-raised pt-2 text-xs">
      {segments.map((s) => (
        <div key={s.phase} className="flex items-center justify-between">
          <span className="flex items-center gap-1.5 capitalize text-on-raised">
            {s.active ? (
              <Loader2 className="h-3 w-3 animate-spin text-accent-on-raised" />
            ) : (
              <Check className="h-3 w-3 text-success" />
            )}
            {s.phase}
          </span>
          <span className="tabular-nums text-on-raised-muted">{formatDuration(s.seconds)}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * The run's live state, rendered in the gate chrome while — and only while — a worker is running.
 *
 * WHAT IT SAYS, AND WHAT IT REFUSES TO SAY. A reviewer who lands on a gate mid-run needs three facts: the
 * stage the run has reached, roughly how far it has got, and how long it has been going. It gives those.
 * It does NOT give a finish time it cannot support, and it does not animate a bar over a run that is
 * standing still in a provider's queue — the two ways a progress readout lies.
 *
 * THE BATCH QUEUE IS THE CASE THIS EXISTS TO GET RIGHT. The queue is the majority of a batch run's wall
 * clock (modelled at a mid of an hour against a documented 24-hour ceiling) and the stage percentage does
 * not move while it runs, so a bar that has not moved in twenty minutes reads as a hung product. Instead
 * the readout names what is being waited on and drops the bar entirely — the same honesty 08-13b settled
 * on for the Setup estimate, where itemising work and queue as two labelled lines was what stopped the
 * uncertain half hiding inside a blended figure.
 *
 * IT RENDERS NOTHING FOR A RUN THAT IS NOT IN FLIGHT, and that includes a PARKED run. A parked run's
 * screen is about the review, not about the run; the rail already carries where it got to and what it
 * spent, and a progress strip there would be chrome competing with the thing the reviewer came for. The
 * frozen-elapsed rule 08-14c established is enforced in `elapsedSeconds` regardless, so no surface — this
 * one or a later one — can show a climbing clock over a run that has stopped.
 *
 * IT OWNS ITS OWN TICK. `GateShell` does not subscribe to the stream and must not grow a timer for a
 * readout that is usually absent; the interval here starts only while the run is in flight and is torn
 * down the moment it is not, so a parked or finished gate screen runs no timer at all.
 */
export function RunProgress({ job, className }: { job?: JobResult | null; className?: string }) {
  // Seconds, matching the wire: `createdAt`/`updatedAt` are unix seconds.
  const [now, setNow] = useState(() => Date.now() / 1000);
  const inFlight = isInFlight(job?.status);
  useEffect(() => {
    if (!inFlight) return;
    const tick = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(tick);
  }, [inFlight]);

  if (!job || !inFlight) return null;

  const config = job.config as Record<string, unknown> | undefined;
  const elapsed = elapsedSeconds(job, now);
  const pct = phasePercent(job.phase, job.completed, job.total);
  const queued = isAwaitingProviderQueue(config, job.phase);
  const eta = etaSeconds({ status: job.status, phase: job.phase, config, elapsed, pct });

  return (
    <section
      data-testid="run-progress"
      // A live region: a reviewer who arrives mid-run and does not look away should still be told when
      // the stage changes. `polite`, because nothing here is urgent enough to interrupt.
      aria-live="polite"
      aria-label="How far this run has got"
      className={cn(
        "flex flex-col gap-2 rounded-card bg-surface-raised px-6 py-4 shadow-card",
        className,
      )}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        {/* The stage LABEL comes verbatim from the stream, so a pipeline stage this client has never
            heard of still displays. Only the percentage uses the known ordering. */}
        <p data-testid="run-progress-stage" className="flex items-center gap-2 text-sm text-on-raised">
          <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin text-accent-on-raised" />
          <span className="font-semibold capitalize">{job.phase}</span>
          {job.total > 0 && (
            <span className="font-mono text-xs tabular-nums text-on-raised-muted">
              {job.completed} / {job.total}
            </span>
          )}
        </p>
        <p className="flex items-center gap-3 text-xs text-on-raised-muted">
          <span data-testid="run-progress-elapsed" className="tabular-nums">
            Running for {formatDuration(elapsed)}
          </span>
          {/* ABSENT, not zeroed, when no honest projection exists. See `etaSeconds` for the four refusals. */}
          {eta !== null && (
            <span data-testid="run-progress-eta" className="tabular-nums">
              ~{formatDuration(eta)} left
            </span>
          )}
        </p>
      </div>

      {queued ? (
        /* NO BAR HERE, DELIBERATELY. The percentage is standing still because the work is with the
           provider, and rendering it would present a stalled number as progress. */
        <p data-testid="run-progress-queue" className="max-w-[80ch] text-sm text-on-raised-muted">
          <span className="font-semibold text-on-raised">Waiting in the provider&rsquo;s batch queue.</span>{" "}
          The work itself is minutes; the queue is what makes a batch run long — most clear within an hour,
          and the provider allows up to 24. Nothing is stuck, and you can close this tab: the run keeps
          going and will be waiting at its gate when you come back.
        </p>
      ) : (
        <div
          data-testid="run-progress-bar"
          data-pct={pct}
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${job.phase} — ${pct}% of the run`}
          className="h-1.5 w-full overflow-hidden rounded-pill bg-surface-inset"
        >
          <div className="h-full rounded-pill bg-accent-action" style={{ width: `${pct}%` }} />
        </div>
      )}
    </section>
  );
}
