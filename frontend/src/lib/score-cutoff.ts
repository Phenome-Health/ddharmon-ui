/**
 * Gate 1's score SUGGESTION CUT-OFF as the reviewer's decision (`gate1_score_cutoff`, review round 6 — Bhargav: the
 * "0.62" "should be user-selectable with default 0.62").
 *
 * The free search scores each group by the cosine of its best member to a concept; a group at or above the cut-off
 * is SUGGESTED — tagged in the queue and seeded into Gate 1's scope. The default is the payload's own threshold (core's
 * calibrated value, never a copy kept here); the reviewer's choice, when there is one, replaces it everywhere Gate 1
 * applies it. Reset deletes the row. Pure, so a Playwright spec can import it (`frontend/` has no component runner).
 * Mirrors `backend/artifact_kinds.py` (`SCORE_CUTOFF_SETTING`, `SCORE_CUTOFF_LIST_SEPARATOR`, `SCORE_CUTOFF_MIN`/`_MAX`).
 *
 * ONE PER SPOTLIGHT LIST (2026-11-08: "implement per list cutoff"). Each declared list has its own row, keyed
 * `suggestion_cutoff::<list name>` (`listCutoffSetting`), and each concept is split at its own list's cut-off. The
 * list rides IN the kind's one identity field, so the identity table and every stored row keep their keys. The bare
 * `suggestion_cutoff` row is the RUN-WIDE cut-off a run held before lists had their own: it is still read, as where
 * every list without a row of its own starts — and what a list's reset falls back to, before core's default.
 */
import type { GateDecision } from "@/lib/gate-decisions";

export const SCORE_CUTOFF_KIND = "gate1_score_cutoff" as const;
/** The run-wide setting — the one cut-off a run had before each list got its own. Read, never written now. */
export const SCORE_CUTOFF_SETTING = "suggestion_cutoff";
/** What joins the setting to a list's name in that list's own setting. */
export const SCORE_CUTOFF_LIST_SEPARATOR = "::";
export const SCORE_CUTOFF_MIN = 0.3;
export const SCORE_CUTOFF_MAX = 0.95;

/** A typed cut-off as a number rounded to two decimals, or `null` when it is not a number in range. */
export function parseCutoff(text: string): number | null {
  const t = text.trim();
  if (!/^\d*\.?\d+$/.test(t)) return null;
  const v = Math.round(Number(t) * 100) / 100;
  return Number.isFinite(v) && v >= SCORE_CUTOFF_MIN && v <= SCORE_CUTOFF_MAX ? v : null;
}

/** The cut-off a row holds, if it reads as a number in range, else the fallback. */
export function effectiveCutoff(decision: GateDecision | undefined, fallback: number): number {
  const chosen = typeof decision?.chosen === "string" ? parseCutoff(decision.chosen) : null;
  return chosen ?? fallback;
}

/** The setting a Spotlight list's own cut-off is keyed on: `suggestion_cutoff::<list name>` (the name trimmed). */
export function listCutoffSetting(listName: string): string {
  return `${SCORE_CUTOFF_SETTING}${SCORE_CUTOFF_LIST_SEPARATOR}${listName.trim()}`;
}

/** The list a cut-off setting belongs to — `null` for the run-wide row, `undefined` for a setting that is neither. */
export function cutoffSettingList(setting: string): string | null | undefined {
  if (setting === SCORE_CUTOFF_SETTING) return null;
  const prefix = SCORE_CUTOFF_SETTING + SCORE_CUTOFF_LIST_SEPARATOR;
  const name = setting.startsWith(prefix) ? setting.slice(prefix.length) : "";
  return name && name === name.trim() ? name : undefined;
}

/** One list's cut-off, and where reset would take it. */
export interface ListCutoff {
  /** The cut-off this list's concepts are split at. */
  value: number;
  /** The list has a row of its own (in range) — the only thing a reset can delete. */
  own: boolean;
  /** What the list reads without its own row: the run-wide row if the run holds one, else core's default. */
  fallback: number;
}

/**
 * A list's cut-off: its own row, else the run-wide row, else the payload's threshold (core's default). A row that does
 * not read as a number in range is no cut-off at all, so the list falls through it.
 */
export function listCutoff(
  decisions: Record<string, GateDecision>,
  listName: string,
  payloadThreshold: number,
): ListCutoff {
  const fallback = effectiveCutoff(decisions[SCORE_CUTOFF_SETTING], payloadThreshold);
  const row = decisions[listCutoffSetting(listName)];
  const own = typeof row?.chosen === "string" ? parseCutoff(row.chosen) : null;
  return { value: own ?? fallback, own: own !== null, fallback };
}
