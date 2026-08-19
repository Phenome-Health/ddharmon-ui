import { expect, test } from "@playwright/test";

/**
 * The staged-review gate walk — the tracer's end-to-end assertion.
 *
 * WHY THE FIXTURES MATTER HERE MORE THAN ANYWHERE ELSE. Since UI-SPEC §0.1's reversal, reaching Gate 1 on
 * a real run pays for concept generation, splitting and the coherence judge. No test in this phase may
 * incur that. So this walks the bundled static fixture
 * `frontend/public/static-data/result-demo-staged-gate1.json` — a run PAUSED at the Gate 1 boundary,
 * derived from the shipped demo result by `scripts/build_gate_fixture.py`, so the rows on screen are real
 * groups from a real run rather than invented ones.
 *
 *   run: npm run test:e2e -- --grep "resume at gate"
 */

/** The fixture's job id. Its result file is `result-<id>.json`, which is all `getResult` needs. */
const PAUSED_JOB = "demo-staged-gate1";

/** Group ids, in render order, as the page reports them. The identity the reload has to preserve. */
async function conceptGroupIds(page: import("@playwright/test").Page): Promise<string[]> {
  const rows = page.locator("[data-testid='concept-group']");
  await expect(rows.first()).toBeVisible();
  return rows.evaluateAll((els) => els.map((el) => el.getAttribute("data-group-id") ?? ""));
}

test.describe("staged review", () => {
  test("@gates the reviewer can resume at gate 1 with the same concept groups after a reload", async ({ page }) => {
    await page.goto(`/run/${PAUSED_JOB}/gate1`);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForLoadState("networkidle");

    // The screen is Gate 1, and it says so to assistive technology as well as visually.
    await expect(page.getByRole("heading", { level: 1, name: "Concept groups" })).toBeVisible();
    const rail = page.locator("[data-testid='gate-rail'] > li");
    await expect(rail).toHaveCount(6);
    await expect(page.locator("[data-testid='gate-rail'] li[aria-current='step']")).toHaveAttribute(
      "data-gate",
      "gate1",
    );

    // Rows are POST-SPLIT CONCEPT GROUPS, each carrying its parent cluster as provenance and its
    // generated name marked as generated — no catalog badge, no identifier link, no endorsement.
    const before = await conceptGroupIds(page);
    expect(before.length).toBeGreaterThan(0);
    await expect(page.locator("[data-testid='concept-group']").first().getByText("generated")).toBeVisible();
    await expect(page.locator("[data-testid='concept-group']").first()).toContainText("from cluster");

    // A run rejoined at a gate says so, and its banner carries NO countdown: retention is indefinite
    // until the reviewer deletes the run, so a timer would be a threat the product never carries out.
    const banner = page.locator("[data-testid='resume-banner']");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("resume any time");
    await expect(banner).not.toContainText(/expires|deleted in|days left|remaining/i);

    // THE TRACER'S CLAIM: close and reopen, and the run is still at Gate 1 with the same groups.
    await page.reload();
    await page.evaluate(() => document.fonts.ready);
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("heading", { level: 1, name: "Concept groups" })).toBeVisible();
    await expect(page.locator("[data-testid='gate-rail'] li[aria-current='step']")).toHaveAttribute(
      "data-gate",
      "gate1",
    );
    expect(await conceptGroupIds(page)).toEqual(before);
  });

  test("@gates gate 1 tells the reviewer what reaching it already cost, not what it might cost", async ({ page }) => {
    await page.goto(`/run/${PAUSED_JOB}/gate1`);
    await page.waitForLoadState("networkidle");

    // Reaching Gate 1 spent money, so its figure is REALIZED. A forecast here would invite reading
    // committed spend as an estimate — the confusion UI-SPEC §7.1.3 asks the rail to prevent.
    await expect(page.locator("[data-testid='gate-rail'] li[data-gate='gate1'] [data-cost]")).toHaveAttribute(
      "data-cost",
      "realized",
    );
    await expect(page.locator("[data-testid='gate-rail'] li[data-gate='gate2'] [data-cost]")).toHaveAttribute(
      "data-cost",
      "forecast",
    );
    await expect(page.getByText(/Already spent to reach this gate/)).toBeVisible();
  });

  test("@gates the how-to panel names where spending starts", async ({ page }) => {
    await page.goto(`/run/${PAUSED_JOB}/gate1`);
    await page.waitForLoadState("networkidle");

    // Written for someone who has never used the tool: numbered actions, in order, naming their control,
    // and saying plainly when money starts being spent. The honest answer since §0.1 is Gate 0's Continue.
    const toggle = page.getByRole("button", { name: /how to use this screen/i });
    await expect(toggle).toBeVisible();
    await toggle.click();
    await expect(page.getByText(/already charged at Gate 0/i)).toBeVisible();
  });
});
