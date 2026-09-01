import { Check, Loader2 } from "lucide-react";
import { formatDuration } from "@/types";
import { timelineSegments } from "@/lib/run-progress";

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
