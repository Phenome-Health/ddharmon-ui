import { expect, test, type Locator, type Page } from "@playwright/test";
import { decisionItemKey, optionSetKey, type GateDecision } from "@/lib/gate-decisions";
import { SANDBOX_PREFIX } from "@/lib/sandbox";
import { searchCoverage, suggestionCards, type SearchCoverage } from "@/lib/score-suggestion-cards";
import type { ScoreSuggestions } from "@/types";
import { PAUSED_JOB, asOwnedRun, fixtureGroups, serveRun } from "./gate1-fixture";

/**
 * Gate 1's per-cohort table, REACHED BY SEARCH (review round 6, Bhargav's note L7: "no cohort coverage table?";
 * answered 2026-10-13: option (b) — Gate 4 carries the full table next to the match, and Gate 1 carries this one).
 *
 * Gate 1 has no match, only the free search, so the table cannot say a cohort HAS a component. It says the search
 * REACHED it: a group this component's search suggested (at or above the cut-off), kept in scope, holds a variable
 * from that cohort. That is the rule each card's spread already counts ("in scope: N variables · M cohorts"), laid
 * out as a table — so the two cannot disagree. A blank is what this search reached, never "missing".
 *
 *   run: E2E_PORT=4199 npx playwright test tests/e2e/score-coverage.spec.ts
 */

const TAU = 0.62;
const SCORE = "Frailty index (Williams 2019)";
const DECLARED = ["Hearing difficulty", "Glaucoma", "Tinnitus"];
/** `summary.cohorts` of the committed fixture — the table's columns. */
const ROSTER = ["AI-READI", "AoU", "CLSA", "MESA", "UKBB"];

/**
 * Real fixture groups and the cosine the free search scored each with (the cut-off spec's own set). Their cohorts:
 * g0 AI-READI/CLSA/MESA · g1 AI-READI/CLSA/MESA/UKBB · g2 AoU · g3 AI-READI/CLSA/MESA/UKBB · g4 AI-READI/AoU ·
 * g5 AI-READI/CLSA/MESA/UKBB.
 */
function reached() {
  const g = fixtureGroups();
  return [
    { group: g[0]!, score: 0.91, component: "Glaucoma" },
    { group: g[1]!, score: 0.7, component: "Glaucoma" },
    { group: g[4]!, score: 0.3, component: "Glaucoma" },
    { group: g[2]!, score: 0.66, component: "Hearing difficulty" },
    { group: g[3]!, score: 0.58, component: "Hearing difficulty" },
    { group: g[5]!, score: 0.5, component: "Tinnitus" },
  ];
}
const gid = (i: number) => fixtureGroups()[i]!.groupId;
const cohortsOf = (id: string) => fixtureGroups().find((g) => g.groupId === id)?.cohorts;

function suggestions(): ScoreSuggestions {
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
  };
}

const reachedBy = (cov: SearchCoverage, component: string) => cov.rows.find((r) => r.component === component)?.reached;

test.describe("the reached-by-search table — as a function", () => {
  test("@gate1 a cohort is reached when a suggested group in scope holds one of its variables; below the cut-off never counts", () => {
    // Everything in scope — including the groups BELOW the cut-off, which still must not count (the card's own rule).
    const cov = searchCoverage(suggestionCards(DECLARED, suggestions()), ROSTER, cohortsOf, () => true);
    expect(cov.cohorts).toEqual(ROSTER);
    expect(cov.rows.map((r) => r.component)).toEqual(DECLARED); // declared order, never re-sorted
    expect(reachedBy(cov, "Glaucoma")).toEqual(["AI-READI", "CLSA", "MESA", "UKBB"]);
    expect(reachedBy(cov, "Hearing difficulty")).toEqual(["AoU"]);
    expect(reachedBy(cov, "Tinnitus")).toEqual([]);
    expect(cov.reachedPerCohort).toEqual({ "AI-READI": 1, AoU: 1, CLSA: 1, MESA: 1, UKBB: 1 });
  });

  test("@gate1 a suggested group taken out of scope takes its cohorts with it", () => {
    const cov = searchCoverage(suggestionCards(DECLARED, suggestions()), ROSTER, cohortsOf, (id) => id !== gid(1));
    expect(reachedBy(cov, "Glaucoma")).toEqual(["AI-READI", "CLSA", "MESA"]);
    expect(cov.reachedPerCohort.UKBB).toBe(0);
  });

  test("@gate1 the reviewer's lower cut-off widens what the search reached", () => {
    const cov = searchCoverage(suggestionCards(DECLARED, suggestions(), 0.5), ROSTER, cohortsOf, () => true);
    expect(reachedBy(cov, "Hearing difficulty")).toEqual(ROSTER);
    expect(reachedBy(cov, "Tinnitus")).toEqual(["AI-READI", "CLSA", "MESA", "UKBB"]);
  });

  test("@gate1 a reached cohort the roster does not name still gets a column — never silently dropped", () => {
    const cov = searchCoverage(suggestionCards(DECLARED, suggestions()), ["AoU"], cohortsOf, () => true);
    expect(cov.cohorts).toEqual(["AoU", "AI-READI", "CLSA", "MESA", "UKBB"]);
  });
});

