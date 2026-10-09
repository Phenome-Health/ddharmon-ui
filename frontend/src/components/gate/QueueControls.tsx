import { ArrowDownWideNarrow, ArrowUpNarrowWide, Search, SlidersHorizontal, X } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { type ColumnSort } from "@/lib/column-sort";
import { cohortInitials, type TickedOfShown } from "@/lib/queue-controls";
import { cn } from "@/lib/utils";

/**
 * THE REVIEW QUEUE'S CONTROLS — one set, worn by the side panel on Gates 1, 2 and 3 (08-30b).
 *
 * Bhargav settled these over five rounds of a clickable design lab built on the app's own tokens; the lab's
 * final template is the spec and its class strings are lifted here verbatim where they fit. Each gate brings
 * its own vocabulary (Gate 1 filters on the coherence state, Gate 2 on the verdict, Gate 3 on arithmetic
 * recodes) through the slots; the controls themselves — and so how the queue FEELS — are the same everywhere.
 */

// --- search, with the filters inside it ---------------------------------------------------------------------

/**
 * THE SEARCH FIELD, WITH THE FILTER MENU INSIDE IT (lab rounds 3–5, the Gmail pattern).
 *
 * Inset, a search icon, its own clear button — the browser's native × is hidden so there is one, not two —
 * and NO "/" shortcut (round 2). The sliders button at the right opens the gate's filter menu; a dot on it says
 * a filter is on even with the menu closed, and the chips under the field say which.
 */
export function QueueSearch({
  value,
  onChange,
  placeholder,
  ariaLabel,
  filters,
  activeFilters = 0,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  ariaLabel: string;
  /** The gate's filter menu (`FilterSection`s). Omitted, the field is a plain search. */
  filters?: React.ReactNode;
  /** How many filters are on — lights the dot on the filter button. */
  activeFilters?: number;
}) {
  const field = (
    <div className="relative min-w-0 flex-1">
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-on-raised-faint"
      />
      <input
        type="search"
        data-testid="term-search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel}
        className={cn(
          "peer h-8 w-full rounded-inner border border-transparent bg-surface-inset pl-8 text-sm text-on-raised placeholder:text-on-raised-faint focus:border-rule-control-on-raised focus:bg-surface-raised focus-visible:outline-none [&::-webkit-search-cancel-button]:appearance-none",
          filters ? "pr-16" : "pr-8",
        )}
      />
      <button
        type="button"
        data-testid="search-clear"
        aria-label="Clear search"
        onClick={() => onChange("")}
        className={cn(
          "absolute top-1/2 grid h-5 w-5 -translate-y-1/2 place-content-center rounded-full text-on-raised-faint peer-placeholder-shown:hidden hover:bg-surface-inset-strong hover:text-on-raised",
          filters ? "right-9" : "right-2",
        )}
      >
        <X aria-hidden="true" className="h-3 w-3" strokeWidth={2.5} />
      </button>
      {filters && (
        <PopoverTrigger asChild>
          <button
            type="button"
            data-testid="filter-open"
            aria-label={activeFilters > 0 ? `Filters (${activeFilters} on)` : "Filters"}
            title="Filter"
            className={cn(
              "absolute right-1 top-1/2 grid h-6 w-7 -translate-y-1/2 place-content-center rounded-inner transition-colors",
              activeFilters > 0
                ? "text-accent-on-raised"
                : "text-on-raised-muted hover:bg-surface-inset-strong hover:text-on-raised",
            )}
          >
            <SlidersHorizontal aria-hidden="true" className="h-3.5 w-3.5" />
            {activeFilters > 0 && (
              <span
                data-testid="filter-dot"
                aria-hidden="true"
                className="absolute right-0 top-0 h-1.5 w-1.5 rounded-full bg-accent-action"
              />
            )}
          </button>
        </PopoverTrigger>
      )}
    </div>
  );
  if (!filters) return <div className="flex">{field}</div>;
  return (
    <Popover>
      <PopoverAnchor asChild>
        <div className="flex">{field}</div>
      </PopoverAnchor>
      <PopoverContent
        align="end"
        data-testid="filter-menu"
        // Picking keeps it open — several filters are set in one visit (lab round 3); Escape or a click
        // outside closes it.
        // w-80, not the lab's w-72: the app's states are longer than the lab's ("Not judged"), and each sits in the
        // first of two columns so its count lines up with the first cohort column.
        className="w-80 rounded-inner border border-rule-on-raised bg-surface-raised p-1.5 text-on-raised shadow-card"
      >
        {filters}
      </PopoverContent>
    </Popover>
  );
}

