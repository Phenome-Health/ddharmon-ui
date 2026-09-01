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

// --- the partition -------------------------------------------------------------------------------------

/**
 * The two buckets, and they are a STRUCTURAL FACT rather than a judgement.
 *
 * A group drawing on two or more cohorts is HARMONIZATION — the thing this tool is for. A group drawing on
 * one is CDE-mapping: a real result, and a different job, scored separately and never blended with the
 * first. The names say which is which and neither says "good".
 */
export type Bucket = "cross-cohort" | "single-cohort";
export const BUCKETS: Bucket[] = ["cross-cohort", "single-cohort"];

/** The DEFAULT view. See `partitionByBreadth` for why the ledger partitions before it sorts. */
export const DEFAULT_BUCKET: Bucket = "cross-cohort";

/**
 * Split the ledger on cohort breadth — BEFORE sorting, not after.
 *
 * WHY A PARTITION AND NOT JUST AN ORDER (the 2026-08-21 amendment, from measurement). On the full-5
 * artifact the judge flags 351 of 1901 groups, and **237 of those 351 are single-cohort**. Flag-first
 * ordering alone therefore spends 68% of the reviewer's first attention on rows that are not
 * harmonization at all.
 *
 * The judge is not the problem — it is well aimed where it matters. Its flag rate is 45% on cross-cohort
 * groups against 14% on single-cohort ones: pooling across dictionaries really is ~3x harder and the judge
 * fires ~3x more often there. So the verdict is a good SIGNAL and a bad PARTITION. Use each for what it is
 * good at: partition on a structural fact, then order flag-first inside the partition.
 *
 * That also discharges this screen's own trust boundary — *"LLM judge verdicts → the reviewer's triage
 * order"* — without weakening the judge: the model no longer chooses the SET, only the order within a set
 * chosen by a fact.
 *
 * READ OFF THE CONTRACT BOOLEAN. `crossCohort` is already a field on `UIConceptGroup`, populated from
 * core's own `cross_cohort`. Recomputing it here from `cohorts.length` would be a second answer to a
 * question the backend has already answered, and the two could drift. (`cohorts.length` is still the right
 * key for ORDERING breadth, because the boolean cannot rank 2 against 5 — see `compareGroups`.)
 */
export function partitionByBreadth(groups: readonly ConceptGroup[]): Record<Bucket, ConceptGroup[]> {
  const out: Record<Bucket, ConceptGroup[]> = { "cross-cohort": [], "single-cohort": [] };
  for (const g of groups) out[g.crossCohort ? "cross-cohort" : "single-cohort"].push(g);
  return out;
}

// --- the sort control ------------------------------------------------------------------------------------

/**
 * The orders a reviewer can choose between. Every one of them ENDS IN GROUP ID, so every one is total and
 * no reload can reorder the screen under someone who left mid-triage.
 */
export type SortKey = "verdict" | "breadth" | "size";

export const SORTS: { key: SortKey; label: string }[] = [
  { key: "verdict", label: "Flagged first" },
  { key: "breadth", label: "Most cohorts first" },
  { key: "size", label: "Most variables first" },
];

const byId = (a: ConceptGroup, b: ConceptGroup) => (a.groupId < b.groupId ? -1 : a.groupId > b.groupId ? 1 : 0);

export function sortGroupsBy(groups: readonly ConceptGroup[], key: SortKey): ConceptGroup[] {
  if (key === "verdict") return sortGroups(groups);
  if (key === "breadth") {
    return [...groups].sort((a, b) => b.cohorts.length - a.cohorts.length || b.nMembers - a.nMembers || byId(a, b));
  }
  return [...groups].sort((a, b) => b.nMembers - a.nMembers || b.cohorts.length - a.cohorts.length || byId(a, b));
}

// --- the filters -------------------------------------------------------------------------------------------

export interface LedgerFilters {
  /** Coherence states to keep. Empty means every state — an empty filter is not a filter. */
  verdicts: CoherenceState[];
  /** Cohorts a group must draw on at least one of. Empty means every cohort. */
  cohorts: string[];
  /** Only groups the reviewer has already decided something about. */
  touchedOnly: boolean;
  /** Only groups currently going forward. */
  inScopeOnly: boolean;
}

