import { useEffect, useRef, type RefObject } from "react";
import { DisclosureChevron, DisclosureLabel } from "@/components/ui/disclosure";
import { RAIL_PIN_FOLDED_PX } from "@/components/gate/GateShell";
import { Highlight, SearchHighlightProvider } from "@/components/ui/highlight";
import { cn } from "@/lib/utils";
import { QueueRowFacts } from "@/components/gate/QueueControls";

/**
 * The shared master-detail frame for the review gates (08-16g) — now worn by all three (08-30b).
 *
 * Extracted from Gate 1's unified layout (08-16f) so Gate 2 and Gate 3 wear the SAME shell rather than
 * each inventing one — the intent Gate 1's own detail pane states verbatim: *"Same layout, later gates.
 * The left queue and this detail frame do not change."* Gate 1 moved onto it with the recurring-controls
 * redesign, so the three side panels cannot drift apart again: one frame, one set of controls
 * (`QueueControls.tsx`), each gate bringing only its own vocabulary.
 *
 * The frame is deliberately dumb: it owns the grid, the scrollable queue and the detail card, and takes
 * every screen-specific part as a slot, in the order the queue reads top to bottom — `toolbar` (search,
 * filter chips), `tools` (select-all, sort), `aboveList`, the cohort `legend` and the `rows`, `belowList`,
 * `footer`. `gate` prefixes the testids (`gate2-queue`, `gate2-rows`, `gate2-detail`) so each screen's e2e
 * can target its own frame.
 */
/**
 * WHERE THE QUEUE PINS, AND HOW TALL IT IS (review round 4: "during scroll, sidebar should remain pinned but right side
 * panel can move"). It used to pin at `top-4` — under the `z-30` rail, which hid its search box — and to be
 * `100vh - 7rem` tall whatever sat below it, so at the end of the page the grid's end pushed it up under the rail.
 *
 * Now: top = the folded rail pin (a constant — see `RAIL_PIN_FOLDED_PX`); height = the scroller's visible height,
 * less that, less everything the page puts BELOW the grid (the Continue bar's pin, the gap, the page's padding). So
 * the queue fits between the rail and the bar at every scroll position, the end of the page included. Set inline at
 * the `lg` breakpoint, where the queue is sticky; re-measured when a size changes, never on scroll.
 */
function usePinnedQueue(grid: RefObject<HTMLElement | null>, queue: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const g = grid.current;
    const q = queue.current;
    const scroller = g?.closest("main");
    if (!g || !q || !scroller) return;
    const wide = window.matchMedia("(min-width: 64rem)");
    const measure = () => {
      if (!wide.matches) {
        q.style.top = "";
        q.style.maxHeight = "";
        return;
      }
      const gridBottom = g.getBoundingClientRect().bottom - scroller.getBoundingClientRect().top + scroller.scrollTop;
      const below = Math.max(0, scroller.scrollHeight - gridBottom);
      q.style.top = `${RAIL_PIN_FOLDED_PX}px`;
      q.style.maxHeight = `${Math.max(240, scroller.clientHeight - RAIL_PIN_FOLDED_PX - below)}px`;
    };
    measure();
    const resize = new ResizeObserver(measure);
    resize.observe(scroller);
    resize.observe(g);
    if (g.parentElement) resize.observe(g.parentElement);
    wide.addEventListener("change", measure);
    return () => {
      resize.disconnect();
      wide.removeEventListener("change", measure);
    };
  }, [grid, queue]);
}

export function ConceptWorkbench({
  gate,
  testid,
  toolbar,
  tools,
  aboveList,
  legend,
  rows,
  belowList,
  footer,
  detail,
  detailRef,
  search,
}: {
  gate: string;
  /** The grid's testid; defaults to `${gate}-ledger`. Gate 1's predates the frame and stays `ledger`. */
  testid?: string;
  toolbar?: React.ReactNode;
  /** The row under the toolbar: select-all on the left (Gate 1), the sort control on the right. */
  tools?: React.ReactNode;
  aboveList?: React.ReactNode;
  /** The cohort legend, printed once above the rows (`CohortLegend`). */
  legend?: React.ReactNode;
  rows: React.ReactNode;
  belowList?: React.ReactNode;
  footer?: React.ReactNode;
  detail: React.ReactNode;
  detailRef?: React.Ref<HTMLElement>;
  /** The queue's live search, so the rows AND the open concept's detail highlight what it matched (rounds 3-4). */
  search?: { query: string; mode: "substring" | "word-prefix" };
}) {
  const gridRef = useRef<HTMLDivElement>(null);
  const queueRef = useRef<HTMLElement>(null);
  usePinnedQueue(gridRef, queueRef);
  return (
    <SearchHighlightProvider query={search?.query} mode={search?.mode ?? "substring"}>
    <div
      ref={gridRef}
      data-testid={testid ?? `${gate}-ledger`}
      className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(340px,384px)_minmax(0,1fr)] lg:items-start"
    >
      <aside
        data-testid={`${gate}-queue`}
        ref={queueRef}
        // Pinned under the rail and sized to what is visible by `usePinnedQueue`; these classes are the first paint.
        className="flex flex-col gap-3 overflow-hidden rounded-card bg-surface-raised py-4 shadow-card lg:sticky lg:top-4 lg:max-h-[calc(100vh-7rem)]"
      >
        {toolbar && <div className="flex flex-col gap-2 px-4">{toolbar}</div>}
        {/* pl-5 = the rows' 4px state rule + their 16px padding, so select-all sits in the row checkboxes' column. */}
        {tools && <div className="flex items-center justify-between gap-2 pl-5 pr-4">{tools}</div>}
        {aboveList}
        <div className="flex min-h-0 flex-1 flex-col border-y border-rule-quiet-on-raised">
          <div
            data-testid={`${gate}-rows`}
            className="min-h-0 flex-1 divide-y divide-rule-quiet-on-raised overflow-y-auto"
          >
            {/* The legend lives INSIDE the scrolling list, pinned to its top: a classic (non-overlay) scrollbar
                narrows the list, and a legend outside it would then sit a gutter's width right of its squares. */}
            {legend && <div className="sticky top-0 z-10 bg-surface-raised">{legend}</div>}
            {rows}
          </div>
        </div>
        {belowList}
        {footer && <div className="px-4">{footer}</div>}
      </aside>

      <section
        ref={detailRef}
        data-testid={`${gate}-detail`}
        className="min-w-0 rounded-card bg-surface-raised p-5 shadow-card lg:p-6"
      >
        {detail}
      </section>
    </div>
    </SearchHighlightProvider>
  );
}

