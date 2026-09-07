import { cn } from "@/lib/utils";
import type { UITransform } from "@/types";

/**
 * The recode content for one transform spec (08-16g) — the workbench's value-mapping detail
 * (`workbench.tsx` `transformSummary` + `TransformDetail`), lifted onto Gate 3 so a reviewer sees EXACTLY
 * what a spec does inline, without exporting: the categorical code→code pairs (with value labels), the
 * unit factor/offset, the arithmetic formula, or the data-dependent method.
 *
 * `srcLabels`/`tgtLabels` are code→label maps (source field / target GenCDE permissible values); empty maps
 * degrade to bare codes. Identity/none render nothing.
 */

const CODE_MAP_CAP = 10;

/** A one-line human summary of a transform, for the row header. */
export function transformSummary(t: UITransform): string {
  switch (t.kind) {
    case "identity":
      return "identity (already aligned)";
    case "categorical":
      return `${Object.keys(t.codeMap ?? {}).length} codes mapped${
        t.unmappedSourceCodes?.length ? `, ${t.unmappedSourceCodes.length} unmapped` : ""
      }`;
    case "unit":
      return `× ${t.factor ?? "?"}${t.offset ? ` + ${t.offset}` : ""} (${t.sourceUnit ?? "?"} → ${t.targetUnit ?? "?"})`;
    case "arithmetic":
      return t.formula ?? "formula";
    case "data_dependent":
      return `${t.method ?? "data-dependent"} (needs data at apply-time)`;
    default:
      return "no spec";
  }
}

function CodeLabel({ code, label, codeClass }: { code: string; label?: string; codeClass: string }) {
  return (
    <span className="inline-flex min-w-0 items-baseline gap-1">
      <span className={cn("font-mono", codeClass)}>{code}</span>
      {label ? <span className="truncate text-on-raised-muted">({label})</span> : null}
    </span>
  );
}

export function RecodeDetail({
  t,
  srcLabels,
  tgtLabels,
}: {
  t: UITransform;
  srcLabels: Record<string, string>;
  tgtLabels: Record<string, string>;
}) {
  if (t.kind === "categorical") {
    const entries = Object.entries(t.codeMap ?? {});
    if (!entries.length && !t.unmappedSourceCodes?.length) return null;
    const shown = entries.slice(0, CODE_MAP_CAP);
    const moreCodes = entries.length - shown.length;
    const unmapped = t.unmappedSourceCodes ?? [];
    return (
      <div data-testid="recode-detail" data-kind="categorical" className="mt-2 space-y-1 border-t border-rule-quiet-on-raised pt-2 pl-1">
        {shown.length > 0 && (
          <div className="grid grid-cols-1 gap-x-6 gap-y-0.5 sm:grid-cols-2">
            {shown.map(([src, tgt]) => (
              <div
                key={src}
                className="flex items-center gap-1.5 text-xs"
                title={`${src}${srcLabels[src] ? ` = ${srcLabels[src]}` : ""}  →  ${tgt}${tgtLabels[tgt] ? ` = ${tgtLabels[tgt]}` : ""}`}
              >
                <CodeLabel code={src} label={srcLabels[src]} codeClass="text-on-raised-muted" />
                <span className="shrink-0 text-on-raised-faint">→</span>
                <CodeLabel code={tgt} label={tgtLabels[tgt]} codeClass="text-on-raised" />
              </div>
            ))}
          </div>
        )}
        {moreCodes > 0 && <div className="text-xs text-on-raised-muted">+{moreCodes} more mapped</div>}
        {unmapped.length > 0 && (
          <div className="text-xs text-status-warn">
            <span className="font-semibold">unmapped:</span>{" "}
            {unmapped.slice(0, CODE_MAP_CAP).map((code, i) => (
              <span key={code}>
                {i > 0 ? ", " : ""}
                <span className="font-mono">{code}</span>
                {srcLabels[code] ? <span className="text-status-warn/80"> ({srcLabels[code]})</span> : null}
              </span>
            ))}
            {unmapped.length > CODE_MAP_CAP ? ` +${unmapped.length - CODE_MAP_CAP} more` : ""}
          </div>
        )}
      </div>
    );
  }
  if (t.kind === "unit") {
    return (
      <div data-testid="recode-detail" data-kind="unit" className="mt-2 border-t border-rule-quiet-on-raised pt-2 pl-1 font-mono text-xs text-on-raised">
        target = source × {t.factor ?? "?"}
        {t.offset ? ` + ${t.offset}` : ""}
        <span className="ml-2 font-sans text-on-raised-muted">
          ({t.sourceUnit ?? "?"} → {t.targetUnit ?? "?"})
        </span>
      </div>
    );
  }
  if (t.kind === "arithmetic") {
    return (
      <div data-testid="recode-detail" data-kind="arithmetic" className="mt-2 border-t border-rule-quiet-on-raised pt-2 pl-1 font-mono text-xs text-on-raised">
        {t.formula ?? "—"}
        {t.inputs?.length ? <span className="ml-2 font-sans text-on-raised-muted">inputs: {t.inputs.join(", ")}</span> : null}
      </div>
    );
  }
  if (t.kind === "data_dependent") {
    return (
      <div data-testid="recode-detail" data-kind="data_dependent" className="mt-2 border-t border-rule-quiet-on-raised pt-2 pl-1 text-xs text-on-raised-muted">
        method <span className="font-mono text-on-raised">{t.method ?? "data-dependent"}</span> — needs row-level
        data at apply-time
      </div>
    );
  }
  return null;
}
