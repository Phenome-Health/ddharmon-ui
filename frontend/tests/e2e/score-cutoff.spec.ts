import { expect, test, type Locator, type Page } from "@playwright/test";
import { decisionItemKey, optionSetKey, type GateDecision } from "@/lib/gate-decisions";
import { SANDBOX_PREFIX } from "@/lib/sandbox";
import { cutoffSettingList, listCutoff, listCutoffSetting, parseCutoff } from "@/lib/score-cutoff";
import { scoreScopeInput, scoreSeededGroups, suggestionMatches } from "@/lib/score-scope";
import { decisionLogCsvRows, decisionLogRows } from "@/lib/gate4";
import type { JobResult, ScoreSuggestions } from "@/types";
import { PAUSED_JOB, asOwnedRun, fixtureGroups, serveRun } from "./gate1-fixture";

/**
 * Gate 1's score SUGGESTION CUT-OFF, chosen by the reviewer (review round 6, Bhargav on the live Lavish build: the
 * "0.62" "should be user-selectable with default 0.62").
 *
 * The cut-off decides which groups a declared score SUGGESTS: the cards' above/below split, the queue's "Suggested"
 * tag, and the groups that START in Gate 1's scope. So it is a Gate 1 decision (`gate1_score_cutoff`), persisted per
 * run like the rest, frozen with Gate 1; the default is the payload's own threshold (core's calibrated value); an
 * explicit scope check always wins over it; and on the shared demo it is held in the tab like every demo decision.
 *
 *   run: E2E_PORT=4201 npx playwright test score-cutoff
 */

const TAU = 0.62;
const SCORE = "Frailty index (Williams 2019)";
const DECLARED = ["Hearing difficulty", "Glaucoma", "Tinnitus"];

/** Real fixture groups and the cosine the free search scored each with. */
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

function declaration(): GateDecision[] {
  return DECLARED.map((componentName) => ({
    scoreName: SCORE,
    componentName,
    chosen: "",
    alternatives: DECLARED,
    optionSetKey: optionSetKey(DECLARED),
  }));
}

async function seedSandbox(page: Page, jobId: string, kinds: Record<string, GateDecision[]>): Promise<void> {
  const gateDecisions = Object.fromEntries(
    Object.entries(kinds).map(([kind, rows]) => [kind, Object.fromEntries(rows.map((r) => [decisionItemKey(kind as never, r), r]))]),
  );
  await page.addInitScript(
    ([key, state]) => {
      // Seed ONCE per tab: a reload must find what the screen wrote, not this seed again.
      if (sessionStorage.getItem(key) === null) sessionStorage.setItem(key, state);
    },
    [`${SANDBOX_PREFIX}${jobId}`, JSON.stringify({ gateDecisions })] as const,
  );
}

/** Gate 1 of the reviewer's OWN run with the score declared and the free search's answer served; panel open. */
async function openOwned(page: Page, mutate: (run: JobResult) => void = () => {}): Promise<Locator> {
  await seedSandbox(page, PAUSED_JOB, { composite_swap: declaration() });
  await page.route("**/api/harmonize/jobs/*/score/suggestions", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(suggestions()) }),
  );
  await serveRun(page, (run) => {
    asOwnedRun(run);
    mutate(run);
  });
  await page.goto(`/run/${PAUSED_JOB}/gate1`);
  await page.waitForLoadState("networkidle");
  return openPanel(page);
}

async function openPanel(page: Page): Promise<Locator> {
  await expect(page.locator("[data-testid='ledger']")).toBeVisible();
  await page.locator("[data-testid='score-panel-toggle']").click();
  const panel = page.locator("[data-testid='score-panel']");
  await expect(panel).toBeVisible();
  return panel;
}

