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

/** The one-line claim beside the verdict. Never "not computable" for the indeterminate case. */
export const SCOPE_VERDICT_COPY: Record<ScopeVerdict, string> = {
  full: "Every required component is present in this run.",
  partial: "Some required components are present in this run; others are not.",
  infeasible: "Every required component was looked for in this run and none was found.",
  indeterminate:
    "Cannot be determined yet — this run has not produced any concepts, so there is nothing to match " +
    "these components against. It is not a finding that the score cannot be built.",
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
