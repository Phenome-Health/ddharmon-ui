import { Link } from "wouter";
import {
  ArrowRight,
  Bot,
  CheckCircle2,
  Download,
  ExternalLink,
  FileSpreadsheet,
  Gauge,
  GitCompareArrows,
  Layers,
  ListChecks,
  Pencil,
  Sparkles,
  UserCheck,
  Upload,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { REF } from "@/lib/links";
import { VERDICT_STYLES } from "@/types";

/** Inline external link, styled + with an icon. */
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

export default function GuidePage() {
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-ph-ink">What this platform does</h1>
        <p className="mt-1 text-sm text-neutral-500">
          A guide to harmonizing cohort data dictionaries onto a Common Data Element backbone — what you
          provide, how a run works, and what you get back.
        </p>
      </div>

      {/* 1 · The problem it solves (incl. meaning-not-wording) --------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <GitCompareArrows className="h-4 w-4 text-ph-navy" /> The problem it solves
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm leading-relaxed text-neutral-600">
          <p>
            Different studies describe the same measurement in different words — <code>bmi</code> in one
            cohort, <code>body_mass_index</code> in another, <code>Q47_weight_kg</code> in a third — and the same
            survey question gets reworded from study to study. One study asks{" "}
            <span className="italic text-neutral-700">“In general, would you say your health is…”</span>; another
            records the same thing as <span className="italic text-neutral-700">“Overall health rating”</span> under
            a variable named <code>2178</code>. String matching misses these. Before you can pool cohorts for an analysis, those
            variables have to be mapped to a shared standard.
          </p>
          <p>
            <span className="font-medium text-ph-ink">ddharmon</span> reads the <em>data dictionaries</em>{" "}
            (the metadata that describes each variable) from two or more cohorts, groups fields that mean the
            same thing, and assigns each concept to a{" "}
            <A href={REF.cde}>Common Data Element (CDE)</A> — a curated, reusable standard definition (e.g. from
            the NIH CDE Repository, often coded with <A href={REF.loinc}>LOINC</A> or{" "}
            <A href={REF.snomed}>SNOMED CT</A>). For every assignment it also generates a{" "}
            <span className="font-medium text-ph-ink">transform spec</span>: the recipe for converting your
            raw values into the CDE's expected form.
          </p>
        </CardContent>
      </Card>

      {/* 2 · What you provide / get back ------------------------------------------------------- */}
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">What you provide</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-neutral-600">
            <p>A data dictionary per cohort (CSV/TSV). Map at least one of:</p>
            <ul className="space-y-1">
              <FieldItem name="variable_name">
                the field's identifier/code — optional; auto-generated if you omit it
              </FieldItem>
              <FieldItem name="description">a human-readable definition</FieldItem>
              <FieldItem name="question_text">the survey question, if any</FieldItem>
            </ul>
            <p className="pt-1">
              Optional columns sharpen the result — <code>value_encoding</code> (response options),{" "}
              <code>units</code>, <code>data_type</code> — especially for generating transform specs.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">What you get back</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-neutral-600">
            <ul className="space-y-1.5">
              <OutputItem>A reviewable queue of concepts with verdicts, confidence, and CDE candidates</OutputItem>
              <OutputItem>Transform specs — value recodes, unit conversions, formulas</OutputItem>
              <OutputItem>
                <span className="font-medium text-ph-ink">Python / R notebooks</span> that apply the transforms
                in your own environment
              </OutputItem>
              <OutputItem>Exports: expert-review TSV, records JSON, decisions CSV</OutputItem>
              <OutputItem>Visual maps: match-journey Sankey &amp; a cohort-colored embedding atlas</OutputItem>
            </ul>
          </CardContent>
        </Card>
      </div>

      {/* 3 · The workflow ---------------------------------------------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Layers className="h-4 w-4 text-ph-navy" /> The workflow
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm text-neutral-600">
          <Step
            n={1}
            icon={<Upload className="h-4 w-4" />}
            title="Upload data dictionaries"
            body="One CSV/TSV per cohort, describing your variables. This is metadata about your fields — not the participant-level data itself."
          />
          <Step
            n={2}
            icon={<FileSpreadsheet className="h-4 w-4" />}
            title="Map columns to roles"
            body="Tell ddharmon which of your columns is the variable name, the description, the response options, and so on. Every role starts blank — hover the ⓘ next to each for what it means and how to format it."
          />
          <Step
            n={3}
            icon={<GitCompareArrows className="h-4 w-4" />}
            title="Run the harmonization"
            body="ddharmon embeds and clusters your fields, retrieves candidate CDEs from the catalog, and decides adopt / refine / novel — generating transform specs along the way."
          />
          <Step
            n={4}
            icon={<ListChecks className="h-4 w-4" />}
            title="Review & decide"
            body="Every concept comes with a verdict, a confidence score, ranked CDE candidates, and its transform spec. Approve, refine, or reject each in the review queue or the workbench."
          />
          <Step
            n={5}
            icon={<Download className="h-4 w-4" />}
            title="Export"
            body="Take the results into your pipeline: an expert-review queue, machine-readable records, decision logs, and ready-to-run Python / R notebooks that apply the transforms."
          />
        </CardContent>
      </Card>

      {/* 4 · Where AI is used ------------------------------------------------------------------ */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Bot className="h-4 w-4 text-ph-navy" /> Where AI is used
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm leading-relaxed text-neutral-600">
          <p>ddharmon is AI-assisted end to end — concretely:</p>
          <ul className="space-y-1.5">
            <li>
              <span className="font-medium text-neutral-700">Grouping</span> — sentence-embedding models place
              semantically similar fields near each other, then cluster them into concepts.
            </li>
            <li>
              <span className="font-medium text-neutral-700">Assignment</span> — a large language model weighs the
              retrieved CDE candidates for each concept and decides adopt / refine / novel, with a written rationale.
            </li>
            <li>
              <span className="font-medium text-neutral-700">Transform specs</span> — the LLM drafts the value recodes
              and unit / arithmetic conversions.
            </li>
          </ul>
          <p>
            Embeddings run locally; the LLM steps are the only ones that call an external model — and the only paid
            part (you'll see a cost estimate before each run). <span className="font-medium">Preview</span> mode runs
            the grouping with no LLM at all.{" "}
            <span className="font-medium text-ph-ink">Every AI output is a suggestion, never a silent commit</span> —
            every concept is yours to approve, refine, or reject.
          </p>
        </CardContent>
      </Card>

      {/* 5 · Choosing run options -------------------------------------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Choosing run options</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm text-neutral-600">
          <div>
            <div className="mb-1 text-xs font-medium uppercase tracking-wide text-neutral-400">Run mode</div>
            <ul className="space-y-1">
              <li>
                <Badge variant="secondary" className="mr-2 font-mono">batch</Badge>
                Asynchronous, cost-bounded (default). Uses the Anthropic Batch API.
              </li>
              <li>
                <Badge variant="secondary" className="mr-2 font-mono">sync</Badge>
                Inline results — needs an API key; best for small runs.
              </li>
              <li>
                <Badge variant="secondary" className="mr-2 font-mono">preview</Badge>
                No LLM — clustering + retrieval only, to inspect groupings before spending credits.
              </li>
            </ul>
          </div>
          <div>
            <div className="mb-1 text-xs font-medium uppercase tracking-wide text-neutral-400">CDE catalog</div>
            <ul className="space-y-1">
              <li>
                <span className="font-medium text-ph-ink">NIH-endorsed</span> — a focused, curated set. Fewer,
                higher-signal candidates.
              </li>
              <li>
                <span className="font-medium text-ph-ink">Full repo</span> — the complete catalog (~22.7k). Broader
                coverage, more candidates to weigh.
              </li>
            </ul>
          </div>
        </CardContent>
      </Card>

      {/* 6 · How each concept is classified ---------------------------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Sparkles className="h-4 w-4 text-ph-navy" /> How each concept is classified
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-3">
          <VerdictCard
            verdict="adopt"
            icon={<CheckCircle2 className="h-4 w-4" />}
            title="Adopt"
            body="A CDE fits as-is. Use the standard directly; values already align."
          />
          <VerdictCard
            verdict="refine"
            icon={<Pencil className="h-4 w-4" />}
            title="Refine"
            body="A CDE fits, but values need a transform — a recode, a unit conversion, or a formula."
          />
          <VerdictCard
            verdict="novel"
            icon={<Sparkles className="h-4 w-4" />}
            title="Novel"
            body="No existing CDE fits well. A candidate GenCDE is proposed for a new standard."
          />
        </CardContent>
      </Card>

      {/* 7 · You're in the loop ---------------------------------------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <UserCheck className="h-4 w-4 text-ph-navy" /> You're in the loop
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm leading-relaxed text-neutral-600">
          <p>
            ddharmon is built for <span className="font-medium text-ph-ink">expert-in-the-loop (EITL)</span> review —
            the AI drafts, a human decides. Every concept arrives with a verdict, a{" "}
            <span className="font-medium">confidence score</span>, its ranked CDE candidates, and the exact transform,
            so you can <span className="font-medium text-success">approve</span>,{" "}
            <span className="font-medium text-warning">refine</span>, or{" "}
            <span className="font-medium text-danger">reject</span> each — in the review queue or the candidate
            workbench. Export the whole queue as a TSV to split review across your team.
          </p>
          <div className="flex items-start gap-2 rounded-md border border-neutral-200 p-3">
            <Gauge className="mt-0.5 h-4 w-4 shrink-0 text-ph-navy" />
            <p className="text-xs leading-relaxed">
              <span className="font-medium text-neutral-700">Confidence score</span> = the semantic similarity (0–1,
              cosine) between your field and the chosen CDE; higher means stronger support for the match. Use it to
              triage — skim the high-confidence adopts, and spend your time on low-confidence, “floored”, and novel
              items, which the queue flags for exactly that reason.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* 8 · Learn more ------------------------------------------------------------------------ */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Learn more</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-neutral-600">
          <ul className="grid gap-1.5 sm:grid-cols-2">
            <li>
              <A href={REF.cde}>NIH CDE Repository</A> — the Common Data Element catalog
            </li>
            <li>
              <A href={REF.loinc}>LOINC</A> · <A href={REF.snomed}>SNOMED CT</A> — coding standards
            </li>
            <li>
              <A href={REF.sssom}>SSSOM</A> — a portable format for sharing mappings
            </li>
            <li>
              <A href={REF.fair}>FAIR principles</A> — why harmonization matters
            </li>
            <li>
              <A href={REF.bertopic}>BERTopic</A> — the topic-clustering method behind grouping
            </li>
            <li>
              <A href={REF.hitl}>Expert-in-the-loop (EITL)</A> — the human review step
            </li>
            <li>
              <A href="https://harmonydata.ac.uk">Harmony</A> — related semantic questionnaire-item matching
            </li>
          </ul>
          <p className="pt-1 text-xs text-neutral-400">
            Want the under-the-hood detail? See{" "}
            <Link href="/methods" className="text-ph-navy underline hover:text-ph-ink">
              Methods
            </Link>{" "}
            for a stage-by-stage walk of the pipeline. The{" "}
            <Link href="/related" className="text-ph-navy underline hover:text-ph-ink">
              Related work
            </Link>{" "}
            tab covers the fuller ecosystem of tools and groups.
          </p>
        </CardContent>
      </Card>

      <div className="flex items-center justify-between rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3">
        <p className="text-sm text-neutral-600">
          Ready to try it? Start a run, or load a precomputed demo — no API credits needed.
        </p>
        <Button asChild size="sm">
          <Link href="/new">
            New run <ArrowRight className="ml-1.5 h-4 w-4" />
          </Link>
        </Button>
      </div>
    </div>
  );
}

function VerdictCard({
  verdict,
  icon,
  title,
  body,
}: {
  verdict: string;
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="rounded-lg border border-neutral-200 p-3">
      <Badge variant="outline" className={`gap-1.5 ${VERDICT_STYLES[verdict] ?? ""}`}>
        {icon}
        {title}
      </Badge>
      <p className="mt-2 text-xs leading-relaxed text-neutral-600">{body}</p>
    </div>
  );
}

function Step({ n, icon, title, body }: { n: number; icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="flex gap-3">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-ph-navy/10 text-ph-navy">
        {icon}
      </div>
      <div>
        <div className="font-medium text-neutral-700">
          <span className="mr-1.5 text-neutral-400">{n}.</span>
          {title}
        </div>
        <p className="text-neutral-600">{body}</p>
      </div>
    </div>
  );
}

function FieldItem({ name, required, children }: { name: string; required?: boolean; children: React.ReactNode }) {
  return (
    <li className="flex items-baseline gap-2">
      <code className="shrink-0 rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-ph-ink">{name}</code>
      {required && <span className="text-xs font-medium text-ph-crimson">required</span>}
      <span>— {children}</span>
    </li>
  );
}

function OutputItem({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
      <span>{children}</span>
    </li>
  );
}
