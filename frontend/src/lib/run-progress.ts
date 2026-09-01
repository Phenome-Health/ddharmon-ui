import type { RunMode } from "@/types";
import { isInFlight } from "@/lib/run-state";

/**
 * How far along a run is — the arithmetic only, as pure functions with NO environment reads.
 *
 * WHY THIS MODULE EXISTS. Every progress affordance this product has was written on
 * `pages/dashboard.tsx` and none of it was exported: `phasePercent` (`:115`) and `RunTimeline` (`:130`)
 * were module-local. `08-14f` then made Start land directly on Gate 1, so the dashboard stopped being a
 * screen anyone walks through — and the only place that could answer "how far has this got" went with it.
 * Bhargav, watching a real run on 2026-08-31: *"there's no progress bar or real time population of stats
 * on gate 1 screen while a run is going."*
 *
 * The answer is to LIFT what exists, not to write a second one. A second implementation of "how far along
 * is this run" is exactly the duplication the inherited-UI audit exists to catch, and the four-copies
 * history recorded in `lib/run-state.ts` is what that costs: each copy looks correct in its own file, and
 * only reading them together shows the disagreement.
 *
 * THIS FILE IS 08-14h TASK 1 AND IT MOVED CODE ONLY. Nothing here was retuned on the way past: the `5`
 * floor for an unknown phase, the `99` ceiling for a known one, the terminal-stamp handling and the
 * zero floor are all the dashboard's own, character for character. The proof is that the dashboard's
 * visual baseline did not move.
 *
 * NO ENVIRONMENT READS, ever — the same rule as `lib/run-state.ts` and `lib/gate-routes.ts`, and for the
 * same measured reason: `lib/api.ts` reads `import.meta.env.VITE_STATIC`, which is undefined in the
 * Playwright node runtime, so a spec importing that module throws before any assertion runs. See
 * `tests/e2e/run-progress.spec.ts`, which asserts all of this without a browser.
 *
 * IT ALSO HOLDS NO RUN-STATE KNOWLEDGE OF ITS OWN. Whether a run is in flight, parked or terminal is
 * `lib/run-state.ts`'s question, it is already answered there, and this module IMPORTS that answer rather
 * than restating it — a one-directional dependency, the same shape `gate-routes.ts` has. Both the elapsed
 * freeze and the ETA suppression turn on `isInFlight`, and writing a fourth copy of that predicate next
 * to a percentage that happened to need one is exactly the defect `run-state.ts` exists to end.
 */

/**
 * Known phase ordering for the progress bar.
 *
 * The phase LABEL is shown verbatim from the stream, so a new pipeline phase still displays; only the
 * percent uses this ordering, and it falls back gracefully when the phase is not in the list.
 */
export const PHASE_ORDER = ["loading", "embedding", "clustering", "generating", "splitting", "assigning", "specs"];

/**
 * Stamps the stream carries that are ENDINGS rather than stages.
 *
 * They arrive in the same `phaseStartedAt` map as the real stages, so a timeline that did not filter them
 * would render "complete" as a stage of zero length sitting after the work.
 */
export const TERMINAL_PHASES = ["complete", "error", "prepared"];

/**
 * The run's completion as a percentage: its phase's position in the pipeline, plus how far into that
 * phase its own item count has got.
 *
 * TWO BOUNDS, BOTH LOAD-BEARING.
 *
 * The `5` floor for a phase not in `PHASE_ORDER` is what keeps the ETA suppressed over a parked run:
 * `awaiting_review` is not a pipeline phase, so it scores 5, which fails the dashboard's `pct >= 12`
 * guard. 08-14c depends on this and says so; changing the floor upward would silently start projecting a
 * finish time for work that has stopped.
 *
 * The `99` ceiling is what reserves 100 for a run that has actually finished. A bar reading 100% over a
 * stage that is still streaming is a false claim, not a rounding convenience.
 */
