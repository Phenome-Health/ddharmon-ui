/**
 * The declared score — components in, scope band out.
 *
 * RE-SITED FROM SETUP TO GATE 1 (the 2026-08-25 amendment), and re-sited is the operative word: the
 * feasibility algebra below is unchanged, and `setupScopeVerdict` is kept rather than deleted so the
 * reasoning that produced it stays legible. What moved is the CONSUMER. Two independent reasons, both
 * already written into this file's original header:
 *
 *   1. Setup could read a document for free but not transcribe it, because transcription is a model call
 *      and Setup's standing promise is that nothing has been charged yet — so it ingested a 41,000-
 *      character paper and then asked the reviewer to type its components out by hand.
 *   2. Setup's verdict was UNANSWERABLE, not merely unknown: feasibility asks whether THIS RUN's concepts
 *      can supply the components, and at Setup there is no run. A band that can only ever say one thing
 *      is not a control.
 *
 * At Gate 1 the second reason dissolves — the run has happened and its concept groups exist — and a paid
 * call is unsurprising on a screen that is already a spend decision.
 *
 * WHY A SCORE IS *DECLARED* HERE AND NOT DERIVED. The composite builder is a thread through the six
 * screens rather than a gate, and it enters at Setup because reading a document needs only the document.
 * But core's pipeline splits into a free half and a paid half:
 *
 *   - reading the document                       $0  (`POST /api/harmonize/score/extract`, no run needed)
 *   - transcribing it into components      1 LLM call (`extract_score_definition`)
 *   - matching components onto concepts    1 LLM call (`match_components`, and it needs a finished run)
 *   - judging feasibility                        $0  (deterministic, but only once matches exist)
 *
 * Setup's standing promise is that nothing has been charged yet, so the paid transcription cannot run
 * here. What CAN: read the document for free, and let the reviewer state the components themselves — they
 * usually know the score they came for. Hence UI-SPEC §5.4's own name for the element, the "**declared**-
 * score scope band", and §8.4's "deriving a score needs an account": declaring is the free act.
 *
 * AND WHY ITS VERDICT IS ALWAYS INDETERMINATE. Feasibility asks whether THIS RUN's concepts can supply the
 * components. At Setup there is no run and therefore no concepts, so the question is not answerable — not
 * answered "no". Rendering "not computable" here would assert exactly what the standing prohibition
 * forbids: a negative claim where only positive-or-indeterminate is determinable.
 */

import type { ScoreSuggestions } from "@/types";

/** How Setup names the four feasibility states. Mirrors `backend/composite.py::presentation_verdict`. */
export type ScopeVerdict = "full" | "partial" | "infeasible" | "indeterminate";

/**
 * The components the reviewer declared, one per line.
 *
 * Blank lines are not components and neither is surrounding whitespace; duplicates collapse, because a
 * score does not have the same component twice and counting it twice would misstate the scope offered at
 * Gate 1. Order is preserved — it is the order the reviewer wrote, which is usually the paper's order.
 */
