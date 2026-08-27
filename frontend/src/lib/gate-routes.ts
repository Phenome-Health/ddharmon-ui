import type { GatePosition } from "@/types";

/**
 * Route knowledge for the staged review flow, as pure functions with NO environment reads.
 *
 * WHY THIS IS ITS OWN FILE AND NOT `lib/api.ts`. It belongs beside `GATE_ORDER` and `IS_STATIC` by
 * subject — that is where this app keeps route and environment knowledge — and it was written there
 * first. It cannot stay there: `api.ts` line 1 of its constants reads `import.meta.env.VITE_STATIC`,
 * which is a Vite-only expression, so importing that module from a Playwright spec throws before any
 * assertion runs (`import.meta.env` is undefined in the node test runtime). Measured, not assumed — a
 * probe spec importing it fails at that line.
 *
 * That matters here more than the filing does, because the whole reason this helper exists is
 * TESTABILITY. Setup's post-Start destination used to be an inline string inside a closure whose button
 * is disabled in the static build the suite runs against — a destination no test could reach, which is
 * exactly how it came to still point at a retired route with nobody noticing. A helper that cannot be
 * imported by a test would have reproduced the defect one file over.
 *
 * `api.ts` re-exports it, so a reader looking beside `GATE_ORDER` still finds it.
 */

/**
 * Where a reviewer goes the moment a run is STARTED — Setup's own route, for the NEW run.
 *
 * NOT A NO-OP, and this is the part that is easy to get wrong: `startHarmonize` returns a NEW job id
 * while the URL the reviewer is standing on carries the DRAFT one, so staying put would leave them on a
 * route whose id no longer names their run. The navigation is load-bearing under any layout; only its
 * target moved.
 *
 * IT MUST NEVER RETURN THE RETIRED `gate0` PATH. That is where Setup used to send them, and since
 * 2026-08-26 that URL redirects straight back here — so leaving it produced Setup -> retired path ->
 * Setup: a double navigation on the run's very first transition, visible as a flicker and invisible to
 * every gate we have, because the FINAL url is correct either way.
 */
export function setupPathFor(jobId: string): string {
  return `/run/${jobId}/setup`;
}

/** The one position the flow no longer draws a screen for. It is still a live WIRE value (D-3). */
export const RETIRED_GATE: GatePosition = "gate0";