const cutoffInput = (page: Page) => page.getByTestId("score-cutoff-input");
async function setCutoff(page: Page, value: string): Promise<void> {
  await cutoffInput(page).fill(value);
  await cutoffInput(page).press("Enter");
}
const inScope = (page: Page, id: string) =>
  page.locator(`[data-testid='ledger-row'][data-row-id='${id}'] [data-testid='queue-scope']`);
const tagged = (page: Page, id: string) =>
  page.locator(`[data-testid='ledger-row'][data-row-id='${id}'] [data-testid='queue-score-tag'][data-tag-source='suggestion']`);
const cardGroup = (panel: Locator, component: string, id: string) =>
  panel.locator(`[data-testid='score-suggestion'][data-component='${component}'] [data-testid='score-suggestion-group'][data-group='${id}']`);

test.describe("the cut-off — as a function", () => {
  test("@gate1 a cut-off is a number in [0.30, 0.95], two decimals; anything else is not one", () => {
    expect(parseCutoff("0.55")).toBe(0.55);
    expect(parseCutoff(" 0.7 ")).toBe(0.7);
    expect(parseCutoff("0.555")).toBe(0.56);
    expect(parseCutoff("0.30")).toBe(0.3);
    expect(parseCutoff("0.95")).toBe(0.95);
    for (const bad of ["", "abc", "0.29", "0.96", "1", "NaN", "Infinity"]) expect(parseCutoff(bad)).toBeNull();
  });
});

