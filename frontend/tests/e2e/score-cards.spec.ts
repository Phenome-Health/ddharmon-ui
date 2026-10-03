import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import { decisionItemKey, optionSetKey, type GateDecision } from "@/lib/gate-decisions";
import { SANDBOX_PREFIX } from "@/lib/sandbox";
import { suggestionCards } from "@/lib/score-suggestion-cards";
import type { CompositeSpec, JobResult, ScoreSuggestions } from "@/types";
import { PAUSED_JOB, asOwnedRun, fixtureGroups, gate1Fixture, serveRun } from "./gate1-fixture";
import { FINISHED_JOB, finishedRecords, serveFinished } from "./gate23-fixture";

/**
 * The score builder's per-component CARDS, back on both gates that hold half of what they used to show (08-28,
 * Bhargav 2026-10-02: "what happened to the old score builder look?" → option A).
 *
 * WHY THEY WENT. The cards (`SpecView` in `pages/composite.tsx`) only ever drew from a PAID match. Decision Q5 moved
 * that match to Gate 4, so a live Gate 1 never had one and fell back to a plain list of names — and Gate 4 got a new,
 * one-line-per-component panel instead of the cards. Nobody decided to drop the look; it was stranded.
 *
 * WHAT COMES BACK, AND WITH WHICH NUMBER. The old card did two jobs, now on two screens:
 *   - Gate 1 (SCOPING): a card per component from the FREE search — the groups it reached, what is in them, which are
 *     in scope. Its figure is the search's similarity and is labelled so: a cosine is not the judge's confidence and
 *     is never shown in the judge's slot ("mean best / cohort").
 *   - Gate 4 (VERDICT): the old card itself, from the match, as a RECORD — scope was settled on Gate 1, so there is
 *     no checkbox and no "Gate 2" tag, and every group the match reached counts toward the figure, as it does toward
 *     the coverage the verdict is computed from.
 *
 *   run: E2E_PORT=4243 npx playwright test score-cards
 */

// --- Gate 1: the suggestion cards -------------------------------------------------------------------------------

/** The payload carries core's calibrated cut-off; the cards read it from there. */
const TAU = 0.62;
const SCORE = "Frailty index (Williams 2019)";
/** Declared in a non-alphabetical order: the cards follow the declaration, never a sort. */
const DECLARED = ["Hearing difficulty", "Glaucoma", "Tinnitus", "Migraine"];

/** Six real fixture groups and the cosine the free search scored each with. Migraine reached nothing at all. */
function reached() {
  const g = fixtureGroups();
  return [
    { group: g[0]!, score: 0.91, component: "Glaucoma" },
    { group: g[1]!, score: 0.7, component: "Glaucoma" },
    { group: g[4]!, score: 0.3, component: "Glaucoma" }, // below the cut-off: listed, not suggested
    { group: g[2]!, score: TAU, component: "Hearing difficulty" }, // exactly AT the cut-off: suggested (>=)
    { group: g[3]!, score: 0.61, component: "Hearing difficulty" },
    { group: g[5]!, score: 0.5, component: "Tinnitus" }, // reached, but only below the cut-off
  ];
}

function suggestions(over: Partial<ScoreSuggestions> = {}): ScoreSuggestions {
  const r = reached();
  return {
    scored: true,
    scoreKind: "dense_cosine",
    threshold: TAU,
    reason: "",
    billedUsd: 0,
    scores: [
      {
        scoreName: SCORE,
        nVariablesIndexed: 328,
        components: DECLARED.map((component) => ({
          component,
          groups: r
            .filter((x) => x.component === component)
            .map((x) => ({ groupId: x.group.groupId, score: x.score, bestMember: x.group.memberVariableNames[0] ?? "" })),
        })),
      },
    ],
    ...over,
  };
}

function declaration(components: string[]): GateDecision[] {
  return components.map((componentName) => ({
    scoreName: SCORE,
    componentName,
    chosen: "",
    alternatives: components,
    optionSetKey: optionSetKey(components),
  }));
}

async function seedSandbox(page: Page, kinds: Record<string, GateDecision[]>): Promise<void> {
  const gateDecisions = Object.fromEntries(
    Object.entries(kinds).map(([kind, rows]) => [
      kind,
      Object.fromEntries(rows.map((r) => [decisionItemKey(kind as never, r), r])),
    ]),
  );
  await page.addInitScript(
    ([key, state]) => sessionStorage.setItem(key, state),
    [`${SANDBOX_PREFIX}${PAUSED_JOB}`, JSON.stringify({ gateDecisions })] as const,
  );
}

