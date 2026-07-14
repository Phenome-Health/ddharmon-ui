// ─────────────────────────────────────────────────────────────────────────────────────────────
// ddharmon evaluation — BENCHMARK MANIFEST (single source of truth for the Benchmarks page)
//
// GROUNDING (strict — this is a public, credibility-facing surface):
// Every number below is copied VERBATIM from the SHIPPED, canonical Evaluation section (§3) of
// `Phenome-Health/ddharmon:docs/methods.md`. Nothing here is derived from internal experiment logs,
// internal-cohort results, EITL locked human verdicts, or any un-shipped run. If a figure is not in
// that canonical Evaluation table, it does NOT appear here. No version labels ("v2"/"v3").
// Keep this file in sync with `methods.md §3` when the canonical evaluation changes.
//
// The Benchmarks page renders one card per entry from THIS array — do NOT hardcode numbers in JSX.
// Adding / editing a benchmark is a one-place edit here.
//
// HONESTY MODEL — every card carries a dev/held-out/external tier tag so a development-set number is
// never shown without its "already tuned on → optimistic" caveat. CDEMapper is the development set;
// PhenX and AI-READI are held-out generalization checks; EITL human verdicts are the locked in-domain
// acceptance gate (a gate, not a benchmark number — so it is described, never quantified here).
//
// FUTURE FOLLOW-ONS (do NOT build now, noted so the intent isn't lost):
//   (a) Generated source of truth: the todo's ideal is a full auto-export of a results JSON straight
//       from the `benchmarks/` package runs (portable, $0, reproducible under PYTHONHASHSEED=0), which
//       would replace this hand-maintained file. This structured data file is the pragmatic interim.
//   (b) Public trend / time-series view: benchmark history over runs exists internally but is NOT
//       public-safe to dump, so no trend view is shipped here yet — it is a deliberate future add.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * How a benchmark is used, per the canonical benchmark-usage policy:
 *  - `development` — already tuned on; read the number as optimistic (carries a caution tag).
 *  - `held-out`    — a generalization check; measured, never tuned on.
 *  - `external`    — external ground truth presented as-is (no dev/held-out claim beyond canonical).
 */
export type BenchmarkTier = "development" | "held-out" | "external";

export interface BenchmarkMetric {
  /** What the number measures, e.g. "hybrid retrieval recall@5". */
  label: string;
  /** The value, verbatim from methods.md §3 (e.g. "0.632", "Δ0.536", "0.832 → 0.869"). */
  value: string;
}

export interface Benchmark {
  /** Benchmark / gold-dataset name. */
  name: string;
  /** The plain-language question the benchmark answers. */
  question: string;
  /** The external ground-truth dataset used as gold. */
  groundTruth: string;
  /** Headline metric(s) — verbatim canonical numbers. */
  metrics: BenchmarkMetric[];
  /** Development / held-out / external — surfaced as a badge on every card. */
  tier: BenchmarkTier;
  /** Short canonical caveat / interpretation for this benchmark. */
  note?: string;
}

// Numbers below are verbatim from `Phenome-Health/ddharmon:docs/methods.md` §3 (Evaluation).
export const BENCHMARKS: Benchmark[] = [
  {
    name: "CDEMapper",
    question: "Are we matching the right CDE?",
    groundTruth: "Yale CDE-Mapping-Tool (494 variable→CDE)",
    metrics: [
      { label: "hybrid retrieval recall@5", value: "0.632" },
      { label: "fused assignment (in-backbone)", value: "0.521" },
    ],
    tier: "development",
    note: "The development set — already tuned on, so read these numbers as optimistic.",
  },
  {
    name: "PhenX",
    question: "Do same-concept vars from different cohorts co-cluster?",
    groundTruth: "PhenX↔dbGaP crosswalk",
    metrics: [{ label: "embedding separability", value: "Δ0.536" }],
    tier: "held-out",
    note: "Clustering's edge is diffuse — which is exactly what motivates the assignment-first design.",
  },
  {
    name: "AI-READI",
    question: "Does a variable reach the right concept?",
    groundTruth: "AI-READI OMOP/CDE anchors",
    metrics: [{ label: "variable→concept recall@5", value: "0.655" }],
    tier: "held-out",
  },
  {
    name: "ATHLOS",
    question: "Are the value recodes generated correctly?",
    groundTruth: "ATHLOS harmonisation scripts (284 recode golds)",
    metrics: [{ label: "LLM recode pair-accuracy (with question_text context)", value: "0.832 → 0.869" }],
    tier: "external",
    note: "Feeding the source variable's question_text into the recode generator lifts recode accuracy ~7pp (0.832 → 0.869).",
  },
];
