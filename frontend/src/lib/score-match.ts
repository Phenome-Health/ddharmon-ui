import type { CompositeSpec } from "@/types";
import type { DecisionIndex } from "@/lib/gate-decisions";
import type { RealArtifact } from "@/lib/gate4";
import { estimateScoreMatchUsd, formatUsd } from "@/lib/estimate";

/**
 * The declared score on GATE 4 — decision Q5 (2026-09-30), 08-28 1f.
 *
 * A score is DECLARED on Gate 1 (free: one `composite_swap` row per component) and MATCHED on Gate 4 (one paid
 * model call), against the concepts as the reviewer leaves them — scope, renames, target picks and edits all
 * applied. It could never be matched on Gate 1: a staged run parked there has concept groups but no assigned
 * records, and the panel's promise that "the verdict fills in once the run has got that far" pointed at no
 * screen that ever offered it (live verify 3 F20).
 *
 * `frozen` — a passed Gate 1 — blocks EDITING the declaration, never matching it: Gate 4 shows the declaration
 * as a record and matches it as it stands.
 *
 * Pure, like `lib/gate4.ts`, because `frontend/` has no component test runner: everything here is pinned by
 * `tests/e2e/gate4-score.spec.ts`. The server-side twin is `backend/declared_score.py`.
 */

/** One declared score: its name and its components, in the order they were DECLARED. */
export interface DeclaredScore {
  scoreName: string;
  components: string[];
}

/**
 * Every score the reviewer declared, grouped by name, components in DECLARED order.
 *
 * Each row's `alternatives` carries the whole list as it was declared — usually the paper's order — while the
 * decision index is keyed by identity, which reads back alphabetically (live verify 3 H3). Order within a score:
 * first appearance across the rows' `alternatives`, restricted to components that still have a row; a component
 * no list names follows in index order. Mirrors `backend/declared_score.py::declared_scores`.
 */
export function declaredScores(index: DecisionIndex | null | undefined): DeclaredScore[] {
  const byScore = new Map<string, { names: Set<string>; rows: { name: string; alternatives: unknown[] }[] }>();
  for (const d of Object.values(index?.composite_swap ?? {})) {
    const score = typeof d.scoreName === "string" ? d.scoreName.trim() : "";
    const name = typeof d.componentName === "string" ? d.componentName.trim() : "";
    if (!score || !name) continue;
    const entry = byScore.get(score) ?? { names: new Set<string>(), rows: [] };
    entry.names.add(name);
    entry.rows.push({ name, alternatives: Array.isArray(d.alternatives) ? d.alternatives : [] });
    byScore.set(score, entry);
  }
  const out: DeclaredScore[] = [];
  for (const [scoreName, { names, rows }] of byScore) {
    const ordered: string[] = [];
    for (const r of rows)
      for (const a of r.alternatives) {
        const n = String(a).trim();
        if (names.has(n) && !ordered.includes(n)) ordered.push(n);
      }
    for (const r of rows) if (!ordered.includes(r.name)) ordered.push(r.name);
    out.push({ scoreName, components: ordered });
  }
  return out;
}

/** The newest spec derived under `scoreName` (case-insensitive, the `composite` kind's own identity), or null. */
export function specForScore(
  composites: readonly CompositeSpec[] | null | undefined,
  scoreName: string,
): CompositeSpec | null {
  const wanted = scoreName.trim().toLowerCase();
  let found: CompositeSpec | null = null;
  for (const s of composites ?? []) if ((s.definition?.name ?? "").trim().toLowerCase() === wanted) found = s;
  return found;
}

/** The paid action's label — its one call and its price ON the control, as every other paid control does. */
export function matchActionLabel(nComponents: number, again = false): string {
  return `${again ? "Match again" : "Match"} (one model call, about ${formatUsd(estimateScoreMatchUsd(nComponents))})`;
}

/**
 * Gate 1's honest not-available for matching (08-28 1f): WHERE it happens, instead of a verdict that never came.
 * Gate 1 keeps the declaration (free) and its per-component group hints as the scoping aid.
 */
export const GATE1_MATCH_DEFERRED =
  "Matching happens on Gate 4 (Export), against the concepts as you leave this review — after scope, renames, " +
  "target picks and edits. Declare the components now: it is free and it is saved, and Gate 4 shows this " +
  "declaration and matches it for one model call.";

/** Why Gate 4 cannot match here, or null when it can. The declaration is shown either way. */
export function gate4MatchRefusal(opts: { pinned?: boolean }): { claim: "not-enabled"; reason: string } | null {
  if (opts.pinned) {
    return {
      claim: "not-enabled",
      reason:
        "This is the shared demo, which never spends money. Clone it into a run of your own to match the " +
        "declared score against its concepts.",
    };
  }
  return null;
}

// --- the score file ------------------------------------------------------------------------------------

/** The export tile for the score file — offered only on a run that carries a declared or derived score. */
export const SCORE_ARTIFACT: RealArtifact = {
  id: "score_json",
  name: "Declared score (JSON)",
  description:
    "The score you declared at Gate 1 — its components, the match verdict, per-cohort coverage and the derivation recipe. A recipe, never a computed score.",
  filename: "score_json.json",
};

/** The file's own statement of what it is. Identical to `backend/declared_score.py::EXPORT_NOTE`. */
export const SCORE_EXPORT_NOTE =
  "A recipe, not a computed score. Presence is per data dictionary: it says a cohort records a variable, not how many participants have a value for it. ddharmon never computes the score — run the derivation on your own rows. Partial coverage is not the published score.";

export interface ScoreExportEntry {
  scoreName: string;
  declaredComponents: string[];
  /** `matched` — a spec exists; `declared` — declared, not matched yet; `derived` — a spec with no declaration. */
  status: "matched" | "declared" | "derived";
  /** The spec's presentation verdict, or `indeterminate` when nothing was matched — never the negative claim. */
  verdict: string;
  spec: CompositeSpec | null;
}

/** The `score_json` export, built the way the server builds it — what the Gate 4 preview shows. */
export function scoreExport(
  scores: readonly DeclaredScore[],
  composites: readonly CompositeSpec[] | null | undefined,
): { note: string; scores: ScoreExportEntry[] } {
  const entry = (
    scoreName: string,
    declaredComponents: string[],
    spec: CompositeSpec | null,
    status: ScoreExportEntry["status"],
  ): ScoreExportEntry => ({
    scoreName,
    declaredComponents: [...declaredComponents],
    status,
    verdict: spec?.feasibility?.verdict ?? "indeterminate",
    spec,
  });
  const out: ScoreExportEntry[] = [];
  const named = new Set<string>();
  for (const s of scores) {
    const spec = specForScore(composites, s.scoreName);
    named.add(s.scoreName.trim().toLowerCase());
    out.push(entry(s.scoreName, s.components, spec, spec ? "matched" : "declared"));
  }
  for (const c of composites ?? []) {
    const name = c.definition?.name ?? "";
    if (named.has(name.trim().toLowerCase())) continue;
    named.add(name.trim().toLowerCase());
    out.push(entry(name, [], specForScore(composites, name), "derived"));
  }
  return { note: SCORE_EXPORT_NOTE, scores: out };
}
