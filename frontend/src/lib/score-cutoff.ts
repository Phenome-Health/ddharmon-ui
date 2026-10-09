/**
 * Gate 1's score SUGGESTION CUT-OFF as the reviewer's decision (`gate1_score_cutoff`, review round 6 — Bhargav: the
 * "0.62" "should be user-selectable with default 0.62").
 *
 * The free search scores each group by the cosine of its best member to a component; a group at or above the cut-off
 * is SUGGESTED — tagged in the queue and seeded into Gate 1's scope. The default is the payload's own threshold (core's
 * calibrated value, never a copy kept here); the reviewer's choice, when there is one, replaces it everywhere Gate 1
 * applies it. Reset deletes the row. Pure, so a Playwright spec can import it (`frontend/` has no component runner).
 * Mirrors `backend/artifact_kinds.py` (`SCORE_CUTOFF_SETTING`, `SCORE_CUTOFF_MIN`/`_MAX`).
 */
import type { GateDecision } from "@/lib/gate-decisions";

export const SCORE_CUTOFF_KIND = "gate1_score_cutoff" as const;
/** The one item key a cut-off row has — the setting itself. */
export const SCORE_CUTOFF_SETTING = "suggestion_cutoff";
export const SCORE_CUTOFF_MIN = 0.3;
export const SCORE_CUTOFF_MAX = 0.95;

/** A typed cut-off as a number rounded to two decimals, or `null` when it is not a number in range. */
export function parseCutoff(text: string): number | null {
  const t = text.trim();
  if (!/^\d*\.?\d+$/.test(t)) return null;
  const v = Math.round(Number(t) * 100) / 100;
  return Number.isFinite(v) && v >= SCORE_CUTOFF_MIN && v <= SCORE_CUTOFF_MAX ? v : null;
}

/** The cut-off Gate 1 applies: the reviewer's stored one if it reads as a number in range, else the payload's own. */
export function effectiveCutoff(decision: GateDecision | undefined, payloadThreshold: number): number {
  const chosen = typeof decision?.chosen === "string" ? parseCutoff(decision.chosen) : null;
  return chosen ?? payloadThreshold;
}
