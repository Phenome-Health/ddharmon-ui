import { expect, test, type Page, type Route } from "@playwright/test";
import type { DecisionIndex } from "@/lib/gate-decisions";
import { REAL_ARTIFACTS } from "@/lib/gate4";
import { estimateScoreMatchUsd, formatUsd } from "@/lib/estimate";
import {
  GATE1_MATCH_DEFERRED,
  SCORE_ARTIFACT,
  declaredScores,
  matchActionLabel,
  scoreExport,
  specForScore,
} from "@/lib/score-match";
import { SCOPE_VERDICT_COPY } from "@/lib/score-scope";
import { gate4ScoreHeader } from "@/lib/gate4-score";
import type { CompositeSpec } from "@/types";
import { FINISHED_JOB, serveFinished } from "./gate23-fixture";
import { PAUSED_JOB } from "./gate1-fixture";

/**
 * 08-28 1f — the declared score is MATCHED on Gate 4 (decision Q5), against the concepts as the reviewer
 * leaves them, and its verdict + recipe leave the tool in their own file.
 *
 *   run: E2E_PORT=4204 npx playwright test gate4-score
 *
 * WHY GATE 4. A staged run parked at Gate 1 has concept groups but no assigned records, so matching could
 * never run there — and the panel promised "the verdict fills in once the run has got that far" while no
 * screen past Gate 1 ever offered it (live verify 3 F20). Gate 4 is where the records are final.
 *
 * HOW A STATIC BUILD REACHES THE PAID ROUTE. It cannot — there is no backend. The match call tries the request
 * and the spec fulfils it at the network layer with the shape `tests/test_score_staged.py` pins. Declarations
 * are seeded into the browser sandbox, which is where a static build's gate decisions live.
 */

const SCORE = "Fried frailty phenotype";
// Declared in the PAPER's order, which is deliberately not alphabetical (live verify 3 H3).
const DECLARED = ["Weight loss", "Weak grip strength", "Slow gait"];

function declarationRows(score = SCORE, components = DECLARED) {
  return Object.fromEntries(
    components.map((c) => [
      `${score}\u001f${c}`,
      { scoreName: score, componentName: c, chosen: "", alternatives: components, optionSetKey: "k" },
    ]),
  );
}

function spec(over: Partial<CompositeSpec["feasibility"]> = {}): CompositeSpec {
  return {
    definition: {
      name: SCORE,
      kind: "custom",
      citation: "",
      combinationRule: "",
      threshold: "",
      notes: "",
      statedNItems: null,
      underEnumerated: 0,
      provenance: "",
      sourceSha256: "",
      components: DECLARED.map((name) => ({
        name,
        definition: "",
        required: true,
        weight: null,
        coding: {
          kind: "unstated",
          cutoff: "",
          referenceRange: "",
          codeMap: {},
          formula: "",
          units: "",
          statedInSource: false,
          needsReview: true,
        },
      })),
    },
    matches: [
      {
        component: "Weight loss",
        conceptId: "c1#g0",
        concept: "Unintentional weight loss (reviewer's name)",
        column: "weight_loss",
        cohorts: ["UKBB", "AoU"],
        sourceVariables: ["UKBB:wl", "AoU:wl"],
        confidence: 0.9,
        rationale: "",
        required: true,
        pinned: false,
        shortlist: ["c1#g0"],
      },
      {
        component: "Weak grip strength",
        conceptId: "c0#g0",
        concept: "Hand grip strength",
        column: "grip",
        cohorts: ["UKBB"],
        sourceVariables: ["UKBB:grip"],
        confidence: 0.8,
        rationale: "",
        required: true,
        pinned: false,
        shortlist: ["c0#g0"],
      },
      {
        component: "Slow gait",
        conceptId: null,
        concept: "",
        column: "",
        cohorts: [],
        sourceVariables: [],
        confidence: 0,
        rationale: "",
        required: true,
        pinned: false,
        shortlist: ["c5#g0", "c6#g0"],
      },
    ],
    feasibility: {
      verdict: "partial",
      coreVerdict: "partial",
      nRequired: 3,
      nRequiredMatched: 2,
      matched: ["Weight loss", "Weak grip strength"],
      missing: ["Slow gait"],
      needsReview: [],
      computableCohorts: [],
      perCohort: [
        { cohort: "UKBB", present: ["Weight loss", "Weak grip strength"], missing: ["Slow gait"], computable: false },
        { cohort: "AoU", present: ["Weight loss"], missing: ["Weak grip strength", "Slow gait"], computable: false },
      ],
      caveats: ["Partial coverage is not the published score."],
      ...over,
    },
    derivation: [
      {
        order: 1,
        kind: "code_component",
        description: "Code weight loss from weight_loss",
        expression: "weight_loss_flag = weight_loss",
        component: "Weight loss",
        conceptId: "c1#g0",
        needsReview: true,
      },
      {
        order: 2,
        kind: "combine",
        description: "Combine the coded components",
        expression: "score = weight_loss_flag + grip_flag",
        component: "",
        conceptId: null,
        needsReview: true,
      },
    ],
    units: "",
    validationRules: [],
    nConceptsIndexed: 8,
    callsMade: 1,
    sourceKind: "definition",
  };
}

