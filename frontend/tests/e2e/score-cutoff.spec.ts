import { expect, test, type Locator, type Page } from "@playwright/test";
import { decisionItemKey, optionSetKey, type GateDecision } from "@/lib/gate-decisions";
import { SANDBOX_PREFIX } from "@/lib/sandbox";
import { parseCutoff } from "@/lib/score-cutoff";
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
