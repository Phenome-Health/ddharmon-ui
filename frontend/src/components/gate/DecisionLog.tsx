import { GateEmptyState } from "@/components/gate/GateEmptyState";
import type { DecisionIndex } from "@/lib/gate-decisions";
import type { HarmonizationResult } from "@/types";
import {
  decisionCount,
  decisionLogRows,
  formatRevisionPct,
  revisionRate,
} from "@/lib/gate4";

/**
 * The in-app decision log (UI-SPEC §0.2 Surface 4, STGD-15, R15).
 *
 * A PURE FRONTEND READ over the persisted decisions the hook already hydrates (`all`) plus the run result.
 * `decisions_csv` already exports the same data and the artifact route already serves it — this adds NO
 * backend surface, which the plan asserts with an endpoint-count check. Its point is that "each correction
 * persists and is visible after reload" (R6) and "defend the mappings I export" (the goal) are both
 * untestable by a reviewer who cannot see their own decision trail before they download it.
 *
 * SUPERSEDED DECISIONS ARE SHOWN HONESTLY: the index holds one CURRENT decision per thing, so an earlier
 * choice is not re-listed as if it still stood; a decision whose upstream has since changed is marked
 * stale, which shows the current state without claiming the earlier one never happened.
 *
 * It also hosts the E3 revision-rate metric (external-methods audit E3): how much of what the pipeline
 * proposed the reviewer changed, computed under the P5 cosmetic-edit exclusion and stamped with its P2
 * denominator so the number is never read as a variable/row count.
 */
export function DecisionLog({
  index,
  result,
  coreVersion,
}: {
  index: DecisionIndex;
  result: HarmonizationResult | null | undefined;
  coreVersion?: string;
}) {
  const rows = decisionLogRows(index);
  const total = decisionCount(index);
  const rr = revisionRate(index, result, coreVersion ?? "");

  return (
    <section data-testid="decision-log" className="flex flex-col gap-3 rounded-card bg-surface-raised px-6 py-5 shadow-card">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-on-raised">The decisions behind this export</h2>
        {total > 0 && (
          <span className="text-xs text-on-raised-muted">
            {total} {total === 1 ? "decision" : "decisions"}
          </span>
        )}
      </div>

      {total === 0 ? (
        <GateEmptyState
          heading="No decisions recorded yet"
          nextStep="Walk back through the gates to adjust a grouping, a target, or a transform — each choice you make is recorded here."
        >
          You accepted the pipeline's proposals as they were. That is a valid outcome — nothing needs correcting — but
          it means there is no decision trail to show yet.
        </GateEmptyState>
      ) : (
        <>
          {/* E3 revision-rate — denominator stamped (P2), cosmetic edits excluded (P5). */}
          <p data-testid="revision-rate" data-denominator={rr.denominator} className="text-xs text-on-raised-muted">
            You substantively edited{" "}
            <span className="font-semibold text-on-raised">
              {rr.edited} of {rr.shown} {rr.denominator}
            </span>{" "}
            (<span className="font-mono tabular-nums">{formatRevisionPct(rr.rate)}</span>).
            {rr.excludedCosmetic > 0 && (
              <>
                {" "}
                {rr.excludedCosmetic} cosmetic {rr.excludedCosmetic === 1 ? "change" : "changes"} (renames) are excluded.
              </>
            )}{" "}
            <span className="text-on-raised-faint">
              Measured against pipeline release {rr.hygieneVersion}; not comparable to a variable count.
            </span>
          </p>

          <ul className="flex flex-col divide-y divide-rule-on-raised">
            {rows.map((r) => (
              <li
                key={`${r.kind}${r.thing}`}
                data-testid="decision-row"
                data-kind={r.kind}
                data-stale={String(r.stale)}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2"
              >
                <span className="inline-flex min-w-16 shrink-0 rounded-inner bg-surface-inset px-2 py-0.5 text-xs font-semibold text-on-raised-muted">
                  {r.gate}
                </span>
                <span className="text-sm text-on-raised">{r.action}</span>
                <span className="truncate font-mono text-xs text-on-raised-muted" title={r.thing}>
                  {r.thing}
                </span>
                {r.chosen !== "" ? (
                  <span className="font-mono text-xs text-on-raised-faint">→ {r.chosen}</span>
                ) : (
                  <span className="text-xs text-on-raised-faint">→ none of these</span>
                )}
                {r.stale && (
                  <span data-testid="decision-stale" className="text-xs font-semibold text-status-warn">
                    upstream changed — may be out of date
                  </span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
