import { expect, test, type Page, type Route } from "@playwright/test";
import {
  MAX_COMPONENT_EXTRACT_CHARS,
  acceptedDraft,
  errorOutcome,
  extractionRefusalFor,
  initialSelection,
  proposalOutcome,
  underEnumeratedNote,
  type ComponentProposal,
} from "@/lib/score-proposal";
import { PAUSED_JOB, serveRun } from "./gate1-fixture";

/**
 * 08-16e — a model reads the score paper, instead of the reviewer transcribing it.
 *
 * WHAT IS BEING PROTECTED. Extraction PROPOSES; the reviewer disposes. A proposal is never written into the
 * declaration on its own, the free text stays on screen beside it (it is the evidence the list is checked
 * against), and the panel's three cost states — reading free, extracting paid, matching paid — are each stated
 * where the reviewer meets them.
 *
 * HOW A STATIC BUILD REACHES A PAID ROUTE. It cannot: there is no backend. The two document calls try the
 * request first and fall back to the static-preview message, so these specs fulfil them at the NETWORK layer
 * (`page.route`) with the exact shapes the backend returns (`tests/test_score_components.py` pins those).
 * The run is served UNPINNED — the committed fixture is the shared demo, which refuses to spend by design
 * (asserted below as its own case).
 *
 * In its own file rather than `gate1.spec.ts` so a parallel stream editing that spec does not collide with
 * this one.
 *
 *   run: npx playwright test score-proposal
 */

const TEXT = [
  "A standard procedure for creating a frailty index. Table 1: deficit variables.",
  "Help Bathing  Yes = 1, No = 0",
  "Help Dressing  Yes = 1, No = 0",
  "Self Rating of Health  Poor = 1, Fair = 0.75",
  "The index comprises 40 deficits.",
].join("\n");

const READ = {
  text: TEXT,
  provenance: "searle-2008.pdf",
  sha256: "a".repeat(64),
  nChars: TEXT.length,
};

function proposal(over: Partial<ComponentProposal> = {}): ComponentProposal {
  return {
    found: true,
    scoreName: "Frailty index (Searle 2008)",
    statedNItems: 40,
    components: [
      {
        name: "Help Bathing",
        verbatim: true,
        coding: { kind: "categorical", cutoff: "", referenceRange: "", codeMap: { Yes: "1", No: "0" }, formula: "", units: "" },
      },
      { name: "Help Dressing", verbatim: true, coding: null },
      // Not in the text: what a model fills a gap with. Kept, flagged, NOT ticked.
      { name: "Grip strength", verbatim: false, coding: null },
    ],
    reason: "",
    sha256: READ.sha256,
    nChars: READ.nChars,
    provenance: READ.provenance,
    model: "claude-sonnet-4-6",
    cached: false,
    ...over,
  };
}

type Answer = { status: number; body: unknown };

/**
 * Serve an UNPINNED Gate 1 run, the free read, and the extraction. Records every extraction request so a spec
 * can assert that nothing was spent before the press — or at all.
 */
async function setup(
  page: Page,
  answer: Answer | ((n: number) => Answer),
  opts: { pinned?: boolean; gate?: string; read?: typeof READ } = {},
): Promise<{ extracts: unknown[] }> {
  const extracts: unknown[] = [];
  await serveRun(page, (run) => {
    (run.config as Record<string, unknown>).demo = opts.pinned ?? false;
    if (opts.gate) {
      run.gatePosition = opts.gate as typeof run.gatePosition;
      run.result!.gatePosition = opts.gate as typeof run.gatePosition;
    }
  });
  await page.route("**/api/harmonize/score/extract", (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(opts.read ?? READ) }),
  );
  await page.route("**/api/harmonize/jobs/*/score/components", async (route: Route) => {
    extracts.push(route.request().postDataJSON());
    const a = typeof answer === "function" ? answer(extracts.length) : answer;
    await route.fulfill({ status: a.status, contentType: "application/json", body: JSON.stringify(a.body) });
  });
  await page.goto(`/run/${PAUSED_JOB}/gate1`);
  await page.waitForLoadState("networkidle");
  await page.locator("[data-testid='score-panel-toggle']").click();
  await expect(page.locator("[data-testid='score-panel']")).toBeVisible();
  return { extracts };
}