// --- the algebra, in node --------------------------------------------------------------------------------

test.describe("declared score algebra", () => {
  test("@gate4 a declaration reads back in the order it was DECLARED, not alphabetically", () => {
    const index = { composite_swap: declarationRows() } as unknown as DecisionIndex;
    expect(declaredScores(index)).toEqual([{ scoreName: SCORE, components: DECLARED }]);
    expect(declaredScores({} as DecisionIndex)).toEqual([]);
  });

  test("@gate4 a score's spec is the newest one derived under its name", () => {
    const older = spec({ verdict: "infeasible" });
    const newer = spec();
    expect(specForScore([older, newer], SCORE.toUpperCase())).toBe(newer);
    expect(specForScore([older], "Another score")).toBeNull();
    expect(specForScore(null, SCORE)).toBeNull();
  });

  test("@gate4 the Match action names its one model call and its price before it runs", () => {
    expect(estimateScoreMatchUsd(48)).toBeGreaterThan(estimateScoreMatchUsd(5));
    const label = matchActionLabel(48);
    expect(label).toMatch(/^Match/);
    expect(label).toContain("one model call");
    expect(label).toContain(formatUsd(estimateScoreMatchUsd(48)));
  });

  test("@gate4 the score file says 'declared' — never a negative verdict — until a match exists", () => {
    const scores = [{ scoreName: SCORE, components: DECLARED }];
    const before = scoreExport(scores, null);
    expect(before.scores).toEqual([
      { scoreName: SCORE, declaredComponents: DECLARED, status: "declared", verdict: "indeterminate", spec: null },
    ]);
    const after = scoreExport(scores, [spec()]);
    expect(after.scores[0].status).toBe("matched");
    expect(after.scores[0].verdict).toBe("partial");
    expect(after.scores[0].spec?.derivation.length).toBeGreaterThan(0);
    expect(SCORE_ARTIFACT.id).toBe("score_json");
  });

  test("@gate4 F9 — before a match the verdict says NOT MATCHED YET, not that the run has no concepts", () => {
    expect(SCOPE_VERDICT_COPY.indeterminate).not.toMatch(/not produced any concepts/i);
    expect(SCOPE_VERDICT_COPY.indeterminate).toMatch(/not been matched/i);
    expect(SCOPE_VERDICT_COPY.indeterminate).toMatch(/cannot be determined/i);
  });

  test("@gate4 review 2 — the collapsed header says there is a score and whether it is matched, priced", () => {
    // Bhargav, final review round 2: "score builder section should be collapsible". Folded, the header still has to
    // say a score was declared and where it stands — and, unmatched, what matching costs (the price is never hidden
    // behind the disclosure).
    const before = gate4ScoreHeader(DECLARED.length, null, { refused: false });
    expect(before.state).toBe("unmatched");
    expect(before.text).toBe(
      `3 components · Not matched yet — matching is one model call, about ${formatUsd(estimateScoreMatchUsd(3))}`,
    );
    // The shared demo never spends, so the header does not price a call it will refuse.
    expect(gate4ScoreHeader(1, null, { refused: true }).text).toBe("1 component · Not matched yet — not available on the shared demo");
    const after = gate4ScoreHeader(DECLARED.length, spec(), { refused: false });
    expect(after.state).toBe("partial");
    expect(after.text).toBe("3 components · Matched: Some components are present (2/3)");
    // An unrecognized verdict reads as indeterminate, never as the negative claim.
    const odd = gate4ScoreHeader(3, spec({ verdict: "nonsense" as never }), { refused: false });
    expect(odd.state).toBe("indeterminate");
    expect(odd.text).toBe("3 components · Matched: Cannot be determined yet (2/3)");
  });

  test("@gate4 Gate 1's promise points at Gate 4 instead of a verdict that never arrives", () => {
    expect(GATE1_MATCH_DEFERRED).toMatch(/Gate 4/);
    expect(GATE1_MATCH_DEFERRED).not.toMatch(/fills in once the run has got that far/i);
  });
});

