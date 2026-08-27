import type { PreprocessDiff, PreprocessReport, PreprocessRule, RuleOutcome } from "@/types";

/**
 * The pure half of the pre-flight — every decision the preparation report drives, as functions.
 *
 * (It was Gate 0's until that screen was demoted on 2026-08-26; the surface moved to Setup, the
 * arithmetic did not move at all.)
 *
 * WHY THESE ARE NOT IN THE COMPONENTS. Three of the things this surface must get right are claims about
 * arithmetic and provenance rather than about layout: which before/after rows may be shown under which
 * rule, whether the counts close against the row count, and which quality signals the report can honestly
 * supply. A rule that can only be checked by driving a page is a rule that stops being checked (the same
 * reasoning `@/lib/dictionary` exists for, and `setup.spec.ts` asserts against without a browser).
 *
 * THE CENTRAL HONESTY CONSTRAINT: THE JOIN IS INFERRED, NOT REPORTED. `PreprocessDiff` deliberately
 * carries no rule name — the pipeline records before and after per variable and does not stamp which rule
 * fired (UI-SPEC §9 item 2). So `examplesFor` cannot look a rule up; it can only narrow the diff to rows
 * whose CHANGED FACET is one this rule is capable of touching. That is weaker than provenance and the
 * screen says so. Widening this to a claim about causation would be inventing a record the product does
 * not keep.
 */

/**
 * Which part of a variable each rule can change, read off core's own implementation rather than guessed
 * (`ddharmon/ingestion/preprocessor.py`, step order in `preprocess_dictionary`'s docstring):
 *
 *  - `both`       — `_normalize_unicode` and `_normalize_whitespace` rewrite variable_name AND description.
 *  - `description`— administrative-text stripping, option-echo clearing and placeholder replacement all
 *                   act on description (+ question_text), never on the name.
 *  - `name`       — common-prefix stripping and stopword removal act on variable_name only.
 *  - `embed-name` — name-in-description dedup changes NEITHER string: it sets `_embed_variable_name`
 *                   False, so the name simply stops reaching the embedding text. Its evidence is the
 *                   `embedNameSuppressed` flag, and a diff row can carry it with no text change at all.
 *
 * A rule absent from this map yields no examples rather than all of them: an unknown rule is a reason to
 * show less, not to attribute arbitrary rows to it.
 */
export type RuleFacet = "name" | "description" | "both" | "embed-name";

export const RULE_FACETS: Record<string, RuleFacet> = {
  unicode_normalization: "both",
  administrative_text_stripping: "description",
  option_echo_clearing: "description",
  placeholder_description_replacement: "description",
  common_prefix_stripping: "name",
  stopword_removal: "name",
  name_in_description_dedup: "embed-name",
  whitespace_normalization: "both",
};

/** Rows from the diff that this rule COULD have produced. Never a claim that it did — see the docstring. */
export function examplesFor(rule: PreprocessRule, diff: PreprocessDiff[]): PreprocessDiff[] {
  const facet = RULE_FACETS[rule.rule];
  if (!facet) return [];
  return diff.filter((d) => {
    if (facet === "embed-name") return d.embedNameSuppressed;
    if (facet === "description") return d.descChanged;
    if (facet === "name") return d.nameChanged;
    return d.nameChanged || d.descChanged;
  });
}

/**
 * The outcome in WORDS — never by colour alone, and never with zero and one collapsed.
 *
 * FOUR outcomes, because three of them are routinely merged by a careless implementation and each merge
 * misinforms the reviewer in a different direction:
 *
 *  - `changed`   — it ran and changed N. `1 variable` / `N variables`, never `1 variables`.
 *  - `no_change` — it ran and found nothing. "changed 0 variables" says the check HAPPENED.
 *  - `not_run`   — it never executed, so nothing is known about what it would have found. Reporting this
 *                  as `0` would claim a check that never ran.
 *  - `failed`    — it threw, so the outcome is UNKNOWN rather than zero. A failure reading as a clean pass
 *                  is the same defect class as an unjudged group reading as coherent.
 */
