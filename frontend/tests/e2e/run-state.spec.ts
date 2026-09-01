import { expect, test } from "@playwright/test";
import { PARKED, countInFlight, isInFlight, isParked, isTerminal, justEnded } from "@/lib/run-state";
import { RETIRED_GATE, pathForGate, resumeGateOf, resumePathFor, setupPathFor } from "@/lib/gate-routes";
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

test.describe("the header badge's count", () => {
  /**
   * ASSERTED AS PURE FUNCTIONS, NOT BY RENDERING, and the reason is structural rather than convenient:
   * `ActiveRunsIndicator` is disabled outright in a static build (`enabled: !IS_STATIC`, and an
   * `IS_STATIC` early return), and the static build is what this suite drives. A rendered assertion on
   * that badge would pass against a component that never mounts — a green test measuring nothing.
   */
  const run = (status: string, jobId = status) => ({ jobId, status });

  test("@runstate five parked runs count as zero running", () => {
    // The literal screenshot that prompted 08-14c: the header read "5 running", with a spinning loader,
    // over five runs that had exited and were spending nothing.
    const jobs = [1, 2, 3, 4, 5].map((n) => run(PARKED, `parked-${n}`));
    expect(countInFlight(jobs)).toBe(0);
  });

  test("@runstate one in-flight run among four parked counts as one", () => {
    const jobs = [run(PARKED, "p1"), run(PARKED, "p2"), run(PARKED, "p3"), run(PARKED, "p4"), run("clustering")];
    expect(countInFlight(jobs)).toBe(1);
  });

  test("@runstate terminal runs never count, and an empty list counts as zero", () => {
    expect(countInFlight([run("complete"), run("error"), run("cancelled")])).toBe(0);
    expect(countInFlight([])).toBe(0);
    expect(countInFlight(undefined)).toBe(0);
  });

  test("@runstate a run that parks is not announced as an ending", () => {
    // The toast effect announces a run that FINISHED. A park is not an ending — it is a handover to a
    // human — so announcing it (and the failure toast is the fallthrough arm) would report a working
    // pause as a broken run.
    expect(justEnded("clustering", PARKED)).toBe(false);
    expect(justEnded(PARKED, PARKED)).toBe(false);
    // ...and the announcements that already worked keep working, including the one that fires when a
    // reviewer files the last verdict and the run resumes and finishes.
    expect(justEnded("clustering", "complete")).toBe(true);
    expect(justEnded(PARKED, "complete")).toBe(true);
    expect(justEnded(PARKED, "error")).toBe(true);
    expect(justEnded("assigning", "cancelled")).toBe(true);
    // Never re-announce a run that was already over, and never announce one seen for the first time.
    expect(justEnded("complete", "complete")).toBe(false);
    expect(justEnded(undefined, "complete")).toBe(false);
  });
});

test.describe("no surface keeps a private copy of the predicate", () => {
  /**
   * THE REGRESSION GUARD. Two of the four copies of this predicate were wrong, and both were wrong the
   * same way — a literal `new Set(["complete", "error", "cancelled"])` written beside the surface that
   * used it. Nothing about either file looked wrong on its own, so a test that reads the source is the
   * only thing that notices the third one being written.
   */
  const REPAIRED = ["src/pages/jobs.tsx", "src/components/active-runs-indicator.tsx"];

  test("@runstate the repaired surfaces declare no terminal-status set of their own", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve, dirname } = await import("node:path");
    const root = resolve(dirname(test.info().file), "..", "..");
    // COMMENTS ARE STRIPPED FIRST. Both files carry a header QUOTING the set they used to declare, so
    // that a reader learns why the predicate is imported rather than local — and a naive text match
    // fails on the explanation itself, which would train the next author to delete the explanation.
    const code = (src: string) =>
      src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const rel of REPAIRED) {
      const src = code(readFileSync(resolve(root, rel), "utf8"));
      expect(src, `${rel} must not re-declare the status set`).not.toMatch(/new Set\(\[\s*"complete"/);
      expect(src, `${rel} must import the shared predicates`).toContain('from "@/lib/run-state"');
    }
  });
});

/**
 * `pathForGate` — the ONE place a gate position becomes a URL (08-16c Task 8).
 *
 * WHY IT IS ASSERTED HERE rather than through the button that uses it. Gate 1's Continue is the caller,
 * and Continue is DISABLED in the static build the rendered suite runs against (it is the spend path), so
 * a test that pressed it could never reach the destination. That is the precise defect this helper exists
 * to end: `gate-routes.ts`'s header records that Setup's post-Start destination sat as an inline template
 * inside exactly such a closure and went on pointing at a retired route with nobody noticing. A
 * destination computed by an importable function is a destination a spec can hold to account.
 *
 *   run: npm run test:e2e -- --grep "@runstate"
 */
test.describe("pathForGate", () => {
  test("@runstate a gate position becomes that gate's route under the run", () => {
    for (const gate of ["gate1", "gate2", "gate3", "gate4"] as GatePosition[]) {
      expect(pathForGate("job-7", gate), `pathForGate(gate=${gate})`).toBe(`/run/job-7/${gate}`);
    }
  });

  test("@runstate setup goes through the helper that owns its route, not the generic template", () => {
    expect(pathForGate("job-7", "setup")).toBe(setupPathFor("job-7"));
  });

  /**
   * The case that produces a BROKEN destination rather than a merely suboptimal one, and the reason this
   * translation lives in the helper instead of at each call site. `gate0` is retired but still a live WIRE
   * value: `GATE_ORDER` contains it, so the server's `target` can genuinely BE `gate0` and a caller that
   * emitted it would send the reviewer to a URL that redirects straight back to Setup — a double
   * navigation invisible to any check that only reads the FINAL url.
   */
  test("@runstate the retired position is translated to Setup, never emitted as a route", () => {
    expect(pathForGate("job-7", RETIRED_GATE)).toBe(setupPathFor("job-7"));
    expect(pathForGate("job-7", RETIRED_GATE)).not.toContain(RETIRED_GATE);
  });

  test("@runstate resumePathFor and pathForGate cannot disagree — one definition, two entry points", () => {
    for (const gate of ["setup", "gate1", "gate2", "gate3", "gate4"] as GatePosition[]) {
      expect(
        resumePathFor({ jobId: "job-7", status: "awaiting_review", gatePosition: gate }),
        `resumePathFor(${gate})`,
      ).toBe(pathForGate("job-7", gate));
    }
  });
});
