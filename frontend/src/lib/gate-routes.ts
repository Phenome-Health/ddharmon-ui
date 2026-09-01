import { isParked } from "@/lib/run-state";
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

/**
 * Where a reviewer goes the moment a run is STARTED — Gate 1, since 08-14f.
 *
 * WHAT CHANGED AND WHY. Until 08-14f a submitted run parked at the retired position, so Start bought
 * nothing and landed the reviewer back on Setup in a "pre-flight" state whose Continue was the real first
 * charge. Bhargav read that flow live on 2026-08-31 and cut the middle screen: the free inspection it
 * existed for now happens BEFORE Start, per dictionary, through a job-less export. So Start is the first
 * charge and Gate 1 is where it lands. One press, one charge, no screen in between.
 *
 * IT MUST NEVER RETURN THE RETIRED PATH, for the reason `setupPathFor` records: that URL redirects to
 * Setup, so pointing at it produces a double navigation on the run's very first transition — a flicker
 * that no gate we have can see, because the FINAL url is correct either way.
 *
 * `GATE_ORDER` is not consulted. It is the WIRE order and still contains the retired position, so
 * "the one after setup" is the wrong answer by exactly one step.
 */
export function startedPathFor(jobId: string): string {
  return `/run/${jobId}/gate1`;
}

/** The one position the flow no longer draws a screen for. It is still a live WIRE value (D-3). */
export const RETIRED_GATE: GatePosition = "gate0";

/**
 * Which screen a run should be RE-ENTERED at, or null if it should not be re-entered at all.
 *
 * The Runs list used to answer this with a two-way branch — complete or demo went to the results view,
 * *everything else* went to the progress dashboard — and `gatePosition` was never read. So a reviewer who
 * walked away from a gate and came back via Runs landed on a progress bar with no way onward. That is the
 * defect this pair of helpers closes, and it lives here rather than in the page so the NEXT surface that
 * links to a run cannot get it wrong independently.
 *
 * Null for a terminal run AND for an in-flight one: both already have a correct destination of their own
 * (results, and the dashboard), so the caller keeps what it had. Only a parked run is re-entered.
 */
export function resumeGateOf(job: {
  status?: string | null;
  gatePosition?: GatePosition | null;
}): GatePosition | null {
  if (!isParked(job.status)) return null;
  // TWO INPUTS COLLAPSE TO SETUP, and both would otherwise produce a BROKEN destination rather than a
  // merely suboptimal one. `gate0` is retired (D-2) and its route redirects straight back to Setup, so
  // honouring it costs a double navigation on the run's re-entry — a flicker invisible to any check that
  // only reads the final url. Every parked run on the live backend carries exactly that value (measured
  // 2026-08-31). An ABSENT position is the other: the field is optional on the wire, and absence is not
  // evidence of a position — Setup is the one screen correct for a run parked anywhere.
  const gate = job.gatePosition;
  if (!gate || gate === RETIRED_GATE) return "setup";
  return gate;
}

/** The route for {@link resumeGateOf}. Null carries the same meaning: the caller keeps its own route. */
export function resumePathFor(job: {
  jobId: string;
  status?: string | null;
  gatePosition?: GatePosition | null;
}): string | null {
  const gate = resumeGateOf(job);
  if (!gate) return null;
  // Delegated to `pathForGate` so the app has exactly ONE place that turns a gate position into a URL —
  // including the Setup special case and the retired-position translation.
  return pathForGate(job.jobId, gate);
}

/**
 * The route for ANY gate position — the destination half of Continue, and of the rail's backward links.
 *
 * WHY IT EXISTS AT ALL. Two callers were building this URL with an inline template literal inside a
 * click handler (`gate1.tsx`'s Continue, once it had any navigation, and `setup.tsx:1174`), which is the
 * exact shape this file's header records as the defect that let Setup keep pointing at a retired route
 * with nobody noticing: a destination computed inside a closure whose button the static suite disables
 * is a destination no test can reach. Every gate URL in the app now comes from here, so it is asserted
 * once rather than trusted five times.
 *
 * THE RETIRED POSITION IS TRANSLATED, NOT EMITTED. `gate0` is still a live WIRE value — `GATE_ORDER`
 * contains it and `next_gate("setup")` returns it — so a server-named `target` can genuinely BE `gate0`.
 * Its route redirects to Setup, so emitting it costs the double navigation `setupPathFor` and
 * `startedPathFor` each warn about. Sending the reviewer straight to Setup is the same final URL by the
 * shorter path, and it keeps the rule in one place instead of at every call site.
 */
export function pathForGate(jobId: string, gate: GatePosition | string): string {
  if (gate === "setup" || gate === RETIRED_GATE) return setupPathFor(jobId);
  return `/run/${jobId}/${gate}`;
}
