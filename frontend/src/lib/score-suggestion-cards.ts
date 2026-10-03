/**
 * Gate 1's score CARDS from the free search (08-28, option A — "what happened to the old score builder look?").
 *
 * The builder's per-component cards only ever drew from the PAID match, and decision Q5 moved that match to Gate 4 —
 * so a live Gate 1 lost them. This is the scoping half of the old card, fed by what Gate 1 does have: the free
 * suggestions (`GET /jobs/{id}/score/suggestions`, retrieval only, $0).
 *
 * ONE CARD PER DECLARED COMPONENT, IN DECLARED ORDER — the order the reviewer (or the paper) gave, never re-sorted by
 * how well a component was found. Its groups are EVERY group the search reached, best-first, each flagged against
 * the payload's OWN cut-off: the ones at or above it are what seeds scope (`suggestionMatches`); the ones below are
 * listed so the reviewer can catch a miss, and are never tagged or seeded.
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
  by: "chosen" | "made" | "score" | "none";
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
      .map((g) => ({ ...g, suggested: g.score >= s.threshold }));
    return {
      component,
      groups,
      best: groups[0]?.score ?? null,
      nSuggested: groups.filter((g) => g.suggested).length,
    };
  });
}
