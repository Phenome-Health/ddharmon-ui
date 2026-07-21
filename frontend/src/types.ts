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
  | "gencde"
  | "specs"
  | "prepared"
  | "complete"
  | "error"
  | "cancelled"; // user stopped the run (terminal; distinct from error) — re-runnable from its uploads

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

// A synthesized Common Data Element for a novel concept group (mirrors contract.py UIGenCDE) — the novel
// route's proposed harmonization target. Distinct from UIRecord.idealCde (the free-text coverage anchor):
// a spec-conformant proposal (name/definition/data type/permissible values/units) reconciled from the
// group's pooled cross-cohort member evidence. `valueCoverage`/`needsReview` are verification flags, never a gate.
export interface GenCDE {
  gencdeId: string;
  preferredName: string;
  title: string;
  definition: string;
  questionText: string;
  dataType: string; // numeric | categorical | binary | date | text
  permissibleValues: ResponseOption[]; // reconciled categorical domain
  aliases: string[];
  sourceVariables: string[]; // pooled member edges ("cohort:var")
  sourceCohorts: string[];
  relatedCdes: string[]; // near-miss candidate names the assign stage saw
  valueCoverage: number | null; // fraction of observed answer-concepts represented (flag, not gate); null = N/A for a numeric GenCDE
  uncoveredLabels: string[];
  confidence: number;
  needsReview: boolean;
  rationale: string;
  generatedBy: string;
  // numeric concepts only
  units?: string;
  minimum?: number;
  maximum?: number;
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
  gencde: GenCDE | null; // novel route -> synthesized spec-conformant CDE proposal; null otherwise
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
  gencde: number;
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

/** Realized cost + token totals for one pipeline stage (from the backend's cost ledger). */
export interface StageCost {
  usd: number;
  inputTokens: number;
  outputTokens: number;
  calls: number;
}
/** Realized run cost — REAL spend: tokens captured per LLM call and priced against LiteLLM's model→price map
 *  (Batch billed at 50%). For a BYOK run this is the user's own provider bill, not an estimate. */
export interface RunCost {
  actualUsd: number;
  tokens: { input: number; output: number };
  perStage: Record<string, StageCost>;
}

/** One source field in a preview cluster (a capped sample of the cluster's members). */
export interface PreviewMember {
  cohort: string;
  variable: string;
  text: string;
}
/** One retrieved CDE candidate for a preview cluster — a RETRIEVAL hit, NOT an assignment (preview skips the
 *  LLM assign stage). */
export interface PreviewCandidate {
  rank: number;
  cdeId: string;
  cdeExternalId: string;
  definition: string;
  cosine: number;
}
/** A preview-mode cluster: the deterministic front half (embed → cluster → retrieve), no LLM. `members` is a
 *  capped sample (`nMembers` is the true size); `candidates` are the top-k retrieved CDEs. A full run's LLM
 *  stages can substantially restructure these. */
export interface PreviewCluster {
  clusterId: string;
  nMembers: number;
  cohorts: string[];
  crossCohort: boolean;
  top1Cos: number | null;
  members: PreviewMember[];
  candidates: PreviewCandidate[];
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
  // Realized run cost — real spend, not an estimate (contract v3+). Optional so pre-v3 demo fixtures still parse.
  cost?: RunCost;
  // PREVIEW ONLY (contract v4+): clusters + retrieved CDE candidates from the deterministic front half, so a
  // preview shows viz + candidate matches instead of a bare status string. Absent/empty on a full run.
  previewClusters?: PreviewCluster[];
}

export interface JobResult {
  jobId: string;
  displayName: string;
  status: JobStatus;
  phase: string;
  completed: number;
  total: number;
  errorMessage: string | null;
  // On a failed run, the pipeline stage it was in when it broke (e.g. "assigning"); null/absent otherwise.
  // Feeds the "Report this problem" link so a filed issue names the failing stage.
  failedPhase?: string | null;
  result: HarmonizationResult | null;
  config: Record<string, unknown>;
  decisions: Record<string, { decision: string; note: string }>;
  // Opt-in, LLM-suggested downstream analyses (null until generated; see POST /jobs/{id}/analysis-ideas).
  analysisIdeas?: AnalysisIdea[] | null;
  createdAt: number;
  updatedAt: number;
  // Present on the bundled demo fixture: per-phase wall-clock from the real build run, used to pace the
  // client-side replay in static (backend-less) mode so the Netlify demo feels like a live run.
  phaseTimings?: Record<string, number>;
  // LIVE runs only: wall-clock epoch (seconds) when the run first entered each reported phase — the
  // backend "stage-event stream". Powers the run view's per-stage timeline + elapsed. Absent on DB-hydrated
  // historical runs (which fall back to total elapsed = updatedAt − createdAt).
  phaseStartedAt?: Record<string, number>;
  // True once a Stop has been requested but the run hasn't reached its cancel checkpoint yet (backend-derived:
  // cancel_mode set and status not terminal). Lets the run view show a "Stopping…" state. The raw keep/discard
  // mode is never exposed.
  stopping?: boolean;
  // LIVE runs: realized cost-so-far in USD, streamed as each LLM stage prices its captured token usage — the
  // "spent so far" counter. Absent on DB-hydrated historical runs (not persisted); the final total is in
  // result.cost.actualUsd. A demo fixture may carry it so the Runs list shows the demo's build cost.
  costSoFar?: number;
}

export interface JobSummary extends Omit<JobResult, "result" | "analysisIdeas"> {
  nRecords: number;
}

/** One LLM-suggested downstream analysis unlocked by this run's cross-cohort harmonization. */
export interface AnalysisIdea {
  title: string;
  hypothesis: string;
  concepts: string[]; // grounded in this run's own concepts
  cohorts: string[];
  method: string;
  whyNewlyPossible: string;
  category: string;
}

export interface DictSpec {
  filename: string;
  cohortName: string;
  columnRoles: Record<string, string>;
}

// One selectable model in the "New Run" picker. The catalog comes from the LiteLLM proxy's
// GET /model/info when a proxy is configured, else a built-in fallback list (see api.listModels).
export interface ModelInfo {
  id: string; // the model tag the engine routes on (e.g. "claude-sonnet-4-6", "gemini/gemini-1.5-pro")
  provider: string; // "anthropic" | "openai" | "gemini" | "local" | "other"
  label: string; // human-facing label for the dropdown
}

export interface RunConfig {
  dictionaries: DictSpec[];
  cdeSet: CdeSet;
  runMode: RunMode;
  genTransformSpecs: boolean;
  // Generate "analysis ideas" during the run (one extra LLM pass, same model/provider/key). No-op in preview.
  suggestAnalysisIdeas: boolean;
  displayName?: string;
  // advanced passthrough knobs (optional; the engine auto-scales min_cluster_size from corpus size when
  // omitted, and falls back to harmonize_leanb's own defaults for the rest)
  minClusterSize?: number;
  topK?: number;
  retrievalFloor?: number;
  modelTag?: string; // the chosen model id (from the picker); routes provider selection in the engine
  provider?: string; // the chosen provider (informational; the engine derives routing from modelTag)
  // Corpus size the New-Run form estimated, echoed back on the run's config so the Stop dialog can price a
  // partial stop (run_config carries no dictionaries to re-count). Persisted snake_case as est_fields/est_cohorts.
  estFields?: number;
  estCohorts?: number;
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
  // ddharmon core version the demo snapshots were built with (stamped by scripts/build_demos.py). Shown on the
  // demo page so users know which release the frozen demo reflects — prod lags dev, so its demo may predate
  // features already live on dev.ddharmon.io.
  coreVersion?: string;
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
    "The variable's unique identifier or code in your dataset (e.g. BMI, Q47_weight). Optional — a synthetic row id is generated if you don't map it; it's the join key other roles attach to.",
  description:
    "A human-readable definition of what the variable measures (e.g. “Body mass index in kg/m²”). The primary signal used to match your variable to a CDE.",
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
    "An external or catalog identifier for the variable, if you have one (e.g. a study's field number).",
  standard_code:
    "An existing ontology/standard code for the variable, if already annotated (e.g. LOINC, SNOMED, a CDE tinyId).",
};

// PRE-run cost ESTIMATE (the one number that can't be exact — tokens aren't known until the run). Its price
// basis is real: the same Claude Sonnet rates ddharmon's cost accounting prices against (LiteLLM model→price
// map — $3/1M input, $15/1M output), calibrated to an observed run (~$1.45 batch over ~7,451 fields ⇒
// ~$0.0002/field). Cost is ~linear in fields; split+assign (≈77%) grow with cohort count, so a small
// cross-cohort multiplier is applied. Batch ≈ 50% of sync; preview uses no LLM. The POST-run ACTUAL cost
// (result.cost, from captured tokens) supersedes this — it's the real spend, not an estimate.
// Calibrated to an observed FULL run (all stages: ideal+split+assign+gencde+specs): 769 vars × 5 cohorts,
// sync = $5.38 realized (Sonnet $3/$15; ~1013 in + 264 out tokens/field across stages). Back out the ×2 sync
// and ×1.32 cohort factors → ~$0.0026/field for a full BATCH run. (Was 0.0002 — ~13× too low: it counted
// only a small assign prompt and missed split/gencde/specs + the large CDE-candidate prompt context.)
// Rough: the LLM stages really scale with clusters/records/novels, not linearly with fields, and the `full`
// CDE set costs more than the `endorsed` set this was calibrated on. The POST-run result.cost is truth.
const PER_FIELD_BATCH_USD = 0.0026;
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

// Per-stage shares of the full LLM total, from the observed run above (fractions of $5.38): gen-ideal ≈6%,
// split+assign ≈44%, GenCDE synthesis of novel concepts ≈28%, transform spec-gen ≈22% (embedding/clustering
// are local → $0). Sum ≈ 1.0 with all stages on. Used for the itemized estimate.
const STAGE_SHARES = { ideal: 0.06, splitAssign: 0.44, gencde: 0.28, specgen: 0.22 };
// "Analysis ideas" is ONE LLM pass over the concept digest (not per-field), so it's a small flat add on top
// of the run — independent of corpus size and of batch/sync (it always runs synchronously).
const ANALYSIS_IDEAS_USD = 0.05;
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
  suggestIdeas = false,
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
    { label: "Generate CDEs for novel concepts", cost: line(STAGE_SHARES.gencde) },
  ];
  if (genSpecs) lines.push({ label: "Transform spec-gen", cost: line(STAGE_SHARES.specgen) });
  if (suggestIdeas) lines.push({ label: "Analysis ideas", cost: ANALYSIS_IDEAS_USD, note: "one LLM pass" });
  const mid = lines.reduce((s, l) => s + l.cost, 0);
  return {
    free: false,
    lines,
    total: { low: mid * 0.6, mid, high: mid * 1.6, free: false },
    batchSavings: mode === "batch" ? mid : 0, // sync would cost ~2×, so batch saves ≈ mid
  };
}

