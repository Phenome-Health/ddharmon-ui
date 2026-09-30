import type { ExportFormat, HarmonizationResult, UIRecord, UITransform } from "@/types";
import {
  GATE_DECISION_KINDS,
  type DecisionIndex,
  type GateDecision,
  type GateDecisionKind,
  deriveStaleness,
  inheritedGate1Scope,
} from "@/lib/gate-decisions";

/**
 * Gate 4's pure logic — the export catalog, the download-label rule, the decision-log rows, and the E3
 * revision-rate. Kept here, out of the React tree, for the reason `lib/gate-decisions.ts` gives: `frontend/`
 * has no component test runner, so logic reachable only through a component ships unasserted. Everything in
 * this file is pure and is pinned by `tests/e2e/gate4.spec.ts`.
 */

// --- the export catalog (UI-SPEC §0.2) ----------------------------------------------------------------

/**
 * A run's artifact is `ready` once the result exists; `generating` while the pipeline is still producing it;
 * `failed` when it was attempted and produced nothing. The last two are DIFFERENT claims from the
 * not-available tiles below — a defect versus a boundary — and must never look alike (UI-SPEC §9, T-08-103).
 */
export type ArtifactState = "ready" | "generating" | "failed";

/** A shipping export. `notebook` collapses `notebook_py`/`notebook_r` behind the language toggle (Surface 1). */
export interface RealArtifact {
  /** The tile's id. `notebook` is resolved to a concrete `ExportFormat` by the chosen language. */
  id: ExportFormat | "notebook";
  name: string;
  /** One sentence, per Surface 2. */
  description: string;
  /** The download filename, so the reviewer sees what lands in Downloads before they click. */
  filename: string;
}

/**
 * The FOUR tiles that cover the FIVE shipping formats (`backend/app.py` export route): the two notebook
 * formats collapse into one tile whose language is the segmented control. Descriptions are the one-sentence
 * form of the tooltips the retired `dashboard.tsx` ExportButton carried, so no capability description is lost
 * in the supersession.
 */
export const REAL_ARTIFACTS: readonly RealArtifact[] = [
  {
    id: "eitl_tsv",
    name: "Expert-review queue (TSV)",
    description:
      "One row per concept — its verdict, confidence, ranked CDE candidates and transform — for expert-in-the-loop sign-off.",
    filename: "eitl_tsv.tsv",
  },
  {
    id: "decisions_csv",
    name: "Decision log (CSV)",
    description:
      "Every decision you made at Gates 1–4, with what it changed from and to — the audit trail that defends the export.",
    filename: "decisions_csv.csv",
  },
  {
    id: "records_json",
    name: "Records (JSON)",
    description: "The full machine-readable result — every concept with members, verdict, candidates and specs.",
    filename: "records_json.json",
  },
  {
    id: "notebook",
    name: "Transform notebook",
    description: "A ready-to-run notebook that applies the harmonization transforms to your data in your own environment.",
    filename: "harmonization.ipynb",
  },
] as const;

/** The concrete export format a notebook tile resolves to for the chosen language. */
export type NotebookLang = "py" | "r";
export function notebookFormat(lang: NotebookLang): ExportFormat {
  return lang === "r" ? "notebook_r" : "notebook_py";
}

/** Resolve a tile id + chosen language to the concrete backend export format for a download. */
export function resolveFormat(id: RealArtifact["id"], lang: NotebookLang): ExportFormat {
  return id === "notebook" ? notebookFormat(lang) : id;
}

/** An honest "not available" gap (UI-SPEC §9 rows 4/5/6): deferred by design, never quietly omitted. */
export interface NotAvailableGap {
  slug: string;
  thing: string;
  /** Why, one sentence, and what to do instead. */
  body: string;
}

export const NOT_AVAILABLE_GAPS: readonly NotAvailableGap[] = [
  {
    slug: "mapping-table",
    thing: "Mapping table",
    body: "This run exports records and decisions; a flat mapping table is not one of the formats yet.",
  },
  {
    slug: "run-report",
    thing: "Run report (HTML)",
    body: "The plots on this run are viewable in the app; a self-contained report file is not generated yet.",
  },
  {
    slug: "composite-notebook",
    thing: "Composite recipes in the notebook",
    body: "The notebook applies approved recodes; it has no notion of a derived variable, so a composite score you built is not computed by it. Export the records to carry it.",
  },
] as const;