// --- the screen -----------------------------------------------------------------------------------------

async function openGate4(
  page: Page,
  { pinned = false, declared = true }: { pinned?: boolean; declared?: boolean } = {},
): Promise<void> {
  await serveFinished(page, (run) => {
    (run.config as Record<string, unknown>).demo = pinned;
  });
  if (declared) {
    await page.addInitScript(
      ([jobId, rows]) => {
        sessionStorage.setItem(
          `ddharmon.sandbox.${jobId}`,
          JSON.stringify({ gateDecisions: { composite_swap: rows } }),
        );
      },
      [FINISHED_JOB, declarationRows()] as const,
    );
  }
  await page.goto(`/run/${FINISHED_JOB}/gate4`);
  await page.waitForLoadState("networkidle");
}

/** Unfold the declared-score panel (review 2: it is a disclosure, folded by default). */
async function unfoldScore(page: Page): Promise<void> {
  const toggle = page.getByTestId("gate4-score-toggle");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
}

async function routeMatch(page: Page, answer: { status: number; body: unknown }): Promise<unknown[]> {
  const sent: unknown[] = [];
  await page.route("**/api/harmonize/jobs/*/composite", async (route: Route) => {
    sent.push(route.request().postDataJSON());
    await route.fulfill({ status: answer.status, contentType: "application/json", body: JSON.stringify(answer.body) });
  });
  return sent;
}

