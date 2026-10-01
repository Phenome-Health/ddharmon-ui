import { expect, test } from "@playwright/test";
import { decisionItemKey, optionSetKey, type DecisionIndex, type GateDecision } from "@/lib/gate-decisions";
import { stripStatus } from "@/lib/score-declaration";
import type { CompositeSpec } from "@/types";

/**
 * What Gate 1's score panel says about the declaration it holds (phase-8 final review, round 2).
 *
 *  - H4, Bhargav: *"still there — fix now"*: the COLLAPSED score strip gave no hint that a score was already
 *    declared. Closed, it read as the same invitation whether the reviewer had declared 48 components or none.
 *
 *   run: npx playwright test tests/e2e/score-declaration.spec.ts
 */

const SCORE = "Frailty index (Searle 2008)";

/** The rows "Declare these components" writes: one `composite_swap` per component, chosen "" (not matched). */
function declared(scoreName: string, components: string[], extra: Record<string, unknown> = {}): GateDecision[] {
  return components.map((componentName) => ({
    scoreName,
    componentName,
    ...extra,
    chosen: "",
    alternatives: components,
    optionSetKey: optionSetKey(components),
  }));
}

function indexOf(...rows: GateDecision[][]): DecisionIndex {
  const byItem: Record<string, GateDecision> = {};
  for (const r of rows.flat()) byItem[decisionItemKey("composite_swap", r)] = r;
  return { composite_swap: byItem };
}

/** A spec derived under `name` whose matches found `found` of `components`. */
function specOf(name: string, components: string[], found: number): CompositeSpec {
  return {
    definition: {
      name,
      kind: "custom",
      citation: "",
      combinationRule: "",
      threshold: "",
      notes: "",
      statedNItems: null,
      underEnumerated: 0,
      provenance: "",
      sourceSha256: "",
      components: [],
    },
    matches: components.map((component, i) => ({
      component,
      conceptId: i < found ? `c${i}#g0` : null,
      concept: "",
      column: "",
      cohorts: [],
      sourceVariables: [],
      confidence: 0.9,
      rationale: "",
      required: true,
      pinned: false,
      shortlist: [],
    })),
    feasibility: {
      verdict: "partial",
      nRequired: components.length,
      nRequiredMatched: found,
      matched: [],
      missing: [],
      needsReview: [],
      computableCohorts: [],
      perCohort: [],
      caveats: [],
    },
    derivation: [],
    units: "",
    validationRules: [],
    sourceKind: "declaration",
  } as unknown as CompositeSpec;
}

const THREE = ["Weak grip strength", "Slow walking speed", "Unintentional weight loss"];

// --- H4: the closed strip says a score is declared ------------------------------------------------------------

test.describe("score strip status (H4)", () => {
  test("@gate1 nothing declared and nothing derived: no status — the strip stays an invitation", () => {
    expect(stripStatus({}, null)).toBeNull();
    expect(stripStatus(null, undefined)).toBeNull();
    expect(stripStatus({ composite_swap: {} }, null)).toBeNull();
  });

  test("@gate1 a declared score names itself, counts its components, and says it is not matched yet", () => {
    expect(stripStatus(indexOf(declared(SCORE, THREE)), null)).toBe(
      `${SCORE} · 3 components declared · not matched yet`,
    );
    // One component is "component", not "components".
    expect(stripStatus(indexOf(declared(SCORE, ["Weak grip strength"])), null)).toBe(
      `${SCORE} · 1 component declared · not matched yet`,
    );
  });

  test("@gate1 a match under the score's own name (any case) gives the match state: N of M found", () => {
    const spec = specOf(SCORE.toUpperCase(), THREE, 2);
    expect(stripStatus(indexOf(declared(SCORE, THREE)), spec)).toBe(
      `${SCORE} · 3 components declared · matched: 2 of 3 found`,
    );
    // A spec derived under ANOTHER score's name is not this score's match.
    expect(stripStatus(indexOf(declared(SCORE, THREE)), specOf("SES index", THREE, 3))).toBe(
      `${SCORE} · 3 components declared · not matched yet`,
    );
  });

  test("@gate1 a score derived with no declaration behind it still reads as a score, not an invitation", () => {
    expect(stripStatus({}, specOf("SES index", THREE, 1))).toBe("SES index · 3 components · matched: 1 of 3 found");
  });

  test("@gate1 a second declared score is counted, not hidden", () => {
    const index = indexOf(declared(SCORE, THREE), declared("SES index", ["Income"]));
    expect(stripStatus(index, null)).toBe(`${SCORE} · 3 components declared · not matched yet · and 1 more score`);
    const three = indexOf(declared(SCORE, THREE), declared("SES index", ["Income"]), declared("IC score", ["Gait"]));
    expect(stripStatus(three, null)).toMatch(/· and 2 more scores$/);
  });
});