/**
 * One row in a gate's queue — the scannable master of the master-detail, the Gate 2 / Gate 3 sibling of
 * Gate 1's `QueueRow`, in the same layout since 08-30b: the name has the left column to itself (up to three
 * lines), anything unusual about the concept rides under it (`marks`), and the right column is the cohort
 * strip with the variable count and the state tag beneath. Simpler than Gate 1's: no scope checkbox and no
 * drop target (regrouping is Gate 1's job alone). The old condensed sort-header strip is gone with it —
 * every gate sorts with `SegmentedSort` now.
 */
export function ConceptQueueRow({
  id,
  testid = "concept-row",
  label,
  marks,
  state,
  cohorts,
  roster,
  count,
  selected,
  query,
  onSelect,
}: {
  id: string;
  testid?: string;
  label: string;
  /** The queue's search, so the row can highlight what it matched in the name (review round 3). */
  query?: string;
  /** Exceptional badges shown under the name (Gate 3's concept-match flag). */
  marks?: React.ReactNode;
  /** The row's state tag — the verdict, as a `VerdictPill variant="tag"`. */
  state?: React.ReactNode;
  cohorts: string[];
  /** Every cohort in the run, in its fixed order — the strip's columns, under the queue's one legend. */
  roster: string[];
  count?: number;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      data-testid={testid}
      data-concept-id={id}
      data-search-label={label}
      aria-current={selected}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        "grid cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2.5 border-l-4 px-4 py-2.5 text-left",
        selected
          ? "border-l-accent-action bg-surface-info"
          : "border-l-transparent hover:bg-surface-inset",
      )}
    >
      <div className="min-w-0">
        <div
          className={cn(
            "line-clamp-3 text-sm font-semibold leading-snug",
            selected ? "text-accent-on-raised" : "text-on-raised",
          )}
          title={label}
        >
          <Highlight text={label} query={query} />
        </div>
        {marks && <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">{marks}</div>}
      </div>
      <QueueRowFacts cohorts={cohorts} roster={roster} vars={count} state={state} />
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
            data-testid="concept-title"
            className="text-xl font-semibold leading-tight text-on-raised"
            title={title}
          >
            <Highlight text={title} />
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

/** `variant="tag"` is the queue row's compact square form, beside the variable count (08-30b). */
export function VerdictPill({ verdict, variant = "pill" }: { verdict?: string; variant?: "pill" | "tag" }) {
  const v = verdict ? VERDICT_PILL[verdict] : undefined;
  if (!v) return null;
  return (
    <span
      data-testid="verdict-pill"
      data-verdict={verdict}
      data-variant={variant}
      className={cn(
        variant === "tag"
          ? "whitespace-nowrap rounded-sm border px-1.5 py-0.5 text-xs font-semibold uppercase"
          : "rounded-pill border px-2 py-0.5 text-xs font-semibold",
        v.cls,
        // Borderless like Gate 1's state tag, so the queue's tags read alike on every gate — last, so it wins.
        variant === "tag" && "border-transparent",
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
      {/* The shared disclosure header (08-30b): the whole row lights on hover, a trailing chevron, no Show/Hide
          words. The label leads in sentence case; where it came from and that it is read-only follow it, quieter. */}
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-0.5 rounded-inner px-4 py-2.5 transition-colors hover:bg-surface-inset-strong group-open:rounded-b-none [&::-webkit-details-marker]:hidden">
        <DisclosureLabel ground="inset" className="first-letter:uppercase">
          {label}
        </DisclosureLabel>
        <span className="text-xs text-on-inset-muted">from {from} · read-only</span>
        {detail && (
          <span className="text-xs text-on-inset-muted">{detail}</span>
        )}
        <DisclosureChevron ground="inset" className="ml-auto group-open:rotate-180" />
      </summary>
      <div className="border-t border-rule-quiet-on-raised px-4 py-3">
        {children}
      </div>
    </details>
  );
}
