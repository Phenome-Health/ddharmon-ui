// Shared palette + primitives for the run visualizations (Sankey, bars, histogram, heatmap, atlas).
// One source of truth for verdict/cohort colors — previously duplicated across three chart files —
// so the brand palette (and dark-mode behavior of tooltip chrome) stays consistent.

export const VERDICTS = ["adopt", "refine", "novel", "unclassified"] as const;
export type Verdict = (typeof VERDICTS)[number];

/** Verdict encoding — mirrors VERDICT_STYLES badges + the Phenome brand palette. */
export const VERDICT_COLOR: Record<string, string> = {
  // §5.3: adopt is the ok green, refine the warn amber, novel the action blue
  // (a deliberate overload — "novel" means we generated one, the same register
  // as "you acted"), and unclassified takes the residual mark, not a hue.
  adopt: "var(--ok)",
  refine: "var(--warn)",
  novel: "var(--b-blue)",
  unclassified: "var(--chart-residual)",
};

export const VERDICT_LABEL: Record<string, string> = {
  adopt: "Adopt",
  refine: "Refine",
  novel: "Novel",
  unclassified: "Unclassified",
};

/** Cohort series palette (embedding atlas + any cohort encoding); teal leads, in its
 *  paper-legal `--b-teal-ink` form, because charts render on paper cards. */
export const COHORT_PALETTE = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-6)",
  "var(--chart-7)",
  "var(--chart-8)",
];

export function verdictColor(v: string): string {
  return VERDICT_COLOR[v] ?? VERDICT_COLOR.unclassified;
}

export function isVerdict(v: string): v is Verdict {
  return (VERDICTS as readonly string[]).includes(v);
}

/** Grid + axis hues. These read `--sf-200` / `--sf-400` until 08-07: that raw layer
 *  was deleted with the retheme, so every chart grid line and axis has been resolving
 *  to an undefined variable. Re-pointed at the surviving rule/ink tokens. */
/** Axis, label and legend type inside a chart: the meta size (`--text-xs`, 12px).
 *  Recharts takes a NUMBER for these, so the scale cannot be applied as a class —
 *  naming it here keeps the six call sites on the token's value instead of an 11px
 *  literal that sits off the four-size scale entirely. */
export const CHART_LABEL_SIZE = 12;

export const CHART_GRID = "var(--line)";
export const CHART_AXIS = "var(--muted)";

/** Branded floating-tooltip container. (Single theme now — nothing flips.) */
export const CHART_TOOLTIP_CLASS =
  "pointer-events-none rounded-md border border-neutral-200 bg-neutral-0 px-2.5 py-1.5 text-xs shadow-md";

// ── Brushing & linking: one shared selection across all run charts + the review queue ──
// A focus is a single axis of the run — one verdict, one cohort, or the "unassigned" residual (source
// fields that never clustered into a concept). Clicking a chart element sets it; it filters the review
// queue and emphasizes the matching slice everywhere else. "unassigned" is valueless — it's a single
// bucket, not a family of values — and is deliberately NOT a verdict (records never carry it).
export type Focus =
  | { kind: "verdict"; value: string }
  | { kind: "cohort"; value: string }
  | { kind: "unassigned" }
  | null;

export function sameFocus(a: Focus, b: Focus): boolean {
  if (!a || !b) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === "unassigned" || b.kind === "unassigned") return true;
  return a.value === b.value;
}

export function focusLabel(focus: Focus): string {
  if (!focus) return "";
  if (focus.kind === "unassigned") return "Unclustered";
  return focus.kind === "verdict" ? (VERDICT_LABEL[focus.value] ?? focus.value) : focus.value;
}

/** Does a record fall inside the current focus? Structural type so lib/ stays decoupled from types.ts.
 *  An "unassigned" focus matches NO record — records are all clustered; unassigned fields are surfaced
 *  separately (result.unassignedFields), so the record queue is empty under this focus. */
export function recordMatchesFocus(r: { verdict: string; cohorts: string[] }, focus: Focus): boolean {
  if (!focus) return true;
  if (focus.kind === "unassigned") return false;
  return focus.kind === "verdict" ? r.verdict === focus.value : r.cohorts.includes(focus.value);
}
