import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { type ColumnSort } from "@/lib/column-sort";

/**
 * The shared master-detail frame for the review gates (08-16g).
 *
 * Extracted from Gate 1's unified layout (08-16f) so Gate 2 and Gate 3 wear the SAME shell rather than
 * each inventing one — the intent Gate 1's own detail pane states verbatim: *"Same layout, later gates.
 * The left queue and this detail frame do not change."* Gate 1 itself is left on its inline copy for now
 * (its 500-test e2e suite pins that DOM); this component matches its classes and testid conventions so
 * Gate 1 can adopt it later with no visual change.
 *
 * The frame is deliberately dumb: it owns the grid, the scrollable queue and the detail card, and takes
 * every screen-specific part (toolbar, sort header, rows, footer, detail) as a slot. `gate` prefixes the
 * testids (`gate2-queue`, `gate2-rows`, `gate2-detail`) so each screen's e2e can target its own frame.
 */
export function ConceptWorkbench({
  gate,
  toolbar,
  sortHeader,
  rows,
  footer,
  detail,
}: {
  gate: string;
  toolbar?: React.ReactNode;
  sortHeader?: React.ReactNode;
  rows: React.ReactNode;
  footer?: React.ReactNode;
  detail: React.ReactNode;
}) {
  return (
    <div
      data-testid={`${gate}-ledger`}
      className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(340px,384px)_minmax(0,1fr)] lg:items-start"
    >
      <aside
        data-testid={`${gate}-queue`}
        className="flex flex-col gap-3 overflow-hidden rounded-card bg-surface-raised py-4 shadow-card lg:sticky lg:top-4 lg:max-h-[calc(100vh-7rem)]"
      >
        {toolbar && <div className="px-4">{toolbar}</div>}
        {sortHeader}
        <div
          data-testid={`${gate}-rows`}
          className="flex-1 divide-y divide-rule-quiet-on-raised overflow-y-auto border-y border-rule-quiet-on-raised"
        >
          {rows}
        </div>
        {footer && <div className="px-4">{footer}</div>}
      </aside>

      <section
        data-testid={`${gate}-detail`}
        className="min-w-0 rounded-card bg-surface-raised p-5 shadow-card lg:p-6"
      >
        {detail}
      </section>
    </div>
  );
}

/**
 * One row in a gate's queue — the scannable master of the master-detail, the Gate 2 / Gate 3 sibling of
 * Gate 1's `QueueRow`. Simpler than Gate 1's: no scope checkbox and no drop target (regrouping is Gate 1's
 * job alone), just a selectable two-line summary — name, badges, cohorts, size — that opens its depth on
 * the right.
 */
export function ConceptQueueRow({
  id,
  testid = "concept-row",
  label,
  badges,
  cohorts,
  count,
  right,
  selected,
  onSelect,
}: {
  id: string;
  testid?: string;
  label: string;
  badges?: React.ReactNode;
  cohorts?: string[];
  count?: number;
  right?: React.ReactNode;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      data-testid={testid}
      data-concept-id={id}
      aria-current={selected}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        "grid cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-start gap-2.5 border-l-4 px-4 py-2.5 text-left",
        selected
          ? "border-l-accent-action bg-surface-info"
          : "border-l-transparent hover:bg-surface-inset",
      )}
    >
      <div className="min-w-0">
        <div
          className={cn(
            "line-clamp-2 text-sm font-semibold leading-snug",
            selected ? "text-accent-on-raised" : "text-on-raised",
          )}
          title={label}
        >
          {label}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
          {badges}
          {cohorts && cohorts.length > 0 && (
            <span className="flex flex-wrap gap-1">
              {cohorts.map((c) => (
                <span
                  key={c}
                  className="rounded bg-surface-inset px-1.5 py-0.5 text-xs font-bold uppercase tracking-wide text-on-inset-muted"
                >
                  {c}
                </span>
              ))}
            </span>
          )}
          {typeof count === "number" && (
            <span className="text-xs text-on-raised-faint">
              {count} {count === 1 ? "var" : "vars"}
            </span>
          )}
        </div>
      </div>
      {right && (
        <span className="whitespace-nowrap pt-0.5 text-xs text-on-raised-muted">
          {right}
        </span>
      )}
    </div>
  );
}

/**
 * The queue's sort control — the same condensed header strip Gate 1 uses, over the shared
 * `ColumnSort`/`toggleSort` state so a group orders identically on every surface.
 */
