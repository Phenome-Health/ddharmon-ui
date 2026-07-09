// Mirrors the stable UIRecord/UIResult contract emitted by backend/engine/contract.py.
// This file is the frontend half of the insulation boundary — when ddharmon's pipeline churns, only the
// backend adapter's mapping changes; these shapes (and the views that render them) stay still. Keep in
// sync with contract.py (CONTRACT_VERSION).

export type RunMode = "batch" | "sync" | "preview";
export type CdeSet = "endorsed" | "full";

// Job lifecycle phases are REPORTED by the engine (data-driven) — this union is for hints only; the UI
// renders whatever phase string a run reports and reads result.phases for the sequence.
export type JobStatus =
  | "pending"
  | "loading"
  | "embedding"
  | "clustering"
  | "generating"
  | "splitting"
  | "assigning"
  | "specs"
  | "prepared"
  | "complete"
  | "error";

export interface CdeRef {
  id: string;
  externalId: string;
}

export interface Cosines {
  top1: number | null;
  chosen: number | null;
}

export interface UITransform {
  sourceVariable: string;
  targetCdeId: string;
  kind: string; // identity | categorical | unit | arithmetic | data_dependent | none
  confidence: number;
  coverage: number;
  needsUnits: boolean;
  needsData: boolean;
  needsReview: boolean;
  rationale: string;
  generatedBy: string;
  // kind-specific (present only when relevant)
  codeMap?: Record<string, string>;
  unmappedSourceCodes?: string[];
  factor?: number;
  offset?: number;
  sourceUnit?: string;
  targetUnit?: string;
  formula?: string;
  inputs?: string[];
  method?: string;
  params?: Record<string, unknown>;
}

export interface UICandidate {
  rank: number; // 1-based, best-first
  cdeId: string;
  cdeExternalId: string; // "" when absent
  definition: string;
  cosine: number;
  isChosen: boolean;
  llmSuggested: boolean;
}

export interface AtlasPoint {
  cohort: string;
  variable: string;
  x: number;
  y: number;
}

// One source field a concept pooled — surfaced so a reviewer can see WHICH variables (and their text)
// drove the assignment. `text` is the embedded signal (description/question/label); `name` may be a
// synthetic row id when the source dictionary had no usable identifier column. Mirrors contract.py.
export interface UIMember {
  id: string; // "cohort:var"
  cohort: string;
  name: string;
  text: string;
}

// One coded response option (code→label) for a field. `order` present only when the source carried an
// ordinal position. Mirrors contract.py ResponseOptionUI.
export interface ResponseOption {
  code: string;
  label: string;
  order?: number;
}

// Full read-in detail for one source (non-CDE) field, keyed "cohort:var" in HarmonizationResult.fieldIndex.
// Covers every embedded source field (UNCAPPED — unlike the downsampled atlas). `name` and `text` (the
// embedded signal) are always present; the raw attributes appear only when the source provided a non-empty
// value (`description` is omitted when it merely echoes the variable name). Mirrors contract.py FieldDetail.
export interface FieldDetail {
  name: string;
  text: string;
  description?: string;
  questionText?: string;
  valueEncoding?: string; // inline code=label string, e.g. "1=Yes|2=No"
  units?: string;
  dataType?: string;
  responseOptions?: ResponseOption[];
}

// A source field that landed in NO concept record (unclustered / dropped outlier). `x`,`y` present only when
// the field is in the atlas sample (the atlas is downsampled; this list is not). Mirrors contract.py.
export interface UnassignedField {
  cohort: string;
  variable: string;
  text: string;
  x?: number;
  y?: number;
}

export interface UIRecord {
  id: string;
  clusterId: string;
  groupId: string;
  concept: string;
  verdict: string; // adopt | refine | novel | unclassified
  route: string; // assigned | gencde_residual
  cde: CdeRef | null;
  idealCde: string;
  cosines: Cosines;
  coverageGap: boolean;
  floored: boolean;
  crossCohort: boolean;
  nMembers: number;
  cohorts: string[];
  members: string[];
  memberDetails: UIMember[]; // the source fields (name + text) this concept pooled — for review
  transforms: UITransform[];
  candidates: UICandidate[]; // ranked CDE candidates the assign stage saw (best-first)
  rationale: string;
  decidedBy: string;
}

export interface PromptCounts {
  ideal: number;
  split: number;
  groupAssign: number;
  specgen: number;
}

export interface ResultSummary {
  nRecords: number;
  counts: Record<string, number>; // verdict -> count
  nCrossCohort: number;
  nAssigned: number;
  nGencdeResidual: number;
  nWithTransforms: number;
  cohorts: string[];
}

