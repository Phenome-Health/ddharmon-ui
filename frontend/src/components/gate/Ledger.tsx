import { cn } from "@/lib/utils";
import { LEDGER_GRID } from "@/components/gate/LedgerRow";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { ariaSortFor, type ColumnSort } from "@/lib/column-sort";

/**
 * The ledger container — a ruled account with a right-aligned money column and a real sum.
 *
 * IT IS A LEDGER, NOT A LIST. Both a correction and a scope decision post to the same money column; that
 * is the point of the metaphor and the reason the column is right-aligned, mono and tabular. A reviewer
 * scans down it.
 *
 * GEOMETRY (UI-SPEC §4). The CONTAINER always takes the container radius and the single elevation token —
 * it is a paper surface floating on the ground. Its ROWS never do. That split is the identity's rule
 * carried into a data screen: brand geometry at container level, instrument discipline at data level.
 *
 * THE HEAD is eyebrow type in the muted role, not the faint one: `--faint` measures 2.95:1 on paper, which
 * is fine for a hairline and not fine for a column header (UI-SPEC §5.5).
 */

export interface LedgerColumn {
  /** The visible column label. Shorten a label rather than shrinking the type (UI-SPEC §3.1). */
  label: string;
  /** Right-align a numeric column so the digits line up under the header. */
  align?: "left" | "right";
  /**
   * Makes the header a sort control (08-16c Task 10). A column WITHOUT one stays plain text — that is how
   * "Gate 2+" opts out, since every row carries the same per-group price and sorting it would be a
   * control that visibly does nothing.
   */
  sortKey?: string;
  /**
   * A FILTER CONTROL BESIDE THE SORT, on the columns that have one (08-16c review, item B).
   *
   * Bhargav, on Gate 1's bucket tabs: *"all this should be part of the column header sort/filter
   * functionality."* It is a SLOT rather than a filter model, deliberately: this component knows what a
   * ledger column is and has no business knowing what cohort breadth is. Gate 1 passes its own control;
   * the three gates that render a ledger without one pass nothing and are unchanged.
   */
  filter?: React.ReactNode;
}

/** Gate 1's head: `Concept · Coherence · Cohorts · Vars · Gate 2+` (UI-SPEC §7.3.3). */
export const GATE1_LEDGER_COLUMNS: LedgerColumn[] = [
  { label: "Concept", sortKey: "concept" },
  { label: "Coherence", sortKey: "verdict" },
  { label: "Cohorts", sortKey: "cohorts" },
  { label: "Vars", align: "right", sortKey: "vars" },
  // No `sortKey`: one price for every row, so there is nothing to order by.
  { label: "Gate 2+", align: "right" },
];

export function Ledger({
  columns,
  children,
  sum,
  caption,
  className,
  sort = null,
  onSort,
}: {
  columns: LedgerColumn[];
  /** The active column sort, or null for the ledger's own documented default order. */
  sort?: ColumnSort<string> | null;
  /** Omit to leave every header plain text — the ledger is then not sortable at all. */
  onSort?: (key: string) => void;
  /** `LedgerRow` children, or a `GateEmptyState` when there are none. */
  children: React.ReactNode;
  /** The sum block — realized above in-scope above whole-corpus (UI-SPEC §7.3.6). */
  sum?: React.ReactNode;
  /** An accessible name for the whole account, e.g. `Concept groups`. */
  caption: string;
  className?: string;
}) {
  return (
    <section
      data-testid="ledger"
      aria-label={caption}
      className={cn("flex flex-col rounded-card bg-surface-raised shadow-card", className)}
    >
      {/*
        THE HEAD IS NOT PRESENTATIONAL ANY MORE, and the `aria-hidden` it carried is gone (08-16c review,
        item B).

        It was marked hidden when it was five words of static text, on the reasoning that announcing the
        column labels before every row would bury the rows' own content. That reasoning stopped holding
        the moment Task 10 put SORT BUTTONS in here, and it fails outright now that the breadth filter
        joins them: a focusable control inside an `aria-hidden` subtree is a control no assistive
        technology can reach at all — the labels stay drawn, the buttons become unusable, and nothing on
        screen says so. This screen already holds that a verb with no keyboard path is a regression; a
        verb with no ACCESSIBLE path is the same defect one step further on.

        The cost is the one the original note named — a screen reader now meets five column labels once,
        in reading order, before the list. Once, ahead of a list, is what a column header is for.
      */}
      <div
        className={cn(
          LEDGER_GRID,
          "border-b border-rule-on-raised px-6 py-3 text-xs font-semibold uppercase tracking-eyebrow text-on-raised-muted",
        )}
      >
        {/* The leading checkbox track has no header. */}
        <span />
        {columns.map((c) => {
          const sortable = !!c.sortKey && !!onSort;
          const active = sortable && sort?.key === c.sortKey;
          const Icon = active && sort ? (sort.dir === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown;
          return (
            <span
              key={c.label}
              data-testid={`ledger-column-${c.sortKey ?? c.label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
              // Announced, not merely drawn: a screen-reader user is told which column is sorting and
              // which way, on the header itself.
              role={sortable ? "columnheader" : undefined}
              aria-sort={sortable ? ariaSortFor(sort, c.sortKey!) : undefined}
              className={cn(
                "flex min-w-0 items-center gap-1",
                c.align === "right" && "justify-end",
              )}
            >
              {sortable ? (
                <button
                  type="button"
                  data-testid={`ledger-sort-${c.sortKey}`}
                  data-active={active ? "true" : "false"}
                  onClick={() => onSort(c.sortKey!)}
                  className={cn(
                    "inline-flex min-w-0 items-center gap-1 font-semibold hover:text-accent-on-raised",
                    c.align === "right" && "flex-row-reverse",
                  )}
                >
                  <span className="truncate">{c.label}</span>
                  <Icon
                    aria-hidden="true"
                    className={cn("h-3 w-3 shrink-0", active ? "text-accent-on-raised" : "text-on-raised-muted")}
                  />
                </button>
              ) : (
                c.label
              )}
              {/* The column's own filter, where it has one — a sibling of the sort rather than a second
                  meaning loaded onto it, so one click still sorts and nothing has to be discovered. */}
              {c.filter}
            </span>
          );
        })}
        {/* …and neither does the trailing chevron track. */}
        <span />
      </div>
      <ul className="flex flex-col">{children}</ul>
      {sum && <div className="border-t border-rule-on-raised px-6 py-4">{sum}</div>}
    </section>
  );
}