test.describe("the score suggestion cut-off — Gate 1", () => {
  test("@gate1 by default the cut-off is the payload's own, and there is nothing to reset", async ({ page }) => {
    await openOwned(page);
    await expect(cutoffInput(page)).toHaveValue(TAU.toFixed(2));
    await expect(page.getByTestId("score-cutoff-reset")).toHaveCount(0);
  });

  test("@gate1 raising it un-suggests a group: its card, its queue tag and its seeded scope all follow", async ({ page }) => {
    const panel = await openOwned(page);
    await expect(inScope(page, gid(1))).toHaveAttribute("aria-checked", "true"); // 0.70 >= 0.62
    await expect(tagged(page, gid(1))).toHaveCount(1);
    await setCutoff(page, "0.80");
    await expect(inScope(page, gid(1))).toHaveAttribute("aria-checked", "false");
    await expect(tagged(page, gid(1))).toHaveCount(0);
    await expect(inScope(page, gid(0))).toHaveAttribute("aria-checked", "true"); // 0.91 still clears it
    await panel.locator("[data-testid='score-suggestion'][data-component='Glaucoma'] [data-testid='score-suggestion-expand']").click();
    await panel.locator("[data-testid='score-suggestion'][data-component='Glaucoma'] [data-testid='score-suggestion-cutoff']").click();
    await expect(cardGroup(panel, "Glaucoma", gid(1))).toHaveAttribute("data-suggested", "false");
    await expect(page.getByTestId("score-cutoff-reset")).toBeVisible();
  });

  test("@gate1 lowering it suggests a group that was below, and puts it in scope", async ({ page }) => {
    await openOwned(page);
    await expect(inScope(page, gid(3))).toHaveAttribute("aria-checked", "false"); // 0.58 < 0.62
    await setCutoff(page, "0.55");
    await expect(inScope(page, gid(3))).toHaveAttribute("aria-checked", "true");
    await expect(tagged(page, gid(3))).toHaveCount(1);
  });

  test("@gate1 an explicit scope check survives a cut-off change, either way", async ({ page }) => {
    await openOwned(page);
    await inScope(page, gid(0)).click(); // 0.91, suggested — explicitly OUT
    await expect(inScope(page, gid(0))).toHaveAttribute("aria-checked", "false");
    await inScope(page, gid(4)).click(); // 0.30, never suggested — explicitly IN
    await expect(inScope(page, gid(4))).toHaveAttribute("aria-checked", "true");
    await setCutoff(page, "0.30");
    await expect(inScope(page, gid(0))).toHaveAttribute("aria-checked", "false");
    await setCutoff(page, "0.95");
    await expect(inScope(page, gid(4))).toHaveAttribute("aria-checked", "true");
  });

  test("@gate1 reset returns to the payload's cut-off", async ({ page }) => {
    await openOwned(page);
    await setCutoff(page, "0.80");
    await expect(inScope(page, gid(1))).toHaveAttribute("aria-checked", "false");
    await page.getByTestId("score-cutoff-reset").click();
    await expect(cutoffInput(page)).toHaveValue(TAU.toFixed(2));
    await expect(inScope(page, gid(1))).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("score-cutoff-reset")).toHaveCount(0);
  });

  test("@gate1 a value outside the range is not taken", async ({ page }) => {
    await openOwned(page);
    await setCutoff(page, "0.99");
    await expect(cutoffInput(page)).toHaveAttribute("aria-invalid", "true");
    await expect(inScope(page, gid(1))).toHaveAttribute("aria-checked", "true"); // still the 0.62 default
    await expect(page.getByTestId("score-cutoff-reset")).toHaveCount(0);
  });

  test("@gate1 the chosen cut-off is the run's: it is there after a reload", async ({ page }) => {
    await openOwned(page);
    await setCutoff(page, "0.80");
    await expect(inScope(page, gid(1))).toHaveAttribute("aria-checked", "false");
    await page.reload();
    await page.waitForLoadState("networkidle");
    await openPanel(page);
    await expect(cutoffInput(page)).toHaveValue("0.80");
    await expect(inScope(page, gid(1))).toHaveAttribute("aria-checked", "false");
  });

  test("@gate1 on the shared demo the cut-off is held in the tab — nothing is sent", async ({ page }) => {
    const writes: string[] = [];
    page.on("request", (req) => {
      if (req.method() !== "GET") writes.push(`${req.method()} ${req.url()}`);
    });
    await serveRun(page, (run) => {
      // The shared demo carries its SHIPPED score (declaration + Gate 1 hints) and never asks the route.
      (run as JobResult).demoScore = { declaration: declaration() as Record<string, unknown>[], suggestions: suggestions() };
    });
    await page.goto(`/run/${PAUSED_JOB}/gate1`);
    await page.waitForLoadState("networkidle");
    await openPanel(page);
    await setCutoff(page, "0.80");
    await expect(inScope(page, gid(1))).toHaveAttribute("aria-checked", "false");
    const held = await page.evaluate((key) => sessionStorage.getItem(key), `${SANDBOX_PREFIX}${PAUSED_JOB}`);
    expect(held).toContain("gate1_score_cutoff");
    expect(writes).toEqual([]);
  });

  test("@gate1 a Gate 1 a person continued offers no cut-off — its scope is the record it sent", async ({ page }) => {
    await seedSandbox(page, PAUSED_JOB, { composite_swap: declaration() });
    await serveRun(page, (run) => {
      asOwnedRun(run);
      run.gatePosition = "gate2";
      run.result!.gatePosition = "gate2";
      run.config = { ...(run.config ?? {}), gate1_scope: [gid(0)] } as JobResult["config"];
    });
    await page.goto(`/run/${PAUSED_JOB}/gate1`);
    await page.waitForLoadState("networkidle");
    await openPanel(page);
    await expect(cutoffInput(page)).toHaveCount(0);
  });
});

// --- ONE CUT-OFF PER SPOTLIGHT LIST (Bhargav, Lavish review 2026-11-08: "implement per list cutoff") ---------------
//
// Each declared list carries its own cut-off, inside its own fold, and every place the free search is cut — the list's
// cards, its coverage dots, its "None of your N concepts…" headline, the queue's tags and the scope it seeds — splits
// a concept at ITS list's cut-off. A group two lists' concepts reach is suggested if it clears EITHER list's cut-off
// for that list's concept. The row is the same kind, scoped to the list (`suggestion_cutoff::<list>`); a run-wide row
// a run already holds is where every list without its own starts, and a list's reset deletes only that list's row.

