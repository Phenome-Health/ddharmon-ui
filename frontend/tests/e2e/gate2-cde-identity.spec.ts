import { expect, test, type Page } from "@playwright/test";
import type { JobResult, UICandidate } from "@/types";
import { SANDBOX_PREFIX } from "@/lib/sandbox";
import { FINISHED_JOB, serveFinished } from "./gate23-fixture";

/**
 * 08-28 1h (F13) — a catalog element is identified by its tinyId, not only by its (repeatable) name.
 *
 * The endorsed catalog repeats "Age", "Age Units" and "Employment Status". Core keeps both rows by minting
 * `Age__2` for the second, and Gate 2 used to print that key: two rows reading "Age" and "Age__2" say nothing about
 * which element is which. So a repeated name shows its tinyId beside it, and every pick records the element's
 * `externalId` beside `chosen` (the name, kept for compatibility) — the backend resolves an ambiguous name by it.
 *
 *   run: E2E_PORT=4205 npx playwright test gate2-cde-identity
 */

const AGE_FIRST = "PDjBiGXjO";
const AGE_SECOND = "fmMMaUGpKS";

/** One adopt concept whose top two candidates are the catalog's two "Age" elements. */
function twoAges(withSharedName: boolean) {
  return (run: JobResult) => {
    const recs = run.result!.records!;
    const r = recs.find((x) => x.verdict === "adopt" && x.candidates.length >= 3 && x.members.length >= 1)!;
    const age = (c: UICandidate, cdeId: string, ext: string): UICandidate => ({
      ...c,
      cdeId,
      cdeExternalId: ext,
      ...(withSharedName ? { sharedName: "Age" } : {}),
    });
    r.candidates = [age(r.candidates[0], "Age", AGE_FIRST), age(r.candidates[1], "Age__2", AGE_SECOND), r.candidates[2]];
    r.cde = { id: "Age", externalId: AGE_FIRST };
    r.rationale = "Candidate 1 is the age at the visit; Candidate 2 is the age at enrollment.";
    run.result!.records = [r];
  };
}

async function openGate2(page: Page): Promise<void> {
  await page.goto(`/run/${FINISHED_JOB}/gate2`);
  await page.waitForLoadState("networkidle");
}

function nameOf(page: Page, cdeId: string) {
  return page.locator(`[data-testid='candidate-row'][data-cde-id='${cdeId}'] [data-testid='candidate-name']`);
}

for (const withSharedName of [true, false]) {
  test(`@gate2 two catalog elements named "Age" are told apart by tinyId (${withSharedName ? "wire marks them" : "older wire"})`, async ({
    page,
  }) => {
    await serveFinished(page, twoAges(withSharedName), { keep: 0 });
    await openGate2(page);
    await expect(nameOf(page, "Age")).toHaveText(`Age · ${AGE_FIRST}`);
    await expect(nameOf(page, "Age__2")).toHaveText(`Age · ${AGE_SECOND}`);
    // the loader's minted key is an identity, never a name a reviewer is shown
    await expect(page.getByTestId("candidate-list")).not.toContainText("Age__2");
    await expect(page.getByTestId("current-target")).toContainText(`Age · ${AGE_FIRST}`);
    // the model's rationale cites candidates by the same name the rows show
    const rationale = page.getByTestId("model-rationale");
    await expect(rationale).toContainText(`Candidate 2 (Age · ${AGE_SECOND})`);
    await expect(rationale).not.toContainText("Age__2");
  });
}

test("@gate2 a unique catalog name is shown alone", async ({ page }) => {
  await serveFinished(page, twoAges(true), { keep: 0 });
  await openGate2(page);
  const third = page.locator("[data-testid='candidate-row']").nth(2);
  const id = (await third.getAttribute("data-cde-id"))!;
  await expect(third.getByTestId("candidate-name")).toHaveText(id);
});

test("@gate2 a pick records the element's externalId beside its name", async ({ page }) => {
  await serveFinished(page, twoAges(true), { keep: 0 });
  await openGate2(page);
  const second = page.locator("[data-testid='candidate-row'][data-cde-id='Age__2']");
  await second.getByTestId("candidate-expand").click();
  await second.getByTestId("candidate-select").click();
  const stored = () =>
    page.evaluate((key) => {
      const s = JSON.parse(sessionStorage.getItem(key) || "{}");
      return Object.values(s.gateDecisions?.gate2_candidate_pick ?? {})[0] as Record<string, unknown> | undefined;
    }, `${SANDBOX_PREFIX}${FINISHED_JOB}`);
  await expect.poll(async () => (await stored())?.chosen).toBe("Age__2");
  expect((await stored())?.externalId).toBe(AGE_SECOND);
});

test("@gate2 'none of these' carries no catalog externalId", async ({ page }) => {
  await serveFinished(page, twoAges(true), { keep: 0 });
  await openGate2(page);
  await page.getByTestId("author-own-cde").click();
  const stored = () =>
    page.evaluate((key) => {
      const s = JSON.parse(sessionStorage.getItem(key) || "{}");
      return Object.values(s.gateDecisions?.gate2_candidate_pick ?? {})[0] as Record<string, unknown> | undefined;
    }, `${SANDBOX_PREFIX}${FINISHED_JOB}`);
  await expect.poll(async () => typeof (await stored())?.chosen).toBe("string");
  expect((await stored())?.externalId).toBeUndefined();
});
