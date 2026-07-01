// Dashboard analytics — the "distribution" views the Sankey (flow) doesn't show. Convergent picks from the
// literature + BIDS cde-atlas + Krishnamurthy sweeps, all derived from the UIRecord contract (no backend):
//   1. Coverage-by-cohort table (CDEMapper/DIVER coverage-rate idiom)
//   2. Concepts by size-tier × verdict (cde-atlas OverlapView)
//   3. Retrieval-score histogram stacked by verdict (Semantic Search Helper cosine dist)
//   4. Cross-cohort overlap heatmap (concept co-occurrence per cohort pair)
import { useMemo } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { UIRecord } from "@/types";

const VERDICTS = ["adopt", "refine", "novel", "unclassified"] as const;
const VCOLOR: Record<string, string> = {
  adopt: "#005B33",
  refine: "#B45309",
  novel: "#113682",
  unclassified: "#8892A3",
};

function cohortOf(member: string, fallback: string): string {
  const i = member.indexOf(":");
  return i > 0 ? member.slice(0, i) : fallback;
}
type Verdict = (typeof VERDICTS)[number];
function vkey(r: UIRecord): Verdict {
  return VERDICTS.includes(r.verdict as Verdict) ? (r.verdict as Verdict) : "unclassified";
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

function StackedVerdictBars({ data, height = 200 }: { data: Record<string, string | number>[]; height?: number }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 4, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#E3E7EE" vertical={false} />
        <XAxis dataKey="name" tick={{ fontSize: 11 }} />
        <YAxis allowDecimals={false} tick={{ fontSize: 11 }} width={28} />
        <RTooltip />
        {VERDICTS.map((v) => (
          <Bar key={v} dataKey={v} stackId="s" fill={VCOLOR[v]} radius={v === "unclassified" ? [3, 3, 0, 0] : undefined} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

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
                  <TableCell className="font-medium text-neutral-800">{r.cohort}</TableCell>
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
            <StackedVerdictBars data={sizeBars} />
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
            <StackedVerdictBars data={hist} />
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
          <p className="mt-2 text-xs text-neutral-400">concepts shared between each cohort pair (diagonal = total)</p>
        </CardContent>
      </Card>
    </div>
  );
}

function OverlapHeatmap({ cohorts, matrix, max }: { cohorts: string[]; matrix: number[][]; max: number }) {
  return (
    <div className="overflow-x-auto">
      <table className="border-collapse text-xs tabular-nums">
        <thead>
          <tr>
            <th className="p-1" />
            {cohorts.map((c) => (
              <th key={c} className="max-w-[64px] truncate p-1 text-neutral-500" title={c}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {cohorts.map((rc, i) => (
            <tr key={rc}>
              <td className="max-w-[100px] truncate p-1 pr-2 text-right font-medium text-neutral-600" title={rc}>
                {rc}
              </td>
              {cohorts.map((cc, j) => {
                const v = matrix[i][j];
                const alpha = i === j ? 0.12 : v / max;
                return (
                  <td
                    key={cc}
                    className="h-8 w-12 border border-white text-center"
                    style={{
                      backgroundColor: `rgba(17, 54, 130, ${Math.max(v ? 0.08 : 0, alpha)})`,
                      color: alpha > 0.5 ? "#fff" : "#2A3142",
                    }}
                    title={`${rc} ∩ ${cc}: ${v}`}
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
  );
}
