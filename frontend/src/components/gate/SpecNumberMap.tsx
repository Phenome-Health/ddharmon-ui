import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  NUMBER_ACTIONS,
  NUMBER_ACTION_LABEL,
  type NumberAction,
  type NumberMapEntry,
} from "@/lib/gate23";
import { cn } from "@/lib/utils";
import type { SourceOption } from "@/components/gate/SpecMappingEditor";

/**
 * ② The value-recode surface for a CATEGORICAL source on a NUMERIC target (08-16g) — AI-READI
 * `susmkstoage` is the canonical case: "years smoked" captured as a number with a couple of coded overlays
 * (98 = "more than 60", 999 = "prefer not to say") mapping onto a Number CDE that has no permissible values.
 *
 * WHY NOT THE DRAG-AND-DROP VALUE MAP. `SpecMappingEditor` sorts source chips INTO target-value buckets, and
 * a numeric target has none — so the chip editor renders only Missing/Drop and cannot say "98 means the
 * number 60" or "the numeric body passes through unchanged". This is a table instead: the numeric BODY is a
 * standing pass-through row (the default, and the bulk of the data), and each coded value gets one editable
 * decision — a representative Number, Missing, or Drop.
 *
 * DEFAULT IS MISSING, NEVER A FABRICATED NUMBER. A code has no natural number on a numeric target, so every
 * code opens at Missing; a representative number is a deliberate reviewer upgrade (see `seedNumberMap`). The
 * honestly-correct answer for a top-code like 98 is a censored value (≥ 60), which lands in a later pass once
 * the run contract can carry a censored flag downstream.
 *
 * Owns no persistence: every change calls `onChange(map)`; the caller writes the `gate3_spec_edit` decision
 * so the edit survives a reload (R6), exactly like a Gate 1 move.
 */
export function SpecNumberMap({
  sourceOptions,
  targetUnits,
  value,
  recommended,
  onChange,
  readOnly,
}: {
  /** The source variable's coded values — the numeric body is NOT among these; it is the standing row. */
  sourceOptions: SourceOption[];
  /** The target CDE's unit, echoed on the pass-through row so "value" is not dimensionless. */
  targetUnits?: string;
  value: Record<string, NumberMapEntry>;
  recommended: Record<string, NumberMapEntry>;
  onChange: (map: Record<string, NumberMapEntry>) => void;
  readOnly?: boolean;
}) {
  const entryFor = (code: string): NumberMapEntry =>
    value[code] ?? { action: "missing", value: null };
  const setEntry = (code: string, entry: NumberMapEntry) =>
    onChange({ ...value, [code]: entry });
  const edited = sourceOptions.some((o) => {
    const a = value[o.code];
    const b = recommended[o.code];
    return (
      (a?.action ?? "missing") !== (b?.action ?? "missing") ||
      (a?.value ?? null) !== (b?.value ?? null)
    );
  });

  return (
    <div data-testid="spec-number-map" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-on-raised-muted">
          Numeric target — a coded value becomes a number, Missing, or Drop;
          numeric responses pass through
          {edited && (
            <span className="ml-1 font-semibold text-status-warn">
              · edited
            </span>
          )}
        </span>
        {edited && !readOnly && (
          <Button
            data-testid="number-reset"
            size="sm"
            variant="ghost"
            className="h-6 gap-1 text-xs"
            onClick={() => onChange({ ...recommended })}
          >
            <RotateCcw className="h-3 w-3" /> Reset to recommended
          </Button>
        )}
      </div>

      <div className="overflow-hidden rounded-inner border border-rule-on-raised">
        {/* The numeric body — the default, pre-selected, and the bulk of the data. Not a code, so it never
            appears in the map; stated as a standing row so "pass through" is a visible decision, not a gap. */}
        <div
          data-testid="number-passthrough"
          className="grid grid-cols-[minmax(9rem,15rem)_1fr] border-b border-rule-quiet-on-raised bg-surface-ok"
        >
          <div className="border-r border-rule-quiet-on-raised px-3 py-2">
            <div className="font-mono text-xs font-semibold text-on-raised">
              numeric responses
            </div>
            <div className="mt-0.5 text-xs font-semibold uppercase tracking-wide text-on-ok">
              the body of the data
            </div>
          </div>
          <div className="flex flex-col justify-center gap-0.5 px-3 py-2">
            <div className="flex items-center gap-2 text-xs">
              <span className="text-on-ok">◉</span>
              <span className="font-semibold text-on-raised">
                Pass through as-is
              </span>
              <span className="font-mono text-on-raised-muted">
                → value{targetUnits ? ` (${targetUnits})` : ""}
              </span>
            </div>
            <div className="text-xs text-on-raised-faint">
              Entered directly as a number — the default for a numeric target.
            </div>
          </div>
        </div>

        {sourceOptions.map((o) => {
          const entry = entryFor(o.code);
          return (
            <div
              key={o.code}
              data-testid="number-row"
              data-code={o.code}
              data-action={entry.action}
              className="grid grid-cols-[minmax(10rem,16rem)_1fr] border-b border-rule-quiet-on-raised last:border-b-0"
            >
              <div className="min-w-0 border-r border-rule-quiet-on-raised bg-surface-inset px-3 py-2">
                <div className="break-all font-mono text-xs font-semibold text-on-inset">
                  {o.code}
                </div>
                {o.label && (
                  <div className="mt-0.5 break-words text-xs text-on-inset-muted">
                    {o.label}
                  </div>
                )}
                <div className="mt-1 text-[10.5px] font-semibold uppercase tracking-wide text-on-inset-muted">
                  coded value
                </div>
              </div>
              <div className="flex flex-col justify-center gap-1.5 px-3 py-2">
                {NUMBER_ACTIONS.map((action: NumberAction) => {
                  const active = entry.action === action;
                  return (
                    <div key={action} className="flex items-center gap-2">
                      <button
                        type="button"
                        data-testid="number-action"
                        data-action={action}
                        data-chosen={active}
                        disabled={readOnly}
                        onClick={() =>
                          setEntry(o.code, {
                            action,
                            value: action === "number" ? entry.value : null,
                          })
                        }
                        className={cn(
                          "inline-flex items-center gap-1 rounded-pill border px-2 py-0.5 text-xs",
                          active
                            ? "border-accent-on-raised font-semibold text-on-raised"
                            : "border-rule-on-raised text-on-raised-muted",
                        )}
                      >
                        {NUMBER_ACTION_LABEL[action]}
                      </button>
                      {action === "number" && (
                        <input
                          data-testid="number-value"
                          type="number"
                          inputMode="numeric"
                          disabled={readOnly}
                          value={
                            entry.action === "number" && entry.value != null
                              ? entry.value
                              : ""
                          }
                          placeholder="value"
                          onChange={(e) =>
                            setEntry(o.code, {
                              action: "number",
                              value:
                                e.target.value === ""
                                  ? null
                                  : Number(e.target.value),
                            })
                          }
                          className="w-20 rounded border border-rule-on-raised bg-surface-raised px-2 py-0.5 text-center font-mono text-xs text-on-raised"
                        />
                      )}
                      {action === "missing" && active && (
                        <span className="text-xs text-on-raised-faint">
                          — safe default; never fabricates a number
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
