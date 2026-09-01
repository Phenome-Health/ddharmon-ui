// The algebra behind Gate 2 (concepts to elements) and Gate 3 (transform specs).
//
// WHY A LIB RATHER THAN LOGIC IN THE PAGES. The same reason `lib/ledger.ts` exists for Gate 1: these are
// CLASSIFICATIONS, and a classification asserted through a rendered DOM is asserted twice — once for the
// rule and once for the markup — so a copy change breaks a logic test. Everything here is pure and is
// asserted in node from `tests/e2e/gate23.spec.ts`.
//
// THE ONE RULE THAT MATTERS MOST IN THIS FILE. Three of these functions exist to keep two states apart
// that a naive render would fuse, and in every case fusing them makes the tool CLAIM something it does not
// know:
//
//   - `candidateListState`  — "retrieval ran and nothing fit" vs "we never got an answer".
//   - `specState`           — "nothing needed changing" vs "we tried and failed" vs "we never tried".
//   - `conceptMatchState`   — "the check passed" vs "this run did not buy the check".
//
// Each pair renders identically if you only test for emptiness, and each wrong reading is the tool
// vouching for something no stage ever looked at.

import type { UICandidate, UIRecord, UITransform } from "@/types";

// --- Gate 2: what a concept's candidate list actually means --------------------------------------------

/**
 * `ranked`  — candidates were retrieved; the reviewer picks among them.
 * `novel`   — retrieval ran, nothing cleared the floor, and the pipeline said so by routing the concept to
 *             the novel path. An ASSESSED absence.
 * `failed`  — no candidates AND no assessment. The pipeline never reached a verdict for this concept, so
 *             the one thing the screen must not do is render it as "no match exists".
 *
 * THE CONTRACT CARRIES NO PER-RECORD FAILURE FLAG, and this function is deliberately derived rather than
 * waiting for one. `batch_reconcile` knows about a failed retrieval at the level of a whole batch TAG, not
 * a record, so there is nothing on the wire to read. What IS on the wire is whether the pipeline reached a
 * verdict: a novel is a decision (`verdict: "novel"`, usually with a generated element attached), and
 * `unclassified` with nothing retrieved is the absence of one. Deriving the distinction from the
 * assessment rather than inventing a field keeps this readable against runs that already exist.
 */
export type CandidateListState = "ranked" | "novel" | "failed";

export function candidateListState(record: Pick<UIRecord, "candidates" | "verdict" | "gencde">): CandidateListState {
  if ((record.candidates?.length ?? 0) > 0) return "ranked";
  if (record.verdict === "novel" || record.gencde) return "novel";
  return "failed";
}

/**
 * Whether a lone candidate may be treated as settled.
 *
 * ALWAYS FALSE, and the function exists to make that a stated rule rather than an omission. "There is only
 * one option" is not evidence that the option is right — the adopt floor exists precisely because a single
 * far-cosine retrieval is the case most likely to be wrong, and auto-adopting it would launder a weak
 * retrieval into a decision nobody made.
 */
export function autoAdoptsSingleCandidate(): boolean {
  return false;
}

/** The identifiers a Gate 2 pick chose BETWEEN — the option space the decision records. */
export function candidateAlternatives(candidates: UICandidate[]): string[] {
  return candidates.map((c) => c.cdeId).filter(Boolean);
}

// --- Gate 2: the SKOS relation between a concept and the element it takes -------------------------------

/**
 * The closed relation vocabulary, in the order a reviewer reasons about it: same thing first, then the two
 * directions of hierarchy, then the escape hatch.
 *
 * SKOS RATHER THAN AN INVENTED PREDICATE because the NIH CDE model has no "refines" of its own — the same
 * reason core stamps `relation` on a refined element (`GenCDE.relation`). Keeping the browser's vocabulary
 * identical to core's means a relation asserted here is the relation core would have written.
 */
export const SKOS_RELATIONS = [
  "skos:exactMatch",
  "skos:closeMatch",
  "skos:narrowMatch",
  "skos:broadMatch",
  "skos:relatedMatch",
] as const;

