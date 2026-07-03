import { useEffect, useState } from "react";
import { Link } from "wouter";
import { ArrowRight, GitCompareArrows, Layers, UserCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PhLogo } from "@/components/ph-logo";

// ── The signature visual: the SAME concept, asked differently and coded differently
// across cohorts — question text + response options carry the meaning; the variable
// name rides along as a differentiator — resolving to one shared CDE with a canonical
// value set. Meaning, not wording — shown.
const SOURCES = [
  { cohort: "Cohort A", v: "SMQ020", q: "Do you smoke cigarettes now?", r: "Yes · No", y: 16 },
  { cohort: "Cohort B", v: "smoking_status", q: "Current smoking status", r: "Never · Former · Current", y: 50 },
  { cohort: "Cohort C", v: "cig_use_30d", q: "Cigarette use, last 30 days", r: "0 · 1 · 2", y: 84 },
];
const LINE_X1 = 46; // right edge of the source cards (viewBox units)
const RING_EDGE_X = 66; // left edge of the ring
const RING_Y = 50;

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
    <div className="relative mx-auto aspect-square w-full max-w-[460px]">
      {/* connectors — source questions flow into the shared concept */}
      <svg viewBox="0 0 100 100" className="absolute inset-0 h-full w-full" aria-hidden="true">
        {SOURCES.map((s, i) => {
          const len = Math.hypot(RING_EDGE_X - LINE_X1, RING_Y - s.y);
          return (
            <line
              key={s.cohort}
              x1={LINE_X1}
              y1={s.y}
              x2={RING_EDGE_X}
              y2={RING_Y}
              stroke="#3AC2CB"
              strokeWidth={0.5}
              strokeLinecap="round"
              style={{
                strokeDasharray: len,
                strokeDashoffset: shown ? 0 : len,
                opacity: shown ? 0.5 : 0,
                transition: animate ? `stroke-dashoffset .7s ease ${0.35 + i * 0.12}s, opacity .5s ${0.35 + i * 0.12}s` : "none",
              }}
            />
          );
        })}
      </svg>

      {/* left — the raw survey items (question text primary; response options + variable name alongside) */}
      {SOURCES.map((s, i) => (
        <div
          key={s.cohort}
          className="absolute left-0 w-[45%] rounded-md border border-white/12 bg-white/[0.06] px-2.5 py-1.5 backdrop-blur-sm"
          style={{
            top: `${s.y}%`,
            transform: shown ? "translateY(-50%)" : "translateY(-50%) translateX(-18px)",
            opacity: shown ? 1 : 0,
            transition: animate ? `opacity .55s ease ${i * 0.13}s, transform .55s cubic-bezier(.22,1,.36,1) ${i * 0.13}s` : "none",
          }}
        >
          <div className="flex items-center gap-1 font-mono text-[8.5px] uppercase tracking-wide text-[#7f92b8]">
            <span>{s.cohort}</span>
            <span className="text-[#5a6b8c]">·</span>
            <span className="normal-case text-[#7f92b8]">{s.v}</span>
          </div>
          <div className="mt-0.5 text-[11.5px] font-medium leading-snug text-white">{s.q}</div>
          <div className="mt-1 truncate font-mono text-[9.5px] text-ph-teal">{s.r}</div>
        </div>
      ))}

      {/* right — the circos ring anchor: one shared CDE */}
      <div className="absolute right-0 top-1/2 aspect-square w-[44%] -translate-y-1/2">
        <svg viewBox="0 0 100 100" className="absolute inset-0 h-full w-full" aria-hidden="true">
          <g className="ddh-ring-spin" style={{ transformBox: "view-box", transformOrigin: "50% 50%", animation: "ddh-ring-spin 60s linear infinite" }}>
            <circle cx="50" cy="50" r="42" fill="none" stroke="#E21C52" strokeWidth="1.3" strokeLinecap="round" strokeDasharray="190 265" />
            <circle cx="50" cy="50" r="33" fill="none" stroke="#FFFFFF" strokeWidth="1.3" strokeLinecap="round" strokeDasharray="126 208" transform="rotate(80 50 50)" opacity="0.7" />
            <circle cx="50" cy="50" r="24" fill="none" stroke="#3AC2CB" strokeWidth="1.3" strokeLinecap="round" strokeDasharray="90 152" transform="rotate(210 50 50)" />
          </g>
        </svg>
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
          {animate && (
            <span
              className="ddh-anchor-pulse absolute left-1/2 top-1/2 h-16 w-16 -translate-x-1/2 -translate-y-1/2 rounded-full bg-ph-crimson"
              style={{ animation: "ddh-anchor-pulse 2.4s ease-out 1.2s 2" }}
            />
          )}
          <div
            className="relative flex h-[74px] w-[74px] flex-col items-center justify-center rounded-full border-2 border-ph-crimson shadow-lg"
            style={{
              background: "#0B152D",
              opacity: shown ? 1 : 0,
              transform: shown ? "scale(1)" : "scale(0.6)",
              transition: animate ? "opacity .5s ease 1s, transform .5s cubic-bezier(.34,1.56,.64,1) 1s" : "none",
            }}
          >
            <span className="font-mono text-[9px] font-medium tracking-wide text-ph-teal">CDE</span>
            <span className="text-[12px] font-semibold leading-none text-white">Smoking</span>
            <span className="text-[8.5px] leading-none text-white/60">status</span>
          </div>
        </div>
      </div>
    </div>
  );
}

const STEPS = [
  {
    n: "01",
    icon: Layers,
    title: "Group by meaning",
    body: "Sentence embeddings compare each field's question text and description — where its meaning lives — so items that ask the same thing cluster together, even under unrelated variable names.",
  },
  {
    n: "02",
    icon: GitCompareArrows,
    title: "Anchor to a standard",
    body: "Each concept maps to a Common Data Element: adopt as-is, refine (recoding response options, converting units), or propose a novel GenCDE.",
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
              <span className="font-semibold text-white">ddharmon</span> reads each field's question text and
              description — the fields that carry its meaning — along with its response options and variable name,
              groups the items that mean the same thing across cohorts, and anchors each concept to a shared Common
              Data Element, generating the value transform to get there. AI drafts every match; you decide.
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
            <a
              href="https://phenomehealth.org"
              target="_blank"
              rel="noreferrer"
              className="mt-10 inline-flex items-center gap-2.5 opacity-80 transition-opacity hover:opacity-100"
            >
              <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-white/45">A project of</span>
              <PhLogo tone="dark" className="h-4 w-auto" />
            </a>
          </div>

          <div>
            <ConvergenceViz />
            <p className="mt-4 text-center font-mono text-[11px] leading-relaxed text-[#8fa1c4]">
              3 cohorts · different wording, different response codes
              <br />
              → 1 CDE · Smoking status <span className="text-ph-teal/80">(Never · Former · Current)</span>
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