const SES = "SES index";
const SES_DECLARED = ["Income", "Education"];

/** The second list's reach. g3 is the group Frailty's Hearing difficulty reaches at 0.58 — two lists, one group. */
function sesReached() {
  const g = fixtureGroups();
  return [
    { group: g[6]!, score: 0.66, component: "Income" },
    { group: g[3]!, score: 0.57, component: "Income" },
    { group: g[7]!, score: 0.58, component: "Education" },
  ];
}

function twoListSuggestions(): ScoreSuggestions {
  const answer = suggestions();
  const r = sesReached();
  answer.scores.push({
    scoreName: SES,
    nVariablesIndexed: 328,
    components: SES_DECLARED.map((component) => ({
      component,
      groups: r
        .filter((x) => x.component === component)
        .map((x) => ({ groupId: x.group.groupId, score: x.score, bestMember: x.group.memberVariableNames[0] ?? "" })),
    })),
  });
  return answer;
}

function twoListDeclaration(): GateDecision[] {
  return [
    ...declaration(),
    ...SES_DECLARED.map((componentName) => ({
      scoreName: SES,
      componentName,
      chosen: "",
      alternatives: SES_DECLARED,
      optionSetKey: optionSetKey(SES_DECLARED),
    })),
  ];
}

/** A cut-off row as the screen writes it: the default it replaced is the one alternative. */
function cutoffRow(setting: string, chosen: string): GateDecision {
  return { setting, chosen, alternatives: [TAU.toFixed(2)], optionSetKey: optionSetKey([TAU.toFixed(2)]) };
}

async function openTwoLists(
  page: Page,
  { cutoffs = [], mutate = () => {} }: { cutoffs?: GateDecision[]; mutate?: (run: JobResult) => void } = {},
): Promise<Locator> {
  await seedSandbox(page, PAUSED_JOB, {
    composite_swap: twoListDeclaration(),
    ...(cutoffs.length ? { gate1_score_cutoff: cutoffs } : {}),
  });
  await page.route("**/api/harmonize/jobs/*/score/suggestions", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(twoListSuggestions()) }),
  );
  await serveRun(page, (run) => {
    asOwnedRun(run);
    mutate(run);
  });
  await page.goto(`/run/${PAUSED_JOB}/gate1`);
  await page.waitForLoadState("networkidle");
  return openPanel(page);
}

const listFold = (panel: Locator, name: string) => panel.locator(`[data-testid='spotlight-list'][data-score='${name}']`);
const listInput = (panel: Locator, name: string) => listFold(panel, name).getByTestId("score-cutoff-input");
const listReset = (panel: Locator, name: string) => listFold(panel, name).getByTestId("score-cutoff-reset");
async function setListCutoff(panel: Locator, name: string, value: string): Promise<void> {
  await listInput(panel, name).fill(value);
  await listInput(panel, name).press("Enter");
}
const listCard = (panel: Locator, name: string, component: string) =>
  listFold(panel, name).locator(`[data-testid='score-suggestion'][data-component='${component}']`);
async function openCoverage(fold: Locator): Promise<Locator> {
  const toggle = fold.getByTestId("search-coverage-toggle");
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  return fold.getByTestId("search-coverage");
}
const coverageCell = (table: Locator, component: string, cohort: string) =>
  table.locator(
    `[data-testid='search-coverage-row'][data-component='${component}'] [data-testid='search-coverage-cell'][data-cohort='${cohort}']`,
  );
/** The cut-off rows the tab holds, by item key. */
async function heldCutoffs(page: Page): Promise<Record<string, GateDecision>> {
  const raw = await page.evaluate((key) => sessionStorage.getItem(key), `${SANDBOX_PREFIX}${PAUSED_JOB}`);
  return (JSON.parse(raw ?? "{}")?.gateDecisions?.gate1_score_cutoff ?? {}) as Record<string, GateDecision>;
}

