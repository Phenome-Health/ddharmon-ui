import { useState } from "react";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  DROP_BUCKET,
  MISSING_BUCKET,
  mappingForSave,
  type SourceOption,
  type TargetValue,
} from "@/lib/value-map";

/**
 * The editable value-mapping surface for a transform spec (08-16g) — a drag-and-drop card-sort in the Gate
 * 1 idiom, so a reviewer FIXES a recode instead of only annotating it.
 *
 * Bhargav: *"prepopulate a manually editable transform spec based on the var response options even if the
 * value mapping fails ... any spec should be manually editable ... the same kind of drag and drop as in
 * gate 1 — a recommended mapping produced by ddharmon that can be adjusted by the user."*
 *
 * So the source var's response options are draggable chips; the target CDE's permissible values (plus two
 * standing buckets — "Missing / not collected" and "Drop") are drop zones; and ddharmon's recommendation
 * pre-places the chips. Crucially it renders EVEN WHEN GENERATION FAILED: the scaffold is built from the
 * source options and the target's permissible values, both of which exist regardless of whether the model
 * produced a recode. A chip left in "Unmapped" is a source value with no decision yet.
 *
 * The editor owns no persistence — every change calls `onChange(mapping)`; the caller writes the
 * `gate3_spec_edit` decision so the edit survives a reload (R6), exactly like a Gate 1 move.
 *
 * ONE CODE SPACE (08-28 1c). A bucket is a target VALUE keyed by its CODE (`data-bucket` = the code; for a
 * catalog CDE the code is the label), so the model's code map lands where the model put it and every change
 * the reviewer makes is saved in the target's codes (`lib/value-map.ts`). A change saves the WHOLE mapping,
 * with any code left unplaced written as an explicit Missing (Q3).
 */

export { DROP_BUCKET, MISSING_BUCKET };
export type { SourceOption };
const DRAG_TYPE = "application/x-ddharmon-spec-value";

/** A chip for one source value — draggable between buckets. */
function ValueChip({ code, label, readOnly }: { code: string; label: string; readOnly?: boolean }) {
  return (
    <span
      data-testid="spec-value-chip"
      data-code={code}
      draggable={!readOnly}
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, code);
        e.dataTransfer.effectAllowed = "move";
      }}
      className={cn(
        "inline-flex max-w-full items-baseline gap-1 rounded border border-rule-on-raised bg-surface-raised px-1.5 py-0.5 text-xs",
        !readOnly && "cursor-grab active:cursor-grabbing",
      )}
      title={`${code}${label ? ` = ${label}` : ""}`}
    >
      <span className="font-mono text-on-raised">{code}</span>
      {label && <span className="truncate text-on-raised-muted">{label}</span>}
    </span>
  );
}

/** A drop zone — a target value, or a standing convention bucket. */
function Bucket({
  id,
  title,
  code,
  hint,
  chips,
  readOnly,
  onDropCode,
}: {
  id: string;
  title: string;
  /** The target value's code, shown beside its label when the two differ. */
  code?: string;
  hint?: string;
  chips: React.ReactNode;
  readOnly?: boolean;
  onDropCode: (code: string, bucket: string) => void;
}) {
  const [over, setOver] = useState(false);
  return (
    <div
      data-testid="spec-bucket"
      data-bucket={id}
      data-drop-over={over ? "true" : undefined}
      onDragOver={
        readOnly
          ? undefined
          : (e) => {
              if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              setOver(true);
            }
      }
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false);
      }}
      onDrop={
        readOnly
          ? undefined
          : (e) => {
              e.preventDefault();
              setOver(false);
              const code = e.dataTransfer.getData(DRAG_TYPE);
              if (code) onDropCode(code, id);
            }
      }
      className={cn(
        "flex min-h-[3.25rem] flex-col gap-1 rounded-inner border border-dashed border-rule-on-raised bg-surface-raised px-2.5 py-2",
        over && "border-solid border-accent bg-surface-info",
      )}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-semibold text-on-raised">
          {code !== undefined && code !== title && (
            <span className="mr-1 font-mono font-normal text-on-raised-muted">{code}</span>
          )}
          {title}
        </span>
        {hint && <span className="text-xs text-on-raised-faint">{hint}</span>}
      </div>
      <div className="flex flex-wrap gap-1">{chips}</div>
    </div>
  );
}

