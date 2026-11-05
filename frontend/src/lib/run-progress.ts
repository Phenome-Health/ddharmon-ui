import type { BatchInFlight, RunMode } from "@/types";
import { formatUsd } from "@/lib/estimate";
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
 * Stamps that are QUEUE / PARK markers rather than stages (08-26, live-test-2 #5).
 *
 * `pending` is the enqueue before a leg's worker starts, `awaiting_review` the park at a gate, `cancelled`
 * a stop. They are read as BOUNDARIES — the stage before a park ends at the park — but never rendered: a
 * park drawn as a stage "ran" for the days the run sat waiting for a human.
 */
export const NON_STAGE_PHASES = ["pending", "awaiting_review", "cancelled", "stopping"];

/**
 * When the CURRENT leg of a staged run started, in the stream's clock — or null with no timings.
 *
 * A resumed run is several legs, and the progress panel describes the one running now. The server starts
 * each leg with a fresh timing map (08-26), so the leg is simply its first stamp. An OLDER server kept the
 * first leg's stamps (they are set once, never reset) and added the park; there the current leg is
 * whatever was stamped AFTER the last park. Both readings are the same function.
 */
export function legStartedAt(phaseStartedAt?: Record<string, number>): number | null {
  const entries = Object.entries(phaseStartedAt ?? {});
  if (!entries.length) return null;
  const park = phaseStartedAt?.awaiting_review;
  const after = park == null ? [] : entries.filter(([p, t]) => p !== "awaiting_review" && t > park).map(([, t]) => t);
  if (after.length) return Math.min(...after);
  const rest = entries.filter(([p]) => p !== "awaiting_review").map(([, t]) => t);
  return rest.length ? Math.min(...rest) : (park ?? null);
}

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
  // Only the CURRENT leg's stages (#5): on a resume, the first leg's stamps are not this leg's work.
  const legStart = legStartedAt(timings);
  const seq = Object.keys(timings)
    .filter((p) => !TERMINAL_PHASES.includes(p) && !NON_STAGE_PHASES.includes(p))
    .filter((p) => legStart === null || timings[p] >= legStart)
    .sort((a, b) => timings[a] - timings[b]);
  if (!seq.length) return [];
  const terminalAt = timings.complete ?? timings.error ?? null;
  // A stage ends at the NEXT stamp of any kind — its successor stage, a park, a stop or the terminal stamp —
  // and runs to `now` only when nothing has been stamped after it.
  const stamps = Object.values(timings).sort((a, b) => a - b);
  const endOf = (start: number): number => stamps.find((t) => t > start) ?? terminalAt ?? now;
  return seq.map((phase) => ({
    phase,
    seconds: Math.max(0, endOf(timings[phase]) - timings[phase]),
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
  transport?: string | null,
): boolean {
  // 08-28 0e: a leg that switched to sync is sending its calls NOW, whatever the run was started as — its
  // progress is real again. `transport` is absent on older servers, which keeps the config-only reading.
  if (transport === "sync") return false;
  return runModeOf(config) === "batch" && PROVIDER_STAGES.includes(phase);
}

/**
 * Where the batch -> sync switch stands for this run (08-28 0e), or null when there is nothing to show.
 *
 *  - `offer`     — the leg is batch and its batch is still `in_progress` and switchable: offer to finish now,
 *                  with the sync remainder's estimate in the label. An estimate that could not be priced is
 *                  left OUT of the label rather than shown as "+$0", which would be an under-quote (R8).
 *  - `requested` — pressed; the server has marked the batch un-switchable and the stage acts at its next
 *                  heartbeat. Rendered as an acknowledgement, never as a second offer.
 *  - `switching` — the batch was cancelled and is handing back what it had already finished; the rest runs
 *                  sync once it has.
 *
 * Only `in_progress` is ever offered: that is the one batch state a cancel can act on, and the Batches API's
 * per-item counts are 0 until a batch ends, so "how much is left" cannot be read mid-batch — the estimate is
 * for everything the batch was sent.
 */
export type SyncSwitchState =
  | { kind: "offer"; label: string; estimateUsd: number | null; nItems: number }
  | { kind: "requested" }
  | { kind: "switching" }
  | null;

export function syncSwitchState(
  run: { transport?: string | null; batch?: BatchInFlight | null } | null | undefined,
): SyncSwitchState {
  const batch = run?.batch;
  if (!run || !batch) return null;
  if (run.transport === "sync") return { kind: "switching" };
  if (run.transport !== "batch" || batch.status !== "in_progress") return null;
  if (!batch.switchable) return { kind: "requested" };
  const est = typeof batch.syncEstimateUsd === "number" && batch.syncEstimateUsd > 0 ? batch.syncEstimateUsd : null;
  return {
    kind: "offer",
    label: est === null ? "Finish now with sync" : `Finish now with sync (+${formatUsd(est)})`,
    estimateUsd: est,
    nItems: batch.nItems,
  };
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
  /** The current leg's start (`legStartedAt`). Given, a LIVE clock counts this leg only (#5): measured from
   *  `createdAt`, a Gate 2 -> 3 resume read "running for 69h" — the days it sat parked, not work. */
  legStart?: number | null,
): number {
  if (!run) return 0;
  if (isInFlight(run.status)) return Math.max(0, now - (legStart ?? run.createdAt));
  return Math.max(0, run.updatedAt - run.createdAt);
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
  transport,
  elapsed,
  pct,
}: {
  status?: string | null;
  phase: string;
  config: Record<string, unknown> | null | undefined;
  /** The leg's live transport (08-28 0e); a switched leg is progressing, not queued. */
  transport?: string | null;
  elapsed: number;
  pct: number;
}): number | null {
  if (!isInFlight(status)) return null;
  if (isAwaitingProviderQueue(config, phase, transport)) return null;
  if (!(elapsed > 3 && pct >= 12 && pct < 100)) return null;
  return (elapsed * (100 - pct)) / pct;
}
