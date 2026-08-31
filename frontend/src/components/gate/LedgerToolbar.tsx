import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  BUCKETS,
  SORTS,
  activeFilterCount,
  type Bucket,
  type LedgerFilters,
  type SortKey,
} from "@/lib/ledger";
import type { CoherenceState } from "@/types";

/**
 * What makes a large flagged set tractable: the BUCKET TABS, a sort, four filters, and a progress readout
 * that survives the reviewer leaving.
 *
 * THE BUCKET TABS ARE THE STRUCTURAL IDEA, not a convenience. The ledger partitions on cohort breadth
 * BEFORE it sorts (see `partitionByBreadth`), because flag-first ordering alone spends 68% of the
 * reviewer's first attention on single-cohort rows — which are not harmonization at all. The default is
 * the cross-cohort bucket.
 *
 * AND THE OTHER BUCKET IS NEVER HIDDEN. It is 87% of the corpus on a real run and it holds real work: a
 * variable-to-CDE mapping is a result, just not a POOLING result. So it is a labelled, counted, one-click
 * destination that names what it holds — never a filtered-away default, and never described as failed,
 * erroneous or outlying. Presenting the cross-cohort rows as if they were the whole run is the failure
 * mode this tab exists to prevent.
 *
 * NO COMPLETION GATE ANYWHERE IN HERE. The progress readout REPORTS; it does not withhold. How much to
 * review is the reviewer's judgement call (D-09 revised), so nothing in this component can disable
 * Continue, and the readout is worded as a count rather than as a target.
 *
 * NO NUMERIC COHERENCE CONFIDENCE. The verdict filter is a closed four-state categorical. Sorting and
 * filtering on the state is in scope; a gradient, a percentage or a confidence meter is not, because no
 * such number is computed and the calibration to justify one does not exist yet.
 */

const BUCKET_COPY: Record<Bucket, { label: string; note: string }> = {
  "cross-cohort": {
    label: "Across cohorts",
    note:
      "Groups drawing on two or more of your dictionaries. This is pooling — the thing harmonization is " +
      "for — and it is where the coherence judge raises most of what it raises.",
  },
  "single-cohort": {
    label: "Within one cohort",
    note:
      "Groups whose variables all come from one dictionary. These are still results — each is a variable " +
      "mapped to a common data element — but they are a different job from pooling, and the two are " +
      "counted separately rather than blended.",
  },
};

/** The four states, in the triage order the ledger sorts by. */
const VERDICTS: { state: CoherenceState; label: string }[] = [
  { state: "split", label: "split" },
  { state: "qualify", label: "qualify" },
  { state: "not_judged", label: "not judged" },
  { state: "single", label: "checked" },
];

function Chip({
  active,
  onClick,
  children,
  ...rest
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
} & React.ComponentProps<"button">) {
  return (
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
  );
}

export interface LedgerToolbarProps {
  counts: Record<Bucket, number>;
  bucket: Bucket;
  onBucketChange: (bucket: Bucket) => void;
  sort: SortKey;
  onSortChange: (sort: SortKey) => void;
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
  sort,
  onSortChange,
  filters,
  onFiltersChange,
  allCohorts,
  reviewed,
  inScope,
  className,
}: LedgerToolbarProps) {
  const nActive = activeFilterCount(filters);
  const toggle = <T,>(list: T[], value: T): T[] =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

  return (
    <section
      data-testid="ledger-toolbar"
      aria-label="Narrow and order the concept groups"
      className={cn("flex flex-col gap-4", className)}
    >
      {/* The partition. Both buckets are always present and always counted. */}
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Which groups to show">
        {BUCKETS.map((b) => (
          <button
            key={b}
            type="button"
            data-testid="bucket-tab"
            data-bucket={b}
            aria-pressed={b === bucket}
            onClick={() => onBucketChange(b)}
            className={cn(
              "flex min-h-10 items-center gap-2 rounded-inner border px-4 py-2 text-sm font-semibold",
              b === bucket
                ? "border-accent-on-field bg-surface-raised text-on-raised shadow-card"
                : "border-rule-on-field text-on-field-muted",
            )}
          >
            {BUCKET_COPY[b].label}
            <span className="font-mono text-xs tabular-nums">{counts[b]}</span>
          </button>
        ))}
        {/* Derived, so the two counts can never be presented as if one were the whole run. */}
        <span className="text-xs text-on-field-muted">
          {counts["cross-cohort"] + counts["single-cohort"]} groups in total
        </span>
      </div>

      <p data-testid="bucket-note" className="max-w-[80ch] text-sm text-on-field-muted">
        {BUCKET_COPY[bucket].note}
      </p>

      <div className="flex flex-col gap-3 rounded-card bg-surface-raised px-6 py-4 shadow-card">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor="ledger-sort" className="text-xs font-semibold uppercase tracking-eyebrow text-on-raised-muted">
              Order
            </label>
            <select
              id="ledger-sort"
              value={sort}
              onChange={(e) => onSortChange(e.target.value as SortKey)}
              className="min-h-8 rounded-inner border border-rule-control-on-raised bg-surface-raised px-2 py-1 text-xs text-on-raised"
            >
              {SORTS.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>

          {/*
            THE PROGRESS READOUT. Both figures are derived from persisted decisions by the caller, never
            from component state — R6 requires a correction to be visible after a reload, and a counter in
            `useState` is gone the moment the page reloads. It reports and never withholds: no number here
            gates anything.
          */}
          <p data-testid="triage-progress" className="text-xs text-on-raised-muted">
            <span className="font-mono tabular-nums text-on-raised">{reviewed}</span> reviewed ·{" "}
            <span className="font-mono tabular-nums text-on-raised">{inScope}</span> in scope. Come back to
            the rest whenever — nothing expires, and nothing is waiting on a count.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <span className="text-xs font-semibold uppercase tracking-eyebrow text-on-raised-muted">
            Coherence
          </span>
          {VERDICTS.map((v) => (
            <Chip
              key={v.state}
              data-testid="filter-verdict"
              data-verdict={v.state}
              active={filters.verdicts.includes(v.state)}
              onClick={() => onFiltersChange({ ...filters, verdicts: toggle(filters.verdicts, v.state) })}
            >
              {v.label}
            </Chip>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <span className="text-xs font-semibold uppercase tracking-eyebrow text-on-raised-muted">Cohort</span>
          {allCohorts.map((c) => (
            <Chip
              key={c}
              data-testid="filter-cohort"
              data-cohort={c}
              active={filters.cohorts.includes(c)}
              onClick={() => onFiltersChange({ ...filters, cohorts: toggle(filters.cohorts, c) })}
            >
              {c}
            </Chip>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Chip
            data-testid="filter-touched"
            active={filters.touchedOnly}
            onClick={() => onFiltersChange({ ...filters, touchedOnly: !filters.touchedOnly })}
          >
            I changed it
          </Chip>
          <Chip
            data-testid="filter-in-scope"
            active={filters.inScopeOnly}
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
              {[...filters.verdicts, ...filters.cohorts].map((f) => (
                <span key={f} className="rounded-pill bg-surface-inset px-2 py-0.5 text-on-inset-muted">
                  {f === "not_judged" ? "not judged" : f === "single" ? "checked" : f}
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
        </div>
      </div>
    </section>
  );
}