async function serveSuggestions(page: Page, body: ScoreSuggestions): Promise<void> {
  await page.route("**/api/harmonize/jobs/*/score/suggestions", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) }),
  );
}

/** Gate 1 of the reviewer's OWN run with `DECLARED` declared and `body` as the free search's answer; panel open. */
async function openGate1Panel(
  page: Page,
  body: ScoreSuggestions = suggestions(),
  mutate: (run: JobResult) => void = () => {},
): Promise<Locator> {
  await seedSandbox(page, { composite_swap: declaration(DECLARED) });
  await serveSuggestions(page, body);
  await serveRun(page, (run) => {
    asOwnedRun(run);
    mutate(run);
  });
  await page.goto(`/run/${PAUSED_JOB}/gate1`);
  await page.waitForLoadState("networkidle");
  await expect(page.locator("[data-testid='ledger']")).toBeVisible();
  await page.locator("[data-testid='score-panel-toggle']").click();
  const panel = page.locator("[data-testid='score-panel']");
  await expect(panel).toBeVisible();
  return panel;
}

const cardOf = (panel: Locator, component: string) =>
  panel.locator(`[data-testid='score-suggestion'][data-component='${component}']`);
const scopeOf = (page: Page, gid: string) =>
  page.locator(`[data-testid='ledger-row'][data-row-id='${gid}'] [data-testid='queue-scope']`);

test.describe("score cards — the suggestion algebra (node)", () => {
  test("@gate1 one card per DECLARED component, in declared order; groups best-first, flagged at the payload's cut-off", () => {
    const cards = suggestionCards(DECLARED, suggestions());
    expect(cards.map((c) => c.component)).toEqual(DECLARED);
    const glaucoma = cards.find((c) => c.component === "Glaucoma")!;
    expect(glaucoma.groups.map((g) => g.score)).toEqual([0.91, 0.7, 0.3]);
    expect(glaucoma.groups.map((g) => g.suggested)).toEqual([true, true, false]);
    expect(glaucoma.best).toBe(0.91);
    expect(glaucoma.nSuggested).toBe(2);
    // AT the cut-off is suggested (>=), as the scope rule seeds it.
    expect(cards.find((c) => c.component === "Hearing difficulty")!.nSuggested).toBe(1);
    // Reached only below the cut-off: listed, nothing suggested. Reached nothing: no groups, no figure.
    const tinnitus = cards.find((c) => c.component === "Tinnitus")!;
    expect([tinnitus.nSuggested, tinnitus.groups.length, tinnitus.best]).toEqual([0, 1, 0.5]);
    const migraine = cards.find((c) => c.component === "Migraine")!;
    expect([migraine.groups.length, migraine.best]).toEqual([0, null]);
  });

  test("@gate1 a component named in a different case still finds its suggestion; no dense score, no cards", () => {
    expect(suggestionCards(["glaucoma"], suggestions())[0]!.nSuggested).toBe(2);
    expect(suggestionCards(DECLARED, suggestions({ scored: false }))).toEqual([]);
    expect(suggestionCards(DECLARED, null)).toEqual([]);
  });
});

