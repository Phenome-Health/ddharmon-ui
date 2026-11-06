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

test("@guide puts every cost fact in ONE section, not under the steps (Lavish note 6-7, 2026-11-06)", async ({ page }) => {
  await page.goto("/guide");
  const cost = page.getByTestId("guide-cost");
  await expect(cost).toBeVisible();
  // Where the money moves, in run order.
  await expect(cost).toContainText("Start run");
  await expect(cost).toContainText("Gate 1's Continue");
  await expect(cost).toContainText("Gate 2's Continue");
  await expect(cost).toContainText(/free/i);
  // The steps describe the work; the cost lives only in the cost section.
  await expect(page.getByTestId("guide-step").filter({ hasText: "Start run is the first charge" })).toHaveCount(0);
  await expect(page.getByTestId("guide-step").filter({ hasText: "Continue buys" })).toHaveCount(0);
});

test("@guide no longer describes the retired one-shot flow", async ({ page }) => {
  await page.goto("/guide");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.locator("main")).not.toContainText("review queue or the workbench");
  await expect(page.locator("main")).not.toContainText("Run the harmonization");
});

test("@guide introduces the gates before naming one, and drops the sections Bhargav cut (2026-11-06)", async ({ page }) => {
  await page.goto("/guide");
  const main = page.locator("main");
  // "What you get back" sits ABOVE the step-by-step, so it must not lean on gate names a first-time reader has not met.
  await expect(page.getByTestId("guide-get-back")).not.toContainText(/Gate \d/);
  await expect(main).not.toContainText("You're in the loop");
  await expect(main).not.toContainText("Learn more");
});

test("@guide motivates the AI before using it: the research lines ddharmon comes from (Lavish note, 2026-11-06)", async ({ page }) => {
  await page.goto("/guide");
  const lineage = page.getByTestId("guide-lineage");
  await expect(lineage).toBeVisible();
  for (const line of ["Topic modeling", "LLM refinement", "Prompt optimization"]) {
    await expect(lineage).toContainText(line);
  }
  // It comes right after the problem and before any step, so the AI the steps rely on has been introduced.
  const lineageTop = (await lineage.boundingBox())!.y;
  const firstStepTop = (await page.getByTestId("guide-step").first().boundingBox())!.y;
  expect(lineageTop).toBeLessThan(firstStepTop);
  // Every work it names is linked to its paper.
  for (const name of ["BERTopic", "BioLORD-2023", "TopicGPT", "DSPy", "GEPA"]) {
    await expect(lineage.getByRole("link", { name })).toHaveAttribute("href", /^https:\/\//);
  }
});