export function outcomeLabel(rule: PreprocessRule): string {
  switch (rule.outcome) {
    case "changed":
      return `ran · changed ${rule.nChanged.toLocaleString()} ${rule.nChanged === 1 ? "variable" : "variables"}`;
    case "no_change":
      return "ran · changed 0 variables";
    case "not_run":
      return "did not run";
    case "failed":
      return "failed — outcome unknown";
  }
}

/** One sentence per outcome, so the list never leaves the reviewer to infer the difference from a number. */
export function outcomeExplanation(rule: PreprocessRule): string {
  switch (rule.outcome) {
    case "changed":
      return "This rule ran and rewrote the variables below.";
    case "no_change":
      return "This rule ran on every variable and found nothing to change. That is different from a rule that did not run: the check happened.";
    case "not_run":
      return "This rule never executed on this run, so nothing is known about what it would have found. That is not the same as finding nothing.";
    case "failed":
      return "This rule raised an error, so what it would have changed is unknown — not zero. Preparation cannot fail a run, so the rest of the pipeline continued without it.";
  }
}

/** Sort order for a legend/summary: the states a reviewer must not confuse, in the order they read. */
export const OUTCOME_SEQUENCE: RuleOutcome[] = ["changed", "no_change", "not_run", "failed"];

/**
 * The on-screen reconciliation.
 *
 * WHAT RECONCILES AGAINST WHAT, and it is one denominator, not two: every rule's count is out of the
 * dictionary's VARIABLE count — its unique-name count, which is what the rules were actually applied to.
 * `rows` is the source file's row count and is carried BESIDE it rather than folded in, because
 * `load_dictionary` keys on the variable name and a repeated name is a silent last-wins drop: rows minus
 * variables is the size of that loss, and hiding it inside a single "total" is how it stays invisible.
 *
 * `ok` is false when a rule claims more changed variables than there are variables. The backend already
 * refuses to ship that figure (it reports the rule `failed` instead), so this is a second, independent
 * check on the number the screen is about to state — not a substitute for it.
 */
export interface Reconciliation {
  /** Data rows in the source file. */
  rows: number;
  /** Unique variable names — the denominator every per-rule count is out of. */
  variables: number;
  /** Rows the loader dropped silently because their variable name repeated. */
  droppedSilently: number;
  /** Variables preprocessing changed at all. */
  changed: number;
  /** Variables it left exactly as they were. `changed + untouched === variables`. */
  untouched: number;
  ok: boolean;
}

export function reconcile(report: PreprocessReport): Reconciliation {
  const variables = report.nUniqueVariableNames;
  const changed = Math.min(report.nChangedVariables, Math.max(0, variables));
  return {
    rows: report.nVariables,
    variables,
    droppedSilently: report.nDuplicateVariableNames,
    changed,
    untouched: Math.max(0, variables - changed),
    ok:
      variables >= 0 &&
      report.nChangedVariables <= variables &&
      report.rules.every((r) => r.nChanged <= variables),
  };
}

/** True when every rule that RAN found nothing — the "No changes" state (UI-SPEC §8.2). */
export function noRuleFired(report: PreprocessReport): boolean {
  return report.ran && !report.failed && report.rules.every((r) => r.outcome !== "changed");
}

// --- the input-quality signals (08-14 Task 3) ----------------------------------------------------------

/**
 * One read on how good the INPUT dictionary is, as its own number with its own denominator.
 *
 * DELIBERATELY NOT A COMPOSITE. The external methods audit proposed a per-cohort "tier"; the same audit
 * rejects its own Interoperability Score because *"it averages three quantities with different
 * denominators"* and *"a single mean hides which of the three is the problem"*. A tier IS a composite, so
 * the tier proposal contradicts that rejection — resolved (2026-08-26) toward the rejection's own
 * prescription: separate, denominator-labelled numbers and no grade, letter, star or score anywhere.
 *
 * EVERY SIGNAL CARRIES ITS DENOMINATOR IN `denominator`, and on this screen that denominator is always
 * VARIABLES — dictionary rows. A revision rate is denominated in metadata ATTRIBUTES and is a different
 * kind of number; the two must never be presented alike (P2).
 */
export interface QualitySignal {
  id: string;
  /** What was found, in the reviewer's terms. */
  label: string;
  count: number;
  /** How many variables the count is out of. */
  of: number;
  /** The denominator IN WORDS, rendered on screen beside the number. */
  denominator: string;
  /** Why this signal matters for the run about to be paid for. */
  why: string;
  /** Concrete evidence, when the report carries any — e.g. the placeholder strings themselves. */
  evidence: string[];
}