export interface HarmonizationResult {
  contractVersion: string;
  mode: string;
  phases: string[];
  records: UIRecord[];
  summary: ResultSummary;
  prompts: PromptCounts;
  atlas: AtlasPoint[];
  // Full per-field detail for every embedded source (non-CDE) field, keyed "cohort:var" (uncapped) — lets the
  // UI show complete field detail on demand without a re-fetch.
  fieldIndex: Record<string, FieldDetail>;
  // Source fields that landed in no concept record (unclustered / dropped outliers) — the "everything else"
  // the run didn't harmonize. Uncapped; x/y only when the field is in the atlas.
  unassignedFields: UnassignedField[];
}

export interface JobResult {
  jobId: string;
  displayName: string;
  status: JobStatus;
  phase: string;
  completed: number;
  total: number;
  errorMessage: string | null;
  result: HarmonizationResult | null;
  config: Record<string, unknown>;
  decisions: Record<string, { decision: string; note: string }>;
  createdAt: number;
  updatedAt: number;
  // Present on the bundled demo fixture: per-phase wall-clock from the real build run, used to pace the
  // client-side replay in static (backend-less) mode so the Netlify demo feels like a live run.
  phaseTimings?: Record<string, number>;
}

export interface JobSummary extends Omit<JobResult, "result"> {
  nRecords: number;
}

export interface DictSpec {
  filename: string;
  cohortName: string;
  columnRoles: Record<string, string>;
}

export interface RunConfig {
  dictionaries: DictSpec[];
  cdeSet: CdeSet;
  runMode: RunMode;
  genTransformSpecs: boolean;
  displayName?: string;
  // advanced passthrough knobs (optional; the engine auto-scales min_cluster_size from corpus size when
  // omitted, and falls back to harmonize_leanb's own defaults for the rest)
  minClusterSize?: number;
  topK?: number;
  retrievalFloor?: number;
  modelTag?: string;
}

export type ExportFormat = "eitl_tsv" | "records_json" | "decisions_csv" | "notebook_py" | "notebook_r";

// Precomputed demo runs (loaded without spending API credits).
export interface DemoDataset {
  id: string;
  label: string;
  nFields: number;
  description?: string;
  file?: string;
}
export interface DemoCombo {
  datasets: string[];
  snapshot: string;
  label: string;
  description?: string;
  available: boolean;
}
export interface DemosResponse {
  datasets: DemoDataset[];
  combos: DemoCombo[];
}

// load_dictionary column roles the UI lets you map (value = source column).
export const COLUMN_ROLES = [
  "variable_name",
  "description",
  "question_text",
  "value_encoding",
  "data_type",
  "units",
  "category",
  "field_id",
  "standard_code",
] as const;
export type ColumnRole = (typeof COLUMN_ROLES)[number];

// Core roles get top billing in the mapping UI, split by what they describe: the QUESTION (semantic) side
// — what the field asks / means — vs the RESPONSE (value) side — the values and how they're coded. The
// rest live behind "advanced" (organizational / external ids, not part of the core mapping).
export const SEMANTIC_ROLES: ColumnRole[] = ["variable_name", "description", "question_text"];
export const VALUE_ROLES: ColumnRole[] = ["value_encoding", "units", "data_type"];
export const PRIMARY_ROLES: ColumnRole[] = [...SEMANTIC_ROLES, ...VALUE_ROLES];
export const ADVANCED_ROLES: ColumnRole[] = ["category", "field_id", "standard_code"];

// Roles whose column VALUES must follow a specific format — surfaced inline so users format correctly.
export const ROLE_FORMAT: Partial<Record<ColumnRole, string>> = {
  value_encoding: "Format: code=label pairs separated by |  —  e.g.  1=Male|2=Female|3=Other",
};

// Per-role requirement tier — derived from the pipeline's REAL contract, not a hardcoded star:
//  - "meaning": at least one meaning-bearing field is required. The loader tries description →
//    short_label → variable_name and skips the row if none carries usable text, so the semantic group
//    (not any single field) is the hard requirement. These carry the primary group required marker.
//  - "conditional": required only for a specific downstream output — value_encoding is the HARD input
//    for CATEGORICAL transform specs (an empty value_set ⇒ no recode spec).
//  - "recommended": improves output but never blocks — units let numeric unit specs resolve; when it's
//    absent the specs are still generated, just flagged needs_units.
// variable_name is intentionally UNMARKED: the pipeline auto-synthesizes a synthetic row id (_ROW_nnnn)
// when it's unmapped, so it's optional. data_type and the advanced roles are optional too.
export const ROLE_REQUIREMENT: Partial<Record<ColumnRole, "meaning" | "conditional" | "recommended">> = {
  question_text: "meaning",
  description: "meaning",
  value_encoding: "conditional",
  units: "recommended",
};

