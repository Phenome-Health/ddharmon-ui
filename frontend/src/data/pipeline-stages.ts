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
import type { ContentProvenance } from "./content-provenance";
import {
  Boxes,
  ClipboardCheck,
  Combine,
  FileCog,
  FileSpreadsheet,
  GitBranch,
  Network,
  Search,
  ShieldAlert,
  Sparkles,
  Split,
  Target,
} from "lucide-react";

/** See ./content-provenance — re-stamp only after re-reading the prose against the pipeline. The
 *  stage/phase agreement itself is enforced mechanically by tests/test_content_drift.py. */
export const VERIFIED_AGAINST: ContentProvenance = {
  coreCommit: "f92abb6",
  contractVersion: "5",
  checkedOn: "2026-09-08",
  scope:
    "Methods refresh alongside the phase-08 staged review: added the coherence-check stage (dual-sample flag-not-gate, post-split/pre-assign); replaced the single review workbench with the Setup → Gate 1–4 staged flow and repointed its deep-links; added the cat↔num transform recodes (code→number, range→band) to the specs stage; noted the adopt floor on assign; refreshed retrieval recall@5 to the BioLORD-2023 pair (0.468 → 0.679).",
};

/** The pipeline's reported progress phases — mirrors `PHASES_RUN` in backend/engine/contract.py.
 *  Enforced by `tests/test_content_drift.py`: this list, that list, and the stage entries below must
 *  agree exactly. Both copies had silently drifted (`gencde` since the M12 work, `refine` on adding
 *  the refine route) — hence the test. */
