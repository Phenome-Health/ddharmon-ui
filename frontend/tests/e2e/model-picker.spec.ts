import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * The New Run form's model picker follows the model list, not a model name written into the UI.
 *
 * Which models ddharmon was validated against is decided in core (`ddharmon.llm.models`), served by
 * `GET /api/harmonize/models` as `{models: [{id, label, provider, validated}], default}` — and, in this static
 * build, by the bundled `static-data/models.json` the fixture builder snapshots from that endpoint. So a model
 * bump is a core release plus a repin: the picker's first selection is the list's `default`, a model is
 * selectable only when the list marks it `validated`, and the help text names whichever models those are.
 *
 * The list is swapped with `page.route` for one where a model this UI has never heard of is the validated
 * default — if the picker still lands on (or names) Sonnet 4.6, it is reading a hardcoded name.
 *
 *   run: E2E_PORT=4193 npx playwright test model-picker
 */

const MODELS_URL = "**/static-data/models.json";

interface Model {
  id: string;
  label: string;
  provider: string;
  validated: boolean;
}

async function serveModels(page: Page, models: Model[], defaultId: string): Promise<void> {
  await page.route(MODELS_URL, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ models, default: defaultId, source: "core" }),
    }),
  );
}

async function openNewRun(page: Page): Promise<void> {
  await page.goto("/new");
  await page.waitForLoadState("networkidle");
}

/** Every option in the model dropdown, as its visible text and whether it can be picked. */
async function modelOptions(page: Page): Promise<{ text: string; disabled: boolean }[]> {
  await page.getByTestId("model-select").click();
  const options = page.getByRole("option");
  await expect(options.first()).toBeVisible();
  const out = await options.evaluateAll((els) =>
    els.map((el) => ({
      text: (el.textContent ?? "").trim(),
      disabled: el.getAttribute("aria-disabled") === "true" || el.hasAttribute("data-disabled"),
    })),
  );
  await page.keyboard.press("Escape");
  await expect(options).toHaveCount(0);
  return out;
}

/** Hover one ⓘ and return its tooltip; the previous tooltip is dismissed first so only one is ever open. */
async function tooltipFor(page: Page, label: string): Promise<Locator> {
  await page.mouse.move(0, 0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await page.getByRole("button", { name: label }).hover();
  const tip = page.getByRole("tooltip");
  await expect(tip).toBeVisible();
  return tip;
}

test.describe("New Run model picker", () => {
  test("@models the bundled list: its default is selected, only validated models are selectable, the help names them", async ({
    page,
  }) => {
    await openNewRun(page);
    await expect(page.getByTestId("provider-select")).toHaveText("Anthropic");
    await expect(page.getByTestId("model-select")).toHaveText("Claude Sonnet 4.6");

    const options = await modelOptions(page);
    expect(options).toContainEqual({ text: "Claude Sonnet 4.6", disabled: false });
    // Every other model is offered — visible, so the picker does not misrepresent what exists — but disabled.
    const others = options.filter((o) => o.text !== "Claude Sonnet 4.6");
    expect(others.length).toBeGreaterThan(0);
    for (const o of others) expect(o).toEqual({ text: expect.stringMatching(/· not yet tested$/), disabled: true });

    await expect(await tooltipFor(page, "About the model options")).toContainText("so far that's Claude Sonnet 4.6");
  });

  test("@models a list naming a different validated model: the picker and its help follow the list", async ({
    page,
  }) => {
    await serveModels(
      page,
      [
        { id: "claude-next-5", label: "Claude Next 5", provider: "anthropic", validated: true },
        { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", provider: "anthropic", validated: false },
        { id: "gpt-4o", label: "GPT-4o", provider: "openai", validated: false },
      ],
      "claude-next-5",
    );
    await openNewRun(page);

    await expect(page.getByTestId("model-select")).toHaveText("Claude Next 5");
    expect(await modelOptions(page)).toEqual([
      { text: "Claude Next 5", disabled: false },
      { text: "Claude Sonnet 4.6 · not yet tested", disabled: true },
    ]);

    const modelTip = await tooltipFor(page, "About the model options");
    await expect(modelTip).toContainText("so far that's Claude Next 5");
    await expect(modelTip).not.toContainText("Sonnet");
    const providerTip = await tooltipFor(page, "About the provider options");
    await expect(providerTip).toContainText("tested only with Anthropic (Claude Next 5)");
    await expect(providerTip).not.toContainText("Sonnet");
  });

  test("@models the first selection is the list's default, its provider included", async ({ page }) => {
    await serveModels(
      page,
      [
        { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", provider: "anthropic", validated: true },
        { id: "gemini/gemini-3-pro", label: "Gemini 3 Pro", provider: "gemini", validated: true },
      ],
      "gemini/gemini-3-pro",
    );
    await openNewRun(page);

    await expect(page.getByTestId("provider-select")).toHaveText("Google Gemini");
    await expect(page.getByTestId("model-select")).toHaveText("Gemini 3 Pro");
    // Two validated models across two providers are both named, each under its provider.
    await expect(await tooltipFor(page, "About the provider options")).toContainText(
      "tested only with Anthropic (Claude Sonnet 4.6) and Google Gemini (Gemini 3 Pro)",
    );
  });
});
