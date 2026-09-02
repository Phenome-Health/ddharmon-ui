import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { InfoTip } from "@/components/ui/info-tip";
import { COHERENCE_COPY } from "@/components/gate/CoherenceMark";
import { BUCKET_COPY } from "@/components/gate/BreadthFilter";
import { cn } from "@/lib/utils";
import { activeFilterCount, type Bucket, type LedgerFilters } from "@/lib/ledger";
import type { CoherenceState } from "@/types";

/**
 * What makes a large flagged set tractable: four filters, a progress readout that survives the reviewer
 * leaving, and the line that says which half of the run is on screen.
 *
 * NEITHER ORDERING NOR THE PARTITION IS A CONTROL IN HERE ANY MORE. Both went to the column headers, in
 * the same direction and on the same reasoning.
 *
 *  - The ORDER select — "Flagged first / Most cohorts first / Most variables first" — went when Bhargav
 *    read it beside the sortable headers Task 10 added: *"concept groups are sortable below so this is
 *    redundant."* Every preset it named is a header the reviewer can click.
 *  - The BUCKET TABS went at his next reading, on the strip itself: *"all this should be part of the
 *    column header sort/filter functionality."* The control is now `BreadthFilter`, on the Cohorts header.
 *
 * WHAT REMAINS HERE IS THE STATEMENT, AND IT IS LOAD-BEARING RATHER THAN DECORATIVE. The partition itself
 * has NOT moved and has not weakened: the ledger still partitions on cohort breadth BEFORE it sorts (see
 * `partitionByBreadth`, which records the measurement — flag-first ordering alone spends 68% of the
 * reviewer's first attention on single-cohort rows, which are not harmonization at all), and the
 * cross-cohort half still leads by default. But a partition whose only sign was a control folded into a
 * header would leave a reviewer reading 28 rows of 54 with nothing on screen saying so — which is exactly
 * the coverage lie the tabs existed to prevent, arrived at from the other direction. So both counts stay
 * visible without opening anything, the other half is one click away, and neither is described as failed,
 * erroneous or outlying. It is 87% of the corpus on a real run and it holds real work.
 *
 * NO COMPLETION GATE ANYWHERE IN HERE. The progress readout REPORTS; it does not withhold. How much to
 * review is the reviewer's judgement call (D-09 revised), so nothing in this component can disable
 * Continue, and the readout is worded as a count rather than as a target.
 *
 * NO NUMERIC COHERENCE CONFIDENCE. The verdict filter is a closed four-state categorical. Sorting and
 * filtering on the state is in scope; a gradient, a percentage or a confidence meter is not, because no
 * such number is computed and the calibration to justify one does not exist yet.
 */

/**
 * The four states, in the TRIAGE ORDER the ledger sorts by — which is this file's only claim about them.
 *
 * Their labels and their explanations come from `COHERENCE_COPY`, the register `CoherenceMark` owns and
 * the ledger cell renders. This file used to spell the labels out itself, and the active-filter summary
 * below spelled them a second time; with `CoherenceMark`'s that was THREE copies of the vocabulary a
 * reviewer filters by. The order is a genuine local fact; the words are not.
 */
const VERDICT_ORDER: CoherenceState[] = ["split", "qualify", "not_judged", "single"];

/** A state's label, from the one register. Used by the chips and by the active-filter summary. */
function verdictLabel(state: string): string {
  return COHERENCE_COPY[state as CoherenceState]?.label ?? state;
}

/**
 * A filter chip, and — since 08-14h — its own explanation.
 *
 * WHY THE CHIP IS THE TRIGGER RATHER THAN AN `InfoTip` BESIDE IT. `InfoTip` renders its own small ⓘ
 * button, which is right where an explanation hangs off a LABEL (the order select below uses it for
 * exactly that). Here there are a dozen chips, and parking an ⓘ next to each would double the control
 * count of the toolbar to explain it. The chip is already a `<button>`, so making it the trigger costs
 * no extra control and is strictly better on both required paths: Radix opens on FOCUS as well as hover
 * and wires `aria-describedby`, so the explanation reaches a keyboard user and a screen reader rather
 * than only a mouse. It is the same `Tooltip` primitive and the same `TooltipContent` styling `InfoTip`
 * is built from — not a second tooltip mechanism.
 */