test.describe("score cards — Gate 1 (the free search)", () => {
  test("@gate1 each declared component is a card, in declared order, its figure labelled as a search similarity", async ({
    page,
  }) => {
    const panel = await openGate1Panel(page);
    await expect(panel.locator("[data-testid='score-suggestion']")).toHaveText(DECLARED.map((c) => new RegExp(c)));
    const glaucoma = cardOf(panel, "Glaucoma");
    await expect(glaucoma).toHaveAttribute("data-suggested", "true");
    await expect(glaucoma.getByTestId("score-suggestion-similarity")).toHaveText("0.91");
    await expect(glaucoma).toContainText(/best similarity/i);
    // Never the judge's slot: a cosine is a different scale from the match's confidence.
    await expect(panel.locator("[data-testid='score-suggestions']")).not.toContainText(/mean best/i);
    await expect(panel.locator("[data-testid='score-match']")).toHaveCount(0);
  });

  test("@gate1 the always-visible spread counts the suggested groups, what is in them, and what is in scope", async ({
    page,
  }) => {
    const panel = await openGate1Panel(page);
    const [g0, g1] = [fixtureGroups()[0]!, fixtureGroups()[1]!];
    const cohorts = [...new Set([...g0.cohorts, ...g1.cohorts])];
    const spread = cardOf(panel, "Glaucoma").getByTestId("score-suggestion-spread");
    await expect(spread).toContainText("2 groups suggested");
    await expect(spread).toContainText(`${g0.nMembers + g1.nMembers} variables`);
    await expect(spread).toContainText(`${cohorts.length} cohorts`);
    await expect(spread).toContainText("2 in scope");
  });

  test("@gate1 the info strip says it is a free search, not a judgement, and states the cut-off", async ({ page }) => {
    const panel = await openGate1Panel(page);
    const info = panel.getByTestId("score-suggestion-info");
    await expect(info).toContainText(/free search/i);
    await expect(info).toContainText("$0");
    await expect(info).toContainText(/not a judgement/i);
    await expect(info).toContainText(/membership, not a match/i);
    await expect(info).toContainText(TAU.toFixed(2));
  });

  test("@gate1 opened, a card lists every group reached best-first, the cut-off drawn between, the best match by its question", async ({
    page,
  }) => {
    const panel = await openGate1Panel(page);
    const card = cardOf(panel, "Glaucoma");
    await card.getByTestId("score-suggestion-expand").click();
    const groups = card.getByTestId("score-suggestion-group");
    await expect(groups).toHaveCount(3);
    const expected = reached().filter((x) => x.component === "Glaucoma");
    for (const [i, x] of expected.entries()) {
      await expect(groups.nth(i)).toHaveAttribute("data-group", x.group.groupId);
      await expect(groups.nth(i)).toHaveAttribute("data-suggested", String(x.score >= TAU));
    }
    await expect(card.getByTestId("score-suggestion-cutoff")).toHaveCount(1);
    await expect(card.getByTestId("score-suggestion-cutoff")).toContainText(TAU.toFixed(2));
    // The best member is named by its question text, never its raw "cohort:var" id.
    const best = fixtureGroups()[0]!.memberVariableNames[0]!;
    const question = gate1Fixture().result!.fieldIndex![best]!.questionText!;
    const bestLine = groups.first().getByTestId("score-suggestion-best");
    await expect(bestLine).toContainText(question.slice(0, 30));
    await expect(bestLine).toContainText(best.slice(0, best.indexOf(":")));
  });

  test("@gate1 a card's checkbox IS the group's Gate 1 scope: the queue follows it, and the spread re-counts", async ({
    page,
  }) => {
    const panel = await openGate1Panel(page);
    const card = cardOf(panel, "Glaucoma");
    await card.getByTestId("score-suggestion-expand").click();
    const [top, , below] = reached().filter((x) => x.component === "Glaucoma").map((x) => x.group.groupId);
    const row = (gid: string) => card.locator(`[data-testid='score-suggestion-group'][data-group='${gid}']`);
    await expect(row(top!)).toHaveAttribute("data-in-scope", "true");
    await expect(row(below!)).toHaveAttribute("data-in-scope", "false");

    await row(top!).getByTestId("score-suggestion-group-toggle").click();
    await expect(scopeOf(page, top!)).toHaveAttribute("aria-checked", "false");
    await expect(row(top!)).toHaveAttribute("data-in-scope", "false");
    // A group below the cut-off can be put in scope from here too — the reviewer catching a miss.
    await row(below!).getByTestId("score-suggestion-group-toggle").click();
    await expect(scopeOf(page, below!)).toHaveAttribute("aria-checked", "true");
    await expect(card.getByTestId("score-suggestion-spread")).toContainText("2 in scope");
  });

  test("@gate1 a component with nothing suggested says so — never that it is missing from the cohorts", async ({
    page,
  }) => {
    const panel = await openGate1Panel(page);
    const tinnitus = cardOf(panel, "Tinnitus");
    await expect(tinnitus).toHaveAttribute("data-suggested", "false");
    await expect(tinnitus.getByTestId("score-suggestion-none")).toContainText(/nothing suggested/i);
    await expect(tinnitus.getByTestId("score-suggestion-none")).toContainText(/1 group reached below the cut-off/i);
    const migraine = cardOf(panel, "Migraine");
    await expect(migraine.getByTestId("score-suggestion-none")).toContainText(/nothing suggested/i);
    await expect(migraine.getByTestId("score-suggestion-similarity")).toHaveCount(0);
    for (const card of [tinnitus, migraine]) await expect(card).not.toContainText(/missing|not found|lacks/i);
  });

  test("@gate1 no dense encoder: no cards — the plain declared list stands", async ({ page }) => {
    const empty = suggestions().scores.map((sc) => ({ ...sc, components: sc.components.map((c) => ({ ...c, groups: [] })) }));
    const panel = await openGate1Panel(page, suggestions({ scored: false, reason: "no dense encoder", scores: empty }));
    await expect(panel.locator("[data-testid='score-suggestion']")).toHaveCount(0);
    await expect(panel.locator("[data-testid='score-component']")).toHaveCount(DECLARED.length);
  });
});

