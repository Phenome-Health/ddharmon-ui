import { Link } from "wouter";
import {
  ArrowRight,
  Bot,
  Coins,
  CheckCircle2,
  Download,
  ExternalLink,
  Flashlight,
  GitCompareArrows,
  Layers,
  Pencil,
  Settings2,
  Sparkles,
  Wand2,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { REF } from "@/lib/links";
import { REVIEW_MODE_COPY } from "@/lib/review-mode";
import { VERDICT_STYLES } from "@/types";
import { AUTH_ENABLED, useAuthState } from "@/auth";
import { GATE_LABELS } from "@/components/gate/GateRail";

/**
 * The Guide — rewritten 2026-11-05 for the STAGED flow (Set up → Gates 1–4, paid gate by gate). The old page described
 * the v1 flow (one run, then a review queue / workbench). Where a screen already states a fact in its own words (the
 * review modes, the run modes, the export tiles), this page says the same thing, so the guide and the screen cannot
 * drift into two different promises.
 */

/** Inline external link, styled + with an icon. */
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

export default function GuidePage() {
  const { isGuest } = useAuthState();
  const guest = AUTH_ENABLED && isGuest;
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="font-display text-xl font-semibold text-on-field">How ddharmon works</h1>
        <p className="mt-1 text-sm text-on-field-muted">
          Harmonizing cohort data dictionaries onto Common Data Elements: what you provide, what happens at each step
          of a run, and what you take away.
        </p>
      </div>

      {/* 1 · The problem it solves ------------------------------------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <GitCompareArrows className="h-4 w-4 text-accent-on-raised" /> The problem it solves
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm leading-relaxed text-on-raised">
          <p>
            Different studies describe the same measurement in different words — <code>bmi</code> in one cohort,{" "}
            <code>body_mass_index</code> in another, <code>Q47_weight_kg</code> in a third — and the same survey
            question gets reworded from study to study. One study asks{" "}
            <span className="italic text-on-raised">“In general, would you say your health is…”</span>; another records
            the same thing as <span className="italic text-on-raised">“Overall health rating”</span> under a variable
            named <code>2178</code>. String matching misses these. Before you can pool cohorts for an analysis, those
            variables have to be mapped to a shared standard.
          </p>
          <p>
            <span className="font-semibold text-on-raised">ddharmon</span> reads the <em>data dictionaries</em> (the
            metadata that describes each variable) from two or more cohorts, groups the variables that mean the same
            thing, and maps each concept to a <A href={REF.cde}>Common Data Element (CDE)</A> — a curated, reusable
            standard definition from the NIH CDE Repository, often coded with <A href={REF.loinc}>LOINC</A> or{" "}
            <A href={REF.snomed}>SNOMED CT</A>. For every mapping it also drafts a{" "}
            <span className="font-semibold text-on-raised">transform spec</span>: the recipe for converting each
            cohort's values into the CDE's form. The AI proposes at every step; you review and decide.
          </p>
        </CardContent>
      </Card>

      {/* 2 · What you provide / get back ------------------------------------------------------- */}
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">What you provide</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-on-raised">
            <p>One data dictionary per cohort (CSV or TSV), one row per variable. Map at least one of:</p>
            <ul className="space-y-1">
              <FieldItem name="variable_name">
                the variable's identifier or code — optional; generated if you leave it out
              </FieldItem>
              <FieldItem name="description">a human-readable definition</FieldItem>
              <FieldItem name="question_text">the survey question, if there is one</FieldItem>
            </ul>
            <p className="pt-1">
              Optional fields sharpen the result — <code>value_encoding</code> (response options), <code>units</code>,{" "}
              <code>data_type</code> — above all for the transform specs.
            </p>
            <p className="text-xs text-on-raised-muted">
              Dictionaries only: metadata about your variables, never participant-level data.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">What you get back</CardTitle>
          </CardHeader>
          <CardContent data-testid="guide-get-back" className="space-y-2 text-sm text-on-raised">
            <p>At the end of a run you download the files you pick, as one zip:</p>
            <ul className="space-y-1.5">
              <OutputItem>
                <span className="font-semibold text-on-raised">Transform notebook</span> (Python or R) that applies the
                harmonization to your data in your own environment — your data never enters ddharmon
              </OutputItem>
              <OutputItem>
                <span className="font-semibold text-on-raised">Expert-review queue</span> (TSV) — one row per concept,
                with its verdict, confidence, ranked CDE candidates and transform
              </OutputItem>
              <OutputItem>
                <span className="font-semibold text-on-raised">Decision log</span> (CSV) — every decision made during
                review, with what it changed from and to
              </OutputItem>
              <OutputItem>
                <span className="font-semibold text-on-raised">Records</span> (JSON) — the full machine-readable result
              </OutputItem>
              <OutputItem>
                <span className="font-semibold text-on-raised">Concept Spotlight</span> (JSON), when you declared one (see
                below) —
                its items, per-cohort coverage and the derivation recipe
              </OutputItem>
            </ul>
          </CardContent>
        </Card>
      </div>

      {/* 3 · A run, step by step --------------------------------------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <Layers className="h-4 w-4 text-accent-on-raised" /> A run, step by step
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm text-on-raised">
          <p className="leading-relaxed">
            A run moves through Set up and four review gates. Each gate shows what the pipeline proposed and, in Guided
            mode, waits for you before the next step runs.
          </p>
          <Step
            label={GATE_LABELS.setup}
            icon={<Settings2 className="h-4 w-4" />}
            title="Add your dictionaries and choose how to run"
          >
            Add one dictionary per cohort and map each file's columns to roles. Check the row count against the
            unique-name count (a repeated variable name is dropped), and download the prepared text to read exactly what
            will be grouped. Then pick a run mode, a review mode and a model, and paste your Anthropic key. Everything
            before Start run is free.
          </Step>
          <Step
            label="Gate 1"
            icon={<Layers className="h-4 w-4" />}
            title={GATE_LABELS.gate1}
          >
            Each row is a group of variables, across your cohorts, that mean the same thing. Search and filter, open a
            group to see every variable in it and any proposed division, and drag a variable onto another group (or out
            to <span className="italic">In no group</span>) to fix it. Tick the groups you want to take forward.
          </Step>
          <Step
            label="Gate 2"
            icon={<GitCompareArrows className="h-4 w-4" />}
            title={GATE_LABELS.gate2}
          >
            For each concept, compare the ranked candidate CDEs against a generated description of the ideal element,
            and choose the target — an existing CDE, or a proposed GenCDE when none fits.
          </Step>
          <Step
            label="Gate 3"
            icon={<Wand2 className="h-4 w-4" />}
            title={GATE_LABELS.gate3}
          >
            Work through the recodes and unit or arithmetic conversions, concept by concept. Settle any source value
            that maps to nothing — add it, map it, or record the loss — and recheck anything marked stale because its
            target changed at Gate 2.
          </Step>
          <Step label="Gate 4" icon={<Download className="h-4 w-4" />} title={GATE_LABELS.gate4}>
            Choose Python or R for the notebook, tick the files you want, preview each, and download them. The decision
            log records every call made along the way, so you can defend a mapping later.
          </Step>
        </CardContent>
      </Card>

      {/* 4 · What it costs (Lavish note 7, 2026-11-06: every cost fact in ONE place) ---------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <Coins className="h-4 w-4 text-accent-on-raised" /> What it costs
          </CardTitle>
        </CardHeader>
        <CardContent data-testid="guide-cost" className="space-y-3 text-sm leading-relaxed text-on-raised">
          <p>
            Only the model calls cost money, and Anthropic bills them to the key you paste on Set up. Uploading,
            mapping, reviewing and exporting are free. Every paid button shows its amount before you press it.
          </p>
          <ul className="space-y-1.5">
            <CostItem when="Start run">naming the concept groups, splitting mixed ones and checking each group.</CostItem>
            <CostItem when="Gate 1's Continue">
              matching the groups you ticked to CDEs, and drafting a GenCDE where none fits.
            </CostItem>
            <CostItem when="Gate 2's Continue">drafting the transform specs.</CostItem>
            <CostItem when="Gate 3 → Gate 4 and the export">free.</CostItem>
          </ul>
          <p>
            In Full auto, Start run quotes and pays for the whole run at once. Batch mode costs about half as much as
            synchronous; Preview calls no model and is free. For scale, the demo — 5 cohorts, 1,000 variables, batch
            mode — cost $5.47 from start to export.
          </p>
        </CardContent>
      </Card>

      {/* 5 · Choosing run options -------------------------------------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Choosing run options</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm text-on-raised">
          <div>
            <div className="mb-1 text-xs font-semibold uppercase tracking-eyebrow text-on-raised-muted">Review</div>
            <ul className="space-y-1">
              <li>
                <Badge variant="secondary" className="mr-2">{REVIEW_MODE_COPY.guided.label}</Badge>
                {REVIEW_MODE_COPY.guided.sentence} The default.
              </li>
              <li>
                <Badge variant="secondary" className="mr-2">{REVIEW_MODE_COPY.auto.label}</Badge>
                {REVIEW_MODE_COPY.auto.sentence} Every gate stays open to review afterwards, marked{" "}
                <span className="italic">not reviewed</span>.
              </li>
            </ul>
          </div>
          <div>
            <div className="mb-1 text-xs font-semibold uppercase tracking-eyebrow text-on-raised-muted">Run mode</div>
            <ul className="space-y-1">
              <li>
                <Badge variant="secondary" className="mr-2 font-mono">batch</Badge>
                Can take hours. The default, and the cheaper one.
              </li>
              <li>
                <Badge variant="secondary" className="mr-2 font-mono">sync</Badge>
                Minutes.
              </li>
              <li>
                <Badge variant="secondary" className="mr-2 font-mono">preview</Badge>
                No model call — grouping and CDE retrieval only, to inspect a run before you spend.
              </li>
            </ul>
          </div>
          <div>
            <div className="mb-1 text-xs font-semibold uppercase tracking-eyebrow text-on-raised-muted">
              Model and key
            </div>
            <p>
              Pick a model and paste your Anthropic key on Set up. The key is held in this browser tab only — never
              stored, and gone when you reload.
            </p>
          </div>
          <div>
            <div className="mb-1 text-xs font-semibold uppercase tracking-eyebrow text-on-raised-muted">CDE catalog</div>
            <ul className="space-y-1">
              <li>
                <span className="font-semibold text-on-raised">Full repository</span> (the default) — the complete
                catalog (~22.7k). Broader coverage, including common measures such as body weight, PHQ and PROMIS; more
                candidates to weigh.
              </li>
              <li>
                <span className="font-semibold text-on-raised">NIH-endorsed</span> — a focused, curated set. Fewer,
                higher-signal candidates, but without those common measures, which then come out as GenCDEs.
              </li>
            </ul>
          </div>
        </CardContent>
      </Card>

      {/* 6 · How each concept is classified ---------------------------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <Sparkles className="h-4 w-4 text-accent-on-raised" /> How each concept is classified
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-3">
          <VerdictCard
            verdict="adopt"
            icon={<CheckCircle2 className="h-4 w-4" />}
            title="Adopt"
            body="A CDE fits as-is. Use the standard directly; the values already align."
          />
          <VerdictCard
            verdict="refine"
            icon={<Pencil className="h-4 w-4" />}
            title="Refine"
            body="A CDE fits, but the values need a transform — a recode, a unit conversion, or a formula."
          />
          <VerdictCard
            verdict="novel"
            icon={<Sparkles className="h-4 w-4" />}
            title="Novel"
            body="No existing CDE fits well. ddharmon proposes a GenCDE — a generated element in the CDE format — as the target."
          />
        </CardContent>
      </Card>

      {/* 7 · Concept Spotlight ------------------------------------------------------------------ */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <Flashlight className="h-4 w-4 text-accent-on-raised" /> Concept Spotlight
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm leading-relaxed text-on-raised">
          <p>
            Have a published index or instrument the harmonization needs to support — a 49-item frailty index, say?
            Declare it as a Spotlight list at Gate 1 — read from the paper (PDF or Word), or typed or pasted in.
            ddharmon suggests the concept groups that
            cover each item, and Gate 4 shows which items the run covers, cohort by cohort, with the recipe for deriving
            the score on your own rows. ddharmon never computes the score itself.
          </p>
          <p className="text-xs text-on-raised-muted">
            Reading a paper is free; extracting its items and matching them against the run each cost one model call.
          </p>
        </CardContent>
      </Card>

      {/* 8 · Where AI is used ------------------------------------------------------------------ */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <Bot className="h-4 w-4 text-accent-on-raised" /> Where AI is used
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm leading-relaxed text-on-raised">
          <ul className="space-y-1.5">
            <li>
              <span className="font-semibold text-on-raised">Grouping</span> — a biomedical sentence-embedding model
              places variables with similar meaning near each other, and clustering turns them into candidate concepts.
              No model call; it runs on ddharmon's server.
            </li>
            <li>
              <span className="font-semibold text-on-raised">Naming, splitting and checking</span> — a large language
              model names each group, splits groups that mix distinct concepts, and judges whether each group holds
              together. Doubtful groups are flagged for you, never silently dropped.
            </li>
            <li>
              <span className="font-semibold text-on-raised">Finding candidates</span> — each concept is matched against
              the CDE catalog by meaning and by keywords, giving a ranked shortlist.
            </li>
            <li>
              <span className="font-semibold text-on-raised">Assignment</span> — the model weighs that shortlist and
              decides adopt, refine or novel, with a written rationale, drafting a GenCDE when nothing fits.
            </li>
            <li>
              <span className="font-semibold text-on-raised">Transform specs</span> — the model drafts the value recodes
              and unit or arithmetic conversions. Arithmetic conversions always come to you for review.
            </li>
          </ul>
          <p>
            The model steps send your dictionaries' text — never participant data — to the model, with your key.{" "}
            <span className="font-semibold text-on-raised">Every AI output is a proposal, never a silent commit.</span>
          </p>
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-rule-on-raised bg-surface-inset px-4 py-3">
        <p className="text-sm text-on-raised">
          {guest
            ? "Walk the demo: a finished run you can open gate by gate, with every control live and nothing charged. Sign in to run your own cohorts."
            : "Walk the demo — a finished run, gate by gate, nothing charged — or start a run of your own."}
        </p>
        <div className="flex gap-2">
          <Button asChild size="sm" variant="outline">
            <Link href="/demo">Open the demo</Link>
          </Button>
          {!guest && (
            <Button asChild size="sm">
              <Link href="/run/new/setup">
                New run <ArrowRight className="ml-1.5 h-4 w-4" />
              </Link>
            </Button>
          )}
        </div>
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
    <div className="rounded-lg border border-rule-on-raised p-3">
      <Badge variant="outline" className={`gap-1.5 ${VERDICT_STYLES[verdict] ?? ""}`}>
        {icon}
        {title}
      </Badge>
      <p className="mt-2 text-xs leading-relaxed text-on-raised">{body}</p>
    </div>
  );
}

/**
 * One screen of the run: where it is (Set up / Gate N) and what you do there (its cost is in "What it costs"). The
 * screen names come from `GATE_LABELS`, the rail's own, so renaming a gate renames it here too (`guide.spec.ts`).
 */
function Step({
  label,
  icon,
  title,
  children,
}: {
  label: string;
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div data-testid="guide-step" className="flex gap-3">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface-info text-accent-on-raised">
        {icon}
      </div>
      <div className="min-w-0">
        <div className="font-semibold text-on-raised">
          <span className="mr-1.5 font-mono text-xs uppercase tracking-eyebrow text-on-raised-muted">{label}</span>
          {title}
        </div>
        <p className="leading-relaxed text-on-raised">{children}</p>
      </div>
    </div>
  );
}

/** One place money moves: the control that spends it, then what it buys. */
function CostItem({ when, children }: { when: string; children: React.ReactNode }) {
  return (
    <li className="flex items-baseline gap-2">
      <span className="shrink-0 font-semibold text-on-raised">{when}</span>
      <span>— {children}</span>
    </li>
  );
}

function FieldItem({ name, required, children }: { name: string; required?: boolean; children: React.ReactNode }) {
  return (
    <li className="flex items-baseline gap-2">
      <code className="shrink-0 rounded bg-surface-inset-strong px-1.5 py-0.5 text-xs text-on-raised">{name}</code>
      {required && <span className="text-xs font-semibold text-status-destructive">required</span>}
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
