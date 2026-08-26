import { useState } from "react";
import {
  ADVANCED_ROLES,
  COLUMN_ROLES,
  ROLE_HELP,
  SEMANTIC_ROLES,
  VALUE_ROLES,
  type ColumnRole,
} from "@/types";
import { InfoTip } from "@/components/ui/info-tip";
import { assignRole, nameCheck, roleOf, type DictRow, type NameCheck } from "@/lib/dictionary";

/**
 * One dictionary's column mapping — one row per SOURCE COLUMN, choosing what that column is (08-13).
 *
 * COLUMN-MAJOR, unlike the shipped New Run form, which is role-major (one control per role, choosing a
 * column). Two reasons, and the second is the one that matters:
 *
 *  1. It answers the question the reviewer actually has in front of a strange dictionary — "what is this
 *     column?" — rather than making them hold nine roles in their head and hunt for each one's column.
 *  2. It is bounded by the file. A role-major form renders a fixed nine controls whether the file has two
 *     columns or forty; a column-major table renders exactly what is there, so the file's real shape is
 *     visible instead of implied. The cost is that the table grows with the file, which is why it owns its
 *     own scroll (see below) rather than growing the page.
 *
 * A ROLE IS SINGLE-VALUED PER FILE. Assigning one takes it off whichever column held it (`assignRole`), so
 * "two columns are both the description" is not a state a click can reach.
 *
 * THE TABLE NEVER REFLOWS THE PAGE. `table-fixed` plus a truncating cell means a 90-character column name
 * is clamped inside its cell with the full value on `title`; the scroller caps the height and owns the
 * overflow in BOTH axes. A ~12k-variable dictionary with forty columns therefore scrolls within its card
 * and the page does not scroll sideways at the 1440px design canvas.
 */

/**
 * The select's options, GROUPED the way the shipped New Run form groups its controls: the QUESTION
 * (semantic) side — what the variable asks — against the RESPONSE (value) side — the values and how they
 * are coded — with organizational/external ids last.
 *
 * The split lives on the OPTIONS, not on the rows. Rows are source columns, and a column's group is only
 * decided by the role you give it, so grouping rows would mean re-sorting the table on every change — and
 * this table is contractually forbidden from reflowing. Grouping the options puts the same distinction at
 * the point where the decision is actually made, and the table stays stable under the cursor.
 *
 * Any role already present on this file but outside the known vocabulary is kept, under "other", so a
 * run-seeded dictionary never silently loses a mapping this build does not recognise.
 */
const PRIMARY_ROLE_GROUPS: { label: string; roles: readonly string[] }[] = [
  { label: "Question — what the variable asks", roles: SEMANTIC_ROLES },
  { label: "Response — the values & how they're coded", roles: VALUE_ROLES },
];

/**
 * The advanced group, COLLAPSED BEHIND A DISCLOSURE (08-13b Task 3, lifted from `home.tsx:340-346`).
 *
 * Organizational and external-id roles are a minority need — most dictionaries never map one — and every
 * option in a native select is a line the reviewer reads past on their way to `description`. The shipped
 * New Run form has hidden them behind a counted "Show advanced columns (3)" trigger all along; Setup was
 * showing all three groups at once.
 *
 * THE TRIGGER NAMES THE COUNT rather than saying "advanced": a disclosure that does not say how much it
 * is holding is a disclosure you have to open to find out whether it was worth opening.
 *
 * IT OPENS ITSELF WHEN IT IS ALREADY IN USE. A run-seeded or prefilled dictionary can arrive with
 * `category` already mapped; hiding the group then would leave a select holding a value with no matching
 * option, which renders blank — a silently dropped mapping, which is the one outcome this table exists
 * to prevent.
 */
const ADVANCED_GROUP = { label: "Advanced — organizational & external ids", roles: ADVANCED_ROLES };

function extraRoles(roles: Record<string, string>): string[] {
  return Object.keys(roles).filter(
    (r) => r && roles[r] && !(COLUMN_ROLES as readonly string[]).includes(r),
  );
}

export interface DictionaryMappingTableProps {
  headers: string[];
  /** role -> source column, the shape the run config wants. */
  roles: Record<string, string>;
  onRolesChange: (roles: Record<string, string>) => void;
  /** Parsed rows, when the file was read in this browser. Absent for a run-seeded dictionary. */
  rows?: DictRow[] | null;
  /** True when this dictionary belongs to a run that has already started — read-back, not an editor. */
  disabled?: boolean;
}

