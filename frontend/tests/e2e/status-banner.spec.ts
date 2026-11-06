import { expect, test } from "@playwright/test";

/**
 * The site-wide "under active development" banner fits on ONE line on a standard laptop (Bhargav, 2026-11-06: it
 * wrapped to two lines and pushed every screen down). 1280px is the narrow end of a laptop viewport; the configured
 * 1440 is checked too. A line is measured, not guessed: the text's height must be one line-height.
 */
for (const width of [1280, 1440]) {
  test(`@banner the status banner is one line at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/");
    const text = page.getByRole("status").filter({ hasText: "under active development" }).locator("p");
    await expect(text).toBeVisible();
    const { height, lineHeight } = await text.evaluate((el) => ({
      height: el.getBoundingClientRect().height,
      lineHeight: parseFloat(getComputedStyle(el).lineHeight),
    }));
    expect(height).toBeLessThan(lineHeight * 1.5);
  });
}

test("@banner the banner still says the two things it is for: provisional results, and where feedback goes", async ({ page }) => {
  await page.goto("/");
  const banner = page.getByRole("status").filter({ hasText: "under active development" });
  await expect(banner).toContainText(/provisional/i);
  await expect(banner).toContainText("Report an issue");
});
