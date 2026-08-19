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
  ChevronDown,
  ChevronRight,
  FlaskConical,
  GripVertical,
  Layers,
  Pencil,
  RefreshCw,
  Scissors,
  Sparkles,
  Wallet,
} from "lucide-react";
import { PreviewShell } from "@/components/preview-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { estimateRunCost, formatUsd } from "@/types";

// ── illustrative fixtures ─────────────────────────────────────────────────────────────────────
// Plausible, public-safe stand-ins. Flags mirror the signals the pipeline already computes today but
// does not yet surface (group granularity, off-theme members, weak match support).
type Flag = "split" | "qualify" | "mismatch" | "weak" | null;

/** One source variable inside a concept group — the unit you drag. */
interface Member {
  id: string;
  cohort: string;
  name: string;
}

interface MockGroup {
  id: string;
  name: string;
  members: Member[];
  flag: Flag;
  axis?: string;
  detail?: string;
  values?: string[];
}

/** Cohorts are DERIVED from membership, so the row stays truthful as variables are dragged. */
const cohortsOf = (m: Member[]): string[] => [...new Set(m.map((x) => x.cohort))];

const SEED_GROUPS: MockGroup[] = [
  {
    id: "g-bp",
    name: "Blood pressure",
    flag: "split",
    axis: "measurement",
    detail: "systolic, diastolic and pulse appear fused into one group",
    members: [
      { id: "m1", cohort: "UKBB", name: "systolic_bp_automated" },
      { id: "m2", cohort: "MESA", name: "s1bp1" },
      { id: "m3", cohort: "CLSA", name: "BP_DIASTOLIC_FIRST" },
      { id: "m4", cohort: "AoU", name: "diastolic_bp_mmhg" },
      { id: "m5", cohort: "MESA", name: "pulse_rate_seated" },
      { id: "m6", cohort: "AI-READI", name: "bp1_diabp_vsorres" },
    ],
  },
  {
    id: "g-milk",
    name: "Milk consumption",
    flag: "qualify",
    axis: "fat content",
    values: ["whole", "semi-skimmed", "skimmed"],
    detail: "likely one concept with a qualifier slot — advisory only",
    members: [
      { id: "m7", cohort: "UKBB", name: "milk_type_used" },
      { id: "m8", cohort: "CLSA", name: "NUT_MILK_TYPE" },
      { id: "m9", cohort: "AoU", name: "dairy_milk_freq" },
      { id: "m10", cohort: "UKBB", name: "semi_skimmed_freq" },
    ],
  },
  {
    id: "g-age",
    name: "Age at visit",
    flag: null,
    members: [
      { id: "m11", cohort: "AoU", name: "age_at_visit" },
      { id: "m12", cohort: "CLSA", name: "AGE_NMBR" },
      { id: "m13", cohort: "MESA", name: "age1c" },
      { id: "m14", cohort: "UKBB", name: "age_when_attended_centre" },
      { id: "m15", cohort: "AI-READI", name: "age_vsorres" },
    ],
  },
  {
    id: "g-height",
    name: "Standing height",
    flag: null,
    members: [
      { id: "m16", cohort: "AoU", name: "height_cm" },
      { id: "m17", cohort: "CLSA", name: "HGT_HEIGHT_CM" },
      { id: "m18", cohort: "MESA", name: "htcm1" },
      { id: "m19", cohort: "UKBB", name: "standing_height" },
      { id: "m20", cohort: "AI-READI", name: "height_vsorres" },
    ],
  },
  {
    id: "g-smoke",
    name: "Current smoking status",
    flag: null,
    members: [
      { id: "m21", cohort: "AoU", name: "smoking_status" },
      { id: "m22", cohort: "CLSA", name: "SMK_CURRENT" },
      { id: "m23", cohort: "UKBB", name: "current_tobacco_smoking" },
      { id: "m24", cohort: "UKBB", name: "pack_years_adult_smoking" },
    ],
  },
  {
    id: "g-pa",
    name: "Physical activity — vigorous",
    flag: "weak",
    detail: "closest element matched with low support",
    members: [
      { id: "m25", cohort: "UKBB", name: "vigorous_activity_days" },
      { id: "m26", cohort: "CLSA", name: "PA2_VIG_FREQ" },
    ],
  },
];

/** Variables the clustering left in no group — a drop target both ways, so a bad member has somewhere
 *  to go and a stray one can be pulled back in. */
