// Removing a rogue variable from one concept at Gate 3 (review round 2, Gate 3 note 2).
//
// A reviewer decision of its own registered kind, `gate3_member_exclusion`, keyed on the (group, variable) pair
// it removes. A row MEANS "this variable is out of this concept": `chosen` is always "exclude", and Undo deletes
// the row (never a "keep" written over it — every reader treats a row as a removal). The export applies it in
// `backend/export_decisions.py::effective_records` — gone from the concept's members, member details and transform
// specs in every format, and logged — and Gate 3 shows the concept as the export will carry it. Nothing re-runs.
//
// Pure, so it is asserted in node from `tests/e2e/member-exclusion.spec.ts`.

import type { UIRecord } from "@/types";

export const MEMBER_KEEP = "keep";
export const MEMBER_EXCLUDE = "exclude";
/** The option space a removal records (mirrors `backend/artifact_kinds.py`); only "exclude" is ever stored. */
export const MEMBER_EXCLUSION_ALTERNATIVES: readonly string[] = [MEMBER_KEEP, MEMBER_EXCLUDE];

/** The decisions this module reads — the hook's `decisions` for the kind, itemKey → payload. */
type Removals = Record<string, { groupId?: unknown; memberId?: unknown; chosen?: unknown }> | undefined;

/** The variables removed from ONE concept. A row on another concept, or one that is not a removal, removes nothing. */
export function removedMembersOf(decisions: Removals, groupId: string): Set<string> {
  const out = new Set<string>();
  for (const d of Object.values(decisions ?? {})) {
    if (d.groupId === groupId && d.chosen === MEMBER_EXCLUDE && typeof d.memberId === "string") out.add(d.memberId);
  }
  return out;
}

/**
 * Whether `member` may be removed: it is still in the concept and is not the LAST one left. A concept with no
 * variables is not a concept — to drop one from the output whole, its recode is rejected instead.
 */
export function canRemoveMember(members: readonly string[], removed: ReadonlySet<string>, member: string): boolean {
  if (removed.has(member) || !members.includes(member)) return false;
  return members.filter((m) => !removed.has(m)).length > 1;
}

/** The write one removal makes: the identity fields and the option-space payload the store validates. */
export function removalWrite(
  groupId: string,
  memberId: string,
): { fields: { groupId: string; memberId: string }; options: { chosen: string; alternatives: string[] } } {
  return {
    fields: { groupId, memberId },
    options: { chosen: MEMBER_EXCLUDE, alternatives: [...MEMBER_EXCLUSION_ALTERNATIVES] },
  };
}

/**
 * The records as the export carries them — each concept without the variables removed from it (members and the
 * specs they write). An untouched concept is returned as is; nothing is mutated. Used where Gate 3 groups by what
 * the notebook WRITES (the combine control), so a removed variable is nobody's combine partner.
 */
export function withoutRemovedMembers<R extends Pick<UIRecord, "groupId" | "members" | "transforms">>(
  records: readonly R[],
  decisions: Removals,
): R[] {
  return records.map((r) => {
    const removed = removedMembersOf(decisions, r.groupId);
    if (removed.size === 0) return r;
    return {
      ...r,
      members: (r.members ?? []).filter((m) => !removed.has(m)),
      transforms: (r.transforms ?? []).filter((t) => !removed.has(t.sourceVariable)),
    };
  });
}

/** The cohorts a concept still draws on once its removed variables are gone, in the record's own order. */
export function cohortsLeft(record: Pick<UIRecord, "cohorts" | "members">, removed: ReadonlySet<string>): string[] {
  if (removed.size === 0) return record.cohorts ?? [];
  const left = new Set((record.members ?? []).filter((m) => !removed.has(m)).map((m) => m.split(":")[0]));
  return (record.cohorts ?? []).filter((c) => left.has(c));
}