// --- the download action label (UI-SPEC §8.1) ---------------------------------------------------------

/**
 * `Download 1 artifact` for one, `Download N artifacts` for several. Driven exactly off the count so the
 * label can never disagree with what will be downloaded; the caller disables the action at zero and names
 * the reason separately (UI-SPEC §8.2, "No artifacts selected").
 */
export function downloadLabel(count: number): string {
  return count === 1 ? "Download 1 artifact" : `Download ${count} artifacts`;
}

// --- the decision log (UI-SPEC §0.2 Surface 4) --------------------------------------------------------

const GATE_OF: Record<GateDecisionKind, string> = {
  gate1_group_scope: "Gate 1",
  gate1_new_group: "Gate 1",
  gate1_regroup: "Gate 1",
  gate1_rename: "Gate 1",
  gate2_candidate_pick: "Gate 2",
  gate2_relation: "Gate 2",
  gate3_spec_edit: "Gate 3",
  gate4_export_selection: "Gate 4",
  composite_swap: "Composite",
};

const ACTION_OF: Record<GateDecisionKind, string> = {
  gate1_group_scope: "Set group scope",
  gate1_new_group: "Created a group",
  gate1_regroup: "Moved a variable",
  gate1_rename: "Renamed a group",
  gate2_candidate_pick: "Picked a target",
  gate2_relation: "Set a relation",
  gate3_spec_edit: "Edited a transform spec",
  gate4_export_selection: "Chose export inclusion",
  // The only composite write is the DECLARATION of a component (08-27 audit) — swaps never persisted.
  composite_swap: "Declared a score component",
};

export interface DecisionLogRow {
  kind: GateDecisionKind;
  gate: string;
  action: string;
  /** The thing decided (the decision's item key), e.g. a group id or a variable name. */
  thing: string;
  /** The identifier currently taken. `""` (rendered as "none of these") when the reviewer cleared it. */
  chosen: string;
  /** The concept's name for a group-keyed decision (the reviewer's rename, else the generated one). */
  label?: string;
  /** What the decision DID, in words — before → after where it is known. Replaces "→ chosen" when present. */
  detail?: string;
  /** DERIVED: the upstream this decision depended on has since changed, so it may be out of date. */
  stale: boolean;
}

/**
 * Flatten the full decision index into an ordered, human-readable log over all EIGHT registered kinds.
 *
 * Sourced from `GATE_DECISION_KINDS` (the live registry), so a kind added later — as `gate1_rename` was —
 * appears in the log without a second edit here. The index already holds only the CURRENT decision per
 * thing (last write wins per item key), so a superseded choice is not shown as a separate row; instead a
 * decision whose upstream changed is marked `stale`, which is how the log "shows superseded honestly"
 * without claiming an earlier choice never happened.
 */
export function decisionLogRows(
  index: DecisionIndex,
  result?: HarmonizationResult | null,
): DecisionLogRow[] {
  const stale = new Set(deriveStaleness(index).map((s) => `${s.kind}${s.itemKey}`));
  const records = new Map((result?.records ?? []).map((r) => [r.groupId, r]));
  const renames = index.gate1_rename ?? {};
  const newGroups = index.gate1_new_group ?? {};
  const nameOf = (gid: unknown): string | undefined => {
    if (typeof gid !== "string" || !gid || gid === "__unassigned__") return undefined;
    const renamed = renames[gid]?.chosen;
    if (typeof renamed === "string" && renamed.trim()) return renamed.trim();
    // A New group has no record until Gate 2 — its own decision carries its name.
    const made = newGroups[gid];
    const madeName = made && (typeof made.name === "string" && made.name.trim() ? made.name : made.chosen);
    if (typeof madeName === "string" && madeName.trim()) return madeName.trim();
    return records.get(gid)?.concept || gid;
  };
  const rows: DecisionLogRow[] = [];
  for (const kind of GATE_DECISION_KINDS) {
    // Scope is summarised, not listed: one row per group buried ~20 real edits under 1,234 scope rows on the
    // live run (08-27 audit). See `scopeSummary`.
    if (kind === "gate1_group_scope") continue;
    const byItem = index[kind];
    if (!byItem) continue;
    for (const [itemKey, decision] of Object.entries(byItem)) {
      const d = decision as GateDecision;
      const gid = typeof d.groupId === "string" ? d.groupId : undefined;
      rows.push({
        kind,
        gate: GATE_OF[kind],
        action: ACTION_OF[kind],
        thing: itemKey,
        chosen: String(d.chosen ?? ""),
        label: gid ? nameOf(gid) : undefined,
        detail: detailOf(kind, d, nameOf, gid ? records.get(gid) : undefined),
        stale: stale.has(`${kind}${itemKey}`),
      });
    }
  }
  return rows;
}

