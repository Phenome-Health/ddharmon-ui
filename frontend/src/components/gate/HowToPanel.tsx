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
 * so the run's first charge pays for concept generation, splitting and the coherence judge. Since the
 * Gate 0 demotion (2026-08-26) that press lives on **Setup**, and since 08-14f deleted the pre-flight
 * screen it is **Start run** itself — not a later Continue. Setup's list was rewritten in 08-14g because
 * it had not caught up with either change: it still walked the reviewer through Start, then a prepared
 * download, then a Continue that no longer exists, which is a confident wrong map rather than stale copy.
 *
 * WHAT SETUP'S LIST NOW HAS TO CARRY. 08-14f made the embedded-text check per-dictionary and free: mark a
 * dictionary complete and you can download your own rows with the exact clustered string appended. That
 * is the screen's main affordance and its whole value is that it comes BEFORE the charge, so the list
 * states it in that position. `setup.spec.ts` ("08-14g") gates the step's presence AND its index.
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
 * Per-screen steps. Setup and Gate 1 both name Setup's own Continue as the first charge, because on those
 * two screens the reviewer is about to press it or has just passed it.
 *
 * THE `gate0` KEY STAYS. This map is `Record<GatePosition, …>` and `GatePosition` is the WIRE type, which
 * still carries the retired position (D-3) — dropping the key fails typecheck. Nothing renders it: the
 * route redirects before any screen mounts. Do not "tidy" it into a compile error.
 */
export const HOW_TO: Record<GatePosition, HowToStep[]> = {
  setup: [
    { text: "Add one data dictionary per cohort, then map each file's columns." },
    { text: "Check the row count against the unique-name count — a repeated variable name is dropped silently." },
    {
      text: "Mark each dictionary complete, then download it and read the exact text that will be clustered — before you spend anything.",
    },
    { text: "Pick a run mode and a model, and paste a provider key if you are using your own." },
    {
      text: "Press Start run. This is the run's first charge — it pays for naming the concepts, splitting the groups and the coherence judge. The amount is on the button.",
      charge: true,
    },
  ],
  // NEVER RENDERED. Kept only because `GatePosition` still carries the position — see the docstring.
  gate0: [{ text: "This screen was retired; the run pauses at this point on Set up instead." }],
  gate1: [
    { text: "Read the grouping strip: how many concept groups formed, and from how many clusters." },
    { text: "Search for the concepts you care about, one term per line." },
    { text: "Tick the groups you want to take to Gate 2." },
    { text: "Open a group to see every variable in it and any proposed division." },
    {
      text: "Press Continue to Gate 2. The naming, splitting and judging that produced this screen were already charged on Set up; this button buys the assignment step, and its amount is on it.",
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
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      // Addressable, because 08-14g gates the SETUP steps on their content and their order. Reaching them
      // through the trigger's ancestors couples the assertion to the collapsible's markup.
      data-testid="how-to"
      className={cn("rounded-inner bg-on-field/5 px-4 py-3", className)}
    >
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