const SEED_UNASSIGNED: Member[] = [
  { id: "u1", cohort: "MESA", name: "bpdiaavg" },
  { id: "u2", cohort: "AoU", name: "pulse_bpm" },
  { id: "u3", cohort: "CLSA", name: "PA2_MOD_FREQ" },
];

const STEPS = [
  { n: 1, title: "Concept groups", sub: "Are these each one concept, and which do I care about?", icon: Layers },
  { n: 2, title: "Concepts → CDEs", sub: "Is this the right element, and is the proposed one any good?", icon: Sparkles },
  { n: 3, title: "Transform specs", sub: "Is this recode correct?", icon: FlaskConical },
  { n: 4, title: "Export", sub: "What ships, and to whom?", icon: ArrowRight },
] as const;

const FLAG_STYLE: Record<Exclude<Flag, null>, { cls: string; label: string }> = {
  split: { cls: "border-warning/40 bg-warning-bg text-warning", label: "may be more than one concept" },
  qualify: { cls: "border-rule-control-on-raised bg-surface-inset text-on-raised-muted", label: "qualifier axis" },
  mismatch: { cls: "border-danger/40 bg-danger/5 text-danger", label: "right values, wrong concept" },
  weak: { cls: "border-warning/40 bg-warning-bg text-warning", label: "weak support" },
};

