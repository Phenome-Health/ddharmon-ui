// Dashboard analytics — the "distribution" views the Sankey (flow) doesn't show. Convergent picks from the
// literature + BIDS cde-atlas + Krishnamurthy sweeps, all derived from the UIRecord contract (no backend):
//   1. Coverage-by-cohort table (CDEMapper/DIVER coverage-rate idiom)
//   2. Concepts by size-tier × verdict (cde-atlas OverlapView)
//   3. Retrieval-score histogram stacked by verdict (Semantic Search Helper cosine dist)
//   4. Cross-cohort overlap heatmap (concept co-occurrence per cohort pair)
//
// Interactivity: branded tooltips with per-verdict breakdown + a legend on the bar charts; the overlap
// heatmap cross-highlights the hovered row/column and reads out the pair. Palette from lib/chart.
import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PlotInfo } from "@/components/plot-info";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
// The bars and the histogram were EXTRACTED by 08-16 so Gate 2 could take the histogram alone. Imported
// back here rather than kept as a private copy: one implementation, two call sites.
import { StackedVerdictBars } from "@/components/stacked-verdict-bars";
import { RetrievalHistogram } from "@/components/gate/RetrievalHistogram";
import {
  CHART_TOOLTIP_CLASS,
  isVerdict,
  VERDICT_COLOR,
  VERDICT_LABEL,
  VERDICTS,
  type Focus,
  type Verdict,
} from "@/lib/chart";
import type { UIRecord } from "@/types";

function cohortOf(member: string, fallback: string): string {
  const i = member.indexOf(":");
  return i > 0 ? member.slice(0, i) : fallback;
}
function vkey(r: UIRecord): Verdict {
  return isVerdict(r.verdict) ? r.verdict : "unclassified";
}

// ── 1. coverage by cohort ────────────────────────────────────────
interface CohortRow {
  cohort: string;
  total: number;
  assigned: number; // adopt + refine
  novel: number;
  coverage: number; // assigned / total
}
function coverageByCohort(records: UIRecord[], cohortTotals?: Record<string, number>): CohortRow[] {
  const acc = new Map<string, { total: number; assigned: number; novel: number }>();
  const ensure = (c: string) => acc.get(c) ?? { total: 0, assigned: 0, novel: 0 };
  for (const r of records) {
    const v = vkey(r);
    const members = r.members.length ? r.members : r.cohorts.map((c) => `${c}:`);
    for (const m of members) {
      const c = cohortOf(m, r.cohorts[0] ?? "unknown");
      const row = ensure(c);
      row.total += 1;
      if (v === "adopt" || v === "refine") row.assigned += 1;
      else if (v === "novel") row.novel += 1;
      acc.set(c, row);
    }
  }
  // Use the true per-cohort field count (from the atlas) as the denominator when available, so "Fields" and
  // coverage reflect ALL the cohort's fields — not just those that reached a concept. The shortfall
  // (Fields − Assigned − Novel) is fields that never clustered.
  if (cohortTotals) {
    for (const [c, n] of Object.entries(cohortTotals)) {
      const row = ensure(c);
      row.total = n;
      acc.set(c, row);
    }
  }
  return [...acc.entries()]
    .map(([cohort, r]) => ({ cohort, ...r, coverage: r.total ? r.assigned / r.total : 0 }))
    .sort((a, b) => b.total - a.total);
}

// ── 2. concepts by size tier × verdict ───────────────────────────
function sizeTier(n: number): string {
  if (n >= 5) return "≥5";
  return String(Math.max(1, n));
}
const TIER_ORDER = ["1", "2", "3", "4", "≥5"];
function sizeVerdictBars(records: UIRecord[]) {
  const acc = new Map<string, Record<string, number>>();
  for (const r of records) {
    const tier = sizeTier(r.nMembers);
    const row = acc.get(tier) ?? {};
    const v = vkey(r);
    row[v] = (row[v] ?? 0) + 1;
    acc.set(tier, row);
  }
  return TIER_ORDER.filter((t) => acc.has(t)).map((t) => ({ name: t, ...acc.get(t) }));
}