// Fraction of a run's total LLM cost already committed by the time it is IN a given phase — i.e. what a
// "keep" stop (finish the current stage, skip the rest) would still be billed. Local stages (loading/
// embedding/clustering) are free; the LLM stages accrue in order. Cumulative through each stage, from the
// observed run's per-stage shares (ideal 6% → split 22% → assign 22% → gencde 28% → specs 22%). Anything
// past the current stage is avoided. Keys mirror the backend phase labels.
const STOP_COMMITTED_BY_PHASE: Record<string, number> = {
  loading: 0,
  embedding: 0,
  clustering: 0,
  generating: 0.06, // gen-ideal done
  splitting: 0.28, // + splitting
  assigning: 0.5, // + assigning (split+assign done)
  gencde: 0.78, // + GenCDE synthesis (novels)
  specs: 1, // + transform spec-gen (last paid stage)
  complete: 1,
};

export interface StopCostSplit {
  committed: number; // ≈ USD already committed this run (billed even on a "keep" stop)
  avoided: number; // ≈ USD a stop-now avoids (the skipped downstream stages)
  total: number; // ≈ USD the full run would cost
  hasEstimate: boolean; // false when the run carries no corpus size (older run / API caller) → show qualitative copy
}

// Price a mid-run stop for the Stop dialog: how much is already committed vs. avoided by stopping in `phase`.
// Reads the corpus size the New-Run form persisted onto the run's config (est_fields/est_cohorts, snake_case)
// and the run_mode. A preview run (or a run with no stored counts) yields total 0 / hasEstimate=false, so the
// dialog falls back to qualitative wording rather than a bogus "$0".
export function stopCostSplit(config: Record<string, unknown>, phase: string): StopCostSplit {
  const estFields = typeof config.est_fields === "number" ? config.est_fields : 0;
  const estCohorts = typeof config.est_cohorts === "number" ? config.est_cohorts : 0;
  const runMode = (typeof config.run_mode === "string" ? config.run_mode : "batch") as RunMode;
  const total = estFields > 0 ? estimateRunCost(estFields, estCohorts, runMode).mid : 0;
  const frac = STOP_COMMITTED_BY_PHASE[phase] ?? 0.5; // unknown mid-run phase: assume ~half committed
  const committed = total * frac;
  return { committed, avoided: Math.max(0, total - committed), total, hasEstimate: estFields > 0 && total > 0 };
}