test.describe("Gate 4 declared score", () => {
  test("@gate4 no declared score: no score panel, and the export set is the shipping four", async ({ page }) => {
    await openGate4(page, { declared: false });
    await expect(page.getByTestId("gate4-score")).toHaveCount(0);
    await expect(page.getByTestId("artifact-tile")).toHaveCount(REAL_ARTIFACTS.length);
  });

  test("@gate4 review 2 — the score panel is a disclosure: folded, its header still names the score and its state", async ({
    page,
  }) => {
    const sent = await routeMatch(page, { status: 200, body: spec() });
    await openGate4(page);
    const panel = page.getByTestId("gate4-score");
    const toggle = panel.getByTestId("gate4-score-toggle");
    // Folded by default, like the how-to strip and Gate 1's score strip — and the header still says it all.
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(toggle).toContainText(SCORE);
    const state = panel.getByTestId("gate4-score-state");
    await expect(state).toHaveAttribute("data-state", "unmatched");
    await expect(state).toHaveText(gate4ScoreHeader(DECLARED.length, null, { refused: false }).text);
    await expect(panel.getByTestId("gate4-score-component")).toHaveCount(0);
    await expect(panel.getByTestId("gate4-score-match")).toHaveCount(0);
    // Unfolding shows the declaration; folding again hides it. Nothing is spent by either.
    await unfoldScore(page);
    await expect(panel.getByTestId("gate4-score-component")).toHaveCount(DECLARED.length);
    await panel.getByTestId("gate4-score-match").click();
    // Matched: the header now says so, with the verdict and its coverage.
    await expect(state).toHaveAttribute("data-state", "partial");
    await expect(state).toHaveText(gate4ScoreHeader(DECLARED.length, spec(), { refused: false }).text);
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(panel.getByTestId("gate4-score-component")).toHaveCount(0);
    await expect(state).toContainText("Matched: Some components are present (2/3)");
    expect(sent).toHaveLength(1);
  });

  test("@gate4 the declaration is shown READ-ONLY, in declared order, with the price before the press", async ({
    page,
  }) => {
    const sent = await routeMatch(page, { status: 200, body: spec() });
    await openGate4(page);
    const panel = page.getByTestId("gate4-score");
    await expect(panel).toBeVisible();
    await unfoldScore(page);
    await expect(panel).toContainText(SCORE);
    await expect(panel.getByTestId("gate4-score-component")).toHaveText(DECLARED.map((c) => new RegExp(c)));
    // A record, not a form: nothing here edits the declaration.
    await expect(panel.locator("textarea, input[type='text']")).toHaveCount(0);
    await expect(panel.getByRole("button", { name: /Declare/ })).toHaveCount(0);
    // Not matched yet: indeterminate, worded as "not matched", never the negative claim.
    const verdict = panel.getByTestId("gate4-score-verdict");
    await expect(verdict).toHaveAttribute("data-verdict", "indeterminate");
    await expect(verdict).toContainText(/not been matched/i);
    // The paid action carries its price ON the control, and nothing was spent by opening the screen.
    await expect(panel.getByTestId("gate4-score-match")).toHaveText(matchActionLabel(DECLARED.length));
    expect(sent).toEqual([]);
    // The score leaves the tool in its own file even before a match — declared, stated as such.
    await expect(page.locator(`[data-testid="artifact-tile"][data-thing="score_json"]`)).toBeVisible();
  });

  test("@gate4 Match runs ONE call on the declaration and shows the verdict, coverage and recipe", async ({ page }) => {
    const sent = await routeMatch(page, { status: 200, body: { ...spec(), billedUsd: 0.12 } });
    await openGate4(page);
    const panel = page.getByTestId("gate4-score");
    await unfoldScore(page);
    await panel.getByTestId("gate4-score-match").click();
    await expect(panel.getByTestId("gate4-score-verdict")).toHaveAttribute("data-verdict", "partial");
    expect(sent).toEqual([{ declaredScore: SCORE }]);
    // Rule 3: partial is not the published score, in words.
    await expect(panel.getByTestId("gate4-score-verdict")).toContainText(/not the published score/i);
    // Each component: matched to the REVIEWER'S concept name, or an honest gap.
    const weight = panel.locator(`[data-testid="gate4-score-component"][data-component="Weight loss"]`);
    await expect(weight).toHaveAttribute("data-verdict", "full");
    await expect(weight).toContainText("Unintentional weight loss (reviewer's name)");
    const gait = panel.locator(`[data-testid="gate4-score-component"][data-component="Slow gait"]`);
    await expect(gait).toHaveAttribute("data-verdict", "infeasible");
    await expect(gait).toContainText(/2 candidate concepts/);
    // Per-cohort computability and the recipe itself.
    await expect(panel.getByTestId("gate4-score-cohort")).toHaveCount(2);
    await expect(panel.getByTestId("gate4-score-step")).toHaveCount(2);
    await expect(panel.getByTestId("gate4-score-step").first()).toContainText("weight_loss_flag = weight_loss");
    await expect(panel.getByTestId("gate4-score-billed")).toContainText("$0.12");

    // The export carries it: the score file's preview is the verdict + recipe, not a description.
    await page
      .locator('[data-testid="artifact-tile"][data-thing="score_json"] [data-testid="artifact-preview"]')
      .click();
    const content = page.getByTestId("artifact-preview-content");
    await expect(content).toContainText('"status": "matched"');
    await expect(content).toContainText('"verdict": "partial"');
    await expect(content).toContainText("weight_loss_flag = weight_loss");
  });

  test("@gate4 a failed match is reported as a failure, never as a verdict", async ({ page }) => {
    await routeMatch(page, { status: 502, body: { detail: "The provider is overloaded." } });
    await openGate4(page);
    const panel = page.getByTestId("gate4-score");
    await unfoldScore(page);
    await panel.getByTestId("gate4-score-match").click();
    await expect(panel.getByTestId("gate4-score-error")).toContainText("overloaded");
    await expect(panel.getByTestId("gate4-score-verdict")).toHaveAttribute("data-verdict", "indeterminate");
  });

  test("@gate4 the shared demo shows the declaration but refuses to spend, and says why", async ({ page }) => {
    const sent = await routeMatch(page, { status: 200, body: spec() });
    await openGate4(page, { pinned: true });
    const panel = page.getByTestId("gate4-score");
    await expect(panel.getByTestId("gate4-score-state")).toContainText("not available on the shared demo");
    await unfoldScore(page);
    await expect(panel.getByTestId("gate4-score-component")).toHaveCount(DECLARED.length);
    await expect(panel.getByTestId("gate4-score-match")).toHaveCount(0);
    await expect(panel.getByTestId("not-available")).toContainText(/demo/i);
    expect(sent).toEqual([]);
  });
});

test.describe("Gate 1 score strip copy", () => {
  test("@gate1 the declared score's verdict says 'not matched yet' and the match is sent to Gate 4", async ({
    page,
  }) => {
    await page.goto(`/run/${PAUSED_JOB}/gate1`);
    await page.waitForLoadState("networkidle");
    await page.locator("[data-testid='score-panel-toggle']").click();
    await page.locator("[data-testid='score-components']").fill("Weak grip strength\nSlow walking speed");
    await page.getByRole("button", { name: "Declare these components" }).click();
    const verdict = page.locator("[data-testid='score-verdict']");
    await expect(verdict).toHaveAttribute("data-verdict", "indeterminate");
    await expect(verdict).not.toContainText(/not produced any concepts/i);
    const na = page.locator("[data-testid='score-panel'] [data-testid='not-available']");
    await expect(na).toContainText(/Gate 4/);
    await expect(na).not.toContainText(/fills in once the run has got that far/i);
  });
});
