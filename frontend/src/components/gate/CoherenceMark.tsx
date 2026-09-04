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

/**
 * THE ONE REGISTER FOR WHAT EACH COHERENCE STATE MEANS — label and explanation.
 *
 * EXPORTED BY 08-14h. `LedgerToolbar` filters on these four states and spelled its own labels out twice
 * (once in a `VERDICTS` table, once in the active-filter summary's inline ternary), which made three
 * copies of a vocabulary the reviewer is asked to filter by. Three copies is how a filter chip comes to
 * disagree with the ledger cell it filters, and the plan's instruction was explicit: take the wording
 * from the coherence judge's own vocabulary rather than inventing glosses. The same pattern as
 * `ROLE_HELP`, and the reason `RoleInfo` exists rather than a per-screen re-wording.
 */
export const COHERENCE_COPY: Record<CoherenceState, { label: string; explain: string }> = {
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

/**
 * A FILLED, STATE-TINTED PILL (Bhargav, on the mockup: "I prefer the styling of the judgement verdict").
 *
 * Each state gets a soft-tinted pill + a coloured dot, the way the mockup badges read, rather than a bare
 * dot beside muted text. `qualify` moves to the BLUE (info) register here — the mockup differentiates it
 * from `split`'s amber (split is a real over-merge to resolve; qualify is an advisory modifier), and that
 * distinction is exactly what the colour is carrying.
 *
 * `not_judged` STILL DIFFERS BY FORM, NOT DIMNESS: it takes the neutral pill but keeps the HOLLOW DASHED
 * dot, so "the judge was never asked" never reads as a quiet pass.
 */
const PILL: Record<CoherenceState, { surface: string; text: string; dot: string }> = {
  split: { surface: "bg-surface-warn", text: "text-on-warn", dot: "bg-status-warn" },
  qualify: { surface: "bg-surface-info", text: "text-on-info", dot: "bg-status-info" },
  single: { surface: "bg-surface-ok", text: "text-on-ok", dot: "bg-status-ok" },
  not_judged: {
    surface: "bg-surface-inset",
    text: "text-on-inset-muted",
    dot: "border border-dashed border-rule-control-on-raised bg-transparent",
  },
};

export function CoherenceMark({ state, className }: { state: CoherenceState; className?: string }) {
  const copy = COHERENCE_COPY[state];
  const pill = PILL[state];
  return (
    <span
      data-testid="coherence-mark"
      data-coherence={state}
      title={copy.explain}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-pill px-2 py-0.5 text-xs font-bold capitalize",
        pill.surface,
        pill.text,
        className,
      )}
    >
      {/* The marker is decorative: the state is already in the text beside it, so announcing the dot
          twice would only add noise for a screen reader. */}
      <span aria-hidden="true" className={cn("h-2 w-2 shrink-0 rounded-full", pill.dot)} />
      {copy.label}
      <span className="sr-only">. {copy.explain}</span>
    </span>
  );
}
