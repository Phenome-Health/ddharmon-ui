import { Link } from "wouter";
import { ArrowRight, BookOpen, ExternalLink, Gauge, RefreshCcw, ScaleIcon, ShieldCheck } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PH } from "@/lib/links";
import { BENCHMARKS, METRIC_DEFS, type Benchmark, type BenchmarkTier } from "@/data/benchmarks";
import { UnderReviewBanner } from "@/components/under-review-banner";

/** Inline external link, styled + with an icon (matches the Methods/Guide `A`). */
function A({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-0.5 text-link-on-raised underline decoration-rule-info underline-offset-2 hover:decoration-link-on-raised"
    >
      {children}
      <ExternalLink className="h-3 w-3" />
    </a>
  );
}

/**
 * Per-tier presentation. The badge variant is the honesty signal: `warning` for the development set
 * (tuned on → optimistic), `success` for held-out generalization checks, `neutral` for external gold.
 * Every card renders one of these, so a development number is never shown without its caveat.
 */
const TIER: Record<
  BenchmarkTier,
  { label: string; badge: "warning" | "success" | "neutral"; blurb: string }
> = {
  development: {
    label: "Development set",
    badge: "warning",
    blurb: "Already tuned on — read as optimistic.",
  },
  "held-out": {
    label: "Held-out",
    badge: "success",
    blurb: "Generalization check — measured, not tuned.",
  },
  external: {
    label: "External gold",
    badge: "neutral",
    blurb: "External ground truth, presented as-is.",
  },
};

function BenchmarkCard({ b }: { b: Benchmark }) {
  const tier = TIER[b.tier];
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-sm">{b.name}</CardTitle>
          <Badge variant={tier.badge} className="ml-auto">
            {tier.label}
          </Badge>
        </div>
        <p className="text-sm text-on-raised-muted">{b.question}</p>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div>
          <div className="mb-1 text-xs font-semibold uppercase tracking-eyebrow text-on-raised-muted">
            Task
          </div>
          <p className="text-on-raised">{b.task}</p>
        </div>

        <div>
          <div className="mb-1 text-xs font-semibold uppercase tracking-eyebrow text-on-raised-muted">
            Ground truth &amp; provenance
          </div>
          <p className="text-on-raised">{b.groundTruth}</p>
          <p className="mt-1 text-on-raised">{b.provenance}</p>
          {b.sources && b.sources.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
              {b.sources.map((s) => (
                <A key={s.href} href={s.href}>
                  {s.label}
                </A>
              ))}
            </div>
          )}
        </div>

        <div>
          <div className="mb-1.5 text-xs font-semibold uppercase tracking-eyebrow text-on-raised-muted">
            {b.metrics.length > 1 ? "Headline metrics" : "Headline metric"}
          </div>
          <div className="space-y-1.5">
            {b.metrics.map((m) => (
              <div
                key={m.label}
                className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 rounded-md border border-border bg-muted px-3 py-2"
              >
                <span className="text-xs text-on-raised">{m.label}</span>
                <span className="font-mono text-sm font-semibold text-on-raised">{m.value}</span>
              </div>
            ))}
          </div>
        </div>

        {/* The dev/held-out caveat travels with the number — never one without the other. */}
        <div className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-on-raised-faint" />
          <span>
            <span className="font-semibold text-on-raised">{tier.blurb}</span>
            {b.note ? <> {b.note}</> : null}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

