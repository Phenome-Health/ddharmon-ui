import type { JobResult, JobStatus, PreprocessReport } from "@/types";

/**
 * The ONE answer to "is this run running?", as pure functions with NO environment reads.
 *
 * WHY THIS MODULE EXISTS. The staged flow added a third kind of run — parked at a review gate — and the
 * surfaces that predate it only knew two. Four copies of the in-flight predicate were in the tree on
 * 2026-08-31 and TWO OF THEM WERE WRONG, both of them the same wrong: `new Set(["complete", "error",
 * "cancelled"])` in `components/active-runs-indicator.tsx` and `pages/jobs.tsx`. `awaiting_review` is
 * non-terminal, so under those two a parked run counted as running — which is how the header badge came
 * to read "5 running" with a spinning loader over five runs that had no worker and were spending nothing.
 * Each copy looked correct in its own file. Only reading all four together showed the disagreement, and
 * that is precisely the class of defect a shared definition removes rather than fixes.
 *
 * THE CORRECT PREDICATE WAS ALREADY IN THIS CODEBASE — it was simply not shared. `GateShell.tsx:106`
 * (`NOT_IN_FLIGHT`) and `hooks/use-harmonize-stream.ts:35` both already exclude `awaiting_review`, and
 * GateShell's copy even carries the reasoning. **Neither is migrated to this module, deliberately.**
 * 08-14c ran in parallel with the plans building the gate screens (08-15/16/17), which render both of
 * those files, so migrating them would have created a merge conflict for zero behaviour change. They are
 * not an oversight and they are not wrong — they are a de-duplication owed to a later, quieter moment.
 *
 * NO ENVIRONMENT READS, ever — the same rule as `lib/gate-routes.ts` and for the same measured reason:
 * `lib/api.ts` reads `import.meta.env.VITE_STATIC`, which is undefined in the Playwright node runtime, so
 * a spec importing that module throws before any assertion runs. A predicate that cannot be imported by a
 * test is a predicate that drifts, which is the history above.
 */

/** The status of a run that has parked at a review gate. Non-terminal, but with no worker (08 D-01). */
export const PARKED = "awaiting_review";

/**
 * The run is over, one way or another. `cancelled` is a user stop and is distinct from `error`, but both
 * are endings.
 */
const TERMINAL = new Set<string>(["complete", "error", "cancelled"]);

/**
 * Nothing is executing. DERIVED from the two sets above rather than written out a third time — writing
 * the literal again is the exact defect this module exists to end.
 */
const NOT_IN_FLIGHT = new Set<string>([...TERMINAL, PARKED]);

/** The run has ended: complete, failed, or stopped by the user. */
export function isTerminal(status: JobStatus | string | null | undefined): boolean {
  return !!status && TERMINAL.has(status);
}

/**
 * The run is paused at a review gate, waiting on a human.
 *
 * NOT terminal — it will continue when a verdict is filed — and NOT in flight: a pause is an EXIT (08
 * D-01), so the worker is gone and nothing is accruing. Offering a stop here, or counting it as running,
 * is a false claim about the run rather than a harmless imprecision.
 */
export function isParked(status: JobStatus | string | null | undefined): boolean {
  return status === PARKED;
}

/**
 * A worker is burning money right now.
 *
 * `pending` IS in flight: the worker has not started, so a stop still avoids the whole cost. An ABSENT
 * status is not — a missing field is not evidence that something is running.
 */
export function isInFlight(status: JobStatus | string | null | undefined): boolean {
  return !!status && !NOT_IN_FLIGHT.has(status);
}

/**
 * How many of these runs are actually running.
 *
 * A FUNCTION RATHER THAN AN INLINE FILTER, because the number it returns is a CLAIM the header makes to
 * the user — "5 running", next to a spinning loader — and that claim was false for months. A count is
 * exactly the kind of thing that reads as obviously-correct at the call site and is asserted nowhere.
 */
export function countInFlight(jobs: readonly { status?: JobStatus | string | null }[] | null | undefined): number {
  return (jobs ?? []).filter((j) => isInFlight(j.status)).length;
}

/**
 * Did this run just END — the transition worth announcing to someone who has navigated away?
 *
 * A PARK IS NOT AN ENDING. It is a handover to a human, and the run is expected to continue, so the
 * completion toast would be premature and the failure toast (the fallthrough arm of that effect) would
 * report a working pause as a broken run. Resuming out of a park and finishing IS an ending, and still
 * announces — which is why this takes the previous status rather than testing the new one alone.
 */
export function justEnded(
  prev: JobStatus | string | null | undefined,
  next: JobStatus | string | null | undefined,
): boolean {
  // An unseen run announces nothing: the observer seeds its map on first load precisely so a page
  // opened after the fact does not fire a burst of stale toasts.
  if (!prev) return false;
  return !isTerminal(prev) && isTerminal(next);
}

// --- how far the local, unpaid part of a run has got -----------------------------------------------------

/** One cohort in the run, with its preparation report if that cohort has produced one yet. */
export interface CohortPreparation {
  cohort: string;
  report: PreprocessReport | null;
}

/** Phases that run BEFORE preprocessing has produced anything for every cohort. */
const PRE_PREPARE_PHASES = new Set(["queued", "loading", "embedding"]);

/**
 * How far preparation has actually got, and therefore whether the run may be committed.
 *
 * WHY IT IS IN THIS MODULE. It arrived in the pre-flight panel (08-14b), which 08-14d deleted along
 * with the rest of the preprocessing report. This function is NOT part of that report: it answers *"is the free
 * leg finished?"*, which is a fact about the RUN, and Setup's commit control — the run's first charge —
 * reads it to decide whether it may be pressed. Deleting a screen must not delete the predicate its money
 * control depends on, so it moved to the module that already owns "what state is this run in".
 *
 * PURE, WITH NO ENVIRONMENT READS, same as everything else here — so a Playwright spec can import it.
 */
export interface PreparationProgress {
  /** DECLARED cohorts first, so a cohort the run knows about but has not prepared yet is still listed. */
  cohorts: CohortPreparation[];
  /** How many of them have produced a report. */
  prepared: number;
  /** True only when every declared cohort is done AND the run is past the pre-preparation phases. */
  allPrepared: boolean;
  /** Variables across the FINISHED reports. Only a total for the run when `allPrepared`. */
  variables: number;
}

export function preparationProgress(run: JobResult | null): PreparationProgress {
  const reports: PreprocessReport[] = run?.result?.preprocessing ?? [];
  const byCohort = new Map(reports.map((r) => [r.cohort, r]));
  const declared: string[] = run?.result?.summary?.cohorts ?? [];
  // DECLARED cohorts first, so a cohort the run knows about but has not prepared yet is listed in the
  // pending state rather than being invisible — an absent entry is indistinguishable from a cohort that
  // was never in the run.
  const order = [...declared, ...reports.map((r) => r.cohort).filter((c) => !declared.includes(c))];
  const cohorts: CohortPreparation[] = order.map((cohort) => ({
    cohort,
    report: byCohort.get(cohort) ?? null,
  }));
  const prepared = cohorts.filter((c) => c.report).length;
  return {
    cohorts,
    prepared,
    allPrepared:
      cohorts.length > 0 && prepared === cohorts.length && !PRE_PREPARE_PHASES.has(run?.phase ?? ""),
    variables: reports.reduce((n, r) => n + r.nUniqueVariableNames, 0),
  };
}
