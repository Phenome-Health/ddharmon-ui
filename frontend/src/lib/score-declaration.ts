import type { DecisionIndex } from "@/lib/gate-decisions";
import { declaredScores } from "@/lib/score-match";
import type { CompositeSpec } from "@/types";

/**
 * What Gate 1's score panel says about the declaration it HOLDS (phase-8 final review, round 2).
 *
 * The panel already said how to make a declaration; these are about one that exists:
 *
 *  - H4 — the CLOSED strip names the declared score (`stripStatus`). Closed, the strip used to read as the same
 *    invitation whether the reviewer had declared 48 components or none, so a reviewer coming back to Gate 1 could
 *    not tell from the top of the screen that their score was there.
 *
 * Pure, because `frontend/` has no component test runner: pinned node-side by `tests/e2e/score-declaration.spec.ts`
 * and on the static build by the same file.
 */

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "matched: 40 of 48 found" — the count `SpecView` heads its component list with ("40/48 found"). */
function matchState(spec: CompositeSpec | null): string {
  if (!spec) return "not matched yet";
  const found = spec.matches.filter((m) => m.conceptId != null).length;
  return `matched: ${found} of ${spec.matches.length} found`;
}

/**
 * The closed strip's one line when a score is declared (H4), or `null` when none is — the strip then keeps its
 * invitation copy (`STRIP_SUMMARY`), exactly as before.
 *
 * `{name} · {N} components declared · {match state}`. The match state is the spec derived under the score's OWN
 * name (case-insensitive, the `composite` kind's identity), else "not matched yet" — a spec derived for another
 * score is not this one's match. It deliberately does not name the gate where matching happens. A spec with no
 * declaration behind it (derived straight from a document) is still a score the panel shows, so it gets a status
 * too, without the word "declared". A second declared score is counted rather than hidden.
 */
export function stripStatus(
  index: DecisionIndex | null | undefined,
  spec: CompositeSpec | null | undefined,
): string | null {
  const scores = declaredScores(index);
  if (scores.length === 0) {
    if (!spec) return null;
    const name = spec.definition?.name?.trim() || "Declared score";
    return `${name} · ${plural(spec.matches.length, "component", "components")} · ${matchState(spec)}`;
  }
  const [first, ...rest] = scores;
  const own = spec && (spec.definition?.name ?? "").trim().toLowerCase() === first.scoreName.toLowerCase() ? spec : null;
  const more = rest.length ? ` · and ${plural(rest.length, "more score", "more scores")}` : "";
  return `${first.scoreName} · ${plural(first.components.length, "component", "components")} declared · ${matchState(own)}${more}`;
}
