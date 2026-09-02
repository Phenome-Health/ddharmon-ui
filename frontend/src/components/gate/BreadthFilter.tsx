import { ListFilter } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { BUCKETS, type Bucket } from "@/lib/ledger";

/**
 * WHICH HALF OF THE LEDGER IS ON SCREEN, as a control on the Cohorts column header (08-16c review, item B).
 *
 * Bhargav, on the "Across cohorts 28 / Within one cohort 26" strip above the ledger: *"all this should be
 * part of the column header sort/filter functionality."* Consistent with his earlier call to delete the
 * ORDER select — he is consolidating the ledger's controls onto the headers it already sorts by, and the
 * partition is a statement about the COHORTS column if it is a statement about anything.
 *
 * WHAT MOVED IS THE CONTROL. WHAT DID NOT MOVE IS THE PARTITION, and keeping those apart is the whole of
 * this change.
 *
 * `partitionByBreadth` records a MEASUREMENT, not a preference: on the full-5 artifact the judge flags 351
 * of 1901 groups and **237 of those 351 are single-cohort**, so flag-first ordering ALONE spends 68% of
 * the reviewer's first attention on rows that are not harmonization at all. The judge is not the problem —
 * it fires on 45% of cross-cohort groups against 14% of single-cohort ones, which is a good SIGNAL and a
 * bad PARTITION. So the ledger still partitions on the structural fact FIRST and orders flag-first inside
 * it, and the cross-cohort half still leads without anyone choosing it.
 *
 * THIS IS THEREFORE NOT A `LedgerFilters` ENTRY, and the difference is not cosmetic. A filter is something
 * a reviewer turns ON, can clear to nothing, and which `activeFilterCount` reports; the partition is
 * always in exactly one of two states and is never off. Folding it in would also collapse the ledger's two
 * empty states into one — "no group matches this filter" (the reviewer's own doing, cleared by clearing
 * it) and "no group in this run spans more than one cohort" (a finding about the corpus, which names the
 * other half and goes there in one click) are different facts with different recoveries.
 *
 * AND THE OTHER HALF IS STILL NEVER HIDDEN. It is 87% of the corpus on a real run and it holds real work —
 * a variable-to-CDE mapping is a result, just not a POOLING result. A control that vanished into a menu
 * would leave a reviewer reading 28 rows of 54 with nothing on screen saying so, which is exactly the
 * coverage lie the tab strip existed to prevent, reached by a different route. So the counts and the way
 * across stay on screen in the ledger's own note (`LedgerToolbar`), and this control carries them again
 * where the choice is made. Neither says "good".
 */

export const BUCKET_COPY: Record<Bucket, { label: string; short: string; note: string }> = {
  "cross-cohort": {
    label: "Across cohorts",
    short: "across cohorts",
    note:
      "Groups drawing on two or more of your dictionaries. This is pooling — the thing harmonization is " +
      "for — and it is where the coherence judge raises most of what it raises.",
  },
  "single-cohort": {
    label: "Within one cohort",
    short: "within one cohort",
    note:
      "Groups whose variables all come from one dictionary. These are still results — each is a variable " +
      "mapped to a common data element — but they are a different job from pooling, and the two are " +
      "counted separately rather than blended.",
  },
};

export function BreadthFilter({
  bucket,
  counts,
  onChange,
  className,
}: {
  bucket: Bucket;
  counts: Record<Bucket, number>;
  onChange: (bucket: Bucket) => void;
  className?: string;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="breadth-filter"
          data-bucket={bucket}
          // An icon-only control names the ACTION AND ITS OBJECT, and here it also has to name the CURRENT
          // state: the trigger is the only thing in the header saying which half of the corpus is on
          // screen, so a bare "filter" would leave that unsaid to exactly the users who cannot see it.
          aria-label={`Cohort breadth — showing the ${counts[bucket]} groups ${BUCKET_COPY[bucket].short}. Choose which half of the run the ledger shows.`}
          title="Which half of the run to show"
          className={cn(
            "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-on-raised-muted hover:text-accent-on-raised",
            className,
          )}
        >
          <ListFilter aria-hidden="true" className="h-3 w-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-2">
        <div role="radiogroup" aria-label="Which half of the run to show" className="flex flex-col gap-1">
          {BUCKETS.map((b) => (
            <button
              key={b}
              type="button"
              role="radio"
              aria-checked={b === bucket}
              data-testid="breadth-option"
              data-bucket={b}
              onClick={() => onChange(b)}
              className={cn(
                "flex flex-col gap-1 rounded-inner border px-3 py-2 text-left",
                b === bucket
                  ? "border-accent-on-raised bg-surface-inset"
                  : "border-rule-control-on-raised hover:bg-surface-inset",
              )}
            >
              <span className="flex items-baseline gap-2 text-sm font-semibold normal-case tracking-normal text-on-raised">
                {BUCKET_COPY[b].label}
                {/* COUNTED IN THE MENU TOO, so the choice is made against a number rather than a name. */}
                <span className="font-mono text-xs tabular-nums text-on-raised-muted">{counts[b]}</span>
              </span>
              <span className="text-xs font-normal normal-case leading-relaxed tracking-normal text-on-raised-muted">
                {BUCKET_COPY[b].note}
              </span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
