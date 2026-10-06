import type { GateDecision, GroupedDecisions } from "@/lib/gate-decisions";
import type { DemoScore, ScoreSuggestions } from "@/types";

/**
 * The shared demo's SHIPPED declared score (`backend/demos/score.json`, served as `job.demoScore`).
 *
 * The score builder's flow is declare on Gate 1 (free), see which groups the free search reaches on Gate 1 (free,
 * embedding only), match on Gate 4 (one paid call). On the demo none of it could happen: a guest's declaration lives
 * in their tab, which the server never sees, so no hints were asked for; and the match is paid, which the demo never
 * is. So the demo ships the whole flow, built once offline against its own run — the declaration and Gate 1's hints
 * here, Gate 4's match as the run's `composites` — and the screens read it where a real run reads the reviewer's own
 * rows and the suggestions route.
 *
 * Both readers answer `null` unless the run is DEFINITELY the shared demo (`pinned === true`), so a real run is
 * unchanged by construction. Pure, like the rest of `lib/`, because `frontend/` has no component test runner.
 */

/** The demo's declaration as decision rows — the hook's BASELINE (`useGateDecisions({ baseline })`) — or null. */
export function shippedDeclaration(demoScore: DemoScore | null | undefined, pinned: boolean | undefined): GroupedDecisions {
  if (pinned !== true) return null;
  const rows = demoScore?.declaration;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return { composite_swap: rows as GateDecision[] };
}

/** Gate 1's hints for the demo's declaration, computed when it was built — or null. */
export function shippedSuggestions(
  demoScore: DemoScore | null | undefined,
  pinned: boolean | undefined,
): ScoreSuggestions | null {
  if (pinned !== true) return null;
  return demoScore?.suggestions ?? null;
}