/** One titled block of the filter menu. Sections after the first are ruled off from the one above. */
export function FilterSection({
  title,
  lead,
  hint,
  first = false,
  columns = 1,
  children,
}: {
  title: string;
  /** A box that belongs to the section but not to its grid (Cohorts' "Cross-cohort only"). */
  lead?: React.ReactNode;
  hint?: string;
  first?: boolean;
  /** Cohorts lay out in two columns; a gate's own vocabulary stays in the first, so its counts line up. */
  columns?: 1 | 2;
  children: React.ReactNode;
}) {
  return (
    <div role="group" aria-label={title}>
      {!first && <div className="my-1 border-t border-rule-quiet-on-raised" />}
      <p className="px-2 pb-0.5 pt-1 text-xs font-semibold text-on-raised-muted">{title}</p>
      {lead}
      {hint && <p className="px-2 pb-0.5 pt-1.5 text-xs text-on-raised-faint">{hint}</p>}
      <div className={cn("grid", columns === 2 ? "grid-cols-2" : "grid-cols-2 [&>*]:col-start-1")}>{children}</div>
    </div>
  );
}

/** One box in the filter menu: a checkbox, its label, and how many rows ticking it would keep. */
export function FilterCheck({
  testid,
  checked,
  onChange,
  label,
  count,
  countTestid,
  className,
}: {
  testid: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: React.ReactNode;
  count?: number;
  countTestid?: string;
  className?: string;
}) {
  return (
    <label
      className={cn(
        "flex w-full cursor-pointer items-center gap-2 rounded-inner px-2 py-1.5 text-left text-sm hover:bg-surface-inset",
        className,
      )}
    >
      <Checkbox data-testid={testid} checked={checked} onCheckedChange={(v) => onChange(v === true)} />
      <span className="min-w-0 truncate" title={typeof label === "string" ? label : undefined}>
        {label}
      </span>
      {count !== undefined && (
        <span data-testid={countTestid} className="ml-auto font-mono text-xs tabular-nums text-on-raised-faint">
          {count}
        </span>
      )}
    </label>
  );
}

export interface FilterChip {
  key: string;
  label: string;
  onRemove: () => void;
}

/** Every filter that is on, as a removable chip under the search, then one Clear for all of them. */
export function FilterChips({ chips, onClear }: { chips: FilterChip[]; onClear: () => void }) {
  if (chips.length === 0) return null;
  return (
    <div data-testid="filter-chips" className="flex flex-wrap items-center gap-1.5">
      {chips.map((c) => (
        <span
          key={c.key}
          data-testid="filter-chip"
          data-key={c.key}
          className="inline-flex h-6 items-center gap-1 rounded-pill bg-accent-action/10 pl-2.5 pr-1 text-xs font-semibold text-accent-on-raised"
        >
          {c.label}
          <button
            type="button"
            aria-label={`Remove ${c.label}`}
            onClick={c.onRemove}
            className="grid h-4 w-4 place-content-center rounded-full hover:bg-accent-action/15"
          >
            <X aria-hidden="true" className="h-3 w-3" strokeWidth={2.5} />
          </button>
        </span>
      ))}
      <button
        type="button"
        data-testid="filter-clear"
        onClick={onClear}
        className="ml-1 text-xs font-semibold text-link-on-raised hover:underline"
      >
        Clear
      </button>
    </div>
  );
}

// --- sort ---------------------------------------------------------------------------------------------------

