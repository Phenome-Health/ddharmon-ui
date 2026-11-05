import { isInFlight, isParked } from "@/lib/run-state";
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

/**
 * The five screens the rail draws, in order. Mirrors `GATE_SEQUENCE` in `components/gate/GateRail.tsx`,
 * and deliberately NOT `GATE_ORDER` — that constant is the WIRE order and still carries the retired
 * position, so using it here would offer `gate0` as a sixth destination.
 *
 * It lives in this file as well as the component because these predicates must be assertable from a spec,
 * and `GateRail.tsx` imports React. `gates.spec.ts` already asserts the two lists differ in exactly the
 * retired position; `run-state.spec.ts` now asserts these two agree.
 */
export const RAIL_SEQUENCE: GatePosition[] = ["setup", "gate1", "gate2", "gate3", "gate4"];

/**
 * Has the run already PASSED this gate? — the question that decides whether a screen is a record or a
 * working surface (08-16c Task 2).
 *
 * Bhargav: *"want to be able to click back on setup to see what the run parameters were, even if that
 * means freezing the setup screen so no edits can be made (this applies for other gates too)."*
 *
 * FREEZING IS THE LOAD-BEARING HALF, not the navigation. A past gate that still renders live controls
 * invites a reviewer to change a decision the pipeline has already consumed, and the write would either
 * fail confusingly or silently corrupt a finished stage.
 *
 * AN UNKNOWN POSITION FREEZES NOTHING. If the run's position is absent or off the rail, this returns
 * false: a screen wrongly frozen is unusable, while a screen wrongly live is exactly as usable as it is
 * today. The failure is taken in the recoverable direction.
 */
export function isGatePast(gate: GatePosition, runPosition: GatePosition | null | undefined): boolean {
  const here = RAIL_SEQUENCE.indexOf(gate);
  const at = runPosition ? RAIL_SEQUENCE.indexOf(runPosition) : -1;
  if (here < 0 || at < 0) return false;
  return here < at;
}

/**
 * May the reviewer NAVIGATE to this gate? — the run's current position and everything behind it.
 *
 * A gate the run has not reached is not reachable, and the rail says so rather than rendering a link that
 * silently does nothing: "visibly not reachable" is the requirement, because an inert link is
 * indistinguishable from a broken one.
 */
export function isGateReachable(gate: GatePosition, runPosition: GatePosition | null | undefined): boolean {
  const here = RAIL_SEQUENCE.indexOf(gate);
  const at = runPosition ? RAIL_SEQUENCE.indexOf(runPosition) : -1;
  if (here < 0 || at < 0) return false;
  return here <= at;
}

/**
 * How far along the rail a run has got, for REACHABILITY — which is not the same question as freezing (08-18).
 *
 * A FINISHED run carries no gate position (the pipeline ran through every boundary), and `isGateReachable`
 * reads an absent position as "reached nothing". So the finished shared demo — the run every guest walks — drew
 * all four gates as "this run has not reached this gate yet": false, and no way forward. A finished run has
 * produced everything every gate shows, so it has reached them all.
 *
 * FREEZING IS DELIBERATELY UNTOUCHED. `isGatePast` keeps reading the raw position, so a finished run's gates
 * stay re-decidable (R13) and nothing about a parked run changes.
 */
export function railReachOf(
  job: { status?: string | null; gatePosition?: GatePosition | null } | null | undefined,
): GatePosition | null {
  if (!job) return null;
  if (job.status === "complete") return RAIL_SEQUENCE[RAIL_SEQUENCE.length - 1];
  return job.gatePosition ?? null;
}

/** The next screen on the rail, or null from the last — where the shared demo's Continue walks to (08-18). */
export function nextRailGate(gate: GatePosition): GatePosition | null {
  const i = RAIL_SEQUENCE.indexOf(gate);
  return i >= 0 && i < RAIL_SEQUENCE.length - 1 ? RAIL_SEQUENCE[i + 1] : null;
}

/**
 * The query parameter that turns a NEW run's Setup into a re-run of an earlier one (08-28).
 *
 * Re-run means "start a new run, with the last one's inputs filled in" — not "repeat the last run". The
 * shipped control used to POST the re-run at once, in the old run's mode, which bought a paid run the
 * reviewer never got to look at, and then landed them on the legacy run page with no way into the gates.
 * Setup is where a run is set up and where its first charge is consented to, so a re-run starts there too.
 */
