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
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  CHART_AXIS,
  CHART_GRID,
  CHART_TOOLTIP_CLASS,
  isVerdict,
  VERDICT_COLOR,
  VERDICT_LABEL,
  VERDICTS,
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
function coverageByCohort(records: UIRecord[]): CohortRow[] {
  const acc = new Map<string, { total: number; assigned: number; novel: number }>();
  for (const r of records) {
    const v = vkey(r);
    const members = r.members.length ? r.members : r.cohorts.map((c) => `${c}:`);
    for (const m of members) {
      const c = cohortOf(m, r.cohorts[0] ?? "unknown");
      const row = acc.get(c) ?? { total: 0, assigned: 0, novel: 0 };
      row.total += 1;
      if (v === "adopt" || v === "refine") row.assigned += 1;
      else if (v === "novel") row.novel += 1;
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
const TIER_ORDER = ["≥5", "4", "3", "2", "1"];
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

// ── 3. retrieval-score histogram (top1 cosine) stacked by verdict ─
function scoreHistogram(records: UIRecord[]) {
  const bins = Array.from({ length: 10 }, (_, i) => ({
    name: `${(i / 10).toFixed(1)}`,
    adopt: 0,
    refine: 0,
    novel: 0,
    unclassified: 0,
  }));
  let any = false;
  for (const r of records) {
    const c = r.cosines.top1;
    if (c == null) continue;
    any = true;
    const b = Math.min(9, Math.max(0, Math.floor(c * 10)));
    bins[b][vkey(r)] += 1;
  }
  return any ? bins : [];
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

// ── branded tooltip for the stacked bars ─────────────────────────
interface BarTipItem {
  dataKey?: string | number;
  value?: number;
  color?: string;
}
function makeBarTooltip(formatLabel: (name: string) => string) {
  return function BarTooltip({
    active,
    payload,
    label,
  }: {
    active?: boolean;
    payload?: BarTipItem[];
    label?: string | number;
  }) {
    if (!active || !payload?.length) return null;
    const rows = payload.filter((p) => (p.value ?? 0) > 0);
    if (!rows.length) return null;
    const total = payload.reduce((s, p) => s + (p.value ?? 0), 0);
    return (
      <div className={CHART_TOOLTIP_CLASS}>
        <div className="mb-1 font-medium text-neutral-700">{formatLabel(String(label))}</div>
        {rows.map((p) => (
          <div key={String(p.dataKey)} className="flex items-center justify-between gap-4">
            <span className="flex items-center gap-1.5 text-neutral-600">
              <span className="inline-block h-2 w-2 rounded-sm" style={{ backgroundColor: p.color }} />
              {VERDICT_LABEL[String(p.dataKey)] ?? String(p.dataKey)}
            </span>
            <span className="tabular-nums text-neutral-600">{p.value}</span>
          </div>
        ))}
        <div className="mt-1 flex items-center justify-between gap-4 border-t border-neutral-100 pt-1 text-neutral-500">
          <span>Total</span>
          <span className="tabular-nums">{total}</span>
        </div>
      </div>
    );
  };
}

function StackedVerdictBars({
  data,
  formatLabel,
  height = 224,
}: {
  data: Record<string, string | number>[];
  formatLabel: (name: string) => string;
  height?: number;
}) {
  const BarTooltip = useMemo(() => makeBarTooltip(formatLabel), [formatLabel]);
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 4, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} vertical={false} />
        <XAxis dataKey="name" tick={{ fontSize: 11, fill: CHART_AXIS }} />
        <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: CHART_AXIS }} width={28} />
        <RTooltip content={<BarTooltip />} cursor={{ fill: "var(--sf-100)" }} />
        <Legend
          iconType="square"
          iconSize={9}
          formatter={(v: string) => <span className="text-neutral-500">{VERDICT_LABEL[v] ?? v}</span>}
          wrapperStyle={{ fontSize: 11 }}
        />
        {VERDICTS.map((v) => (
          <Bar key={v} dataKey={v} stackId="s" fill={VERDICT_COLOR[v]} radius={v === "unclassified" ? [3, 3, 0, 0] : undefined} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

const sizeLabel = (t: string) => `${t} field${t === "1" ? "" : "s"} per concept`;
const binLabel = (b: string) => {
  const lo = Number(b);
  return `cosine ${lo.toFixed(1)}–${(lo + 0.1).toFixed(1)}`;
};

export function Analytics({ records }: { records: UIRecord[] }) {
  const cohortRows = useMemo(() => coverageByCohort(records), [records]);
  const sizeBars = useMemo(() => sizeVerdictBars(records), [records]);
  const hist = useMemo(() => scoreHistogram(records), [records]);
  const overlap = useMemo(() => cohortOverlap(records), [records]);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Coverage by cohort</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Cohort</TableHead>
                <TableHead className="text-right">Fields</TableHead>
                <TableHead className="text-right">Assigned</TableHead>
                <TableHead className="text-right">Novel</TableHead>
                <TableHead className="text-right">Coverage</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {cohortRows.map((r) => (
                <TableRow key={r.cohort}>
                  <TableCell className="font-medium text-neutral-700">{r.cohort}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.total}</TableCell>
                  <TableCell className="text-right tabular-nums text-success">{r.assigned}</TableCell>
                  <TableCell className="text-right tabular-nums text-ph-navy">{r.novel}</TableCell>
                  <TableCell className="text-right tabular-nums font-medium">{(r.coverage * 100).toFixed(0)}%</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Concepts by size × verdict</CardTitle>
        </CardHeader>
        <CardContent>
          {sizeBars.length ? (
            <StackedVerdictBars data={sizeBars} formatLabel={sizeLabel} />
          ) : (
            <p className="py-8 text-center text-sm text-neutral-400">No concepts.</p>
          )}
          <p className="mt-1 text-xs text-neutral-400">x = fields pooled per concept · bars stacked by verdict</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Retrieval score distribution</CardTitle>
        </CardHeader>
        <CardContent>
          {hist.length ? (
            <StackedVerdictBars data={hist} formatLabel={binLabel} />
          ) : (
            <p className="py-8 text-center text-sm text-neutral-400">No retrieval scores.</p>
          )}
          <p className="mt-1 text-xs text-neutral-400">
            nearest-CDE cosine (binned) · adopts cluster high, novels low
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Cross-cohort overlap</CardTitle>
        </CardHeader>
        <CardContent>
          {overlap.cohorts.length ? (
            <OverlapHeatmap {...overlap} />
          ) : (
            <p className="py-8 text-center text-sm text-neutral-400">No cohorts.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function OverlapHeatmap({ cohorts, matrix, max }: { cohorts: string[]; matrix: number[][]; max: number }) {
  const [hc, setHc] = useState<{ i: number; j: number } | null>(null);
  const readout = hc
    ? hc.i === hc.j
      ? `${cohorts[hc.i]} — ${matrix[hc.i][hc.j]} concepts total`
      : `${cohorts[hc.i]} ∩ ${cohorts[hc.j]} — ${matrix[hc.i][hc.j]} shared concept${matrix[hc.i][hc.j] === 1 ? "" : "s"}`
    : "concepts shared between each cohort pair (diagonal = total)";
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
                  className={`max-w-[64px] truncate p-1 ${hc?.j === j ? "font-semibold text-ph-navy" : "text-neutral-500"}`}
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
                  className={`max-w-[100px] truncate p-1 pr-2 text-right font-medium ${hc?.i === i ? "text-ph-navy" : "text-neutral-600"}`}
                  title={rc}
                >
                  {rc}
                </td>
                {cohorts.map((cc, j) => {
                  const v = matrix[i][j];
                  const alpha = i === j ? 0.12 : v / max;
                  const inCross = hc && (hc.i === i || hc.j === j);
                  const isCell = hc?.i === i && hc?.j === j;
                  return (
                    <td
                      key={cc}
                      onMouseEnter={() => setHc({ i, j })}
                      className="h-8 w-12 border text-center transition-colors"
                      style={{
                        backgroundColor: `rgba(17, 54, 130, ${Math.max(v ? 0.08 : 0, alpha)})`,
                        color: alpha > 0.5 ? "#fff" : "var(--sf-700)",
                        borderColor: isCell ? "var(--navy)" : inCross ? "var(--sf-300)" : "var(--sf-0)",
                        outline: isCell ? "1px solid var(--navy)" : "none",
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
      <p className={`mt-2 text-xs ${hc ? "font-medium text-neutral-600" : "text-neutral-400"}`}>{readout}</p>
    </div>
  );
}