/**
 * SORT AS A SEGMENTED CONTROL plus a direction button, and no "Sort" label (lab rounds 1–2).
 *
 * The same shared `ColumnSort` state the old header strip drove, so a group orders identically everywhere.
 * `null` is still each screen's OWN documented default order (Gate 1's is flag-first), so with no column
 * picked no segment claims to be active, and the direction button — which reverses a column — waits for one.
 */
export function SegmentedSort<K extends string>({
  cols,
  sort,
  onSort,
  onFlip,
}: {
  cols: { k: K; label: string }[];
  sort: ColumnSort<K> | null;
  /** Pick a column; re-picking the active one reverses it (`toggleSort`). */
  onSort: (key: K) => void;
  onFlip: () => void;
}) {
  const asc = sort?.dir !== "desc";
  return (
    <div data-testid="segmented-sort" className="flex shrink-0 items-center gap-1.5 text-xs">
      <div role="group" aria-label="Sort by" className="inline-flex rounded-inner border border-rule-control-on-raised p-0.5">
        {cols.map((c) => {
          const on = sort?.key === c.k;
          return (
            <button
              key={c.k}
              type="button"
              data-testid={`sort-${c.k}`}
              aria-pressed={on}
              onClick={() => onSort(c.k)}
              className={cn(
                "rounded-[5px] px-1.5 py-0.5",
                on ? "bg-surface-inset-strong font-semibold text-on-raised" : "text-on-raised-muted hover:text-on-raised",
              )}
            >
              {c.label}
            </button>
          );
        })}
      </div>
      <button
        type="button"
        data-testid="sort-direction"
        disabled={!sort}
        onClick={onFlip}
        aria-label={!sort ? "Pick a column to sort by" : asc ? "Ascending — reverse" : "Descending — reverse"}
        title={!sort ? "Pick a column to sort by" : asc ? "Ascending: click to reverse" : "Descending: click to reverse"}
        className="grid h-7 w-7 place-content-center rounded-inner border border-rule-control-on-raised text-on-raised-muted enabled:hover:bg-surface-inset enabled:hover:text-on-raised disabled:opacity-50"
      >
        {asc ? (
          <ArrowUpNarrowWide aria-hidden="true" className="h-3.5 w-3.5" />
        ) : (
          <ArrowDownWideNarrow aria-hidden="true" className="h-3.5 w-3.5" />
        )}
      </button>
    </div>
  );
}

// --- select all ---------------------------------------------------------------------------------------------

/**
 * SELECT ALL SHOWN — one three-state box in the row checkboxes' own column, with live counts (lab rounds 2–5).
 *
 * It replaced a sentence plus two full buttons, one always disabled. What survives of that control's contract:
 * it acts on the SHOWN rows only and its counts say so ("5/6 groups" over "40/47 vars", ticked of shown — two
 * lines, because one overflows the 384px panel); the tri-state is real; and it locks while it saves, because
 * there is no bulk endpoint and a second press mid-flight is a half-succeeded burst with no story.
 */
export function SelectAllShown({
  counts,
  busy,
  frozen = false,
  onToggle,
}: {
  counts: TickedOfShown;
  busy: boolean;
  frozen?: boolean;
  onToggle: (target: "in" | "out") => void;
}) {
  const { state, groups, vars } = counts;
  return (
    <div data-testid="bulk-scope" data-state={state} className="flex items-center gap-2.5">
      <Checkbox
        data-testid="bulk-scope-toggle"
        checked={state === "all" ? true : state === "some" ? "indeterminate" : false}
        disabled={busy || frozen || groups.shown === 0}
        onCheckedChange={() => onToggle(state === "all" ? "out" : "in")}
        aria-label={state === "all" ? `Deselect all ${groups.shown} shown` : `Select all ${groups.shown} shown`}
      />
      <span className="flex flex-col whitespace-nowrap text-xs leading-tight text-on-raised-muted">
        <span data-testid="bulk-count-groups">
          <span className="font-mono tabular-nums text-on-raised">{groups.on}</span>/{groups.shown}{" "}
          {groups.shown === 1 ? "group" : "groups"}
        </span>
        <span data-testid="bulk-count-vars">
          <span className="font-mono tabular-nums text-on-raised">{vars.on}</span>/{vars.shown}{" "}
          {vars.shown === 1 ? "var" : "vars"}
        </span>
      </span>
      {busy && (
        <span role="status" data-testid="bulk-scope-busy" className="text-xs text-on-raised-muted">
          Saving…
        </span>
      )}
    </div>
  );
}

