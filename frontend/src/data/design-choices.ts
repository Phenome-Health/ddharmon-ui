// ─────────────────────────────────────────────────────────────────────────────────────────────
// ddharmon — DESIGN-CHOICES MANIFEST (single source of truth for the Design Choices page)
//
// GROUNDING (strict — this is a public, credibility-facing surface):
// Every decision, rejected alternative, and number below is grounded in the SHIPPED, canonical
// `Phenome-Health/ddharmon:docs/methods.md` (§1 "Why assignment-first", §2 "The pipeline", §3
// "Evaluation") — the same source the Methods and Benchmarks pages use. NOTHING here is derived from
// internal experiment logs, internal run numbers/ids, planning artifacts, internal-cohort results, or
// run-cost figures. Every `evidence` value is a published delta on a NAMED external benchmark
// (CDEMapper / PhenX / ATHLOS); the `source` field names that benchmark, never an internal run.
// Keep this file in sync with `methods.md` when the canonical method changes.
//
// The Design Choices page renders one card per entry from THIS array — do NOT hardcode content in JSX.
//
// Purpose vs. the sibling pages (don't duplicate): Methods = WHAT the stages are; Benchmarks = the
// scores; this page = WHY, i.e. the non-obvious choice, the obvious alternative we rejected, and what
// the data said. Backward-looking justification of decisions already made.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import type { LucideIcon } from "lucide-react";
import { Boxes, Combine, Crosshair, Gauge, Layers, Ruler, ScanSearch, Split, Tag } from "lucide-react";

/** A published delta on a named external benchmark — the only kind of number allowed on this page. */
export interface DesignEvidence {
  /** What improved, e.g. "retrieval recall@5". */
  metric: string;
  /** The before → after, verbatim from methods.md (e.g. "0.447 → 0.632"). */
  value: string;
  /** The NAMED public benchmark the delta is measured on (never an internal run id). */
  source: "CDEMapper" | "PhenX" | "AI-READI" | "ATHLOS";
}

export interface DesignChoice {
  icon: LucideIcon;
  /** The choice we made. */
  title: string;
  /** The obvious alternative we did NOT take. */
  rejected: string;
  /** Why — grounded in methods.md §1/§2. */
  rationale: string;
  /** A published delta, when the decision has one. Omitted when the rationale is qualitative/structural. */
  evidence?: DesignEvidence;
  /** One-line takeaway. */
  takeaway: string;
}

