import { expect, test } from "@playwright/test";
import { PAUSED_JOB, fixtureGroups } from "./gate1-fixture";

/**
 * What a reviewer DOES with a coherence label (user test 2026-11-03, note 6: "qualify and split need to be better defined
 * in terms of actionability — what does a user DO with that information").
 *
 * SPLIT already carried its action (accept, edit or ignore the proposed division). QUALIFY — one measurement varied by
 * a modifier, advisory — showed the judge's axis and values and stopped there. It now says what to do, naming the axis:
 * usually keep the group whole, and when the analysis needs each value apart, drag those variables into their own
 * groups. Advice only (Bhargav's pick): no new paid path.
 *
 *   run: npx playwright test tests/e2e/coherence-advice.spec.ts
 */

test("@gate1 a QUALIFY group says what to do, naming its axis", async ({ page }) => {
  const qualify = fixtureGroups().find((g) => g.coherence === "qualify" && !g.incoherent && g.coherenceAxis);
  expect(qualify, "the fixture carries an unflagged qualify group with an axis").toBeTruthy();

  await page.goto(`/run/${PAUSED_JOB}/gate1`);
  await page.waitForLoadState("networkidle");
  await page.locator(`[data-testid='ledger-row'][data-row-id='${qualify!.groupId}']`).click();
  const finding = page.locator("[data-testid='gate1-detail'] [data-testid='carve-proposal'][data-coherence='qualify']");
  await expect(finding).toBeVisible();

  const advice = finding.getByTestId("qualify-advice");
  await expect(advice).toContainText("Usually keep this as one group");
  await expect(advice).toContainText(qualify!.coherenceAxis!);
  await expect(advice).toContainText(/drag those variables into their own groups/i);
  // Advisory: still no paid action on a qualify.
  await expect(finding.getByRole("button", { name: /accept this division/i })).toHaveCount(0);
});
