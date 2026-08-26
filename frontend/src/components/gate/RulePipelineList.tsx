import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { GateEmptyState } from "@/components/gate/GateEmptyState";
import {
  examplesFor,
  noRuleFired,
  outcomeExplanation,
  outcomeLabel,
  reconcile,
} from "@/lib/preprocess-report";
import type { PreprocessDiff, PreprocessReport, PreprocessRule } from "@/types";

/**
 * The preparation pipeline for ONE dictionary: every rule that ran, what each one did, and a worked
 * before/after example for each one that fired (UI-SPEC §7.5, §10 rows `populated` / `empty` /
 * `zero-one-many` / `error` / `long-text` for the Gate 0 surface).
 *
 * FOUR OUTCOMES, LABELLED IN WORDS, AND NEVER BY COLOUR ALONE. Three of them are the ones a careless
 * implementation merges, and each merge misinforms in its own direction:
 *
 *   - ran and changed N     — the ordinary case.
 *   - ran and changed zero  — the check HAPPENED and found nothing. Not silence, and never a hidden row:
 *                             a hidden zero cannot be told from a rule that was never in the pipeline.
 *   - did not run           — nothing is known about what it would have found. Reporting it as `0` would
 *                             claim a check that never happened.
 *   - failed                — the outcome is UNKNOWN rather than zero. A failure reading as a clean pass
 *                             is the same defect class as an unjudged group reading as coherent, so the
 *                             failed row carries its error text and its own claim marker.
 *
 * ZERO AND ONE READ DIFFERENTLY, in words. `changed 0 variables` versus `changed 1 variable` — the
 * singular is not cosmetic; `changed 1 variables` is the tell of a count nobody read.
 *
 * THE EXAMPLES ARE ESCAPED TEXT CHILDREN AND NOTHING ELSE. React escapes text by construction, and a
 * raw-HTML escape hatch is the only way mojibake in an uploaded dictionary becomes executable — so this
 * file uses none, and a grep gate asserts that rather than trusting the reading. (The literal itself is
 * deliberately not written anywhere here: the gate is a raw grep over this file, so a comment naming the
 * rule would convict the sentence that documents it.)
 *
 * THE JOIN UNDER EACH RULE IS INFERRED, NOT REPORTED, and the screen says so beside it. The pipeline
 * records before and after per variable and does not stamp which rule fired, so an example is narrowed to
 * rows whose changed FACET this rule can touch — never claimed to be caused by it. See
 * `@/lib/preprocess-report`, which owns that narrowing, and the provenance tile Gate 0 renders.
 *
 * IT SCROLLS INSIDE ITS OWN CARD. Many rules across many cohorts must not grow the page at 1440x900.
 */

/** How many worked examples one rule shows before the rest are counted rather than listed. */
const EXAMPLE_CAP = 3;

/** The claim each outcome makes, as a stable attribute — so styling and tests read the same source. */
const CLAIM: Record<PreprocessRule["outcome"], string> = {
  changed: "changed",
  no_change: "no-change",
  not_run: "not-run",
  failed: "failed",
};

/**
 * One before/after pair.
 *
 * CLAMPED WITH THE FULL VALUE AVAILABLE. A dictionary description can run to paragraphs, and an
 * unclamped one reflows the whole list; the complete string stays on `title`, so nothing is lost. Both
 * halves are labelled, because an "after" with no "before" is not a worked example.
 */
function Example({ row }: { row: PreprocessDiff }) {
  const nameMoved = row.nameChanged || row.embedNameSuppressed;
  const before = nameMoved && !row.descChanged ? row.rawVariableName : row.rawDescription;
  const after = nameMoved && !row.descChanged ? row.variableName : row.cleanedDescription;
  return (
    <li data-testid="rule-example" className="flex flex-col gap-1 border-t border-rule-quiet-on-raised pt-3 first:border-t-0 first:pt-0">
      <p className="font-mono text-xs text-on-raised-muted">{row.variableName}</p>
      <div className="grid grid-cols-2 gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-xs font-semibold text-on-raised-muted">Before</p>
          {/* Escaped text child. The clamp is a display bound, not a truncation of the data. */}
          <p data-testid="example-before" title={before} className="line-clamp-3 text-xs text-on-raised">
            {before || "(empty)"}
          </p>
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-xs font-semibold text-on-raised-muted">After</p>
          <p data-testid="example-after" title={after} className="line-clamp-3 text-xs text-on-raised">
            {after || "(cleared)"}
          </p>
        </div>
      </div>
      {row.embedNameSuppressed && (
        <p className="text-xs text-on-raised-muted">
          The variable name was dropped from the embedding text because the description already contained
          it — neither string changed.
        </p>
      )}
    </li>
  );
}

/** What a rule's expanded body says, per outcome. Only `changed` has examples to show. */
function RuleBody({ rule, diff }: { rule: PreprocessRule; diff: PreprocessDiff[] }) {
  const examples = examplesFor(rule, diff).slice(0, EXAMPLE_CAP);
  const total = examplesFor(rule, diff).length;
  return (
    <div className="flex flex-col gap-3 px-6 pb-4">
      <p className="max-w-[68ch] text-xs text-on-raised-muted">{outcomeExplanation(rule)}</p>
      {rule.outcome === "changed" && rule.detail && (
        <p className="max-w-[68ch] text-xs text-on-raised">
          <span className="font-semibold">What it matched:</span> {rule.detail}
        </p>
      )}
      {rule.outcome === "changed" && examples.length > 0 && (
        <>
          <p className="text-xs text-on-raised-muted">
            {/* The honesty note, repeated where the inference is actually made rather than only in the
                tile above: these rows are ones this rule COULD have produced. */}
            {examples.length === 1 ? "One example" : `${examples.length} examples`} of the {total}{" "}
            {total === 1 ? "variable" : "variables"} whose change this rule could account for — the
            pipeline does not stamp which rule changed a variable, so the match below is inferred.
          </p>
          <ul className="flex flex-col gap-3">
            {examples.map((row) => (
              <Example key={row.variableName} row={row} />
            ))}
          </ul>
        </>
      )}
      {rule.outcome === "changed" && examples.length === 0 && (
        <p className="max-w-[68ch] text-xs text-on-raised-muted">
          This rule reported {rule.nChanged.toLocaleString()}{" "}
          {rule.nChanged === 1 ? "change" : "changes"}, but the per-variable sample carried on this run
          holds no row whose changed part this rule can touch — so there is no example to show rather than
          an example to guess at.
        </p>
      )}
    </div>
  );
}