export default function PreviewStagedReviewPage() {
  const [step, setStep] = useState(1);
  return (
    <PreviewShell
      title="Staged review"
      intro="A proposed change to how you review a run: four gates, one per stage of the pipeline, instead of one page that asks for every judgement at once."
    >
      {/* One honest exception to the shell's blanket "everything is illustrative": the money is real
          arithmetic from the shipped estimator, which is the whole point of the step-1 gate. */}
      <p className="-mt-2 text-xs text-on-raised-muted">
        One exception to the banner above: the <b>cost figures are live</b>, computed by the same estimator
        the New Run form uses. The concept groups are illustrative.
      </p>

      {/* ── why ─────────────────────────────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Why change it</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-on-raised">
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
          <p className="text-xs text-on-raised-muted">
            The staged shape follows established retrospective-harmonization guidance, which separates
            defining target variables from assessing which studies can supply them, from processing the
            data, from disseminating the result — see the{" "}
            <Link href="/related" className="text-link-on-raised hover:underline">
              related work
            </Link>{" "}
            and{" "}
            <Link href="/methods" className="text-link-on-raised hover:underline">
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
                active ? "border-rule-info bg-surface-info" : "border-rule-on-raised hover:bg-surface-inset"
              }`}
            >
              <div className="flex items-center gap-1.5">
                <s.icon className={`h-3.5 w-3.5 ${active ? "text-accent-on-raised" : "text-on-raised-muted"}`} />
                <span className={`text-xs font-semibold ${active ? "text-accent-on-raised" : "text-on-raised-muted"}`}>
                  Step {s.n}
                </span>
              </div>
              <div className={`mt-0.5 text-sm font-semibold ${active ? "text-on-raised" : "text-on-raised"}`}>
                {s.title}
              </div>
            </button>
          );
        })}
      </div>

      <p className="-mt-2 text-sm italic text-on-raised-muted">{STEPS[step - 1].sub}</p>

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
          <CardTitle className="text-sm">Open questions</CardTitle>
          <p className="text-xs text-on-raised-muted">
            Decisions still to make — the point of previewing this before building it.
          </p>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2.5 text-sm text-on-raised">
            {[
              "Scope before triage, or triage before scope? A large corpus produces more flagged groups than anyone wants to clear, so the subset control probably has to come first — and the flag count should be reported for the selection, not the whole corpus.",
              "How much editing belongs in step 1? Moving one variable at a time is demonstrated above. Splitting a fused concept, merging two, and creating one from scratch each cost more to build — and a fused concept like blood pressure really wants splitting, not six separate drags.",
              "After an edit, what gets re-checked? Re-running only the concepts you touched is the cheap and obvious answer, but a variable that moves changes two concepts, and the one it left may now be worth a second look too.",
              "Should a step be skippable? Accepting every group unchanged is a legitimate choice, and forcing four gates on someone re-running a known configuration would be worse than today.",
              "Where do composite scores get confirmed? They can be proposed at step 1, but whether they are actually computable can only be judged once elements are assigned at step 2.",
              "Two model queues instead of one. Splitting the paid work in two adds a second wait. Running a smaller selection interactively may be the better trade.",
            ].map((q) => (
              <li key={q} className="flex gap-2">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-on-raised-faint" />
                <span>{q}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </PreviewShell>
  );
}

// ── Step 1 — the interactive one ──────────────────────────────────────────────────────────────
// Granularity and selection are live so the cost gate can be felt, not just described. Field counts
// scale off the illustrative corpus size below; the money comes from the shipped estimator.
const CORPUS_FIELDS = 7451;
const CORPUS_COHORTS = 5;

/** Drop-target id for the "no group" tray — a real destination, not a sentinel to special-case. */
const UNASSIGNED = "__unassigned__";

/** A draggable variable chip — used inside a concept and inside the unassigned tray. Declared at module
 *  scope on purpose: a component defined inside StepOne would be a NEW type on every render, remounting
 *  every chip on each state change and cancelling any drag in flight. */
function Chip({
  m,
  dragging,
  onStart,
  onEnd,
}: {
  m: Member;
  dragging: boolean;
  onStart: () => void;
  onEnd: () => void;
}) {
  return (
    <div
      draggable
      onDragStart={onStart}
      onDragEnd={onEnd}
      className={`flex cursor-grab items-center gap-1.5 rounded border border-rule-on-raised bg-surface-inset px-1.5 py-1 text-xs active:cursor-grabbing ${
        dragging ? "opacity-40" : ""
      }`}
    >
      <GripVertical className="h-3 w-3 shrink-0 text-on-raised-muted" />
      <Badge variant="outline" className="shrink-0 px-1 py-0 text-xs font-normal text-on-raised-muted">
        {m.cohort}
      </Badge>
      <span className="truncate font-mono text-on-raised">{m.name}</span>
    </div>
  );
}

function StepOne() {
  const [granularity, setGranularity] = useState(50);
  const [groups, setGroups] = useState<MockGroup[]>(SEED_GROUPS);
  const [unassigned, setUnassigned] = useState<Member[]>(SEED_UNASSIGNED);
  const [picked, setPicked] = useState<Record<string, boolean>>({ "g-bp": true, "g-age": true });
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ "g-bp": true });
  const [drag, setDrag] = useState<{ id: string; from: string } | null>(null);
  const [over, setOver] = useState<string | null>(null);
  // Groups whose membership the reviewer changed — the real feature would re-check these with the model.
  const [touched, setTouched] = useState<Record<string, boolean>>({});

  const edited =
    groups.some((g) => touched[g.id]) || unassigned.length !== SEED_UNASSIGNED.length;

  /** Move one variable between any two containers (a group, or the unassigned tray). */
  function moveMember(memberId: string, from: string, to: string) {
    if (from === to) return;
    const source = from === UNASSIGNED ? unassigned : (groups.find((g) => g.id === from)?.members ?? []);
    const member = source.find((m) => m.id === memberId);
    if (!member) return;

    setGroups((prev) =>
      prev.map((g) => {
        if (g.id === from) return { ...g, members: g.members.filter((m) => m.id !== memberId) };
        if (g.id === to) return { ...g, members: [...g.members, member] };
        return g;
      }),
    );
    if (from === UNASSIGNED) setUnassigned((prev) => prev.filter((m) => m.id !== memberId));
    if (to === UNASSIGNED) setUnassigned((prev) => [...prev, member]);

    setTouched((t) => ({ ...t, ...(from !== UNASSIGNED && { [from]: true }), ...(to !== UNASSIGNED && { [to]: true }) }));
    if (to !== UNASSIGNED) setExpanded((e) => ({ ...e, [to]: true })); // show where it landed
  }

  function reset() {
    setGroups(SEED_GROUPS);
    setUnassigned(SEED_UNASSIGNED);
    setTouched({});
  }

  // Looser grouping -> fewer, larger groups and fewer leftovers. Illustrative, not a model.
  const shaped = useMemo(() => {
    const t = granularity / 100;
    return {
      groups: Math.round(3900 - t * 900),
      flagged: Math.round(480 + t * 150),
      unassigned: Math.round(1000 - t * 500),
    };
  }, [granularity]);

  const chosen = groups.filter((g) => picked[g.id]);
  const chosenVars = chosen.reduce((s, g) => s + g.members.length, 0);
  // Every variable in play, including the tray — so dragging one OUT of a selected group genuinely
  // lowers the estimate rather than silently re-normalising it away.
  const allVars = groups.reduce((s, g) => s + g.members.length, 0) + unassigned.length;
  // The six groups above stand in for a whole corpus, so the selected fraction of THEM is applied to the
  // corpus size to get a field count the estimator can price at a realistic magnitude.
  const selectedFields = Math.round((chosenVars / allVars) * CORPUS_FIELDS);
  const full = estimateRunCost(CORPUS_FIELDS, CORPUS_COHORTS, "batch");
  const partial = estimateRunCost(selectedFields, CORPUS_COHORTS, "batch");
  const flaggedInScope = chosen.filter((g) => g.flag === "split" || g.flag === "weak").length;

  const chip = (m: Member, from: string) => (
    <Chip
      key={m.id}
      m={m}
      dragging={drag?.id === m.id}
      onStart={() => setDrag({ id: m.id, from })}
      onEnd={() => { setDrag(null); setOver(null); }}
    />
  );

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="space-y-1">
          <CardTitle className="text-sm">Step 1 · Concept groups</CardTitle>
          <p className="text-xs text-on-raised-muted">
            Runs on your machine. No model is called, so this step is free and you can adjust it as much as
            you like before committing to anything.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* granularity */}
          <div className="rounded-md border border-rule-on-raised p-3">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold uppercase tracking-eyebrow text-on-raised-muted">Grouping</span>
              <span className="text-on-raised-muted">
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
            <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs tabular-nums text-on-raised-muted">
              <span>
                <b className="text-on-raised">{shaped.groups.toLocaleString()}</b> groups
              </span>
              <span>
                <b className="text-on-raised">{shaped.flagged}</b> need a closer look
              </span>
              <span>
                <b className="text-on-raised">{shaped.unassigned}</b> variables in no group
              </span>
            </div>
            <p className="mt-2 text-xs text-on-raised-muted">
              Looser grouping pools more variables together, which means fewer leftovers but coarser
              concepts — the trade-off is between how much you can combine and how much detail survives.
            </p>
          </div>

          {/* groups — each row is a drop target; expand to drag its variables */}
          <div className="flex items-center gap-2 text-xs text-on-raised-muted">
            <GripVertical className="h-3.5 w-3.5" />
            Drag a variable onto another concept, or into “No group” below.
            {edited && (
              <Button size="sm" variant="ghost" onClick={reset} className="ml-auto h-6 gap-1 text-xs text-on-raised-muted">
                <RefreshCw className="h-3 w-3" /> Reset groups
              </Button>
            )}
          </div>
          <div className="space-y-1.5">
            {groups.map((g) => {
              const on = !!picked[g.id];
              const f = g.flag ? FLAG_STYLE[g.flag] : null;
              const isOpen = !!expanded[g.id];
              const isOver = over === g.id && drag?.from !== g.id;
              return (
                <div
                  key={g.id}
                  onDragOver={(e) => { e.preventDefault(); setOver(g.id); }}
                  onDragLeave={() => setOver((o) => (o === g.id ? null : o))}
                  onDrop={() => { if (drag) moveMember(drag.id, drag.from, g.id); setDrag(null); setOver(null); }}
                  className={`rounded-md border px-3 py-2.5 transition-colors ${
                    isOver
                      ? "border-rule-info bg-surface-info ring-1 ring-rule-info"
                      : on
                        ? "border-rule-info bg-surface-info"
                        : "border-rule-on-raised hover:bg-surface-inset"
                  }`}
                >
                  <div className="flex items-start gap-2.5">
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => setPicked((p) => ({ ...p, [g.id]: !p[g.id] }))}
                      aria-label={`Include ${g.name}`}
                      className="mt-1 h-3.5 w-3.5 shrink-0 cursor-pointer accent-accent-action"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold text-on-raised">{g.name}</span>
                        {f && (
                          <Badge variant="outline" className={`gap-1 px-1.5 py-0 text-xs ${f.cls}`}>
                            {g.flag === "split" && <Scissors className="h-3 w-3" />}
                            {g.flag === "weak" && <AlertTriangle className="h-3 w-3" />}
                            {f.label}
                            {g.axis ? `: ${g.axis}` : ""}
                          </Badge>
                        )}
                        {touched[g.id] && (
                          <Badge variant="outline" className="gap-1 border-rule-info px-1.5 py-0 text-xs text-accent-on-raised">
                            <Pencil className="h-3 w-3" /> edited
                          </Badge>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => setExpanded((e) => ({ ...e, [g.id]: !e[g.id] }))}
                        className="mt-0.5 flex items-center gap-1 text-xs text-on-raised-muted hover:text-accent-on-raised"
                      >
                        {isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                        {g.members.length} variable{g.members.length === 1 ? "" : "s"}
                        {g.members.length > 0 && ` · ${cohortsOf(g.members).join(", ")}`}
                      </button>
                      {g.detail && <p className="mt-0.5 text-xs italic text-on-raised-muted">{g.detail}</p>}
                      {g.values && (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {g.values.map((v) => (
                            <span key={v} className="rounded bg-surface-inset-strong px-1.5 py-0.5 text-xs text-on-raised-muted">
                              {v}
                            </span>
                          ))}
                        </div>
                      )}
                      {isOpen && (
                        <div className="mt-2 grid gap-1 sm:grid-cols-2">
                          {g.members.map((m) => chip(m, g.id))}
                          {!g.members.length && (
                            <div className="col-span-full rounded border border-dashed border-rule-on-raised py-2 text-center text-xs text-on-raised-muted">
                              Empty — drop a variable here
                            </div>
                          )}
                        </div>
                      )}
                      {g.flag === "split" && (
                        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                          <Button size="sm" variant="outline" className="h-6 gap-1 text-xs" disabled>
                            <Scissors className="h-3 w-3" /> Split into 3
                          </Button>
                          <Button size="sm" variant="ghost" className="h-6 text-xs" disabled>
                            Keep as one
                          </Button>
                          <span className="text-xs text-on-raised-muted">— not in this preview; move variables by hand instead</span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}

            {/* the "no group" tray — a real drop target both ways */}
            <div
              onDragOver={(e) => { e.preventDefault(); setOver(UNASSIGNED); }}
              onDragLeave={() => setOver((o) => (o === UNASSIGNED ? null : o))}
              onDrop={() => { if (drag) moveMember(drag.id, drag.from, UNASSIGNED); setDrag(null); setOver(null); }}
              className={`rounded-md border border-dashed px-3 py-2.5 transition-colors ${
                over === UNASSIGNED && drag?.from !== UNASSIGNED
                  ? "border-rule-info bg-surface-info"
                  : "border-rule-control-on-raised"
              }`}
            >
              <div className="text-xs font-semibold text-on-raised-muted">
                No group
                <span className="ml-1 font-normal text-on-raised-muted">
                  · {unassigned.length} variable{unassigned.length === 1 ? "" : "s"} the clustering left out — drop
                  one here to remove it from a concept, or drag one into a concept above
                </span>
              </div>
              <div className="mt-2 grid gap-1 sm:grid-cols-2">
                {unassigned.map((m) => chip(m, UNASSIGNED))}
                {!unassigned.length && (
                  <div className="col-span-full py-1 text-center text-xs text-on-raised-muted">
                    Nothing left out
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* the gate */}
          <div className="rounded-md border border-success/30 bg-success-bg/40 px-3 py-3">
            <div className="flex items-start gap-2">
              <Wallet className="mt-0.5 h-4 w-4 shrink-0 text-success" />
              <div className="min-w-0 flex-1 space-y-1">
                <div className="text-sm font-semibold text-on-raised">
                  {chosen.length} group{chosen.length === 1 ? "" : "s"} selected
                  <span className="ml-1 font-normal text-on-raised-muted">
                    ·{" "}
                    {flaggedInScope === 0
                      ? "none need a closer look"
                      : `${flaggedInScope} still ${flaggedInScope === 1 ? "needs" : "need"} a closer look`}
                  </span>
                </div>
                <div className="text-xs text-on-raised">
                  Continuing sends only what you selected to the model stages —{" "}
                  <b className="tabular-nums text-on-raised">{formatUsd(partial.mid)}</b> instead of{" "}
                  <b className="tabular-nums">{formatUsd(full.mid)}</b> for the whole corpus.
                </div>
                <div className="text-xs text-on-raised-muted">
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
        proposed="Grouping comes first, costs nothing, and is adjustable — expand a concept and drag its variables somewhere better. You fix mis-grouped concepts before they propagate, drop what you don't need, and only then commit to the paid stages."
      />

      <p className="text-xs text-on-raised-muted">
        In the real feature, moving a variable would rewrite the run&apos;s stored grouping and re-check only
        the concepts you touched — the pipeline already keys its cached work to a group&apos;s exact
        membership, so an edited concept re-runs and the untouched ones do not. Splitting, merging and
        creating concepts are the obvious next moves; this preview deliberately stops at moving one variable
        at a time.
      </p>
    </div>
  );
}

function StepTwo() {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="space-y-1">
          <CardTitle className="text-sm">Step 2 · Concepts → Common Data Elements</CardTitle>
          <p className="text-xs text-on-raised-muted">
            Runs only on what you kept. For each group: the ranked candidate elements the pipeline
            considered, and — where nothing fits — a proposed new element built from the pooled variables.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="rounded-md border border-rule-on-raised">
            <div className="border-b border-rule-quiet-on-raised px-3 py-2 text-sm font-semibold text-on-raised">
              Blood pressure, systolic
              <span className="ml-2 text-xs font-normal text-on-raised-muted">4 variables · AoU, MESA, UKBB, CLSA</span>
            </div>
            <div className="divide-y divide-rule-quiet-on-raised">
              {[
                { id: "Systolic Blood Pressure Measurement", cos: 0.782, chosen: true, axis: null },
                { id: "Blood Pressure Systolic Seated", cos: 0.771, chosen: false, axis: "qualifier: posture" },
                { id: "Mean Arterial Pressure", cos: 0.654, chosen: false, axis: "scope" },
              ].map((c, i) => (
                <div key={c.id} className="flex items-center gap-2 px-3 py-2 text-xs">
                  <span className="w-4 tabular-nums text-on-raised-muted">{i + 1}</span>
                  <span className="min-w-0 flex-1">
                    <span className="font-semibold text-on-raised">{c.id}</span>
                    {c.axis && <span className="ml-2 text-on-raised-muted">would need to change — {c.axis}</span>}
                  </span>
                  <span className="tabular-nums text-on-raised-muted">{c.cos.toFixed(3)}</span>
                  {c.chosen ? (
                    <Badge variant="outline" className="border-success/40 bg-success-bg text-xs text-success">
                      selected
                    </Badge>
                  ) : (
                    <Button size="sm" variant="outline" className="h-6 text-xs" disabled>
                      Choose this
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </div>
          <p className="text-xs text-on-raised-muted">
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
          <CardTitle className="text-sm">Step 3 · Transform specs</CardTitle>
          <p className="text-xs text-on-raised-muted">
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
            <div key={t.src} className="rounded border border-rule-quiet-on-raised px-3 py-2 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="secondary" className="font-mono text-xs">
                  {t.kind}
                </Badge>
                <span className="font-mono text-on-raised">{t.src}</span>
                <span className="text-on-raised-faint">→</span>
                <span className="text-on-raised">{t.body}</span>
                <span className="text-on-raised-muted">coverage {t.cov}%</span>
                {t.review && (
                  <Badge variant="outline" className="border-warning/40 text-xs text-warning">
                    always reviewed
                  </Badge>
                )}
                <span className="ml-auto flex gap-0.5 text-on-raised-faint">
                  <Check className="h-4 w-4" />
                  <Pencil className="h-4 w-4" />
                  <Ban className="h-4 w-4" />
                </span>
              </div>
            </div>
          ))}
          <p className="pt-1 text-xs text-on-raised-muted">
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
          <CardTitle className="text-sm">Step 4 · Export</CardTitle>
          <p className="text-xs text-on-raised-muted">Choose what leaves the tool.</p>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-on-raised">
          {[
            ["Runnable notebook (Python / R)", "Applies the approved recodes to your data — the data never has to leave your environment."],
            ["Mapping table", "Every source variable, its target element, and the recipe."],
            ["Review log", "Who decided what, and the note they left. The audit trail for the run."],
            ["Proposed new elements", "Any elements the run proposed, ready for submission."],
            ["Composite score recipes", "With a clear statement of which cohorts can and cannot compute each one."],
          ].map(([t, d]) => (
            <div key={t} className="flex items-start gap-2.5 rounded border border-rule-quiet-on-raised px-3 py-2">
              <input type="checkbox" defaultChecked className="mt-1 h-3.5 w-3.5 accent-accent-action" disabled />
              <span>
                <span className="text-sm font-semibold text-on-raised">{t}</span>
                <span className="mt-0.5 block text-xs text-on-raised-muted">{d}</span>
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
      <div className="rounded-md border border-rule-on-raised bg-surface-inset px-3 py-2.5">
        <div className="text-xs font-semibold uppercase tracking-eyebrow text-on-raised-muted">Today</div>
        <p className="mt-1 text-xs text-on-raised">{now}</p>
      </div>
      <div className="rounded-md border border-rule-info bg-surface-info px-3 py-2.5">
        <div className="text-xs font-semibold uppercase tracking-eyebrow text-accent-on-raised">Proposed</div>
        <p className="mt-1 text-xs text-on-raised">{proposed}</p>
      </div>
    </div>
  );
}