export function phasePercent(phase: string, completed: number, total: number): number {
  if (phase === "complete" || phase === "prepared") return 100;
  const idx = PHASE_ORDER.indexOf(phase);
  if (idx < 0) return 5;
  const span = 100 / PHASE_ORDER.length;
  // A total of zero is "this stage does not count items", not "zero of zero done": dividing would give
  // NaN, which renders as an empty bar and reads as no progress at all.
  const sub = total > 0 ? (completed / total) * span : 0;
  return Math.min(99, Math.round(idx * span + sub));
}

/** One reached stage of a run, with how long it ran. */
export interface TimelineSegment {
  /** The phase name, verbatim from the stream. */
  phase: string;
  /** How long it ran, in seconds. Floored at zero. */
  seconds: number;
  /** True for the stage running right now — at most one, and none once the run has ended. */
  active: boolean;
}

/**
 * The per-stage timeline of a run, built from the backend's `phaseStartedAt` stream.
 *
 * A STAGE ENDS WHEN THE NEXT ONE STARTS. The backend stamps starts, not durations, so a stage's length is
 * derived from its successor — and the last stage runs to the terminal stamp once there is one, or to
 * `now` while there is not. That is what makes a live run's last row tick and a finished run's stop.
 *
 * SORTED BY TIMESTAMP, not by key. Object key order is not a guarantee the stream makes, and a timeline
 * that showed stages out of the order they ran would be worse than none.
 *
 * FLOORED AT ZERO, because `now` lags the newest stage's start for a moment after a transition — the tick
 * is on an interval and the stream is not — and a stage rendering "-3s" reads as a bug in the run.
 *
 * Returns an EMPTY ARRAY when no timings were streamed (a DB-hydrated historical run), which is the
 * caller's cue to render nothing at all rather than a heading over an empty list.
 */
export function timelineSegments({
  phaseStartedAt,
  currentPhase,
  now,
}: {
  phaseStartedAt?: Record<string, number>;
  currentPhase: string;
  now: number;
}): TimelineSegment[] {
  const timings = phaseStartedAt ?? {};
  const seq = Object.keys(timings)
    .filter((p) => !TERMINAL_PHASES.includes(p))
    .sort((a, b) => timings[a] - timings[b]);
  if (!seq.length) return [];
  const terminalAt = timings.complete ?? timings.error ?? null;
  const endOf = (i: number): number => (i + 1 < seq.length ? timings[seq[i + 1]] : (terminalAt ?? now));
  return seq.map((phase, i) => ({
    phase,
    seconds: Math.max(0, endOf(i) - timings[phase]),
    // Nothing is active once the run has ended: the stage it stopped in is finished, not running.
    active: phase === currentPhase && terminalAt === null,
  }));
}

// --- what the run is actually waiting on, and what may honestly be projected from it -------------------

/**
 * Stages that run on THIS MACHINE. No provider is involved, so their progress is observable and real.
 */
export const LOCAL_STAGES = ["loading", "embedding", "clustering"];

/**
 * Stages handed to the model provider. In BATCH mode these are submitted and then waited on.
 *
 * The list mirrors `STOP_COMMITTED_BY_PHASE` in `lib/estimate.ts`, which is the authority on which stages
 * cost money and therefore on which ones call a provider at all. Keeping the two in step matters: a stage
 * that spends is a stage that queues.
 */
export const PROVIDER_STAGES = ["generating", "splitting", "assigning", "gencde", "specs"];

/**
 * The run's mode, from its stored config.
 *
 * DEFAULTS TO BATCH when absent or malformed, which is the convention `stopCostSplit` already follows and
 * the product's own default. It also errs in the required direction: an unknown mode is treated as the
 * one where a projection would be a fabrication, so the uncertainty resolves into saying less.
 */
export function runModeOf(config: Record<string, unknown> | null | undefined): RunMode {
  const mode = config?.run_mode;
  return (typeof mode === "string" ? mode : "batch") as RunMode;
}

