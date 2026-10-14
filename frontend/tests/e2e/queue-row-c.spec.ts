import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
 *   - CONCEPT SPOTLIGHT (the score builder) has one icon everywhere — the Flashlight since round 8 (note 9; it was
 *     ClipboardList). In the queue it is a marker ALONE, under the checkbox; the components are named in the app's
 *     tooltip on hover/focus, and the ring says suggestion (dashed) vs Gate 4 match (solid) (`score-suggestions.spec.ts`).
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

  test("@gate1 Concept Spotlight's icon heads the Gate 1 score strip — the Flashlight", async ({ page }) => {
    await openGate1(page);
    await expect(page.locator("[data-testid='score-panel-toggle'] svg.lucide-flashlight")).toHaveCount(1);
  });
});

test("@gate1 Concept Spotlight has ONE icon everywhere: no ClipboardList is left in the app", () => {
  // Round 8, note 9: the strip, the queue marker, the Gate 4 header, the dashboard card and the Spotlight page all
  // draw the Flashlight. A leftover ClipboardList would say the same thing with a second picture.
  const src = resolve(dirname(fileURLToPath(import.meta.url)), "../../src");
  const offenders = readdirSync(src, { recursive: true })
    .map(String)
    .filter((f) => /\.(tsx?|jsx?)$/.test(f))
    .filter((f) => /\bClipboardList\b/.test(readFileSync(join(src, f), "utf8")));
  expect(offenders).toEqual([]);
});