/** Gate 1 scope, as counts — the log shows this line instead of one row per group. */
export function scopeSummary(index: DecisionIndex): { in: number; out: number } {
  const all = Object.values(index.gate1_group_scope ?? {});
  return {
    in: all.filter((d) => String(d.chosen) === "in").length,
    out: all.filter((d) => String(d.chosen) === "out").length,
  };
}

function detailOf(
  kind: GateDecisionKind,
  d: GateDecision,
  nameOf: (gid: unknown) => string | undefined,
  record: { candidates?: { cdeId: string; isChosen?: boolean }[] } | undefined,
): string | undefined {
  const q = (t: unknown) => `“${String(t)}”`;
  switch (kind) {
    case "gate1_regroup":
      return `from ${nameOf(d.fromGroupId) ?? "no group"} to ${nameOf(d.chosen) ?? "no group"}`;
    case "gate1_rename":
      return typeof d.generatedName === "string" ? `${q(d.generatedName)} → ${q(d.chosen)}` : `→ ${q(d.chosen)}`;
    case "gate2_candidate_pick": {
      if (d.chosen === "") return d.gencdeEdit ? "your own CDE, edited" : "none of these";
      const model = record?.candidates?.find((c) => c.isChosen)?.cdeId;
      const edited = d.gencdeEdit ? ", anchor edited" : "";
      return model && model !== d.chosen ? `${String(d.chosen)} (model picked ${model})${edited}` : `${String(d.chosen)}${edited}`;
    }
    case "gate3_spec_edit": {
      const parts: string[] = [];
      if (d.rejected === true) parts.push("rejected");
      if (d.mapping != null) parts.push("value map edited");
      if (d.numberMap != null) parts.push("number map edited");
      if (d.bins != null) parts.push("binning edited");
      if (typeof d.note === "string" && d.note.trim()) parts.push(`note: ${q(d.note.trim())}`);
      return parts.length ? parts.join(" · ") : "saved with no change";
    }
    default:
      return undefined;
  }
}

export function decisionCount(index: DecisionIndex): number {
  return GATE_DECISION_KINDS.reduce((n, kind) => n + Object.keys(index[kind] ?? {}).length, 0);
}

// --- the decision-log CSV (08-27) -------------------------------------------------------------------------

/**
 * The columns of the downloaded decision log on a staged run — `backend/export_decisions.py::DECISION_LOG_COLS`.
 */
export const DECISION_LOG_CSV_COLS = ["gate", "kind", "action", "item", "before", "after", "note", "detail", "stale"];

/** The label a cleared choice (`chosen === ""`) reads as — `NONE_OF_THESE` in the backend. */
const NONE_OF_THESE = "none of these";
const SPEC_EDIT_FIELDS = ["mapping", "numberMap", "bins"] as const;

/**
 * Compact, key-sorted JSON — byte-identical to the backend's `_j` (`sort_keys`, no spaces, unescaped), so a
 * `detail` cell previews exactly as it downloads.
 */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

const clean = (s: unknown) => String(s ?? "").replace(/[\t\n\r]/g, " ");
const chosenLabel = (v: unknown) => String(v ?? "") || NONE_OF_THESE;

function modelPick(record: UIRecord | undefined): string {
  const chosen = record?.candidates?.find((c) => c.isChosen);
  if (chosen?.cdeId) return chosen.cdeId;
  return record?.cde?.id ?? "";
}