// --- Gate 4: the match cards ------------------------------------------------------------------------------------

const G4_SCORE = "Fried frailty phenotype";
const G4_DECLARED = ["Weight loss", "Weak grip strength", "Slow gait"];

function g4Rows() {
  return Object.fromEntries(
    G4_DECLARED.map((c) => [
      `${G4_SCORE}\u001f${c}`,
      { scoreName: G4_SCORE, componentName: c, chosen: "", alternatives: G4_DECLARED, optionSetKey: "k" },
    ]),
  );
}

/** A match over real finished-demo records (inside `serveFinished`'s default 12), union coverage member-level. */
function g4Spec(): CompositeSpec {
  const r = finishedRecords();
  const [smoked, started, years] = [r[2]!, r[3]!, r[4]!];
  const coding = {
    kind: "categorical",
    cutoff: "",
    referenceRange: "",
    codeMap: { no: "0", yes: "1" },
    formula: "",
    units: "",
    statedInSource: true,
    needsReview: false,
  };
  return {
    definition: {
      name: G4_SCORE,
      kind: "custom",
      citation: "",
      combinationRule: "",
      threshold: "",
      notes: "",
      statedNItems: null,
      underEnumerated: 0,
      provenance: "",
      sourceSha256: "",
      components: G4_DECLARED.map((name) => ({ name, definition: "", required: true, weight: null, coding })),
    },
    matches: [
      {
        component: "Weight loss",
        conceptId: smoked.id,
        concept: "Unintentional weight loss (reviewer's name)",
        column: "weight_loss",
        cohorts: smoked.cohorts,
        sourceVariables: [],
        confidence: 0.9,
        rationale: "",
        required: true,
        pinned: false,
        shortlist: [smoked.id],
        groupCandidates: [{ groupId: smoked.id, confidence: 0.9, nMatched: 2, nTotal: 3 }],
        coverageMembers: {
          "AI-READI": [{ variableId: "AI-READI:susmkncf", confidence: 0.9, groupId: smoked.id }],
          AoU: [{ variableId: "AoU:smoking_100cigslifetime", confidence: 0.7, groupId: smoked.id }],
        },
      },
      {
        component: "Weak grip strength",
        conceptId: years.id,
        concept: years.concept,
        column: "grip",
        cohorts: years.cohorts,
        sourceVariables: [],
        confidence: 0.8,
        rationale: "",
        required: true,
        pinned: false,
        shortlist: [years.id, started.id],
        // Two groups, one BELOW the builder's 0.80 auto-select: on Gate 4 both count — scope is already settled.
        groupCandidates: [
          { groupId: years.id, confidence: 0.8 },
          { groupId: started.id, confidence: 0.6 },
        ],
        coverageMembers: {
          CLSA: [{ variableId: "CLSA:SMK_YRDL_NB_TRM", confidence: 0.8, groupId: years.id }],
          "AI-READI": [{ variableId: "AI-READI:susmkstaage", confidence: 0.6, groupId: started.id }],
        },
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
      perCohort: [{ cohort: "AI-READI", present: ["Weight loss", "Weak grip strength"], missing: ["Slow gait"], computable: false }],
      caveats: [],
    },
    derivation: [],
    units: "",
    validationRules: [],
    nConceptsIndexed: 12,
    callsMade: 1,
    sourceKind: "declaration",
  } as unknown as CompositeSpec;
}

/** Gate 4 with the score declared, unfolded, and matched (the match fulfilled at the network layer). */
async function openGate4Matched(page: Page, { match = true }: { match?: boolean } = {}): Promise<Locator> {
  await page.route("**/api/harmonize/jobs/*/composite", (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(g4Spec()) }),
  );
  await serveFinished(page, (run) => {
    (run.config as Record<string, unknown>).demo = false;
  });
  await page.addInitScript(
    ([jobId, rows]) =>
      sessionStorage.setItem(`ddharmon.sandbox.${jobId}`, JSON.stringify({ gateDecisions: { composite_swap: rows } })),
    [FINISHED_JOB, g4Rows()] as const,
  );
  await page.goto(`/run/${FINISHED_JOB}/gate4`);
  await page.waitForLoadState("networkidle");
  const panel = page.getByTestId("gate4-score");
  await panel.getByTestId("gate4-score-toggle").click();
  if (match) {
    await panel.getByTestId("gate4-score-match").click();
    await expect(panel.getByTestId("gate4-score-verdict")).toHaveAttribute("data-verdict", "partial");
  }
  return panel;
}

