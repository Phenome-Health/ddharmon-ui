import { test, expect } from "@playwright/test";
import { GATE_LABELS } from "@/components/gate/GateRail";

/**
 * The Guide describes the run a visitor will actually meet (rewritten 2026-11-05: it still described the v1 flow —
 * one run, then a review queue / workbench — months after the staged gates shipped). It walks the same screens, in
 * the same order, under the same names the gate rail uses, so a renamed or reordered gate breaks this rather than
 * leaving the guide quietly wrong again.
 */
test("@guide walks Set up and the four gates, in order, under the rail's own names", async ({ page }) => {
  await page.goto("/guide");
  const steps = page.getByTestId("guide-step");
  const expected: [string, string][] = [
    [GATE_LABELS.setup, ""],
    ["Gate 1", GATE_LABELS.gate1],
    ["Gate 2", GATE_LABELS.gate2],
    ["Gate 3", GATE_LABELS.gate3],
    ["Gate 4", GATE_LABELS.gate4],
  ];
  await expect(steps).toHaveCount(expected.length);
  for (const [i, [label, name]] of expected.entries()) {
    await expect(steps.nth(i)).toContainText(label);
    if (name) await expect(steps.nth(i)).toContainText(name);
  }
});

test("@guide says where the money moves: Start run first, then Gate 1 and Gate 2's Continue, Gate 3 free", async ({ page }) => {
  await page.goto("/guide");
  const steps = page.getByTestId("guide-step");
  await expect(steps.nth(0)).toContainText("Start run is the first charge");
  await expect(steps.nth(1)).toContainText("Continue buys the CDE assignment");
  await expect(steps.nth(2)).toContainText("Continue buys the transform specs");
  await expect(steps.nth(3)).toContainText("costs nothing");
});

test("@guide no longer describes the retired one-shot flow", async ({ page }) => {
  await page.goto("/guide");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.locator("main")).not.toContainText("review queue or the workbench");
  await expect(page.locator("main")).not.toContainText("Run the harmonization");
});