function specSummary(t: UITransform | undefined): string {
  if (!t) return "";
  const kind = String(t.kind ?? "");
  if (kind === "categorical" && t.codeMap && Object.keys(t.codeMap).length) return `categorical ${stableJson(t.codeMap)}`;
  if (kind === "unit") return `unit ${t.sourceUnit || "?"} -> ${t.targetUnit || "?"}`;
  if (kind === "arithmetic") return `arithmetic ${t.formula ?? ""}`;
  return kind;
}

/**
 * The decision log the `decisions_csv` download carries on a staged run, header first — the client mirror of
 * `backend/export_decisions.py::decision_log_rows`, pinned to it by the shared parity fixture
 * (`tests/e2e/fixtures/decision-log-parity.json`). One row per gate decision in gate order, preceded by the
 * scope Gate 1's Continue froze and followed by any workbench verdicts; `before` is filled where the run
 * knows it (the generated name, the variable's origin group, the model's pick, the model's recode).
 */
export function decisionLogCsvRows(
  index: DecisionIndex,
  result: HarmonizationResult | null | undefined,
  config: Record<string, unknown> | null | undefined,
  verdicts: Record<string, LegacyVerdicts> | undefined,
): string[][] {
  const records = result?.records ?? [];
  const byGroup = new Map(records.map((r) => [String(r.groupId || r.id || ""), r]));
  const specBySource = new Map<string, UITransform>();
  for (const r of records) for (const t of r.transforms ?? []) specBySource.set(String(t.sourceVariable ?? ""), t);
  const groups = new Map((result?.conceptGroups ?? []).map((g) => [String(g.groupId ?? ""), g]));
  const stale = new Set(deriveStaleness(index).map((s) => `${s.kind}\u001f${s.itemKey}`));

  const rows: string[][] = [DECISION_LOG_CSV_COLS];
  // Past Gate 1 the regrouping is frozen (`config.gate1_overrides`): a move in it was APPLIED by the pipeline, one
  // outside it was not (the run passed Gate 1 before moves were applied). At Gate 1 nothing is claimed either way.
  const regrouping = config?.gate1_overrides as { moves?: Record<string, unknown> } | undefined;
  const appliedMoves = new Set(Object.keys((regrouping && typeof regrouping === "object" && regrouping.moves) || {}));
  const passedGate1 =
    Array.isArray(config?.gate1_scope) || (!!regrouping && typeof regrouping === "object" && !Array.isArray(regrouping));
  const frozen = config?.gate1_scope;
  if (Array.isArray(frozen)) {
    rows.push(["Gate 1", "gate1_scope_frozen", "Continued with this scope", "", "", `${frozen.length} groups in scope`, "", stableJson(frozen), "false"]);
  }
  for (const kind of GATE_DECISION_KINDS) {
    for (const [item, d] of Object.entries(index[kind] ?? {})) {
      let before = "";
      let after = chosenLabel(d.chosen);
      let detail = "";
      const note = typeof d.note === "string" ? d.note : "";
      if (kind === "gate1_rename") {
        const gid = String(d.groupId || item);
        before = String(d.generatedName || byGroup.get(gid)?.concept || groups.get(gid)?.concept || "");
      } else if (kind === "gate1_regroup") {
        before = String(d.fromGroupId || "");
        if (passedGate1) detail = appliedMoves.has(item) ? "applied" : "not applied";
      } else if (kind === "gate2_candidate_pick") {
        before = byGroup.has(item) ? chosenLabel(modelPick(byGroup.get(item))) : "";
        if (d.gencdeEdit && typeof d.gencdeEdit === "object") detail = stableJson({ gencdeEdit: d.gencdeEdit });
      } else if (kind === "gate3_spec_edit") {
        before = specSummary(specBySource.get(item));
        const edit: Record<string, unknown> = {};
        for (const f of SPEC_EDIT_FIELDS) if (isPresent(d[f])) edit[f] = d[f];
        const edited = Object.keys(edit).length > 0;
        after = d.rejected ? "rejected" : edited ? "edited" : "annotated";
        if (edited) detail = stableJson(edit);
      }
      rows.push([GATE_OF[kind], kind, ACTION_OF[kind], item, before, after, note, detail, String(stale.has(`${kind}\u001f${item}`))]);
    }
  }
  for (const [recordId, v] of Object.entries(verdicts ?? {})) {
    if (v.decision) rows.push(["Workbench", "verdict", "Recorded a verdict", `${recordId}|match`, "", v.decision, v.note ?? "", "", "false"]);
    for (const [sv, t] of Object.entries(v.transforms ?? {}))
      rows.push(["Workbench", "verdict", "Recorded a verdict", `${recordId}|transform|${sv}`, "", t.decision ?? "", t.note ?? "", "", "false"]);
    if (v.gencde?.decision)
      rows.push(["Workbench", "verdict", "Recorded a verdict", `${recordId}|gencde`, "", v.gencde.decision, v.gencde.note ?? "", "", "false"]);
  }
  return rows.map((row) => row.map(clean));
}

