// ─────────────────────────────────────────────────────────────────────────────────────────────
// Public roadmap — where ddharmon is going. Single source of truth for the /roadmap page.
//
// PUBLIC surface: curate, don't dump. Every item is user-legible and public-safe — NO internal
// terminology, run IDs, competitor names, proprietary cohort specifics, or research-run notes.
// Forthcoming work only: "in-progress" = actively being built; "planned" = intended next;
// "exploring" = an open research direction we're actively thinking about, not a commitment.
// Strike an item entirely once it ships — shipped work does not belong here.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import type { ContentProvenance } from "./content-provenance";

/** See ./content-provenance. NOT yet baselined — item statuses have not been re-checked against what
 *  actually shipped. This is the manifest most prone to quiet drift: "planned" items go out without
 *  anyone crossing them off, so the roadmap under-claims. First pass should reconcile every status
 *  against the pipeline, then set a real coreCommit. */
export const VERIFIED_AGAINST: ContentProvenance = {
  coreCommit: "unverified",
  contractVersion: "unverified",
  checkedOn: "never",
  scope: "Baseline not established — item statuses unreconciled against what has shipped.",
};

export type RoadmapStatus = "in-progress" | "planned" | "exploring";

export interface RoadmapItem {
  label: string;
  status: RoadmapStatus;
  /** Optional one-line clarification, public-safe. */
  note?: string;
  /** Optional design preview / mockup of this item (an in-app route; renders a "Preview" tag). */
  preview?: string;
}

export interface RoadmapGroup {
  theme: string;
  blurb: string;
  items: RoadmapItem[];
}

export const ROADMAP: RoadmapGroup[] = [
  {
    theme: "Harmonization",
    blurb: "How ddharmon maps variables to a shared standard.",
    items: [
      {
        label: "Choose your LLM provider and model",
        status: "in-progress",
        note: "Provider/model picker is live; more models are being validated end-to-end.",
      },
      {
        label: "Detect and flag validated instruments (e.g. PHQ-9) for exact, item-level harmonization",
        status: "planned",
      },
      {
        label: "Direct variable → ontology annotation (LOINC, SNOMED, …), beyond CDE mapping",
        status: "planned",
      },
      {
        label: "Propose cross-cohort concepts only — suppress single-cohort elements on demand",
        status: "planned",
      },
      {
        label: "Local / on-prem LLM support — run inside your own compliance boundary",
        status: "planned",
      },
      {
        label: "Longitudinal & repeated-measures handling (per-timepoint variables)",
        status: "planned",
      },
      { label: "Wearable / continuous-signal harmonization", status: "planned" },
      {
        label: "User-tunable granularity — trade effective sample size against concept specificity",
        status: "exploring",
      },
      {
        label: "Backbone-free mode — harmonize with no pre-existing catalog, proposing a bespoke element per concept",
        status: "exploring",
        note: "A test of whether anchoring to an existing catalog helps or constrains.",
      },
    ],
  },
  {
    theme: "Interface & transparency",
    blurb: "Seeing what the pipeline does and why.",
    items: [
      {
        label: "Inline inspection of the prompt behind each pipeline stage",
        status: "planned",
      },
      { label: "Richer cluster and atlas visualizations", status: "planned" },
      {
        label: "Drag-and-drop concept restructuring — move variables between concepts, then re-check with the model",
        status: "planned",
        preview: "/preview/restructure",
      },
      {
        label: "Flag a concept as incoherent and have the model re-adjudicate it",
        status: "planned",
      },
    ],
  },
  {
    theme: "Analysis & impact",
    blurb: "Turning a harmonized crosswalk into a scientific result.",
    items: [
      {
        label: "Export a run as a runnable analysis notebook",
        status: "planned",
      },
      {
        label: "End-to-end value demos — a finding that only emerges after pooling cohorts",
        status: "planned",
      },
      {
        label: "Quantify the payoff of harmonization — effective sample size and statistical power gained",
        status: "exploring",
        preview: "/preview/payoff",
      },
      {
        label: "Composite / derived-variable builder — assemble scores (e.g. frailty) from harmonized inputs",
        status: "exploring",
        preview: "/preview/composite",
      },
    ],
  },
  {
    theme: "Interoperability",
    blurb: "Playing well with existing standards and tooling.",
    items: [
      { label: "SSSOM crosswalk export for mappings", status: "planned" },
      { label: "LinkML schema export of the data model", status: "planned" },
      { label: "GenCDE / CDE-curator submission handoff for proposed new elements", status: "planned" },
      { label: "Selectable CDE catalogs beyond NIH — bring a community or domain catalog", status: "planned" },
      {
        label: "Bridge harmonized elements into a biomedical knowledge graph",
        status: "exploring",
        preview: "/preview/knowledge-graph",
      },
    ],
  },
  {
    theme: "Cohorts & data",
    blurb: "The dictionaries ddharmon can harmonize.",
    items: [
      {
        label: "A growing library of public source dictionaries",
        status: "in-progress",
      },
      {
        label: "Incremental cohort onboarding — add a cohort to an existing model without a full re-run",
        status: "planned",
      },
      { label: "Therapeutic-area-focused demos — e.g. neurology, immunology", status: "planned" },
    ],
  },
  {
    theme: "Evaluation & review",
    blurb: "How we measure quality and keep humans in the loop.",
    items: [
      {
        label: "Reproducibility metrics — run-to-run and cross-model agreement",
        status: "planned",
        preview: "/preview/reproducibility",
      },
      {
        label: "Fold expert review verdicts back in as human ground truth",
        status: "exploring",
      },
    ],
  },
];
