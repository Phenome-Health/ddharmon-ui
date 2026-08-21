/**
 * RED-PHASE SCAFFOLD (08-13 Task 1). Signatures only — every body throws.
 *
 * This exists for exactly one commit, so `tests/e2e/setup.spec.ts` can be RUN and seen to fail on its
 * assertions rather than on a missing module. The next commit replaces every body. If you are reading this
 * in a later commit, the GREEN step did not land and that is a defect.
 */

export type DictRow = Record<string, string>;

export interface NameCheck {
  checkable: boolean;
  rowCount: number;
  uniqueNameCount: number | null;
  unnamed: number;
  dropped: number;
  fired: boolean;
  repeated: string[];
}

export const PARTICIPANT_ID_HEADERS: ReadonlySet<string> = new Set();

export function normalizeHeader(_name: string): string {
  throw new Error("not implemented");
}

export function nameCheck(_rows: DictRow[], _variableNameColumn: string | undefined): NameCheck {
  throw new Error("not implemented");
}

export function participantLevelColumn(_headers: string[], _rows: DictRow[], _sample = 40): string | null {
  throw new Error("not implemented");
}

export function assignRole(
  _roles: Record<string, string>,
  _column: string,
  _role: string,
): Record<string, string> {
  throw new Error("not implemented");
}