async function readPaper(page: Page): Promise<void> {
  await page
    .locator("[data-testid='score-upload'] input[type='file']")
    .setInputFiles({ name: "searle-2008.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 stub") });
  await expect(page.locator("[data-testid='score-doc-read']")).toBeVisible();
}

const OK: Answer = { status: 200, body: proposal() };
const extractButton = (page: Page) => page.getByRole("button", { name: /Extract the components/ });

// --- the algebra, in node --------------------------------------------------------------------------------

test.describe("score proposal algebra", () => {
  test("@gate1 only names found word-for-word start ticked; the rest are kept but never accepted by default", () => {
    expect([...initialSelection(proposal())]).toEqual(["Help Bathing", "Help Dressing"]);
  });

  test("@gate1 accepting ADDS to what was typed and never duplicates it", () => {
    expect(acceptedDraft("Weak grip\nhelp bathing", ["Help Bathing", "Help Dressing"])).toBe(
      "Weak grip\nhelp bathing\nHelp Dressing",
    );
    expect(acceptedDraft("", ["Help Bathing"])).toBe("Help Bathing");
  });

  test("@gate1 found, nothing, refused and failed are four outcomes, not two", () => {
    expect(proposalOutcome(proposal())).toBe("found");
    expect(proposalOutcome(proposal({ found: false, components: [] }))).toBe("nothing");
    for (const s of [400, 403, 409, 413]) expect(errorOutcome(s)).toBe("refused");
    for (const s of [502, 503, 504, 429, undefined]) expect(errorOutcome(s)).toBe("failed");
  });

  test("@gate1 the pre-press refusals: the demo, a passed gate, and a document over the cap", () => {
    expect(extractionRefusalFor({ nChars: 10 })).toBeNull();
    expect(extractionRefusalFor({ nChars: 10, pinned: true })?.reason).toMatch(/demo/i);
    expect(extractionRefusalFor({ nChars: 10, frozen: true })?.reason).toMatch(/passed Gate 1/i);
    const over = extractionRefusalFor({ nChars: MAX_COMPONENT_EXTRACT_CHARS + 1 });
    expect(over?.reason).toContain(MAX_COMPONENT_EXTRACT_CHARS.toLocaleString());
    expect(over?.reason).toMatch(/refused rather than cut short/);
  });

  test("@gate1 a document that claims more items than were read says so", () => {
    expect(underEnumeratedNote(proposal())).toMatch(/40 items; 3 could be read/);
    expect(underEnumeratedNote(proposal({ statedNItems: 3 }))).toBe("");
  });
});

// --- the rendered flow -----------------------------------------------------------------------------------

