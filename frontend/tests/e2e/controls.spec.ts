import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * THE RECURRING CONTROLS (08-30b) — the twelve decisions from the controls design lab, asserted on the real app.
 *
 * Bhargav settled them over five rounds in a Lavish lab built on the app's own tokens; its final template is the
 * executable spec these tests were written against. They pin GEOMETRY and BEHAVIOUR, never a screenshot — the
 * @visual baselines are regenerated once, after he has seen the whole build.
 *
 *   run: npm run test:e2e -- --grep "@controls"
 */

const PAUSED = "demo-staged-gate1";
const FINISHED = "demo-aireadi_aou_clsa_mesa_ukbb";

async function open(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await page.waitForLoadState("networkidle");
}

async function geometry(l: Locator) {
  return l.evaluate((el) => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      w: Math.round(r.width * 10) / 10,
      h: Math.round(r.height * 10) / 10,
      radius: cs.borderTopLeftRadius,
      border: cs.borderTopWidth,
    };
  });
}

async function type(l: Locator) {
  return l.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { size: cs.fontSize, weight: cs.fontWeight, transform: cs.textTransform, color: cs.color };
  });
}

async function background(l: Locator): Promise<string> {
  return l.evaluate((el) => getComputedStyle(el).backgroundColor);
}

test.describe("controls primitives", () => {
  test("@controls a checkbox is 18px, 5px radius, 1.5px border, with a 12px heavy tick", async ({ page }) => {
    await open(page, `/run/${PAUSED}/gate1`);
    const box = page.locator("[data-testid='queue-scope']").first();
    await expect(box).toBeVisible();
    // The tick is what is being measured, so tick it: the fixture opens with nothing in scope.
    if ((await box.getAttribute("data-state")) !== "checked") await box.click();
    await expect(box).toHaveAttribute("data-state", "checked");
    // The border is AUTHORED at 1.5px (Safari draws it so), but Chromium floors any fractional border width of
    // 1px or more to a whole CSS pixel at every device scale — probed on Chromium 151 at 1x and 2x. The lab was
    // judged in Chrome, so 1px here IS the box Bhargav approved; the box and the radius are what moved.
    expect(await geometry(box)).toEqual({ w: 18, h: 18, radius: "5px", border: "1px" });
    await expect(box).toHaveClass(/border-\[1\.5px\]/);
    const tick = box.locator("svg");
    const t = await geometry(tick);
    expect([t.w, t.h]).toEqual([12, 12]);
    await expect(tick).toHaveAttribute("stroke-width", "3");
  });

  test("@controls every dropdown wears the up-down arrows, not a single chevron", async ({ page }) => {
    await open(page, "/new");
    const triggers = page.locator("button[role='combobox']");
    expect(await triggers.count()).toBeGreaterThan(0);
    for (const t of await triggers.all()) {
      await expect(t.locator("svg.lucide-chevrons-up-down")).toHaveCount(1);
      await expect(t.locator("svg.lucide-chevron-down")).toHaveCount(0);
    }
  });

  test("@controls a disclosure header is a sentence-case label and a chevron — the whole row lights on hover, no words", async ({
    page,
  }) => {
    await open(page, `/run/${PAUSED}/gate1`);
    const trigger = page.locator("[data-testid='how-to'] > button").first();
    await expect(trigger).toHaveText("How to use this screen");
    const label = trigger.locator("span").first();
    const lead = page.locator("[data-testid='how-to-lead']");
    const t = await type(label);
    expect(t).toMatchObject({ size: "14px", weight: "600", transform: "none" });
    // Full ink: the label is the same colour as the body text it heads, not a muted eyebrow.
    expect(t.color).toBe((await type(lead)).color);
    const before = await background(trigger);
    await trigger.hover();
    await expect.poll(() => background(trigger)).not.toBe(before);
  });

  test("@controls an inherited panel's header says what it holds, never Show or Hide", async ({ page }) => {
    await open(page, `/run/${FINISHED}/gate2`);
    const summary = page.locator("[data-testid='inherited-source-rows'] > summary");
    await expect(summary).toBeVisible();
    await expect(summary).not.toContainText(/\b(Show|Hide)\b/);
    const label = summary.locator("[data-disclosure-label]");
    expect(await type(label)).toMatchObject({ size: "14px", weight: "600", transform: "none" });
    const before = await background(summary);
    await summary.hover();
    await expect.poll(() => background(summary)).not.toBe(before);
  });
});

test.describe("controls section labels", () => {
  test("@controls a panel heading is sentence case, 14px semibold, full ink — on every gate", async ({ page }) => {
    await open(page, `/run/${FINISHED}/gate2`);
    const rationale = page.getByText("Why this CDE — model rationale", { exact: true });
    await expect(rationale).toBeVisible();
    const t = await type(rationale);
    expect(t).toMatchObject({ size: "14px", weight: "600", transform: "none" });
    // Full ink: the heading is the colour of the concept title it sits under, not a muted eyebrow.
    expect(t.color).toBe((await type(page.locator("[data-testid='concept-title']"))).color);

    await open(page, `/run/${FINISHED}/gate3`);
    const target = page.locator("[data-testid='inherited-target']").getByText(/^(Selected|Synthesized) CDE$/);
    expect(await type(target)).toMatchObject({ size: "14px", weight: "600", transform: "none" });
  });

  test("@controls column headers and the rail's gate labels keep their uppercase register", async ({ page }) => {
    await open(page, `/run/${FINISHED}/gate2`);
    expect(await type(page.locator("[data-testid='candidate-columns']"))).toMatchObject({
      size: "12px",
      transform: "uppercase",
    });
    const railLabel = page.locator("[data-testid='gate-rail'] li span.tracking-eyebrow").first();
    expect(await type(railLabel)).toMatchObject({ size: "12px", transform: "uppercase" });
  });
});