// Rough WALL-CLOCK estimate for a run — the time analog of estimateRunCost, and the SAME model used for
// both the pre-run estimate (New Run form) and the live ETA (run view). Much rougher than cost: embedding
// + clustering are local CPU (scale with fields); the LLM stages dominate the rest. Batch turnaround is set
// mostly by the Anthropic Batch API QUEUE (minutes to tens of minutes, only weakly tied to size), so its
// range is wide and flagged. Sync scales ~linearly with fields; preview is local-only. Order-of-magnitude —
// meant to set expectations, not promise a deadline.
const LOCAL_BASE_SECS = 15; // fixed model-load + setup before any per-field work
const LOCAL_PER_FIELD_SECS = 0.03; // embedding + UMAP/HDBSCAN, per field
const SYNC_PER_FIELD_SECS = 0.5; // sequential LLM calls (ideal + split + assign + specs), per field
const BATCH_QUEUE_SECS = 300; // typical Batch API turnaround floor — highly variable (see `note`)

export interface TimeEstimate {
  low: number; // seconds
  mid: number;
  high: number;
  note?: string; // caveat to show alongside (e.g. batch queue variance)
}
export function estimateRunTime(totalFields: number, nCohorts: number, mode: RunMode): TimeEstimate {
  if (totalFields <= 0) return { low: 0, mid: 0, high: 0 };
  const cohortFactor = 1 + 0.08 * Math.max(0, nCohorts - 1); // cross-cohort assign work grows with cohorts
  const local = LOCAL_BASE_SECS + totalFields * LOCAL_PER_FIELD_SECS;
  if (mode === "preview") return { low: local * 0.6, mid: local, high: local * 1.5 };
  if (mode === "sync") {
    const mid = local + totalFields * SYNC_PER_FIELD_SECS * cohortFactor;
    return { low: mid * 0.6, mid, high: mid * 1.8 };
  }
  // batch: local work + Batch API queue turnaround (the queue dominates and varies widely).
  const mid = local + BATCH_QUEUE_SECS + totalFields * 0.05 * cohortFactor;
  return { low: mid * 0.5, mid, high: mid * 3, note: "Batch API queue time varies widely" };
}

