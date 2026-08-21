/**
 * The decisions Setup makes about a FILE, as plain functions (08-13 Task 1).
 *
 * Extracted from the screen for the same reason the estimator was: these are the two claims Setup makes
 * that are worth checking without a browser — "this file would silently lose variables" and "this file is
 * not a data dictionary at all". Both are the kind of rule that gets weakened by accident, and a rule that
 * can only be exercised by driving a page is a rule that stops being exercised.
 *
 * Nothing here touches React, and nothing here uploads: every function is a pure read of already-parsed
 * rows. That is what makes the participant-level refusal a REFUSAL rather than a server round trip.
 */

/** One parsed dictionary row: source column name -> cell value, as Papa hands it back. */
export type DictRow = Record<string, string>;

// --- the duplicate-variable-name hazard ---------------------------------------------------------------

export interface NameCheck {
  /** False when no column is mapped to the variable name — then the unique count is UNKNOWN, not equal. */
  checkable: boolean;
  rowCount: number;
  /** Distinct non-empty names, or null when the check cannot be run at all. */
  uniqueNameCount: number | null;
  /** Rows whose name cell is empty. Counted separately: they are unkeyable, not "one repeated name". */
  unnamed: number;
  /** How many rows a repeated name would cost, i.e. rows − distinct names − unnamed. */
  dropped: number;
  fired: boolean;
  /** The names that repeat, so the message can point at them rather than at a number. */
  repeated: string[];
}

/**
 * Rows against distinct variable names — the project's longest-standing silent data loss.
 *
 * `load_dictionary` keys on the variable-name column and LAST-WINS on a repeat, so a dictionary with a
 * duplicated name loses rows with no warning anywhere: the run completes, the counts look plausible, and
 * the missing variables are only discovered by someone counting by hand. That has cost real debugging time
 * (see CLAUDE.md §Cohorts), which is why this is surfaced BEFORE the run rather than reported after it.
 *
 * THREE OUTCOMES, kept distinct on purpose:
 *  - not checkable — no variable-name column is mapped, so the unique count is `null`. Reporting it as
 *    equal to the row count would be inventing the very number we do not have.
 *  - clean — both figures render anyway. A check that only appears when it fires is indistinguishable
 *    from a check that was never run.
 *  - fired — the names that repeat are named, because "some name repeats" is not actionable.
 *
 * An EMPTY name is not a repeat. Two blank cells are two rows the loader cannot key at all; folding them
 * into a single repeated `""` would report one lost row where there are two.
 */
export function nameCheck(rows: DictRow[], variableNameColumn: string | undefined): NameCheck {
  const rowCount = rows.length;
  if (!variableNameColumn) {
    return {
      checkable: false,
      rowCount,
      uniqueNameCount: null,
      unnamed: 0,
      dropped: 0,
      fired: false,
      repeated: [],
    };
  }
  const seen = new Map<string, number>();
  let unnamed = 0;
  for (const row of rows) {
    const name = (row[variableNameColumn] ?? "").trim();
    if (!name) {
      unnamed += 1;
      continue;
    }
    seen.set(name, (seen.get(name) ?? 0) + 1);
  }
  const repeated = [...seen.entries()].filter(([, n]) => n > 1).map(([name]) => name);
  const uniqueNameCount = seen.size;
  const dropped = rowCount - uniqueNameCount - unnamed;
  return {
    checkable: true,
    rowCount,
    uniqueNameCount,
    unnamed,
    dropped: Math.max(0, dropped),
    fired: repeated.length > 0,
    repeated,
  };
}

// --- the participant-level refusal --------------------------------------------------------------------

/**
 * Headers that name a participant identifier.
 *
 * MIRRORS `backend/app.py::_PARTICIPANT_ID_HEADERS`, deliberately and exactly — the client refusal exists
 * so the user does not wait on a round trip to be told their file is the wrong kind, not to enforce a
 * DIFFERENT rule than the server. `tests/test_content_drift.py::test_participant_id_headers_agree` fails
 * if the two lists diverge, because a client list that has quietly grown weaker than the server's is worse
 * than no client check: it looks like coverage.
 *
 * Bare `id` is ABSENT on purpose. It is the one name a dictionary plausibly uses for its own key, so
 * including it would refuse real dictionaries.
 */
export const PARTICIPANT_ID_HEADERS: ReadonlySet<string> = new Set([
  "eid",
  "usubjid",
  "subjid",
  "person_id",
  "patient_id",
  "sample_id",
  "subject_id",
  "record_id",
  "participant_id",
  "respondent_id",
]);

/** Fold a header for lookup: non-alphanumerics to `_`, lowercased, trimmed of edge separators. */
export function normalizeHeader(name: string): string {
  return String(name ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * The column that makes this file look like participant records, or null.
 *
 * TWO conditions must BOTH hold, and the reason is that either one alone has a real false positive:
 *
 *  1. a header naming a participant identifier, and
 *  2. that column's values unique across the sampled rows.
 *
 * Condition 1 alone refuses a dictionary that DESCRIBES a participant id — a row whose variable name is
 * `participant_id`, which is most real dictionaries. Condition 2 alone refuses every dictionary, since a
 * variable-name column is unique by construction.
 *
 * The user's own column mapping is deliberately NOT an exemption. Someone uploading participant rows by
 * mistake maps the identifier column as the variable name, because that is what the naive mapping does —
 * so exempting declared columns would open the hole exactly where the mistake lives.
 *
 * Fewer than two rows proves nothing about uniqueness, so nothing is refused.
 */
export function participantLevelColumn(headers: string[], rows: DictRow[], sample = 40): string | null {
  const suspects = headers.filter((h) => PARTICIPANT_ID_HEADERS.has(normalizeHeader(h)));
  if (!suspects.length) return null;
  const window = rows.slice(0, sample);
  if (window.length < 2) return null;
  for (const column of suspects) {
    const values = window.map((r) => (r[column] ?? "").trim());
    if (values.some((v) => !v)) continue; // a blank is not a per-row-unique identifier
    if (new Set(values).size === values.length) return column;
  }
  return null;
}

// --- the column -> role mapping -----------------------------------------------------------------------

/**
 * Assign `role` to `column` in a column-major mapping, keeping every role SINGLE-VALUED per file.
 *
 * The mapping is stored role -> column (which is what the run config wants), but Setup edits it
 * column-major: one table row per source column, choosing what that column IS. So assigning a role has to
 * take it off whichever column held it — two columns cannot both be `description`, and a mapping that
 * cannot be expressed should not be reachable by clicking.
 *
 * An empty role CLEARS the column: the entry is removed rather than set to a sentinel, so the config that
 * goes to the server has no placeholder values in it.
 */
export function assignRole(
  roles: Record<string, string>,
  column: string,
  role: string,
): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [existingRole, existingColumn] of Object.entries(roles)) {
    if (existingColumn === column) continue; // this column is being re-described
    if (existingRole === role) continue; // the role is moving to `column`
    next[existingRole] = existingColumn;
  }
  if (role) next[role] = column;
  return next;
}

/** The role a given source column currently plays, or "" when it plays none. */
export function roleOf(roles: Record<string, string>, column: string): string {
  return Object.entries(roles).find(([, c]) => c === column)?.[0] ?? "";
}
