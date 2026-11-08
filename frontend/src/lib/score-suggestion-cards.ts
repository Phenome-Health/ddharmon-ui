/**
 * Gate 1's score CARDS from the free search (08-28, option A — "what happened to the old score builder look?").
 *
 * The builder's per-component cards only ever drew from the PAID match, and decision Q5 moved that match to Gate 4 —
 * so a live Gate 1 lost them. This is the scoping half of the old card, fed by what Gate 1 does have: the free
 * suggestions (`GET /jobs/{id}/score/suggestions`, retrieval only, $0).
 *
 * ONE CARD PER DECLARED COMPONENT, IN DECLARED ORDER — the order the reviewer (or the paper) gave, never re-sorted by
 * how well a component was found. Its groups are EVERY group the search reached, best-first, each flagged against
 * its list's cut-off (the reviewer's for that list, else the payload's own): the ones at or above it are what seeds
 * scope (`suggestionMatches`); the ones below are listed so the reviewer can catch a miss, and this list never tags or
 * seeds them (another list's concept may, at its own cut-off).
 *
 * `best` is the top group's similarity — a dense cosine, NOT the judge's confidence. The card labels it so and never
 * puts it in the judge's "mean best / cohort" slot: the two are different scales.
 */

import type { ScoreSuggestions } from "@/types";

export interface SuggestionCardGroup {
  groupId: string;
  /** The dense cosine of the group's best-matching member. */
  score: number;
  bestMember: string;
  bestOption?: string;
  /** At or above the payload's cut-off — what seeds scope and earns the queue's "Suggested" tag. */
  suggested: boolean;
}

export interface SuggestionCard {
  component: string;
  /** Every group the free search reached for this component, best-first. */
  groups: SuggestionCardGroup[];
  /** The top group's similarity, or null when the search reached nothing. */
  best: number | null;
  nSuggested: number;
}

/**
 * WHY a group is in Gate 1's scope — the reviewer chose it, made it, or a score suggestion seeded it (and for which
 * components) — so a card can say why a group it did not suggest is in scope.
 */
export interface GroupScopeWhy {
  /** `auto`: Full auto sent it (a Gate 1 Full auto committed) — never the reviewer's choice. */
  by: "chosen" | "made" | "score" | "auto" | "none";
  /** For `score`: the components whose suggestion seeded it. */
  components: string[];
}

/**
 * Whether an in-scope group COUNTS toward this card's spread: only when it was suggested for THIS component.
 *
 * Scope is one set for the whole gate, and the free search reaches ~8 groups per component — so counting every
 * reached group that is in scope made a card read "7 in scope" when 2 were its own (live rig, iteration 7,
 * 2026-10-02). Counting the reviewer's explicit picks did not fix it: a driver's (or a bulk include's) explicit
 * decisions cover groups no card suggested. So the spread is "this component's suggestions you kept"; every other
 * in-scope row stays checked and says why (`GroupScopeWhy`).
 */
export function countsForCard(g: SuggestionCardGroup, inScope: boolean): boolean {
  return inScope && g.suggested;
}

/**
 * The cohorts a card's COUNTED groups hold (`countsForCard`), in first-appearance order — group membership, not a
 * match. The card's spread and the reached-by-search table both read this, so the two cannot disagree.
 */
export function keptCohorts(
  card: SuggestionCard,
  cohortsOf: (groupId: string) => readonly string[] | undefined,
  inScope: (groupId: string) => boolean,
): string[] {
  const out: string[] = [];
  for (const g of card.groups) {
    if (!countsForCard(g, inScope(g.groupId))) continue;
    for (const c of cohortsOf(g.groupId) ?? []) if (!out.includes(c)) out.push(c);
  }
  return out;
}

export interface SearchCoverage {
  /** The columns: the run's roster, then any reached cohort the roster does not name (never silently dropped). */
  cohorts: string[];
  /** One row per card, in declared order; `reached` in column order. */
  rows: { component: string; reached: string[] }[];
  /** Per cohort, how many components the search reached in it. */
  reachedPerCohort: Record<string, number>;
}

/**
 * Gate 1's per-cohort table, REACHED BY SEARCH (review round 6 note L7, option (b)): each card's `keptCohorts`, laid
 * out against the run's cohorts.
 *
 * Gate 1 has no match, so a mark says only that the free search REACHED the cohort — a suggested group kept in scope
 * holds one of its variables. A blank is what this search reached at the cut-off, never a finding that the cohort
 * lacks the component; Gate 4's match, with its own full table, is where presence is decided.
 */
export function searchCoverage(
  cards: readonly SuggestionCard[],
  roster: readonly string[],
  cohortsOf: (groupId: string) => readonly string[] | undefined,
  inScope: (groupId: string) => boolean,
): SearchCoverage {
  const kept = cards.map((card) => ({ component: card.component, cohorts: keptCohorts(card, cohortsOf, inScope) }));
  const cohorts = [...roster];
  for (const k of kept) for (const c of k.cohorts) if (!cohorts.includes(c)) cohorts.push(c);
  const rows = kept.map((k) => ({ component: k.component, reached: cohorts.filter((c) => k.cohorts.includes(c)) }));
  const reachedPerCohort = Object.fromEntries(
    cohorts.map((c) => [c, rows.filter((r) => r.reached.includes(c)).length]),
  );
  return { cohorts, rows, reachedPerCohort };
}

/**
 * The cards for `declared`, or `[]` when there is nothing to draw them from — no dense score (`scored: false`: a
 * lexical score is never thresholded or shown in its place) or no score searched for at all. `[]` means the panel
 * keeps its plain declared list.
 *
 * Component names are matched case-insensitively, as a declaration dedupes them. A group reached twice for one
 * component keeps its better score.
 */
export function suggestionCards(
  declared: readonly string[],
  s: ScoreSuggestions | null | undefined,
  /**
   * The cut-off these concepts are split at — their Spotlight LIST's own (`gate1_score_cutoff`, one per list since
   * 2026-11-08), so a panel asks once per list. Absent → the payload's own threshold.
   */
  cutoff?: number,
): SuggestionCard[] {
  if (!s?.scored || !(s.scores?.length)) return [];
  const byComponent = new Map<string, Map<string, Omit<SuggestionCardGroup, "suggested">>>();
  for (const score of s.scores) {
    for (const c of score.components ?? []) {
      const key = c.component.trim().toLowerCase();
      const groups = byComponent.get(key) ?? new Map();
      for (const g of c.groups ?? []) {
        const seen = groups.get(g.groupId);
        if (!seen || g.score > seen.score) groups.set(g.groupId, g);
      }
      byComponent.set(key, groups);
    }
  }
  return declared.map((component) => {
    const groups = [...(byComponent.get(component.trim().toLowerCase())?.values() ?? [])]
      .sort((a, b) => b.score - a.score)
      .map((g) => ({ ...g, suggested: g.score >= (cutoff ?? s.threshold) }));
    return {
      component,
      groups,
      best: groups[0]?.score ?? null,
      nSuggested: groups.filter((g) => g.suggested).length,
    };
  });
}