export default function BenchmarksPage() {
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="flex items-center gap-2 font-display text-xl font-semibold text-on-raised">
          <Gauge className="h-6 w-6 text-accent-on-raised" /> Benchmarks
        </h1>
        <p className="mt-1 text-sm text-on-raised-muted">
          How ddharmon performs against <span className="font-semibold text-on-raised">external ground-truth</span>{" "}
          benchmarks — not self-defined metrics. Each card carries a dev/held-out tag so the numbers are
          read honestly. A results complement to the{" "}
          <Link href="/methods" className="text-link-on-raised underline hover:text-on-raised">
            Methods
          </Link>{" "}
          page.
        </p>
      </div>

      <UnderReviewBanner />

      {/* Benchmark-usage policy (honesty) — sets the reading frame before any number is shown. */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <ScaleIcon className="h-4 w-4 text-accent-on-raised" /> How to read these numbers
          </CardTitle>
          <p className="text-xs text-on-raised-muted">
            The benchmark-usage policy, stated up front — so a development-set number is never mistaken
            for a held-out one.
          </p>
        </CardHeader>
        <CardContent className="space-y-3 text-sm leading-relaxed text-on-raised">
          <div className="grid gap-2.5 sm:grid-cols-3">
            <div className="rounded-md border border-warning-border bg-warning-bg p-3">
              <Badge variant="warning" className="mb-1.5">
                Development set
              </Badge>
              <p className="text-xs text-on-raised">
                <span className="font-semibold text-on-raised">CDEMapper.</span> Already tuned on, so
                read it as <em>optimistic</em> — an upper bound, not a generalization claim.
              </p>
            </div>
            <div className="rounded-md border border-success-border bg-success-bg p-3">
              <Badge variant="success" className="mb-1.5">
                Held-out
              </Badge>
              <p className="text-xs text-on-raised">
                <span className="font-semibold text-on-raised">PhenX, AI-READI.</span> Generalization
                checks — measured, never tuned on.
              </p>
            </div>
            <div className="rounded-md border border-border bg-muted p-3">
              <Badge variant="neutral" className="mb-1.5">
                Locked gate
              </Badge>
              <p className="text-xs text-on-raised">
                <span className="font-semibold text-on-raised">EITL human verdicts.</span> The locked
                in-domain acceptance gate — the arbiter of the boundary.
              </p>
            </div>
          </div>
          <p className="text-xs text-on-raised-muted">
            Only <span className="font-semibold text-on-raised">mechanistically-justified</span> changes
            are adopted — never benchmark-chasing.
          </p>
        </CardContent>
      </Card>

      {/* Per-benchmark cards — rendered from the manifest, one per gold dataset. */}
      <div className="grid gap-4 sm:grid-cols-2">
        {BENCHMARKS.map((b) => (
          <BenchmarkCard key={b.name} b={b} />
        ))}
      </div>

      {/* Metric definitions — so a value isn't read without knowing exactly what it measures. */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <BookOpen className="h-4 w-4 text-accent-on-raised" /> What the metrics mean
          </CardTitle>
          <p className="text-xs text-on-raised-muted">
            Precise definitions + the reference frame for reading each score.
          </p>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-on-raised">
          <dl className="space-y-2.5">
            {METRIC_DEFS.map((m) => (
              <div key={m.term} className="grid gap-0.5 sm:grid-cols-[minmax(9rem,13rem)_1fr] sm:gap-3">
                <dt className="font-mono text-xs font-semibold text-on-raised">{m.term}</dt>
                <dd className="text-on-raised">{m.def}</dd>
              </div>
            ))}
          </dl>
          <p className="rounded-md border border-border bg-muted p-3 text-xs">
            <span className="font-semibold text-on-raised">What&apos;s good?</span> recall@k, assignment, and
            recode-accuracy run 0–1 (1 = perfect; a chance / naive baseline sits far below). Separability Δ is a
            distributional gap, not an accuracy — larger means the encoder separates concepts more cleanly, 0
            means no separation.
          </p>
        </CardContent>
      </Card>

      {/* The value layer needs context — the ATHLOS lift, called out. */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <ShieldCheck className="h-4 w-4 text-accent-on-raised" /> The value layer needs question context
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm leading-relaxed text-on-raised">
          <p>
            Value recodes aren't generated blind. On the ATHLOS benchmark, feeding the source variable's{" "}
            <span className="font-mono text-xs text-on-raised">question_text</span> into the recode
            generator lifts recode accuracy about{" "}
            <span className="font-semibold text-on-raised">7 percentage points</span>{" "}
            <span className="font-mono text-xs">(0.832 → 0.869)</span> by resolving polarity and
            granularity judgment calls.
          </p>
        </CardContent>
      </Card>

      {/* Reproducibility — the plain-language "what this means". */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <RefreshCcw className="h-4 w-4 text-accent-on-raised" /> Reproducibility
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm leading-relaxed text-on-raised">
          <p>
            The benchmarks live in a portable{" "}
            <span className="font-mono text-xs text-on-raised">benchmarks/</span> package — it runs at{" "}
            <span className="font-semibold text-on-raised">$0</span> (no paid API calls to reproduce the
            reported figures) and is deterministic under{" "}
            <span className="font-mono text-xs text-on-raised">PYTHONHASHSEED=0</span>.
          </p>
          <p className="rounded-md border border-border bg-muted p-3 text-xs">
            <span className="font-semibold text-on-raised">What this means:</span> anyone can re-run the
            same evaluation on the same public gold datasets and get the same numbers on this page —
            they aren't one-off results from a private run.
          </p>
          <p className="text-xs text-on-raised-muted">
            Numbers on this page are grounded verbatim in the canonical{" "}
            <A href={`${PH.ddharmon}/blob/main/docs/methods.md`}>ddharmon methods documentation</A>{" "}
            (Evaluation section).
          </p>
        </CardContent>
      </Card>

      <div className="flex items-center justify-between rounded-lg border border-rule-on-raised bg-surface-inset px-4 py-3">
        <p className="text-sm text-on-raised">
          Curious how the pipeline earns these numbers? Walk the stages, or try a run.
        </p>
        <div className="flex gap-2">
          <Button asChild size="sm" variant="outline">
            <Link href="/methods">Methods</Link>
          </Button>
          <Button asChild size="sm">
            <Link href="/demo">
              Open demo <ArrowRight className="ml-1.5 h-4 w-4" />
            </Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
