// PREVIEW / MOCKUP — "Composite / derived-variable builder" (roadmap: Analysis & impact, Exploring).
// Assemble a derived score (here: the Fried frailty phenotype) from harmonized input concepts, and see, live,
// which cohorts can actually compute it — the completeness↔coverage tradeoff. Sample data; ddharmon is
// metadata-only, so the real builder would emit a derived-variable spec applied to your data outside it.
import { useMemo, useState } from "react";
import { Check, Layers, Sparkles } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PreviewShell } from "@/components/preview-shell";

const COHORTS = ["All of Us", "CLSA", "UK Biobank", "MESA", "AI-READI"];

interface Input {
  id: string;
  label: string;
  fried: boolean; // part of the canonical Fried 5?
  cohorts: string[]; // which cohorts carry a harmonized variable for this concept
}

// Sample harmonized concepts + which cohorts have each (illustrative). The Fried 5 are selected by default.
const INPUTS: Input[] = [
  { id: "weightloss", label: "Unintentional weight loss", fried: true, cohorts: ["All of Us", "CLSA", "UK Biobank", "MESA"] },
  { id: "exhaustion", label: "Self-reported exhaustion", fried: true, cohorts: ["All of Us", "CLSA", "UK Biobank", "MESA", "AI-READI"] },
  { id: "grip", label: "Weakness (grip strength)", fried: true, cohorts: ["CLSA", "UK Biobank", "MESA"] },
  { id: "gait", label: "Slowness (gait speed)", fried: true, cohorts: ["CLSA", "MESA", "AI-READI"] },
  { id: "activity", label: "Low physical activity", fried: true, cohorts: ["All of Us", "CLSA", "UK Biobank", "MESA", "AI-READI"] },
  { id: "bmi", label: "Body mass index", fried: false, cohorts: ["All of Us", "CLSA", "UK Biobank", "MESA", "AI-READI"] },
  { id: "cognition", label: "Cognitive score", fried: false, cohorts: ["CLSA", "UK Biobank", "AI-READI"] },
];

const METHODS = [
  { id: "count", label: "Count of criteria met (Fried)", formula: (ids: string[]) => `frail if ≥ 3 of ${ids.length} criteria met` },
  { id: "weighted", label: "Weighted sum of z-scores", formula: (ids: string[]) => `score = Σ wᵢ · zᵢ  over ${ids.length} inputs` },
  { id: "mean", label: "Mean of standardized inputs", formula: (ids: string[]) => `score = mean(z₁ … z${ids.length})` },
];

export default function PreviewCompositePage() {
  const [selected, setSelected] = useState<Set<string>>(new Set(INPUTS.filter((i) => i.fried).map((i) => i.id)));
  const [method, setMethod] = useState("count");

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Cohorts that carry EVERY selected input can compute the composite; others are missing ≥1 input.
  const { computable, chosen } = useMemo(() => {
    const chosen = INPUTS.filter((i) => selected.has(i.id));
    const computable = chosen.length
      ? COHORTS.filter((c) => chosen.every((i) => i.cohorts.includes(c)))
      : [];
    return { computable, chosen };
  }, [selected]);

  const methodDef = METHODS.find((m) => m.id === method)!;

  return (
    <PreviewShell
      title="Composite / derived-variable builder"
      intro="Assemble a derived score from harmonized concepts — here the Fried frailty phenotype — and see, live, which cohorts can actually compute it. More criteria make the score more faithful but shrink the set of cohorts that carry every input."
    >
      <div className="grid gap-4 lg:grid-cols-2">
        {/* Left — harmonized inputs palette */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Harmonized inputs</CardTitle>
            <p className="text-xs text-neutral-400">Toggle concepts to include. Chips show which cohorts carry each.</p>
          </CardHeader>
          <CardContent className="space-y-1.5">
            {INPUTS.map((i) => {
              const on = selected.has(i.id);
              return (
                <button
                  key={i.id}
                  onClick={() => toggle(i.id)}
                  className={`flex w-full items-center gap-2.5 rounded-md border px-2.5 py-2 text-left text-sm ${
                    on ? "border-ph-navy/30 bg-ph-navy/5" : "border-neutral-200 hover:border-neutral-300"
                  }`}
                >
                  <span
                    className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                      on ? "border-ph-navy bg-ph-navy text-white" : "border-neutral-300"
                    }`}
                  >
                    {on && <Check className="h-3 w-3" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="text-neutral-700">{i.label}</span>
                    {i.fried && <span className="ml-1.5 text-[10px] uppercase tracking-wide text-neutral-400">Fried</span>}
                    <span className="mt-1 flex flex-wrap gap-1">
                      {COHORTS.map((c) => (
                        <span
                          key={c}
                          className={`rounded px-1 py-0.5 text-[10px] ${
                            i.cohorts.includes(c) ? "bg-neutral-100 text-neutral-500" : "bg-transparent text-neutral-300 line-through"
                          }`}
                        >
                          {c}
                        </span>
                      ))}
                    </span>
                  </span>
                </button>
              );
            })}
          </CardContent>
        </Card>

        {/* Right — composite definition */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Layers className="h-4 w-4 text-ph-navy" /> Frailty phenotype
            </CardTitle>
            <p className="text-xs text-neutral-400">A derived variable defined over the selected harmonized inputs.</p>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <div>
              <div className="mb-1 text-xs font-medium uppercase tracking-wide text-neutral-400">Combination method</div>
              <select
                value={method}
                onChange={(e) => setMethod(e.target.value)}
                className="w-full rounded-md border border-neutral-200 bg-transparent px-2.5 py-1.5 text-sm text-neutral-700 outline-none focus:border-ph-navy/40"
              >
                {METHODS.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
            </div>

            <div>
              <div className="mb-1 text-xs font-medium uppercase tracking-wide text-neutral-400">Definition</div>
              <div className="rounded-md border border-neutral-200 bg-muted p-3 font-mono text-xs text-neutral-600">
                <div>frailty = f({chosen.map((i) => i.id).join(", ") || "—"})</div>
                <div className="mt-1 text-neutral-500">{methodDef.formula(chosen.map((i) => i.id))}</div>
              </div>
            </div>

            <div>
              <div className="mb-1 text-xs font-medium uppercase tracking-wide text-neutral-400">
                Computable in {computable.length} of {COHORTS.length} cohorts
              </div>
              <div className="flex flex-wrap gap-1.5">
                {COHORTS.map((c) => {
                  const ok = computable.includes(c);
                  return (
                    <Badge key={c} variant={ok ? "success" : "neutral"} className={ok ? "" : "opacity-50"}>
                      {ok ? <Check className="mr-1 h-3 w-3" /> : null}
                      {c}
                    </Badge>
                  );
                })}
              </div>
              <p className="mt-1.5 text-xs text-neutral-400">
                A cohort must carry a harmonized variable for <em>every</em> selected input to compute the score;
                the rest need a proxy or are excluded. Drop a hard-to-find criterion (e.g. gait speed) to widen
                coverage.
              </p>
            </div>

            <Button size="sm" variant="outline" disabled className="gap-1.5">
              <Sparkles className="h-4 w-4" /> Generate derived-variable spec
            </Button>
          </CardContent>
        </Card>
      </div>

      <p className="text-xs text-neutral-400">
        In the real feature, the builder would emit a portable derived-variable spec (inputs + method +
        thresholds, grounded in this run&apos;s harmonized concepts) that you apply to your participant data
        outside ddharmon; an LLM would sanity-check the definition and flag cohorts needing a proxy. Frailty is
        one illustrative example — the same builder assembles any composite.
      </p>
    </PreviewShell>
  );
}
