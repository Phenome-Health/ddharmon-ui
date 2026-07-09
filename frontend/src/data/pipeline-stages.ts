// ─────────────────────────────────────────────────────────────────────────────────────────────
// ddharmon pipeline — STAGE MANIFEST (single source of truth for the Methods page)
//
// GROUNDING: This manifest mirrors the SHIPPED, canonical methodology in
// `Phenome-Health/ddharmon:docs/methods.md` — its assignment-first framing, stage order, and
// terminology (adopt/refine/novel; the "ideal CDE" coverage anchor; "GenCDE / clustering residual"
// as the novel route). It is NOT derived from any internal research-repo notes. Keep it in sync
// with `methods.md` when the canonical method changes.
//
// Both the per-stage <StageSection>s AND the visual stage-flow spine on the Methods page render
// from THIS array. Adding / renaming / reordering a stage is a ONE-PLACE edit here.
//
// `phase` links each stage to the pipeline's ACTUAL reported progress phase — the backend's
// `PHASES_RUN` (see backend/engine/contract.py + the `run_pipeline` progress(phase, …) calls in
// backend/engine/adapter.py). Stages with `phase: null` have no dedicated progress bar (they run
// inside a neighboring phase, or are post-pipeline). Mirroring `PHASES_RUN` here makes drift between
// the doc/UI and the running pipeline detectable.
//
// FUTURE FOLLOW-ONS (do NOT build now, noted so the intent isn't lost):
//   (a) Share this manifest with the planned Sphinx docs-site methodology page so the in-app Methods
//       page and the docs site render from one source instead of drifting.
//   (b) Add a drift check (a test) asserting every id in `PHASES_RUN` appears as some stage's
//       `phase` — so a new/renamed backend phase with no manifest entry fails loudly.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import type { LucideIcon } from "lucide-react";
import {
  Boxes,
  ClipboardCheck,
  Combine,
  FileCog,
  FileSpreadsheet,
  GitBranch,
  Network,
  Search,
  Split,
  Target,
} from "lucide-react";

/** The pipeline's reported progress phases — mirrors `PHASES_RUN` in backend/engine/contract.py. */
export const PHASES_RUN = [
  "loading",
  "embedding",
  "clustering",
  "generating",
  "splitting",
  "assigning",
  "specs",
] as const;

export type PhaseId = (typeof PHASES_RUN)[number];

/** Where the work happens: local compute (free, deterministic), an LLM call (paid), or a human. */
export type StageKind = "local" | "llm" | "human";

export interface PipelineStage {
  /** Slug — also the section anchor (`#stage-<id>`) the diagram spine links to. */
  id: string;
  /** The `PHASES_RUN` progress phase this stage reports as; `null` = no dedicated progress bar. */
  phase: PhaseId | null;
  /** Full stage name (section heading). */
  name: string;
  /** Short label for the stage-flow diagram spine. */
  short: string;
  /** Where the work runs. */
  kind: StageKind;
  icon: LucideIcon;
  /** One-paragraph "what this stage does". */
  whatItDoes: string;
  inputs: string[];
  outputs: string[];
  /** Design choices / empirical findings for this stage (from canonical methods.md). */
  keyDecisions: string[];
  /** Optional deep-link into the live UI where this stage's output is visible. */
  link?: { href: string; label: string };
}

