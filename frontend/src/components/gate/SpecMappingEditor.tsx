import { useState } from "react";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

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
 */

export const MISSING_BUCKET = "__missing__";
export const DROP_BUCKET = "__drop__";
const DRAG_TYPE = "application/x-ddharmon-spec-value";

export interface SourceOption {
  code: string;
  label: string;
}

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
  hint,
  chips,
  readOnly,
  onDropCode,
}: {
  id: string;
  title: string;
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
        <span className="text-xs font-semibold text-on-raised">{title}</span>
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
  onChange,
  readOnly,
}: {
  /** The source variable's response options — the chips to place. */
  sourceOptions: SourceOption[];
  /** The target CDE's permissible values — the primary drop buckets. */
  targetValues: string[];
  /** Current mapping: source code -> target value | MISSING_BUCKET | DROP_BUCKET. Absent = Unmapped. */
  value: Record<string, string>;
  /** ddharmon's recommendation, for the edited badge + "reset to recommended". */
  recommended: Record<string, string>;
  onChange: (mapping: Record<string, string>) => void;
  readOnly?: boolean;
}) {
  const assign = (code: string, bucket: string) => {
    if (value[code] === bucket) return;
    onChange({ ...value, [code]: bucket });
  };

  const edited = sourceOptions.some((o) => (value[o.code] ?? "") !== (recommended[o.code] ?? ""));
  const codesIn = (bucket: string) => sourceOptions.filter((o) => (value[o.code] ?? "") === bucket);
  const unmapped = sourceOptions.filter((o) => !value[o.code]);

  const chipsFor = (bucket: string) =>
    codesIn(bucket).map((o) => <ValueChip key={o.code} code={o.code} label={o.label} readOnly={readOnly} />);

  return (
    <div data-testid="spec-mapping-editor" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-on-raised-muted">
          ddharmon&apos;s recommended mapping{edited && <span className="ml-1 font-semibold text-status-warn">· edited</span>}
          {!readOnly && " — drag a value to change where it lands"}
        </span>
        {edited && !readOnly && (
          <Button
            data-testid="spec-reset-mapping"
            size="sm"
            variant="ghost"
            className="h-6 gap-1 text-xs"
            onClick={() => onChange({ ...recommended })}
          >
            <RotateCcw className="h-3 w-3" /> Reset to recommended
          </Button>
        )}
      </div>

      {/* Source values not yet mapped — the tray you drag OUT of. */}
      <Bucket
        id=""
        title="Unmapped source values"
        hint={unmapped.length === 0 ? "all placed" : `${unmapped.length} to place`}
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

      {/* Target permissible values — the primary destinations. */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {targetValues.map((t) => (
          <Bucket key={t} id={t} title={t} chips={chipsFor(t)} readOnly={readOnly} onDropCode={assign} />
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

/**
 * Seed the recommended mapping when the model produced no usable code map — a $0 heuristic so a FAILED spec
 * still opens with a sensible starting point rather than a blank grid:
 *  - exact (case-insensitive) label match to a target value → that target,
 *  - a label that reads as a missing-data convention → the Missing bucket,
 *  - otherwise Unmapped, for the reviewer to place.
 */
const MISSING_HINTS = ["prefer not", "don't know", "dont know", "unknown", "refused", "not answer", "missing", "n/a"];

export function seedRecommendedMapping(
  sourceOptions: SourceOption[],
  targetValues: string[],
  existing?: Record<string, string>,
): Record<string, string> {
  const targetByLower = new Map(targetValues.map((t) => [t.toLowerCase(), t]));
  const out: Record<string, string> = {};
  // Heuristic base — exact label match, then missing-data hints.
  for (const o of sourceOptions) {
    const label = (o.label || o.code).toLowerCase();
    const exact = targetByLower.get(label);
    if (exact) {
      out[o.code] = exact;
    } else if (MISSING_HINTS.some((h) => label.includes(h))) {
      out[o.code] = MISSING_BUCKET;
    }
  }
  // Overlay the model's own code map where it gave one (partial maps merge over the heuristic).
  if (existing) for (const [k, v] of Object.entries(existing)) if (v) out[k] = v;
  return out;
}

/** Translate a transform's `codeMap` (source code -> target CODE) into target-VALUE buckets, keeping only
 *  entries whose target lands on a known permissible value (others fall through to the heuristic). */
export function codeMapToBuckets(
  codeMap: Record<string, string> | undefined,
  targetValues: string[],
): Record<string, string> {
  const byLower = new Map(targetValues.map((t) => [t.toLowerCase(), t]));
  const out: Record<string, string> = {};
  for (const [src, tgt] of Object.entries(codeMap ?? {})) {
    const hit = byLower.get(String(tgt).toLowerCase());
    if (hit) out[src] = hit;
  }
  return out;
}