// Hover-help for each mappable role — what to point this column at, and why it matters.
export const ROLE_HELP: Record<ColumnRole, string> = {
  variable_name:
    "The field's unique identifier or code in your dataset (e.g. BMI, Q47_weight). Optional — a synthetic row id is generated if you don't map it; it's the join key other roles attach to.",
  description:
    "A human-readable definition of what the variable measures (e.g. “Body mass index in kg/m²”). The primary signal used to match your field to a CDE.",
  question_text:
    "For survey items, the exact question asked (e.g. “In the past week, how often…”). A strong matching signal for questionnaires.",
  value_encoding:
    "The coded response options, e.g. 1=Male|2=Female. Drives value-recode transform specs (mapping your codes to the CDE's) — required for categorical transform specs; without it no recode is generated.",
  data_type:
    "The variable's storage type — integer, float, categorical, string, date. Helps choose the right transform.",
  units:
    "The unit of measurement (e.g. kg, cm, mmHg). Enables unit-conversion transform specs when your unit differs from the CDE's. Recommended — numeric specs are still generated without it, but flagged as needing units.",
  category:
    "A grouping or section label from your dictionary (e.g. Demographics, Vitals). Organizational context — not required.",
  field_id:
    "An external or catalog identifier for the field, if you have one (e.g. a study's field number).",
  standard_code:
    "An existing ontology/standard code for the field, if already annotated (e.g. LOINC, SNOMED, a CDE tinyId).",
};

// Rough LLM-cost estimate for a run. Anchored on an observed run: ~$1.45 (batch, Sonnet) over ~7,451
// fields ⇒ ~$0.0002/field. Cost is ~linear in total fields; split+assign (≈77% of it) grow with cohort
// count, so a small cross-cohort multiplier is applied. Batch ≈ 50% of sync; preview uses no LLM.
const PER_FIELD_BATCH_USD = 0.0002;
export interface CostEstimate {
  low: number;
  mid: number;
  high: number;
  free: boolean;
}
export function estimateRunCost(totalFields: number, nCohorts: number, mode: RunMode): CostEstimate {
  if (mode === "preview" || totalFields <= 0) return { low: 0, mid: 0, high: 0, free: true };
  const modeFactor = mode === "sync" ? 2 : 1; // batch is ~half of sync
  const cohortFactor = 1 + 0.08 * Math.max(0, nCohorts - 1); // cross-cohort assign work grows with cohorts
  const mid = totalFields * PER_FIELD_BATCH_USD * modeFactor * cohortFactor;
  return { low: mid * 0.6, mid, high: mid * 1.6, free: false };
}
export function formatUsd(x: number): string {
  if (x === 0) return "$0";
  if (x < 0.01) return "<$0.01";
  if (x < 1) return `$${x.toFixed(2)}`;
  return `$${x.toFixed(x < 10 ? 2 : 0)}`;
}

// Per-stage cost shares of the LLM total, from an observed run: split+assign ≈77%, gen-ideal ≈7%,
// spec-gen ≈15% (embedding/clustering are local → $0). Used for the itemized estimate.
const STAGE_SHARES = { ideal: 0.07, splitAssign: 0.77, specgen: 0.15 };
export interface CostLine {
  label: string;
  cost: number;
  note?: string;
}
export interface CostBreakdown {
  free: boolean;
  lines: CostLine[];
  total: CostEstimate;
  batchSavings: number; // vs running the same in sync mode (0 unless mode is batch)
}
export function estimateRunCostBreakdown(
  totalFields: number,
  nCohorts: number,
  mode: RunMode,
  genSpecs: boolean,
): CostBreakdown {
  if (mode === "preview" || totalFields <= 0) {
    return { free: true, lines: [], total: { low: 0, mid: 0, high: 0, free: true }, batchSavings: 0 };
  }
  const cohortFactor = 1 + 0.08 * Math.max(0, nCohorts - 1);
  const baseBatch = totalFields * PER_FIELD_BATCH_USD * cohortFactor; // full batch run, all stages
  const modeFactor = mode === "sync" ? 2 : 1; // batch ≈ ½ sync
  const line = (share: number) => baseBatch * share * modeFactor;
  const lines: CostLine[] = [
    { label: "Embedding & clustering", cost: 0, note: "local — no API" },
    { label: "Generate ideal CDEs", cost: line(STAGE_SHARES.ideal) },
    { label: "Split + assign to CDEs", cost: line(STAGE_SHARES.splitAssign) },
  ];
  if (genSpecs) lines.push({ label: "Transform spec-gen", cost: line(STAGE_SHARES.specgen) });
  const mid = lines.reduce((s, l) => s + l.cost, 0);
  return {
    free: false,
    lines,
    total: { low: mid * 0.6, mid, high: mid * 1.6, free: false },
    batchSavings: mode === "batch" ? mid : 0, // sync would cost ~2×, so batch saves ≈ mid
  };
}

// Verdict → badge styling (Phenome Health tokens).
export const VERDICT_STYLES: Record<string, string> = {
  adopt: "bg-success-bg text-success border-success/30",
  refine: "bg-warning-bg text-warning border-warning/30",
  novel: "bg-ph-navy/10 text-ph-navy border-ph-navy/30",
  unclassified: "bg-neutral-100 text-neutral-600 border-neutral-300",
};
