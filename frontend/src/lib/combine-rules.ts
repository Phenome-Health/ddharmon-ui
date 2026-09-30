// Several variables of ONE cohort landing on ONE target column (08-28 item 1d, F1; decision Q4).
//
// The notebook used to write each same-cohort variable over the one before it. A (cohort, target) pair with
// two or more variables is a COMBINE GROUP, and the reviewer chooses how it becomes one column — recorded as a
// `gate3_combine_rule` decision keyed on that pair:
//
//   coalesce  — first non-blank value in member order, plus a `TARGET__source` provenance column and a runtime
//               overlap count. The DEFAULT: what an undecided group gets, and the screen says so.
//   separate  — one `TARGET__<var>` column per variable.
//   <member>  — that variable alone writes the column.
//
// Mirrors `backend/combine_rules.py` (grouping + `resolve_rule`), which is what every export carries and the
// notebook runs. Pure, so it is asserted in node from `tests/e2e/combine-rules.spec.ts`.

import type { UIRecord } from "@/types";

export const COMBINE_COALESCE = "coalesce";
export const COMBINE_SEPARATE = "separate";

export interface CombineGroup {
  cohort: string;
  targetId: string;
  /** The "cohort:var" members that write this column, in record/member order. */
  members: string[];
}

export interface CombineChoice {
  rule: "coalesce" | "separate" | "source";
  /** The one writer, when `rule` is `source`. */
  source: string;
  decidedBy: "reviewer" | "default";
  /** Why a reviewer's choice could not apply (a source that no longer writes the column). */
  note?: string;
}

/** The column one member writes, or "" when it writes none (a novel with no target). */
function targetOf(record: Pick<UIRecord, "cde" | "transforms">, member: string): string {
  const t = (record.transforms ?? []).find((x) => x.sourceVariable === member);
  return t?.targetCdeId || record.cde?.id || "";
}

/**
 * Every (cohort, target) column that two or more variables write, across the records given, in first-seen
 * order. A REJECTED recode writes nothing (the notebook leaves it out), so it is not one of the writers.
 */
export function combineGroups(
  records: Pick<UIRecord, "members" | "cde" | "transforms">[],
  rejected: ReadonlySet<string> = new Set(),
): CombineGroup[] {
  const byPair = new Map<string, CombineGroup>();
  for (const r of records) {
    for (const member of r.members ?? []) {
      if (rejected.has(member)) continue;
      const targetId = targetOf(r, member);
      if (!targetId) continue;
      const cohort = member.split(":")[0];
      const key = `${cohort}\u001f${targetId}`;
      const g = byPair.get(key) ?? { cohort, targetId, members: [] };
      if (!g.members.includes(member)) g.members.push(member);
      byPair.set(key, g);
    }
  }
  return [...byPair.values()].filter((g) => g.members.length >= 2);
}

/** The option space a combine-rule decision records: the two rule names, then the variables combined. */
export function combineAlternatives(members: string[]): string[] {
  return [COMBINE_COALESCE, COMBINE_SEPARATE, ...members];
}

/** The rule a group runs under — the reviewer's, else the stated default. Mirrors `resolve_rule`. */
export function combineChoice(decision: { chosen?: unknown } | undefined, members: string[]): CombineChoice {
  const chosen = typeof decision?.chosen === "string" ? decision.chosen : "";
  if (chosen === COMBINE_SEPARATE) return { rule: "separate", source: "", decidedBy: "reviewer" };
  if (chosen === COMBINE_COALESCE) return { rule: "coalesce", source: "", decidedBy: "reviewer" };
  if (chosen && members.includes(chosen)) return { rule: "source", source: chosen, decidedBy: "reviewer" };
  const out: CombineChoice = { rule: "coalesce", source: "", decidedBy: "default" };
  if (chosen) out.note = `the chosen source ${chosen} no longer writes this column, so the default applies`;
  return out;
}
