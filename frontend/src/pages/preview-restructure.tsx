// PREVIEW / MOCKUP — a design sketch of the planned "Restructuring workbench" (roadmap: Interface &
// transparency). NOT a real feature: the board is seeded with sample data, the drag-and-drop is local
// state only, and "Re-check with the model" is a canned simulation — no run, no backend, no LLM call.
// It exists so we can feel out the interaction before building it for real. Linked from /roadmap.
import { useState } from "react";
import { Link } from "wouter";
import { AlertTriangle, ArrowLeft, Check, FlaskConical, GripVertical, Loader2, Pencil, Plus, RefreshCw, Sparkles } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

// A source variable chip. `kind` is a hidden tag the mock "model check" uses to spot a misplaced chip.
interface Chip {
  id: string;
  cohort: string;
  name: string;
  kind: string;
}
interface Concept {
  id: string;
  name: string;
  kind: string;
  cde: string | null; // chosen CDE anchor; null → novel / GenCDE
  chips: Chip[];
}

// Seeded board — a plausible blood-pressure slice, with one deliberately misplaced chip (a pulse variable
// sitting in the systolic concept) so the "Re-check with the model" pass has something to flag.
const SEED: Concept[] = [
  {
    id: "c-dia",
    name: "Diastolic blood pressure",
    kind: "diastolic",
    cde: "Diastolic Blood Pressure Measurement",
    chips: [
      { id: "v1", cohort: "UKBB", name: "diastolic_bp_automated", kind: "diastolic" },
      { id: "v2", cohort: "MESA", name: "d1bp1", kind: "diastolic" },
      { id: "v3", cohort: "CLSA", name: "BP_DIASTOLIC_FIRST", kind: "diastolic" },
      { id: "v4", cohort: "AI-READI", name: "bp1_diabp_vsorres", kind: "diastolic" },
    ],
  },
  {
    id: "c-sys",
    name: "Systolic blood pressure",
    kind: "systolic",
    cde: "Systolic Blood Pressure Measurement",
    chips: [
      { id: "v5", cohort: "UKBB", name: "systolic_bp_automated", kind: "systolic" },
      { id: "v6", cohort: "MESA", name: "s1bp1", kind: "systolic" },
      { id: "v7", cohort: "MESA", name: "pulse_rate_seated", kind: "pulse" }, // ← misplaced on purpose
    ],
  },
  {
    id: "c-pulse",
    name: "Pulse rate",
    kind: "pulse",
    cde: null,
    chips: [
      { id: "v8", cohort: "AI-READI", name: "hr_vsorres", kind: "pulse" },
      { id: "v9", cohort: "CLSA", name: "HR_RESTING", kind: "pulse" },
    ],
  },
];

interface Finding {
  conceptId: string;
  level: "ok" | "warn";
  msg: string;
}

// Canned "model" pass: flag chips whose hidden kind disagrees with their concept, and concepts with no CDE
// anchor. Deterministic — this is a mockup, not an LLM call.
function fakeReview(concepts: Concept[]): Finding[] {
  const out: Finding[] = [];
  for (const c of concepts) {
    const misfits = c.chips.filter((ch) => ch.kind !== c.kind);
    if (misfits.length) {
      out.push({
        conceptId: c.id,
        level: "warn",
        msg: `“${misfits[0].cohort}:${misfits[0].name}” looks out of place here — it reads as ${misfits[0].kind}, not ${c.kind}.`,
      });
    } else if (!c.chips.length) {
      out.push({ conceptId: c.id, level: "warn", msg: "Empty concept — drag variables in or remove it." });
    } else if (!c.cde) {
      out.push({ conceptId: c.id, level: "ok", msg: "No existing CDE match — would be proposed as a new GenCDE." });
    } else {
      out.push({ conceptId: c.id, level: "ok", msg: "Members look coherent for this concept." });
    }
  }
  return out;
}

