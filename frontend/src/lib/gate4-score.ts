import { estimateScoreMatchUsd, formatUsd } from "@/lib/estimate";
import type { ScopeVerdict } from "@/lib/score-scope";
import type { CompositeSpec } from "@/types";

/**
 * The declared score on Gate 4, as its DISCLOSURE HEADER states it (final review round 2).
 *
 * Bhargav: "score builder section should be collapsible". Folding the panel must not fold away the two
 * things the reviewer needs without opening it: THAT a score was declared, and WHERE IT STANDS — not matched
 * yet (and what matching would cost: the price is never moved behind a disclosure, the same rule the Gate 1
 * strip keeps), or matched, with the verdict and its coverage count. Pure, so the copy is pinned node-side.
 */

/** The verdict's one-line name — shared by the header and the panel's verdict box. */
export const GATE4_VERDICT_LABEL: Record<ScopeVerdict, string> = {
  full: "Every component is present",
  partial: "Some components are present",
  infeasible: "None of the components was found",
  indeterminate: "Cannot be determined yet",
};

const KNOWN = new Set<string>(Object.keys(GATE4_VERDICT_LABEL));

/** The server's presentation verdict; an unrecognized one is INDETERMINATE, never the negative claim. */
export function gate4ScoreVerdict(spec: CompositeSpec | null | undefined): ScopeVerdict {
  const raw = spec?.feasibility?.verdict;
  return typeof raw === "string" && KNOWN.has(raw) ? (raw as ScopeVerdict) : "indeterminate";
}

export type Gate4ScoreState = "unmatched" | ScopeVerdict;

/**
 * `3 components · Not matched yet — matching is one model call, about $0.01`, or, once matched,
 * `3 components · Matched: Some components are present (2/3)`. `refused` is the shared demo, which never
 * spends, so its header does not price a call it would refuse.
 */
export function gate4ScoreHeader(
  nComponents: number,
  spec: CompositeSpec | null | undefined,
  { refused }: { refused: boolean },
): { state: Gate4ScoreState; text: string } {
  const count = `${nComponents} ${nComponents === 1 ? "component" : "components"}`;
  if (!spec) {
    const how = refused
      ? "not available on the shared demo"
      : `matching is one model call, about ${formatUsd(estimateScoreMatchUsd(nComponents))}`;
    return { state: "unmatched", text: `${count} · Not matched yet — ${how}` };
  }
  const verdict = gate4ScoreVerdict(spec);
  const f = spec.feasibility;
  return {
    state: verdict,
    text: `${count} · Matched: ${GATE4_VERDICT_LABEL[verdict]} (${f.nRequiredMatched}/${f.nRequired})`,
  };
}
