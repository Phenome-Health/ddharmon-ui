import { cn } from "@/lib/utils";
import { LEDGER_GRID } from "@/components/gate/LedgerRow";

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
}

/** Gate 1's head: `Concept · Coherence · Cohorts · Vars · Gate 2+` (UI-SPEC §7.3.3). */
export const GATE1_LEDGER_COLUMNS: LedgerColumn[] = [
  { label: "Concept" },
  { label: "Coherence" },
  { label: "Cohorts" },
  { label: "Vars", align: "right" },
  { label: "Gate 2+", align: "right" },
];

export function Ledger({
  columns,
  children,
  sum,
  caption,
  className,
}: {
  columns: LedgerColumn[];
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
      {/* The head is presentational: the rows carry their own accessible content, and announcing five
          column labels before every row would bury it. */}
      <div
        aria-hidden="true"
        className={cn(
          LEDGER_GRID,
          "border-b border-rule-on-raised px-6 py-3 text-xs font-semibold uppercase tracking-eyebrow text-on-raised-muted",
        )}
      >
        {/* The leading checkbox track has no header. */}
        <span />
        {columns.map((c) => (
          <span key={c.label} className={c.align === "right" ? "text-right" : undefined}>
            {c.label}
          </span>
        ))}
        {/* …and neither does the trailing chevron track. */}
        <span />
      </div>
      <ul className="flex flex-col">{children}</ul>
      {sum && <div className="border-t border-rule-on-raised px-6 py-4">{sum}</div>}
    </section>
  );
}
