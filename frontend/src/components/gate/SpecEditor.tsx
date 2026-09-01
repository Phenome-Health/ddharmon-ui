import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  UNMAPPED_OUTCOMES,
  UNMAPPED_OUTCOME_LABEL,
  specForm,
  unmappedState,
  type UnmappedOutcome,
} from "@/lib/gate23";
import { cn } from "@/lib/utils";
import type { UITransform } from "@/types";

/**
 * The three editing surfaces one transform spec can need, and the unmapped-value decision under them.
 *
 * THREE SURFACES, NOT ONE GENERIC FORM. A categorical recode is a TABLE of code pairs, a unit conversion is
 * two scalars and two unit names, and an arithmetic spec is a formula string. Rendering all three through a
 * single "edit the JSON" affordance would technically work and would make the one that needs the most
 * scrutiny - the formula - the hardest to read.
 *
 * NO MULTI-INPUT DERIVATION SURFACE, DELIBERATELY. An arithmetic transform spec is single-source by
 * construction; a derivation over several variables is a COMPOSITE and belongs to the composite thread.
 * Building an editor for it here would mean inventing a fixture the pipeline cannot produce, which is a
 * recorded failure mode on this project.
 *
 * AN UNMAPPED SOURCE VALUE IS A DECISION, NOT A FOOTNOTE. It is the quiet way a harmonization loses data:
 * the row does not arrive on the other side and nothing raises an error. So the reviewer is made to choose
 * - add a mapping, send it to a missing-data convention, or accept the loss ON THE RECORD - and zero, one
 * and many render differently so "one value is being dropped" cannot hide inside a generic plural.
 */

export function SpecEditor({
  transform,
  unmappedChoice,
  onUnmappedChoice,
  readOnly,
}: {
  transform: UITransform;
  /** The reviewer's recorded outcome per unmapped code, if any. */
  unmappedChoice?: Record<string, UnmappedOutcome>;
  onUnmappedChoice?: (code: string, outcome: UnmappedOutcome) => void;
  readOnly?: boolean;
}) {
  const form = specForm(transform.kind);
  const unmapped = transform.unmappedSourceCodes ?? [];
  const state = unmappedState(transform);

  return (
    <div className="flex flex-col gap-3">
      {form === "categorical" && (
        // Scrolls WITHIN its card: a large recode table must not grow the page at 1440x900 (T-08-99).
        <ScrollArea className="max-h-64 rounded-inner border border-rule-on-raised">
          <Table data-testid="recode-table">
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs">Source value</TableHead>
                <TableHead className="text-xs">Target value</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {Object.entries(transform.codeMap ?? {}).map(([from, to]) => (
                <TableRow key={from}>
                  <TableCell className="font-mono text-xs">{from}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {/* Clamped, with the full value available: a long label must not reflow the list. */}
                    <span className="line-clamp-1 break-all" title={to}>
                      {to}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ScrollArea>
      )}

      {form === "unit" && (
        <dl data-testid="unit-spec" className="flex flex-wrap gap-x-8 gap-y-1 text-xs text-on-raised-muted">
          <div>
            <dt className="inline font-semibold">From: </dt>
            <dd className="inline font-mono">{transform.sourceUnit || "unstated"}</dd>
          </div>
          <div>
            <dt className="inline font-semibold">To: </dt>
            <dd className="inline font-mono">{transform.targetUnit || "unstated"}</dd>
          </div>
          <div>
            <dt className="inline font-semibold">value x </dt>
            <dd className="inline font-mono">{transform.factor ?? 1}</dd>
          </div>
          <div>
            <dt className="inline font-semibold">+ </dt>
            <dd className="inline font-mono">{transform.offset ?? 0}</dd>
          </div>
        </dl>
      )}

      {form === "arithmetic" && (
        <div data-testid="arithmetic-spec" className="flex flex-col gap-1">
          <span className="text-xs font-semibold text-on-raised">Formula</span>
          {/* Clamped rather than wrapped: a long formula must not reflow the whole list. */}
          <code className="line-clamp-2 break-all rounded-inner bg-surface-inset px-3 py-2 font-mono text-xs text-on-raised">
            {transform.formula || "(no formula recorded)"}
          </code>
        </div>
      )}

      {form === "passthrough" && (
        <p data-testid="passthrough-note" className="text-xs text-on-raised-muted">
          The source values already match the target&apos;s value domain, so nothing is recoded.
        </p>
      )}

      {/* Zero, one and many render distinctly. Zero is stated rather than omitted, because "no unmapped
          values" is a RESULT a reviewer wants confirmed, not an absence to be inferred from silence. */}
      <div data-testid="unmapped" data-state={state} className="flex flex-col gap-2">
        {state === "none" ? (
          <p className="text-xs text-on-raised-muted">
            Every source value is carried across - no source value is dropped by this recode.
          </p>
        ) : (
          <>
            <p className="text-xs font-semibold text-on-raised">
              {unmapped.length === 1
                ? "1 source value has no target and will be dropped unless you decide otherwise"
                : `${unmapped.length} source values have no target and will be dropped unless you decide otherwise`}
            </p>
            <ul className="flex flex-col gap-2">
              {unmapped.map((code) => (
                <li
                  key={code}
                  data-testid="unmapped-decision"
                  data-code={code}
                  className="flex flex-wrap items-center gap-2"
                >
                  <span className="font-mono text-xs text-on-raised">{code}</span>
                  {UNMAPPED_OUTCOMES.map((outcome) => {
                    const active = unmappedChoice?.[code] === outcome;
                    return (
                      <button
                        key={outcome}
                        type="button"
                        data-outcome={outcome}
                        data-chosen={active}
                        disabled={readOnly}
                        onClick={() => onUnmappedChoice?.(code, outcome)}
                        className={cn(
                          "rounded-pill border px-2 py-0.5 text-xs",
                          active
                            ? "border-accent-on-raised text-on-raised"
                            : "border-rule-on-raised text-on-raised-muted",
                        )}
                      >
                        {UNMAPPED_OUTCOME_LABEL[outcome]}
                      </button>
                    );
                  })}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

/** A read-only echo of the source variable a spec applies to. Kept here so the two screens agree. */
export function SpecSource({ sourceVariable }: { sourceVariable: string }) {
  return (
    <Input readOnly value={sourceVariable} aria-label="Source variable" className="font-mono text-xs" />
  );
}