export type SkosRelation = (typeof SKOS_RELATIONS)[number];

/** Plain-language glosses. Copied in meaning from `workbench.tsx`'s map so two screens cannot disagree. */
export const SKOS_RELATION_LABEL: Record<SkosRelation, string> = {
  "skos:exactMatch": "the same element",
  "skos:closeMatch": "same concept, changed representation",
  "skos:narrowMatch": "narrower than the target (specialized)",
  "skos:broadMatch": "broader than the target (generalized)",
  "skos:relatedMatch": "related, neither narrower nor broader",
};

/**
 * The relation the pipeline's own verdict implies, used as the control's initial position.
 *
 * A SUGGESTION, NEVER A RECORDED DECISION. Nothing is persisted until the reviewer picks, so a run the
 * reviewer never touched carries no relation assertion — which is the truth about it.
 */
export function suggestedRelation(record: Pick<UIRecord, "verdict" | "gencde">): SkosRelation {
  if (record.verdict === "adopt") return "skos:exactMatch";
  const stamped = record.gencde?.relation;
  if (stamped && (SKOS_RELATIONS as readonly string[]).includes(stamped)) return stamped as SkosRelation;
  return "skos:closeMatch";
}

// --- Gate 3: what one transform spec is ----------------------------------------------------------------

/** The editing surfaces Gate 3 offers. Everything else renders read-only with its kind named. */
export type SpecForm = "categorical" | "unit" | "arithmetic" | "passthrough" | "other";

export function specForm(kind: string): SpecForm {
  if (kind === "categorical") return "categorical";
  if (kind === "unit") return "unit";
  if (kind === "arithmetic") return "arithmetic";
  if (kind === "none" || kind === "identity") return "passthrough";
  return "other";
}

/**
 * ARITHMETIC ALWAYS GOES TO REVIEW — unconditionally, not because a confidence score happened to be low.
 * It is a property of the CATEGORY: an arithmetic recode silently produces plausible numbers when it is
 * wrong, so there is no value of `needsReview` from the pipeline that should be able to turn this off.
 */
export function routesToReview(t: Pick<UITransform, "kind" | "needsReview">): boolean {
  return t.kind === "arithmetic" || t.needsReview;
}

/**
 * `none`  — the reviewer has nothing to decide.
 * `one`   — singular copy; a list that says "1 values" is a tell that nobody looked.
 * `many`  — plural, with the count.
 *
 * Separated because an unmapped source value is the quiet way a harmonization LOSES DATA: the row simply
 * does not arrive on the other side, and no error is ever raised. Zero, one and many read differently so
 * that "one value is being dropped" cannot hide inside a generic plural.
 */
export type UnmappedState = "none" | "one" | "many";

export function unmappedState(t: Pick<UITransform, "unmappedSourceCodes">): UnmappedState {
  const n = t.unmappedSourceCodes?.length ?? 0;
  if (n === 0) return "none";
  return n === 1 ? "one" : "many";
}

/** What the reviewer may decide about a value the recode does not carry across. */
export const UNMAPPED_OUTCOMES = ["add", "missing", "accept-loss"] as const;
export type UnmappedOutcome = (typeof UNMAPPED_OUTCOMES)[number];

export const UNMAPPED_OUTCOME_LABEL: Record<UnmappedOutcome, string> = {
  add: "Add a mapping",
  missing: "Map to a missing-data convention",
  "accept-loss": "Accept the loss and record it",
};

/**
 * `ok`            — a spec exists and says how to convert.
 * `no-transform`  — a spec exists and says nothing needs converting. A RESULT, not an absence.
 * `failed`        — spec generation ran for this run and produced nothing for this variable.
 * `not-generated` — spec generation never ran, because the run did not buy it.
 *
 * THE LAST TWO ARE THE POINT. Both render as "no spec here", and they are opposite claims: one says the
 * tool tried and could not, the other says the tool was never asked. Omitting a failed spec from the list
 * is worse than either — it removes the only evidence that the variable was ever in scope.
 */
export type SpecState = "ok" | "no-transform" | "failed" | "not-generated";

