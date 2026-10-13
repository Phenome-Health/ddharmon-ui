import { expect, test, type Page } from "@playwright/test";
import { isFlagged } from "@/lib/ledger";
import { PAUSED_JOB, fixtureGroups } from "./gate1-fixture";

/**
 * Gate 1's queue row, LAYOUT C (Bhargav, 2026-10-13, picked in the round-6 score-icon mockups): "facts own the
 * measurements" — one signal per meaning.
 *
 *   - STATE is its tag alone. The amber left edge on a split said it a second time, so it goes; the edge is left to
 *     mean "you changed this row".
 *   - SIZE is the variable count alone. Bhargav dropped the LARGE tag entirely, not just its amber: "a large group
 *     doesn't have to be a bad thing unless it's actually incoherent" — the coherence judge says that — and the
 *     queue's Vars sort is there when size matters.
 *   - The TEMPLATE check is a coherence-family pattern, so it sits with the state in the facts column, as one word.
 *   - The SCORE BUILDER has one icon everywhere, ClipboardList (Bhargav: generic enough to cover "a bunch of things
 *     I'm interested in harmonizing even if they don't belong to a common score"). Its queue chip is the icon and the
 *     component's name; the dashed outline says it is a suggestion (`score-suggestions.spec.ts`).
 *
 *   run: E2E_PORT=4199 npx playwright test tests/e2e/queue-row-c.spec.ts
 */

async function openGate1(page: Page): Promise<void> {
  await page.goto(`/run/${PAUSED_JOB}/gate1`);
  await page.waitForLoadState("networkidle");
  await expect(page.locator("[data-testid='ledger']")).toBeVisible();
}

test.describe("Gate 1 queue rows — layout C", () => {
  test("@gate1 no LARGE tag: a big group's size is its variable count, and nothing else", async ({ page }) => {
    await openGate1(page);
    await expect(page.locator("[data-testid='large-group-mark']")).toHaveCount(0);
    // The fixture's biggest cross-cohort group: 17 variables, well past the old 10-variable LARGE line.
    const big = fixtureGroups()[0]!;
    expect(big.nMembers).toBeGreaterThanOrEqual(10);
    const row = page.locator(`[data-testid='ledger-row'][data-row-id='${big.groupId}']`);
    await expect(row.getByTestId("row-vars")).toHaveText(`${big.nMembers} vars`);
    await expect(row).not.toContainText(/\blarge\b/i);
  });

  test("@gate1 split is said once, by its state tag — no amber edge; the edge is left to mean 'you changed it'", async ({
    page,
  }) => {
    await openGate1(page);
    const flagged = new Set(fixtureGroups().filter((g) => isFlagged(g)).map((g) => g.groupId));
    const rows = await page.locator("[data-testid='ledger-row']").evaluateAll((els) =>
      els.map((el) => ({
        id: el.getAttribute("data-row-id"),
        spine: el.getAttribute("data-spine"),
        edge: getComputedStyle(el).borderLeftColor,
        state: el.querySelector("[data-testid='coherence-mark']")?.getAttribute("data-coherence") ?? null,
      })),
    );
    const onScreen = rows.filter((r) => flagged.has(r.id!));
    expect(onScreen.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.spine).not.toBe("unresolved");
    for (const r of onScreen) {
      // Untouched, a flagged row has no coloured edge — and still says its state, in its tag.
      expect(r.spine).toBe("none");
      expect(r.edge).toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
      expect(r.state).not.toBeNull();
    }
  });

  test("@gate1 the template check sits with the state, in the facts column, as one word", async ({ page }) => {
    await openGate1(page);
    const marks = page.locator("[data-testid='template-suspicion']");
    await expect(marks.first()).toBeVisible();
    const n = await marks.count();
    await expect(page.locator("[data-testid='row-facts'] [data-testid='template-suspicion']")).toHaveCount(n);
    await expect(marks.first()).toHaveText("template");
    // The face is one word; the claim — a pattern, not the judge — stays whole in the title.
    await expect(marks.first()).toHaveAttribute("title", /question template/);
  });

  test("@gate1 the score builder's icon heads the Gate 1 score strip", async ({ page }) => {
    await openGate1(page);
    await expect(page.locator("[data-testid='score-panel-toggle'] svg.lucide-clipboard-list")).toHaveCount(1);
  });
});