/**
 * Is this run sitting in the provider's queue rather than making progress?
 *
 * THE CASE THIS WHOLE READOUT EXISTS TO GET RIGHT. The queue is the majority of a batch run's wall clock
 * — the estimator models it at a mid of an hour against a documented ceiling of 24 (`types.ts`,
 * recalibrated 2026-08-26) — and the stage percentage does not move while it runs. A bar that has not
 * moved in twenty minutes reads as a hung product unless the screen says what is being waited on.
 *
 * 08-13b met the same problem in the Setup estimate, where blending the two terms quoted batch as FASTER
 * than sync, and settled it by itemising work and queue as two labelled lines so the uncertain half stays
 * visible. This is that decision, applied to the live run instead of to the forecast.
 */
export function isAwaitingProviderQueue(
  config: Record<string, unknown> | null | undefined,
  phase: string,
): boolean {
  return runModeOf(config) === "batch" && PROVIDER_STAGES.includes(phase);
}

/**
 * How long this run has been running, in seconds.
 *
 * FROZEN THE MOMENT IT STOPS BEING IN FLIGHT. `updatedAt` is stamped at the park
 * (`JobStore.checkpoint`) and filing a verdict never moves it (`set_decision` does not touch the field),
 * so `updatedAt − createdAt` is the run's real compute time. This is 08-14c's rule, lifted here so it is
 * computed ONCE rather than by each surface that needs it — the four-copies history in `lib/run-state.ts`
 * is what the alternative costs.
 *
 * The measurement behind the rule: the live wall clock this replaced had one parked run reading
 * **109 hours** for 6.6 seconds of work. A gate showing a climbing clock over a parked run would be that
 * bug returning by another door, so the freeze is enforced in the arithmetic rather than at each caller.
 *
 * Floored at zero: clock skew between browser and server can put `now` behind `createdAt`, and a negative
 * elapsed renders as "-4s", which reads as a broken run rather than as a clock problem.
 */
export function elapsedSeconds(
  run: { status?: string | null; createdAt: number; updatedAt: number } | null | undefined,
  now: number,
): number {
  if (!run) return 0;
  const end = isInFlight(run.status) ? now : run.updatedAt;
  return Math.max(0, end - run.createdAt);
}

/**
 * Seconds remaining, projected from how far the run has got against how long that took — or NULL.
 *
 * SELF-CALIBRATING, so it needs no field count: if 25% took 100 seconds, the remaining 75% is 300. That
 * is the dashboard's own projection, carried over unchanged.
 *
 * FOUR REASONS TO REFUSE, and every one of them returns null rather than a hedged number, because an
 * absent estimate beats a fabricated one:
 *
 *  1. The run is not in flight. A projected finish time is a CLAIM THAT WORK IS IN PROGRESS, and over a
 *     parked or finished run that claim is false — not merely useless.
 *  2. It is waiting in the provider's queue. The input percentage is standing still, so dividing by it
 *     invents a number out of a stalled measurement. **This is the one condition the dashboard did not
 *     have**; it is added here because the same code now serves both surfaces and the omission was a real
 *     defect on the dashboard too, not merely a gap in the new one.
 *  3. Fewer than three seconds have elapsed — the ratio is wild in the first moments.
 *  4. The percentage is below 12 or has reached 100. The floor is also what keeps an unrecognised phase
 *     (which scores 5) from being projected at all.
 */
export function etaSeconds({
  status,
  phase,
  config,
  elapsed,
  pct,
}: {
  status?: string | null;
  phase: string;
  config: Record<string, unknown> | null | undefined;
  elapsed: number;
  pct: number;
}): number | null {
  if (!isInFlight(status)) return null;
  if (isAwaitingProviderQueue(config, phase)) return null;
  if (!(elapsed > 3 && pct >= 12 && pct < 100)) return null;
  return (elapsed * (100 - pct)) / pct;
}