function Chip({
  active,
  onClick,
  explain,
  children,
  ...rest
}: {
  active: boolean;
  onClick: () => void;
  /** What this filter does, in the reviewer's terms. Required: an unexplained filter is filtering blind. */
  explain: string;
  children: React.ReactNode;
} & React.ComponentProps<"button">) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        // Pill geometry at instrument level — a filter chip never takes the container radius.
        "inline-flex min-h-8 items-center gap-1 rounded-pill border px-3 py-1 text-xs font-semibold",
        active
          ? "border-accent-on-raised bg-surface-inset text-on-inset"
          : "border-rule-control-on-raised text-on-raised-muted",
      )}
      {...rest}
    >
      {children}
    </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs whitespace-normal text-left font-normal normal-case leading-relaxed">
        {explain}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * One labelled group of controls.
 *
 * IT EXISTS BECAUSE AN ANONYMOUS GROUP WAS A REAL DEFECT (08-14h Task 6). This file used to open a bare
 * `div` after the cohort chips holding "I changed it" and "Going forward" — two filters about the
 * REVIEWER'S OWN ACTIONS — with no heading of its own. They therefore sat directly beneath the COHORT
 * eyebrow and read as cohort filters, and with the cohort chips absent (a run that has not populated
 * cohorts yet) they were the ONLY things under that heading. Making the label a required prop is what
 * stops the next group being added without one.
 */
function FilterGroup({
  id,
  label,
  explain,
  children,
}: {
  id: string;
  label: string;
  /** What this whole group filters on. Hangs off the heading as the shipped ⓘ. */
  explain: string;
  children: React.ReactNode;
}) {
  return (
    <div
      data-testid="filter-group"
      data-group={id}
      role="group"
      aria-label={label}
      className="flex flex-wrap items-center gap-x-4 gap-y-2"
    >
      <span className="flex items-center gap-1 text-xs font-semibold uppercase tracking-eyebrow text-on-raised-muted">
        {label}
        <InfoTip text={explain} label={`What does ${label} filter?`} />
      </span>
      {children}
    </div>
  );
}

/** What each review toggle actually does. Both are about the reviewer, not about the data. */
const REVIEW_COPY = {
  touched:
    "Show only the groups you have changed — scoped in or out, or had a variable moved into or out of. It is a record of your own work, not a judgement the pipeline made.",
  inScope:
    "Show only the groups going on to Gate 2 to be matched against common data elements. Everything else stops here.",
};

export interface LedgerToolbarProps {
  counts: Record<Bucket, number>;
  bucket: Bucket;
  onBucketChange: (bucket: Bucket) => void;
  filters: LedgerFilters;
  onFiltersChange: (filters: LedgerFilters) => void;
  /** Every cohort in the run, in a stable order — the cohort filter's option list. */
  allCohorts: string[];
  /** How many groups the reviewer has decided something about, across BOTH buckets. */
  reviewed: number;
  /** How many groups are going forward, across BOTH buckets. */
  inScope: number;
  className?: string;
}

