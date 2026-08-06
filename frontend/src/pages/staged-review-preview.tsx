// ─────────────────────────────────────────────────────────────────────────────────────────────
// DESIGN PREVIEW — "Staged review" (roadmap item, NOT built).
//
// A clickable mockup of the proposed four-gate review flow, linked from /roadmap. Nothing on this page
// runs a pipeline, calls a model, or reads a real run: the groups below are illustrative fixtures. The
// ONE thing that is real is the cost arithmetic — it calls the same `estimateRunCost` the New Run form
// uses, so the "step 1 is free, you choose what to spend on" claim can be checked live rather than
// asserted.
//
// PUBLIC surface, same rules as /roadmap and /design: no internal run ids, no research-run numbers, no
// internal cohort specifics. Cohort names used below are the public example set already named on the
// roadmap. Stage cost SHARES come from the shipped estimator in `types.ts`, not from any research run.
// ─────────────────────────────────────────────────────────────────────────────────────────────
import { useMemo, useState } from "react";
import { Link } from "wouter";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Ban,
  Check,
  CircleHelp,
  FlaskConical,
  Layers,
  Pencil,
  Scissors,
  Sparkles,
  Wallet,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { estimateRunCost, formatUsd } from "@/types";

// ── illustrative fixtures ─────────────────────────────────────────────────────────────────────
// Plausible, public-safe stand-ins. Flags mirror the signals the pipeline already computes today but
// does not yet surface (group granularity, off-theme members, weak match support).
type Flag = "split" | "qualify" | "mismatch" | "weak" | null;

interface MockGroup {
  name: string;
  vars: number;
  cohorts: string[];
  flag: Flag;
  axis?: string;
  detail?: string;
  values?: string[];
}

const GROUPS: MockGroup[] = [
  {
    name: "Blood pressure",
    vars: 12,
    cohorts: ["AoU", "MESA", "UKBB", "CLSA"],
    flag: "split",
    axis: "measurement",
    detail: "systolic, diastolic and pulse appear fused into one group",
  },
  {
    name: "Milk consumption",
    vars: 8,
    cohorts: ["UKBB", "CLSA", "AoU"],
    flag: "qualify",
    axis: "fat content",
    values: ["whole", "semi-skimmed", "skimmed"],
    detail: "likely one concept with a qualifier slot — advisory only",
  },
  { name: "Age at visit", vars: 5, cohorts: ["AoU", "CLSA", "MESA", "UKBB", "AI-READI"], flag: null },
  { name: "Standing height", vars: 5, cohorts: ["AoU", "CLSA", "MESA", "UKBB", "AI-READI"], flag: null },
  { name: "Current smoking status", vars: 9, cohorts: ["AoU", "CLSA", "UKBB"], flag: null },
  {
    name: "Physical activity — vigorous",
    vars: 7,
    cohorts: ["UKBB", "CLSA"],
    flag: "weak",
    detail: "closest element matched with low support",
  },
];

const STEPS = [
  { n: 1, title: "Concept groups", sub: "Are these each one concept, and which do I care about?", icon: Layers },
  { n: 2, title: "Concepts → CDEs", sub: "Is this the right element, and is the proposed one any good?", icon: Sparkles },
  { n: 3, title: "Transform specs", sub: "Is this recode correct?", icon: FlaskConical },
  { n: 4, title: "Export", sub: "What ships, and to whom?", icon: ArrowRight },
] as const;

const FLAG_STYLE: Record<Exclude<Flag, null>, { cls: string; label: string }> = {
  split: { cls: "border-warning/40 bg-warning-bg text-warning", label: "may be more than one concept" },
  qualify: { cls: "border-neutral-300 bg-neutral-50 text-neutral-500", label: "qualifier axis" },
  mismatch: { cls: "border-danger/40 bg-danger/5 text-danger", label: "right values, wrong concept" },
  weak: { cls: "border-warning/40 bg-warning-bg text-warning", label: "weak support" },
};