export const PIPELINE_STAGES: PipelineStage[] = [
  {
    id: "ingest",
    phase: "loading",
    name: "Field mapping & ingest",
    short: "Ingest",
    kind: "local",
    icon: FileSpreadsheet,
    whatItDoes:
      "A role-mapped CSV/TSV loader reads each cohort's data dictionary; you map your columns to roles (variable name, description, question text, value encoding, units, …). The NIH CDE catalog is loaded the same way — as another cohort — so its text lands in the same embedding space as your fields.",
    inputs: ["One CSV/TSV data dictionary per cohort", "The CDE catalog (the assignment backbone)"],
    outputs: ["Canonical Field records with roles resolved", "The CDE backbone loaded as a cohort"],
    keyDecisions: [
      "The pipeline requires a CDE backbone — assignment to the given catalog is the thesis; there is no “no-CDE” path.",
      "Value / encoding / units metadata is kept for the LLM prompts (symbolic), not folded into the geometric vector.",
    ],
    link: { href: "/new", label: "Start a run — upload dictionaries & map columns" },
  },
  {
    id: "embedding",
    phase: "embedding",
    name: "Preprocess & embed",
    short: "Embed",
    kind: "local",
    icon: Boxes,
    whatItDoes:
      "Each field's text is preprocessed into a single embedding-text string, then encoded to a 768-d, L2-normalized vector with FremyCompany/BioLORD-2023. Vectors are SQLite-cached so re-runs are incremental. Embeddings run locally — no external call, no cost.",
    inputs: ["Canonical Field records (source cohorts + CDE catalog)"],
    outputs: ["One semantic vector per field", "A 2-D projection of the field space for the atlas"],
    keyDecisions: [
      "A single semantic vector per field — value/encoding/units metadata is routed to the LLM prompt, never mixed into the vector.",
      "Local + SQLite-cached: the deterministic, zero-cost part of every run.",
    ],
    link: { href: "/demo", label: "See the cohort-colored embedding atlas" },
  },
  {
    id: "clustering",
    phase: "clustering",
    name: "Cluster concepts (+ outlier recovery)",
    short: "Cluster",
    kind: "local",
    icon: Network,
    whatItDoes:
      "Fields are clustered over their semantic vectors, with outlier recovery so stray fields still reach a concept. Clustering is scaffolding — it batches near-duplicate fields into one assignment call and gives dense retrieval a centroid. It is deliberately not the decision engine.",
    inputs: ["Semantic vectors"],
    outputs: ["Coarse concept clusters (+ recovered outliers)", "Per-cluster centroids for retrieval"],
    keyDecisions: [
      "Cohort-agnostic — no cohort identity enters clustering.",
      "min_cluster_size auto-scales to corpus size; the split-aware stages re-derive concepts, so clustering only needs to be reasonable, not perfect.",
    ],
    link: { href: "/demo", label: "the embedding atlas on a run dashboard" },
  },
  {
    id: "retrieve",
    phase: null,
    name: "Hybrid retrieve top-k CDE candidates",
    short: "Retrieve",
    kind: "local",
    icon: Search,
    whatItDoes:
      "For each concept, retrieve the top-k (=20) candidate CDEs by fusing BM25 lexical scores over rich CDE text with dense centroid cosine, via Reciprocal Rank Fusion. This is the candidate generator — it proposes, it does not decide.",
    inputs: ["Concept centroids", "The embedded CDE backbone"],
    outputs: ["A ranked candidate-CDE shortlist per concept"],
    keyDecisions: [
      "Hybrid beats dense at every k (recall@5 0.447 → 0.632 on the CDEMapper gold); the gain is real lexical signal.",
      "Runs inside the clustering phase — it reports no separate progress bar.",
    ],
  },
  {
    id: "generating",
    phase: "generating",
    name: "Generate-ideal (Concept summary)",
    short: "Generate-ideal",
    kind: "llm",
    icon: Target,
    whatItDoes:
      "An LLM describes the ideal CDE for the concept with no candidates shown — an independent coverage anchor for what should exist, unbiased by whatever retrieval happened to surface. In the review workbench this text is shown as the “Concept summary.”",
    inputs: ["The concept's pooled member fields (name + text)"],
    outputs: ["An ideal-CDE description (the coverage anchor / Concept summary)"],
    keyDecisions: [
      "Formed with no candidates on purpose — it anchors the later novel decision rather than following retrieval.",
      "“GenCDE” is reserved for the spec-conformant novel route; this free-text anchor is the Concept summary.",
    ],
    link: { href: "/demo", label: "the Concept summary in the workbench" },
  },
  {
    id: "splitting",
    phase: "splitting",
    name: "Split into concept-groups",
    short: "Split",
    kind: "llm",
    icon: Split,
    whatItDoes:
      "A coarse cluster that pooled more than one concept is partitioned into distinct concept-groups so each concept gets its own CDE decision. Oversized clusters are chunked into coherence-aware sub-units (recursive average-linkage bisection) so the split sees every member; a cross-record merge reunites a concept over-split across clusters.",
    inputs: ["Concept clusters", "The ideal-CDE anchor"],
    outputs: ["Distinct concept-groups, each deciding alone"],
    keyDecisions: [
      "Distinct concepts are never silently collapsed onto one CDE.",
      "The split is what lets each concept-group get an independent adopt/refine/novel verdict.",
    ],
  },
  {
    id: "assigning",
    phase: "assigning",
    name: "Fused assign",
    short: "Fused assign",
    kind: "llm",
    icon: Combine,
    whatItDoes:
      "One LLM call per concept-group: rank the retrieved candidates by the ideal, then commit adopt / refine / novel and pick the chosen candidate in the same call — resolving to a real CDE designation + NIH tinyId.",
    inputs: ["Concept-group", "The ideal anchor", "The candidate shortlist"],
    outputs: ["A verdict (adopt/refine/novel)", "The chosen CDE + rationale", "chosen_cos (for audit)"],
    keyDecisions: [
      "One fused call beats a two-call rerank-then-verdict design (in-backbone assignment 0.458 → 0.521) at half the cost.",
      "Axis preservation: a candidate naming a different qualifier (condition, body site, time window) than the source is treated as novel, not a refine.",
      "Retrieval floor (default 0.30): an adopt/refine is downgraded to novel when the chosen candidate's cosine is below the floor — a bottom guard, not a mid threshold.",
      "The adopt/refine/novel cutoff is deliberately strict; final calibration is deferred to human review.",
    ],
    link: { href: "/demo", label: "the candidate workbench" },
  },
  {
    id: "route",
    phase: null,
    name: "Route: head / tail",
    short: "Route",
    kind: "local",
    icon: GitBranch,
    whatItDoes:
      "Apply the head/tail split per concept-group: adopt / refine records route to a CDE assignment (the head); novel records route to GenCDE / clustering residual (the tail).",
    inputs: ["Per-group verdicts"],
    outputs: ["Head — CDE assignments", "Tail — novel concepts (GenCDE / clustering residual)"],
    keyDecisions: [
      "The two buckets are scored separately — blending them hides the truth (a trivial “everything is novel” baseline wins on a blended metric).",
      "Assignment dominates the head; clustering's edge is confined to the diffuse tail.",
      "Tail handling (GenCDE generation + residual re-clustering) is scoped but deprioritized vs the head engine.",
    ],
  },
  {
    id: "specs",
    phase: "specs",
    name: "Transform-spec generation",
    short: "Transform specs",
    kind: "llm",
    icon: FileCog,
    whatItDoes:
      "For each adopted/refined record, the LLM drafts a transform spec — categorical value recodes, unit conversions, arithmetic formulas, and wide→long specs for repeating-measure families. Specs are emitted, never executed on your data.",
    inputs: ["Adopt/refine records", "Source value / encoding / units metadata"],
    outputs: ["Transform specs (recodes / unit / arithmetic / wide→long), all routed to review"],
    keyDecisions: [
      "Feeding the source field's question_text lifts whole-variable recode accuracy ~7pp (ATHLOS 0.832 → 0.869).",
      "Arithmetic specs are always flagged for review.",
      "Nothing is applied to data — a spec is a recipe you run in your own environment.",
    ],
  },
  {
    id: "review",
    phase: null,
    name: "Review workbench & EITL export",
    short: "Review & export",
    kind: "human",
    icon: ClipboardCheck,
    whatItDoes:
      "Every concept — its verdict, confidence, ranked candidates, Concept summary, and transform spec — lands in a reviewable queue. Export to an expert-in-the-loop (EITL) TSV/CSV, records JSON, decision logs, or ready-to-run Python / R notebooks. Nothing is auto-applied.",
    inputs: ["Routed records", "Transform specs"],
    outputs: ["Review queue", "EITL exports, records JSON, decision logs, transform notebooks"],
    keyDecisions: [
      "EITL human verdicts are the locked acceptance gate — and the source of the strict adopt/refine/novel cutoff calibration.",
      "Every AI output is a suggestion, never a silent commit.",
    ],
    link: { href: "/demo", label: "the review workbench" },
  },
];