export function RulePipelineList({ report }: { report: PreprocessReport }) {
  const rec = reconcile(report);
  const nothingFired = noRuleFired(report);

  return (
    <div className="flex flex-col">
      {/* THE RECONCILIATION, ON SCREEN. Rows and variables are two numbers, not one: the loader keys on
          the variable name, so rows minus variables is a silent last-wins drop, and folding it into a
          single total is how that loss stays invisible. This project's terms are binding — a variable is
          a dictionary ROW, and "field" is reserved for a metadata attribute, so it is not used here. */}
      <p
        data-testid="rule-reconciliation"
        data-variables={String(rec.variables)}
        data-rows={String(rec.rows)}
        data-changed={String(rec.changed)}
        data-untouched={String(rec.untouched)}
        data-dropped={String(rec.droppedSilently)}
        data-reconciles={String(rec.ok)}
        className="border-b border-rule-on-raised px-6 py-3 text-xs text-on-raised-muted"
      >
        <span className="font-semibold text-on-raised">
          {rec.rows.toLocaleString()} rows · {rec.variables.toLocaleString()} variables
        </span>{" "}
        — every count below is out of those {rec.variables.toLocaleString()} variables:{" "}
        <span className="font-semibold text-on-raised">{rec.changed.toLocaleString()} changed</span> and{" "}
        {rec.untouched.toLocaleString()} left exactly as they were.
        {rec.droppedSilently > 0 && (
          <>
            {" "}
            {rec.droppedSilently.toLocaleString()}{" "}
            {rec.droppedSilently === 1 ? "row was" : "rows were"} dropped before any rule ran, because
            their variable name repeated and the loader keeps only the last one.
          </>
        )}
        {!rec.ok && (
          <>
            {" "}
            <span className="font-semibold text-on-raised">
              These counts do not add up, so treat them as unverified.
            </span>
          </>
        )}
      </p>

      {/* The "No changes" state (UI-SPEC §8.2). It renders ABOVE the list rather than instead of it: the
          list is what makes "did not apply" legible, and the copy's whole job is to contrast itself with
          a rule not running. */}
      {nothingFired && (
        <GateEmptyState
          heading="No changes"
          nextStep="Continue when you are ready — nothing here needs your attention."
        >
          Every rule ran; none of them found anything to change in this dictionary. This is different from
          a rule not running — the list below shows each rule and a count of zero.
        </GateEmptyState>
      )}

      {report.failed && report.error && (
        <p role="alert" className="border-b border-rule-on-raised px-6 py-3 text-xs text-on-raised">
          <span className="font-semibold">Preparation failed for this dictionary.</span> Every rule below
          reports the same error, because the rules run as one call — so what each would have changed is
          unknown, not zero. The run continued without them.
        </p>
      )}

      {/* Scrolls inside the card. Many rules across many cohorts must not grow the page. */}
      <div data-testid="rule-pipeline-scroll" className="max-h-[32rem] overflow-y-auto">
        <Accordion type="multiple" className="flex flex-col">
          {report.rules.map((rule) => (
            <AccordionItem
              key={rule.rule}
              value={rule.rule}
              data-testid="rule-row"
              data-rule={rule.rule}
              data-outcome={rule.outcome}
              data-claim={CLAIM[rule.outcome]}
              data-changed={String(rule.nChanged)}
              className="border-b border-rule-quiet-on-raised last:border-b-0"
            >
              <AccordionTrigger className="gap-4 px-6 text-on-raised [&>svg]:text-on-raised-muted">
                <span className="flex min-w-0 flex-1 flex-col gap-1 pr-4 text-left">
                  <span className="text-sm font-semibold text-on-raised">{rule.label}</span>
                  {/* The outcome in WORDS. A marker dot would be colour alone, which is not a label. */}
                  <span className="text-xs font-normal text-on-raised-muted">{outcomeLabel(rule)}</span>
                </span>
              </AccordionTrigger>
              {/* Visible WITHOUT expanding. A failure behind a disclosure reads as a clean pass at a
                  glance, which is the defect the third state exists to prevent. */}
              {rule.outcome === "failed" && rule.error && (
                <p role="alert" className="px-6 pb-3 font-mono text-xs text-on-raised">
                  {rule.error}
                </p>
              )}
              <AccordionContent className="p-0">
                <RuleBody rule={rule} diff={report.diff} />
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </div>

      {report.diffTruncated && (
        <p className="border-t border-rule-on-raised px-6 py-3 text-xs text-on-raised-muted">
          {report.nChangedVariables.toLocaleString()} variables were changed in all; this run carries{" "}
          {report.diff.length.toLocaleString()} of them as worked examples. The count is the true one — the
          sample is what is capped.
        </p>
      )}
    </div>
  );
}
