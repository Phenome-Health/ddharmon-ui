// Mirrors the stable UIRecord/UIResult contract emitted by backend/engine/contract.py.
// This file is the frontend half of the insulation boundary — when ddharmon's pipeline churns, only the
// backend adapter's mapping changes; these shapes (and the views that render them) stay still. Keep in
// sync with contract.py (CONTRACT_VERSION). See ../../docs/GUI-BUILD-PLAN.md §1/§3.

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
  minClusterSize: number;
  genTransformSpecs: boolean;
  displayName?: string;
  // advanced passthrough knobs (optional; default to harmonize_leanb's own values)
  topK?: number;
  retrievalFloor?: number;
  modelTag?: string;
}

export type ExportFormat = "eitl_tsv" | "records_json" | "decisions_csv";

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

// Verdict → badge styling (Phenome Health tokens).
export const VERDICT_STYLES: Record<string, string> = {
  adopt: "bg-success-bg text-success border-success/30",
  refine: "bg-warning-bg text-warning border-warning/30",
  novel: "bg-ph-navy/10 text-ph-navy border-ph-navy/30",
  unclassified: "bg-neutral-100 text-neutral-600 border-neutral-300",
};
