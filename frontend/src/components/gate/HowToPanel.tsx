import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type { GatePosition } from "@/types";

/**
 * The how-to panel (UI-SPEC §7.1.4) — a collapsible numbered task list, on the GROUND, above the working
 * surface, so it reads as instruction rather than as one more panel competing with the data.
 *
 * CONTENT CONTRACT, and it is a contract rather than copy taste. Written for someone who has never used
 * the tool: every item is an action, in order, naming the control it refers to, and saying plainly when
 * money starts being spent.
 *
 * WHERE THE MONEY STARTS. Since UI-SPEC §0.1's reversal, `generate(ideal)` and `split` run BEFORE Gate 1,
 * so the run's first charge is **Continue at Gate 0** — that press pays for concept generation, splitting
 * and the coherence judge. Setup's "Nothing is charged yet" stays true because Setup → Gate 0 is local.
 *
 * The panel therefore may NOT reproduce the retired §0.4 claim about when spending starts. The guest demo
 * walk makes these strings an unauthenticated public surface, and that claim is prohibited on every screen
 * (UI-SPEC §7.2 / §0.4). `tests/test_content_drift.py::test_no_public_surface_claims_the_staged_flow_is_free`
 * gates it, discriminating on the claim's SUBJECT rather than on a keyword: a sentence that names where the
 * charge lands has reconciled the claim, while one that asserts the early gates cost the reviewer nothing
 * has not. Read that test's fixtures before rewording anything here.
 */

/** One numbered instruction. `charge` marks the step where money starts moving. */
export interface HowToStep {
  text: string;
  charge?: boolean;
}

/**
 * Per-screen steps. Setup, Gate 0 and Gate 1 all name Gate 0's Continue as the first charge, because on
 * those three screens the reviewer has not yet reached, is about to press, or has just passed it.
 */
export const HOW_TO: Record<GatePosition, HowToStep[]> = {
  setup: [
    { text: "Add one data dictionary per cohort, then map each file's columns." },
    { text: "Check the row count against the unique-name count — a repeated variable name is dropped silently." },
    { text: "Pick a run mode and a model, and paste a provider key if you are using your own." },
    {
      text: "Press Start run. Nothing is charged yet — preparing runs on your machine. The first charge is Continue at Gate 0, which pays for naming and splitting the groups.",
      charge: true,
    },
  ],
  gate0: [
    { text: "Pick a cohort tab and read the list of preparation rules that ran." },
    { text: "Open a rule to see a before-and-after example of what it changed." },
    { text: "Check the From a row to a vector panel: that is the only text the grouping step reads." },
    {
      text: "Press Continue to Gate 1. This is the first charge of the run — it pays for naming the concepts, splitting the groups and the coherence judge. The amount is on the button.",
      charge: true,
    },
  ],
  gate1: [
    { text: "Read the grouping strip: how many concept groups formed, and from how many clusters." },
    { text: "Search for the concepts you care about, one term per line." },
    { text: "Tick the groups you want to take to Gate 2." },
    { text: "Open a group to see every variable in it and any proposed division." },
    {
      text: "Press Continue to Gate 2. The naming, splitting and judging that produced this screen were already charged at Gate 0; this button buys the assignment step, and its amount is on it.",
      charge: true,
    },
  ],
  gate2: [
    { text: "Pick a concept in the left list." },
    { text: "Compare the ranked candidate elements against the generated target above them." },
    { text: "Choose a target, or accept the one already chosen." },
    { text: "Press Continue to Gate 3 when every concept you scoped has a target.", charge: true },
  ],
  gate3: [
    { text: "Work through the recode specs, grouped by concept." },
    { text: "Settle any source value that maps to nothing — add it, map it, or record the loss." },
    { text: "Check anything marked stale: its target changed at Gate 2." },
    { text: "Press Continue to Gate 4.", charge: true },
  ],
  gate4: [
    { text: "Choose Python or R for the notebook." },
    { text: "Tick the artifacts you want." },
    { text: "Preview each one before you download it." },
    { text: "Read the decision log if you need to defend a mapping later." },
    { text: "Press Download." },
  ],
};

export function HowToPanel({ gate, className }: { gate: GatePosition; className?: string }) {
  const [open, setOpen] = useState(false);
  const steps = HOW_TO[gate];
  return (
    <Collapsible open={open} onOpenChange={setOpen} className={cn("rounded-inner bg-on-field/5 px-4 py-3", className)}>
      <CollapsibleTrigger
        // The accessible name states the ACTION and its OBJECT, not just "toggle" — an icon-only control
        // whose name does not say what it operates on is a defect, not a style choice (UI-SPEC §6).
        aria-label={open ? "Hide how to use this screen" : "Show how to use this screen"}
        className="flex w-full items-center justify-between gap-2 text-left"
      >
        <span className="text-xs font-semibold uppercase tracking-eyebrow text-on-field-muted">
          How to use this screen
        </span>
        <ChevronDown
          aria-hidden="true"
          className={cn("h-4 w-4 shrink-0 text-on-field-muted transition-transform", open && "rotate-180")}
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ol className="mt-3 space-y-2">
          {steps.map((step, i) => (
            <li key={i} className="flex gap-3 text-sm text-on-field">
              <span className="shrink-0 text-xs font-semibold text-on-field-muted">{i + 1}</span>
              <span className={cn(step.charge && "font-semibold")}>{step.text}</span>
            </li>
          ))}
        </ol>
      </CollapsibleContent>
    </Collapsible>
  );
}