export function specState(
  t: Pick<UITransform, "kind"> | undefined,
  { specsGenerated }: { specsGenerated: boolean },
): SpecState {
  if (!specsGenerated) return "not-generated";
  if (!t) return "failed";
  return specForm(t.kind) === "passthrough" ? "no-transform" : "ok";
}

/**
 * Every source variable a concept pooled that Gate 3 owes an answer for, paired with the spec it got.
 *
 * DRIVEN BY THE MEMBERS, NOT BY THE SPECS, and that inversion is the whole reason this function exists.
 * Iterating the transforms can only ever show variables that produced one, so a variable whose spec
 * failed to generate is invisible — the exact omission `specState` is built to prevent. Starting from the
 * members makes the gap a row.
 */
export function specRowsFor(
  record: Pick<UIRecord, "members" | "transforms">,
  { specsGenerated }: { specsGenerated: boolean },
): { sourceVariable: string; transform?: UITransform; state: SpecState }[] {
  const bySource = new Map((record.transforms ?? []).map((t) => [t.sourceVariable, t]));
  return (record.members ?? []).map((sourceVariable) => {
    const transform = bySource.get(sourceVariable);
    return { sourceVariable, transform, state: specState(transform, { specsGenerated }) };
  });
}

// --- Gate 3: the opt-in concept-match check ------------------------------------------------------------

/**
 * `flagged`     — the check ran and says this element measures a different concept.
 * `clear`       — the check ran and found nothing.
 * `not-enabled` — the check did not run on this run.
 *
 * `conceptMismatch` IS ABSENT, NOT FALSE, ON A RUN THAT DID NOT OPT IN (see `UIRecord`), and reading the
 * absent value as `false` is the failure this function exists to stop: it turns "nobody checked" into
 * "checked, and fine", which is the tool vouching for a concept match no stage ever looked at.
 */
export type ConceptMatchState = "flagged" | "clear" | "not-enabled";

export function conceptMatchState(
  record: Pick<UIRecord, "conceptMismatch">,
  { optedIn }: { optedIn: boolean },
): ConceptMatchState {
  if (!optedIn || record.conceptMismatch === undefined) return "not-enabled";
  return record.conceptMismatch ? "flagged" : "clear";
}

// --- R13: what a re-pick on a finished run costs downstream --------------------------------------------

/**
 * How many Gate 3 spec decisions a Gate 2 re-pick on THIS concept would mark stale.
 *
 * Counted from the spec decisions that name this concept's pick as their upstream, so the confirmation
 * shows the REAL number. A placeholder here would be the one figure on the screen a reviewer cannot check,
 * on the one control whose whole promise is that it costs nothing.
 */
export function affectedSpecCount(
  specDecisions: Record<string, { upstream?: { kind: string; itemKey: string } }>,
  groupId: string,
): number {
  return Object.values(specDecisions).filter(
    (d) => d.upstream?.kind === "gate2_candidate_pick" && d.upstream.itemKey === groupId,
  ).length;
}

/**
 * The R13 confirmation, worded per UI-SPEC §8.5.
 *
 * THE ZERO-COST CLAIM IS PART OF THE SENTENCE, not a footnote, because it is the thing that makes the
 * decision easy and it is TRUE: the candidates were retrieved during the original run and re-selecting
 * among them reaches no provider (asserted backend-side by `test_repick_makes_no_llm_call`).
 */
export function repickConfirmation(n: number): string {
  return (
    `Changing the target marks ${n} transform spec${n === 1 ? "" : "s"} at Gate 3 stale. ` +
    `Regenerating them costs nothing — the candidates were already retrieved.`
  );
}

/**
 * Whether a re-pick needs the confirmation at all.
 *
 * NOTHING DOWNSTREAM MEANS NO CONFIRMATION AND NO REGENERATION STEP. Offering to regenerate zero specs is
 * a dead control, and a confirmation whose number is zero teaches the reviewer that the number is noise.
 */
export function needsRepickConfirmation(affected: number): boolean {
  return affected > 0;
}
