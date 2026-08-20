import { cn } from "@/lib/utils";
import type { CoherenceState } from "@/types";

/**
 * The coherence cell — THREE states, differentiated by FORM (UI-SPEC §5.3, §8.3).
 *
 * THE PROHIBITION THIS COMPONENT EXISTS TO SATISFY: a group the judge was never asked about must not read
 * as a group the judge approved. Only groups with at least six variables are judged
 * (`COHERENCE_MIN_MEMBERS`) and `LeanBRecord.coherent` defaults to `true`, so the unjudged state is both
 * common and structurally invisible unless a component insists on showing it.
 *
 * DIFFERENTIATE BY FORM, NEVER BY DIMNESS. A judged verdict is a FILLED dot; an unjudged one is a HOLLOW
 * DASHED ring at the SAME text weight and the SAME muted colour. Rendering an unjudged group dimmer reads
 * as "less important, therefore fine" — which is precisely the misread the prohibition forbids. That is
 * why `not_judged` here is `font-semibold text-on-raised-muted`, exactly like the others, and differs only
 * in the marker's shape.
 *
 * SILENCE FROM A JUDGE THAT WAS NEVER ASKED IS NOT A PASS. That sentence is the tooltip, verbatim.
 */

const COPY: Record<CoherenceState, { label: string; explain: string }> = {
  split: {
    label: "split",
    explain:
      "The judge thinks this group fuses more than one concept. Its proposed division is below — accept it, edit it, or ignore it.",
  },
  qualify: {
    label: "qualify",
    explain: "One concept with a modifier — advisory, not a defect.",
  },
  single: {
    label: "checked",
    explain: "The judge looked at this group and found one concept.",
  },
  not_judged: {
    label: "not judged",
    explain:
      "This group has fewer than 6 variables, so the coherence judge was not asked. Silence from a judge that was never asked is not a pass.",
  },
};

/** Marker shape and colour per state. `not_judged` shares the muted colour and adds a dashed ring. */
const MARKER: Record<CoherenceState, string> = {
  split: "bg-status-warn",
  qualify: "bg-status-warn",
  single: "bg-status-ok",
  // Hollow AND dashed, at the same colour as the label. Form, not dimness.
  not_judged: "border border-dashed border-rule-control-on-raised bg-transparent",
};

const LABEL_TONE: Record<CoherenceState, string> = {
  split: "text-on-warn",
  qualify: "text-on-warn",
  single: "text-on-ok",
  not_judged: "text-on-raised-muted",
};

export function CoherenceMark({ state, className }: { state: CoherenceState; className?: string }) {
  const copy = COPY[state];
  return (
    <span
      data-testid="coherence-mark"
      data-coherence={state}
      title={copy.explain}
      className={cn("flex items-center gap-1 text-xs font-semibold", LABEL_TONE[state], className)}
    >
      {/* The marker is decorative: the state is already in the text beside it, so announcing the dot
          twice would only add noise for a screen reader. */}
      <span aria-hidden="true" className={cn("h-2 w-2 shrink-0 rounded-full", MARKER[state])} />
      {copy.label}
      <span className="sr-only">. {copy.explain}</span>
    </span>
  );
}