export function ConceptSortHeader<K extends string>({
  cols,
  sort,
  onSort,
}: {
  cols: { k: K; label: string }[];
  sort: ColumnSort<K> | null;
  onSort: (key: K) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 text-xs font-semibold uppercase tracking-eyebrow text-on-raised-faint">
      <span className="mr-auto">Sort</span>
      {cols.map((c) => (
        <button
          key={c.k}
          type="button"
          data-testid={`sort-${c.k}`}
          onClick={() => onSort(c.k)}
          className={cn(
            "hover:text-accent-on-raised",
            sort?.key === c.k && "text-accent-on-raised",
          )}
        >
          {c.label}
          {sort?.key === c.k ? (sort.dir === "asc" ? " ↑" : " ↓") : " ⇅"}
        </button>
      ))}
    </div>
  );
}

/**
 * The detail-pane header — the Gate 2 / Gate 3 sibling of Gate 1's `GroupDetail` header: the concept name,
 * a badge row, a provenance/meta line, and an optional actions slot on the right (the verdict controls).
 */
export function ConceptDetailHeader({
  title,
  badges,
  meta,
  actions,
}: {
  title: string;
  badges?: React.ReactNode;
  meta?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-rule-on-raised pb-4">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h2
            className="text-xl font-semibold leading-tight text-on-raised"
            title={title}
          >
            {title}
          </h2>
          {badges}
        </div>
        {meta && <p className="mt-1.5 text-xs text-on-raised-muted">{meta}</p>}
      </div>
      {actions && (
        <div className="flex shrink-0 items-center gap-1">{actions}</div>
      )}
    </div>
  );
}

/** The assignment verdict as a tinted pill — adopt / refine / novel, the Gate 2/3 register (distinct from
 *  Gate 1's coherence states). One closed vocabulary so the queue row and the detail header read alike. */
const VERDICT_PILL: Record<string, { label: string; cls: string }> = {
  adopt: { label: "adopt", cls: "border-status-ok text-on-ok bg-surface-ok" },
  refine: {
    label: "refine",
    cls: "border-status-warn text-on-warn bg-surface-warn",
  },
  novel: {
    label: "novel",
    cls: "border-rule-info text-accent-on-raised bg-surface-info",
  },
};

export function VerdictPill({ verdict }: { verdict?: string }) {
  const v = verdict ? VERDICT_PILL[verdict] : undefined;
  if (!v) return null;
  return (
    <span
      data-testid="verdict-pill"
      data-verdict={verdict}
      className={cn(
        "rounded-pill border px-2 py-0.5 text-xs font-semibold",
        v.cls,
      )}
    >
      {v.label}
    </span>
  );
}

/**
 * A decision made at an EARLIER gate, carried forward as a collapsible, read-only panel (08-16g).
 *
 * The gates are cumulative — each one inherits everything decided before it and adds one active layer, so
 * by Gate 3 the detail pane is the whole prod workbench (source rows → ideal → chosen CDE → transform
 * specs). Bhargav: *"prior gate inherited decisions [go] in collapsible sections since they should be read
 * only after the gate they were decided."* The summary names the deciding gate; the body is context, never
 * a control.
 */
export function InheritedPanel({
  from,
  label,
  detail,
  defaultOpen,
  testid,
  children,
}: {
  /** The gate this was decided at, e.g. "Gate 1". */
  from: string;
  /** What it is, e.g. "source variables" / "chosen target". */
  label: string;
  /** An optional at-a-glance value shown on the summary line while collapsed. */
  detail?: React.ReactNode;
  defaultOpen?: boolean;
  testid?: string;
  children: React.ReactNode;
}) {
  return (
    <details
      data-testid={testid}
      open={defaultOpen}
      className="group rounded-inner border border-rule-on-raised bg-surface-inset"
    >
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 px-4 py-2.5 [&::-webkit-details-marker]:hidden">
        <ChevronRight
          aria-hidden="true"
          className="h-4 w-4 shrink-0 text-on-inset-muted transition-transform group-open:rotate-90"
        />
        <span className="text-xs font-semibold uppercase tracking-eyebrow text-on-inset-muted">
          From {from}
          <span className="font-normal normal-case tracking-normal text-on-inset-faint">
            {" "}
            · {label} · read-only
          </span>
        </span>
        {detail && (
          <span className="text-xs text-on-inset-muted">{detail}</span>
        )}
        <span className="ml-auto text-xs font-semibold text-on-inset-muted group-open:hidden">
          Show
        </span>
        <span className="ml-auto hidden text-xs font-semibold text-on-inset-muted group-open:inline">
          Hide
        </span>
      </summary>
      <div className="border-t border-rule-quiet-on-raised px-4 py-3">
        {children}
      </div>
    </details>
  );
}