test.describe("gate1 score proposal", () => {
  test("@gate1 reading shows the text beside the form and no longer dumps it into the components box", async ({
    page,
  }) => {
    await setup(page, OK);
    await readPaper(page);
    await expect(page.locator("[data-testid='score-doc-text']")).toContainText("Help Bathing  Yes = 1");
    // The 2026-09-15 finding: raw document text used to be pasted into the components box for the reviewer
    // to prune. It is evidence, not a declaration draft.
    await expect(page.locator("[data-testid='score-components']")).toHaveValue("");
  });

  test("@gate1 all three cost states are stated where the reviewer meets them, and nothing is spent unpressed", async ({
    page,
  }) => {
    const { extracts } = await setup(page, OK);
    await readPaper(page);
    await expect(page.locator("[data-testid='score-upload']")).toContainText(/costs nothing/i);
    const price = page.locator("[data-testid='score-extract-price']");
    await expect(price).toContainText(/costs money/i);
    await expect(price).toContainText(/one model call/i);
    await expect(price).toContainText(READ.nChars.toLocaleString());
    await expect(page.locator("[data-testid='score-match-price']")).toContainText(/costs money/i);
    // The price sits ABOVE the control it prices, inline — never behind a modal.
    const priceBox = await price.boundingBox();
    const buttonBox = await extractButton(page).boundingBox();
    expect(priceBox!.y).toBeLessThan(buttonBox!.y);
    await expect(page.locator("[role='dialog']")).toHaveCount(0);
    // The closed strip names all three: free, and two paid steps.
    await expect(page.locator("[data-testid='score-panel-toggle']")).toContainText(/free.*extracting.*matching/i);
    expect(extracts).toEqual([]);
  });

  test("@gate1 the proposal is a PROPOSAL: shown for checking, never written into the declaration", async ({
    page,
  }) => {
    const { extracts } = await setup(page, OK);
    await readPaper(page);
    await extractButton(page).click();
    const list = page.locator("[data-testid='score-proposal']");
    await expect(list).toBeVisible();
    await expect(list).toContainText(/proposed by a model/i);
    // It sent the TEXT that was read, and its handle — not the file.
    expect(extracts).toEqual([{ text: TEXT, sha256: READ.sha256, provenance: READ.provenance }]);
    // Nothing declared, nothing drafted, until the reviewer accepts.
    await expect(page.locator("[data-testid='score-components']")).toHaveValue("");
    await expect(page.locator("[data-testid='score-component']")).toHaveCount(0);
    // The free text is STILL on screen — the evidence the list is checked against.
    await expect(page.locator("[data-testid='score-doc-text']")).toBeVisible();
    // The document's gap is named, not filled.
    await expect(list).toContainText(/40 items; 3 could be read/);
  });

  test("@gate1 a name the text does not contain is flagged and unticked; stated coding only where stated", async ({
    page,
  }) => {
    await setup(page, OK);
    await readPaper(page);
    await extractButton(page).click();
    const item = (name: string) => page.locator(`[data-testid='score-proposal-item'][data-name='${name}']`);
    await expect(item("Grip strength")).toHaveAttribute("data-verbatim", "false");
    await expect(item("Grip strength").locator("[data-testid='score-proposal-unverified']")).toBeVisible();
    await expect(item("Grip strength").getByRole("checkbox")).not.toBeChecked();
    await expect(item("Help Bathing").getByRole("checkbox")).toBeChecked();
    await expect(item("Help Bathing").locator("[data-testid='score-proposal-unverified']")).toHaveCount(0);
    // Rule 2: a coding shows only where the source stated one.
    await expect(item("Help Bathing").locator("[data-testid='score-proposal-coding']")).toContainText("Yes = 1, No = 0");
    await expect(item("Help Dressing").locator("[data-testid='score-proposal-coding']")).toHaveCount(0);
  });

  test("@gate1 an accepted list behaves exactly as a typed one: same box, same declare, survives a reload", async ({
    page,
  }) => {
    await setup(page, OK);
    await readPaper(page);
    await extractButton(page).click();
    // Deliberately tick the flagged one too — the reviewer disposes, including against the flag.
    await page
      .locator("[data-testid='score-proposal-item'][data-name='Grip strength']")
      .getByRole("checkbox")
      .check();
    await page.getByRole("button", { name: /Use the 3 ticked components/ }).click();
    await expect(page.locator("[data-testid='score-components']")).toHaveValue(
      "Help Bathing\nHelp Dressing\nGrip strength",
    );
    await expect(page.locator("#score-name")).toHaveValue("Frailty index (Searle 2008)");
    // The ordinary declare path — the one typing uses.
    await page.getByRole("button", { name: "Declare these components" }).click();
    await expect(page.locator("[data-testid='score-component']")).toHaveCount(3);
    await page.reload();
    await page.waitForLoadState("networkidle");
    await page.locator("[data-testid='score-panel-toggle']").click();
    await expect(page.locator("[data-testid='score-component']")).toHaveCount(3);
  });

  test("@gate1 unticking a proposed name keeps it out; discarding leaves the box untouched", async ({ page }) => {
    await setup(page, OK);
    await readPaper(page);
    await page.locator("[data-testid='score-components']").fill("Weak grip");
    await extractButton(page).click();
    await page.locator("[data-testid='score-proposal-item'][data-name='Help Dressing']").getByRole("checkbox").uncheck();
    await page.getByRole("button", { name: /Use the 1 ticked component\b/ }).click();
    await expect(page.locator("[data-testid='score-components']")).toHaveValue("Weak grip\nHelp Bathing");

    await extractButton(page).click();
    await page.getByRole("button", { name: "Discard the proposal" }).click();
    await expect(page.locator("[data-testid='score-proposal']")).toHaveCount(0);
    await expect(page.locator("[data-testid='score-components']")).toHaveValue("Weak grip\nHelp Bathing");
  });

  test("@gate1 found nothing is an answer: said plainly, the text stays, and typing still works", async ({ page }) => {
    await setup(page, {
      status: 200,
      body: proposal({ found: false, components: [], statedNItems: null, reason: "no score components could be read" }),
    });
    await readPaper(page);
    await extractButton(page).click();
    const box = page.locator("[data-testid='score-extract']");
    await expect(box).toHaveAttribute("data-state", "nothing");
    await expect(box).toContainText(/found no components/i);
    await expect(page.locator("[data-testid='score-proposal']")).toHaveCount(0);
    await expect(page.locator("[data-testid='score-doc-text']")).toBeVisible();
    await page.locator("[data-testid='score-components']").fill("Help Bathing");
    await expect(page.getByRole("button", { name: "Declare these components" })).toBeEnabled();
  });

  test("@gate1 a failure says it FAILED — distinct from found nothing — and the text stays to read", async ({
    page,
  }) => {
    await setup(page, {
      status: 502,
      body: { detail: "The model's answer could not be read as a component list, so nothing is proposed." },
    });
    await readPaper(page);
    await extractButton(page).click();
    const box = page.locator("[data-testid='score-extract']");
    await expect(box).toHaveAttribute("data-state", "failed");
    await expect(box).toContainText(/did not produce|failed/i);
    await expect(box).toContainText("could not be read as a component list");
    await expect(box).not.toContainText(/found no components/i);
    await expect(page.locator("[data-testid='score-doc-text']")).toBeVisible();
  });

  test("@gate1 a refusal says it was REFUSED and that nothing was charged", async ({ page }) => {
    await setup(page, {
      status: 400,
      body: { detail: "Enter your Anthropic API key to extract the components — it is one model call." },
    });
    await readPaper(page);
    await extractButton(page).click();
    const box = page.locator("[data-testid='score-extract']");
    await expect(box).toHaveAttribute("data-state", "refused");
    await expect(box).toContainText(/refused/i);
    await expect(box).toContainText("Enter your Anthropic API key");
    await expect(page.locator("[data-testid='score-doc-text']")).toBeVisible();
  });

  test("@gate1 the same text a second time says it was not charged again", async ({ page }) => {
    await setup(page, (n) => ({ status: 200, body: proposal({ cached: n > 1 }) }));
    await readPaper(page);
    await extractButton(page).click();
    await expect(page.locator("[data-testid='score-proposal-cached']")).toHaveCount(0);
    await page.getByRole("button", { name: "Discard the proposal" }).click();
    await extractButton(page).click();
    await expect(page.locator("[data-testid='score-proposal-cached']")).toContainText(/not charged again/i);
  });

  test("@gate1 a document over the cap is refused BEFORE the press, with both numbers", async ({ page }) => {
    const big = "x".repeat(MAX_COMPONENT_EXTRACT_CHARS + 1);
    const { extracts } = await setup(page, OK, { read: { ...READ, text: big, nChars: big.length } });
    await readPaper(page);
    const na = page.locator("[data-testid='score-extract'] [data-testid='not-available']");
    await expect(na).toContainText(big.length.toLocaleString());
    await expect(na).toContainText(MAX_COMPONENT_EXTRACT_CHARS.toLocaleString());
    await expect(extractButton(page)).toHaveCount(0);
    expect(extracts).toEqual([]);
  });

  test("@gate1 the shared demo refuses to spend on extraction, and typing still works", async ({ page }) => {
    const { extracts } = await setup(page, OK, { pinned: true });
    await readPaper(page);
    const na = page.locator("[data-testid='score-extract'] [data-testid='not-available']");
    await expect(na).toContainText(/shared demo/i);
    await expect(extractButton(page)).toHaveCount(0);
    await page.locator("[data-testid='score-components']").fill("Help Bathing");
    await expect(page.getByRole("button", { name: "Declare these components" })).toBeEnabled();
    expect(extracts).toEqual([]);
  });
});

test.describe("gate1 score proposal frozen", () => {
  test("@gate1 a passed Gate 1 refuses the extraction action (08-27 audit B4)", async ({ page }) => {
    const { extracts } = await setup(page, OK, { gate: "gate2" });
    await expect(page.locator("[data-testid='gate-frozen']")).toBeVisible();
    await readPaper(page);
    const na = page.locator("[data-testid='score-extract'] [data-testid='not-available']");
    await expect(na).toContainText(/passed Gate 1/i);
    await expect(extractButton(page)).toHaveCount(0);
    expect(extracts).toEqual([]);
  });
});
