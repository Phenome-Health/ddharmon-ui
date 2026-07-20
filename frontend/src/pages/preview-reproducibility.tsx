// PREVIEW / MOCKUP — "Reproducibility metrics" (roadmap: Evaluation & review, Planned).
// How the LLM portions of ddharmon vary run-to-run and across providers/models — scored by the external
// benchmarks AND internal expert review — plus the cost and time each choice implies, so a user can pick
// where to sit on the performance / cost / time frontier. All numbers are ILLUSTRATIVE sample data from a
// reproducibility experiment; no run, no backend, no LLM call.
import { useState } from "react";
import { Clock, DollarSign } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PreviewShell } from "@/components/preview-shell";

interface MeanSd {
  mean: number;
  sd: number; // run-to-run spread (repeat runs, same config)
}
interface Model {
  id: string;
  label: string;
  cvar: string; // CSS var for the series color (validated categorical, flips light/dark)
  cdemapper: MeanSd;
  aireadi: MeanSd;
  athlos: MeanSd;
  expert: MeanSd; // agreement with the locked expert-review (EITL) verdict set
  cost: number; // $ per run
  time: MeanSd; // minutes per run (batch-queue variance → the sd)
}

// Illustrative reproducibility experiment: 5 provider/model choices, each run repeatedly.
const MODELS: Model[] = [
  { id: "opus", label: "Claude Opus", cvar: "--rmv-1", cdemapper: { mean: 0.64, sd: 0.01 }, aireadi: { mean: 0.66, sd: 0.01 }, athlos: { mean: 0.875, sd: 0.008 }, expert: { mean: 0.94, sd: 0.015 }, cost: 2.4, time: { mean: 6.5, sd: 2.5 } },
  { id: "sonnet", label: "Claude Sonnet", cvar: "--rmv-2", cdemapper: { mean: 0.63, sd: 0.012 }, aireadi: { mean: 0.655, sd: 0.014 }, athlos: { mean: 0.869, sd: 0.01 }, expert: { mean: 0.93, sd: 0.02 }, cost: 1.1, time: { mean: 5.0, sd: 2.0 } },
  { id: "gpt", label: "GPT-5", cvar: "--rmv-3", cdemapper: { mean: 0.615, sd: 0.02 }, aireadi: { mean: 0.64, sd: 0.018 }, athlos: { mean: 0.855, sd: 0.018 }, expert: { mean: 0.915, sd: 0.03 }, cost: 1.55, time: { mean: 5.5, sd: 2.5 } },
  { id: "gemini", label: "Gemini 2.5", cvar: "--rmv-4", cdemapper: { mean: 0.6, sd: 0.02 }, aireadi: { mean: 0.63, sd: 0.02 }, athlos: { mean: 0.845, sd: 0.02 }, expert: { mean: 0.9, sd: 0.03 }, cost: 0.85, time: { mean: 4.5, sd: 2.0 } },
  { id: "llama", label: "Llama (local)", cvar: "--rmv-5", cdemapper: { mean: 0.55, sd: 0.03 }, aireadi: { mean: 0.585, sd: 0.03 }, athlos: { mean: 0.805, sd: 0.028 }, expert: { mean: 0.865, sd: 0.04 }, cost: 0.06, time: { mean: 12.0, sd: 3.0 } },
];

const METRICS: { id: "cdemapper" | "aireadi" | "athlos" | "expert"; label: string }[] = [
  { id: "cdemapper", label: "CDEMapper recall@5" },
  { id: "aireadi", label: "AI-READI recall@5" },
  { id: "athlos", label: "ATHLOS recode acc." },
  { id: "expert", label: "Expert-review agreement" },
];

const benchComposite = (m: Model): MeanSd => ({
  mean: (m.cdemapper.mean + m.aireadi.mean + m.athlos.mean) / 3,
  sd: (m.cdemapper.sd + m.aireadi.sd + m.athlos.sd) / 3,
});

