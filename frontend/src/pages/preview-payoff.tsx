// PREVIEW / MOCKUP — "Quantify the payoff of harmonization" (roadmap: Analysis & impact, Exploring).
// Shows the classic before/after: a hypothesis that is underpowered in one cohort, then reaches
// significance once ddharmon harmonizes the exposure + outcome across cohorts and the effective N rises.
// All numbers are ILLUSTRATIVE sample data — ddharmon is metadata-only; the real stats run outside it.
import { useState } from "react";
import { Users, TrendingUp, Check, X } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PreviewShell } from "@/components/preview-shell";

interface Row {
  label: string;
  n: number;
  est: number;
  lo: number;
  hi: number;
}

// Illustrative sample effect estimates (standardized) for a single exposure→outcome association.
const COHORTS: Row[] = [
  { label: "All of Us", n: 1180, est: 0.17, lo: -0.06, hi: 0.4 },
  { label: "CLSA", n: 940, est: 0.21, lo: -0.03, hi: 0.45 },
  { label: "UK Biobank", n: 5200, est: 0.15, lo: -0.01, hi: 0.31 },
  { label: "MESA", n: 760, est: 0.24, lo: -0.05, hi: 0.53 },
  { label: "AI-READI", n: 410, est: 0.19, lo: -0.13, hi: 0.51 },
];
const POOLED: Row = { label: "Pooled (harmonized)", n: 8490, est: 0.18, lo: 0.1, hi: 0.26 };
const SINGLE: Row = { label: "Your cohort alone", n: 760, est: 0.24, lo: -0.05, hi: 0.53 };

// x-domain for the plot (standardized effect).
const XMIN = -0.2;
const XMAX = 0.6;
const PLOT_L = 168;
const PLOT_R = 512;
const VAL_X = 656;
const ROW_H = 34;
const scale = (v: number) => PLOT_L + ((v - XMIN) / (XMAX - XMIN)) * (PLOT_R - PLOT_L);
const sig = (r: Row) => r.lo > 0 || r.hi < 0; // CI excludes the null → "significant" in this mock
const fmt = (r: Row) => `${r.est.toFixed(2)} [${r.lo.toFixed(2)}, ${r.hi.toFixed(2)}]`;

function Forest({ rows, pooled }: { rows: Row[]; pooled?: Row }) {
  const all = pooled ? [...rows, pooled] : rows;
  const height = all.length * ROW_H + 44;
  const ticks = [-0.2, 0, 0.2, 0.4, 0.6];
  return (
    <svg viewBox={`0 0 800 ${height}`} className="w-full" role="img" aria-label="Forest plot of effect estimates">
      {/* null line */}
      <line x1={scale(0)} y1={14} x2={scale(0)} y2={all.length * ROW_H + 8} stroke="currentColor" className="text-neutral-300" strokeDasharray="4 3" />
      <text x={scale(0)} y={all.length * ROW_H + 30} textAnchor="middle" className="fill-neutral-400 text-[10px]">no effect</text>
      {/* axis ticks */}
      {ticks.map((t) => (
        <text key={t} x={scale(t)} y={all.length * ROW_H + 42} textAnchor="middle" className="fill-neutral-400 text-[10px] tabular-nums">
          {t}
        </text>
      ))}
      {all.map((r, i) => {
        const y = i * ROW_H + ROW_H / 2 + 6;
        const isPooled = pooled && i === all.length - 1;
        const significant = sig(r);
        const cls = isPooled ? "text-ph-navy" : significant ? "text-success" : "text-neutral-400";
        const w = Math.max(5, Math.min(13, Math.sqrt(r.n) / 6)); // marker size ∝ √n (study weight)
        return (
          <g key={r.label} className={cls}>
            <text x={8} y={y - 3} className="fill-neutral-600 text-[11px] font-medium">{r.label}</text>
            <text x={8} y={y + 10} className="fill-neutral-400 text-[10px] tabular-nums">n = {r.n.toLocaleString()}</text>
            {/* CI */}
            <line x1={scale(r.lo)} y1={y} x2={scale(r.hi)} y2={y} stroke="currentColor" strokeWidth={isPooled ? 2 : 1.5} />
            <line x1={scale(r.lo)} y1={y - 3} x2={scale(r.lo)} y2={y + 3} stroke="currentColor" strokeWidth={1.5} />
            <line x1={scale(r.hi)} y1={y - 3} x2={scale(r.hi)} y2={y + 3} stroke="currentColor" strokeWidth={1.5} />
            {/* marker */}
            {isPooled ? (
              <path
                d={`M ${scale(r.est)} ${y - 7} L ${scale(r.est) + 8} ${y} L ${scale(r.est)} ${y + 7} L ${scale(r.est) - 8} ${y} Z`}
                fill="currentColor"
              />
            ) : (
              <rect x={scale(r.est) - w / 2} y={y - w / 2} width={w} height={w} fill="currentColor" />
            )}
            {/* value */}
            <text x={VAL_X} y={y + 3} textAnchor="start" className="fill-neutral-600 text-[10px] tabular-nums">{fmt(r)}</text>
          </g>
        );
      })}
    </svg>
  );
}

