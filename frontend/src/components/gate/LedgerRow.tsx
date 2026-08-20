import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { formatUsd } from "@/lib/estimate";

/**
 * One ledger row — an expandable ruled grid row, NOT a table row.
 *
 * WHY NOT THE `Table` PRIMITIVE. Rows expand, carry a left spine and a right-aligned money column; a
 * table gives none of those and fights all three. `Collapsible` plus CSS grid gives all three and keeps
 * the columns aligned across rows, which is the whole point of a ledger (UI-SPEC §6).
 *
 * THE SPINE ENCODES STATE, and the precedence is not cosmetic:
 *   amber  = an unresolved judgment (the judge flagged this group and nobody has resolved it)
 *   accent = you changed it
 *   AMBER OUTRANKS THE ACCENT when both apply — a reviewer who has edited a flagged group still has an
 *   open judgment to resolve, and showing "you touched this" instead would report the wrong thing.
 *
 * GEOMETRY (UI-SPEC §4). A ledger row NEVER takes the container radius: brand geometry at container level,
 * instrument discipline at data level. The container (`Ledger`) carries `rounded-card`; nothing in here does.
 *
 * OVERFLOW. `content-visibility: auto` with a size estimate, so several hundred rows cost the browser
 * almost nothing to skip. No virtualization package: the phase adds no dependency, and a few hundred
 * expandable rows does not justify one (UI-SPEC §11).
 */

/** The normalised grid tracks (UI-SPEC §2): checkbox · concept · coherence · cohorts · vars · money · chevron. */
export const LEDGER_GRID = "grid grid-cols-[24px_1fr_92px_76px_64px_80px_24px] items-start gap-2";

export interface LedgerRowProps {
  /** Stable row id, surfaced so a test names a row rather than a position. */
  rowId: string;
  /** The row's title — for a Gate 1 row, the generated concept name. */
  title: React.ReactNode;
  /** One line under the title: provenance, flags. */
  subtitle?: React.ReactNode;
  /** The coherence cell. */
  coherence?: React.ReactNode;
  /** The cohort coverage strip. */
  coverage?: React.ReactNode;
  /** The variable count. Mono — the pipeline computed it. */
  count?: React.ReactNode;
  /** The money column. */
  cost?: number;
  selected?: boolean;
  onSelectedChange?: (selected: boolean) => void;
  /** True while the judge's verdict on this row is unresolved — the amber spine. */
  unresolved?: boolean;
  /** True once the reviewer has changed something on this row — the accent spine. */
  changed?: boolean;
  /** The expanded body: full membership, drop zones, the carve proposal. */
  children?: React.ReactNode;
  className?: string;
}

export function LedgerRow({
  rowId,
  title,
  subtitle,
  coherence,
  coverage,
  count,
  cost,
  selected = false,
  onSelectedChange,
  unresolved = false,
  changed = false,
  children,
  className,
}: LedgerRowProps) {
  const [open, setOpen] = useState(false);
  // Amber outranks the accent. Both, and amber wins — see the docstring.
  const spine = unresolved ? "border-l-status-warn" : changed ? "border-l-accent-action" : "border-l-transparent";
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      asChild
    >
      <li
        data-testid="ledger-row"
        data-row-id={rowId}
        data-spine={unresolved ? "unresolved" : changed ? "changed" : "none"}
        className={cn(
          "border-b border-l-4 border-b-rule-quiet-on-raised last:border-b-0",
          // Hundreds of rows: let the browser skip the ones nobody is looking at. `contain-intrinsic-size`
          // keeps the scrollbar honest while they are skipped.
          "[content-visibility:auto] [contain-intrinsic-size:auto_56px]",
          spine,
          className,
        )}
      >
        <div className={cn(LEDGER_GRID, "min-h-8 px-6 py-3")}>
          <Checkbox
            checked={selected}
            onCheckedChange={(v) => onSelectedChange?.(v === true)}
            aria-label={`Include ${typeof title === "string" ? title : rowId} in the next gate`}
            className="mt-1"
          />
          <div className="flex min-w-0 flex-col gap-1">
            <span className="truncate text-sm font-semibold text-on-raised">{title}</span>
            {subtitle && <span className="text-xs text-on-raised-muted">{subtitle}</span>}
          </div>
          <div className="flex items-start">{coherence}</div>
          <div className="flex items-start">{coverage}</div>
          <span className="text-right font-mono text-xs tabular-nums text-on-raised-muted">{count}</span>
          <span className="text-right font-mono text-sm tabular-nums text-on-raised">
            {cost === undefined ? "" : formatUsd(cost)}
          </span>
          <CollapsibleTrigger
            // An icon-only control names the ACTION AND ITS OBJECT. "Expand" alone tells a screen-reader
            // user nothing about which of four hundred rows they are on.
            aria-label={`${open ? "Collapse" : "Expand"} ${typeof title === "string" ? title : rowId}`}
            className="flex h-6 w-6 items-center justify-center rounded-md text-on-raised-muted"
          >
            <ChevronDown
              aria-hidden="true"
              className={cn("h-4 w-4 transition-transform", open && "rotate-180")}
            />
          </CollapsibleTrigger>
        </div>
        <CollapsibleContent>
          {/* The expanded body renders the FULL, uncapped membership: a regroup verb is unimplementable
              against a partial sample (UI-SPEC §0.1's member-cap rule). */}
          <div className="flex flex-col gap-3 border-t border-rule-quiet-on-raised px-6 py-4">{children}</div>
        </CollapsibleContent>
      </li>
    </Collapsible>
  );
}
