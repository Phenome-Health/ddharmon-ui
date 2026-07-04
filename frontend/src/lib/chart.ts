// Shared palette + primitives for the run visualizations (Sankey, bars, histogram, heatmap, atlas).
// One source of truth for verdict/cohort colors — previously duplicated across three chart files —
// so the brand palette (and dark-mode behavior of tooltip chrome) stays consistent.

export const VERDICTS = ["adopt", "refine", "novel", "unclassified"] as const;
export type Verdict = (typeof VERDICTS)[number];

/** Verdict encoding — mirrors VERDICT_STYLES badges + the Phenome brand palette. */
export const VERDICT_COLOR: Record<string, string> = {
  adopt: "#005B33", // ph-green
  refine: "#B45309", // warning
  novel: "#113682", // ph-navy
  unclassified: "#8892A3", // neutral-400
};

export const VERDICT_LABEL: Record<string, string> = {
  adopt: "Adopt",
  refine: "Refine",
  novel: "Novel",
  unclassified: "Unclassified",
};

/** Cohort series palette (embedding atlas + any cohort encoding); ph-teal leads. */
export const COHORT_PALETTE = [
  "#3AC2CB",
  "#113682",
  "#E21C52",
  "#005B33",
  "#B45309",
  "#7C3AED",
  "#0EA5E9",
  "#8892A3",
];

export function verdictColor(v: string): string {
  return VERDICT_COLOR[v] ?? VERDICT_COLOR.unclassified;
}

export function isVerdict(v: string): v is Verdict {
  return (VERDICTS as readonly string[]).includes(v);
}

/** Grid + axis hues that read on both themes (token-backed via CSS vars where possible). */
export const CHART_GRID = "var(--sf-200)";
export const CHART_AXIS = "var(--sf-400)";

/** Branded floating-tooltip container — neutral tokens flip under `.dark`. */
export const CHART_TOOLTIP_CLASS =
  "pointer-events-none rounded-md border border-neutral-200 bg-neutral-0 px-2.5 py-1.5 text-xs shadow-md";

// ── Brushing & linking: one shared selection across all run charts + the review queue ──
// A focus is a single axis of the run — one verdict, or one cohort. Clicking a chart element sets it;
// it filters the review queue and emphasizes the matching slice everywhere else.
export type Focus = { kind: "verdict"; value: string } | { kind: "cohort"; value: string } | null;

export function sameFocus(a: Focus, b: Focus): boolean {
  if (!a || !b) return a === b;
  return a.kind === b.kind && a.value === b.value;
}

export function focusLabel(focus: Focus): string {
  if (!focus) return "";
  return focus.kind === "verdict" ? (VERDICT_LABEL[focus.value] ?? focus.value) : focus.value;
}

/** Does a record fall inside the current focus? Structural type so lib/ stays decoupled from types.ts. */
export function recordMatchesFocus(r: { verdict: string; cohorts: string[] }, focus: Focus): boolean {
  if (!focus) return true;
  return focus.kind === "verdict" ? r.verdict === focus.value : r.cohorts.includes(focus.value);
}