export const NO_FILTERS: LedgerFilters = { verdicts: [], cohorts: [], touchedOnly: false, inScopeOnly: false };

/** How many filters are on — what the toolbar reports, so "why is this empty" is answerable at a glance. */
export function activeFilterCount(f: LedgerFilters): number {
  return f.verdicts.length + f.cohorts.length + (f.touchedOnly ? 1 : 0) + (f.inScopeOnly ? 1 : 0);
}

/**
 * Narrow the visible set. The two reviewer-state predicates are INJECTED rather than read here, because
 * both are derived from persisted decisions and this module must stay free of the decision layer to stay
 * importable outside a bundle.
 */
export function applyFilters(
  groups: readonly ConceptGroup[],
  f: LedgerFilters,
  state: { isTouched: (groupId: string) => boolean; isInScope: (groupId: string) => boolean },
): ConceptGroup[] {
  return groups.filter((g) => {
    if (f.verdicts.length > 0 && !f.verdicts.includes(g.coherence)) return false;
    if (f.cohorts.length > 0 && !g.cohorts.some((c) => f.cohorts.includes(c))) return false;
    if (f.touchedOnly && !state.isTouched(g.groupId)) return false;
    if (f.inScopeOnly && !state.isInScope(g.groupId)) return false;
    return true;
  });
}

// --- the search --------------------------------------------------------------------------------------------

/**
 * THE TEXT A SEARCH TERM IS MATCHED AGAINST — and the honest limit of what this search is.
 *
 * IT IS NOT A SEMANTIC MATCH, AND MUST NOT CLAIM TO BE. The plan specified matching a term against each
 * group's embedding centroid, on the reasoning that the vectors are local work already done and therefore
 * free. **They are not on the wire.** `UIConceptGroup` carries no centroid and no embedding; `UIResult`'s
 * only geometry is `atlas`, which is a 2-D PCA projection of individual VARIABLES, is not a semantic index,
 * and is empty on a run paused at Gate 1 because it is built at the end of a run. Putting a vector on the
 * contract is a backend change, which this plan may not make.
 *
 * So the match is LEXICAL, over the text this client actually holds: the generated concept name, the ideal
 * description behind it, and the member variable names. The consequence is stated rather than hidden — the
 * search UI says it matches the text of each group, and never uses the word "semantic". A reviewer whose
 * clinical term is worded differently from the generated name may get a false coverage finding, which is
 * exactly why the finding's copy says "either the clustering never formed such a group, or no cohort in
 * this run measures it" rather than asserting the second.
 */
export function searchableText(group: ConceptGroup): string {
  return [group.concept, group.idealCde, ...group.memberVariableNames].join(" ").toLowerCase();
}

