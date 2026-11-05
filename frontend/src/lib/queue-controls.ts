import { bulkScopeState } from "@/lib/ledger";

/**
 * The pure half of the review queue's controls (08-30b, the recurring-controls design lab).
 *
 * Kept out of the components so the rules a reviewer reads off the panel — what a legend letter stands for,
 * what "5/6 groups" counts — are asserted in node against the same functions the screen calls.
 */

/**
 * TWO-CHARACTER COHORT INITIALS, printed once as the legend above the presence strip.
 *
 * The lab's legend read "AI Ao CL ME UK": the first two letters or digits of each name, first one upper-cased.
 * A legend that repeats itself names nothing, so two cohorts that would share initials are told apart: the
 * second character becomes the first later character that makes the pair unique, and failing that a digit.
 * Deterministic in roster order, so the same run always prints the same legend.
 */
export function cohortInitials(roster: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const used = new Set<string>();
  for (const name of roster) {
    const chars = name.replace(/[^A-Za-z0-9]/g, "");
    const first = (chars[0] ?? name[0] ?? "?").toUpperCase();
    const candidates = [...chars.slice(1)].map((c) => first + c);
    let pick = candidates.find((c) => !used.has(c.toUpperCase()));
    for (let n = 1; !pick; n++) if (!used.has(`${first}${n}`)) pick = `${first}${n}`;
    used.add(pick.toUpperCase());
    out[name] = pick;
  }
  return out;
}

export type SelectState = ReturnType<typeof bulkScopeState>;

export interface TickedOfShown {
  state: SelectState;
  groups: { on: number; shown: number };
  vars: { on: number; shown: number };
}

/**
 * What the select-all box reports: TICKED OF SHOWN, in groups and in variables (lab rounds 4–5).
 *
 * Over the VISIBLE rows only, because that is what the box acts on — "all 117" is a different promise from
 * "all 12 in this filter", and the counts beside the box are how the reviewer reads which one before pressing.
 * The tri-state is real: claiming "all" over a partial selection is the same lie as a box that looks disabled
 * and submits.
 */
export function tickedOfShown(
  ids: readonly string[],
  isOn: (id: string) => boolean,
  varsOf: (id: string) => number,
): TickedOfShown {
  const on = ids.filter(isOn);
  const sum = (xs: readonly string[]) => xs.reduce((n, id) => n + varsOf(id), 0);
  return {
    state: bulkScopeState(ids, isOn),
    groups: { on: on.length, shown: ids.length },
    vars: { on: sum(on), shown: sum(ids) },
  };
}