test.describe("one cut-off per Spotlight list — as functions", () => {
  test("@gate1 a list's cut-off is a row of its own; the run-wide row starts every list that has none", () => {
    expect(listCutoffSetting("Frailty index")).toBe("suggestion_cutoff::Frailty index");
    expect(listCutoffSetting("  Frailty index ")).toBe("suggestion_cutoff::Frailty index");
    // Same kind, same one identity field: the list is named in the setting, so stored rows keep their keys.
    expect(decisionItemKey("gate1_score_cutoff", { setting: listCutoffSetting(SES) })).toBe("suggestion_cutoff::SES index");
    expect(cutoffSettingList("suggestion_cutoff")).toBeNull();
    expect(cutoffSettingList("suggestion_cutoff::Frailty index")).toBe("Frailty index");
    expect(cutoffSettingList("suggestion_cutoff::A::B")).toBe("A::B");

    expect(listCutoff({}, SCORE, TAU)).toEqual({ value: TAU, own: false, fallback: TAU });
    const runWide = { suggestion_cutoff: cutoffRow("suggestion_cutoff", "0.80") };
    expect(listCutoff(runWide, SCORE, TAU)).toEqual({ value: 0.8, own: false, fallback: 0.8 });
    const both = { ...runWide, [listCutoffSetting(SCORE)]: cutoffRow(listCutoffSetting(SCORE), "0.55") };
    expect(listCutoff(both, SCORE, TAU)).toEqual({ value: 0.55, own: true, fallback: 0.8 });
    expect(listCutoff(both, SES, TAU)).toEqual({ value: 0.8, own: false, fallback: 0.8 });
    // A row that does not read as a number in range is not a cut-off: the list falls back.
    const junk = { [listCutoffSetting(SES)]: cutoffRow(listCutoffSetting(SES), "0.99") };
    expect(listCutoff(junk, SES, TAU)).toEqual({ value: TAU, own: false, fallback: TAU });
  });

  test("@gate1 each concept is cut at its own list's cut-off; a group two lists reach clears on EITHER", () => {
    const s = twoListSuggestions();
    const at = (low: string, value: number) => (name: string) => (name === low ? value : TAU);
    const seeds = (cutoff: number | ((name: string) => number)) => {
      const input = scoreScopeInput(null, s, cutoff);
      return scoreSeededGroups(input.matches, input.threshold);
    };
    // SES lowered to 0.55: g3 is offered by SES's Income (0.57) — not by Frailty's Hearing difficulty (0.58 < 0.62).
    const matches = suggestionMatches(s, at(SES, 0.55));
    expect(matches.filter((m) => m.groupCandidates?.some((c) => c.groupId === gid(3))).map((m) => m.component)).toEqual([
      "Income",
    ]);
    const sesLow = seeds(at(SES, 0.55));
    expect(sesLow.get(gid(3))).toEqual(["Income"]);
    expect(sesLow.has(gid(7))).toBe(true); // Education 0.58
    expect(sesLow.has(gid(1))).toBe(true); // Glaucoma 0.70, Frailty still at 0.62
    // Frailty lowered to 0.55 instead: the same group now clears on Frailty's concept, and SES's Education does not.
    const frailtyLow = seeds(at(SCORE, 0.55));
    expect(frailtyLow.get(gid(3))).toEqual(["Hearing difficulty"]);
    expect(frailtyLow.has(gid(7))).toBe(false);
    // Frailty raised to 0.80: only Frailty's concepts lose groups.
    const frailtyHigh = seeds(at(SCORE, 0.8));
    expect(frailtyHigh.has(gid(1))).toBe(false);
    expect(frailtyHigh.has(gid(6))).toBe(true); // Income 0.66, SES still at 0.62
    // A plain number still cuts every list alike.
    expect(seeds(0.55).has(gid(7))).toBe(true);
    expect(seeds(0.55).get(gid(3))).toEqual(["Hearing difficulty", "Income"]);
  });

  test("@gate1 the decision log and its export say which list a cut-off belongs to; the run-wide row reads as before", () => {
    const index = {
      gate1_score_cutoff: {
        suggestion_cutoff: cutoffRow("suggestion_cutoff", "0.80"),
        [listCutoffSetting(SCORE)]: cutoffRow(listCutoffSetting(SCORE), "0.55"),
      },
    };
    const csv = decisionLogCsvRows(index, null, {}, undefined).filter((r) => r[1] === "gate1_score_cutoff");
    expect(csv).toEqual([
      ["Gate 1", "gate1_score_cutoff", "Set the score suggestion cut-off", "suggestion_cutoff", "0.62 (default)", "0.80", "", "", "false"],
      [
        "Gate 1",
        "gate1_score_cutoff",
        `Set the score suggestion cut-off — ${SCORE}`,
        `suggestion_cutoff::${SCORE}`,
        "0.62 (default)",
        "0.55",
        "",
        "",
        "false",
      ],
    ]);
    const shown = decisionLogRows(index, null).filter((r) => r.kind === "gate1_score_cutoff");
    expect(shown.map((r) => [r.action, r.detail])).toEqual([
      ["Set the score suggestion cut-off", "0.80 (default 0.62)"],
      [`Set the score suggestion cut-off — ${SCORE}`, "0.55 (default 0.62)"],
    ]);
  });
});

