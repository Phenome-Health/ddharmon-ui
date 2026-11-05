import { COMBINE_COALESCE, COMBINE_SEPARATE, type CombineChoice, type CombineGroup } from "@/lib/combine-rules";

/**
 * How several of ONE cohort's variables become ONE target column (08-28 1d, decision Q4).
 *
 * Rendered only for a (cohort, target) pair that two or more variables write — elsewhere there is nothing to
 * decide, and a control with nothing to decide teaches the reviewer to skip it. The default is stated, not
 * implied: until the reviewer chooses, the export coalesces (first non-blank in member order, with a
 * `TARGET__source` column and an overlap warning) and says `decidedBy: "default"`.
 *
 * A NATIVE select, like the dictionary mapping table: a closed list opened deliberately, whose options can
 * carry the one-line explanation of each rule.
 */
export function CombineRuleControl({
  group,
  choice,
  targetLabel,
  readOnly,
  onChoose,
}: {
  group: CombineGroup;
  choice: CombineChoice;
  /** The column's display name (the target's name), when it differs from its id. */
  targetLabel?: string;
  readOnly?: boolean;
  onChoose: (chosen: string) => void;
}) {
  const value = choice.rule === "source" ? choice.source : choice.rule;
  const varName = (member: string) => member.slice(member.indexOf(":") + 1);
  const column = targetLabel || group.targetId;
  return (
    <div
      data-testid="combine-rule"
      data-cohort={group.cohort}
      data-target={group.targetId}
      data-rule={choice.rule}
      data-decided-by={choice.decidedBy}
      className="flex flex-col gap-2 rounded-inner border border-rule-on-raised px-4 py-3"
    >
      {/* Review round 2: "land on one column" read as jargon. The plain version says what happened (several of
          one cohort's variables map to the same target), then why it needs a choice (the harmonized data has ONE
          column for that target per cohort, so their values must become one). */}
      <p className="max-w-[80ch] text-xs text-on-raised">
        <span className="font-semibold">
          {group.members.length} {group.cohort} variables map to the same target,
        </span>{" "}
        <span className="font-mono">{column}</span>:{" "}
        {group.members.map((m, i) => (
          <span key={m}>
            {i > 0 ? ", " : ""}
            <span className="font-mono">{varName(m)}</span>
          </span>
        ))}
        . The harmonized data has one <span className="font-mono">{column}</span> column for {group.cohort}, so
        choose how their values are combined into it.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <select
          data-testid="combine-rule-select"
          aria-label={`How ${group.cohort}'s variables combine into ${column}`}
          value={value}
          disabled={readOnly}
          onChange={(e) => onChoose(e.target.value)}
          className="h-8 max-w-full rounded border border-rule-control-on-raised bg-surface-raised px-2 text-xs text-on-raised disabled:cursor-not-allowed disabled:bg-surface-inset disabled:text-on-raised-muted"
        >
          <option value={COMBINE_COALESCE}>
            Coalesce — first non-blank value in the order listed, plus a {column}__source column
          </option>
          <option value={COMBINE_SEPARATE}>Keep separate — one {column}__&lt;variable&gt; column each</option>
          <optgroup label="Use one source only">
            {group.members.map((m) => (
              <option key={m} value={m}>
                Use {varName(m)} only
              </option>
            ))}
          </optgroup>
        </select>
        <span className="text-xs text-on-raised-muted">
          {choice.decidedBy === "default"
            ? "The default — nothing chosen yet. Rows where more than one variable has a value are counted and warned about in the notebook."
            : "Your rule — the notebook, the mapping table and the records file all carry it."}
        </span>
      </div>
      {choice.note && <p className="text-xs text-on-warn">{choice.note}</p>}
    </div>
  );
}