// ── 4. cross-cohort overlap (concept co-occurrence) ──────────────
function cohortOverlap(records: UIRecord[]): { cohorts: string[]; matrix: number[][]; max: number } {
  const cohorts = [...new Set(records.flatMap((r) => r.cohorts))].sort();
  const idx = new Map(cohorts.map((c, i) => [c, i]));
  const matrix = cohorts.map(() => cohorts.map(() => 0));
  let max = 0;
  for (const r of records) {
    const cs = [...new Set(r.cohorts)].filter((c) => idx.has(c));
    for (const a of cs)
      for (const b of cs) {
        const i = idx.get(a)!;
        const j = idx.get(b)!;
        matrix[i][j] += 1;
        if (i !== j && matrix[i][j] > max) max = matrix[i][j];
      }
  }
  return { cohorts, matrix, max: max || 1 };
}

const sizeLabel = (t: string) => `${t} variable${t === "1" ? "" : "s"} per concept`;

export function Analytics({
  records,
  cohortTotals,
  focus = null,
  onFocus,
}: {
  records: UIRecord[];
  cohortTotals?: Record<string, number>;
  focus?: Focus;
  onFocus?: (f: Focus) => void;
}) {
  const cohortRows = useMemo(() => coverageByCohort(records, cohortTotals), [records, cohortTotals]);
  const sizeBars = useMemo(() => sizeVerdictBars(records), [records]);
  const overlap = useMemo(() => cohortOverlap(records), [records]);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader className="flex flex-row items-center gap-2 space-y-0">
          <CardTitle className="text-sm">Coverage by cohort</CardTitle>
          <PlotInfo>
            Per cohort: <b>Variables</b> it contributed, how many were <b>Assigned</b> to an existing CDE
            (adopt/refine) vs proposed <b>Novel</b>, and <b>Coverage</b> = assigned ÷ variables. Assigned + Novel
            can be less than Variables — the rest didn&apos;t cluster into any concept. Click a row to focus that cohort.
          </PlotInfo>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Cohort</TableHead>
                <TableHead className="text-right">Variables</TableHead>
                <TableHead className="text-right">Assigned</TableHead>
                <TableHead className="text-right">Novel</TableHead>
                <TableHead className="text-right">Coverage</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {cohortRows.map((r) => {
                const on = focus?.kind === "cohort" && focus.value === r.cohort;
                return (
                  <TableRow
                    key={r.cohort}
                    onClick={onFocus ? () => onFocus({ kind: "cohort", value: r.cohort }) : undefined}
                    className={`${onFocus ? "cursor-pointer" : ""} ${on ? "bg-surface-info" : "hover:bg-surface-inset"}`}
                  >
                    <TableCell className={`font-semibold ${on ? "text-accent-on-raised" : "text-on-raised"}`}>{r.cohort}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.total}</TableCell>
                    <TableCell className="text-right tabular-nums text-success">{r.assigned}</TableCell>
                    <TableCell className="text-right tabular-nums text-accent-on-raised">{r.novel}</TableCell>
                    <TableCell className="text-right tabular-nums ">{(r.coverage * 100).toFixed(0)}%</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center gap-2 space-y-0">
          <CardTitle className="text-sm">Concepts by size × verdict</CardTitle>
          <PlotInfo>
            How many concepts pooled 1, 2, 3… variables (x-axis), with each bar stacked by verdict
            (adopt/refine/novel). A higher x-tier means more variables pooled into one shared concept
            (more harmonization); the y-axis is how many concepts fall in that tier.
            Click a segment to focus that verdict.
          </PlotInfo>
        </CardHeader>
        <CardContent>
          {sizeBars.length ? (
            <StackedVerdictBars data={sizeBars} formatLabel={sizeLabel} focus={focus} onFocus={onFocus} />
          ) : (
            <p className="py-8 text-center text-sm text-on-raised-muted">No concepts.</p>
          )}
          <p className="mt-1 text-xs text-on-raised-muted">x = variables pooled per concept · bars stacked by verdict</p>
        </CardContent>
      </Card>

      {/* The same component Gate 2 renders — see `RetrievalHistogram`. */}
      <RetrievalHistogram records={records} focus={focus} onFocus={onFocus} />

      <Card>
        <CardHeader className="flex flex-row items-center gap-2 space-y-0">
          <CardTitle className="text-sm">Cross-cohort overlap</CardTitle>
          <PlotInfo>
            A heatmap of how many concepts each pair of cohorts <b>share</b> — i.e. variables from both cohorts
            pooled into the same harmonized concept. Darker cells = more shared concepts, the core payoff of
            cross-cohort harmonization. Click a cell to focus that pair.
          </PlotInfo>
        </CardHeader>
        <CardContent>
          {overlap.cohorts.length ? (
            <OverlapHeatmap {...overlap} focus={focus} onFocus={onFocus} />
          ) : (
            <p className="py-8 text-center text-sm text-on-raised-muted">No cohorts.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function OverlapHeatmap({
  cohorts,
  matrix,
  max,
  focus,
  onFocus,
}: {
  cohorts: string[];
  matrix: number[][];
  max: number;
  focus?: Focus;
  onFocus?: (f: Focus) => void;
}) {
  const [hc, setHc] = useState<{ i: number; j: number } | null>(null);
  const fi = focus?.kind === "cohort" ? cohorts.indexOf(focus.value) : -1; // sticky-focused cohort row/col
  const readout = hc
    ? hc.i === hc.j
      ? `${cohorts[hc.i]} — ${matrix[hc.i][hc.j]} concepts total`
      : `${cohorts[hc.i]} ∩ ${cohorts[hc.j]} — ${matrix[hc.i][hc.j]} shared concept${matrix[hc.i][hc.j] === 1 ? "" : "s"}`
    : fi >= 0
      ? `${cohorts[fi]} — ${matrix[fi][fi]} concepts (filtering the run)`
      : "concepts shared between each cohort pair (diagonal = total)";
  const colOn = (j: number) => hc?.j === j || fi === j;
  const rowOn = (i: number) => hc?.i === i || fi === i;
  const clickCohort = (c: string) => onFocus?.({ kind: "cohort", value: c });
  // The strongest wash a cell may carry. At 55% of the accent over paper the ink still
  // measures 5.37:1; at 65% it is 4.44:1 and already sub-AA.
  const WASH_MAX = 0.55;
  return (
    <div>
      <div className="overflow-x-auto">
        <table className="border-collapse text-xs tabular-nums" onMouseLeave={() => setHc(null)}>
          <thead>
            <tr>
              <th className="p-1" />
              {cohorts.map((c, j) => (
                <th
                  key={c}
                  onClick={onFocus ? () => clickCohort(c) : undefined}
                  className={`max-w-[64px] truncate p-1 ${onFocus ? "cursor-pointer" : ""} ${colOn(j) ? "font-semibold text-accent-on-raised" : "text-on-raised-muted"}`}
                  title={c}
                >
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {cohorts.map((rc, i) => (
              <tr key={rc}>
                <td
                  onClick={onFocus ? () => clickCohort(rc) : undefined}
                  className={`max-w-[100px] truncate p-1 pr-2 text-right ${onFocus ? "cursor-pointer" : ""} ${rowOn(i) ? "text-accent-on-raised" : "text-on-raised"}`}
                  title={rc}
                >
                  {rc}
                </td>
                {cohorts.map((cc, j) => {
                  const v = matrix[i][j];
                  const alpha = i === j ? 0.12 : v / max;
                  const inCross = rowOn(i) || colOn(j);
                  const isCell = hc?.i === i && hc?.j === j;
                  return (
                    <td
                      key={cc}
                      onMouseEnter={() => setHc({ i, j })}
                      className="h-8 w-12 border text-center transition-colors"
                      style={{
                        // The wash is CAPPED at WASH_MAX rather than running to the full accent,
                        // and the number is always the paper ink. Measured, because the obvious
                        // alternative does not work: a two-colour switch over a single-hue wash
                        // passes through a mid-tone where NEITHER the ink nor the cream clears AA.
                        // The dead band bottoms out at ~3.67:1 for every endpoint tried (pure
                        // accent, and accent/ink blends from 80% down to 0%), so it is a property
                        // of the ramp, not a badly-chosen switch point — the old `alpha > 0.5`
                        // rule shipped cells at 2.43:1, 3.47:1 and 4.30:1. Capping keeps the
                        // encoding monotonic, keeps every cell legible at >= 5.37:1, and deletes
                        // the conditional entirely.
                        backgroundColor: `color-mix(in srgb, var(--accent) ${(Math.max(v ? 0.08 : 0, alpha * WASH_MAX) * 100).toFixed(2)}%, transparent)`,
                        color: "var(--on-raised)",
                        borderColor: isCell ? "var(--on-raised)" : inCross ? "var(--rule-on-raised)" : "transparent",
                        outline: isCell ? "1px solid var(--on-raised)" : "none",
                        cursor: "default",
                      }}
                    >
                      {v || ""}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className={`mt-2 text-xs ${hc ? "text-on-raised" : "text-on-raised-muted"}`}>{readout}</p>
    </div>
  );
}