test.describe("one cut-off per Spotlight list — Gate 1", () => {
  test("@gate1 each list has its own cut-off, inside its fold above its table and concepts; how suggestions work is said once, with no cut-off", async ({
    page,
  }) => {
    const panel = await openTwoLists(page);
    await expect(panel.getByTestId("spotlight-list")).toHaveCount(2);
    await expect(panel.getByTestId("score-cutoff-input")).toHaveCount(2);
    for (const name of [SCORE, SES]) {
      const fold = listFold(panel, name);
      const line = fold.getByTestId("score-cutoff-line");
      await expect(line).toHaveCount(1);
      await expect(listInput(panel, name)).toHaveValue(TAU.toFixed(2));
      await expect(line).toContainText(/or higher for this list.s concepts starts in scope, marked as a suggestion in the queue\. Your checks always win\./);
      await expect(listReset(panel, name)).toHaveCount(0);
      const order = await fold
        .locator("[data-testid='score-cutoff-line'], [data-testid='search-coverage'], [data-testid='score-suggestion']")
        .evaluateAll((els) => els.map((el) => el.getAttribute("data-testid")));
      expect(order[0]).toBe("score-cutoff-line");
      expect(order[1]).toBe("search-coverage");
    }
    // How suggestions work: once, above the lists — and it no longer carries a cut-off.
    const guide = panel.getByTestId("score-suggestion-guide");
    await expect(guide).toHaveCount(1);
    await expect(panel.getByTestId("score-suggestion-info")).toHaveCount(1);
    await expect(guide.getByTestId("score-cutoff-line")).toHaveCount(0);
    await expect(guide.getByTestId("score-cutoff-input")).toHaveCount(0);
    await expect(panel).not.toContainText(/one cut-off for every concept/i);
  });

  test("@gate1 changing one list's cut-off re-splits that list alone: its cards, its coverage, the scope and tags it seeds", async ({
    page,
  }) => {
    const panel = await openTwoLists(page);
    // Before: Education's 0.58 and the shared g3 sit below both lists' 0.62.
    await expect(inScope(page, gid(7))).toHaveAttribute("aria-checked", "false");
    await expect(tagged(page, gid(7))).toHaveCount(0);
    await expect(inScope(page, gid(3))).toHaveAttribute("aria-checked", "false");
    const sesTable = await openCoverage(listFold(panel, SES));
    await expect(coverageCell(sesTable, "Education", "AI-READI")).toHaveAttribute("data-reached", "false");

    await setListCutoff(panel, SES, "0.55");
    await expect(listInput(panel, SES)).toHaveValue("0.55");
    await expect(listInput(panel, SCORE)).toHaveValue(TAU.toFixed(2));
    // SES's own concepts: suggested, in scope, tagged — and its coverage fills in.
    await expect(listCard(panel, SES, "Education")).toHaveAttribute("data-suggested", "true");
    await expect(inScope(page, gid(7))).toHaveAttribute("aria-checked", "true");
    await expect(tagged(page, gid(7))).toHaveCount(1);
    await expect(coverageCell(sesTable, "Education", "AI-READI")).toHaveAttribute("data-reached", "true");
    // The marker on that row names the cut-off of the list that reached it.
    await tagged(page, gid(7)).hover();
    await expect(page.getByRole("tooltip")).toContainText("A free search at the 0.55 cut-off");
    // g3 clears SES's cut-off for Income (0.57), so it is in scope — EITHER list's cut-off suggests it.
    await expect(inScope(page, gid(3))).toHaveAttribute("aria-checked", "true");
    await expect(tagged(page, gid(3))).toHaveCount(1);
    // Frailty is untouched: its Hearing difficulty card still splits g3 below ITS 0.62, and its table does not count it.
    const hearing = listCard(panel, SCORE, "Hearing difficulty");
    await hearing.getByTestId("score-suggestion-expand").click();
    await expect(hearing.getByTestId("score-suggestion-cutoff")).toContainText(`1 group below the cut-off ${TAU.toFixed(2)}`);
    await hearing.getByTestId("score-suggestion-cutoff").click();
    await expect(cardGroup(panel, "Hearing difficulty", gid(3))).toHaveAttribute("data-suggested", "false");
    const frailtyTable = await openCoverage(listFold(panel, SCORE));
    await expect(coverageCell(frailtyTable, "Hearing difficulty", "UKBB")).toHaveAttribute("data-reached", "false");
    await expect(frailtyTable.getByTestId("search-coverage-note")).toContainText(TAU.toFixed(2));
    await expect(sesTable.getByTestId("search-coverage-note")).toContainText("0.55");
  });

  test("@gate1 a list whose concepts all fall under ITS cut-off says so in its own fold; the other list does not", async ({
    page,
  }) => {
    const panel = await openTwoLists(page);
    await expect(panel.getByTestId("score-suggestions-none-cleared")).toHaveCount(0);
    await setListCutoff(panel, SES, "0.70"); // Income's best is 0.66, Education's 0.58
    const headline = listFold(panel, SES).getByTestId("score-suggestions-none-cleared");
    await expect(headline).toContainText("None of your 2 concepts reached the 0.70 cut-off");
    await expect(listFold(panel, SCORE).getByTestId("score-suggestions-none-cleared")).toHaveCount(0);
    await expect(inScope(page, gid(6))).toHaveAttribute("aria-checked", "false");
    await expect(inScope(page, gid(1))).toHaveAttribute("aria-checked", "true"); // Frailty's Glaucoma 0.70 ≥ 0.62
  });

  test("@gate1 reset works per list: it deletes that list's row alone", async ({ page }) => {
    const panel = await openTwoLists(page);
    await setListCutoff(panel, SCORE, "0.80");
    await expect(inScope(page, gid(1))).toHaveAttribute("aria-checked", "false"); // Glaucoma 0.70 < 0.80
    await setListCutoff(panel, SES, "0.55");
    await expect(inScope(page, gid(7))).toHaveAttribute("aria-checked", "true");
    expect(Object.keys(await heldCutoffs(page)).sort()).toEqual([listCutoffSetting(SCORE), listCutoffSetting(SES)]);

    await expect(listReset(panel, SCORE)).toHaveText(`reset to ${TAU.toFixed(2)}`);
    await listReset(panel, SCORE).click();
    await expect(listInput(panel, SCORE)).toHaveValue(TAU.toFixed(2));
    await expect(listReset(panel, SCORE)).toHaveCount(0);
    await expect(inScope(page, gid(1))).toHaveAttribute("aria-checked", "true");
    // SES keeps its own.
    await expect(listInput(panel, SES)).toHaveValue("0.55");
    await expect(listReset(panel, SES)).toBeVisible();
    await expect(inScope(page, gid(7))).toHaveAttribute("aria-checked", "true");
    expect(Object.keys(await heldCutoffs(page))).toEqual([listCutoffSetting(SES)]);
  });

  test("@gate1 a run-wide cut-off a run already holds starts every list, and a list's reset falls back to it", async ({
    page,
  }) => {
    const panel = await openTwoLists(page, { cutoffs: [cutoffRow("suggestion_cutoff", "0.80")] });
    await expect(listInput(panel, SCORE)).toHaveValue("0.80");
    await expect(listInput(panel, SES)).toHaveValue("0.80");
    await expect(inScope(page, gid(1))).toHaveAttribute("aria-checked", "false"); // Glaucoma 0.70 < 0.80
    await expect(inScope(page, gid(6))).toHaveAttribute("aria-checked", "false"); // Income 0.66 < 0.80
    await expect(inScope(page, gid(0))).toHaveAttribute("aria-checked", "true"); // Glaucoma 0.91
    // No list has a row of its own, so there is nothing of a list's to reset.
    await expect(panel.getByTestId("score-cutoff-reset")).toHaveCount(0);

    await setListCutoff(panel, SES, "0.60");
    await expect(inScope(page, gid(6))).toHaveAttribute("aria-checked", "true");
    await expect(listInput(panel, SCORE)).toHaveValue("0.80");
    await expect(listReset(panel, SES)).toHaveText("reset to 0.80");
    await listReset(panel, SES).click();
    await expect(listInput(panel, SES)).toHaveValue("0.80");
    await expect(inScope(page, gid(6))).toHaveAttribute("aria-checked", "false");
    // The run-wide row is still the run's — a list's reset never touches it.
    expect(Object.keys(await heldCutoffs(page))).toEqual(["suggestion_cutoff"]);
  });

  test("@gate1 a list's cut-off is kept with the run: it is there after a reload, the other list's default beside it", async ({
    page,
  }) => {
    const panel = await openTwoLists(page);
    await setListCutoff(panel, SES, "0.55");
    await expect(inScope(page, gid(7))).toHaveAttribute("aria-checked", "true");
    await page.reload();
    await page.waitForLoadState("networkidle");
    const again = await openPanel(page);
    await expect(listInput(again, SES)).toHaveValue("0.55");
    await expect(listInput(again, SCORE)).toHaveValue(TAU.toFixed(2));
    await expect(inScope(page, gid(7))).toHaveAttribute("aria-checked", "true");
    const held = await heldCutoffs(page);
    expect(held[listCutoffSetting(SES)]?.chosen).toBe("0.55");
    expect(held[listCutoffSetting(SES)]?.alternatives).toEqual([TAU.toFixed(2)]);
  });

  test("@gate1 a Gate 1 a person continued offers no cut-off on any list", async ({ page }) => {
    const panel = await openTwoLists(page, {
      mutate: (run) => {
        run.gatePosition = "gate2";
        run.result!.gatePosition = "gate2";
        run.config = { ...(run.config ?? {}), gate1_scope: [gid(0)] } as JobResult["config"];
      },
    });
    await expect(panel.getByTestId("spotlight-list")).toHaveCount(2);
    await expect(panel.getByTestId("score-cutoff-input")).toHaveCount(0);
    await expect(panel.getByTestId("score-cutoff-reset")).toHaveCount(0);
  });
});
