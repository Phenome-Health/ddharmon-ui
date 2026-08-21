/**
 * The declared score at Setup — components in, scope band out (08-13 Task 2).
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
