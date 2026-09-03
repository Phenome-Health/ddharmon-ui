import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { COHERENCE_COPY } from "@/components/gate/CoherenceMark";
import { cn } from "@/lib/utils";
import type { CoherenceState } from "@/types";

/**
 * Gate 1's narrowing bar — the prod Review-queue toolbar (`dashboard.tsx`), lifted onto this screen at
 * Bhargav's direction ("lift it wholesale"), and then folded into the master-detail sidebar's header.
 *
 * ONE COMPACT ROW: a title with a live count, the concept search, a Cross-cohort-only toggle, and a single
 * coherence-state select. This REPLACED a dozen filter chips in labelled groups plus a breadth partition
 * folded onto the Cohorts column header — that was Gate 1's own evolution; this is prod's shape, which the
 * reviewer already knows from the shipped dashboard. The SORT still lives on the column headers (shared
 * `lib/column-sort.ts`), unchanged — only the narrowing controls are here.
 *
 * THE COHERENCE SELECT IS GATE 1's ANSWER TO PROD's VERDICT SELECT. Prod filters on adopt/refine/novel —
 * the assignment verdicts, which do not exist until Gate 2. Gate 1's equivalent is the coherence judge's
 * state, so the options are the four `CoherenceState`s (plus "all"), single-select, from the one register
 * (`COHERENCE_COPY`) the ledger cell also reads.
 */

/** The coherence states in triage order — the select's options after "all". A closed categorical. */
const VERDICT_ORDER: CoherenceState[] = ["split", "qualify", "not_judged", "single"];

export interface LedgerToolbarProps {
  /**
   * The concept search (a `TermSearch`) — kept as a slot. It takes a LIST of terms and a term matching
   * nothing is a coverage finding about the run, neither of which this bar has any business owning.
   */
  search?: React.ReactNode;
  /** How many groups are currently on screen — the count beside the title. */
  count: number;
  /** Show only groups pooled from 2+ cohorts (the harmonization subset). Off shows every group. */
  crossCohortOnly: boolean;
  onCrossCohortOnlyChange: (value: boolean) => void;
  /** The single selected coherence state, or "all". */
  verdict: CoherenceState | "all";
  onVerdictChange: (value: CoherenceState | "all") => void;
  className?: string;
}

export function LedgerToolbar({
  search,
  count,
  crossCohortOnly,
  onCrossCohortOnlyChange,
  verdict,
  onVerdictChange,
  className,
}: LedgerToolbarProps) {
  return (
    <section
      data-testid="ledger-toolbar"
      aria-label="Narrow the concept groups"
      className={cn("flex flex-col gap-3", className)}
    >
      <div className="flex flex-wrap items-center gap-2">
        {search}
        <Button
          type="button"
          variant={crossCohortOnly ? "secondary" : "outline"}
          size="sm"
          data-testid="cross-cohort-toggle"
          aria-pressed={crossCohortOnly}
          className={cn("h-8", crossCohortOnly ? "text-accent-on-raised" : "text-on-raised-muted")}
          onClick={() => onCrossCohortOnlyChange(!crossCohortOnly)}
          title="Show only concepts pooled from 2+ cohorts (the harmonization subset)"
        >
          Cross-cohort only
        </Button>
        <Select value={verdict} onValueChange={(v) => onVerdictChange(v as CoherenceState | "all")}>
          <SelectTrigger className="h-8 w-40" data-testid="verdict-select">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All states</SelectItem>
            {VERDICT_ORDER.map((state) => (
              <SelectItem key={state} value={state}>
                {COHERENCE_COPY[state].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="ml-auto text-xs text-on-raised-muted">
          <span className="font-mono tabular-nums text-on-raised">{count}</span>{" "}
          {count === 1 ? "group" : "groups"}
        </span>
      </div>
    </section>
  );
}
