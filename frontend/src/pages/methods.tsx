import { Link } from "wouter";
import { ArrowRight, BookOpen, ChevronRight, ExternalLink, Layers, ShieldCheck, Split as SplitIcon } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PH } from "@/lib/links";
import { PIPELINE_STAGES, type PipelineStage, type StageKind } from "@/data/pipeline-stages";
import { UnderReviewBanner } from "@/components/under-review-banner";

/** Inline external link, styled + with an icon (matches the Guide page's `A`). */
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

const KIND_LABEL: Record<StageKind, string> = { local: "Local · free", llm: "AI step", human: "Human" };
const KIND_STYLE: Record<StageKind, string> = {
  local: "bg-surface-inset-strong text-on-raised border-rule-control-on-raised",
  llm: "bg-surface-info text-accent-on-raised border-rule-info",
  human: "bg-success-bg text-success border-success/30",
};
/** Diagram-chip styling per kind (theme-aware tokens only). */
const CHIP_STYLE: Record<StageKind, string> = {
  local: "border-border bg-surface-inset text-on-raised hover:border-on-raised-faint",
  llm: "border-rule-info bg-surface-info text-accent-on-raised hover:border-rule-info",
  human: "border-success/40 bg-success-bg text-success hover:border-success",
};

function KindBadge({ kind }: { kind: StageKind }) {
  return (
    <span className={`rounded border px-1.5 py-0.5 text-xs font-semibold ${KIND_STYLE[kind]}`}>
      {KIND_LABEL[kind]}
    </span>
  );
}

/** The visual stage-flow spine — derived entirely from PIPELINE_STAGES. */
function StageFlow() {
  return (
    <div className="space-y-3">
      <div className="overflow-x-auto pb-2">
        <ol className="flex min-w-max items-stretch gap-1">
          {PIPELINE_STAGES.map((s, i) => {
            const Icon = s.icon;
            return (
              <li key={s.id} className="flex items-center gap-1">
                <a
                  href={`#stage-${s.id}`}
                  className={`group flex w-28 shrink-0 flex-col gap-1 rounded-md border px-2.5 py-2 transition-colors ${CHIP_STYLE[s.kind]}`}
                >
                  <Icon className="h-4 w-4" />
                  <span className="text-xs font-semibold leading-tight">{s.short}</span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {s.phase ?? "—"}
                  </span>
                </a>
                {i < PIPELINE_STAGES.length - 1 && (
                  <ChevronRight className="h-4 w-4 shrink-0 text-on-raised-faint" aria-hidden />
                )}
              </li>
            );
          })}
        </ol>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm border border-border bg-surface-inset" /> Local · free
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm border border-rule-info bg-surface-info" /> AI step (paid)
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm border border-success/40 bg-success-bg" /> Human
        </span>
        <span className="ml-auto font-mono">
          monospace caption = reported progress phase (PHASES_RUN)
        </span>
      </div>
    </div>
  );
}

function BulletList({ items }: { items: string[] }) {
  return (
    <ul className="space-y-1">
      {items.map((it) => (
        <li key={it} className="flex items-start gap-1.5">
          <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-on-raised-faint" />
          <span>{it}</span>
        </li>
      ))}
    </ul>
  );
}

