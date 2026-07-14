// ─────────────────────────────────────────────────────────────────────────────────────────────
// Public roadmap — where ddharmon is going. Single source of truth for the /roadmap page.
//
// PUBLIC surface: curate, don't dump. Every item is user-legible and public-safe — NO internal
// terminology, run IDs, competitor names, proprietary cohort specifics, or research-run notes.
// "Shipped" = live in this app today; "in-progress" = actively being built; "planned" / "exploring"
// = on the horizon, not a dated commitment. Cross items off (shipped) as they ship.
// ─────────────────────────────────────────────────────────────────────────────────────────────

export type RoadmapStatus = "shipped" | "in-progress" | "planned";

export interface RoadmapItem {
  label: string;
  status: RoadmapStatus;
  /** Optional one-line clarification, public-safe. */
  note?: string;
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
        label: "Split-aware assignment to Common Data Elements (adopt · refine · propose novel)",
        status: "shipped",
      },
      {
        label: "Transform-spec generation — value recodes, unit and arithmetic conversions",
        status: "shipped",
      },
      {
        label: "Choose your LLM provider and model",
        status: "in-progress",
        note: "Provider/model picker is live; more models are being validated end-to-end.",
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
    ],
  },
  {
    theme: "Interface & transparency",
    blurb: "Seeing what the pipeline does and why.",
    items: [
      {
        label: "Cross-cohort run dashboard — mapping-verdict Sankey + embedding atlas",
        status: "shipped",
      },
      { label: "Live run progress — elapsed, ETA, and a per-stage timeline", status: "shipped" },
      { label: "Suggested downstream analyses unlocked by a run", status: "shipped" },
      { label: "Methods, Design-rationale, and external-Benchmarks pages", status: "shipped" },
      {
        label: "Inline inspection of the prompt behind each pipeline stage",
        status: "planned",
      },
      { label: "Richer cluster and atlas visualizations", status: "planned" },
    ],
  },
  {
    theme: "Interoperability",
    blurb: "Playing well with existing standards and tooling.",
    items: [
      { label: "Assignment to NIH Common Data Elements", status: "shipped" },
      { label: "SSSOM crosswalk export for mappings", status: "planned" },
      { label: "LinkML schema export of the data model", status: "planned" },
      { label: "GenCDE / CDE-curator submission handoff for proposed new elements", status: "planned" },
    ],
  },
  {
    theme: "Cohorts & data",
    blurb: "The dictionaries ddharmon can harmonize.",
    items: [
      {
        label: "Public example cohorts — All of Us · CLSA · UK Biobank · MESA · AI-READI",
        status: "shipped",
      },
      { label: "Bring your own data dictionary (upload + column mapping)", status: "shipped" },
      {
        label: "A growing library of public source dictionaries",
        status: "in-progress",
      },
    ],
  },
  {
    theme: "Evaluation & review",
    blurb: "How we measure quality and keep humans in the loop.",
    items: [
      {
        label: "External gold benchmarks — CDEMapper · PhenX · AI-READI · ATHLOS",
        status: "shipped",
      },
      { label: "Expert-in-the-loop review queue and workbench", status: "shipped" },
      {
        label: "Reproducibility metrics — run-to-run and cross-model agreement",
        status: "planned",
      },
    ],
  },
];