// Deterministic per-run jitter (no RNG → stable render): 8 repeat runs, offsets in [-1, 1].
const JITTER = [-0.85, 0.6, -0.35, 0.9, -0.7, 0.2, 0.45, -0.15];

function Legend() {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs">
      {MODELS.map((m) => (
        <span key={m.id} className="inline-flex items-center gap-1.5 text-neutral-600">
          <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: `var(${m.cvar})` }} />
          {m.label}
        </span>
      ))}
    </div>
  );
}

// ── Card 1: quality vs cost/time scatter ─────────────────────────────────────────────────────────
function TradeoffScatter() {
  const [xKey, setXKey] = useState<"cost" | "time">("cost");
  const [yKey, setYKey] = useState<"expert" | "benchmark">("expert");
  const W = 660, H = 300, L = 52, R = 150, T = 18, B = 44;
  const xDom = xKey === "cost" ? [0, 2.8] : [0, 16];
  // Fit the y-domain to the selected metric so the model separation + run-to-run bars fill the plot.
  const yDom = yKey === "expert" ? [0.82, 0.98] : [0.5, 0.78];
  const sx = (v: number) => L + ((v - xDom[0]) / (xDom[1] - xDom[0])) * (W - L - R);
  const sy = (v: number) => T + (1 - (v - yDom[0]) / (yDom[1] - yDom[0])) * (H - T - B);
  const yOf = (m: Model): MeanSd => (yKey === "expert" ? m.expert : benchComposite(m));
  const xOf = (m: Model) => (xKey === "cost" ? m.cost : m.time.mean);
  const xTicks = xKey === "cost" ? [0, 0.5, 1, 1.5, 2, 2.5] : [0, 4, 8, 12, 16];
  const yTicks = yKey === "expert" ? [0.85, 0.9, 0.95] : [0.55, 0.65, 0.75];
  const seg = (on: boolean) => (on ? "bg-ph-navy/10 font-medium text-ph-navy" : "text-neutral-500");

  return (
    <Card>
      <CardHeader className="gap-2 pb-3">
        <CardTitle className="text-base">Pick your tradeoff — quality vs. {xKey === "cost" ? "cost" : "time"}</CardTitle>
        <p className="text-xs text-neutral-400">
          Each provider/model as one choice; the vertical bar is the run-to-run spread over repeat runs. Up and
          to the left is better value. Toggle the axes to optimize for what you care about.
        </p>
        <div className="flex flex-wrap gap-2 text-sm">
          <div className="inline-flex rounded-md border border-neutral-200 p-0.5">
            <button onClick={() => setYKey("expert")} className={`rounded px-2.5 py-1 ${seg(yKey === "expert")}`}>Expert review</button>
            <button onClick={() => setYKey("benchmark")} className={`rounded px-2.5 py-1 ${seg(yKey === "benchmark")}`}>Benchmark score</button>
          </div>
          <div className="inline-flex rounded-md border border-neutral-200 p-0.5">
            <button onClick={() => setXKey("cost")} className={`rounded px-2.5 py-1 ${seg(xKey === "cost")}`}>Cost / run</button>
            <button onClick={() => setXKey("time")} className={`rounded px-2.5 py-1 ${seg(xKey === "time")}`}>Time / run</button>
          </div>
        </div>
        <Legend />
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <svg viewBox={`0 0 ${W} ${H}`} className="w-full min-w-[540px]" role="img" aria-label="Performance versus cost or time by model">
            {/* grid + axes */}
            {yTicks.map((t) => (
              <g key={t}>
                <line x1={L} y1={sy(t)} x2={W - R} y2={sy(t)} stroke="currentColor" className="text-neutral-200" strokeWidth={1} />
                <text x={L - 8} y={sy(t) + 3} textAnchor="end" className="fill-neutral-400 text-[10px] tabular-nums">{t.toFixed(2)}</text>
              </g>
            ))}
            {xTicks.map((t) => (
              <text key={t} x={sx(t)} y={H - B + 16} textAnchor="middle" className="fill-neutral-400 text-[10px] tabular-nums">
                {xKey === "cost" ? `$${t}` : `${t}m`}
              </text>
            ))}
            <text x={(L + W - R) / 2} y={H - 6} textAnchor="middle" className="fill-neutral-500 text-[11px]">
              {xKey === "cost" ? "Cost per run (USD)" : "Wall-clock per run (min)"}
            </text>
            <text x={14} y={T + 4} className="fill-neutral-500 text-[11px]">{yKey === "expert" ? "Expert agreement" : "Benchmark score"}</text>
            {/* points */}
            {MODELS.map((m) => {
              const y = yOf(m);
              const cx = sx(xOf(m));
              return (
                <g key={m.id} style={{ color: `var(${m.cvar})` }}>
                  <line x1={cx} y1={sy(y.mean - y.sd)} x2={cx} y2={sy(y.mean + y.sd)} stroke="currentColor" strokeWidth={2} />
                  <circle cx={cx} cy={sy(y.mean)} r={5.5} fill="currentColor" stroke="var(--card)" strokeWidth={1.5} />
                  <text x={cx + 9} y={sy(y.mean) + 3} className="fill-neutral-600 text-[10px]">{m.label}</text>
                </g>
              );
            })}
          </svg>
        </div>
        <p className="mt-1 text-xs text-neutral-400">
          e.g. Claude Opus tops quality but costs most; Gemini/Sonnet sit on a strong value frontier; the local
          model is near-free but lower and slower, with the widest run-to-run spread.
        </p>
      </CardContent>
    </Card>
  );
}

