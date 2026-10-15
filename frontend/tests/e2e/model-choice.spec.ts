import { expect, test, type Page } from "@playwright/test";
import { costFactor } from "@/lib/model-catalog";
import type { ModelCatalog } from "@/types";

/**
 * Round 11 (Bhargav, 2026-10-14): "I want the user to be able to select haiku or sonnet 5.5 … ensure users have the
 * most performant & cheap models available to them as they're released."
 *
 * Which models are offered is DATA from core's registry (served as `/models`, snapshot in static-data/models.json):
 * a model is SELECTABLE once core knows how to call it, ahead of its benchmark, and the picker says it is not yet
 * benchmarked. The estimate is calibrated on the validated default, so a cheaper model's quote scales by its price
 * and its tokenizer — Haiku 5.5 is ~4% of Sonnet 4.6, and a Sonnet-priced quote would overstate it ~25x.
 */

const SETUP = "/run/new/setup";

function csv(n: number): string {
  const rows = ["variable_name,description,units"];
  for (let i = 0; i < n; i++) rows.push(`var_${i},a description of variable ${i},kg`);
  return rows.join("\n");
}

async function readyToStart(page: Page): Promise<void> {
  await page.goto(SETUP);
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => localStorage.clear());
  await page.getByTestId("dict-upload").setInputFiles({
    name: "cohort.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(csv(40)),
  });
  await expect(page.getByTestId("dict-card")).toHaveCount(1);
  await page.getByTestId("api-key").fill("sk-ant-e2e-not-a-real-key");
  await page.getByTestId("mark-all-complete").click();
  await expect(page.getByTestId("start-blocked")).toHaveCount(0);
}

async function catalog(page: Page): Promise<ModelCatalog> {
  return (await (await page.request.get("/static-data/models.json")).json()) as ModelCatalog;
}

test.describe("Model choice — newer models ahead of their benchmark (round 11)", () => {
  test("@models Setup offers Sonnet 5.5 and Haiku 5.5, says they are not yet benchmarked, keeps the default", async ({
    page,
  }) => {
    await page.goto(SETUP);
    await page.waitForLoadState("networkidle");
    const select = page.getByTestId("model");
    await expect(select).toHaveValue("claude-sonnet-4-6");
    const options = await select.locator("option").evaluateAll((els) =>
      els.map((el) => ({
        value: (el as HTMLOptionElement).value,
        text: (el.textContent ?? "").trim(),
        disabled: (el as HTMLOptionElement).disabled,
      })),
    );
    expect(options).toContainEqual({ value: "claude-sonnet-4-6", text: "Claude Sonnet 4.6", disabled: false });
    expect(options).toContainEqual({
      value: "claude-sonnet-5-5",
      text: "Claude Sonnet 5.5 — not yet benchmarked",
      disabled: false,
    });
    expect(options).toContainEqual({
      value: "claude-haiku-5-5",
      text: "Claude Haiku 5.5 — not yet benchmarked",
      disabled: false,
    });
    expect(options.find((o) => o.value === "claude-opus-5-5")?.disabled, "a listed-only model is selectable").toBe(
      true,
    );
  });

  test("@models choosing Haiku 5.5 scales the quote by its price and tokenizer", async ({ page }) => {
    await readyToStart(page);
    const bar = page.getByTestId("commit-bar");
    const sonnet = Number(await bar.getAttribute("data-total"));
    expect(sonnet).toBeGreaterThan(0);
    await page.getByTestId("model").selectOption("claude-haiku-5-5");
    await expect.poll(async () => Number(await bar.getAttribute("data-total"))).toBeLessThan(sonnet);
    const haiku = Number(await bar.getAttribute("data-total"));
    expect(haiku / sonnet).toBeCloseTo(costFactor(await catalog(page), "claude-haiku-5-5"), 4);
  });

  test("@models Start sends the chosen model", async ({ page }) => {
    const sent: { modelTag?: string }[] = [];
    await page.route("**/api/harmonize/batch", async (route) => {
      const body = route.request().postDataBuffer()?.toString("utf8") ?? "";
      const m = /name="config"\r\n\r\n([\s\S]*?)\r\n--/.exec(body);
      if (m) sent.push(JSON.parse(m[1]) as { modelTag?: string });
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jobId: "j" }) });
    });
    await readyToStart(page);
    await page.getByTestId("model").selectOption("claude-haiku-5-5");
    await page.getByTestId("start-run").click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0].modelTag).toBe("claude-haiku-5-5");
  });

  test("@models costFactor: the default is 1; a cheaper model is priced and tokenized relative to it", () => {
    const cat: ModelCatalog = {
      default: "a",
      source: "core",
      models: [
        { id: "a", label: "A", provider: "anthropic", validated: true, selectable: true, inputPerMtok: 3, outputPerMtok: 15, tokenRatio: 1 },
        { id: "b", label: "B", provider: "anthropic", validated: false, selectable: true, inputPerMtok: 0.1, outputPerMtok: 0.5, tokenRatio: 1.3 },
        { id: "c", label: "C", provider: "openai", validated: false, selectable: false, inputPerMtok: null, outputPerMtok: null, tokenRatio: 1 },
      ],
    };
    expect(costFactor(cat, "a")).toBe(1);
    expect(costFactor(cat, "b")).toBeCloseTo((0.72 * (0.1 / 3) + 0.28 * (0.5 / 15)) * 1.3, 10);
    expect(costFactor(cat, "c"), "an unpriced model is quoted at the default's price, never below it").toBe(1);
    expect(costFactor(cat, "unknown")).toBe(1);
  });
});