export default function PreviewRestructurePage() {
  const [concepts, setConcepts] = useState<Concept[]>(SEED);
  const [drag, setDrag] = useState<{ chipId: string; from: string } | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [findings, setFindings] = useState<Finding[] | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [newSeq, setNewSeq] = useState(1);

  function moveChip(chipId: string, from: string, to: string) {
    if (from === to) return;
    setFindings(null);
    setConcepts((prev) => {
      const chip = prev.find((c) => c.id === from)?.chips.find((ch) => ch.id === chipId);
      if (!chip) return prev;
      return prev.map((c) =>
        c.id === from
          ? { ...c, chips: c.chips.filter((ch) => ch.id !== chipId) }
          : c.id === to
            ? { ...c, chips: [...c.chips, chip] }
            : c,
      );
    });
  }

  function addConcept(withChip?: { chipId: string; from: string }) {
    const id = `c-new-${newSeq}`;
    setNewSeq((n) => n + 1);
    setFindings(null);
    setConcepts((prev) => {
      let chip: Chip | undefined;
      const next = prev.map((c) => {
        const f = withChip && c.id === withChip.from ? c.chips.find((ch) => ch.id === withChip.chipId) : undefined;
        if (f) chip = f;
        return withChip && c.id === withChip.from
          ? { ...c, chips: c.chips.filter((ch) => ch.id !== withChip.chipId) }
          : c;
      });
      return [...next, { id, name: "New concept", kind: "new", cde: null, chips: chip ? [chip] : [] }];
    });
  }

  function rename(id: string, name: string) {
    setConcepts((prev) => prev.map((c) => (c.id === id ? { ...c, name } : c)));
  }

  function runCheck() {
    setChecking(true);
    setFindings(null);
    // Simulated latency so the affordance reads like a real model pass.
    window.setTimeout(() => {
      setFindings(fakeReview(concepts));
      setChecking(false);
    }, 900);
  }

  const findingFor = (id: string) => findings?.find((f) => f.conceptId === id);

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <div>
        <Link href="/roadmap" className="inline-flex items-center gap-1 text-xs text-neutral-500 hover:text-ph-navy">
          <ArrowLeft className="h-3.5 w-3.5" /> Back to roadmap
        </Link>
        <h1 className="mt-1 flex flex-wrap items-center gap-2 text-2xl font-semibold text-ph-ink">
          Restructuring workbench
          <Badge variant="outline" className="gap-1 border-warning/40 text-warning">
            <FlaskConical className="h-3.5 w-3.5" /> Preview · mockup
          </Badge>
        </h1>
        <p className="mt-1 text-sm text-neutral-500">
          A design preview of a planned feature — hand the reviewer direct, drag-and-drop control over the
          harmonization structure, then let the model sanity-check the edits. The board below is seeded with
          sample data; drag chips between concepts to get a feel for it.
        </p>
      </div>

      {/* Honesty banner — this is not a functional feature. */}
      <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning-bg px-4 py-3 text-sm text-neutral-700">
        <FlaskConical className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
        <span>
          <span className="font-medium">This is a mockup, not a live tool.</span> Drag-and-drop and “Re-check
          with the model” run entirely in your browser on sample data — no run, no data upload, no LLM call.
          The real feature would start from your run&apos;s output and persist edits as a user-owned layer.
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={runCheck} disabled={checking} className="gap-1.5">
          {checking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          {checking ? "Checking…" : "Re-check with the model"}
        </Button>
        <Button size="sm" variant="outline" onClick={() => addConcept()} className="gap-1.5">
          <Plus className="h-4 w-4" /> New concept
        </Button>
        {findings && (
          <Button size="sm" variant="ghost" onClick={() => { setConcepts(SEED); setFindings(null); }} className="gap-1.5 text-neutral-500">
            <RefreshCw className="h-3.5 w-3.5" /> Reset board
          </Button>
        )}
        <span className="ml-auto text-xs text-neutral-400">Drag a chip onto another concept — or onto “New concept”.</span>
      </div>

      {/* Board */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {concepts.map((c) => {
          const f = findingFor(c.id);
          return (
            <Card
              key={c.id}
              onDragOver={(e) => { e.preventDefault(); setOver(c.id); }}
              onDragLeave={() => setOver((o) => (o === c.id ? null : o))}
              onDrop={() => { if (drag) moveChip(drag.chipId, drag.from, c.id); setDrag(null); setOver(null); }}
              className={over === c.id ? "ring-2 ring-ph-navy/40" : undefined}
            >
              <CardHeader className="space-y-2 pb-3">
                <div className="flex items-start gap-1.5">
                  {editing === c.id ? (
                    <input
                      autoFocus
                      defaultValue={c.name}
                      onBlur={(e) => { rename(c.id, e.target.value.trim() || c.name); setEditing(null); }}
                      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                      className="w-full rounded border border-ph-navy/30 bg-transparent px-1.5 py-0.5 text-sm font-semibold text-ph-ink outline-none"
                    />
                  ) : (
                    <button
                      onClick={() => setEditing(c.id)}
                      className="group flex items-start gap-1 text-left text-sm font-semibold text-ph-ink"
                      title="Rename concept"
                    >
                      {c.name}
                      <Pencil className="mt-0.5 h-3 w-3 shrink-0 text-neutral-300 group-hover:text-ph-navy" />
                    </button>
                  )}
                  <Badge variant="neutral" className="ml-auto shrink-0 text-[10px]">
                    {c.chips.length}
                  </Badge>
                </div>
                {/* CDE anchor row — a "change" affordance stands in for the candidate-picker popover. */}
                <div className="flex items-center gap-1.5 text-xs">
                  <span className="text-neutral-400">CDE</span>
                  {c.cde ? (
                    <span className="truncate text-neutral-600">{c.cde}</span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-ph-navy">
                      <Sparkles className="h-3 w-3" /> propose GenCDE
                    </span>
                  )}
                  <button className="ml-auto shrink-0 text-neutral-400 underline decoration-dotted hover:text-ph-navy" title="Pick a different CDE (mock)">
                    change
                  </button>
                </div>
              </CardHeader>
              <CardContent className="space-y-1.5">
                {c.chips.map((ch) => (
                  <div
                    key={ch.id}
                    draggable
                    onDragStart={() => setDrag({ chipId: ch.id, from: c.id })}
                    onDragEnd={() => { setDrag(null); setOver(null); }}
                    className={`flex cursor-grab items-center gap-2 rounded-md border border-neutral-200 bg-neutral-50 px-2 py-1.5 text-xs active:cursor-grabbing ${
                      drag?.chipId === ch.id ? "opacity-40" : ""
                    }`}
                  >
                    <GripVertical className="h-3.5 w-3.5 shrink-0 text-neutral-300" />
                    <Badge variant="neutral" className="shrink-0 font-normal">{ch.cohort}</Badge>
                    <span className="truncate font-mono text-neutral-600">{ch.name}</span>
                  </div>
                ))}
                {!c.chips.length && (
                  <div className="rounded-md border border-dashed border-neutral-200 py-3 text-center text-xs text-neutral-300">
                    Drop variables here
                  </div>
                )}
                {f && (
                  <div
                    className={`mt-1 flex items-start gap-1.5 rounded-md px-2 py-1.5 text-xs ${
                      f.level === "warn" ? "bg-warning-bg text-neutral-700" : "bg-success-bg text-neutral-700"
                    }`}
                  >
                    {f.level === "warn" ? (
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
                    ) : (
                      <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
                    )}
                    <span>{f.msg}</span>
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}

        {/* New-concept drop zone */}
        <button
          onDragOver={(e) => { e.preventDefault(); setOver("__new__"); }}
          onDragLeave={() => setOver((o) => (o === "__new__" ? null : o))}
          onDrop={() => { if (drag) addConcept(drag); setDrag(null); setOver(null); }}
          onClick={() => addConcept()}
          className={`flex min-h-[8rem] flex-col items-center justify-center gap-1.5 rounded-lg border-2 border-dashed text-sm ${
            over === "__new__" ? "border-ph-navy/50 bg-ph-navy/5 text-ph-navy" : "border-neutral-200 text-neutral-400 hover:border-ph-navy/40 hover:text-ph-navy"
          }`}
        >
          <Plus className="h-5 w-5" />
          New concept
          <span className="text-[11px] text-neutral-400">click, or drop a variable here</span>
        </button>
      </div>

      <p className="text-xs text-neutral-400">
        In the real feature, edits would layer over ddharmon&apos;s output (never destroying the original run),
        the CDE “change” control would open the ranked candidate list, and “Re-check with the model” would run
        the coherence/assign pass over your edited structure and surface accept/ignore recommendations.
      </p>
    </div>
  );
}