export default function StagedReviewPreviewPage() {
  const [step, setStep] = useState(1);
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <Link href="/roadmap" className="mb-1 flex items-center gap-1 text-xs text-neutral-500 hover:text-ph-navy">
          <ArrowLeft className="h-3 w-3" /> Back to roadmap
        </Link>
        <h1 className="text-2xl font-semibold text-ph-ink">Staged review</h1>
        <p className="mt-1 text-sm text-neutral-500">
          A proposed change to how you review a run: four gates, one per stage of the pipeline, instead of
          one page that asks for every judgement at once.
        </p>
      </div>

      <div className="flex items-start gap-2 rounded-lg border border-ph-navy/20 bg-ph-navy/5 px-4 py-3 text-sm text-neutral-600">
        <CircleHelp className="mt-0.5 h-4 w-4 shrink-0 text-ph-navy" />
        <span>
          <b className="text-ph-ink">This is a design preview — nothing here runs.</b> The groups shown are
          illustrative. The cost figures are live, computed by the same estimator the New Run form uses.
        </span>
      </div>

      {/* ── why ─────────────────────────────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Why change it</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-neutral-600">
          <p>
            Today&apos;s workbench asks you to judge a <b>transform spec</b>, written against a{" "}
            <b>Common Data Element</b> you never approved, for a <b>concept group</b> you never validated —
            three decisions on one screen, with no way to isolate which one went wrong. Because the stages
            feed each other, a mis-grouped concept quietly becomes a wrong element and then a wrong recode.
          </p>
          <p>
            It also means you pay for the whole run before you see anything. Grouping variables is local
            work — no model involved — so it can happen first, for free, and you can decide what is worth
            sending to the paid stages.
          </p>
          <p className="text-xs text-neutral-400">
            The staged shape follows established retrospective-harmonization guidance, which separates
            defining target variables from assessing which studies can supply them, from processing the
            data, from disseminating the result — see the{" "}
            <Link href="/related" className="text-ph-navy hover:underline">
              related work
            </Link>{" "}
            and{" "}
            <Link href="/methods" className="text-ph-navy hover:underline">
              methods
            </Link>{" "}
            pages.
          </p>
        </CardContent>
      </Card>

      {/* ── stepper ─────────────────────────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {STEPS.map((s) => {
          const active = s.n === step;
          return (
            <button
              key={s.n}
              onClick={() => setStep(s.n)}
              className={`rounded-lg border px-3 py-2.5 text-left transition-colors ${
                active ? "border-ph-navy/40 bg-ph-navy/5" : "border-neutral-200 hover:bg-neutral-50"
              }`}
            >
              <div className="flex items-center gap-1.5">
                <s.icon className={`h-3.5 w-3.5 ${active ? "text-ph-navy" : "text-neutral-400"}`} />
                <span className={`text-xs font-medium ${active ? "text-ph-navy" : "text-neutral-500"}`}>
                  Step {s.n}
                </span>
              </div>
              <div className={`mt-0.5 text-sm font-medium ${active ? "text-ph-ink" : "text-neutral-600"}`}>
                {s.title}
              </div>
            </button>
          );
        })}
      </div>

      <p className="-mt-2 text-sm italic text-neutral-500">{STEPS[step - 1].sub}</p>

      {step === 1 && <StepOne />}
      {step === 2 && <StepTwo />}
      {step === 3 && <StepThree />}
      {step === 4 && <StepFour />}

      <div className="flex items-center justify-between">
        <Button variant="outline" size="sm" disabled={step === 1} onClick={() => setStep((s) => s - 1)}>
          <ArrowLeft className="mr-1.5 h-4 w-4" /> Previous step
        </Button>
        <Button size="sm" disabled={step === 4} onClick={() => setStep((s) => s + 1)}>
          Next step <ArrowRight className="ml-1.5 h-4 w-4" />
        </Button>
      </div>

      {/* ── open questions ──────────────────────────────────────────────────────────────────── */}
      <Card className="border-dashed">
        <CardHeader>
          <CardTitle className="text-base">Open questions</CardTitle>
          <p className="text-xs text-neutral-400">
            Decisions still to make — the point of previewing this before building it.
          </p>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2.5 text-sm text-neutral-600">
            {[
              "Scope before triage, or triage before scope? A large corpus produces more flagged groups than anyone wants to clear, so the subset control probably has to come first — and the flag count should be reported for the selection, not the whole corpus.",
              "How much editing belongs in step 1? Moving a variable between groups is cheap to support. Splitting, merging and creating a group from scratch each add more.",
              "Should a step be skippable? Accepting every group unchanged is a legitimate choice, and forcing four gates on someone re-running a known configuration would be worse than today.",
              "Where do composite scores get confirmed? They can be proposed at step 1, but whether they are actually computable can only be judged once elements are assigned at step 2.",
              "Two model queues instead of one. Splitting the paid work in two adds a second wait. Running a smaller selection interactively may be the better trade.",
            ].map((q) => (
              <li key={q} className="flex gap-2">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-neutral-300" />
                <span>{q}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}

// ── Step 1 — the interactive one ──────────────────────────────────────────────────────────────
// Granularity and selection are live so the cost gate can be felt, not just described. Field counts
// scale off the illustrative corpus size below; the money comes from the shipped estimator.
const CORPUS_FIELDS = 7451;
const CORPUS_COHORTS = 5;

function StepOne() {
  const [granularity, setGranularity] = useState(50);
  const [picked, setPicked] = useState<Record<string, boolean>>({ "Blood pressure": true, "Age at visit": true });

  // Looser grouping -> fewer, larger groups and fewer leftovers. Illustrative, not a model.
  const shaped = useMemo(() => {
    const t = granularity / 100;
    return {
      groups: Math.round(3900 - t * 900),
      flagged: Math.round(480 + t * 150),
      unassigned: Math.round(1000 - t * 500),
    };
  }, [granularity]);

  const chosen = GROUPS.filter((g) => picked[g.name]);
  const chosenVars = chosen.reduce((s, g) => s + g.vars, 0);
  const allVars = GROUPS.reduce((s, g) => s + g.vars, 0);
  // The six groups above stand in for a whole corpus, so the selected fraction of THEM is applied to the
  // corpus size to get a field count the estimator can price at a realistic magnitude.
  const selectedFields = Math.round((chosenVars / allVars) * CORPUS_FIELDS);
  const full = estimateRunCost(CORPUS_FIELDS, CORPUS_COHORTS, "batch");
  const partial = estimateRunCost(selectedFields, CORPUS_COHORTS, "batch");
  const flaggedInScope = chosen.filter((g) => g.flag === "split" || g.flag === "weak").length;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="space-y-1">
          <CardTitle className="text-base">Step 1 · Concept groups</CardTitle>
          <p className="text-xs text-neutral-400">
            Runs on your machine. No model is called, so this step is free and you can adjust it as much as
            you like before committing to anything.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* granularity */}
          <div className="rounded-md border border-neutral-200 p-3">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium uppercase tracking-wide text-neutral-500">Grouping</span>
              <span className="text-neutral-400">
                {granularity < 35 ? "tighter — more, narrower groups" : granularity > 65 ? "looser — fewer, broader groups" : "balanced"}
              </span>
            </div>
            <Slider
              className="my-3"
              value={[granularity]}
              onValueChange={([v]) => setGranularity(v)}
              min={0}
              max={100}
              step={5}
            />
            <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs tabular-nums text-neutral-500">
              <span>
                <b className="text-neutral-700">{shaped.groups.toLocaleString()}</b> groups
              </span>
              <span>
                <b className="text-neutral-700">{shaped.flagged}</b> need a closer look
              </span>
              <span>
                <b className="text-neutral-700">{shaped.unassigned}</b> variables in no group
              </span>
            </div>
            <p className="mt-2 text-[11px] text-neutral-400">
              Looser grouping pools more variables together, which means fewer leftovers but coarser
              concepts — the trade-off is between how much you can combine and how much detail survives.
            </p>
          </div>

          {/* groups */}
          <div className="space-y-1.5">
            {GROUPS.map((g) => {
              const on = !!picked[g.name];
              const f = g.flag ? FLAG_STYLE[g.flag] : null;
              return (
                <label
                  key={g.name}
                  className={`flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2.5 transition-colors ${
                    on ? "border-ph-navy/30 bg-ph-navy/5" : "border-neutral-200 hover:bg-neutral-50"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => setPicked((p) => ({ ...p, [g.name]: !p[g.name] }))}
                    className="mt-1 h-3.5 w-3.5 accent-ph-navy"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-neutral-700">{g.name}</span>
                      {f && (
                        <Badge variant="outline" className={`gap-1 px-1.5 py-0 text-[10px] ${f.cls}`}>
                          {g.flag === "split" && <Scissors className="h-3 w-3" />}
                          {g.flag === "weak" && <AlertTriangle className="h-3 w-3" />}
                          {f.label}
                          {g.axis ? `: ${g.axis}` : ""}
                        </Badge>
                      )}
                    </span>
                    <span className="mt-0.5 block text-xs text-neutral-400">
                      {g.vars} variables · {g.cohorts.join(", ")}
                    </span>
                    {g.detail && <span className="mt-0.5 block text-xs italic text-neutral-500">{g.detail}</span>}
                    {g.values && (
                      <span className="mt-1 flex flex-wrap gap-1">
                        {g.values.map((v) => (
                          <span key={v} className="rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-500">
                            {v}
                          </span>
                        ))}
                      </span>
                    )}
                    {g.flag === "split" && (
                      <span className="mt-1.5 flex gap-1.5">
                        <Button size="sm" variant="outline" className="h-6 gap-1 text-[11px]" disabled>
                          <Scissors className="h-3 w-3" /> Split into 3
                        </Button>
                        <Button size="sm" variant="ghost" className="h-6 text-[11px]" disabled>
                          Keep as one
                        </Button>
                        <Button size="sm" variant="ghost" className="h-6 gap-1 text-[11px]" disabled>
                          <Pencil className="h-3 w-3" /> Edit members
                        </Button>
                      </span>
                    )}
                  </span>
                </label>
              );
            })}
          </div>

          {/* the gate */}
          <div className="rounded-md border border-success/30 bg-success-bg/40 px-3 py-3">
            <div className="flex items-start gap-2">
              <Wallet className="mt-0.5 h-4 w-4 shrink-0 text-success" />
              <div className="min-w-0 flex-1 space-y-1">
                <div className="text-sm font-medium text-ph-ink">
                  {chosen.length} group{chosen.length === 1 ? "" : "s"} selected
                  <span className="ml-1 font-normal text-neutral-500">
                    ·{" "}
                    {flaggedInScope === 0
                      ? "none need a closer look"
                      : `${flaggedInScope} still ${flaggedInScope === 1 ? "needs" : "need"} a closer look`}
                  </span>
                </div>
                <div className="text-xs text-neutral-600">
                  Continuing sends only what you selected to the model stages —{" "}
                  <b className="tabular-nums text-ph-ink">{formatUsd(partial.mid)}</b> instead of{" "}
                  <b className="tabular-nums">{formatUsd(full.mid)}</b> for the whole corpus.
                </div>
                <div className="text-[11px] text-neutral-400">
                  Estimated with the same calculator as the New Run form. Actual cost depends on your model
                  and provider.
                </div>
              </div>
              <Button size="sm" disabled className="shrink-0">
                Continue <ArrowRight className="ml-1.5 h-4 w-4" />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <WhatChanges
        now="One page shows every concept the run produced, already assigned to elements, already carrying recodes. Grouping is fixed by the time you see it, and the whole run is already paid for."
        proposed="Grouping comes first, costs nothing, and is adjustable. You fix mis-grouped concepts before they propagate, drop what you don't need, and only then commit to the paid stages."
      />
    </div>
  );
}

function StepTwo() {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="space-y-1">
          <CardTitle className="text-base">Step 2 · Concepts → Common Data Elements</CardTitle>
          <p className="text-xs text-neutral-400">
            Runs only on what you kept. For each group: the ranked candidate elements the pipeline
            considered, and — where nothing fits — a proposed new element built from the pooled variables.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="rounded-md border border-neutral-200">
            <div className="border-b border-neutral-100 px-3 py-2 text-sm font-medium text-neutral-700">
              Blood pressure, systolic
              <span className="ml-2 text-xs font-normal text-neutral-400">4 variables · AoU, MESA, UKBB, CLSA</span>
            </div>
            <div className="divide-y divide-neutral-100">
              {[
                { id: "Systolic Blood Pressure Measurement", cos: 0.782, chosen: true, axis: null },
                { id: "Blood Pressure Systolic Seated", cos: 0.771, chosen: false, axis: "qualifier: posture" },
                { id: "Mean Arterial Pressure", cos: 0.654, chosen: false, axis: "scope" },
              ].map((c, i) => (
                <div key={c.id} className="flex items-center gap-2 px-3 py-2 text-xs">
                  <span className="w-4 tabular-nums text-neutral-400">{i + 1}</span>
                  <span className="min-w-0 flex-1">
                    <span className="font-medium text-neutral-700">{c.id}</span>
                    {c.axis && <span className="ml-2 text-neutral-400">would need to change — {c.axis}</span>}
                  </span>
                  <span className="tabular-nums text-neutral-500">{c.cos.toFixed(3)}</span>
                  {c.chosen ? (
                    <Badge variant="outline" className="border-success/40 bg-success-bg text-[10px] text-success">
                      selected
                    </Badge>
                  ) : (
                    <Button size="sm" variant="outline" className="h-6 text-[11px]" disabled>
                      Choose this
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </div>
          <p className="text-xs text-neutral-500">
            The new affordance is the last column: today the alternatives are shown but cannot be picked. If
            the model&apos;s choice is wrong and you can see the right one, you should be able to say so —
            and the recodes downstream re-generate against your choice.
          </p>
        </CardContent>
      </Card>
      <WhatChanges
        now="Ranked alternatives are displayed read-only. Your only options are approve, refine or reject the choice that was made."
        proposed="Pick a different element. Each candidate says what would have to change about it to fit, so the choice is informed."
      />
    </div>
  );
}

function StepThree() {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="space-y-1">
          <CardTitle className="text-base">Step 3 · Transform specs</CardTitle>
          <p className="text-xs text-neutral-400">
            Generated only for elements you approved. One recipe per source variable, showing exactly what it
            does.
          </p>
        </CardHeader>
        <CardContent className="space-y-2">
          {[
            { kind: "unit", src: "MESA:sbp1c", body: "target = source × 1 (mmHg → mmHg)", cov: 100 },
            { kind: "categorical", src: "CLSA:smk_status", body: "3 codes mapped, 1 unmapped", cov: 75 },
            { kind: "arithmetic", src: "UKBB:21001", body: "weight_kg / (height_m ^ 2)", cov: 100, review: true },
          ].map((t) => (
            <div key={t.src} className="rounded border border-neutral-100 px-3 py-2 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="secondary" className="font-mono text-[10px]">
                  {t.kind}
                </Badge>
                <span className="font-mono text-neutral-600">{t.src}</span>
                <span className="text-neutral-300">→</span>
                <span className="text-neutral-600">{t.body}</span>
                <span className="text-neutral-400">coverage {t.cov}%</span>
                {t.review && (
                  <Badge variant="outline" className="border-warning/40 text-[10px] text-warning">
                    always reviewed
                  </Badge>
                )}
                <span className="ml-auto flex gap-0.5 text-neutral-300">
                  <Check className="h-4 w-4" />
                  <Pencil className="h-4 w-4" />
                  <Ban className="h-4 w-4" />
                </span>
              </div>
            </div>
          ))}
          <p className="pt-1 text-xs text-neutral-500">
            Largely what the workbench already does well, and it stays. The change is upstream: by this
            point the group and the target element have both been confirmed, so a wrong recode is a recode
            problem rather than an inherited one.
          </p>
        </CardContent>
      </Card>
      <WhatChanges
        now="Recodes are presented alongside groups and elements you have not yet approved, so a mistake anywhere reads as a spec problem."
        proposed="Only recodes for confirmed targets reach this step. Anything you changed earlier arrives flagged for re-generation."
      />
    </div>
  );
}

function StepFour() {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="space-y-1">
          <CardTitle className="text-base">Step 4 · Export</CardTitle>
          <p className="text-xs text-neutral-400">Choose what leaves the tool.</p>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-neutral-600">
          {[
            ["Runnable notebook (Python / R)", "Applies the approved recodes to your data — the data never has to leave your environment."],
            ["Mapping table", "Every source variable, its target element, and the recipe."],
            ["Review log", "Who decided what, and the note they left. The audit trail for the run."],
            ["Proposed new elements", "Any elements the run proposed, ready for submission."],
            ["Composite score recipes", "With a clear statement of which cohorts can and cannot compute each one."],
          ].map(([t, d]) => (
            <div key={t} className="flex items-start gap-2.5 rounded border border-neutral-100 px-3 py-2">
              <input type="checkbox" defaultChecked className="mt-1 h-3.5 w-3.5 accent-ph-navy" disabled />
              <span>
                <span className="text-sm font-medium text-neutral-700">{t}</span>
                <span className="mt-0.5 block text-xs text-neutral-400">{d}</span>
              </span>
            </div>
          ))}
        </CardContent>
      </Card>
      <WhatChanges
        now="Export is all-or-nothing per format, from the run as a whole."
        proposed="Pick what ships. The review log becomes a deliverable in its own right rather than a by-product."
      />
    </div>
  );
}

function WhatChanges({ now, proposed }: { now: string; proposed: string }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2.5">
        <div className="text-[11px] font-medium uppercase tracking-wide text-neutral-400">Today</div>
        <p className="mt-1 text-xs text-neutral-600">{now}</p>
      </div>
      <div className="rounded-md border border-ph-navy/20 bg-ph-navy/5 px-3 py-2.5">
        <div className="text-[11px] font-medium uppercase tracking-wide text-ph-navy">Proposed</div>
        <p className="mt-1 text-xs text-neutral-600">{proposed}</p>
      </div>
    </div>
  );
}
