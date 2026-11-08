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
    // Reached weakly for Hearing difficulty, but SUGGESTED for Glaucoma — so it is in scope for Glaucoma's reason.
    { group: g[1]!, score: 0.4, component: "Hearing difficulty" },
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
    await expect(panel.getByTestId("score-suggestion-columns")).toContainText(/best similarity/i);
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

  test("@gate1 that ticked groups continue to Gate 2 is said once, in the info strip — not on every card", async ({ page }) => {
    // Round 5 repeated-copy sweep: "→ continues to Gate 2" sat on every card with a group in scope.
    const panel = await openGate1Panel(page);
    await expect(panel.getByText("→ continues to Gate 2")).toHaveCount(0);
    await expect(panel.getByTestId("score-suggestion-info")).toContainText(/continue to Gate 2/i);
  });

  test("@gate1 the info strip says it is a free search, not a judgement, and states the cut-off", async ({ page }) => {
    const panel = await openGate1Panel(page);
    const info = panel.getByTestId("score-suggestion-info");
    await expect(info).toContainText(/free search/i);
    await expect(info).toContainText("$0");
    await expect(info).toContainText(/not a judgement/i);
    await expect(info).toContainText(/membership, not a match/i);
    // The cut-off is the reviewer's to change (round 6), in its own always-visible line outside the strip's fold (round
    // 7) — since 2026-11-08 one per list, in that list's fold ("implement per list cutoff"), never in the strip.
    await expect(info.getByTestId("score-cutoff-input")).toHaveCount(0);
    await expect(
      panel.getByTestId("spotlight-list").getByTestId("score-cutoff-line").getByTestId("score-cutoff-input"),
    ).toHaveValue(TAU.toFixed(2));
  });

  test("@gate1 opened, a card lists every group reached best-first, the cut-off drawn between, the best match by its question", async ({
    page,
  }) => {
    const panel = await openGate1Panel(page);
    const card = cardOf(panel, "Glaucoma");
    await card.getByTestId("score-suggestion-expand").click();
    const groups = card.getByTestId("score-suggestion-group");
    // Below the cut-off is folded away until asked for (round 6); the fold IS the cut-off line.
    await expect(groups).toHaveCount(2);
    await card.getByTestId("score-suggestion-cutoff").click();
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
    await card.getByTestId("score-suggestion-cutoff").click();
    await expect(row(top!)).toHaveAttribute("data-in-scope", "true");
    await expect(row(below!)).toHaveAttribute("data-in-scope", "false");

    await row(top!).getByTestId("score-suggestion-group-toggle").click();
    await expect(scopeOf(page, top!)).toHaveAttribute("aria-checked", "false");
    await expect(row(top!)).toHaveAttribute("data-in-scope", "false");
    await expect(card.getByTestId("score-suggestion-spread")).toContainText("1 in scope");
    // A group below the cut-off can be put in scope from here too — the reviewer catching a miss. It is in scope and
    // says why, but the spread stays the count of THIS component's suggestions kept: scope is one set for the gate,
    // and the live rig showed that counting every in-scope group a search reached (a driver's or a bulk include's
    // explicit picks among them) inflates every card.
    await row(below!).getByTestId("score-suggestion-group-toggle").click();
    await expect(scopeOf(page, below!)).toHaveAttribute("aria-checked", "true");
    await expect(row(below!)).toHaveAttribute("data-counted", "false");
    await expect(row(below!).getByTestId("score-suggestion-scope-why")).toHaveText(/your choice/i);
    await expect(card.getByTestId("score-suggestion-spread")).toContainText("1 in scope");
  });

  test("@gate1 a group in scope only because ANOTHER component suggested it is named so, and not counted here", async ({
    page,
  }) => {
    const panel = await openGate1Panel(page);
    const card = cardOf(panel, "Hearing difficulty");
    const borrowed = fixtureGroups()[1]!.groupId; // suggested for Glaucoma at 0.70, reached here at 0.40
    // Its own suggestion (exactly at the cut-off) counts; the borrowed group does not — though it IS in scope.
    await expect(card.getByTestId("score-suggestion-spread")).toContainText("1 group suggested");
    await expect(card.getByTestId("score-suggestion-spread")).toContainText("1 in scope");
    await expect(card.getByTestId("score-suggestion-spread")).toContainText(`${fixtureGroups()[2]!.nMembers} variables`);
    await card.getByTestId("score-suggestion-expand").click();
    await card.getByTestId("score-suggestion-cutoff").click();
    const row = card.locator(`[data-testid='score-suggestion-group'][data-group='${borrowed}']`);
    await expect(row).toHaveAttribute("data-in-scope", "true");
    await expect(row).toHaveAttribute("data-counted", "false");
    await expect(row.getByTestId("score-suggestion-scope-why")).toHaveText(/In scope for Glaucoma/);
    await expect(row.getByTestId("score-suggestion-group-toggle")).toBeChecked();
  });

  test("@gate1 a component with nothing suggested says so — never that it is missing from the cohorts", async ({
    page,
  }) => {
    const panel = await openGate1Panel(page);
    const tinnitus = cardOf(panel, "Tinnitus");
    await expect(tinnitus).toHaveAttribute("data-suggested", "false");
    await expect(tinnitus.getByTestId("score-suggestion-none")).toHaveAccessibleName(/nothing suggested/i);
    // What it reached below the cut-off is the fold's own label, one click away — not a sentence on the card.
    await tinnitus.getByTestId("score-suggestion-expand").click();
    await expect(tinnitus.getByTestId("score-suggestion-cutoff")).toContainText(/1 group below the cut-off/i);
    const migraine = cardOf(panel, "Migraine");
    await expect(migraine.getByTestId("score-suggestion-none")).toHaveAccessibleName(/nothing suggested/i);
    await expect(migraine.getByTestId("score-suggestion-similarity")).toHaveCount(0);
    for (const card of [tinnitus, migraine]) await expect(card).not.toContainText(/missing|not found|lacks/i);
  });

  test("@gate1 what 'nothing suggested' means is said ONCE, in the info strip — each card keeps one short line", async ({
    page,
  }) => {
    // Bhargav 2026-10-05: the same three-line caveat repeated on every unsuggested card (dozens on a 49-item score).
    const panel = await openGate1Panel(page);
    const cards = panel.locator("[data-testid='score-suggestions']");
    // The info strip now sits in the panel's one guide, ABOVE the lists (2026-11-08): said once there, for every list,
    // and not again inside a list's cards.
    const guide = panel.getByTestId("score-suggestion-guide");
    await expect(guide).toHaveCount(1);
    await expect(panel.getByTestId("score-suggestion-info")).toHaveCount(1);
    await expect(guide.getByTestId("score-suggestion-info")).toContainText(/not a finding about your cohorts/i);
    await expect(guide.getByText(/not a finding about your cohorts/i)).toHaveCount(1);
    await expect(cards.getByText(/not a finding about your cohorts/i)).toHaveCount(0);
    for (const c of ["Tinnitus", "Migraine"]) {
      await expect(cardOf(panel, c)).not.toContainText(/not a finding|Gate 4/i);
    }
  });

  test("@gate1 no dense encoder: no cards — the plain declared list stands", async ({ page }) => {
    const empty = suggestions().scores.map((sc) => ({ ...sc, components: sc.components.map((c) => ({ ...c, groups: [] })) }));
    const panel = await openGate1Panel(page, suggestions({ scored: false, reason: "no dense encoder", scores: empty }));
    await expect(panel.locator("[data-testid='score-suggestion']")).toHaveCount(0);
    await expect(panel.locator("[data-testid='score-component']")).toHaveCount(DECLARED.length);
  });
});