function StageSection({ stage, n }: { stage: PipelineStage; n: number }) {
  const Icon = stage.icon;
  return (
    <Card id={`stage-${stage.id}`} className="scroll-mt-6">
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface-info text-xs font-semibold text-accent-on-raised">
            {n}
          </span>
          <Icon className="h-4 w-4 text-accent-on-raised" />
          <CardTitle className="text-sm">{stage.name}</CardTitle>
          <div className="ml-auto flex items-center gap-2">
            <KindBadge kind={stage.kind} />
            {stage.phase ? (
              <Badge variant="secondary" className="font-mono text-xs">
                {stage.phase}
              </Badge>
            ) : (
              <span className="text-xs text-muted-foreground">no progress phase</span>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 text-sm text-on-raised">
        <p className="leading-relaxed">{stage.whatItDoes}</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <div className="mb-1 text-xs font-semibold uppercase tracking-eyebrow text-on-raised-muted">Inputs</div>
            <BulletList items={stage.inputs} />
          </div>
          <div>
            <div className="mb-1 text-xs font-semibold uppercase tracking-eyebrow text-on-raised-muted">Outputs</div>
            <BulletList items={stage.outputs} />
          </div>
        </div>
        <div>
          <div className="mb-1 text-xs font-semibold uppercase tracking-eyebrow text-on-raised-muted">Key decisions</div>
          <BulletList items={stage.keyDecisions} />
        </div>
        {stage.link && (
          <Link
            href={stage.link.href}
            className="inline-flex items-center gap-1 text-sm font-semibold text-accent-on-raised hover:text-on-raised"
          >
            {stage.link.label}
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        )}
      </CardContent>
    </Card>
  );
}

/** One glossary term (label + definition) for the orientation card. */
function Term({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <div className="sm:flex sm:gap-3">
      <dt className="shrink-0 font-semibold text-on-raised sm:w-44">{name}</dt>
      <dd className="text-on-raised">{children}</dd>
    </div>
  );
}

export default function MethodsPage() {
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="flex items-center gap-2 font-display text-xl font-semibold text-on-field">Methods</h1>
        <p className="mt-1 text-sm text-on-field-muted">
          A stage-by-stage walk through the harmonization pipeline — from the data dictionaries you upload
          to the review workbench. A deep-dive complement to the{" "}
          <Link href="/guide" className="text-link-on-field underline hover:text-on-field">
            Guide
          </Link>
          .
        </p>
      </div>

      <UnderReviewBanner />

      {/* 0 · Orientation — makes this page standalone; the vocabulary the stages assume ------- */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <BookOpen className="h-4 w-4 text-accent-on-raised" /> Before you dive in: the key terms
          </CardTitle>
          <p className="text-xs text-on-raised-muted">
            New here? The{" "}
            <Link href="/guide" className="text-link-on-raised underline hover:text-on-raised">
              Guide
            </Link>{" "}
            covers what the platform does and how to use it. This page is the under-the-hood detail — here's the
            vocabulary the stages below assume.
          </p>
        </CardHeader>
        <CardContent className="text-sm">
          <dl className="space-y-2 leading-relaxed">
            <Term name="Harmonization">
              mapping variables from different cohorts onto a shared standard, so separate studies can be pooled
              for a single analysis.
            </Term>
            <Term name="Data dictionary">
              the metadata describing a cohort's variables — names, descriptions, response options — not the
              participant-level data itself.
            </Term>
            <Term name="Concept">
              a group of variables (usually across cohorts) that mean the same thing. The concept — not each
              individual variable — is the unit ddharmon assigns to a standard.
            </Term>
            <Term name="CDE — Common Data Element">
              a curated, reusable standard definition (e.g. the NIH CDE Repository) that a concept is matched to.
            </Term>
            <Term name="Ideal CDE">
              an independently-generated “what should exist” description for a concept, used as the coverage
              anchor for the match — shown in the app as the concept summary.
            </Term>
            <Term name="Adopt · Refine · Novel">
              the per-concept verdict — adopt an existing CDE as-is · refine it through a value transform · novel
              when none fits (routed to a proposed new CDE / the clustering tail).
            </Term>
          </dl>
        </CardContent>
      </Card>

      {/* 1 · Why assignment-first (mirrors methods.md §1) ------------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <SplitIcon className="h-4 w-4 text-accent-on-raised" /> Assignment-first, by design
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm leading-relaxed text-on-raised">
          <p>
            ddharmon treats a <span className="font-semibold text-on-raised">covered</span> concept as{" "}
            <span className="font-semibold text-on-raised">assignment to an existing Common Data Element (CDE)</span>,
            and routes only the <span className="font-semibold text-on-raised">uncovered</span> tail to generation and
            clustering. It leads with assignment to the given CDE backbone rather than making clustering the
            primary engine — the division of labor the research harness settled empirically against external
            benchmarks.
          </p>
          <p>Three findings shaped the design:</p>
          <ul className="space-y-1.5">
            <li>
              <span className="font-semibold text-on-raised">Two buckets, scored separately.</span>{" "}
              Harmonization splits into a <em>head</em> (concepts that already have a CDE) and a diffuse{" "}
              <em>tail</em> (no matching CDE). Blending them hides the truth, so the two are measured
              independently — assign the head, cluster/generate the tail.
            </li>
            <li>
              <span className="font-semibold text-on-raised">One fused assignment call.</span> Ranking a wide
              hybrid-retrieved candidate pool <em>and</em> committing a verdict in a single call beats a
              two-call rerank-then-verdict design on both accuracy and cost.
            </li>
            <li>
              <span className="font-semibold text-on-raised">A human gate for the boundary.</span> The
              adopt/refine/novel cutoff is deliberately strict; final calibration is deferred to expert (EITL)
              review of the routed output.
            </li>
          </ul>
          <p className="text-xs text-on-raised-muted">
            Grounded in the canonical{" "}
            <A href={`${PH.ddharmon}/blob/main/docs/methods.md`}>ddharmon methods documentation</A>.
          </p>
        </CardContent>
      </Card>

      {/* 2 · Stage-flow diagram (derived from the manifest) ---------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <Layers className="h-4 w-4 text-accent-on-raised" /> The pipeline at a glance
          </CardTitle>
          <p className="text-xs text-on-raised-muted">
            Each box is a stage below — click to jump. The flow and the sections both render from one stage
            manifest, so they never drift.
          </p>
        </CardHeader>
        <CardContent>
          <StageFlow />
        </CardContent>
      </Card>

      {/* 3 · Per-stage deep dive (one section per manifest entry) ----------------------------- */}
      {PIPELINE_STAGES.map((stage, i) => (
        <StageSection key={stage.id} stage={stage} n={i + 1} />
      ))}

      {/* 4 · How it's evaluated — brief; the Benchmarks page owns the numbers ---------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <ShieldCheck className="h-4 w-4 text-accent-on-raised" /> How it's evaluated
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm leading-relaxed text-on-raised">
          <p>
            The architecture was settled against external ground-truth benchmarks (CDEMapper, PhenX, AI-READI,
            ATHLOS) — portable and reproducible — plus a locked in-domain human (EITL) gate. CDEMapper is the
            development set; PhenX and AI-READI are held-out generalization checks, so a development number never
            stands without its caveat.
          </p>
          <Link
            href="/benchmarks"
            className="inline-flex items-center gap-1 text-sm font-semibold text-accent-on-raised hover:text-on-raised"
          >
            See the benchmark results <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </CardContent>
      </Card>

      <div className="flex items-center justify-between rounded-lg border border-rule-on-raised bg-surface-inset px-4 py-3">
        <p className="text-sm text-on-raised">
          See the pipeline in action — load a precomputed demo, or start your own run.
        </p>
        <div className="flex gap-2">
          <Button asChild size="sm" variant="outline">
            <Link href="/demo">Open demo</Link>
          </Button>
          <Button asChild size="sm">
            <Link href="/new">
              New run <ArrowRight className="ml-1.5 h-4 w-4" />
            </Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
