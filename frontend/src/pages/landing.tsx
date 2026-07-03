import { useEffect, useState } from "react";
import { Link } from "wouter";
import { ArrowRight, GitCompareArrows, Layers, UserCheck } from "lucide-react";
import { Button } from "@/components/ui/button";

// ── The signature visual: many differently-named variables from different cohorts
// converge along connectors and anchor to one shared CDE. Meaning, not wording — shown.
const CHIP_R = 38; // orbit radius in the 100×100 viewBox
const LINE_IN = 16; // connector starts just outside the anchor disc
const LINE_OUT = 33; // …and stops just short of the chip

// Ordered so the longest names sit top/bottom (most horizontal room), short ones at the sides.
const FIELDS = ["body_mass_index", "2178", "BMI_v2", "Q47_weight_kg", "body.mass.idx", "bmi"];

const NODES = FIELDS.map((label, i) => {
  const a = ((-90 + i * 60) * Math.PI) / 180;
  return {
    label,
    x: 50 + CHIP_R * Math.cos(a),
    y: 50 + CHIP_R * Math.sin(a),
    lx1: 50 + LINE_IN * Math.cos(a),
    ly1: 50 + LINE_IN * Math.sin(a),
    lx2: 50 + LINE_OUT * Math.cos(a),
    ly2: 50 + LINE_OUT * Math.sin(a),
    // outward nudge (px) for the pre-convergence scattered state
    dx: 34 * Math.cos(a),
    dy: 34 * Math.sin(a),
  };
});

function ConvergenceViz() {
  const [shown, setShown] = useState(false);
  const [animate, setAnimate] = useState(true);

  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      setAnimate(false);
      setShown(true);
      return;
    }
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setShown(true)));
    return () => cancelAnimationFrame(id);
  }, []);

  return (
    <div className="mx-auto aspect-square w-full max-w-[400px]">
      <div className="relative h-full w-full">
        <svg viewBox="0 0 100 100" className="absolute inset-0 h-full w-full" aria-hidden="true">
          {/* connectors — draw inward as the variables resolve */}
          {NODES.map((n, i) => {
            const len = Math.hypot(n.lx2 - n.lx1, n.ly2 - n.ly1);
            return (
              <line
                key={n.label}
                x1={n.lx1}
                y1={n.ly1}
                x2={n.lx2}
                y2={n.ly2}
                stroke="#3AC2CB"
                strokeWidth={0.4}
                strokeLinecap="round"
                style={{
                  strokeDasharray: len,
                  strokeDashoffset: shown ? 0 : len,
                  opacity: shown ? 0.55 : 0,
                  transition: animate ? `stroke-dashoffset .7s ease ${0.15 + i * 0.09}s, opacity .5s ${0.15 + i * 0.09}s` : "none",
                }}
              />
            );
          })}
          {/* circos ring — the brand's three arcs, slowly turning */}
          <g className="ddh-ring-spin" style={{ transformBox: "view-box", transformOrigin: "50% 50%", animation: "ddh-ring-spin 60s linear infinite" }}>
            <circle cx="50" cy="50" r="24" fill="none" stroke="#E21C52" strokeWidth="0.7" strokeLinecap="round" strokeDasharray="108 151" />
            <circle cx="50" cy="50" r="19" fill="none" stroke="#FFFFFF" strokeWidth="0.7" strokeLinecap="round" strokeDasharray="72 120" transform="rotate(80 50 50)" opacity="0.75" />
            <circle cx="50" cy="50" r="14" fill="none" stroke="#3AC2CB" strokeWidth="0.7" strokeLinecap="round" strokeDasharray="52 88" transform="rotate(210 50 50)" />
          </g>
        </svg>

        {/* the anchor — one shared concept */}
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
          {animate && (
            <span
              className="ddh-anchor-pulse absolute left-1/2 top-1/2 h-16 w-16 -translate-x-1/2 -translate-y-1/2 rounded-full bg-ph-crimson"
              style={{ animation: "ddh-anchor-pulse 2.4s ease-out 1s 2" }}
            />
          )}
          <div
            className="relative flex h-[68px] w-[68px] flex-col items-center justify-center rounded-full border-2 border-ph-crimson shadow-lg"
            style={{
              background: "#0B152D",
              opacity: shown ? 1 : 0,
              transform: shown ? "scale(1)" : "scale(0.6)",
              transition: animate ? "opacity .5s ease .9s, transform .5s cubic-bezier(.34,1.56,.64,1) .9s" : "none",
            }}
          >
            <span className="font-mono text-[10px] font-medium tracking-wide text-ph-teal">CDE</span>
            <span className="text-[11px] font-semibold leading-none text-white">BMI</span>
          </div>
        </div>

        {/* the raw variable names, scattered → orbiting */}
        {NODES.map((n, i) => (
          <div
            key={n.label}
            className="absolute whitespace-nowrap rounded border border-white/15 bg-white/10 px-2 py-1 font-mono text-[10.5px] text-[#dbe4f5] backdrop-blur-sm"
            style={{
              left: `${n.x}%`,
              top: `${n.y}%`,
              opacity: shown ? 1 : 0,
              transform: shown
                ? "translate(-50%, -50%)"
                : `translate(-50%, -50%) translate(${n.dx}px, ${n.dy}px) scale(0.9)`,
              transition: animate ? `opacity .6s ease ${i * 0.09}s, transform .7s cubic-bezier(.22,1,.36,1) ${i * 0.09}s` : "none",
            }}
          >
            {n.label}
          </div>
        ))}
      </div>
    </div>
  );
}