/** Compact human duration: "45s", "6 min", "1h 20m". */
export function formatDuration(secs: number): string {
  if (secs <= 0) return "—";
  if (secs < 60) return `${Math.round(secs)}s`;
  const m = Math.round(secs / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? `${h}h ${rem}m` : `${h}h`;
}

/** A "~2–5 min" span from a TimeEstimate (collapses to one value when the ends round equal). */
export function formatDurationRange(t: TimeEstimate): string {
  if (t.mid <= 0) return "—";
  const lo = formatDuration(t.low);
  const hi = formatDuration(t.high);
  return lo === hi ? lo : `${lo}–${hi}`;
}

// Verdict → badge styling (Phenome Health tokens).
export const VERDICT_STYLES: Record<string, string> = {
  adopt: "bg-success-bg text-success border-success/30",
  refine: "bg-warning-bg text-warning border-warning/30",
  novel: "bg-ph-navy/10 text-ph-navy border-ph-navy/30",
  unclassified: "bg-neutral-100 text-neutral-600 border-neutral-300",
};

// ── concept display label ────────────────────────────────────────────────────────────────────
// A concept's display name must NEVER be a raw internal id. The split-aware pipeline keys a group
// `<clusterHash>#g<n>`; when the labeling step doesn't attach a human title, that key can leak into
// `concept` (observed: "c5c089913f98b#g1"). Guarding here keeps the UI honest regardless of the backend —
// the deeper fix (always generate a title, incl. split-residual subgroups) lives in the core labeler.

/** True when `concept` is empty or a raw internal id — a `<hash>#g<n>` group key, a bare long cluster
 *  hash, or a value equal to the record's own cluster/group id — rather than a human-readable label. */
export function isRawConceptId(
  concept: string | null | undefined,
  ids: { clusterId?: string; groupId?: string } = {},
): boolean {
  const c = (concept ?? "").trim();
  if (!c) return true;
  if (c === ids.clusterId || c === ids.groupId) return true;
  return /^[0-9a-f]{6,}#g\d+$/i.test(c) || /^[0-9a-f]{12,}$/i.test(c);
}

/** The human-readable label for a concept card. When `concept` is a leaked raw id (or empty), fall back to
 *  the GenCDE title, then the concept-summary's first phrase, then a variable-count placeholder — so the UI
 *  never prints a hash. Otherwise returns `concept` untouched. */
export function conceptLabel(
  r: Pick<UIRecord, "concept" | "clusterId" | "groupId" | "gencde" | "idealCde" | "nMembers">,
): string {
  const c = (r.concept ?? "").trim();
  if (!isRawConceptId(c, { clusterId: r.clusterId, groupId: r.groupId })) return c;
  const gTitle = (r.gencde?.title || r.gencde?.preferredName || "").trim();
  if (gTitle) return gTitle;
  const ideal = (r.idealCde ?? "").trim();
  if (ideal) {
    const phrase = ideal.split(/[.;\n]/)[0].trim();
    return phrase.length > 80 ? `${phrase.slice(0, 77)}…` : phrase;
  }
  const n = r.nMembers ?? 0;
  return `Unnamed concept (${n} variable${n === 1 ? "" : "s"})`;
}

// ── value-encoding labels (for the value-mapping display) ──────────────────────────────────────
// The value-mapping panel shows code→code recodes; these turn the bare codes into `code (label)` so a
// reviewer can read what each code MEANS. Source labels come from the loaded dictionary's value encoding
// (responseOptions, else the inline valueEncoding string); target labels from a novel concept's GenCDE
// permissible values. Assigned real CDEs don't carry their permissible values in the payload → bare code.

/** Parse an inline value-encoding string ("1=Yes|2=No") into a `{code: label}` map. Splits on the FIRST
 *  `=` per pair (labels may contain `=`); tolerates `|` or `;` pair separators. */
export function parseValueEncoding(enc: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!enc) return out;
  for (const pair of enc.split(/[|;]/)) {
    const s = pair.trim();
    const eq = s.indexOf("=");
    if (eq <= 0) continue;
    const code = s.slice(0, eq).trim();
    if (code) out[code] = s.slice(eq + 1).trim();
  }
  return out;
}

/** Source-side `{code: label}` for a field, preferring parsed `responseOptions`, falling back to the inline
 *  `valueEncoding` string. Empty for a numeric/open field with no coded options. */
export function sourceValueLabels(fd: FieldDetail | undefined): Record<string, string> {
  if (!fd) return {};
  if (fd.responseOptions?.length) {
    const out: Record<string, string> = {};
    for (const o of fd.responseOptions) if (o.code) out[o.code] = o.label ?? "";
    return out;
  }
  return parseValueEncoding(fd.valueEncoding);
}

/** `{code: label}` from a set of permissible values (a GenCDE's reconciled domain) — the target side. */
export function permissibleValueLabels(opts: ResponseOption[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const o of opts ?? []) if (o.code) out[o.code] = o.label ?? "";
  return out;
}
