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
      className="inline-flex items-center gap-0.5 text-ph-navy underline decoration-ph-navy/30 underline-offset-2 hover:decoration-ph-navy"
    >
      {children}
      <ExternalLink className="h-3 w-3" />
    </a>
  );
}

const KIND_LABEL: Record<StageKind, string> = { local: "Local · free", llm: "AI step", human: "Human" };
const KIND_STYLE: Record<StageKind, string> = {
  local: "bg-neutral-100 text-neutral-600 border-neutral-300",
  llm: "bg-ph-navy/10 text-ph-navy border-ph-navy/30",
  human: "bg-success-bg text-success border-success/30",
};
/** Diagram-chip styling per kind (theme-aware tokens only). */
const CHIP_STYLE: Record<StageKind, string> = {
  local: "border-border bg-neutral-50 text-neutral-700 hover:border-neutral-400",
  llm: "border-ph-navy/30 bg-ph-navy/5 text-ph-navy hover:border-ph-navy/60",
  human: "border-success/40 bg-success-bg text-success hover:border-success",
};

function KindBadge({ kind }: { kind: StageKind }) {
  return (
    <span className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${KIND_STYLE[kind]}`}>
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
                  <span className="text-xs font-medium leading-tight">{s.short}</span>
                  <span className="font-mono text-[9px] text-muted-foreground">
                    {s.phase ?? "—"}
                  </span>
                </a>
                {i < PIPELINE_STAGES.length - 1 && (
                  <ChevronRight className="h-4 w-4 shrink-0 text-neutral-300" aria-hidden />
                )}
              </li>
            );
          })}
        </ol>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm border border-border bg-neutral-50" /> Local · free
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm border border-ph-navy/30 bg-ph-navy/10" /> AI step (paid)
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
          <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-neutral-400" />
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
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-ph-navy/10 text-xs font-semibold text-ph-navy">
            {n}
          </span>
          <Icon className="h-4 w-4 text-ph-navy" />
          <CardTitle className="text-base">{stage.name}</CardTitle>
          <div className="ml-auto flex items-center gap-2">
            <KindBadge kind={stage.kind} />
            {stage.phase ? (
              <Badge variant="secondary" className="font-mono text-[10px]">
                {stage.phase}
              </Badge>
            ) : (
              <span className="text-[10px] text-muted-foreground">no progress phase</span>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 text-sm text-neutral-600">
        <p className="leading-relaxed">{stage.whatItDoes}</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <div className="mb-1 text-xs font-medium uppercase tracking-wide text-neutral-400">Inputs</div>
            <BulletList items={stage.inputs} />
          </div>
          <div>
            <div className="mb-1 text-xs font-medium uppercase tracking-wide text-neutral-400">Outputs</div>
            <BulletList items={stage.outputs} />
          </div>
        </div>
        <div>
          <div className="mb-1 text-xs font-medium uppercase tracking-wide text-neutral-400">Key decisions</div>
          <BulletList items={stage.keyDecisions} />
        </div>
        {stage.link && (
          <Link
            href={stage.link.href}
            className="inline-flex items-center gap-1 text-sm font-medium text-ph-navy hover:text-ph-ink"
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
      <dt className="shrink-0 font-medium text-neutral-700 sm:w-44">{name}</dt>
      <dd className="text-neutral-600">{children}</dd>
    </div>
  );
}

export default function MethodsPage() {
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold text-ph-ink">Methods</h1>
        <p className="mt-1 text-sm text-neutral-500">
          A stage-by-stage walk through the harmonization pipeline — from the data dictionaries you upload
          to the review workbench. A deep-dive complement to the{" "}
          <Link href="/guide" className="text-ph-navy underline hover:text-ph-ink">
            Guide
          </Link>
          .
        </p>
      </div>

      <UnderReviewBanner />

      {/* 0 · Orientation — makes this page standalone; the vocabulary the stages assume ------- */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <BookOpen className="h-4 w-4 text-ph-navy" /> Before you dive in: the key terms
          </CardTitle>
          <p className="text-xs text-neutral-400">
            New here? The{" "}
            <Link href="/guide" className="text-ph-navy underline hover:text-ph-ink">
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
              a group of fields (usually across cohorts) that mean the same thing. The concept — not each
              individual field — is the unit ddharmon assigns to a standard.
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
          <CardTitle className="flex items-center gap-2 text-base">
            <SplitIcon className="h-4 w-4 text-ph-navy" /> Assignment-first, by design
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm leading-relaxed text-neutral-600">
          <p>
            ddharmon treats a <span className="font-medium text-ph-ink">covered</span> concept as{" "}
            <span className="font-medium text-ph-ink">assignment to an existing Common Data Element (CDE)</span>,
            and routes only the <span className="font-medium text-ph-ink">uncovered</span> tail to generation and
            clustering. It leads with assignment to the given CDE backbone rather than making clustering the
            primary engine — the division of labor the research harness settled empirically against external
            benchmarks.
          </p>
          <p>Three findings shaped the design:</p>
          <ul className="space-y-1.5">
            <li>
              <span className="font-medium text-neutral-700">Two buckets, scored separately.</span>{" "}
              Harmonization splits into a <em>head</em> (concepts that already have a CDE) and a diffuse{" "}
              <em>tail</em> (no matching CDE). Blending them hides the truth, so the two are measured
              independently — assign the head, cluster/generate the tail.
            </li>
            <li>
              <span className="font-medium text-neutral-700">One fused assignment call.</span> Ranking a wide
              hybrid-retrieved candidate pool <em>and</em> committing a verdict in a single call beats a
              two-call rerank-then-verdict design on both accuracy and cost.
            </li>
            <li>
              <span className="font-medium text-neutral-700">A human gate for the boundary.</span> The
              adopt/refine/novel cutoff is deliberately strict; final calibration is deferred to expert (EITL)
              review of the routed output.
            </li>
          </ul>
          <p className="text-xs text-neutral-400">
            Grounded in the canonical{" "}
            <A href={`${PH.ddharmon}/blob/main/docs/methods.md`}>ddharmon methods documentation</A>.
          </p>
        </CardContent>
      </Card>

      {/* 2 · Stage-flow diagram (derived from the manifest) ---------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Layers className="h-4 w-4 text-ph-navy" /> The pipeline at a glance
          </CardTitle>
          <p className="text-xs text-neutral-400">
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
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="h-4 w-4 text-ph-navy" /> How it's evaluated
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm leading-relaxed text-neutral-600">
          <p>
            The architecture was settled against external ground-truth benchmarks (CDEMapper, PhenX, AI-READI,
            ATHLOS) — portable and reproducible — plus a locked in-domain human (EITL) gate. CDEMapper is the
            development set; PhenX and AI-READI are held-out generalization checks, so a development number never
            stands without its caveat.
          </p>
          <Link
            href="/benchmarks"
            className="inline-flex items-center gap-1 text-sm font-medium text-ph-navy hover:text-ph-ink"
          >
            See the benchmark results <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </CardContent>
      </Card>

      <div className="flex items-center justify-between rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3">
        <p className="text-sm text-neutral-600">
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