const g4Card = (panel: Locator, component: string) =>
  panel.locator(`[data-testid='score-match'][data-component='${component}']`);

test.describe("score cards — Gate 4 (the match)", () => {
  test("@gate4 before a match there are no cards — the declaration list stands", async ({ page }) => {
    const panel = await openGate4Matched(page, { match: false });
    await expect(panel.locator("[data-testid='score-match']")).toHaveCount(0);
    await expect(panel.getByTestId("gate4-score-component")).toHaveCount(G4_DECLARED.length);
  });

  test("@gate4 after the match each component is the builder's card, in declared order, with its figure and coding", async ({
    page,
  }) => {
    const panel = await openGate4Matched(page);
    await expect(panel.getByText("Components → this run's concepts")).toBeVisible();
    await expect(panel.locator("[data-testid='score-match']")).toHaveText(G4_DECLARED.map((c) => new RegExp(c)));
    // The one-line list is replaced, not doubled.
    await expect(panel.getByTestId("gate4-score-component")).toHaveCount(0);
    const weight = g4Card(panel, "Weight loss");
    await expect(weight).toContainText(/mean best \/ cohort/i);
    await expect(weight.getByTestId("score-confidence")).toHaveText("0.80"); // (0.9 + 0.7) / 2 cohorts
    await expect(weight.getByTestId("score-source-coding")).toContainText("no → 0");
    await expect(weight.getByTestId("score-spread")).toContainText("2 variables");
    await expect(weight.getByTestId("score-spread")).toContainText("2 cohorts (AI-READI, AoU)");
    await expect(weight.getByTestId("score-spread")).toContainText("1 group");
  });

  test("@gate4 every group the match reached counts — including one below the builder's auto-select", async ({ page }) => {
    const panel = await openGate4Matched(page);
    const grip = g4Card(panel, "Weak grip strength");
    await expect(grip.getByTestId("score-confidence")).toHaveText("0.70"); // (0.8 + 0.6) / 2 cohorts
    await expect(grip.getByTestId("score-spread")).toContainText("2 groups");
    await grip.getByTestId("score-component-expand").click();
    await expect(grip.getByTestId("score-group")).toHaveCount(2);
  });

  test("@gate4 the cards are a record: no scope checkbox, no Gate 2 tag, no auto-select copy", async ({ page }) => {
    const panel = await openGate4Matched(page);
    for (const c of G4_DECLARED.slice(0, 2)) await g4Card(panel, c).getByTestId("score-component-expand").click();
    await expect(panel.getByTestId("score-group")).toHaveCount(3);
    await expect(panel.getByTestId("score-group-toggle")).toHaveCount(0);
    await expect(panel.getByTestId("score-group-gate2")).toHaveCount(0);
    const cards = panel.locator("[data-testid='score-match']");
    for (const c of await cards.all()) await expect(c).not.toContainText(/Gate 2|auto-select|auto-queued/i);
    await expect(panel.getByTestId("score-builder-info")).not.toContainText(/auto-select/i);
  });

  test("@gate4 a matched card names its concept; a missing one says why without being opened", async ({ page }) => {
    const panel = await openGate4Matched(page);
    const weight = g4Card(panel, "Weight loss");
    await expect(weight).toHaveAttribute("data-verdict", "full");
    await expect(weight.getByTestId("score-match-summary")).toContainText(
      "Matched: Unintentional weight loss (reviewer's name)",
    );
    const gait = g4Card(panel, "Slow gait");
    await expect(gait).toHaveAttribute("data-verdict", "infeasible");
    await expect(gait.getByTestId("score-match-summary")).toContainText(/2 candidate concepts/);
  });
});