function PowerBar({ value }: { value: number }) {
  return (
    <div className="flex items-center gap-2">
      <div className="h-2 w-28 overflow-hidden rounded-full bg-neutral-200">
        <div className={`h-full rounded-full ${value >= 0.8 ? "bg-success" : "bg-warning"}`} style={{ width: `${value * 100}%` }} />
      </div>
      <span className="tabular-nums text-xs text-neutral-600">{Math.round(value * 100)}%</span>
    </div>
  );
}

export default function PreviewPayoffPage() {
  const [pooled, setPooled] = useState(true);
  const view = pooled
    ? { rows: COHORTS, pooledRow: POOLED, N: POOLED.n, effect: POOLED, power: 0.91, p: "p < 0.001", cohorts: 5 }
    : { rows: [SINGLE], pooledRow: undefined, N: SINGLE.n, effect: SINGLE, power: 0.15, p: "p = 0.11", cohorts: 1 };
  const significant = sig(view.effect);

  return (
    <PreviewShell
      title="Quantify the payoff of harmonization"
      intro="The before/after that motivates harmonizing at all: an association that a single cohort can't resolve, surfaced once the exposure and outcome are harmonized across cohorts and the effective sample size rises."
    >
      {/* Illustrative hypothesis + the toggle that tells the story. */}
      <Card>
        <CardHeader className="gap-2">
          <CardTitle className="text-base">Association of a questionnaire exposure with an outcome</CardTitle>
          <p className="text-xs text-neutral-400">
            Illustrative hypothesis over sample data. ddharmon produces the harmonized crosswalk (which variable
            in each cohort measures the exposure and the outcome); the regression runs outside, on your data.
          </p>
          <div className="mt-1 inline-flex rounded-md border border-neutral-200 p-0.5 text-sm">
            <button
              onClick={() => setPooled(false)}
              className={`rounded px-3 py-1 ${!pooled ? "bg-neutral-100 font-medium text-ph-ink" : "text-neutral-500"}`}
            >
              Single cohort
            </button>
            <button
              onClick={() => setPooled(true)}
              className={`rounded px-3 py-1 ${pooled ? "bg-ph-navy/10 font-medium text-ph-navy" : "text-neutral-500"}`}
            >
              Harmonized (pooled)
            </button>
          </div>
        </CardHeader>
        <CardContent className="grid gap-5 lg:grid-cols-[1fr_260px]">
          {/* Forest plot */}
          <div className="min-w-0 overflow-x-auto rounded-md border border-neutral-100 p-3">
            <Forest rows={view.rows} pooled={view.pooledRow} />
          </div>
          {/* Stat summary */}
          <div className="space-y-3">
            <div className="rounded-md border border-neutral-200 p-3">
              <div className="flex items-center gap-1.5 text-xs text-neutral-400">
                <Users className="h-3.5 w-3.5" /> Effective sample size
              </div>
              <div className="mt-0.5 font-mono text-2xl font-semibold text-ph-ink tabular-nums">
                {view.N.toLocaleString()}
              </div>
              <div className="text-xs text-neutral-400">{view.cohorts} cohort{view.cohorts === 1 ? "" : "s"}</div>
            </div>
            <div className="rounded-md border border-neutral-200 p-3 text-sm">
              <div className="flex items-center gap-1.5 text-xs text-neutral-400">
                <TrendingUp className="h-3.5 w-3.5" /> Pooled effect (95% CI)
              </div>
              <div className="mt-0.5 font-mono text-neutral-700 tabular-nums">{fmt(view.effect)}</div>
              <div className="mt-1 text-xs text-neutral-500">{view.p}</div>
            </div>
            <div className="rounded-md border border-neutral-200 p-3">
              <div className="mb-1 text-xs text-neutral-400">Statistical power</div>
              <PowerBar value={view.power} />
            </div>
            <div
              className={`flex items-center gap-2 rounded-md px-3 py-2 text-sm ${
                significant ? "bg-success-bg text-neutral-700" : "bg-warning-bg text-neutral-700"
              }`}
            >
              {significant ? <Check className="h-4 w-4 text-success" /> : <X className="h-4 w-4 text-warning" />}
              <span>
                {significant ? "Crosses significance" : "Inconclusive — CI includes no-effect"}
              </span>
            </div>
          </div>
        </CardContent>
      </Card>

      <p className="text-xs text-neutral-400">
        In the real feature, you would pick a harmonized concept from your run; ddharmon hands off a clean
        harmonized-variable spec; the pre/post regression + power calculation run on your data (securely, or on
        a synthetic testbed for a fully public version). The numbers above are illustrative, not from a real
        analysis.
      </p>
    </PreviewShell>
  );
}
