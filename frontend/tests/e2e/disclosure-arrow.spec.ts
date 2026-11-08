import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * THE DROPDOWN ARROW SAYS "THIS OPENS" WHILE CLOSED (Bhargav, Lavish 2026-11-08 — "it's easy to scroll past this because
 * it's not obvious that it's expandable. The drop down arrow should be highlighted when collapsed. This should be applied
 * to drop down arrows throughout the UI"; option B picked from the mockups, then "ensure that arrows align vertically
 * whether collapsed or expanded").
 *
 * Option B: every disclosure arrow sits in ONE fixed 24px slot — a soft accent fill with the arrow in the accent colour
 * while CLOSED, no fill and the muted arrow (turned up) when OPEN — so the arrow's centre never moves between states.
 */
test.use({ contextOptions: { reducedMotion: "reduce" } });

const GATE1 = "/run/demo-staged-gate1/gate1";

/** The arrow slot inside a trigger: its box, its fill and its ink. */
async function slot(trigger: Locator) {
  return trigger.locator("[data-disclosure-arrow]").first().evaluate((el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return {
      w: Math.round(r.width),
      h: Math.round(r.height),
      cx: Math.round(r.left + r.width / 2),
      cyInTrigger: Math.round(r.top + r.height / 2 - (el.closest("[aria-expanded]") as HTMLElement).getBoundingClientRect().top),
      fill: s.backgroundColor,
      ink: s.color,
    };
  });
}

const TRANSPARENT = /^(transparent|rgba\(0, 0, 0, 0\))$/;

async function openGate1(page: Page) {
  await page.goto(GATE1);
  await page.waitForLoadState("networkidle");
}

test("@gate1 a disclosure arrow is filled while closed and plain while open, in the same 24px slot", async ({ page }) => {
  await openGate1(page);
  // The how-to strip starts OPEN; Concept Spotlight's strip starts CLOSED.
  const howTo = page.getByTestId("how-to").locator("[aria-expanded]").first();
  const spotlight = page.getByTestId("score-panel-toggle");
  await expect(howTo).toHaveAttribute("aria-expanded", "true");
  await expect(spotlight).toHaveAttribute("aria-expanded", "false");

  const open = await slot(howTo);
  expect([open.w, open.h]).toEqual([24, 24]);
  expect(open.fill).toMatch(TRANSPARENT);

  const closed = await slot(spotlight);
  expect([closed.w, closed.h]).toEqual([24, 24]);
  expect(closed.fill).not.toMatch(TRANSPARENT);
  // The closed arrow is drawn in the accent colour, not the muted ink the open one keeps.
  expect(closed.ink).not.toBe(open.ink);

  // Toggling moves nothing: the same trigger's arrow keeps its centre, and swaps fill.
  await howTo.click();
  await expect(howTo).toHaveAttribute("aria-expanded", "false");
  const howToClosed = await slot(howTo);
  expect(howToClosed.cx).toBe(open.cx);
  expect(howToClosed.cyInTrigger).toBe(open.cyInTrigger);
  expect(howToClosed.fill).not.toMatch(TRANSPARENT);

  await spotlight.click();
  await expect(spotlight).toHaveAttribute("aria-expanded", "true");
  const spotlightOpen = await slot(spotlight);
  expect(spotlightOpen.cx).toBe(closed.cx);
  expect(spotlightOpen.fill).toMatch(TRANSPARENT);
});

test("@gate1 every disclosure on Gate 1 draws its arrow in the shared slot — none hand-drawn", async ({ page }) => {
  await openGate1(page);
  await page.getByTestId("score-panel-toggle").click();
  await expect(page.getByTestId("score-panel")).toBeVisible();
  // Every visible trigger that opens or closes something carries the shared arrow slot, and no bare chevron.
  const triggers = page.locator("button[aria-expanded]:visible, [role='button'][aria-expanded]:visible");
  const n = await triggers.count();
  expect(n).toBeGreaterThan(1);
  for (let i = 0; i < n; i++) {
    const t = triggers.nth(i);
    if ((await t.locator("svg.lucide-chevron-down, svg.lucide-chevron-up, svg.lucide-chevron-right").count()) === 0) continue;
    await expect(t.locator("[data-disclosure-arrow]"), `trigger ${i}: ${(await t.innerText()).slice(0, 60)}`).toHaveCount(1);
  }
});