export function SpecMappingEditor({
  sourceOptions,
  targetValues,
  value,
  recommended,
  recommendedFrom,
  onChange,
  readOnly,
}: {
  /** The source variable's response options — the chips to place. */
  sourceOptions: SourceOption[];
  /** The target's values (code + label) — the primary drop buckets, keyed by CODE. */
  targetValues: TargetValue[];
  /** Current mapping: source code -> target CODE | MISSING_BUCKET | DROP_BUCKET. Absent = Unmapped. */
  value: Record<string, string>;
  /** The starting point, for the edited badge + "reset to recommended". */
  recommended: Record<string, string>;
  /** `model` = the model's own code map; `heuristic` = no model map, a $0 label match. Said on screen. */
  recommendedFrom: "model" | "heuristic";
  onChange: (mapping: Record<string, string>) => void;
  readOnly?: boolean;
}) {
  const sourceCodes = sourceOptions.map((o) => o.code);
  // Every change saves the WHOLE mapping, unplaced codes as an explicit Missing (08-28 Q3).
  const save = (mapping: Record<string, string>) => onChange(mappingForSave(sourceCodes, mapping));
  const assign = (code: string, bucket: string) => {
    if ((value[code] ?? "") === bucket) return;
    save({ ...value, [code]: bucket });
  };

  const saved = mappingForSave(sourceCodes, value);
  const baseline = mappingForSave(sourceCodes, recommended);
  const edited = sourceCodes.some((c) => saved[c] !== baseline[c]);
  const codesIn = (bucket: string) => sourceOptions.filter((o) => (value[o.code] ?? "") === bucket);
  const unmapped = sourceOptions.filter((o) => !value[o.code]);

  const chipsFor = (bucket: string) =>
    codesIn(bucket).map((o) => <ValueChip key={o.code} code={o.code} label={o.label} readOnly={readOnly} />);

  return (
    <div data-testid="spec-mapping-editor" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span
          data-testid="spec-mapping-source"
          data-from={recommendedFrom}
          className="text-xs text-on-raised-muted"
        >
          {recommendedFrom === "model"
            ? "ddharmon's recommended mapping (the model's recode)"
            : "The model produced no mapping — a $0 starting point matched on value labels"}
          {edited && <span className="ml-1 font-semibold text-status-warn">· edited</span>}
          {!readOnly && " — drag a value to change where it lands"}
        </span>
        {edited && !readOnly && (
          <Button
            data-testid="spec-reset-mapping"
            size="sm"
            variant="ghost"
            className="h-6 gap-1 text-xs"
            onClick={() => save({ ...recommended })}
          >
            <RotateCcw className="h-3 w-3" /> Reset to recommended
          </Button>
        )}
      </div>

      {/* Source values not yet mapped — the tray you drag OUT of. Counted, because a code left here is exported
          as missing: stated, never a silent NaN (Q3). */}
      <Bucket
        id=""
        title="Unmapped source values"
        hint={
          unmapped.length === 0
            ? "all placed"
            : `${unmapped.length} to place — exported as missing if left here`
        }
        readOnly={readOnly}
        onDropCode={assign}
        chips={
          unmapped.length ? (
            unmapped.map((o) => <ValueChip key={o.code} code={o.code} label={o.label} readOnly={readOnly} />)
          ) : (
            <span className="text-xs text-on-raised-faint">Every source value has a target.</span>
          )
        }
      />

      {/* Target permissible values — the primary destinations, keyed by CODE. */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {targetValues.map((t) => (
          <Bucket
            key={t.code}
            id={t.code}
            title={t.label}
            code={t.code}
            hint={t.listed ? undefined : "used by the recode, not in the listed values"}
            chips={chipsFor(t.code)}
            readOnly={readOnly}
            onDropCode={assign}
          />
        ))}
      </div>

      {/* Standing conventions — a value can be recorded as missing, or explicitly dropped. */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Bucket
          id={MISSING_BUCKET}
          title="Missing / not collected"
          hint="a missing-data convention"
          chips={chipsFor(MISSING_BUCKET)}
          readOnly={readOnly}
          onDropCode={assign}
        />
        <Bucket
          id={DROP_BUCKET}
          title="Drop (no target)"
          hint="excluded from the recode"
          chips={chipsFor(DROP_BUCKET)}
          readOnly={readOnly}
          onDropCode={assign}
        />
      </div>
    </div>
  );
}