// --- on the screen ----------------------------------------------------------------------------------------------

function declaration(): GateDecision[] {
  return DECLARED.map((componentName) => ({
    scoreName: SCORE,
    componentName,
    chosen: "",
    alternatives: DECLARED,
    optionSetKey: optionSetKey(DECLARED),
  }));
}

async function openOwned(page: Page): Promise<Locator> {
  const rows = declaration();
  const gateDecisions = { composite_swap: Object.fromEntries(rows.map((r) => [decisionItemKey("composite_swap", r), r])) };
  await page.addInitScript(
    ([key, state]) => {
      if (sessionStorage.getItem(key) === null) sessionStorage.setItem(key, state);
    },
    [`${SANDBOX_PREFIX}${PAUSED_JOB}`, JSON.stringify({ gateDecisions })] as const,
  );
  await page.route("**/api/harmonize/jobs/*/score/suggestions", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(suggestions()) }),
  );
  await serveRun(page, (run) => {
    asOwnedRun(run);
  });
  await page.goto(`/run/${PAUSED_JOB}/gate1`);
  await page.waitForLoadState("networkidle");
  await expect(page.locator("[data-testid='ledger']")).toBeVisible();
  await page.locator("[data-testid='score-panel-toggle']").click();
  const panel = page.locator("[data-testid='score-panel']");
  await expect(panel).toBeVisible();
  return panel;
}

const cell = (table: Locator, component: string, cohort: string) =>
  table.locator(
    `[data-testid='search-coverage-row'][data-component='${component}'] [data-testid='search-coverage-cell'][data-cohort='${cohort}']`,
  );

async function setCutoff(page: Page, value: string): Promise<void> {
  const input = page.getByTestId("score-cutoff-input");
  await input.fill(value);
  await input.press("Enter");
}

test.describe("the reached-by-search table — Gate 1", () => {
  test("@gate1 one row per declared component, a column per cohort in the run, marked where the search reached", async ({
    page,
  }) => {
    const panel = await openOwned(page);
    const table = panel.getByTestId("search-coverage");
    await expect(table).toBeVisible();
    await expect(table).toContainText(/reached by search/i);
    await expect(table.getByTestId("search-coverage-row")).toHaveText(DECLARED.map((c) => new RegExp(c)));
    await expect(table.getByTestId("search-coverage-cohort")).toHaveText(ROSTER);
    await expect(cell(table, "Glaucoma", "UKBB")).toHaveAttribute("data-reached", "true");
    await expect(cell(table, "Glaucoma", "AoU")).toHaveAttribute("data-reached", "false");
    await expect(cell(table, "Hearing difficulty", "AoU")).toHaveAttribute("data-reached", "true");
    for (const co of ROSTER) await expect(cell(table, "Tinnitus", co)).toHaveAttribute("data-reached", "false");
    // The per-cohort count of components reached — a search count, never Gate 4's "computable".
    await expect(table.getByTestId("search-coverage-total")).toHaveText(["1", "1", "1", "1", "1"]);
    await expect(table).not.toContainText(/computable/i);
  });

  test("@gate1 a blank is what the search reached, never 'missing' — and the table says whose cut-off it is", async ({
    page,
  }) => {
    const panel = await openOwned(page);
    const table = panel.getByTestId("search-coverage");
    await expect(table).not.toContainText(/missing|not found|absent/i);
    const note = table.getByTestId("search-coverage-note");
    await expect(note).toContainText(/membership, not a match/i);
    await expect(note).toContainText(/not a finding about/i);
    await expect(note).toContainText(TAU.toFixed(2));
  });

  test("@gate1 lowering the cut-off fills the table in", async ({ page }) => {
    const panel = await openOwned(page);
    const table = panel.getByTestId("search-coverage");
    await expect(cell(table, "Tinnitus", "UKBB")).toHaveAttribute("data-reached", "false");
    await setCutoff(page, "0.50");
    await expect(cell(table, "Tinnitus", "UKBB")).toHaveAttribute("data-reached", "true");
    await expect(cell(table, "Hearing difficulty", "AI-READI")).toHaveAttribute("data-reached", "true");
    await expect(table.getByTestId("search-coverage-note")).toContainText("0.50");
  });

  test("@gate1 the table and the card's spread agree: unchecking a group takes its cohorts out of both", async ({
    page,
  }) => {
    const panel = await openOwned(page);
    const table = panel.getByTestId("search-coverage");
    const card = panel.locator("[data-testid='score-suggestion'][data-component='Glaucoma']");
    await expect(cell(table, "Glaucoma", "UKBB")).toHaveAttribute("data-reached", "true");
    await expect(card.getByTestId("score-suggestion-spread")).toContainText("UKBB");
    await card.getByTestId("score-suggestion-expand").click();
    await card
      .locator(`[data-testid='score-suggestion-group'][data-group='${gid(1)}'] [data-testid='score-suggestion-group-toggle']`)
      .uncheck();
    await expect(cell(table, "Glaucoma", "UKBB")).toHaveAttribute("data-reached", "false");
    await expect(card.getByTestId("score-suggestion-spread")).not.toContainText("UKBB");
    await expect(cell(table, "Glaucoma", "CLSA")).toHaveAttribute("data-reached", "true");
  });
});