export const RERUN_PARAM = "rerun";

/**
 * Where a Re-run control goes: Setup for a NEW run, prefilled from the named one.
 *
 * `new` is the draft id every other "New run" link in the app already uses. The source id rides as a
 * query value, encoded, so no run id can turn this URL into a different route.
 */
export function rerunSetupPathFor(sourceJobId: string): string {
  return `${setupPathFor("new")}?${RERUN_PARAM}=${encodeURIComponent(sourceJobId)}`;
}

/**
 * The gate an IN-FLIGHT run's current leg is running toward.
 *
 * A first leg carries no position yet (it is heading for Gate 1, where Start lands the reviewer). A resumed
 * leg still carries the position it LEFT, because the resume route flips only `status`/`phase` — so the
 * destination is the next screen on the rail after it. The retired position and Setup both precede Gate 1.
 */
export function inFlightGateOf(gatePosition: GatePosition | string | null | undefined): GatePosition {
  if (!gatePosition || gatePosition === "setup" || gatePosition === RETIRED_GATE) return "gate1";
  const at = RAIL_SEQUENCE.indexOf(gatePosition as GatePosition);
  if (at < 0) return "gate1";
  return RAIL_SEQUENCE[Math.min(at + 1, RAIL_SEQUENCE.length - 1)];
}

/**
 * Where a link to THIS RUN should go — the one answer every surface that lists runs reads (08-28).
 *
 * Every real run is a staged run now (Start and the API re-run both park at Gate 1), so a run that is not
 * over belongs in the gates: a PARKED run at the gate it waits on, an IN-FLIGHT one at the gate its leg is
 * running toward (that screen carries the live progress and the Stop). Only an ENDED run goes to the legacy
 * run page, which is where a finished result and the error / stopped recovery live. The shipped demo is a
 * client-side replay with no gates to enter, so it keeps its results link unchanged.
 */
export function runPathFor(job: {
  jobId: string;
  status?: string | null;
  gatePosition?: GatePosition | null;
  config?: Record<string, unknown> | null;
}): string {
  const isDemo = Boolean((job.config as { demo?: boolean } | null | undefined)?.demo);
  if (isDemo || job.status === "complete") return `/job/${job.jobId}?results=1`;
  const parked = resumePathFor(job);
  if (parked) return parked;
  if (isInFlight(job.status)) return pathForGate(job.jobId, inFlightGateOf(job.gatePosition));
  return `/job/${job.jobId}`;
}

/** The query key a link to the analysis-ideas page names its ORIGIN screen by (final review round 2). */
export const FROM_PARAM = "from";

/** The analysis-ideas page for a run; `from` names the rail screen the reviewer is leaving, so "back" returns there. */
export function analysisPathFor(jobId: string, from?: GatePosition): string {
  return `/job/${jobId}/analysis${from ? `?${FROM_PARAM}=${encodeURIComponent(from)}` : ""}`;
}

/**
 * Where the analysis-ideas page's "Back to run" goes (final review round 2).
 *
 * It used to be `/job/:id` for every run — the LEGACY run page — so a reviewer who opened the ideas from Gate 4
 * came "back" to a screen they had never been on (Bhargav: "takes me to the sankey diagram page"). Now:
 *
 *  1. the screen the link came FROM, when it names one on the rail. Validated against `RAIL_SEQUENCE`, so the
 *     query can only ever pick a gate — never a URL — and the retired position is not one of them;
 *  2. else, for a STAGED run (it carries a gate position), Gate 4 — the screen the ideas are reached from, and a
 *     pure read. Not the run's own position: the shared demo's server row stays parked at Gate 1 while a guest
 *     walks it on in their browser, so its position is not where the reviewer was;
 *  3. else the legacy run page, which is where a one-shot run's results live — unchanged.
 */
export function analysisBackPathFor(
  job: { jobId: string; gatePosition?: GatePosition | string | null },
  from: string | null | undefined,
): string {
  if (from && (RAIL_SEQUENCE as readonly string[]).includes(from)) return pathForGate(job.jobId, from);
  if (job.gatePosition) return pathForGate(job.jobId, "gate4");
  return `/job/${job.jobId}`;
}
