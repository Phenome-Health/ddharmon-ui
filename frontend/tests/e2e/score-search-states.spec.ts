import { expect, test, type Page, type Route } from "@playwright/test";
import { decisionItemKey, optionSetKey, type GateDecision } from "@/lib/gate-decisions";
import { SANDBOX_PREFIX } from "@/lib/sandbox";
import type { ScoreSuggestions } from "@/types";
import { PAUSED_JOB, asOwnedRun, fixtureGroups, serveRun } from "./gate1-fixture";

/**
 * What Gate 1's Concept Spotlight says while its free search runs, when it fails, and when no item clears the cut-off.
 *
 * Found in the user test of 2026-11-03 (a team member on dev.ddharmon.io, run 379c70ce): they declared three items and
 * saw only "Matching happens on Gate 4". The free search was running — its first call on a run embeds every variable,
 * 93 seconds on dev — but the panel said nothing while it ran (and drops a failure silently), so after ~70 seconds they
 * left for the demo. Its answer then had all three items below the 0.62 cut-off (best 0.50), which the panel reported
 * only as counts inside a fold. Each state now says itself.
 *
 *   run: npx playwright test tests/e2e/score-search-states.spec.ts
 */

const SCORE = "Declared score";
const ITEMS = ["sleep", "activity", "glucose"];
const TAU = 0.62;

/** The tester's own numbers: each item reached groups, and its best sat under the cut-off. */
function belowCutoff(): ScoreSuggestions {
  const g = fixtureGroups();
  const best: Record<string, number> = { sleep: 0.497, activity: 0.392, glucose: 0.478 };
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
        components: ITEMS.map((component, ci) => ({
          component,
          groups: [0, 1, 2].map((i) => ({
            groupId: g[ci * 3 + i]!.groupId,
            score: +(best[component]! - i * 0.03).toFixed(3),
            bestMember: g[ci * 3 + i]!.memberVariableNames[0] ?? "",
          })),
        })),
      },
    ],
  };
}

/** One item that clears the cut-off — the ordinary case, where the headline must NOT appear. */
function oneCleared(): ScoreSuggestions {
  const s = belowCutoff();
  s.scores[0]!.components[0]!.groups[0]!.score = 0.8;
  return s;
}

async function declare(page: Page): Promise<void> {
  const rows: GateDecision[] = ITEMS.map((componentName) => ({
    scoreName: SCORE,
    componentName,
    chosen: "",
    alternatives: ITEMS,
    optionSetKey: optionSetKey(ITEMS),
  }));
  const gateDecisions = {
    composite_swap: Object.fromEntries(rows.map((r) => [decisionItemKey("composite_swap" as never, r), r])),
  };
  await page.addInitScript(
    ([key, state]) => sessionStorage.setItem(key, state),
    [`${SANDBOX_PREFIX}${PAUSED_JOB}`, JSON.stringify({ gateDecisions })] as const,
  );
}

async function openPanel(page: Page): Promise<void> {
  await serveRun(page, asOwnedRun);
  await page.goto(`/run/${PAUSED_JOB}/gate1`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.locator("[data-testid='ledger']")).toBeVisible();
  const toggle = page.getByTestId("score-panel-toggle");
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
}

test.describe("Gate 1 Concept Spotlight — search states (user test 2026-11-03)", () => {
  test("@gate1 while the free search runs, the panel says it is searching", async ({ page }) => {
    await declare(page);
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    await page.route("**/api/harmonize/jobs/*/score/suggestions", async (route: Route) => {
      await held;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(oneCleared()) });
    });
    await openPanel(page);

    const searching = page.getByTestId("score-suggestions-loading");
    await expect(searching).toBeVisible();
    await expect(searching).toContainText(/searching/i);
    await expect(searching).toContainText(/for your concepts/);
    await expect(searching).toHaveAttribute("role", "status");

    release();
    await expect(page.getByTestId("score-suggestions")).toBeVisible();
    await expect(searching).toHaveCount(0);
  });

  test("@gate1 a free search that fails says so, and searching again recovers", async ({ page }) => {
    await declare(page);
    let calls = 0;
    await page.route("**/api/harmonize/jobs/*/score/suggestions", async (route: Route) => {
      calls += 1;
      if (calls === 1) {
        await route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ detail: "Bad gateway" }) });
        return;
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(oneCleared()) });
    });
    await openPanel(page);

    const failed = page.getByTestId("score-suggestions-error");
    await expect(failed).toBeVisible();
    await expect(failed).toHaveAttribute("role", "alert");
    await expect(failed).toContainText(/nothing was charged/i);
    await expect(failed).toContainText(/your concepts are saved/i);

    await page.getByTestId("score-suggestions-retry").click();
    await expect(page.getByTestId("score-suggestions")).toBeVisible();
    await expect(failed).toHaveCount(0);
    expect(calls).toBe(2);
  });

  test("@gate1 when no concept clears the cut-off, the panel leads with that and names the closest", async ({ page }) => {
    await declare(page);
    await page.route("**/api/harmonize/jobs/*/score/suggestions", (route: Route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(belowCutoff()) }),
    );
    await openPanel(page);

    const headline = page.getByTestId("score-suggestions-none-cleared");
    await expect(headline).toBeVisible();
    await expect(headline).toContainText("None of your 3 concepts reached the 0.62 cut-off");
    await expect(headline).toContainText(/open a concept to see its closest groups/);
    // Closest first, each with its best similarity.
    await expect(headline).toContainText(/sleep 0\.50.*glucose 0\.48.*activity 0\.39/);
    // The near misses are one glance away: the list's fold is open.
    await expect(page.getByTestId("spotlight-list")).toHaveAttribute("data-state", "open");
  });

  test("@gate1 a concept that clears the cut-off means no such headline", async ({ page }) => {
    await declare(page);
    await page.route("**/api/harmonize/jobs/*/score/suggestions", (route: Route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(oneCleared()) }),
    );
    await openPanel(page);
    await expect(page.getByTestId("score-suggestions")).toBeVisible();
    await expect(page.getByTestId("score-suggestions-none-cleared")).toHaveCount(0);
  });
});
