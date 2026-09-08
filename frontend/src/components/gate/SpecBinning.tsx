import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { BinRule } from "@/lib/gate23";
import { cn } from "@/lib/utils";

/**
 * ③ The value-recode surface for a NUMERIC source on a CATEGORICAL target (08-16g) — the mirror of ②. A
 * source measured as a number (age in years) mapping onto a banded CDE (an age-group with permissible
 * values 18–29, 30–44, …) hits the same wall as ② the other way: there are no source chips to enumerate,
 * because the source is a continuous number. So this is a range table — one row per target band, with the
 * boundaries the reviewer edits.
 *
 * BANDS ARE PRE-PROPOSED FROM THE LABELS. `seedBinning` parses "18-29" / "65+" / "under 18" into
 * boundaries so the reviewer opens with a starting point, not a blank grid; a named band with no parseable
 * range ("adult") opens unbounded for the reviewer to fill.
 *
 * VALUES OUTSIDE EVERY BAND FALL TO MISSING — stated, not silent, for the same reason ② defaults to
 * Missing: dropping a value must never be invisible.
 *
 * Owns no persistence: every change calls `onChange(bins)`; the caller writes the `gate3_spec_edit`
 * decision so the edit survives a reload (R6).
 */

/** Flag adjacent bands that overlap or leave a gap — a soft diagnostic, never a gate. */
function binIssues(bins: BinRule[]): string[] {
  const bounded = bins.filter((b) => b.min != null || b.max != null);
  const sorted = [...bounded].sort(
    (a, b) => (a.min ?? -Infinity) - (b.min ?? -Infinity),
  );
  const issues: string[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (prev.max == null || cur.min == null) continue;
    if (cur.min <= prev.max)
      issues.push(`${prev.band} and ${cur.band} overlap`);
    else if (cur.min > prev.max + 1)
      issues.push(`gap between ${prev.band} and ${cur.band}`);
  }
  return issues;
}

export function SpecBinning({
  value,
  recommended,
  onChange,
  readOnly,
}: {
  value: BinRule[];
  recommended: BinRule[];
  onChange: (bins: BinRule[]) => void;
  readOnly?: boolean;
}) {
  const setBin = (index: number, patch: Partial<BinRule>) =>
    onChange(value.map((b, i) => (i === index ? { ...b, ...patch } : b)));
  const num = (raw: string): number | null =>
    raw.trim() === "" ? null : Number(raw);
  const edited = value.some((b, i) => {
    const r = recommended[i];
    return (
      !r ||
      (b.min ?? null) !== (r.min ?? null) ||
      (b.max ?? null) !== (r.max ?? null)
    );
  });
  const issues = binIssues(value);

  return (
    <div data-testid="spec-binning" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-on-raised-muted">
          Categorical target — a source number falls into a band by its range;
          edit the boundaries
          {edited && (
            <span className="ml-1 font-semibold text-status-warn">
              · edited
            </span>
          )}
        </span>
        {edited && !readOnly && (
          <Button
            data-testid="binning-reset"
            size="sm"
            variant="ghost"
            className="h-6 gap-1 text-xs"
            onClick={() => onChange(recommended.map((b) => ({ ...b })))}
          >
            <RotateCcw className="h-3 w-3" /> Reset to recommended
          </Button>
        )}
      </div>

      <div className="overflow-hidden rounded-inner border border-rule-on-raised">
        {value.map((b, i) => (
          <div
            key={b.band}
            data-testid="bin-row"
            data-band={b.band}
            className="grid grid-cols-[minmax(11rem,18rem)_1fr] border-b border-rule-quiet-on-raised last:border-b-0"
          >
            <div className="flex items-center gap-1.5 border-r border-rule-quiet-on-raised px-3 py-2">
              <input
                data-testid="bin-min"
                type="number"
                inputMode="numeric"
                disabled={readOnly}
                value={b.min ?? ""}
                placeholder="−∞"
                onChange={(e) => setBin(i, { min: num(e.target.value) })}
                className="w-16 rounded border border-rule-on-raised bg-surface-raised px-2 py-0.5 text-center font-mono text-xs text-on-raised"
              />
              <span className="font-mono text-xs text-on-raised-faint">–</span>
              <input
                data-testid="bin-max"
                type="number"
                inputMode="numeric"
                disabled={readOnly}
                value={b.max ?? ""}
                placeholder="∞"
                onChange={(e) => setBin(i, { max: num(e.target.value) })}
                className="w-16 rounded border border-rule-on-raised bg-surface-raised px-2 py-0.5 text-center font-mono text-xs text-on-raised"
              />
            </div>
            <div className="flex items-center gap-2 px-3 py-2">
              <span className="text-on-raised-faint">→</span>
              <span className="text-xs font-semibold text-on-raised">
                {b.band}
              </span>
            </div>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        <span className="text-on-raised-muted">
          A source number outside every band → Missing.
        </span>
        {issues.length > 0 && (
          <span
            data-testid="bin-warning"
            className={cn("font-semibold text-status-warn")}
          >
            check: {issues.join("; ")}
          </span>
        )}
      </div>
    </div>
  );
}
