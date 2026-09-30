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

export function candidateListState(
  record: Pick<UIRecord, "candidates" | "verdict" | "gencde">,
): CandidateListState {
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

/**
 * Name every "Candidate N" the model's rationale cites (08-26, live-test-2 #3).
 *
 * THE MODEL'S ORDINAL IS THE CANDIDATE'S RANK — the order it was shown them in — not any position on the
 * screen. The ranked table floats the chosen candidate to the top, so "Candidate 3" and a pick on the first
 * displayed row are the SAME element; read against display positions they disagree. Citing the element by
 * name removes the ambiguity whatever the table's order, and the table numbers each row by its rank so the
 * two numberings are one. An ordinal no candidate carries is left untouched rather than pinned to a guess,
 * and a citation already followed by its name is not named twice.
 */
export function citeCandidateOrdinals(
  rationale: string,
  candidates: Pick<UICandidate, "rank" | "cdeId">[],
): string {
  const byRank = new Map(candidates.map((c) => [c.rank, c.cdeId]));
  return rationale.replace(
    /\b(candidate\s*#?\s*)(\d+)\b(?!\s*\()/gi,
    (whole, _lead: string, n: string) => {
      const name = byRank.get(Number(n));
      return name ? `${whole} (${name})` : whole;
    },
  );
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
 * A relation's `targetId` for the group's OWN element when that element has no GenCDE id — a reviewer authored
 * one on a concept core generated nothing for, so the pick's `chosen` is "". `OWN_TARGET` in the backend's
 * `export_decisions.py`, which reads every id of the own element (this, "", its GenCDE id) as one target.
 */
export const OWN_TARGET = "own";

/**
 * The target a relation decision is keyed on (with the group): the chosen catalog element's id, or — when the
 * group takes its OWN element — that element's GenCDE id, else `OWN_TARGET`. One id per target, so re-picking
 * the own element under another name ("" vs its id) cannot split its note across two rows.
 */
export function relationTargetId(chosenId: string, ownGencdeId: string | undefined, targetIsOwn: boolean): string {
  if (targetIsOwn) return ownGencdeId || OWN_TARGET;
  return chosenId || OWN_TARGET;
}

/**
 * The relation the pipeline's own verdict implies, used as the control's initial position.
 *
 * A SUGGESTION, NEVER A RECORDED DECISION. Nothing is persisted until the reviewer picks, so a run the
 * reviewer never touched carries no relation assertion — which is the truth about it.
 */
export function suggestedRelation(
  record: Pick<UIRecord, "verdict" | "gencde">,
): SkosRelation {
  if (record.verdict === "adopt") return "skos:exactMatch";
  const stamped = record.gencde?.relation;
  if (stamped && (SKOS_RELATIONS as readonly string[]).includes(stamped))
    return stamped as SkosRelation;
  return "skos:closeMatch";
}

// --- Gate 3: what one transform spec is ----------------------------------------------------------------

/** The editing surfaces Gate 3 offers. Everything else renders read-only with its kind named.
 *
 *  `none` is NOT a passthrough (08-28 1c, F16): core emits it when the model's code map came back EMPTY — no
 *  value could be mapped — so it is `no-spec`, the opposite claim to `identity`'s "already aligned". */
export type SpecForm =
  "categorical" | "unit" | "arithmetic" | "passthrough" | "no-spec" | "other";

export function specForm(kind: string): SpecForm {
  if (kind === "categorical") return "categorical";
  if (kind === "unit") return "unit";
  if (kind === "arithmetic") return "arithmetic";
  if (kind === "identity") return "passthrough";
  if (kind === "none") return "no-spec";
  return "other";
}

/**
 * Why a GENERATED spec could not actually be produced, or `""` when it can be applied (08-28 1c, F16).
 *
 *  - kind `none` — the model's code map came back empty: nothing was mapped.
 *  - a `unit` spec with no conversion factor — core's `needs_units` residual: the units could not be
 *    reconciled, so there is no conversion to apply (the notebook used to emit `raw * 1.0 + 0.0`).
 *
 * Mirrored by `backend/notebook.py::_unproduced`, which emits a REVIEW REQUIRED stub for exactly these.
 */
export function specUnproduced(t: Pick<UITransform, "kind" | "factor"> | undefined): string {
  if (!t) return "";
  if (t.kind === "none") return "couldn't map";
  if (t.kind === "unit" && typeof t.factor !== "number") return "couldn't convert";
  return "";
}

/**
 * What the harmonization TARGET's values are: a number, something that is not a number (an enumerated
 * category, text, a date…), or UNKNOWN.
 *
 * ENUMERATED VALUES DECIDE IT FIRST. A target with a permissible-value list is one the reviewer maps values
 * INTO, whatever its declared type says. With no list, the DECLARED type decides — and only a declared
 * number type (Number / numeric / integer / …) is numeric. Everything else declared — the catalog's own
 * "Value List" (its word for categorical), "Externally Defined", text, date, binary — is not.
 *
 * WHY "UNKNOWN" IS ITS OWN ANSWER (08-26, live-test-2 #7). No type AND no values is the ABSENCE of evidence,
 * not evidence of a number. It is exactly what a run whose candidates reached the wire without catalog
 * metadata looks like (573cf61f), and reading it as numeric is what put a coded Yes/No target
 * (`Current Pregnancy Indicator`) on the code→number editor with "numeric responses pass through".
 */
export type TargetValueKind = "numeric" | "non-numeric" | "unknown";

const NUMERIC_DATA_TYPES = new Set([
  "number",
  "numeric",
  "integer",
  "int",
  "float",
  "decimal",
  "double",
  "real",
  "continuous",
]);

export function targetValueKind(
  dataType: string | undefined,
  permissibleValues: string[],
): TargetValueKind {
  if (permissibleValues.length > 0) return "non-numeric";
  const t = (dataType ?? "").trim().toLowerCase();
  if (!t) return "unknown";
  return NUMERIC_DATA_TYPES.has(t) ? "numeric" : "non-numeric";
}

/** Whether the target is DECLARED a number (see `targetValueKind`; an unknown type is not a number). */
export function targetIsNumeric(
  dataType: string | undefined,
  permissibleValues: string[],
): boolean {
  return targetValueKind(dataType, permissibleValues) === "numeric";
}

/**
 * The values a concept's generated specs map INTO a target, recovered from their code maps — the fallback
 * value list for a target whose own list never reached the wire (#7).
 *
 * A categorical spec's `codeMap` is source code → target LABEL, so the union of its right-hand sides over
 * the specs into THIS target is a (possibly partial) picture of the target's domain: enough buckets to put
 * the model's own recode back where it put it. A code map whose targets are all numbers is a numeric
 * landing, not a value list, and yields nothing — this never invents categories for a number.
 */
export function targetValuesFromSpecs(
  transforms: UITransform[],
  targetCdeId: string,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of transforms) {
    if (t.targetCdeId !== targetCdeId || !t.codeMap) continue;
    for (const v of Object.values(t.codeMap)) {
      const label = String(v ?? "").trim();
      const key = label.toLowerCase();
      if (!label || seen.has(key)) continue;
      seen.add(key);
      out.push(label);
    }
  }
  const isNumber = (v: string) => v !== "" && Number.isFinite(Number(v));
  if (out.length === 0 || out.every(isNumber)) return [];
  return out;
}

/**
 * 08-27b: the targets a concept's specs were built for that are NOT the target Gate 3 shows — empty when they
 * agree. Since 08-27b the backend regenerates a Gate 2 re-pick's specs for the reviewer's target, so a
 * non-empty answer means the run crossed Gate 2 -> Gate 3 before that fix (its specs are the model's) and the
 * screen must say so instead of labelling them with the pick. `alsoAccepted` covers a refine record, whose
 * derived element is a legitimate second target of the model's own specs. No specs is never a mismatch.
 */
export function specTargetMismatch(
  transforms: UITransform[],
  expectedTargetId: string,
  alsoAccepted: string[] = [],
): string[] {
  const ok = new Set([expectedTargetId, ...alsoAccepted]);
  const off: string[] = [];
  for (const t of transforms) {
    const id = t.targetCdeId ?? "";
    if (!ok.has(id) && !off.includes(id)) off.push(id);
  }
  return off;
}

/**
 * The four value-recode surfaces, and the ONE rule for choosing between them: the surface follows the
 * TARGET's type, not the source's coded options and not the pipeline's transform kind.
 *
 * WHY TARGET-DRIVEN. A source variable that carries coded response options is not necessarily categorical —
 * AI-READI `susmkstoage` ("years smoked") codes 98 = "more than 60" and 999 = "prefer not to say" over a
 * numeric body, so its source reads "categorical" only because it HAS codes. What settles the surface is
 * where the values must LAND: a Number target has no permissible-value buckets to drop chips into, and a
 * categorical target has no single number to pass a source integer through as. Keying off the source type
 * is what put a chip-and-bucket editor on a numeric target and left it with nowhere to place a value.
 *
 *   - `value-map`      ① target categorical + source has options → chips into target-value buckets.
 *   - `code-to-number` ② target numeric     + source has options → each code → a number / Missing / Drop.
 *   - `binning`        ③ target categorical + source numeric     → source ranges → target bands.
 *   - `recode-detail`  ④ unit / arithmetic / data-dependent, or numeric→numeric with no value list → read-only.
 *
 * An UNKNOWN target type (no declared type, no values) is never treated as numeric (#7): a categorical spec
 * gets ①, anything else ④.
 */
export type RecodeShape =
  "value-map" | "code-to-number" | "binning" | "recode-detail";

export function recodeShape(args: {
  targetDataType?: string;
  /** The target's permissible values (labels), catalog order; empty for a numeric target. */
  targetValues: string[];
  /** Whether the source variable carries enumerated response options. */
  hasSourceOptions: boolean;
  /** The pipeline transform kind, when one was generated. */
  kind?: string;
}): RecodeShape {
  // A method with no value list to sort keeps its read-only detail — these are numeric↔numeric conversions.
  if (
    args.kind === "unit" ||
    args.kind === "arithmetic" ||
    args.kind === "data_dependent"
  )
    return "recode-detail";
  const target = targetValueKind(args.targetDataType, args.targetValues);
  // An UNKNOWN target type (#7) never asserts a number. The spec is the only evidence left: a categorical
  // spec mapped codes onto target LABELS, so a coded source gets the value map; anything else stays
  // read-only rather than guess.
  if (target === "unknown")
    return args.hasSourceOptions && args.kind === "categorical"
      ? "value-map"
      : "recode-detail";
  const numericTarget = target === "numeric";
  if (args.hasSourceOptions)
    return numericTarget ? "code-to-number" : "value-map";
  // A non-numeric target with no bands to bin into (e.g. free text) has nothing to edit — read-only.
  if (!numericTarget)
    return args.targetValues.length > 0 ? "binning" : "recode-detail";
  return "recode-detail";
}

// --- ② code → number (categorical source, numeric target) ---------------------------------------------

/**
 * What a single source code becomes on a numeric target. `number` carries a value; `missing` and `drop`
 * do not. The numeric BODY of the variable is not a code — it passes through as-is and is rendered as a
 * standing row, so it never appears in this map.
 *
 * NO `censored` YET, DELIBERATELY. A top-code like 98 = "more than 60" is honestly a censored value
 * (≥ 60), but recording that needs the run contract to carry a censored flag downstream, which it does not
 * yet. Until it does, the safe default is `missing` and a representative `number` is the deliberate upgrade —
 * never a silently fabricated point value.
 */
export type NumberAction = "number" | "missing" | "drop";
export const NUMBER_ACTIONS = ["number", "missing", "drop"] as const;
export const NUMBER_ACTION_LABEL: Record<NumberAction, string> = {
  number: "Number",
  missing: "Missing",
  drop: "Drop",
};
export interface NumberMapEntry {
  action: NumberAction;
  value: number | null;
}

/**
 * Seed the code→number map. Every coded value defaults to `missing` — on a numeric target a code has no
 * natural number, so the honest starting point is "not collected", which the reviewer upgrades to a
 * representative number where one exists. Persisted edits win.
 */
export function seedNumberMap(
  sourceOptions: { code: string }[],
  existing?: Record<string, NumberMapEntry>,
): Record<string, NumberMapEntry> {
  const out: Record<string, NumberMapEntry> = {};
  for (const o of sourceOptions)
    out[o.code] = { action: "missing", value: null };
  if (existing)
    for (const [k, v] of Object.entries(existing)) if (v) out[k] = v;
  return out;
}

// --- ③ binning (numeric source, categorical target) ---------------------------------------------------

export interface BinRule {
  band: string; // the target permissible value this range maps onto
  min: number | null; // inclusive lower bound; null = open below
  max: number | null; // inclusive upper bound; null = open above
}

/**
 * Parse a numeric range out of a band LABEL so the reviewer opens with proposed boundaries instead of a
 * blank grid: "18-29" / "18–29" / "18 to 29" → [18, 29]; "65+" / "65 or older" / "≥65" → [65, ∞);
 * "<18" / "under 18" → (−∞, 18). Returns null when the label carries no range (a named category the
 * reviewer must bound by hand).
 */
export function parseBandRange(
  label: string,
): { min: number | null; max: number | null } | null {
  const s = label.trim();
  let m =
    s.match(/^(\d+(?:\.\d+)?)\s*\+$/) ||
    s.match(
      /^(\d+(?:\.\d+)?)\s*(?:or older|and older|and up|or more|and over)$/i,
    ) ||
    s.match(/^(?:>=?|≥)\s*(\d+(?:\.\d+)?)$/);
  if (m) return { min: Number(m[1]), max: null };
  m = s.match(/^(?:<=?|≤|under|up to|less than)\s*(\d+(?:\.\d+)?)$/i);
  if (m) return { min: null, max: Number(m[1]) };
  m = s.match(/^(\d+(?:\.\d+)?)\s*(?:-|–|—|to)\s*(\d+(?:\.\d+)?)$/i);
  if (m) return { min: Number(m[1]), max: Number(m[2]) };
  return null;
}

/** One bin per target band, pre-proposed from the band labels; persisted boundaries win. */
export function seedBinning(
  targetValues: string[],
  existing?: BinRule[],
): BinRule[] {
  const byBand = new Map((existing ?? []).map((b) => [b.band, b]));
  return targetValues.map((band) => {
    const prev = byBand.get(band);
    if (prev) return prev;
    const parsed = parseBandRange(band);
    return { band, min: parsed?.min ?? null, max: parsed?.max ?? null };
  });
}

/**
 * ARITHMETIC ALWAYS GOES TO REVIEW — unconditionally, not because a confidence score happened to be low.
 * It is a property of the CATEGORY: an arithmetic recode silently produces plausible numbers when it is
 * wrong, so there is no value of `needsReview` from the pipeline that should be able to turn this off.
 */
export function routesToReview(
  t: Pick<UITransform, "kind" | "needsReview" | "factor">,
): boolean {
  // A spec that could not be produced is the reviewer's by construction, whatever the pipeline flag says.
  return t.kind === "arithmetic" || !!specUnproduced(t) || t.needsReview;
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

export function unmappedState(
  t: Pick<UITransform, "unmappedSourceCodes">,
): UnmappedState {
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
 * `needs-you`     — a spec row exists but the model could not produce the recode (an empty code map, a unit
 *                   pair with no conversion): "couldn't map — needs you". Reading it as `no-transform` put raw
 *                   yes/no codes into a 35-value disease column labelled "already matches" (F16).
 * `failed`        — spec generation ran for this run and produced nothing for this variable.
 * `not-generated` — spec generation never ran, because the run did not buy it.
 *
 * THE LAST TWO ARE THE POINT. Both render as "no spec here", and they are opposite claims: one says the
 * tool tried and could not, the other says the tool was never asked. Omitting a failed spec from the list
 * is worse than either — it removes the only evidence that the variable was ever in scope.
 */
export type SpecState = "ok" | "no-transform" | "needs-you" | "failed" | "not-generated";

export function specState(
  t: Pick<UITransform, "kind" | "factor"> | undefined,
  { specsGenerated }: { specsGenerated: boolean },
): SpecState {
  if (!specsGenerated) return "not-generated";
  if (!t) return "failed";
  if (specUnproduced(t)) return "needs-you";
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
  const bySource = new Map(
    (record.transforms ?? []).map((t) => [t.sourceVariable, t]),
  );
  return (record.members ?? []).map((sourceVariable) => {
    const transform = bySource.get(sourceVariable);
    return {
      sourceVariable,
      transform,
      state: specState(transform, { specsGenerated }),
    };
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
  specDecisions: Record<
    string,
    { upstream?: { kind: string; itemKey: string } }
  >,
  groupId: string,
): number {
  return Object.values(specDecisions).filter(
    (d) =>
      d.upstream?.kind === "gate2_candidate_pick" &&
      d.upstream.itemKey === groupId,
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

// --- Gate 3: one decision per source variable, MERGED on every save (08-27 audit B1) --------------------

/** The reviewer-edit fields a `gate3_spec_edit` decision carries. Each control patches ONE of them. */
export const SPEC_EDIT_FIELDS = ["note", "mapping", "numberMap", "bins", "rejected"] as const;
export type SpecEditField = (typeof SPEC_EDIT_FIELDS)[number];

/**
 * The `extra` payload for a Gate 3 save: the persisted decision's edit fields, overlaid with this control's
 * patch. The store REPLACES a decision row on write, so a control that sent only its own field erased the
 * others (a note save wiped the value map; Reject wiped the note; a later drag dropped `rejected`). A patch
 * of `rejected: false` clears the flag rather than storing it.
 */
export function mergeSpecEdit(
  prev: Record<string, unknown> | undefined,
  patch: Partial<Record<SpecEditField, unknown>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of SPEC_EDIT_FIELDS) {
    const v = f in patch ? patch[f] : prev?.[f];
    if (v === undefined || (f === "rejected" && v !== true)) continue;
    out[f] = v;
  }
  return out;
}