// --- Gate 4: the match cards ------------------------------------------------------------------------------------

test.describe("score panel — review round 6 (Bhargav, live Lavish build 2026-10-09)", () => {
  test("@gate1 the 'how suggestions work' strip is a fold, open until closed", async ({ page }) => {
    const panel = await openGate1Panel(page);
    const toggle = panel.getByTestId("score-suggestion-info-toggle");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(panel.getByTestId("score-suggestion-info")).toContainText(/free search/i);
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(panel.getByText(/retrieval only, no model call/i)).toHaveCount(0);
  });

  test("@gate1 a component row folds like every other fold: the whole row lights on hover", async ({ page }) => {
    const panel = await openGate1Panel(page);
    const trigger = cardOf(panel, "Glaucoma").getByTestId("score-suggestion-expand");
    const bg = () => trigger.evaluate((el) => getComputedStyle(el).backgroundColor);
    const before = await bg();
    await trigger.hover();
    await expect.poll(bg).not.toBe(before);
  });

  test("@gate1 'best similarity' and 'nothing suggested' are said once for the list, not on every component", async ({
    page,
  }) => {
    const panel = await openGate1Panel(page);
    const list = panel.getByTestId("score-suggestions");
    // Once as the column's head, never on a component row. (The info strip explains it under the same name since
    // round 7 — "The figure." was ambiguous — which is the explanation, not a repeat on the list.)
    await expect(list.getByTestId("score-suggestion-columns").getByText(/best similarity/i)).toHaveCount(1);
    await expect(list.getByTestId("score-suggestion").getByText(/best similarity/i)).toHaveCount(0);
    // No visible sentence per unsuggested card; the strip says what the dashed marker means.
    await expect(list.getByText(/reached below the cut-off/i)).toHaveCount(0);
    await expect(panel.getByTestId("score-suggestion-info")).toContainText(/nothing suggested/i);
  });

  test("@gate1 groups below the cut-off are folded away until asked for", async ({ page }) => {
    const panel = await openGate1Panel(page);
    const card = cardOf(panel, "Glaucoma");
    await card.getByTestId("score-suggestion-expand").click();
    const below = card.locator("[data-testid='score-suggestion-group'][data-suggested='false']");
    const fold = card.getByTestId("score-suggestion-cutoff");
    await expect(fold).toHaveAttribute("aria-expanded", "false");
    await expect(fold).toContainText(/1 group below the cut-off 0\.62/i);
    await expect(below).toHaveCount(0);
    await fold.click();
    await expect(below).toHaveCount(1);
  });

  test("@gate1 on a run Full auto passed, a group's scope says Full auto sent it — never 'your choice'", async ({
    page,
  }) => {
    // Bhargav: "why are these checked if they didnt meet the cutoff?" — Full auto sends every group to Gate 2, and the
    // card called that the reviewer's choice.
    const panel = await openGate1Panel(page, suggestions(), (run) => {
      run.gatePosition = "gate4";
      run.result!.gatePosition = "gate4";
      // The shared demo (Bhargav's case): parked at Gate 4 by Full auto, still practisable, and carrying its SHIPPED
      // score — the declaration and Gate 1's hints — which is what a demo's cards read (it never asks the route).
      (run as JobResult).demoScore = { declaration: declaration(DECLARED) as Record<string, unknown>[], suggestions: suggestions() };
      run.config = {
        ...(run.config ?? {}),
        demo: true,
        review_mode: "auto",
        gate_decided_by: { gate1: "auto", gate2: "auto", gate3: "auto" },
        gate1_scope: fixtureGroups().map((g) => g.groupId),
      } as JobResult["config"];
    });
    const card = cardOf(panel, "Glaucoma");
    await card.getByTestId("score-suggestion-expand").click();
    await card.getByTestId("score-suggestion-cutoff").click();
    const below = card.locator("[data-testid='score-suggestion-group'][data-suggested='false']");
    await expect(below.getByTestId("score-suggestion-group-toggle")).toBeChecked();
    await expect(below.getByTestId("score-suggestion-scope-why")).toHaveText(/sent by Full auto/i);
    await expect(panel.getByTestId("score-suggestion-scope-why").filter({ hasText: /your choice/i })).toHaveCount(0);
  });

  test("@gate1 once a score is declared, the declaration form is folded behind 'Declare a different Spotlight list'", async ({
    page,
  }) => {
    const panel = await openGate1Panel(page);
    const fold = panel.getByTestId("score-declare-toggle");
    await expect(fold).toHaveText(/declare a different Spotlight list/i);
    await expect(fold).toHaveAttribute("aria-expanded", "false");
    await expect(panel.getByTestId("score-components")).toHaveCount(0);
    await fold.click();
    await expect(panel.getByTestId("score-components")).toBeVisible();
  });
});

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
/** `g4Spec()` with NO coding rule on any component — what a score declared as a list of names carries. */
function uncodedSpec(sourceKind: CompositeSpec["sourceKind"]): CompositeSpec {
  const sp = g4Spec();
  const unstated = {
    kind: "unstated",
    cutoff: "",
    referenceRange: "",
    codeMap: {},
    formula: "",
    units: "",
    statedInSource: false,
    needsReview: true,
  };
  return {
    ...sp,
    sourceKind,
    definition: { ...sp.definition, components: sp.definition.components.map((c) => ({ ...c, coding: unstated })) },
  } as unknown as CompositeSpec;
}