// --- the cohort strip ---------------------------------------------------------------------------------------

/**
 * ONE SQUARE PER COHORT, in the run's fixed order, in a column of its own (lab rounds 2–5). 16px columns, a
 * pixel wider than the lab's, so the legend's 12px initials above them stay apart.
 *
 * Spelled-out cohort chips were busy and runs are heading toward ten cohorts; a presence strip reads at a
 * glance which cohorts a group pools, and the same column in every row makes "which groups have UKBB" a
 * vertical scan. Read as an image by assistive tech, with the cohorts named.
 */
export function CohortStrip({ cohorts, roster }: { cohorts: readonly string[]; roster: readonly string[] }) {
  const present = new Set(cohorts);
  const covered = roster.filter((c) => present.has(c));
  return (
    <span
      data-testid="cohort-strip"
      role="img"
      aria-label={`${covered.length} of ${roster.length} cohorts: ${covered.join(", ") || "none"}`}
      title={covered.join(", ")}
      className="inline-flex"
    >
      {roster.map((c) => (
        <span key={c} data-cohort={c} data-covered={present.has(c)} className="grid w-4 place-content-center">
          <span
            className={cn(
              "h-2.5 w-2.5 rounded-[2px]",
              present.has(c) ? "bg-accent-action/75" : "bg-surface-inset-strong",
            )}
          />
        </span>
      ))}
    </span>
  );
}

/**
 * The strip's legend: each cohort's initials, printed ONCE above the list and right-aligned with the strips
 * below it (the rows right-align their strip for exactly this). Hovering an initial names the cohort.
 */
export function CohortLegend({ roster }: { roster: readonly string[] }) {
  const initials = cohortInitials(roster);
  return (
    <div data-testid="cohort-legend" className="flex justify-end py-1 pl-5 pr-4">
      <span className="inline-flex">
        {roster.map((c, i) => (
          <span
            key={c}
            data-cohort={c}
            title={c}
            // 12px is the scale's floor (UI-SPEC §3), so a two-letter initial nearly fills its column: the
            // columns are 16px, the letters set tight, and neighbours alternate tone so "AI Ao CL" never reads
            // as one word. (The lab's 9px left gaps for free, but 9px is off the app's type scale.)
            className={cn(
              "w-4 text-center font-mono text-xs leading-4 tracking-tighter",
              i % 2 === 0 ? "text-on-raised-muted" : "text-on-raised-faint",
            )}
          >
            {initials[c]}
          </span>
        ))}
      </span>
    </div>
  );
}

/**
 * A QUEUE ROW'S RIGHT COLUMN: the cohort strip, the state tag under it, and the variable count under that.
 * Stacked, not side by side (review round 1 on the live build: "there's not enough room"), so the column is
 * only as wide as its widest line and the name keeps the left column to itself. Right-aligned so every strip
 * shares an edge with the legend above the list.
 */
export function QueueRowFacts({
  cohorts,
  roster,
  vars,
  state,
}: {
  cohorts: readonly string[];
  roster: readonly string[];
  vars?: number;
  state?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-end gap-1 pt-0.5">
      <CohortStrip cohorts={cohorts} roster={roster} />
      {state}
      {/* A flex gap draws the space; this one is for the TEXT, so the row reads "split 7 vars", not "split7 vars". */}{" "}
      {typeof vars === "number" && (
        <span data-testid="row-vars" className="whitespace-nowrap text-xs text-on-raised-faint">
          {vars} {vars === 1 ? "var" : "vars"}
        </span>
      )}
    </div>
  );
}
