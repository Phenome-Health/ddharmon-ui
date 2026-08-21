import { COLUMN_ROLES, ROLE_REQUIREMENT } from "@/types";
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

/** Options the select offers: the mappable vocabulary, plus any role THIS file already uses. */
function roleOptions(roles: Record<string, string>): string[] {
  const extra = Object.keys(roles).filter((r) => !(COLUMN_ROLES as readonly string[]).includes(r));
  return [...COLUMN_ROLES, ...extra];
}

/** The requirement hint shown beside a role, or "" — read from the pipeline's real contract, not a star. */
function hintFor(role: string): string {
  const tier = ROLE_REQUIREMENT[role as (typeof COLUMN_ROLES)[number]];
  if (tier === "meaning") return " · meaning";
  if (tier === "conditional") return " · for specs";
  if (tier === "recommended") return " · recommended";
  return "";
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
  const options = roleOptions(roles);
  const check: NameCheck | null = rows ? nameCheck(rows, roles.variable_name) : null;
  /** First non-empty value for a column — what this column looks like, from the file itself. */
  const sample = (column: string): string =>
    (rows ?? []).map((r) => (r[column] ?? "").trim()).find(Boolean) ?? "";

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
                Reads as
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
                      {options.map((role) => (
                        <option key={role} value={role}>
                          {role}
                          {hintFor(role)}
                        </option>
                      ))}
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