/**
 * A signal this report CANNOT supply, declared rather than approximated.
 *
 * The reason is the point. "Not available" with no reason is indistinguishable from "zero", which is the
 * failure mode the honest-absence rule exists to prevent.
 */
export interface UnavailableSignal {
  id: string;
  label: string;
  reason: string;
}

/**
 * The placeholder strings core actually replaced.
 *
 * `PreprocessingReport.placeholder_values` is a LIST in core, and the adapter joins it with `"; "` into
 * the rule's `detail` — so on the wire the strings arrive as one string, not an array. Splitting it back
 * is lossy in principle (a placeholder containing "; " would split in two) and honest in practice: these
 * are boilerplate sentences, and showing them slightly over-split still shows the reviewer the actual
 * words, which is the whole point. `"12 placeholder descriptions"` is an abstraction; `"see codebook"` is
 * evidence.
 */
export function placeholderStrings(report: PreprocessReport): string[] {
  const rule = report.rules.find((r) => r.rule === "placeholder_description_replacement");
  if (!rule?.detail) return [];
  return rule.detail
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** A rule's count off the wire, or 0 when the rule did not run / is absent. */
function ruleCount(report: PreprocessReport, id: string): number {
  const rule = report.rules.find((r) => r.rule === id);
  return rule && rule.outcome === "changed" ? rule.nChanged : 0;
}

/**
 * The signals this report can honestly supply, each keyed to a published sparse-dictionary criterion.
 *
 * MEASURED AGAINST THE WIRE, not against core's dataclass. The three counts live on
 * `PreprocessingReport` as `option_echo_cleared`, `placeholders_replaced` and `name_deduped`, and the
 * adapter carries them INSIDE `report.rules[]` keyed by rule id rather than as top-level fields — so they
 * are read from there.
 *
 * `descriptionsChanged` IS on the wire and is deliberately NOT used: it counts how many descriptions the
 * rules ALTERED, which is cleaning effort, not how populated the source was. Using it as a population
 * signal would be reporting our own work as the dictionary's quality.
 */
export function qualitySignals(report: PreprocessReport): QualitySignal[] {
  const of = report.nUniqueVariableNames;
  const echoed = ruleCount(report, "option_echo_clearing") + ruleCount(report, "name_in_description_dedup");
  const placeholders = ruleCount(report, "placeholder_description_replacement");
  return [
    {
      id: "echoed-description",
      label: "Descriptions that only restated the variable name or one of its answer labels",
      count: echoed,
      of,
      denominator: "variables",
      why: "A description that repeats its own name carries no extra meaning for grouping, so these variables reach the model with less to go on than their row suggests.",
      evidence: [],
    },
    {
      id: "boilerplate-description",
      label: "Descriptions that were the same boilerplate sentence, repeated across variables",
      count: placeholders,
      of,
      denominator: "variables",
      why: "Boilerplate is identical text on variables that mean different things, which pulls them together in the embedding for a reason that has nothing to do with meaning.",
      evidence: placeholderStrings(report),
    },
    {
      id: "nothing-to-embed",
      label: "Variables with no text to embed at all",
      count: report.nNothingToEmbed,
      of,
      denominator: "variables",
      why: "These are present in every listing and reach no concept group, so they are a silent loss rather than a visible failure.",
      evidence: [],
    },
  ];
}

/**
 * The two signals the report cannot supply. They RENDER — see `UnavailableSignal`.
 *
 * Both are honest gaps rather than zeros, and neither may be approximated from something that happens to
 * be at hand: the opaque-abbreviation share is computable inside core but nothing reports it, and
 * per-attribute population rates live on `Dictionary` and not on the preparation report at all. Reaching
 * for either would need a core change, and this screen is UI-only (P6).
 */
export const UNAVAILABLE_SIGNALS: UnavailableSignal[] = [
  {
    id: "opaque-abbreviations",
    label: "Variables whose name is an opaque code",
    reason:
      "A name like A1 or F2txt tells the model nothing, and published results are much weaker on dictionaries built that way. ddharmon detects these when it composes embedding text, but no stage counts them, so there is no number to show — not a zero.",
  },
  {
    id: "attribute-population",
    label: "How many variables actually carry units, answer options or question wording",
    reason:
      "These are per-attribute population rates, and the preparation report does not carry them; they live on the loaded dictionary. Estimating them from what the rules happened to change would report our own cleaning as the dictionary's quality.",
  },
];

// --- the pre-flight read (08-14b) ----------------------------------------------------------------------

/**
 * What preparation FOUND, as opposed to what it DID — the pre-flight's own content.
 *
 * WHY THIS IS NARROWER THAN THE DECISION FIRST ASKED FOR. `08-DECISION-GATE0.md` D-4 asked for *"here is
 * what you should fix before you spend"* and made repeated variable names the headline. The standing
 * inherited-UI review (08-14b's pre-build question Q3) then established that this finding ALREADY SHIPS,
 * pre-Start, on the same screen: `nameCheck` in `@/lib/dictionary`, rendered by `DictionaryMappingTable`,
 * where it recomputes as the mapping changes and is therefore fixable IN PLACE with no restart. D-4 now
 * carries a CORRECTED block because of it.
 *
 * So this derivation is deliberately NOT the whole of "what you should fix". It is the subset that only
 * RUNNING the rules could reveal — and it must not restate the pre-Start finding in different words
 * either. A reviewer who reads the same finding twice, the second time at the moment it has become harder
 * to act on, trusts the screen less rather than more. `nVariables - nUniqueVariableNames` is right there
 * on the report; not using it is the point.
 *
 * EVERY NUMBER IS OUT OF VARIABLES. Dictionary ROWS, stated in words beside the figure. A count of
 * metadata attributes is a different kind of number and is never presented as the same one (P2). And no
 * tier, grade, letter, star or composite: that prohibition came from 08-14 and binds here unchanged.
 *
 * PURE, AND HERE RATHER THAN IN THE COMPONENT, for the reason this file's own header gives: a rule that
 * can only be checked by driving a page is a rule that stops being checked.
 */

/** One thing preparation found, with its count, its denominator and what to do about it. */
export interface PreflightFinding {
  id: string;
  label: string;
  count: number;
  /** The denominator as a number — this dictionary's VARIABLE count. */
  of: number;
  /** The denominator IN WORDS, rendered beside the number. */
  denominator: string;
  /** What it means for the run about to be paid for, and what the reviewer can do. */
  detail: string;
  /**
   * True when this is something to act on, false when it is just a statement of what happened. The
   * "nothing to flag" state is the absence of CONCERNS, not the absence of content.
   */
  concern: boolean;
  /**
   * True when acting on it means starting a FRESH run rather than fixing something in place.
   *
   * A run's column mapping is fixed at `startHarmonize`, so a finding about the MAPPING cannot be acted
   * on where it is read. That restart is free — nothing has been charged at this point — but it IS a
   * restart, and the panel says so rather than implying an in-place fix.
   */
  needsRestart: boolean;
}

/**
 * A finding this report CANNOT supply, declared rather than approximated.
 *
 * The reason and the pointer are both the point. "Not available" with no reason is indistinguishable from
 * "zero"; "not available" with no pointer is a dead end.
 */
export interface PreflightGap {
  id: string;
  label: string;
  reason: string;
  /** Where the reviewer can actually get the answer. */
  pointer: string;
}

export interface PreflightRead {
  /** What the rules did to THIS cohort. Never a concern, and never averaged across cohorts. */
  summary: PreflightFinding;
  findings: PreflightFinding[];
  gaps: PreflightGap[];
  /** True when no finding is a concern — rendered as a positive statement, not an empty region. */
  nothingToFlag: boolean;
}

/**
 * Where every declared gap points.
 *
 * The export is structurally more reliable than this screen: it re-reads and re-prepares the file locally
 * rather than reading the run's capped diff, so it returns EVERY row with the text that was embedded —
 * including the ones no rule touched, which are precisely the rows a gap is about.
 */
const EXPORT_POINTER =
  "Download the prepared dictionary below. It re-reads your file and returns every row with the exact " +
  "text ddharmon embedded — including the rows no rule touched, which are the ones this cannot see.";

/** Which mapped role carries the participant-facing wording. */
const WORDING_ROLE = "question_text";

/**
 * The pre-flight's read on one cohort's report.
 *
 * @param report the cohort's own preparation report.
 * @param roles  the column roles this run recorded FOR THIS COHORT, or null when it recorded none (the
 *               demo path persists dataset ids instead). Null is not "clean" — it is unknown, and it is
 *               declared as a gap rather than assumed either way.
 *
 * It takes ONE report and cannot average anything, which is deliberate: a mean over cohorts hides which
 * cohort is the problem, the same defect that got the composite score rejected in 08-14.
 */
export function preflightRead(
  report: PreprocessReport,
  roles: Record<string, string> | null,
): PreflightRead {
  const of = report.nUniqueVariableNames;
  const changed = Math.min(report.nChangedVariables, Math.max(0, of));

  const summary: PreflightFinding = {
    id: "rules-did",
    label: "changed by preparation",
    count: changed,
    of,
    denominator: "variables",
    detail:
      changed === 0
        ? "Every rule ran and found nothing to change in this dictionary. That is a result, not a skipped step — open What preparation changed below to see each rule's own outcome."
        : "Open What preparation changed below for each rule's outcome and a worked before-and-after example of what it did.",
    concern: false,
    needsRestart: false,
  };

  const findings: PreflightFinding[] = [];
  const gaps: PreflightGap[] = [];

  // 1. VARIABLES THAT COMPOSE NO TEXT TO EMBED. This leads, and it is the one finding that is
  //    unambiguously the pre-flight's to make: you cannot know a row composes to nothing until the rules
  //    have run over it, so it exists nowhere earlier in the product.
  findings.push({
    id: "nothing-to-embed",
    label: "Variables with no text to embed at all",
    count: report.nNothingToEmbed,
    of,
    denominator: "variables",
    detail:
      report.nNothingToEmbed === 0
        ? "Every variable in this dictionary reaches the grouping stage with something to say."
        : "These appear in every listing and reach no concept group, so they are a silent loss rather than a visible failure. They are paid for in nothing and produce nothing.",
    concern: report.nNothingToEmbed > 0,
    needsRestart: false,
  });

  // 2. THE PARTICIPANT-FACING WORDING. Derived from the run's OWN recorded mapping — a fact about this
  //    run, not an estimate, and not a figure carried over from any other cohort. When the run recorded
  //    no mapping the question is unanswerable from it, and that is DECLARED rather than read as clean.
  if (roles === null) {
    gaps.push({
      id: "question-wording",
      label: "Whether the participant-facing wording reached the model",
      reason:
        "This run does not keep a record of which column played which role, so there is no way to tell from it whether a column holding the question as it was asked was mapped — or existed. Reading that as 'nothing was missed' would be a claim the run cannot support.",
      pointer: EXPORT_POINTER,
    });
  } else if (!roles[WORDING_ROLE]) {
    findings.push({
      id: "question-wording",
      label: "No column was mapped as the question as it was asked",
      count: of,
      of,
      denominator: "variables",
      detail:
        "Every variable here was embedded from its description, because that is all that was mapped. Where a dictionary keeps the participant-facing wording in a separate column, that wording is the strongest thing the model can read — and none of it reached this run. The column mapping is fixed once a run starts, so mapping it means starting a new run. That is free: nothing has been charged yet.",
      concern: true,
      needsRestart: true,
    });
  }

  // 3. TEXT THAT IS STILL NOISY AFTER CLEANING — NOT AVAILABLE, and measured rather than assumed. The
  //    per-variable diff carries only variables something CHANGED and is capped besides, so when no rule
  //    fires it is EMPTY: there is nothing to scan. Approximating it from an empty sample would be
  //    inventing a measurement, which is worse than saying the report cannot answer.
  gaps.push({
    id: "unfired-noise",
    label: "Whether text no rule touched is still noisy",
    reason:
      "The run carries before-and-after detail only for variables preparation changed, and only for a sample of those. A variable no rule fired on is not in it at all — so a dictionary the rules left alone produces an empty sample rather than a clean bill of health.",
    pointer: EXPORT_POINTER,
  });

  return { summary, findings, gaps, nothingToFlag: findings.every((f) => !f.concern) };
}
