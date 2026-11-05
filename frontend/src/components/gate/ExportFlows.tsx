import { useMemo } from "react";
import { MatchSankey } from "@/components/match-sankey";
import { PlotInfo } from "@/components/plot-info";
import { buildSankeyData, sankeyVariableCount } from "@/lib/sankey";
import type { UIRecord } from "@/types";

/**
 * Where the exported variables go — the run view's "Match journey" Sankey, surfaced on Gate 4 (final review
 * round 2). Bhargav found it only by accident, by way of analysis ideas -> "back to the run" landing on the
 * legacy run page: "if we have this available we might as well surface it on gate 4 rather than burying it".
 *
 * IT DRAWS THE EXPORT, NOT THE RUN. `records` are the records the files carry (`exportedRecords`: the Gate 1
 * scope, the Gate 4 export selection and the reviewer's names applied — pinned to the backend's
 * `effective_records`), so this chart and the downloads cannot disagree on this screen of all screens. The
 * existing component is reused as-is; it is given no `cohortTotals`, because its reconciliation bucket would
 * file every variable outside the export under "Unclustered" — and most of those were scoped out by the
 * reviewer, which is a different claim. The page's own summary below the export set says which is which.
 */
export function ExportFlows({
  records,
  runHasRecords,
  outsideCount,
}: {
  /** The records the export carries. */
  records: UIRecord[];
  /** Whether the run has any concept records at all — the empty state differs. */
  runHasRecords: boolean;
  /** Variables the export does not carry (scoped out or no concept), named so the chart's total is not misread. */
  outsideCount: number;
}) {
  const variables = useMemo(() => sankeyVariableCount(buildSankeyData(records)), [records]);
  const n = records.length;
  return (
    <section
      data-testid="gate4-sankey"
      data-concepts={n}
      data-variables={variables}
      className="flex flex-col gap-3 rounded-card bg-surface-raised px-6 py-4 shadow-card"
    >
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-on-raised">Where the exported variables go</h2>
          <PlotInfo>
            Every variable this export carries: <b>cohort → verdict → destination</b>, flow width = number of
            variables. <b>Adopt</b> and <b>Refine</b> map onto an existing CDE; <b>Novel</b> routes to a generated
            one. Drawn from the concepts as you leave them — your Gate 1 scope and names, your Gate 2 targets — the
            same records every file below carries.
          </PlotInfo>
        </div>
        {n > 0 && (
          <p className="max-w-[80ch] text-xs text-on-raised-muted">
            {n} {n === 1 ? "concept" : "concepts"}, {variables} {variables === 1 ? "variable" : "variables"}, as you
            leave them. Hover a node or a flow for its count.
            {outsideCount > 0 &&
              ` The ${outsideCount} ${outsideCount === 1 ? "variable" : "variables"} outside the export ${
                outsideCount === 1 ? "is" : "are"
              } not drawn; they are accounted for below the export set.`}
          </p>
        )}
      </div>
      {n > 0 ? (
        <MatchSankey records={records} />
      ) : (
        <p data-testid="gate4-sankey-empty" className="text-sm text-on-raised-muted">
          {runHasRecords
            ? "Nothing is in this export — every concept was scoped out or excluded — so there are no flows to draw."
            : "This run has no concept records yet, so there are no flows to draw."}
        </p>
      )}
    </section>
  );
}