export function declaredComponents(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of (text ?? "").split(/\r?\n/)) {
    const name = raw.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/**
 * The feasibility verdict for a score declared at Setup.
 *
 * Unconditionally `indeterminate` when no run has produced concepts, which at Setup is always. Written as
 * a function taking the concept count rather than as a constant so the reason is in the code: it is
 * indeterminate BECAUSE there is nothing to match against, not because Setup is special. A caller that
 * one day has concepts gets a real verdict from `presentation_verdict` on the server instead.
 */
export function setupScopeVerdict(nConceptsAvailable: number): ScopeVerdict {
  return nConceptsAvailable > 0 ? "partial" : "indeterminate";
}

/**
 * The one-line claim beside the verdict. Never "not computable" for the indeterminate case.
 *
 * `indeterminate` says NOT MATCHED YET (live verify 3 F9). It used to say "this run has not produced any
 * concepts", which was Setup's reason and was false wherever the verdict is actually shown: Gate 1 renders it
 * beside hundreds of concept groups, and Gate 4 beside the final records. What is missing is the match.
 */
export const SCOPE_VERDICT_COPY: Record<ScopeVerdict, string> = {
  full: "Every required component is present in this run.",
  partial: "Some required components are present in this run; others are not.",
  infeasible: "Every required component was looked for in this run and none was found.",
  indeterminate:
    "Cannot be determined yet — these components have not been matched against this run's concepts, so " +
    "there is no evidence either way. It is not a finding that the score cannot be built.",
};

// --- the derived verdict, at a gate that has a run behind it ---------------------------------------------

/**
 * What this run knows about ONE declared component.
 *
 * `searched` IS SEPARATE FROM `matched`, and keeping them apart is the whole point of this shape. "We
 * looked and found nothing" and "we have not looked" are different facts, and only the first supports a
 * negative claim. A single boolean would collapse them and make every undeclared-yet component read as a
 * finding that the score cannot be built.
 */
export interface ComponentEvidence {
  name: string;
  /** Whether matching actually RAN for this component on this run. */
  searched: boolean;
  /** Whether it found a concept in this run that measures it. */
  matched: boolean;
  /**
   * How many candidate concepts retrieval offered and the judge rejected.
   *
   * Carried because "8 candidates were retrieved and none measures this" is DIFFERENT INFORMATION from
   * "nothing was retrieved": the first says the concepts exist and do not fit, the second is closer to
   * absence. Neither says the cohort lacks the measure — MISSING means "not retrieved in this run".
   */
  shortlistSize: number;
}

/** One component's own verdict. Absent evidence is `indeterminate`, never the negative claim. */
export function componentVerdictFor(e: ComponentEvidence): ScopeVerdict {
  if (!e.searched) return "indeterminate";
  return e.matched ? "full" : "infeasible";
}

/**
 * The whole score's verdict, DERIVED from the per-component evidence.
 *
 * `infeasible` requires that EVERY component was actually looked for and none was found. One component
 * still unsearched keeps the verdict at `indeterminate`, because a negative claim about a score is not
 * determinable while any part of it remains unchecked.
 */
export function scopeVerdictFor(evidence: readonly ComponentEvidence[]): ScopeVerdict {
  if (evidence.length === 0) return "indeterminate";
  const matched = evidence.filter((e) => e.matched).length;
  if (matched === evidence.length) return "full";
  if (matched > 0) return "partial";
  return evidence.every((e) => e.searched) ? "infeasible" : "indeterminate";
}

/**
 * Why a component has no match — and it is a RESULT, not a failure to hide.
 *
 * The two outcomes are worded differently on purpose (`pages/composite.tsx`'s first rule, which the
 * 2026-08-25 amendment did not carry across and which this restores). Neither ever says the cohort does
 * not measure the thing: what a run can report is what it retrieved, and "not retrieved in this run" is
 * the only claim the evidence supports.
 */
export function missingReason(e: ComponentEvidence): string {
  if (!e.searched) return "Not looked for yet on this run.";
  if (e.shortlistSize > 0) {
    return (
      `${e.shortlistSize} candidate concept${e.shortlistSize === 1 ? "" : "s"} from this run were ` +
      "retrieved and rejected — none of them measures this component. The concepts exist; they do not fit."
    );
  }
  return "Retrieval returned nothing for this component in this run. That is not a finding about your cohorts — it is what this run retrieved.";
}

/** The sentence that stops `partial` being read as a qualified yes. */
export const PARTIAL_IS_NOT_THE_SCORE =
  "Partial coverage is not the published score. Computing it from the components that are present would " +
  "produce a different measure with the same name.";

/**
 * What a score's coverage IS a statement about — and what it is not.
 *
 * `pages/composite.tsx:397-401`'s rule, restored here: presence is per DATA DICTIONARY. Participant-level
 * missingness, and therefore an effective N, cannot be derived from metadata, and ddharmon never computes
 * the score — the output is a recipe an analyst runs on their own rows.
 */
export const PRESENCE_IS_PER_DICTIONARY =
  "Presence is per data dictionary: it says the cohort records the variable, not how many participants " +
  "have a value for it. ddharmon produces the recipe; it never computes the score.";

/** Said where the source document stated no threshold. Never derived, never defaulted. */
export const CUTOFF_UNSTATED =
  "The source did not state a cutoff for this component. It is flagged for a human rather than filled in — " +
  "a score's threshold is a clinical claim, and inventing a plausible one is the most consequential thing " +
  "this panel could get wrong.";

/**
 * The cohorts a component match ACTUALLY covers — the single source of truth for coverage.
 *
 * Union coverage (08-25) is member-level: a component's `coverageMembers` maps each cohort to the
 * variable(s)/option(s) that actually matched, taken across every matched group. A cohort key with a
 * non-empty array is covered. The over-merge case this exists to fix (the "cataracts" bug): a matched
 * concept GROUP may span cohorts whose members did NOT match — its raw `cohorts` therefore over-claims,
 * while `coverageMembers` keys are honest. Every view (coverage table, found-component detail, Swap list)
 * reads THIS, so none can disagree with another.
 *
 * Back-compat: runs predating union coverage carry no `coverageMembers`, so we fall back to the legacy
 * `cohorts` (a missing component has neither, and correctly reports as covering nothing).
 */
export function coveredCohorts(m: {
  cohorts?: string[];
  coverageMembers?: Record<string, { variableId: string }[]> | null;
}): string[] {
  const cm = m.coverageMembers;
  if (cm) return Object.keys(cm).filter((c) => (cm[c]?.length ?? 0) > 0);
  return m.cohorts ?? [];
}

/**
 * The builder-level AUTO-SELECT threshold: a concept group whose aggregate confidence is at/above this is
 * checked in the score panel and seeded into Gate 1 scope (so it reaches Gate 2). Distinct from the core's
 * per-MEMBER 0.50 coverage floor.
 *
 * INTERNAL NOTE — NOT REVIEWER COPY (final review round 1, item 3): 0.80 is NOT TUNED. Tuning it against the
 * 49-item UKBB frailty-index benchmark is a filed todo. Bhargav asked for this caveat to live here rather than on
 * the score builder, which used to print "Provisional — to be tuned against the 49×UKBB FI benchmark".
 * `tests/e2e/score-auto-select.spec.ts` pins that the RULE works (the selection moves with the threshold); what is
 * unproven is only whether 0.80 is the right value.
 */
export const GROUP_SELECT_THRESHOLD = 0.8;

/**
 * The concept groups a component match OFFERS, one per judge-affirmed group.
 *
 * Back-compat: a spec from before variable-only matching carries only `conceptId` (no `groupCandidates`),
 * so that concept is treated as its one group — a matched component never reads as offering nothing.
 */
export function offeredGroups(m: {
  conceptId: string | null;
  confidence: number;
  groupCandidates?: { groupId: string; confidence: number; nMatched?: number; nTotal?: number }[];
}): { groupId: string; confidence: number; nMatched?: number; nTotal?: number }[] {
  if (m.groupCandidates?.length) return m.groupCandidates;
  return m.conceptId ? [{ groupId: m.conceptId, confidence: m.confidence }] : [];
}

/**
 * groupId → the components whose score match AUTO-SELECTS it (confidence ≥ `threshold`, default
 * `GROUP_SELECT_THRESHOLD`).
 *
 * THE ONE RULE for "the score builder put this group in scope". Gate 1's scope default and the score panel's
 * initial check state both read it, so the panel's "Gate 2 ✓" can never name a group Gate 2 does not get.
 * An explicit `gate1_group_scope` decision still overrides it, in either place.
 *
 * `threshold` is a parameter so the rule can be PROVED to move with it (final review round 1 asked whether the
 * threshold is functional at all); the product passes nothing and gets the one builder-level value.
 */
export function scoreSeededGroups(
  matches: readonly (Parameters<typeof offeredGroups>[0] & { component: string })[],
  threshold: number = GROUP_SELECT_THRESHOLD,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const m of matches) {
    for (const g of offeredGroups(m)) {
      if (g.confidence < threshold) continue;
      const arr = out.get(g.groupId) ?? [];
      if (!arr.includes(m.component)) arr.push(m.component);
      out.set(g.groupId, arr);
    }
  }
  return out;
}