/** Word-ish tokens, so "BMI (kg/m²)" and "bmi" meet. */
function tokens(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/**
 * Match a LIST of terms against the groups, returning what matched and what did not.
 *
 * A TERM MATCHES A GROUP WHEN EVERY ONE OF ITS WORDS BEGINS A WORD in that group's text —
 * order-insensitive, so "pressure blood" and "blood pressure" find the same rows, and conjunctive, so
 * "blood pressure" does not match every group containing the word "blood".
 *
 * PREFIX, ADDED BY 08-14h — AND DELIBERATELY NOT STEMMING OR FUZZY MATCHING. The rule was whole-token and
 * exact, so "press" and "smok" returned nothing at all while "pressure" and "smoking" returned plenty,
 * which is the common way a reviewer's search silently failed. A prefix fixes that while keeping the
 * search PREDICTABLE — a reviewer can say in advance what it will do, and it finds a superset of the
 * exact rule rather than a different set. It is a prefix and not a substring for the same reason: an
 * interior match is not a rule anyone can hold in their head. Anything cleverer would start making the
 * semantic claim 08-15 removed.
 *
 * A TERM MATCHING NOTHING IS A COVERAGE FINDING, NOT AN EMPTY STATE. "No results" tells the reviewer their
 * search failed; "nothing in this run measures smoking" tells them something true about their corpus,
 * which is what they came to find out.
 */
export interface TermMatches {
  /** Groups matched by at least one term. */
  ids: Set<string>;
  /** Terms that matched no group at all. */
  noMatches: string[];
  /**
   * For each unmatched term, the words of it that appear NOWHERE in the run.
   *
   * THE HONEST DISCRIMINATOR the screen needs, and the only one a lexical match can offer. "Is this term
   * absent from my corpus, or did I mistype it?" is the question a reviewer asks when a search returns
   * nothing, and the two need opposite responses. The tool cannot read intent — but it can say which
   * words it could not find: a term whose EVERY word is missing is a coverage finding about the run,
   * while a term where one word landed and another did not ("smokng status") is a wording problem.
   *
   * This is a report, NOT a correction. No fuzzy matching, no suggestions, no did-you-mean — those would
   * be the tool claiming to know what was meant, which is the claim 08-15 removed.
   */
  missingTokens: Record<string, string[]>;
}

export function matchTerms(groups: readonly ConceptGroup[], terms: readonly string[]): TermMatches {
  // Both forms kept: the Set answers an exact hit in one step, and the list is what a prefix scan needs.
  const haystacks = groups.map((g) => {
    const list = tokens(searchableText(g));
    return { id: g.groupId, exact: new Set(list), list };
  });
  /** Does any word in this group BEGIN with `w`? */
  const present = (h: (typeof haystacks)[number], w: string): boolean =>
    h.exact.has(w) || h.list.some((t) => t.startsWith(w));
  const ids = new Set<string>();
  const noMatches: string[] = [];
  const missingTokens: Record<string, string[]> = {};
  for (const term of terms) {
    const wanted = tokens(term);
    if (wanted.length === 0) continue;
    const hits = haystacks.filter((h) => wanted.every((w) => present(h, w)));
    if (hits.length === 0) {
      noMatches.push(term);
      missingTokens[term] = wanted.filter((w) => !haystacks.some((h) => present(h, w)));
    }
    for (const h of hits) ids.add(h.id);
  }
  return { ids, noMatches, missingTokens };
}

// --- regrouping, and the one paid action on this screen ----------------------------------------------------

/**
 * The effective membership of every group AFTER the reviewer's moves.
 *
 * Regroup decisions are keyed on the VARIABLE MOVED (`gate1_regroup`'s identity field is `memberId`), so
 * the current grouping is the original one with those per-variable overrides applied. Computed rather than
 * stored, for the same reason the touched state is: a copy of the membership held in component state is
 * gone on reload, and R6 requires the correction to still be there.
 *
 * `moves` maps a member id to the group it now belongs to. `UNASSIGNED` is a real destination in that map,
 * not a sentinel to special-case at every call site.
 */
export function effectiveMembers(
  groups: readonly ConceptGroup[],
  membersByGroup: Record<string, string[]>,
  moves: Record<string, string>,
): { byGroup: Record<string, string[]>; unassigned: string[] } {
  const byGroup: Record<string, string[]> = {};
  const unassigned: string[] = [];
  for (const g of groups) byGroup[g.groupId] = [];
  for (const g of groups) {
    // The UNCAPPED list when the run carries one; the collapsed sample only as a last resort, and a move
    // written against a partial sample is exactly what T-08-89 forbids — which is why the expanded row
    // reads this and never `memberVariableNames` directly.
    for (const memberId of membersByGroup[g.groupId] ?? g.memberVariableNames) {
      const destination = moves[memberId] ?? g.groupId;
      if (destination in byGroup) byGroup[destination].push(memberId);
      else unassigned.push(memberId);
    }
  }
  return { byGroup, unassigned };
}

/**
 * The re-adjudication request for ONE accepted carve.
 *
 * A FUNCTION, RATHER THAN AN INLINE OBJECT LITERAL AT THE CALL SITE, because "exactly one id, never an
 * empty list, never everything flagged" is the prohibition this screen has to satisfy and an inline
 * literal is a prohibition asserted nowhere. Re-splitting every flagged group BECAUSE it was flagged is an
 * auto-resolution of an over-merge with no human decision behind it — core's own `readjudicate` docstring
 * forbids the pipeline from doing it, and the backend refuses an empty list for the same reason.
 */
export function readjudicationRequest(groupId: string): { groupIds: string[] } {
  const id = groupId.trim();
  if (!id) throw new Error("re-adjudication needs the id of the one group the reviewer accepted");
  return { groupIds: [id] };
}
