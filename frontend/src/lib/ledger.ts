import type { CoherenceState, ConceptGroup } from "@/types";
import type { ColumnSort } from "@/lib/column-sort";

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

// --- the id tiebreak ---------------------------------------------------------------------------------------

/**
 * The LAST component of every order on this screen, and the reason each of them is TOTAL: no two rows can
 * tie, so a reload cannot reorder the ledger under a reviewer who left mid-triage. `compareGroups` states
 * the guarantee; this is the shared expression `sortGroupsByColumn` tiebreaks on.
 */
const byId = (a: ConceptGroup, b: ConceptGroup) => (a.groupId < b.groupId ? -1 : a.groupId > b.groupId ? 1 : 0);

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
export function searchableText(group: ConceptGroup, renamedTo?: string | null): string {
  // A BORROWED LABEL IS SEARCHABLE, a hidden one is not (08-16c Task 1). The search tells the reviewer it
  // matches the text of each group, so the words they can SEE on a row have to be among them — otherwise
  // typing a group's own visible label fails to find it. The judge sentence joins only when it is the
  // label; on a group that has a generated name the summary is not on screen, and matching invisible text
  // would break the same promise from the other side.
  const label = groupLabel(group, renamedTo);
  // A borrowed OR reviewer-given label is searchable, for the same reason: the words on screen must be
  // findable. The generated name stays searchable too even when a rename hides it — a reviewer who
  // renamed a group has not forgotten what the pipeline called it, and may well search for that.
  const shown = label.source === "judge" || label.source === "reviewer" ? label.text : "";
  return [group.concept, shown, group.idealCde, ...group.memberVariableNames].join(" ").toLowerCase();
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

export function matchTerms(
  groups: readonly ConceptGroup[],
  terms: readonly string[],
  /** The reviewer's name for a group, so a renamed group is findable by the name they gave it. */
  renamedOf?: (groupId: string) => string | undefined,
): TermMatches {
  // Both forms kept: the Set answers an exact hit in one step, and the list is what a prefix scan needs.
  const haystacks = groups.map((g) => {
    const list = tokens(searchableText(g, renamedOf?.(g.groupId)));
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
  const known = new Set<string>();
  for (const g of groups) byGroup[g.groupId] = [];
  for (const g of groups) {
    // The UNCAPPED list when the run carries one; the collapsed sample only as a last resort, and a move
    // written against a partial sample is exactly what T-08-89 forbids — which is why the expanded row
    // reads this and never `memberVariableNames` directly.
    for (const memberId of membersByGroup[g.groupId] ?? g.memberVariableNames) {
      known.add(memberId);
      const destination = moves[memberId] ?? g.groupId;
      if (destination in byGroup) byGroup[destination].push(memberId);
      else unassigned.push(memberId);
    }
  }
  /**
   * VARIABLES THAT BELONG TO NO GROUP AT ALL, placed by the reviewer (08-16c review).
   *
   * The clustering's own leftovers (`result.unassignedFields`) are in no group's membership, so the loops
   * above cannot see them — before the pool centralised them they were unreachable on any run that
   * produced groups, and a drag from the pool into a group would have recorded a decision that changed
   * nothing on screen. A silent no-op is worse than a withheld verb.
   *
   * A SECOND PASS, so it can never shadow a real member: anything the loops already accounted for is
   * skipped. And only into a REAL group — a leftover "moved" to the pool is already where it is, and
   * pushing it onto `unassigned` here would list it twice, once from each source.
   */
  for (const [memberId, destination] of Object.entries(moves)) {
    if (known.has(memberId)) continue;
    if (destination in byGroup) byGroup[destination].push(memberId);
  }
  return { byGroup, unassigned };
}

/**
 * The clustering's OWN leftovers that are still unplaced — the pipeline half of the pool (08-16c review).
 *
 * A field the reviewer has since dragged into a real group is NOT unplaced any more and must stop being
 * listed, or the pool would report it in two places at once. A field moved to the POOL is a no-op: that is
 * where it already was, and treating it as a placement would silently drop it from the only list it has.
 *
 * Pure, and separate from `effectiveMembers`, because the two answer different questions: that one is
 * about group membership, this one is about a list the run shipped. Folding them together would make the
 * membership function depend on a field it has no other reason to know about.
 */
export function unplacedFields<T extends { cohort: string; variable: string }>(
  fields: readonly T[],
  moves: Record<string, string>,
  /** The ids of the run's real groups — the only destinations that count as a placement. */
  groupIds: readonly string[],
): T[] {
  const real = new Set(groupIds);
  return fields.filter((f) => !real.has(moves[`${f.cohort}:${f.variable}`] ?? ""));
}

/**
 * The destination tray's order: the groups the REVIEWER has most recently moved a variable into, first
 * (08-16c review).
 *
 * Bhargav: *"these should be ordered by 'most recently added to' groups at the top."* Carving one concept
 * out of a fused group means going back to the same destination several times in a row, and having it
 * scroll away between drops is the friction he is naming.
 *
 * RECENCY OF THE REVIEWER'S OWN MOVES, not of anything the pipeline did — so the key is the DESTINATION of
 * a `gate1_regroup` decision. A move OUT of a group is therefore not a move INTO it and cannot promote the
 * group it left, which falls out of the shape rather than needing a rule.
 *
 * WHERE THE TIME COMES FROM, stated because it is not what it looks like. The persisted decision did NOT
 * carry a timestamp: `use-gate-decisions` writes `{...fields, ...extra, chosen, alternatives,
 * optionSetKey}`, and the server's own `updatedAt` is explicitly NOT served back on read (see the conflict
 * type's docstring — which is why a first write after a reload always looks blind). So `moveMember` now
 * records `movedAt` through `extra`, which rides in the payload and comes back with it. That is what makes
 * this order DERIVED from persisted decisions rather than remembered in component state — R6, and the same
 * rule that shaped Task 7. An order held in `useState` is gone on reload, which is exactly when a reviewer
 * returning to finish would want it.
 *
 * A DECISION WRITTEN BEFORE THIS EXISTED HAS NO `movedAt`, and is treated as no recency at all rather than
 * as time zero being meaningful. It falls back into the caller's order.
 *
 * THE FALLBACK IS THE CALLER'S ORDER, kept by a STABLE sort (guaranteed since ES2019). The tray is handed
 * the visible ledger order, so a group nobody has moved into sits exactly where the ledger put it — this
 * re-ranks the touched groups and leaves every other row's position alone.
 */
export function sortDestinations(
  groups: readonly ConceptGroup[],
  /** Destination group id → when the reviewer last moved something into it. Absent means never. */
  lastMovedInto: Record<string, number>,
): ConceptGroup[] {
  return [...groups].sort((a, b) => (lastMovedInto[b.groupId] ?? 0) - (lastMovedInto[a.groupId] ?? 0));
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

/**
 * The run's cohort ROSTER — the denominator the coverage column measures each group against (08-16c Task 9).
 *
 * WHY IT IS NOT JUST `summary.cohorts`. On the run Bhargav walked on 2026-09-01 (`890638d1`, parked at
 * Gate 1) `result.summary.cohorts` is `[]` while `result.conceptGroups` has 117 entries and the first
 * group's `cohorts` is `["aou"]` — so the per-group data is complete and only the run-level roster is
 * missing. `CohortCoverage` maps over the roster to draw its segments, so an empty roster draws NOTHING
 * and the whole column reads as blank. `summary.nRecords` is `0` on the same checkpoint, which suggests
 * the summary is simply not finished at a Gate 1 park rather than that the run has no cohorts.
 *
 * ONE ANSWER WITH A STATED PRECEDENCE, not two. The summary wins whenever it is non-empty — it is the
 * run's own statement of what it loaded, and it can legitimately name a cohort that contributed no group,
 * which a union over groups can never discover. The union is the FALLBACK, and it is only ever reached
 * when the alternative is an empty column. Returned verbatim in the summary case so a run that does fill
 * the field keeps exactly the order and contents it had.
 *
 * THIS IS NOT THE `crossCohort` MISTAKE. That rule forbids RE-DERIVING a per-group answer the backend
 * already gives. Here the backend gives nothing, and the question is run-level.
 *
 * Sorted in the derived case because the union of a `Set` follows first-encounter order, which changes
 * with the group order — and the roster is a column's axis, so it has to be stable across renders and
 * identical for every row.
 *
 * The precedent is prod's own Review queue: `dashboard.tsx` builds `headerCohorts` this way and has all
 * along.
 */
export function cohortRoster(
  summaryCohorts: readonly string[] | null | undefined,
  groups: readonly { cohorts?: readonly string[] | null }[],
): string[] {
  if (summaryCohorts && summaryCohorts.length > 0) return [...summaryCohorts];
  return [...new Set(groups.flatMap((g) => g.cohorts ?? []))].sort();
}

/** Where a group's displayed label came from — the distinction Tasks 1 and 3 exist to keep visible. */
export type GroupLabelSource = "reviewer" | "generated" | "judge" | "none";

/**
 * The label a group's row shows, and — inseparably — WHERE IT CAME FROM (08-16c Task 1).
 *
 * Bhargav asked for this: *"if we have a summary from the judge as to what's in the group, can't we make
 * it the group name instead of leaving it unnamed?"* The data is already in the browser —
 * `coherenceSummary` rides the wire from core's `coherence_summary` — so this is a labelling decision,
 * not a retrieval one.
 *
 * THE SOURCE IS RETURNED, NOT INFERRED BY THE CALLER, because the honesty constraint is the whole
 * difficulty. `coherenceSummary` is the judge's theme sentence for the group's CORE — a medoid sample,
 * not the whole group — so presenting it as the name the pipeline generated would be a derived value
 * passing as a produced one, which this phase has refused repeatedly. The caller gets the text and the
 * provenance together so it cannot render one without the other, and nothing here writes into `concept`.
 *
 * THREE STATES, NOT TWO. `coherenceSummary` is `""` when the group was never judged, which is distinct
 * from "judged, and the judge said nothing". Only a JUDGED group can lend its sentence, so the
 * `not_judged` case is excluded explicitly rather than falling out of the emptiness check — the two
 * reach the same label by different routes and collapsing them would hide that.
 */
export function groupLabel(
  group: ConceptGroup,
  /** The reviewer's own name for this group, if they have given it one (08-16c Task 3). */
  renamedTo?: string | null,
): { text: string; source: GroupLabelSource } {
  // THE REVIEWER'S NAME OUTRANKS EVERYTHING, including a generated one — that is the whole point of
  // renaming: they are naming it to find it again. It does not overwrite `concept`; the generated name
  // stays on the run result and is recoverable beside this one.
  const renamed = (renamedTo ?? "").trim();
  if (renamed) return { text: renamed, source: "reviewer" };
  if (group.concept) return { text: group.concept, source: "generated" };
  // An over-merged group often has no `concept` but does carry a generated `idealCde` — a far cleaner name
  // than the coherence-axis summary below it (which describes the SPLIT, not the group). Prefer it, so an
  // unnamed group reads "Bone fracture or break history…", never a raw id or a split-axis sentence.
  const ideal = (group.idealCde ?? "").trim();
  if (ideal) return { text: ideal, source: "generated" };
  const judged = group.coherence !== "not_judged";
  const summary = (group.coherenceSummary ?? "").trim();
  if (judged && summary) return { text: summary, source: "judge" };
  return { text: "Unnamed group", source: "none" };
}

/** What a bulk scope action would do: which decisions to clear, and which to write OUT. */
export interface BulkScopePlan {
  clear: string[];
  write: string[];
}

/**
 * Plan a bulk scope change — the two traps of "select all / deselect all" (08-16c Task 7).
 *
 * Bhargav: *"need select all/deselect all option. too many checkboxes to do manually."*
 *
 * TRAP ONE — IN IS THE DEFAULT, SO "ALL IN" MOSTLY MEANS *CLEAR*. `isInScope` is
 * `decisions[id]?.chosen !== "out"`, so a group with NO decision is already in scope, and `isChanged` is
 * `id in scope.decisions`. Writing `"in"` to every group would therefore mark every one of them as
 * reviewer-changed and hand back a ledger claiming the reviewer had been through all 117 by hand. So the
 * restore-to-default direction CLEARS, and only where a departure exists to undo.
 *
 * TRAP TWO — MINIMAL CHANGE. Only groups whose effective scope actually differs from the target are
 * touched. A group already out is not re-written when deselecting, and a group already in — whether by
 * default or by an explicit earlier decision — is left exactly as the reviewer left it when selecting.
 * That keeps `isChanged` reporting departures rather than reporting that a button was pressed, and it
 * makes the request count proportional to the real change rather than to the corpus.
 *
 * IDS ARE THE CALLER'S *VISIBLE* ROWS, never the whole corpus: a reviewer who has filtered to a bucket
 * and presses "select all" means the bucket. The caller states the count on the control so the number is
 * on screen before the press, not discovered after it.
 */
export function bulkScopePlan(
  ids: readonly string[],
  target: "in" | "out",
  isInScope: (groupId: string) => boolean,
  hasDecision: (groupId: string) => boolean,
): BulkScopePlan {
  if (target === "in") {
    // Only an explicit "out" needs undoing. Absent decision = already in; explicit "in" = already in, and
    // clearing it would erase a mark the reviewer deliberately made.
    return { clear: ids.filter((id) => hasDecision(id) && !isInScope(id)), write: [] };
  }
  return { clear: [], write: ids.filter((id) => isInScope(id)) };
}

/** Whether every, no, or only some of `ids` are in scope — so a bulk control can show a real tri-state. */
export function bulkScopeState(
  ids: readonly string[],
  isInScope: (groupId: string) => boolean,
): "all" | "none" | "some" {
  if (ids.length === 0) return "none";
  let inCount = 0;
  for (const id of ids) if (isInScope(id)) inCount++;
  if (inCount === ids.length) return "all";
  if (inCount === 0) return "none";
  return "some";
}

/** The ledger columns a reviewer can sort by. "Gate 2+" is absent deliberately — see `sortGroupsByColumn`. */
export type LedgerSortKey = "concept" | "verdict" | "cohorts" | "vars";

/**
 * Sort the ledger by a CLICKED COLUMN (08-16c Task 10).
 *
 * `null` KEEPS THE LEDGER'S OWN ORDER. The default — verdict, then cohort breadth, then size, then id —
 * is deliberate and documented on `compareGroups`, and click-to-sort is something the reviewer opts into
 * ON TOP of it, never a replacement that arrives by default.
 *
 * SORTS BY MEANING, NOT BY RENDERED STRING, which is `sortValue`'s discipline on the Review queue and the
 * reason this is not a generic table sort:
 *   - `verdict` orders by REVIEW PRIORITY (`COHERENCE_ORDER`: split, qualify, not judged, single), not
 *     alphabetically — "qualify" before "single" is a triage claim, not a lexical accident.
 *   - `cohorts` orders by BREADTH (the count), because the column's subject is how widely a group pools;
 *     ordering it by the joined cohort names would sort "aou,clsa" above "ukbb" and mean nothing.
 *   - `concept` uses the DISPLAYED label via `groupLabel`, so a row showing a borrowed judge sentence
 *     sorts where the reviewer can see it rather than under an empty string.
 *   - a group with no label sorts LAST in either direction's natural reading rather than landing in the
 *     middle as an empty string would.
 *
 * "Gate 2+" IS NOT SORTABLE and that is not an oversight: every row's figure is the same per-group price,
 * so the column has exactly one value and a sort on it would be a control that visibly does nothing.
 *
 * THE ORDER STAYS TOTAL. Every branch tiebreaks down to the group id, so no two rows can tie and a reload
 * cannot reorder the screen under a reviewer who left mid-triage — the guarantee `compareGroups` records.
 *
 * THIS IS NOW THE ONLY WAY TO REORDER THE LEDGER, and the ORDER SELECT THAT SAT BESIDE IT IS GONE —
 * Bhargav, reviewing Gate 1: *"concept groups are sortable below so this is redundant."* Task 10 shipped
 * the select alongside the headers and left "does it survive?" as an open call; this is that call, made.
 *
 * NOTHING WAS ORPHANED, which is the check that had to pass before the control could go. Each of its three
 * presets is still reachable: "Flagged first" is `verdict` ascending AND the `null` default below, "Most
 * cohorts first" is `cohorts` descending, "Most variables first" is `vars` descending — every one of them
 * a header the reviewer can click. What went with it is the second writer of a single state, and the
 * disabled "Sorted by a column" placeholder that existed only so the select could not misreport what the
 * ledger was actually doing. Do not reintroduce it: a preset list is a second name for these four columns.
 */
export function sortGroupsByColumn(
  groups: readonly ConceptGroup[],
  sort: ColumnSort<LedgerSortKey> | null,
  /** The reviewer's name for a group, so the Concept column sorts by what is ON SCREEN (08-16c Task 3). */
  renamedOf?: (groupId: string) => string | undefined,
): ConceptGroup[] {
  if (!sort) return sortGroups(groups);
  const sign = sort.dir === "asc" ? 1 : -1;
  const value = (g: ConceptGroup): string | number => {
    switch (sort.key) {
      case "concept": {
        const l = groupLabel(g, renamedOf?.(g.groupId));
        // An unnamed group has no label to compare; push it to the end rather than to the middle.
        return l.source === "none" ? "￿" : l.text.toLowerCase();
      }
      case "verdict":
        return COHERENCE_ORDER[g.coherence] ?? 9;
      case "cohorts":
        return g.cohorts.length;
      case "vars":
        return g.nMembers;
    }
  };
  return [...groups].sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    const c =
      typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb));
    return sign * c || byId(a, b);
  });
}