// --- Gate 1's free SUGGESTIONS: the same rule, fed by the retrieval half (08-28 Decision 6) ---------------------

/** A component's score evidence in the one shape the scope rule reads — a Gate 4 match, or a suggestion. */
export type ScoreScopeMatch = Parameters<typeof offeredGroups>[0] & { component: string };

/**
 * What a suggestion tag says (its title, and the panel's note). Two claims, both load-bearing: it came from a FREE
 * search (retrieval only, no model call, nothing billed), and it is NOT the verdict — the verdict is the paid match
 * on Gate 4, which is the only thing that ever says a group measures a component.
 */
export const SUGGESTION_TAG_COPY = "Suggested by your score — a free search; the verdict is on Gate 4";

/**
 * Gate 1's suggestions as score evidence: one entry per declared component, OFFERING only the groups whose
 * best-member cosine clears the payload's OWN cut-off (`threshold`, core's calibrated value — never a copy kept
 * here, and never the judge's 0.80, which is a different scale).
 *
 * Filtered HERE, so "offered" means "suggested" for a suggestion: the tag map (every offered group) and the seed
 * (`scoreSeededGroups` at the same cut-off) then name exactly the same groups, and a group below the cut-off is
 * neither tagged nor seeded. `scored: false` (no dense encoder) offers nothing — a lexical score is not comparable
 * across components and is never thresholded in its place.
 */