const STEPS = [
  {
    n: "01",
    icon: Layers,
    title: "Group by meaning",
    body: "Sentence embeddings cluster the fields that ask the same thing — across cohorts, regardless of how they're named.",
  },
  {
    n: "02",
    icon: GitCompareArrows,
    title: "Anchor to a standard",
    body: "Each concept maps to a Common Data Element — adopt as-is, refine with a transform, or propose a novel GenCDE.",
  },
  {
    n: "03",
    icon: UserCheck,
    title: "Stay in the loop",
    body: "Every match arrives as a suggestion with confidence and a rationale. You approve, refine, or reject each one.",
  },
];

export default function LandingPage() {
  return (
    <div className="space-y-8">
      {/* ── Hero ─────────────────────────────────────────────────────────────── */}
      <section
        className="relative overflow-hidden rounded-xl border border-ph-navy/30 px-7 py-12 lg:px-14 lg:py-16"
        style={{ background: "linear-gradient(135deg, #0B152D 0%, #113682 62%, #0d2a68 100%)" }}
      >
        {/* ambient glow behind the ring */}
        <div
          className="pointer-events-none absolute -right-24 top-1/2 h-[460px] w-[460px] -translate-y-1/2 rounded-full opacity-40 blur-3xl"
          style={{ background: "radial-gradient(circle, rgba(58,194,203,0.35), transparent 70%)" }}
          aria-hidden="true"
        />
        <div className="relative grid items-center gap-10 lg:grid-cols-[1.05fr_0.95fr]">
          <div>
            <p className="font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-ph-teal">
              Cross-cohort data harmonization
            </p>
            <h1 className="mt-4 font-display text-4xl font-bold leading-[1.05] tracking-tight text-white sm:text-5xl lg:text-6xl">
              Different words.
              <br />
              <span className="text-ph-teal">One meaning.</span>
            </h1>
            <p className="mt-5 max-w-xl text-[15px] leading-relaxed text-[#c3cfe6]">
              <span className="font-semibold text-white">ddharmon</span> reads the data dictionaries from many cohorts,
              groups the fields that mean the same thing, and anchors each concept to a shared Common Data Element — then
              generates the transform to get there. AI drafts every match; you decide.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Button asChild size="lg" className="bg-ph-crimson text-white hover:bg-ph-crimson-dark">
                <Link href="/new">
                  Start a run <ArrowRight className="ml-1.5 h-4 w-4" />
                </Link>
              </Button>
              <Button
                asChild
                size="lg"
                variant="outline"
                className="border-white/25 bg-transparent text-white hover:bg-white/10 hover:text-white"
              >
                <Link href="/guide">Read the guide</Link>
              </Button>
              <Link
                href="/demo"
                className="ml-1 text-sm text-[#c3cfe6] underline decoration-white/25 underline-offset-4 transition-colors hover:text-white"
              >
                or explore a live demo →
              </Link>
            </div>
          </div>

          <div>
            <ConvergenceViz />
            <p className="mt-3 text-center font-mono text-[11px] text-[#8fa1c4]">
              6 variables · 5 cohorts&nbsp;&nbsp;→&nbsp;&nbsp;1 CDE · Body mass index
            </p>
          </div>
        </div>
      </section>

      {/* ── How it works (a real 3-step sequence) ────────────────────────────── */}
      <section>
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="font-display text-lg font-semibold text-ph-ink">How a run works</h2>
          <Link href="/guide" className="text-sm text-ph-navy underline underline-offset-2 hover:text-ph-ink">
            Full walkthrough →
          </Link>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          {STEPS.map((s) => (
            <div key={s.n} className="rounded-lg border border-neutral-200 bg-neutral-0 p-5">
              <div className="flex items-center gap-2.5">
                <span className="font-mono text-xs font-medium text-ph-crimson">{s.n}</span>
                <s.icon className="h-4 w-4 text-ph-navy" />
              </div>
              <h3 className="mt-3 font-display text-base font-semibold text-ph-ink">{s.title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-neutral-600">{s.body}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
