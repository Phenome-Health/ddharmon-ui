import { NotAvailable } from "@/components/gate/NotAvailable";
import { UNAVAILABLE_SIGNALS, qualitySignals } from "@/lib/preprocess-report";
import type { QualitySignal } from "@/lib/preprocess-report";
import type { PreprocessReport } from "@/types";

/**
 * A pre-spend read on how good the INPUT dictionary is — as SIGNALS, never as a grade.
 *
 * WHY IT IS ON THIS SCREEN AT ALL. Everything else Gate 0 shows is rule PROVENANCE: which rule fired and
 * what it changed. None of that answers the question a reviewer standing in front of the run's first
 * charge actually has, which is whether this dictionary is good enough to spend on. Published results put
 * output quality on input dictionary quality harder than on anything else measured — 100% on dictionaries
 * built over established coding systems against 33% on one whose variables were abstract codes — and
 * three of the cohorts this product ingests are that sparse case. Gate 0 is the last screen before the
 * first charge, so it is the only place such a read can change a spend decision.
 *
 * NO TIER, GRADE, LETTER, STAR, PERCENTAGE OR SCORE. This is the load-bearing constraint, not a style
 * preference. The audit that proposed a per-cohort "tier" also REJECTS its own composite Interoperability
 * Score, because *"it averages three quantities with different denominators"* and *"a single mean hides
 * which of the three is the problem"*. A tier IS a composite, so the proposal contradicts that rejection
 * two sections later — resolved (2026-08-26) toward the rejection's own prescription. A reviewer told
 * "B−" learns nothing they can act on; a reviewer told "45 of 200 variables carried the same boilerplate
 * sentence, and here it is" knows what to fix.
 *
 * EVERY NUMBER IS STAMPED WITH ITS DENOMINATOR, and on this screen that denominator is always VARIABLES —
 * dictionary rows. A revision rate is denominated in metadata ATTRIBUTES and is a different kind of
 * number; presenting the two alike is the confusion P2 exists to prevent, so the words "field" and
 * "attribute" do not appear in any signal's copy.
 *
 * PER COHORT, AND NEVER AVERAGED. The panel lives inside one cohort's tab and reads only that cohort's
 * report. A cross-cohort mean would be the same defect as a tier, one level up.
 *
 * WHAT IT REFUSES TO ESTIMATE. Two signals the report cannot supply render as declared gaps rather than
 * as approximations: the opaque-abbreviation share (computable inside the pipeline, reported by nothing)
 * and per-attribute population rates (on the loaded dictionary, not on the preparation report). Reaching
 * for either would need a core change, and this screen is UI-only. `descriptionsChanged` is on the wire
 * and is deliberately never read here — it counts how many descriptions the RULES altered, which is our
 * own cleaning effort, not how populated the source was.
 *
 * NOTHING-TO-FLAG IS A RESULT. An all-clear dictionary says so, with every row still showing its zero. An
 * empty region would tell the reviewer nothing was looked for.
 */

/** How many placeholder sentences are shown before the rest are counted. The full list stays on `title`. */
const EVIDENCE_CAP = 3;

function SignalRow({ signal }: { signal: QualitySignal }) {
  const shown = signal.evidence.slice(0, EVIDENCE_CAP);
  const rest = signal.evidence.length - shown.length;
  return (
    <li
      data-testid="quality-signal"
      data-signal={signal.id}
      data-count={String(signal.count)}
      data-of={String(signal.of)}
      data-denominator={signal.denominator}
      className="flex flex-col gap-1 border-b border-rule-quiet-on-raised px-6 py-3 last:border-b-0"
    >
      {/* THE COUNT AND ITS DENOMINATOR IN ONE SENTENCE. Not a bare number beside a label: a number whose
          denominator is implied by placement is a number that gets compared to the wrong thing. */}
      <p className="text-sm text-on-raised">
        <span className="font-semibold tabular-nums">
          {signal.count.toLocaleString()} of {signal.of.toLocaleString()} variables
        </span>{" "}
        — {signal.label.charAt(0).toLowerCase()}
        {signal.label.slice(1)}
      </p>
      <p className="max-w-[68ch] text-xs text-on-raised-muted">{signal.why}</p>
      {shown.length > 0 && (
        <ul className="flex flex-col gap-1 pt-1">
          {shown.map((text) => (
            /* The evidence itself, as an escaped text child. A count is an abstraction; the sentence the
               dictionary actually repeated is the thing a reviewer can recognise and go fix. */
            <li key={text} title={text} className="line-clamp-2 rounded-inner bg-surface-inset px-3 py-1.5 text-xs text-on-inset">
              {text}
            </li>
          ))}
          {rest > 0 && (
            <li className="text-xs text-on-raised-muted">
              and {rest.toLocaleString()} more repeated {rest === 1 ? "sentence" : "sentences"}
            </li>
          )}
        </ul>
      )}
    </li>
  );
}

export function InputQualitySignals({ report }: { report: PreprocessReport }) {
  const signals = qualitySignals(report);
  const allClear = signals.every((s) => s.count === 0);

  return (
    <section
      data-testid="input-quality"
      data-cohort={report.cohort}
      data-all-clear={String(allClear)}
      className="flex flex-col border-t border-rule-on-raised"
    >
      <div className="flex flex-col gap-1 px-6 py-3">
        <h3 className="text-sm font-semibold text-on-raised">What this dictionary gives the model</h3>
        <p className="max-w-[68ch] text-xs text-on-raised-muted">
          {/* The absence of a rollup is stated, so it reads as a decision rather than as an omission. */}
          Separate readings, each counted out of this dictionary&rsquo;s variables. They are deliberately
          not combined into one number: a single reading would hide which of them is the problem, and the
          problem is the only part you can act on.
        </p>
      </div>

      {allClear && (
        /* NOTHING TO FLAG IS A FINDING. Stated, with the rows still below it showing their zeros. */
        <p className="border-t border-rule-quiet-on-raised px-6 py-3 text-sm text-on-raised">
          <span className="font-semibold">None of these weaknesses appear in this dictionary.</span> Every
          variable carries wording of its own, none of it repeated boilerplate, and every one composes text
          to embed. Each reading below is shown with its zero rather than hidden, so a check that found
          nothing stays distinguishable from a check nobody made.
        </p>
      )}

      <ul className="border-t border-rule-quiet-on-raised">
        {signals.map((s) => (
          <SignalRow key={s.id} signal={s} />
        ))}
      </ul>

      {/* THE TWO READINGS THIS REPORT CANNOT SUPPLY. Declared, with the reason — "not available" with no
          reason cannot be told from "zero", and an approximation here would be worse than either. */}
      <div className="flex flex-col gap-2 px-6 py-3">
        {UNAVAILABLE_SIGNALS.map((gap) => (
          <NotAvailable key={gap.id} thing={gap.label} claim="deferred">
            {gap.reason}
          </NotAvailable>
        ))}
      </div>
    </section>
  );
}