export const PHASES_RUN = [
  "loading",
  "embedding",
  "clustering",
  "generating",
  "splitting",
  "assigning",
  "gencde",
  "specs",
  "refine",
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
      "A role-mapped CSV/TSV loader reads each cohort's data dictionary; you map your columns to roles (variable name, description, question text, value encoding, units, …). The NIH CDE catalog is loaded the same way — as another cohort — so its text lands in the same embedding space as your variables.",
    inputs: ["One CSV/TSV data dictionary per cohort", "The CDE catalog (the assignment backbone)"],
    outputs: ["Canonical variable records with roles resolved", "The CDE backbone loaded as a cohort"],
    keyDecisions: [
      "The pipeline requires a CDE backbone — assignment to the given catalog is the thesis; there is no “no-CDE” path.",
      "Value / encoding / units metadata is kept for the LLM prompts (symbolic), not folded into the geometric vector.",
    ],
    link: { href: "/run/new/setup", label: "Start a run — upload dictionaries & map columns" },
  },
  {
    id: "embedding",
    phase: "embedding",
    name: "Preprocess & embed",
    short: "Embed",
    kind: "local",
    icon: Boxes,
    whatItDoes:
      "Each variable's text is preprocessed into a single embedding-text string, then encoded to a 768-d, L2-normalized vector with FremyCompany/BioLORD-2023. Vectors are SQLite-cached so re-runs are incremental. Embeddings run locally — no external call, no cost.",
    inputs: ["Canonical variable records (source cohorts + CDE catalog)"],
    outputs: ["One semantic vector per variable", "A 2-D projection of the variable space for the atlas"],
    keyDecisions: [
      "A single semantic vector per variable — value/encoding/units metadata is routed to the LLM prompt, never mixed into the vector.",
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
      "Variables are clustered over their semantic vectors, with outlier recovery so stray variables still reach a concept. Clustering is scaffolding — it batches near-duplicate variables into one assignment call and gives dense retrieval a centroid. It is deliberately not the decision engine.",
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
      "Hybrid beats dense at every k (recall@5 0.468 → 0.679 on the CDEMapper gold, BioLORD-2023 encoder); the gain is real lexical signal.",
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
      "An LLM describes the ideal CDE for the concept with no candidates shown — an independent coverage anchor for what should exist, unbiased by whatever retrieval happened to surface. In staged review this text is shown as the “Concept summary” — the Gate 1 group label, and in full at Gate 2.",
    inputs: ["The concept's pooled member variables (name + text)"],
    outputs: ["An ideal-CDE description (the coverage anchor / Concept summary)"],
    keyDecisions: [
      "Formed with no candidates on purpose — it anchors the later novel decision rather than following retrieval.",
      "“GenCDE” is reserved for the spec-conformant novel route; this free-text anchor is the Concept summary.",
    ],
    link: { href: "/demo", label: "the Concept summary in the demo (Gate 2)" },
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
    id: "coherence",
    phase: null,
    name: "Coherence check (flag, don't gate)",
    short: "Coherence",
    kind: "llm",
    icon: ShieldAlert,
    whatItDoes:
      "A dual-sample judge re-reads each split-out concept-group to catch an over-merge the split missed. Two disjoint samples — the members closest to the group's centroid and the members furthest from it — are described independently and compared; a group that reads as two different measurands is FLAGGED as incoherent / needs-review. It marks the group, it never drops or silently re-splits it.",
    inputs: ["Concept-groups (post-split)", "Their member vectors"],
    outputs: ["A coherence verdict per group (coherent / incoherent / needs-review)", "An over-merge flag carried into review"],
    keyDecisions: [
      "Flag, don't gate — a flagged group stays in the run and reaches a human; the judge never removes a concept on its own.",
      "The calibrated rule fires on a split verdict OR a qualify verdict whose two samples name genuinely different KINDS of thing — tuned for recall, so a real over-merge is not missed.",
      "Groups too small to sample twice are left explicitly unjudged rather than guessed.",
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
      "Adopt floor: a weak-support adopt whose cosine clears the retrieval floor but not the adopt floor is demoted to refine — the bar for taking a CDE as-is is higher than the bar for keeping it with a transform.",
      "The adopt/refine/novel cutoff is deliberately strict; final calibration is deferred to human review.",
    ],
    link: { href: "/demo", label: "the CDE picks in the demo (Gate 2)" },
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
    id: "gencde",
    phase: "gencde",
    name: "GenCDE synthesis",
    short: "GenCDE",
    kind: "llm",
    icon: Sparkles,
    whatItDoes:
      "For each novel concept — one no existing CDE covers — the LLM synthesizes a spec-conformant candidate element: preferred name, definition, question text, and a permissible-value set pooled from the member variables. A GenCDE is a PROPOSAL for review, not a registered standard element.",
    inputs: ["Novel records (the tail)", "Pooled member fields + their observed value sets"],
    outputs: ["A proposed GenCDE per novel concept", "Member → GenCDE value recodes"],
    keyDecisions: [
      "The tail gets a harmonization target of its own — otherwise a novel concept ends the run with nothing to map onto.",
      "Value coverage is reported per proposal: the share of the members' observed values the synthesized domain actually admits.",
      "Nothing is registered anywhere — a GenCDE is a candidate you review, adopt, or discard.",
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
      "For each adopted/refined record, the LLM drafts a transform spec — categorical value recodes, cross-type recodes (a code→number table when a coded source maps onto a numeric target, and a range→band binning table when a numeric source maps onto a categorical target), unit conversions, arithmetic formulas, and wide→long specs for repeating-measure families. Specs are emitted, never executed on your data.",
    inputs: ["Adopt/refine records", "Source value / encoding / units metadata"],
    outputs: ["Transform specs (recodes incl. code→number / range→band, unit, arithmetic, wide→long), all routed to review"],
    keyDecisions: [
      "Feeding the source variable's question_text lifts whole-variable recode accuracy ~7pp (ATHLOS 0.832 → 0.869).",
      "Arithmetic specs are always flagged for review.",
      "Nothing is applied to data — a spec is a recipe you run in your own environment.",
    ],
  },
  {
    id: "refine",
    phase: "refine",
    name: "Refinement authoring",
    short: "Refined CDE",
    kind: "llm",
    icon: GitBranch,
    whatItDoes:
      "A refine verdict says the matched CDE is close but not right. This stage gives that verdict a real target: an element DERIVED from the matched CDE — the parent plus a typed, minimal, stated delta (a qualifier added, a value domain widened, a scope changed). Transform specs are then repointed at the refined element.",
    inputs: ["Refine records + their matched parent CDE", "Pooled member value sets"],
    outputs: [
      "A derived element per refinement — parent, relation, axis, and the delta",
      "Transform specs retargeted from the parent to the refined element",
    ],
    keyDecisions: [
      "The NIH CDE model has no “refines” predicate, so the relation is stated with SKOS (narrow / broad / close / relatedMatch) and the derivation is recorded on the element itself.",
      "Completions are tracked separately from changes and excluded from the delta size — the public catalog is sparse, and supplying an absent question text fills a blank rather than contradicting the standard.",
      "Deltas a rule can derive (unit, structural) are applied for free first, so a model is never paid for an answer arithmetic already settles.",
      "A match the earlier stages already doubt is gated OUT rather than refined — never build a refinement on a concept that looks mis-assigned.",
      "A delta that rewrites more of the parent than it refines is flagged as over-refined: the honest verdict there is usually novel.",
    ],
  },
  {
    id: "review",
    phase: null,
    name: "Staged expert review & export",
    short: "Staged review",
    kind: "human",
    icon: ClipboardCheck,
    whatItDoes:
      "The run's output is reviewed across a sequence of focused screens rather than one dense workbench: Setup (map columns and choose run options — the retired Gate 0 pre-run checks fold in here), Gate 1 (accept or reshape the concept groups), Gate 2 (choose each concept's target CDE), Gate 3 (correct the transform specs), and Gate 4 (export). Each gate settles one kind of decision before the next; nothing is auto-applied.",
    inputs: ["Routed records", "Transform specs", "GenCDE / refined-CDE proposals"],
    outputs: [
      "A per-gate reviewed run",
      "EITL exports, records JSON, decision logs, transform notebooks (at Gate 4)",
    ],
    keyDecisions: [
      "One decision per gate — concept groups, then CDE targets, then transform specs, then export — so a reviewer never judges three different things on one screen.",
      "EITL human verdicts are the locked acceptance gate — and the source of the strict adopt/refine/novel cutoff calibration.",
      "Every AI output is a suggestion, never a silent commit.",
    ],
    link: { href: "/demo", label: "walk the staged review in the demo" },
  },
];
