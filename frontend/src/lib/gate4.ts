import type { ExportFormat, HarmonizationResult } from "@/types";
import {
  GATE_DECISION_KINDS,
  type DecisionIndex,
  type GateDecision,
  type GateDecisionKind,
  deriveStaleness,
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
    description: "Your approve / refine / reject decisions for this run — the audit trail that defends the export.",
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
  gate1_regroup: "Moved a variable",
  gate1_rename: "Renamed a group",
  gate2_candidate_pick: "Picked a target",
  gate2_relation: "Set a relation",
  gate3_spec_edit: "Edited a transform spec",
  gate4_export_selection: "Chose export inclusion",
  composite_swap: "Swapped a component",
};

export interface DecisionLogRow {
  kind: GateDecisionKind;
  gate: string;
  action: string;
  /** The thing decided (the decision's item key), e.g. a group id or a variable name. */
  thing: string;
  /** The identifier currently taken. `""` (rendered as "none of these") when the reviewer cleared it. */
  chosen: string;
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
export function decisionLogRows(index: DecisionIndex): DecisionLogRow[] {
  const stale = new Set(deriveStaleness(index).map((s) => `${s.kind}${s.itemKey}`));
  const rows: DecisionLogRow[] = [];
  for (const kind of GATE_DECISION_KINDS) {
    const byItem = index[kind];
    if (!byItem) continue;
    for (const [itemKey, decision] of Object.entries(byItem)) {
      rows.push({
        kind,
        gate: GATE_OF[kind],
        action: ACTION_OF[kind],
        thing: itemKey,
        chosen: String(decision.chosen ?? ""),
        stale: stale.has(`${kind}${itemKey}`),
      });
    }
  }
  return rows;
}

export function decisionCount(index: DecisionIndex): number {
  return GATE_DECISION_KINDS.reduce((n, kind) => n + Object.keys(index[kind] ?? {}).length, 0);
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
): RevisionRate {
  const records = result?.records ?? [];
  // Denominator: records not scoped OUT at Gate 1 — the population the reviewer actually adjudicated.
  const scopedOut = new Set(
    Object.values(index.gate1_group_scope ?? {})
      .filter((d) => String(d.chosen) === "out")
      .map((d) => String((d as GateDecision).groupId ?? "")),
  );
  const shown = records.filter((r) => !scopedOut.has(r.groupId)).length || records.length;

  // Numerator: distinct records touched by a substantive edit. A decision's identity key starts with the
  // record/group id for every substantive kind, so the leading segment identifies the record it edited.
  const editedRecords = new Set<string>();
  let excludedCosmetic = 0;
  for (const kind of GATE_DECISION_KINDS) {
    const byItem = index[kind] ?? {};
    for (const itemKey of Object.keys(byItem)) {
      if (SUBSTANTIVE_EDIT_KINDS.includes(kind)) {
        editedRecords.add(itemKey.split("|")[0]);
      } else if (kind === "gate1_rename") {
        excludedCosmetic += 1; // the named P5 cosmetic example
      }
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
  decisions: Record<string, { decision?: string; note?: string }> | undefined,
): string {
  const records = (result?.records ?? []).slice(0, 3);
  const dec = decisions ?? {};
  if (records.length === 0) return "This run produced no concept records, so this artifact would be empty.";

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
