import type { JobStatus } from "@/types";

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
