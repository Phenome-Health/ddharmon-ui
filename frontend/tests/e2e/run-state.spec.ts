import { expect, test } from "@playwright/test";
import { PARKED, isInFlight, isParked, isTerminal } from "@/lib/run-state";
import { RETIRED_GATE, resumeGateOf, resumePathFor, setupPathFor } from "@/lib/gate-routes";
import type { GatePosition } from "@/types";

/**
 * Run state — the ONE answer to "is this run running?" and "where does it resume?" (08-14c).
 *
 * WHY THIS SPEC IS PURE. Four copies of the in-flight predicate existed in this app and two of them were
 * wrong, which is a defect no rendered test would have caught: each surface looked right on its own, and
 * only reading all four together showed the disagreement. A predicate asserted directly is a predicate
 * that stays asserted, so these functions live in `@/lib/run-state` (no environment reads, same rule and
 * same reason as `@/lib/gate-routes`) and are checked here without a browser.
 *
 *   run: npm run test:e2e -- --grep "@runstate"
 *
 * The two cases that earn the most attention are the RETIRED gate and the ABSENT gate position. Every
 * other input produces a merely suboptimal destination; those two produce a broken one — a redirect loop
 * and a 404 respectively.
 */

/** Every status the wire can carry, from `JobStatus` in types.ts. Kept literal so a new one is noticed. */
const IN_FLIGHT_STATUSES = [
  "pending",
  "loading",
  "embedding",
  "clustering",
  "generating",
  "splitting",
  "assigning",
  "gencde",
  "specs",
  "prepared",
];
const TERMINAL_STATUSES = ["complete", "error", "cancelled"];

test.describe("run-state predicates", () => {
  test("@runstate a finished, failed or cancelled run is terminal and not in flight", () => {
    for (const s of TERMINAL_STATUSES) {
      expect(isTerminal(s), `isTerminal(${s})`).toBe(true);
      expect(isInFlight(s), `isInFlight(${s})`).toBe(false);
      expect(isParked(s), `isParked(${s})`).toBe(false);
    }
  });

  test("@runstate a parked run is neither terminal nor in flight — it is its own third thing", () => {
    // This is the whole point of the module. `awaiting_review` is non-terminal, so every "not terminal =>
    // running" test in this app counted a parked run as running: the header badge said "5 running" over
    // five runs that had no worker and were spending nothing (08 D-01 makes a pause an EXIT).
    expect(isParked(PARKED)).toBe(true);
    expect(isTerminal(PARKED)).toBe(false);
    expect(isInFlight(PARKED)).toBe(false);
    expect(PARKED).toBe("awaiting_review");
  });

  test("@runstate every other reported status is in flight", () => {
    for (const s of IN_FLIGHT_STATUSES) {
      expect(isInFlight(s), `isInFlight(${s})`).toBe(true);
      expect(isTerminal(s), `isTerminal(${s})`).toBe(false);
      expect(isParked(s), `isParked(${s})`).toBe(false);
    }
  });

  test("@runstate an absent status claims nothing — least of all that a run is in flight", () => {
    for (const s of [undefined, null, ""]) {
      expect(isInFlight(s), `isInFlight(${JSON.stringify(s)})`).toBe(false);
      expect(isTerminal(s), `isTerminal(${JSON.stringify(s)})`).toBe(false);
      expect(isParked(s), `isParked(${JSON.stringify(s)})`).toBe(false);
    }
  });

  test("@runstate the three predicates partition the status space — no status is two things at once", () => {
    for (const s of [...IN_FLIGHT_STATUSES, ...TERMINAL_STATUSES, PARKED]) {
      const hits = [isTerminal(s), isParked(s), isInFlight(s)].filter(Boolean).length;
      expect(hits, `${s} matched ${hits} predicates`).toBe(1);
    }
  });
});

test.describe("resume destination", () => {
  const parked = (gatePosition: GatePosition | null | undefined) => ({
    jobId: "abc123",
    status: PARKED,
    gatePosition,
  });

  test("@runstate a parked run resumes at the gate it is parked on", () => {
    for (const g of ["gate1", "gate2", "gate3", "gate4"] as GatePosition[]) {
      expect(resumeGateOf(parked(g)), `resumeGateOf(${g})`).toBe(g);
      expect(resumePathFor(parked(g)), `resumePathFor(${g})`).toBe(`/run/abc123/${g}`);
    }
  });

  test("@runstate a run parked at Setup resumes at Setup", () => {
    expect(resumeGateOf(parked("setup"))).toBe("setup");
    expect(resumePathFor(parked("setup"))).toBe(setupPathFor("abc123"));
  });

  test("@runstate a run parked at the RETIRED gate resumes at Setup, never the retired path", () => {
    // Every parked run on the live backend carries `gate0` (measured 2026-08-31), and that URL has
    // redirected to Setup since 2026-08-26 (D-2). Sending a reviewer there would work — and would cost a
    // double navigation on every re-entry, visible as a flicker and invisible to any gate that only
    // checks the FINAL url.
    expect(resumeGateOf(parked(RETIRED_GATE))).toBe("setup");
    const path = resumePathFor(parked(RETIRED_GATE));
    expect(path).toBe(setupPathFor("abc123"));
    expect(path).not.toContain(`/${RETIRED_GATE}`);
  });

  test("@runstate a parked run with no gate position resumes at Setup, not at a 404 or the dashboard", () => {
    // `gatePosition` is optional on the wire. Absent is not evidence of anything except that the field
    // was not sent, and Setup is the one screen that is correct for a run at any position.
    for (const g of [null, undefined]) {
      expect(resumeGateOf(parked(g)), `resumeGateOf(${JSON.stringify(g)})`).toBe("setup");
      expect(resumePathFor(parked(g))).toBe(setupPathFor("abc123"));
    }
  });

  test("@runstate a terminal run has no resume destination — the caller keeps its results route", () => {
    for (const status of TERMINAL_STATUSES) {
      // Note the gate position: a finished run still carries the last gate it passed through, so keying
      // the destination off `gatePosition` alone would send a COMPLETE run back into the review flow.
      expect(resumeGateOf({ jobId: "abc123", status, gatePosition: "gate2" }), status).toBeNull();
      expect(resumePathFor({ jobId: "abc123", status, gatePosition: "gate2" }), status).toBeNull();
    }
  });

  test("@runstate an in-flight run has no resume destination either — it belongs on the dashboard", () => {
    for (const status of IN_FLIGHT_STATUSES) {
      expect(resumePathFor({ jobId: "abc123", status, gatePosition: "gate1" }), status).toBeNull();
    }
  });

  test("@runstate no destination this helper returns is ever the retired path, for any input", () => {
    const statuses = [...IN_FLIGHT_STATUSES, ...TERMINAL_STATUSES, PARKED];
    const positions = ["setup", "gate0", "gate1", "gate2", "gate3", "gate4", null, undefined];
    for (const status of statuses) {
      for (const gatePosition of positions) {
        const path = resumePathFor({ jobId: "abc123", status, gatePosition: gatePosition as GatePosition });
        expect(path === null || !path.endsWith(`/${RETIRED_GATE}`), `${status} @ ${gatePosition} -> ${path}`).toBe(
          true,
        );
      }
    }
  });
});