export function DictionaryMappingTable({
  headers,
  roles,
  onRolesChange,
  rows,
  disabled = false,
}: DictionaryMappingTableProps) {
  const extras = extraRoles(roles);
  /** True when one of the advanced roles is already pointed at a column on this dictionary. */
  // EVERY role is offered, always (review 2026-08-26). The advanced group used to sit behind a
  // "Show advanced column roles (3)" disclosure; the reviewer's verdict was to show them in the
  // dropdown by default. A <select> is already a closed list opened deliberately, so hiding three of
  // its options behind a second disclosure made the reviewer open two things to answer one question —
  // and `category`, `field_id` and `standard_code` are ordinary mapping targets, not dangerous ones.
  // It also removes a real hazard the old disclosure had to special-case: a withheld optgroup left a
  // select holding a value with no matching option, which renders BLANK — a silently dropped mapping.
  const roleGroups = [...PRIMARY_ROLE_GROUPS, ADVANCED_GROUP];
  const check: NameCheck | null = rows ? nameCheck(rows, roles.variable_name) : null;
  /** First non-empty value for a column — what this column looks like, from the file itself. */
  const sample = (column: string): string =>
    (rows ?? []).map((r) => (r[column] ?? "").trim()).find(Boolean) ?? "";
  /** The pipeline's real floor: at least one of the semantic roles must point at a column. */
  const meaningMapped = SEMANTIC_ROLES.some((r) => Boolean(roles[r]));

  return (
    <div className="flex flex-col gap-3">
      {/* The row-count against the unique-name-count check. ALWAYS rendered when it can be run — a check
          that only appears when it fires is indistinguishable from a check that was never run. */}
      {check === null ? (
        <p
          data-testid="name-check-unavailable"
          className="rounded-inner border border-dashed border-rule-on-raised px-3 py-2 text-xs text-on-raised-muted"
        >
          <span className="font-semibold text-on-raised">
            Row count against unique-name count — not available for this dictionary.
          </span>{" "}
          The source file is not kept with the run, so the names cannot be counted here. It is not a report
          that every name was unique. Re-upload the file to run the check.
        </p>
      ) : (
        <p
          data-testid="name-check"
          data-fired={String(check.fired)}
          data-rows={String(check.rowCount)}
          data-unique={check.uniqueNameCount === null ? "" : String(check.uniqueNameCount)}
          className={
            check.fired
              ? "rounded-inner border border-rule-warn bg-surface-warn px-3 py-2 text-xs text-on-warn"
              : "rounded-inner border border-rule-on-raised px-3 py-2 text-xs text-on-raised-muted"
          }
        >
          {check.checkable ? (
            <>
              <span className="font-semibold">
                {check.rowCount.toLocaleString()} rows · {(check.uniqueNameCount ?? 0).toLocaleString()}{" "}
                unique variable names
              </span>
              {check.fired ? (
                <>
                  {" "}
                  — {check.dropped.toLocaleString()}{" "}
                  {check.dropped === 1 ? "variable would be" : "variables would be"} dropped{" "}
                  <span className="font-semibold">silently</span>: the loader keys on the variable name and
                  the last row with a repeated name wins, so the earlier ones disappear with no warning.
                  Repeated: {check.repeated.slice(0, 6).join(", ")}
                  {check.repeated.length > 6 ? ` and ${check.repeated.length - 6} more` : ""}. Map a column
                  that is unique per row, or fix the file.
                </>
              ) : (
                <> — every row has its own name, so nothing is dropped silently.</>
              )}
              {check.unnamed > 0 && (
                <>
                  {" "}
                  {check.unnamed.toLocaleString()} {check.unnamed === 1 ? "row has" : "rows have"} no name at
                  all; the loader generates one, so they are kept but carry no identifier of yours.
                </>
              )}
            </>
          ) : (
            <>
              <span className="font-semibold">
                {check.rowCount.toLocaleString()} rows · unique variable names not counted
              </span>{" "}
              — no column is mapped to the variable name yet, so there is nothing to count against. Map one
              below to run the check.
            </>
          )}
        </p>
      )}

      {/* The mapping requirement, FLAGGED ONLY WHEN UNMET (08-13 review). An always-on coverage readout
          was tried and removed: with the roles grouped in the dropdown and each one carrying its own help,
          a permanent "2 of 3 / 3 of 3" line restated what the selects already show and competed with the
          name-check for the same attention. A requirement the user is meeting needs no banner; one they
          are not does. */}
      {!meaningMapped && (
        <p
          data-testid="meaning-requirement"
          className="rounded-inner border border-rule-warn bg-surface-warn px-3 py-2 text-xs text-on-warn"
        >
          <span className="font-semibold">No meaning-bearing column is mapped.</span> Point one column at
          description or question_text — without one the pipeline has nothing to match against, so this
          dictionary cannot reach a common data element. variable_name alone will not do it: it is an
          identifier, not a meaning.
        </p>
      )}

      <div
        data-testid="mapping-scroll"
        className="max-h-[19rem] overflow-auto rounded-inner border border-rule-on-raised"
      >
        <table className="w-full table-fixed border-collapse">
          <thead>
            <tr className="border-b border-rule-on-raised">
              <th className="w-[38%] px-3 py-2 text-left text-xs font-semibold uppercase tracking-eyebrow text-on-raised-muted">
                Source column
              </th>
              <th className="w-[30%] px-3 py-2 text-left text-xs font-semibold uppercase tracking-eyebrow text-on-raised-muted">
                First value
              </th>
              <th className="w-[32%] px-3 py-2 text-left text-xs font-semibold uppercase tracking-eyebrow text-on-raised-muted">
                <span className="inline-flex items-center gap-1">
                  Reads as
                  {/* The per-role explanations live on the <option> `title`s, which nothing advertises —
                      a native select gives no hint that its options carry help. This says where to look. */}
                  <InfoTip
                    text="What this column becomes for the pipeline. Open a dropdown and hover any option to see what that role means and when to use it — every role explains itself. Roles are grouped by whether they describe the QUESTION the variable asks or the RESPONSE values it records."
                    label="About the Reads as column"
                  />
                </span>
              </th>
            </tr>
          </thead>
          <tbody>
            {headers.map((header) => {
              const current = roleOf(roles, header);
              const example = sample(header);
              return (
                <tr
                  key={header}
                  data-testid="mapping-row"
                  className="border-b border-rule-quiet-on-raised last:border-b-0"
                >
                  <td className="px-3 py-1.5 align-middle">
                    {/* Clamped, with the full value on `title`: a long source column name is clipped inside
                        its cell rather than widening the table. */}
                    <span
                      data-column={header}
                      title={header}
                      className="block truncate font-mono text-xs text-on-raised"
                    >
                      {header}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 align-middle">
                    <span
                      title={example}
                      className="block truncate font-mono text-xs text-on-raised-muted"
                    >
                      {example || "—"}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 align-middle">
                    {/* A NATIVE select, not the Radix one used on /new. At forty rows the popper-based
                        control is forty portals for one dense table, and the native control is also the
                        only form chrome on this screen whose rendering follows `color-scheme` — which is
                        what makes a wrong scheme visible in this screen's baseline. */}
                    <select
                      data-testid="role-select"
                      aria-label={`What ${header} reads as`}
                      value={current}
                      disabled={disabled}
                      onChange={(e) => onRolesChange(assignRole(roles, header, e.target.value))}
                      className="h-7 w-full rounded border border-rule-control-on-raised bg-surface-raised px-2 text-xs text-on-raised disabled:cursor-not-allowed disabled:bg-surface-inset disabled:text-on-raised-muted"
                    >
                      <option value="">— not used —</option>
                      {roleGroups.map((group) => (
                        <optgroup key={group.label} label={group.label}>
                          {group.roles.map((role) => (
                            // `title` carries ROLE_HELP: an <option> cannot host a React tooltip, and the
                            // native hint is the only explanation available at the moment of choosing. The
                            // same copy is on the ⓘ in the strip above, from the same register.
                            <option key={role} value={role} title={ROLE_HELP[role as ColumnRole]}>
                              {role}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                      {extras.length > 0 && (
                        <optgroup label="Other — already on this dictionary">
                          {extras.map((role) => (
                            <option key={role} value={role}>
                              {role}
                            </option>
                          ))}
                        </optgroup>
                      )}
                    </select>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