export function LedgerToolbar({
  counts,
  bucket,
  onBucketChange,
  filters,
  onFiltersChange,
  allCohorts,
  reviewed,
  inScope,
  className,
}: LedgerToolbarProps) {
  const nActive = activeFilterCount(filters);
  const otherBucket: Bucket = bucket === "cross-cohort" ? "single-cohort" : "cross-cohort";
  const toggle = <T,>(list: T[], value: T): T[] =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

  return (
    <section
      data-testid="ledger-toolbar"
      aria-label="Narrow and order the concept groups"
      className={cn("flex flex-col gap-4", className)}
    >
      {/*
        WHICH HALF IS ON SCREEN — a statement, and the one place both counts are visible without opening
        anything. The CONTROL is on the Cohorts column header now (`BreadthFilter`); this is what stops
        that control's move turning the partition into something a reviewer has to go looking for.

        The way across is a link inside the sentence rather than a second tab: it names the other half and
        its size, so pressing it is a choice rather than a discovery. Both counts are rendered from the
        same `counts` the control reads, so the two can never disagree.
      */}
      <p data-testid="bucket-note" className="max-w-[80ch] text-sm text-on-field-muted">
        Showing the <span className="font-mono tabular-nums text-on-field">{counts[bucket]}</span>{" "}
        {counts[bucket] === 1 ? "group" : "groups"} {BUCKET_COPY[bucket].short}, of{" "}
        <span className="font-mono tabular-nums text-on-field">
          {counts["cross-cohort"] + counts["single-cohort"]}
        </span>{" "}
        in this run. {BUCKET_COPY[bucket].note}{" "}
        <button
          type="button"
          data-testid="bucket-switch"
          onClick={() => onBucketChange(otherBucket)}
          className="font-semibold text-link-on-field underline underline-offset-2"
        >
          Show the {counts[otherBucket]} {counts[otherBucket] === 1 ? "group" : "groups"}{" "}
          {BUCKET_COPY[otherBucket].short} instead.
        </button>
      </p>

      <div className="flex flex-col gap-3 rounded-card bg-surface-raised px-6 py-4 shadow-card">
        {/*
          THE PROGRESS READOUT. Both figures are derived from persisted decisions by the caller, never from
          component state — R6 requires a correction to be visible after a reload, and a counter in
          `useState` is gone the moment the page reloads. It reports and never withholds: no number here
          gates anything.
        */}
        <p data-testid="triage-progress" className="text-xs text-on-raised-muted">
          <span className="font-mono tabular-nums text-on-raised">{reviewed}</span> reviewed ·{" "}
          <span className="font-mono tabular-nums text-on-raised">{inScope}</span> in scope. Come back to
          the rest whenever — nothing expires, and nothing is waiting on a count.
        </p>

        <FilterGroup
          id="coherence"
          label="Coherence"
          explain="What the coherence judge found when it read the group's variables together: whether they are one concept or several. Filtering on a state without knowing what it means is filtering blind, so each one explains itself."
        >
          {VERDICT_ORDER.map((state) => (
            <Chip
              key={state}
              data-testid="filter-verdict"
              data-verdict={state}
              active={filters.verdicts.includes(state)}
              // THE JUDGE'S OWN WORDS, from the register the ledger cell renders — never a re-gloss.
              // `qualify` and `checked` in particular say something specific about what the judge found.
              explain={COHERENCE_COPY[state].explain}
              onClick={() => onFiltersChange({ ...filters, verdicts: toggle(filters.verdicts, state) })}
            >
              {COHERENCE_COPY[state].label}
            </Chip>
          ))}
        </FilterGroup>

        {/* NO HEADING OVER AN EMPTY GROUP. A COHORT eyebrow with nothing under it claims the run has
            cohort filters, and — before 08-14h — lent its name to whatever happened to render next. */}
        {allCohorts.length > 0 && (
          <FilterGroup
            id="cohort"
            label="Cohort"
            explain="Show only groups that pool at least one variable from the dictionaries you pick. A fact about where the variables came from, not a judgement about the group."
          >
            {allCohorts.map((c) => (
              <Chip
                key={c}
                data-testid="filter-cohort"
                data-cohort={c}
                active={filters.cohorts.includes(c)}
                explain={`Show only groups containing at least one variable from ${c}. Combining cohorts widens the set rather than narrowing it: a group qualifies if it draws on any one of them.`}
                onClick={() => onFiltersChange({ ...filters, cohorts: toggle(filters.cohorts, c) })}
              >
                {c}
              </Chip>
            ))}
          </FilterGroup>
        )}

        <FilterGroup
          id="review"
          label="Your review"
          explain="Your own work on this run — what you have changed and what you are sending on. Neither of these is a property of the data or a judgement the pipeline made, which is why they are not filed under Coherence or Cohort."
        >
          <Chip
            data-testid="filter-touched"
            active={filters.touchedOnly}
            explain={REVIEW_COPY.touched}
            onClick={() => onFiltersChange({ ...filters, touchedOnly: !filters.touchedOnly })}
          >
            I changed it
          </Chip>
          <Chip
            data-testid="filter-in-scope"
            active={filters.inScopeOnly}
            explain={REVIEW_COPY.inScope}
            onClick={() => onFiltersChange({ ...filters, inScopeOnly: !filters.inScopeOnly })}
          >
            Going forward
          </Chip>

          {/* ACTIVE FILTERS ARE VISIBLE. An invisible filter is how a reviewer concludes a run has no
              rows in it — the empty state below says the same thing, but only once they have scrolled to
              nothing. */}
          {nActive > 0 && (
            <span data-testid="active-filters" className="flex flex-wrap items-center gap-2 text-xs text-on-raised">
              <span className="font-semibold">
                {nActive} {nActive === 1 ? "filter" : "filters"} on:
              </span>
              {/* READ FROM THE ONE REGISTER. This line used to re-spell "not judged" and "checked" in an
                  inline ternary — a second copy of the labels three lines from the first. */}
              {filters.verdicts.map((f) => (
                <span key={f} className="rounded-pill bg-surface-inset px-2 py-0.5 text-on-inset-muted">
                  {verdictLabel(f)}
                </span>
              ))}
              {filters.cohorts.map((f) => (
                <span key={f} className="rounded-pill bg-surface-inset px-2 py-0.5 text-on-inset-muted">
                  {f}
                </span>
              ))}
              {filters.touchedOnly && (
                <span className="rounded-pill bg-surface-inset px-2 py-0.5 text-on-inset-muted">I changed it</span>
              )}
              {filters.inScopeOnly && (
                <span className="rounded-pill bg-surface-inset px-2 py-0.5 text-on-inset-muted">going forward</span>
              )}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                data-testid="clear-filters"
                onClick={() => onFiltersChange({ verdicts: [], cohorts: [], touchedOnly: false, inScopeOnly: false })}
                className="h-6 gap-1 px-2 text-xs"
              >
                <X aria-hidden="true" className="h-3 w-3" />
                Clear
              </Button>
            </span>
          )}
        </FilterGroup>
      </div>
    </section>
  );
}