async function openGate4Matched(
  page: Page,
  { match = true, spec = g4Spec() }: { match?: boolean; spec?: CompositeSpec } = {},
): Promise<Locator> {
  await page.route("**/api/harmonize/jobs/*/composite", (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(spec) }),
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
    await expect(panel.getByText("Items → this run's concepts")).toBeVisible();
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

  test("@gate4 a DECLARED score's missing coding is said once above the cards, not as a badge on every card", async ({
    page,
  }) => {
    // Bhargav 2026-10-05 (option A): 49 identical "no coding rule in source" badges on the live run hid each outcome.
    const panel = await openGate4Matched(page, { spec: uncodedSpec("declaration") });
    await expect(panel.getByTestId("score-coding-unstated-note")).toHaveCount(1);
    await expect(panel.getByTestId("score-coding-unstated-note")).toContainText(/declared/i);
    await expect(panel.getByTestId("score-coding-review")).toHaveCount(0);
  });

  test("@gate4 a score READ FROM A DOCUMENT keeps the badge on each card — there it marks the items the source left uncoded", async ({
    page,
  }) => {
    const panel = await openGate4Matched(page, { spec: uncodedSpec("definition") });
    await expect(panel.getByTestId("score-coding-unstated-note")).toHaveCount(0);
    await expect(panel.getByTestId("score-coding-review")).toHaveCount(G4_DECLARED.length);
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
    // What a missing match is NOT is the panel's to say, once — never on the row (round 5 sweep).
    await expect(gait).not.toContainText(/not a finding/i);
    await expect(panel.getByTestId("missing-is-a-run-result")).toHaveCount(1);
  });
});