/** Python's `if d.get(k)` truthiness for a JSON value: empty string / object / array are absent. */
function isPresent(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true;
}

/** One CSV line quoted the way Python's `csv.writer` quotes (minimal: only a field that needs it). */
export function csvLine(row: string[]): string {
  return row.map((c) => (/[",\r\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(",");
}

/** The legacy per-record verdict mirror (`jobState.decisions`) — what a workbench verdict is served as. */
export interface LegacyVerdicts {
  decision?: string;
  note?: string;
  transforms?: Record<string, { decision?: string; note?: string }>;
  gencde?: { decision?: string; note?: string };
}

/**
 * Whether a run downloads the staged decision log rather than the legacy per-record verdict CSV — the
 * backend's `is_staged`: the run is parked at a gate, or it carries any gate decision.
 */
export function isStagedExport(gatePosition: string | null | undefined, index: DecisionIndex): boolean {
  return !!gatePosition || decisionCount(index) > 0;
}

// --- E3 revision rate (external-methods audit E3, P5 exclusion, P2 denominator) ------------------------

/**
 * The gate-decision kinds that COUNT as a substantive edit of the pipeline's output (E3 numerator).
 *
 * Per the P5 exclusion rule written in `08-EXTERNAL-METHODS-AUDIT.md` §P5: a changed verdict/target
 * (`gate2_candidate_pick`), a relation choice (`gate2_relation`), a regrouping that moves a variable
 * (`gate1_regroup`), an edited transform spec (`gate3_spec_edit`) and a composite component swap
 * (`composite_swap`) are corrections and COUNT. Explicitly EXCLUDED as cosmetic / non-corrections:
 * `gate1_rename` (a display-label change, the named P5 example), `gate1_group_scope` (an inclusion/scope
 * choice, not a text correction) and `gate4_export_selection` (export inclusion). Encoding this as a set —
 * rather than inferring from a text diff — is what lets the rule be written down and asserted before the
 * metric ships, which is what P5 requires.
 */
export const SUBSTANTIVE_EDIT_KINDS: readonly GateDecisionKind[] = [
  "gate1_regroup",
  "gate2_candidate_pick",
  "gate2_relation",
  "gate3_spec_edit",
  "composite_swap",
];

/** P2: this metric's denominator, stamped on every rendered number so it is never read as a row count. */
export const REVISION_RATE_DENOMINATOR = "concept records reviewed";

export interface RevisionRate {
  /** Numerator: concept records the reviewer substantively edited (per SUBSTANTIVE_EDIT_KINDS). */
  edited: number;
  /** Denominator: concept records the reviewer was shown (in-scope), per P2 stamped as REVISION_RATE_DENOMINATOR. */
  shown: number;
  /** edited / shown in [0, 1]; 0 when nothing was shown. */
  rate: number;
  /** P2 denominator label, carried with the number so it is never mixed with a variable/row count. */
  denominator: string;
  /** Cosmetic decisions excluded from the numerator under the P5 rule — surfaced so the exclusion is visible. */
  excludedCosmetic: number;
  /**
   * Anti-drift stamp (P5): the pipeline release the rule was computed against. A dedicated `text_hygiene`
   * ruleset version is not on the wire, so `coreVersion` is the proxy — a hygiene change ships in a core
   * release, so a core bump makes the change visible rather than letting the number drift silently.
   */
  hygieneVersion: string;
}

/**
 * The E3 revision rate for a run, derived on the FRONTEND from persisted decisions plus the run result.
 *
 * DENOMINATOR LIMITATION, stated rather than hidden: the prior art (Long et al. 2026) denominates in
 * *metadata attributes* and needs a per-attribute record of what was shown and accepted unchanged. That
 * capture does not exist, and adding it is out of this frontend-only plan's scope. So this denominates in
 * *concept records reviewed* — the records in scope at the gates — and stamps that denominator (P2). The
 * numerator counts DISTINCT records touched by a substantive edit, under the P5 exclusion rule.
 */
export function revisionRate(
  index: DecisionIndex,
  result: HarmonizationResult | null | undefined,
  coreVersion: string,
  config?: Record<string, unknown> | null,
): RevisionRate {
  const records = result?.records ?? [];
  // Denominator: the records Gate 1 sent on — the FROZEN scope when the run has one (08-27 #3), else the legacy
  // "not scoped out" rule.
  const inScope = inheritedGate1Scope(config, index.gate1_group_scope ?? {});
  const shownRecords = records.filter((r) => inScope(r.groupId));
  const shownIds = new Set(shownRecords.map((r) => r.groupId));
  const shown = shownRecords.length || records.length;

  // Numerator: distinct CONCEPT RECORDS a substantive edit touched (08-27 audit). Identity keys are not record
  // ids for every kind — a regroup keys on the variable, a spec edit on the source variable, a composite on the
  // score — so each decision is resolved to the record it edited, and no-op decisions are skipped.
  const groupOfVariable = new Map<string, string>();
  for (const r of records) for (const m of r.members ?? []) if (!groupOfVariable.has(m)) groupOfVariable.set(m, r.groupId);
  const modelPick = new Map(records.map((r) => [r.groupId, r.candidates?.find((c) => c.isChosen)?.cdeId ?? ""]));
  const editedRecords = new Set<string>();
  const touch = (groupId: unknown) => {
    if (typeof groupId === "string" && shownIds.has(groupId)) editedRecords.add(groupId);
  };
  let excludedCosmetic = 0;
  for (const kind of GATE_DECISION_KINDS) {
    for (const d of Object.values(index[kind] ?? {}) as GateDecision[]) {
      if (kind === "gate1_rename") {
        excludedCosmetic += 1; // the named P5 cosmetic example
      } else if (kind === "gate2_candidate_pick" || kind === "gate2_relation") {
        const gid = String(d.groupId ?? "");
        const noop = kind === "gate2_candidate_pick" && d.chosen === modelPick.get(gid) && !d.gencdeEdit;
        if (!noop) touch(gid);
      } else if (kind === "gate1_regroup") {
        if (d.fromGroupId !== d.chosen) {
          touch(d.fromGroupId);
          touch(d.chosen);
        }
      } else if (kind === "gate3_spec_edit") {
        const substantive =
          d.rejected === true ||
          d.mapping != null ||
          d.numberMap != null ||
          d.bins != null ||
          (typeof d.note === "string" && d.note.trim() !== "");
        if (substantive) touch(groupOfVariable.get(String(d.sourceVariable ?? "")));
      }
      // composite_swap edits a SCORE, not a concept record — it is not part of this record-denominated rate.
    }
  }
  const edited = editedRecords.size;
  const rate = shown > 0 ? edited / shown : 0;
  return {
    edited,
    shown,
    rate,
    denominator: REVISION_RATE_DENOMINATOR,
    excludedCosmetic,
    hygieneVersion: coreVersion || "unknown",
  };
}

/** `12%` — the revision rate as a whole-number percentage, for display. */
export function formatRevisionPct(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

// --- review campaigns (UI-SPEC §0.2 Surface 3) --------------------------------------------------------

export interface VerdictBreakdown {
  adopt: number;
  refine: number;
  novel: number;
  total: number;
}

/** The verdict split of the concept records — what the EITL review queue contains. */
export function verdictBreakdown(result: HarmonizationResult | null | undefined): VerdictBreakdown {
  const records = result?.records ?? [];
  const b: VerdictBreakdown = { adopt: 0, refine: 0, novel: 0, total: records.length };
  for (const r of records) {
    if (r.verdict === "adopt") b.adopt += 1;
    else if (r.verdict === "refine") b.refine += 1;
    else if (r.verdict === "novel") b.novel += 1;
  }
  return b;
}

// --- artifact previews (UI-SPEC §0.2 Surface 2) -------------------------------------------------------

/**
 * A faithful preview of what an artifact CONTAINS, derived from the run result on the client.
 *
 * DERIVED, NOT FETCHED, and that is deliberate. The preview must show real generated content, never a
 * description of it (T-08-104) — a described preview looks like verification without being it. Deriving it
 * from the same `result`/`decisions` the download serializes means the preview is real content that is also
 * available in the backend-less build the e2e suite runs against, where fetching the file would 404. The
 * DOWNLOAD still pulls the byte-exact file from the export route; this is an excerpt of the same data.
 */
export function previewFor(
  id: RealArtifact["id"],
  lang: NotebookLang,
  result: HarmonizationResult | null | undefined,
  decisions: Record<string, LegacyVerdicts> | undefined,
  gateLog?: { index: DecisionIndex; config?: Record<string, unknown> | null; gatePosition?: string | null },
): string {
  const records = (result?.records ?? []).slice(0, 3);
  const dec = decisions ?? {};
  if (records.length === 0) return "This run produced no concept records, so this artifact would be empty.";

  // 08-27: on a staged run the download is the gate decision LOG, so the preview reads the same decisions
  // (never the legacy verdict mirror, which no gate writes) through the backend's own row rule.
  if (id === "decisions_csv" && gateLog && isStagedExport(gateLog.gatePosition, gateLog.index)) {
    const rows = decisionLogCsvRows(gateLog.index, result, gateLog.config, decisions);
    const shown = rows.slice(0, 13).map(csvLine);
    if (rows.length === 1) shown.push("(no decisions recorded yet — the file will carry only this header)");
    else if (rows.length > 13) shown.push(`… ${rows.length - 13} more decision(s) in the file`);
    return shown.join("\n");
  }

  if (id === "records_json") {
    return JSON.stringify(
      records.map((r) => ({
        id: r.id,
        concept: r.concept,
        verdict: r.verdict,
        cde: r.cde?.id ?? null,
        nMembers: r.nMembers,
        cohorts: r.cohorts,
        transforms: r.transforms?.length ?? 0,
      })),
      null,
      2,
    );
  }

  if (id === "decisions_csv") {
    const header = ["record_id", "concept", "verdict", "chosen_cde", "your_decision", "note"];
    const rows = records.map((r) => [
      r.id,
      r.concept,
      r.verdict,
      r.cde?.id ?? "",
      dec[r.id]?.decision ?? "",
      dec[r.id]?.note ?? "",
    ]);
    return [header, ...rows].map((row) => row.join(",")).join("\n");
  }

  if (id === "eitl_tsv") {
    const header = ["record_id", "concept", "verdict", "top_candidate", "n_members", "cohorts"];
    const rows = records.map((r) => [
      r.id,
      r.concept,
      r.verdict,
      r.candidates?.[0]?.cdeId ?? r.cde?.id ?? "",
      String(r.nMembers),
      r.cohorts.join(";"),
    ]);
    return [header, ...rows].map((row) => row.join("\t")).join("\n");
  }

  // notebook: a faithful excerpt of what the notebook applies — the transforms, in the chosen language.
  const langName = lang === "r" ? "R" : "Python";
  const lines: string[] = [
    `# Harmonization transform notebook (${langName})`,
    `# Applies ${records.reduce((n, r) => n + (r.transforms?.length ?? 0), 0)} transform(s) across ${
      result?.records?.length ?? 0
    } concept(s).`,
    "# The notebook runs where your data already lives; your data never enters ddharmon.",
    "",
  ];
  for (const r of records) {
    lines.push(`# ${r.concept} — ${r.verdict}${r.cde?.id ? ` → ${r.cde.id}` : ""}`);
    for (const t of r.transforms ?? []) {
      lines.push(`#   transform: ${t.kind ?? "recode"} on ${t.sourceVariable ?? r.id}`);
    }
  }
  return lines.join("\n");
}