// ── Card 2: per-metric performance across models (benchmarks + expert), with run-to-run error bars ──
function MetricDots() {
  const W = 660, L = 176, R = 20, ROW = 46, TOP = 10;
  const xDom = [0.5, 1.0];
  const sx = (v: number) => L + ((v - xDom[0]) / (xDom[1] - xDom[0])) * (W - L - R);
  const H = METRICS.length * ROW + TOP + 24;
  const xTicks = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
  return (
    <Card>
      <CardHeader className="gap-2 pb-3">
        <CardTitle className="text-base">Performance by benchmark &amp; expert review</CardTitle>
        <p className="text-xs text-neutral-400">Per-metric score for each model; the bar is the run-to-run spread. Expert-review agreement is the internal locked human gate.</p>
        <Legend />
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <svg viewBox={`0 0 ${W} ${H}`} className="w-full min-w-[540px]" role="img" aria-label="Per-metric performance by model">
            {xTicks.map((t) => (
              <g key={t}>
                <line x1={sx(t)} y1={TOP} x2={sx(t)} y2={H - 20} stroke="currentColor" className="text-neutral-200" strokeWidth={1} />
                <text x={sx(t)} y={H - 6} textAnchor="middle" className="fill-neutral-400 text-[10px] tabular-nums">{t.toFixed(1)}</text>
              </g>
            ))}
            {METRICS.map((metric, mi) => {
              const yBase = TOP + mi * ROW + ROW / 2;
              return (
                <g key={metric.id}>
                  <text x={8} y={yBase + 3} className="fill-neutral-600 text-[11px] font-medium">{metric.label}</text>
                  {MODELS.map((m, i) => {
                    const d = m[metric.id];
                    const y = yBase + (i - 2) * 6; // fan the 5 models vertically so bars don't overlap
                    return (
                      <g key={m.id} style={{ color: `var(${m.cvar})` }}>
                        <line x1={sx(d.mean - d.sd)} y1={y} x2={sx(d.mean + d.sd)} y2={y} stroke="currentColor" strokeWidth={1.5} />
                        <circle cx={sx(d.mean)} cy={y} r={4} fill="currentColor" stroke="var(--card)" strokeWidth={1} />
                      </g>
                    );
                  })}
                </g>
              );
            })}
          </svg>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Card 3: run-to-run stability for one model ──────────────────────────────────────────────────
function Stability() {
  const [sel, setSel] = useState("sonnet");
  const m = MODELS.find((x) => x.id === sel)!;
  const W = 660, L = 176, R = 64, ROW = 40, TOP = 10;
  const xDom = [0.5, 1.0];
  const sx = (v: number) => L + ((v - xDom[0]) / (xDom[1] - xDom[0])) * (W - L - R);
  const H = METRICS.length * ROW + TOP + 8;
  return (
    <Card>
      <CardHeader className="gap-2 pb-3">
        <CardTitle className="text-base">Run-to-run stability</CardTitle>
        <p className="text-xs text-neutral-400">Eight repeat runs of one model, same config — how much each score wanders between identical runs.</p>
        <div className="flex flex-wrap gap-1.5">
          {MODELS.map((x) => (
            <button
              key={x.id}
              onClick={() => setSel(x.id)}
              className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs ${
                sel === x.id ? "border-ph-navy/40 bg-ph-navy/5 text-ph-navy" : "border-neutral-200 text-neutral-500"
              }`}
            >
              <span className="inline-block h-2 w-2 rounded-full" style={{ background: `var(${x.cvar})` }} />
              {x.label}
            </button>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <svg viewBox={`0 0 ${W} ${H}`} className="w-full min-w-[540px]" role="img" aria-label={`Run-to-run spread for ${m.label}`}>
            {[0.5, 0.6, 0.7, 0.8, 0.9, 1.0].map((t) => (
              <line key={t} x1={sx(t)} y1={TOP} x2={sx(t)} y2={H - 6} stroke="currentColor" className="text-neutral-100" strokeWidth={1} />
            ))}
            {METRICS.map((metric, mi) => {
              const d = m[metric.id];
              const y = TOP + mi * ROW + ROW / 2;
              const cv = ((d.sd / d.mean) * 100).toFixed(1);
              return (
                <g key={metric.id} style={{ color: `var(${m.cvar})` }}>
                  <text x={8} y={y + 3} className="fill-neutral-600 text-[11px] font-medium">{metric.label}</text>
                  {JITTER.map((j, k) => (
                    <circle key={k} cx={sx(d.mean + j * d.sd)} cy={y} r={3.5} fill="currentColor" fillOpacity={0.5} />
                  ))}
                  <line x1={sx(d.mean)} y1={y - 9} x2={sx(d.mean)} y2={y + 9} stroke="currentColor" strokeWidth={2} />
                  <text x={W - R + 8} y={y + 3} className="fill-neutral-500 text-[10px] tabular-nums">
                    ±{d.sd.toFixed(3)} · CV {cv}%
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
        <div className="mt-2 flex flex-wrap gap-4 text-xs text-neutral-500">
          <span className="inline-flex items-center gap-1.5"><DollarSign className="h-3.5 w-3.5" /> ~${m.cost.toFixed(2)} / run <span className="text-neutral-400">(stable)</span></span>
          <span className="inline-flex items-center gap-1.5"><Clock className="h-3.5 w-3.5" /> {m.time.mean.toFixed(0)} ± {m.time.sd.toFixed(0)} min / run <span className="text-neutral-400">(batch-queue variance)</span></span>
        </div>
      </CardContent>
    </Card>
  );
}

export default function PreviewReproducibilityPage() {
  return (
    <PreviewShell
      title="Reproducibility metrics"
      intro="The LLM stages of ddharmon are stochastic and provider-dependent. This is how we would report the variation — run-to-run and across providers/models, scored by the external benchmarks and internal expert review — alongside cost and time, so you can choose where to sit on the performance / cost / time frontier."
    >
      <TradeoffScatter />
      <MetricDots />
      <Stability />
      <p className="text-xs text-neutral-400">
        In the real feature, these come from a reproducibility experiment: each provider/model is run K times on
        the benchmark and expert-review sets; we report means, run-to-run spread, and cross-model agreement, plus
        realized cost and wall-clock. The numbers here are illustrative sample data, not measured results.
      </p>
    </PreviewShell>
  );
}