export function suggestionMatches(s: ScoreSuggestions | null | undefined): ScoreScopeMatch[] {
  if (!s?.scored) return [];
  const out: ScoreScopeMatch[] = [];
  for (const score of s.scores ?? []) {
    for (const c of score.components ?? []) {
      const groups = (c.groups ?? []).filter((g) => g.score >= s.threshold);
      if (groups.length === 0) continue;
      out.push({
        component: c.component,
        conceptId: null,
        confidence: groups[0]!.score,
        groupCandidates: groups.map((g) => ({ groupId: g.groupId, confidence: g.score })),
      });
    }
  }
  return out;
}

/**
 * THE ONE INPUT to Gate 1's score-seeded scope and tags: the Gate 4 match when the run has one (the latest derived
 * spec — a verdict), else Gate 1's free suggestions, else nothing. Never a blend: once a match exists it is the
 * evidence, and a free search is not consulted beside it.
 *
 * `threshold` travels with `matches` because the two sources are on different scales — the judge's group
 * confidence (`GROUP_SELECT_THRESHOLD`) and the free search's cosine (the payload's own cut-off) — and both go
 * through the SAME `scoreSeededGroups` rule.
 */
export function scoreScopeInput(
  spec: { matches: readonly ScoreScopeMatch[] } | null | undefined,
  suggestions: ScoreSuggestions | null | undefined,
): { source: "match" | "suggestion" | "none"; matches: readonly ScoreScopeMatch[]; threshold: number } {
  if (spec) return { source: "match", matches: spec.matches ?? [], threshold: GROUP_SELECT_THRESHOLD };
  const matches = suggestionMatches(suggestions);
  if (matches.length > 0) return { source: "suggestion", matches, threshold: suggestions!.threshold };
  return { source: "none", matches: [], threshold: GROUP_SELECT_THRESHOLD };
}

/**
 * groupId → the component(s) whose evidence OFFERS it — the queue's tag (and pin-to-top) map. Every offered group is
 * tagged; only the auto-selected subset (`scoreSeededGroups`) starts in scope. For a suggestion the two coincide
 * (see `suggestionMatches`).
 */
export function scoreTaggedGroups(matches: readonly ScoreScopeMatch[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const m of matches) {
    for (const g of offeredGroups(m)) {
      const arr = out.get(g.groupId) ?? [];
      if (!arr.includes(m.component)) arr.push(m.component);
      out.set(g.groupId, arr);
    }
  }
  return out;
}
