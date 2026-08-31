import type { CoherenceState, ConceptGroup } from "@/types";

/**
 * The Gate 1 ledger's ALGEBRA: what a row's flag means, how rows order, and what carrying one forward
 * costs. Every function here is pure.
 *
 * WHY IT IS NOT IN THE PAGE. The same two reasons as `lib/gate-decisions.ts`, and they are the reasons
 * that matter on this screen in particular:
 *
 *  1. **These are the properties that have to be ASSERTED.** "Breadth outranks size", "the judge's silence
 *     does not sort as its approval", "a row is flagged by the judge's flag and never by its size" — each
 *     is a claim about the reviewer's attention, and `frontend/` has no component test runner, so logic
 *     reachable only through React is logic that ships unasserted.
 *  2. **NO ENVIRONMENT READS**, ever. `lib/api.ts` reads `import.meta.env`, which is undefined in the
 *     Playwright node runtime, so a spec importing anything that transitively touches it throws before a
 *     single assertion runs. Same rule as `lib/run-state.ts` and `lib/gate-routes.ts`, same measured cause.
 */

// --- the flag ------------------------------------------------------------------------------------------

/**
 * Whether the judge raised an OVER-MERGE on this group — the amber spine, and the carve proposal.
 *
 * READ OFF THE JUDGE'S OWN FLAG, never re-derived. `incoherent` is the contract's flag field and core's
 * docstring is explicit that it is *a flag, never a gate*: an over-merged group is surfaced for a human
 * and never auto-split. `split` is carried alongside it because the verdict and the flag are written by
 * the same pass and a payload with one and not the other is a payload this screen should still act on.
 *
 * `not_judged` IS NOT FLAGGED, and that is deliberate rather than an oversight. An absence is not an
 * alarm: manufacturing one out of the judge's silence would put 1016 rows the judge never saw above the
 * rows it actually objected to. The unjudged state gets its own honest cell and, where the $0 template
 * detector fires, its own weaker mark — but not this one.
 *
 * `qualify` is likewise not flagged. It is one concept with a modifier — advisory, not a defect.
 */
export function isFlagged(group: Pick<ConceptGroup, "incoherent" | "coherence">): boolean {
  return group.incoherent || group.coherence === "split";
}

// --- the order -----------------------------------------------------------------------------------------

/**
 * The four coherence states as a triage order, lowest first. A CLOSED categorical, never a scale.
 *
 * The two non-obvious placements are the whole point:
 *
 *  - **`split` leads** because it is the only state that arrives with a proposed correction attached. It
 *    is the one row where the reviewer has something to accept, edit or ignore rather than merely look at.
 *  - **`not_judged` sits ABOVE `single`.** The judge was never asked about those groups (it needs six
 *    members: five for its centroid core and a disjoint periphery to verify against), and core defaults
 *    `coherent` to true — so sorting them below a group the judge actually cleared would file the
 *    judge's silence as its approval, which is exactly what the four-state cell exists to prevent.
 *
 * NO NUMERIC CONFIDENCE IS IMPLIED ANYWHERE. These are sort positions, not scores: no such number is
 * computed and the calibration to justify one does not exist. A gradient, a percentage or a confidence
 * meter built on this table would be inventing precision.
 */
export const COHERENCE_ORDER: Record<CoherenceState, number> = {
  split: 0,
  qualify: 1,
  not_judged: 2,
  single: 3,
};

/**
 * The ledger's total order WITHIN a bucket: verdict, then COHORT BREADTH, then size, then id.
 *
 * BREADTH OUTRANKS SIZE, and this tiebreak was reversed on purpose (the 2026-08-21 amendment). The key as
 * originally written sorted on variable count, which puts a 40-variable single-cohort group above a
 * 5-variable group spanning four cohorts — backwards for a screen whose subject is pooling across
 * dictionaries. Breadth is read from `cohorts.length` rather than from the `crossCohort` boolean because
 * the boolean cannot rank 2 against 5; the boolean is the PARTITION key, this is the ORDERING key.
 *
 * GROUP ID IS THE LAST COMPONENT, so the order is total: no two rows can tie, and a reload cannot reorder
 * the screen under a reviewer who left mid-triage.
 */
export function compareGroups(a: ConceptGroup, b: ConceptGroup): number {
  return (
    COHERENCE_ORDER[a.coherence] - COHERENCE_ORDER[b.coherence] ||
    b.cohorts.length - a.cohorts.length ||
    b.nMembers - a.nMembers ||
    (a.groupId < b.groupId ? -1 : a.groupId > b.groupId ? 1 : 0)
  );
}

/** `compareGroups` over a list, without mutating the caller's array. */
export function sortGroups(groups: readonly ConceptGroup[]): ConceptGroup[] {
  return [...groups].sort(compareGroups);
}

// --- what a row costs ------------------------------------------------------------------------------------

/**
 * What carrying ONE group forward to Gate 2 is forecast to cost.
 *
 * DIVIDED EVENLY, and the reason is mechanical rather than a simplification: `assign` runs once per
 * POST-SPLIT GROUP, so the call count is the row count and every row buys the same call. Weighting by
 * member count would imply a per-variable price the pipeline does not charge.
 *
 * Returns 0 for a run with no groups rather than dividing by zero — a price column on an empty ledger is
 * not a number that needs inventing.
 */
export function pricePerGroup(gate2Forecast: number, nGroups: number): number {
  return nGroups > 0 ? gate2Forecast / nGroups : 0;
}