// Grounded in `Phenome-Health/ddharmon:docs/methods.md`. Section refs in comments for traceability.
export const DESIGN_CHOICES: DesignChoice[] = [
  {
    // §1 "Why assignment-first" + §3 PhenX row
    icon: Crosshair,
    title: "Assignment-first, not clustering-first",
    rejected: "making clustering the primary engine and reading concepts off the clusters",
    rationale:
      "A covered concept is best treated as assignment to an existing CDE. In a pooling A/B, assignment-first pooled common backbone-covered concepts about 6× better (micro) than cluster-first; clustering's advantage is confined to the rare no-CDE tail and is diffuse — not bankable by confidence routing.",
    evidence: { metric: "embedding separability (diffuse edge)", value: "Δ0.536", source: "PhenX" },
    takeaway: "Assign the head to real CDEs; cluster/generate only the tail.",
  },
  {
    // §2 Hybrid retrieve row
    icon: ScanSearch,
    title: "Hybrid retrieval (BM25 ⊕ dense, fused by RRF)",
    rejected: "dense embedding similarity alone",
    rationale:
      "The candidate generator fuses BM25 lexical scores over rich CDE text with dense centroid cosine via Reciprocal Rank Fusion. Hybrid beats dense at every k; a dense-rich control confirmed the gain is real lexical signal, not just more text.",
    evidence: { metric: "candidate recall@5", value: "0.447 → 0.632", source: "CDEMapper" },
    takeaway: "Lexical + dense, fused — either one alone leaves recall on the table.",
  },
  {
    // §2 Fused assign row
    icon: Combine,
    title: "One fused assign call — rank and commit together",
    rejected: "a two-call design: rerank the candidates, then a separate verdict call",
    rationale:
      "A single LLM call ranks the retrieved candidates by the independent 'ideal CDE' and commits the adopt/refine/novel verdict plus the chosen candidate at once. It beats the two-call rerank-then-verdict design on accuracy at half the cost.",
    evidence: { metric: "in-backbone assignment", value: "0.458 → 0.521", source: "CDEMapper" },
    takeaway: "Rank-and-commit in one call: more accurate and cheaper.",
  },
  {
    // §2 Split row
    icon: Split,
    title: "Split-aware assignment — one decision per concept",
    rejected: "one CDE decision per coarse cluster (silently merging whatever pooled together)",
    rationale:
      "A coarse cluster that pools more than one concept is partitioned so each concept-group gets its own CDE decision; distinct concepts are never silently merged. Oversized clusters are chunked into coherence-aware sub-units so the split step sees every member, and a cross-record merge reunites a concept over-split across clusters.",
    takeaway: "Decide per concept, not per cluster — clustering is a scaffold, not the verdict.",
  },
  {
    // §2 "Axis preservation"
    icon: Tag,
    title: "Axis preservation — a different qualifier is novel, not a refinement",
    rejected: "treating any near-match as a refinement of the closest existing CDE",
    rationale:
      "A candidate naming a different specific qualifier (condition, body site, time window) than the source is routed novel, not a refinement — so templated families aren't collapsed onto one condition-specific CDE. A semantic fix in the engine, not a router threshold.",
    evidence: { metric: "out-of-backbone novel-precision", value: "0.378 → 0.451", source: "CDEMapper" },
    takeaway: "Don't fold a differently-qualified concept onto the nearest CDE.",
  },
  {
    // §2 Ingest/embed row: "value/encoding metadata is routed to the LLM prompt (symbolic), not the geometric vector"
    icon: Layers,
    title: "Value metadata goes to the prompt, not the embedding",
    rejected: "folding response options / units / data-type into the field's embedding vector",
    rationale:
      "Each field gets a single semantic vector; its value/encoding metadata (response options, units, data type) is routed to the LLM prompt (symbolic), not averaged into the geometric vector. Similarity is a geometric question; value-level judgment is a symbolic one — mixing them adds noise to the vector.",
    takeaway: "Geometry for similarity; symbols (in the prompt) for value-level judgment.",
  },
  {
    // §2 Ingest/embed row: FremyCompany/BioLORD-2023
    icon: Boxes,
    title: "A biomedical-domain encoder (BioLORD-2023)",
    rejected: "a general-purpose sentence encoder",
    rationale:
      "Fields are clinical terminology, so the semantic vector comes from a biomedical domain-tuned encoder (FremyCompany/BioLORD-2023, 768-d, L2-normalized, run locally and SQLite-cached) rather than a general-purpose model. It is the encoder behind the retrieval numbers on the Benchmarks page.",
    takeaway: "Match the encoder to the domain — clinical text, clinical embeddings.",
  },
  {
    // §2 Cluster row + auto-scaled min_cluster_size (Methods stage manifest)
    icon: Gauge,
    title: "Auto-scale the clustering granularity, don't hand-tune it",
    rejected: "a single hand-tuned min_cluster_size",
    rationale:
      "Clustering is scaffolding — it batches near-duplicate fields for one assignment call and provides a centroid for retrieval; it is not the decision engine. Since the split-aware stages re-derive concepts anyway, min_cluster_size only needs to be reasonable, so it auto-scales to corpus size instead of being a tuned knob.",
    takeaway: "Don't over-tune a knob that isn't the decision engine.",
  },
  {
    // §3 ATHLOS row + §3 principle 2
    icon: Ruler,
    title: "Feed question_text into the value-recode generator",
    rejected: "generating recodes from the code/label pairs alone",
    rationale:
      "When generating a value recode, the source field's question_text (a role ddharmon already carries) is fed to the generator — it resolves polarity and granularity judgment calls the bare code/label pairs leave ambiguous.",
    evidence: { metric: "recode pair-accuracy", value: "0.832 → 0.869", source: "ATHLOS" },
    takeaway: "Recodes need the question, not just the answer codes.",
  },
];
