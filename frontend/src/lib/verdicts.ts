// Server verdicts → the flat per-axis maps the review surfaces hold in state.
//
// The wire keeps the legacy NESTED `decisions` shape (backend `_verdicts_to_legacy` rebuilds it from the
// per-axis artifact rows), while the workbench and dashboard each hold one flat map per axis. This is the
// inverse of that backend function, and the reason an owned run's work reappears after you navigate away:
// writes go to the server, and until this existed nothing ever read them back — the only hydration path was
// the demo sandbox, which an owned run deliberately never writes to.

import type { ServerDecisions } from "@/types";

export type LocalVerdicts = {
  decisions: Record<string, string>;
  transformDecisions: Record<string, string>;
  gencdeDecisions: Record<string, string>;
  notes: Record<string, string>;
};

/** Split a nested server `decisions` payload into the four maps the review surfaces keep in state. */
export function toLocalVerdicts(server: ServerDecisions | undefined | null): LocalVerdicts {
  const out: LocalVerdicts = { decisions: {}, transformDecisions: {}, gencdeDecisions: {}, notes: {} };
  for (const [recordId, entry] of Object.entries(server ?? {})) {
    if (!entry) continue;
    if (entry.decision) out.decisions[recordId] = entry.decision;
    if (entry.note) out.notes[recordId] = entry.note;
    if (entry.gencde?.decision) out.gencdeDecisions[recordId] = entry.gencde.decision;
    for (const [sourceVariable, t] of Object.entries(entry.transforms ?? {})) {
      // Same composite key the workbench writes: `${recordId}:${sourceVariable}`, where sourceVariable is
      // itself "cohort:var" — so this joins on the FIRST colon, matching sandbox.ts's split.
      if (t?.decision) out.transformDecisions[`${recordId}:${sourceVariable}`] = t.decision;
    }
  }
  return out;
}

/** True when the payload carries no verdicts at all — the signal that there is nothing to hydrate from. */
export function isEmptyVerdicts(v: LocalVerdicts): boolean {
  return [v.decisions, v.transformDecisions, v.gencdeDecisions, v.notes].every((m) => Object.keys(m).length === 0);
}
