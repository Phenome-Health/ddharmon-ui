import { expect, test } from "@playwright/test";
import { PHASE_ORDER, TERMINAL_PHASES, phasePercent, timelineSegments } from "@/lib/run-progress";

/**
 * How far along is this run — asserted directly, with no browser (08-14h Task 1).
 *
 * WHY THIS MODULE WAS EXTRACTED, AND WHY THE SPEC IS PURE. Every progress affordance the product has was
 * module-local to `pages/dashboard.tsx` — `phasePercent` at `:115` and `RunTimeline` at `:130`, neither
 * exported. `08-14f` then stopped routing anyone through that screen, so the arithmetic that answers "how
 * far has this got" was reachable from exactly one page nobody sees any more. Lifting it is what lets the
 * gate chrome ask the same question without asking it a second way.
 *
 * NO ENVIRONMENT READS, the same rule as `lib/run-state.ts` and `lib/gate-routes.ts` and for the same
 * measured reason: `lib/api.ts` reads `import.meta.env.VITE_STATIC`, which is undefined in the Playwright
 * node runtime, so a spec importing that module throws before any assertion runs. A percentage that
 * cannot be imported by a test is a percentage that drifts.
 *
 *   run: npm run test:e2e -- --grep "@runprogress"
 *
 * THESE ASSERTIONS ENCODE THE PRE-EXTRACTION BEHAVIOUR, deliberately. Task 1 moved code and added none,
 * so every expectation here is a reading of what `dashboard.tsx` already did — including the parts that
 * look odd (the `5` floor for an unknown phase, the `99` ceiling for a known one). Both are load-bearing:
 * `08-14c` established that the ETA suppression on a parked run depends on `awaiting_review` NOT being in
 * `PHASE_ORDER` and therefore scoring 5, which is below the `pct >= 12` guard.
 */

test.describe("phasePercent", () => {
  test("@runprogress a finished run is 100 and an unknown phase floors at 5", () => {
    expect(phasePercent("complete", 0, 0)).toBe(100);
    expect(phasePercent("prepared", 0, 0)).toBe(100);
    // THE PARKED CASE, and it is not incidental. `awaiting_review` is not a pipeline phase, so it scores
    // the unknown-phase floor — which is what keeps the dashboard's `pct >= 12` ETA guard shut over a run
    // that has stopped. 08-14c asserts the suppression; this asserts the number underneath it.
    expect(phasePercent("awaiting_review", 0, 0)).toBe(5);
    expect(phasePercent("", 0, 0)).toBe(5);
    expect(phasePercent("nonsense", 3, 4)).toBe(5);
  });

  test("@runprogress a known phase advances with its index and never claims 100", () => {
    const span = 100 / PHASE_ORDER.length;
    for (const [i, phase] of PHASE_ORDER.entries()) {
      const pct = phasePercent(phase, 0, 0);
      expect(pct, `${phase} at 0/0`).toBe(Math.round(i * span));
    }
    // NEVER 100 WHILE RUNNING. The last phase, fully complete on its sub-count, still reports 99 — a run
    // that says it is finished while a stage is still streaming is a false claim, and the ceiling is what
    // reserves 100 for the terminal phases above.
    expect(phasePercent(PHASE_ORDER[PHASE_ORDER.length - 1], 10, 10)).toBe(99);
  });

  test("@runprogress the sub-count advances within the phase's own span, and a zero total does not", () => {
    const span = 100 / PHASE_ORDER.length;
    const idx = PHASE_ORDER.indexOf("clustering");
    expect(phasePercent("clustering", 0, 4)).toBe(Math.round(idx * span));
    expect(phasePercent("clustering", 2, 4)).toBe(Math.round(idx * span + span / 2));
    // A total of zero is "this stage does not count items", not "zero of zero done" — dividing would be
    // NaN, and a NaN percentage renders as an empty bar that reads as no progress at all.
    expect(phasePercent("clustering", 0, 0)).toBe(Math.round(idx * span));
    expect(phasePercent("clustering", 5, 0)).toBe(Math.round(idx * span));
  });
});

test.describe("timelineSegments", () => {
  test("@runprogress no streamed timings means no timeline, rather than an empty one", () => {
    // A DB-hydrated historical run streams no `phaseStartedAt`. The dashboard hid the timeline entirely
    // in that case rather than rendering a heading over nothing, and that is preserved.
    expect(timelineSegments({ phaseStartedAt: undefined, currentPhase: "clustering", now: 100 })).toEqual([]);
    expect(timelineSegments({ phaseStartedAt: {}, currentPhase: "clustering", now: 100 })).toEqual([]);
  });

  test("@runprogress each stage runs until the next one starts, in start order", () => {
    // Deliberately out of key order, because the sort is by TIMESTAMP and object key order is not a
    // guarantee the stream makes.
    const segs = timelineSegments({
      phaseStartedAt: { clustering: 30, loading: 0, embedding: 10 },
      currentPhase: "clustering",
      now: 55,
    });
    expect(segs.map((s) => s.phase)).toEqual(["loading", "embedding", "clustering"]);
    expect(segs.map((s) => s.seconds)).toEqual([10, 20, 25]);
  });

  test("@runprogress the current stage is the only active one, and only while the run is unfinished", () => {
    const live = timelineSegments({
      phaseStartedAt: { loading: 0, embedding: 10 },
      currentPhase: "embedding",
      now: 25,
    });
    expect(live.map((s) => s.active)).toEqual([false, true]);

    // ONCE THE RUN ENDS, NOTHING IS ACTIVE — and the last stage runs to the terminal stamp rather than to
    // `now`, so a finished run's timeline does not keep growing while the page stays open.
    const done = timelineSegments({
      phaseStartedAt: { loading: 0, embedding: 10, complete: 30 },
      currentPhase: "embedding",
      now: 9_999,
    });
    expect(done.map((s) => s.phase)).toEqual(["loading", "embedding"]);
    expect(done.map((s) => s.active)).toEqual([false, false]);
    expect(done.map((s) => s.seconds)).toEqual([10, 20]);
  });

  test("@runprogress the terminal stamps are read but never rendered as stages of their own", () => {
    for (const terminal of TERMINAL_PHASES) {
      const segs = timelineSegments({
        phaseStartedAt: { loading: 0, [terminal]: 12 },
        currentPhase: "loading",
        now: 9_999,
      });
      expect(segs.map((s) => s.phase), `${terminal} must not be a stage`).toEqual(["loading"]);
    }
    // `error` ends a run as surely as `complete` does, so it stops the clock too.
    const errored = timelineSegments({ phaseStartedAt: { loading: 0, error: 8 }, currentPhase: "loading", now: 9_999 });
    expect(errored[0].seconds).toBe(8);
    expect(errored[0].active).toBe(false);
  });

  test("@runprogress a clock that would run backwards is floored at zero", () => {
    // `now` lags the last stage's start for a moment after a phase transition (the tick is on an interval,
    // the stream is not). A negative duration renders as "-3s", which reads as a bug in the run.
    const segs = timelineSegments({ phaseStartedAt: { loading: 100 }, currentPhase: "loading", now: 90 });
    expect(segs[0].seconds).toBe(0);
  });
});
