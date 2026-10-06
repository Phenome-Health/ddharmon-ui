import { expect, test, type Page } from "@playwright/test";
import { decisionItemKey, optionSetKey, type DecisionIndex, type GateDecision } from "@/lib/gate-decisions";
import { SANDBOX_PREFIX } from "@/lib/sandbox";
import {
  RECORD_OPEN_CHARS,
  RECORD_OPEN_LINES,
  declarationSource,
  isLongRecord,
  pastedRecords,
  recordSize,
  stripStatus,
} from "@/lib/score-declaration";
import { STRIP_SUMMARY } from "@/lib/score-proposal";
import { declaredComponents } from "@/lib/score-scope";
import type { CompositeSpec } from "@/types";
import { PAUSED_JOB, asOwnedRun, serveRun } from "./gate1-fixture";

/**
 * What Gate 1's score panel says about the declaration it holds (phase-8 final review, round 2).
 *
 *  - H4, Bhargav: *"still there — fix now"*: the COLLAPSED score strip gave no hint that a score was already
 *    declared. Closed, it read as the same invitation whether the reviewer had declared 48 components or none.
 *  - Bhargav: *"if score builder source is pasted text, we should show a record of whatever was entered, same way
 *    we would for a doc. make it collapsible if it's long"*. A read document's text is shown read-only ("What was
 *    read"); a declaration typed or pasted into the components box left no record of what was entered.
 *
 *   run: npx playwright test tests/e2e/score-declaration.spec.ts
 */

const SCORE = "Frailty index (Searle 2008)";

/** The rows "Declare these components" writes: one `composite_swap` per component, chosen "" (not matched). */
function declared(scoreName: string, components: string[], extra: Record<string, unknown> = {}): GateDecision[] {
  return components.map((componentName) => ({
    scoreName,
    componentName,
    ...extra,
    chosen: "",
    alternatives: components,
    optionSetKey: optionSetKey(components),
  }));
}

function indexOf(...rows: GateDecision[][]): DecisionIndex {
  const byItem: Record<string, GateDecision> = {};
  for (const r of rows.flat()) byItem[decisionItemKey("composite_swap", r)] = r;
  return { composite_swap: byItem };
}

/** A spec derived under `name` whose matches found `found` of `components`. */
function specOf(name: string, components: string[], found: number): CompositeSpec {
  return {
    definition: {
      name,
      kind: "custom",
      citation: "",
      combinationRule: "",
      threshold: "",
      notes: "",
      statedNItems: null,
      underEnumerated: 0,
      provenance: "",
      sourceSha256: "",
      components: [],
    },
    matches: components.map((component, i) => ({
      component,
      conceptId: i < found ? `c${i}#g0` : null,
      concept: "",
      column: "",
      cohorts: [],
      sourceVariables: [],
      confidence: 0.9,
      rationale: "",
      required: true,
      pinned: false,
      shortlist: [],
    })),
    feasibility: {
      verdict: "partial",
      nRequired: components.length,
      nRequiredMatched: found,
      matched: [],
      missing: [],
      needsReview: [],
      computableCohorts: [],
      perCohort: [],
      caveats: [],
    },
    derivation: [],
    units: "",
    validationRules: [],
    sourceKind: "declaration",
  } as unknown as CompositeSpec;
}

const THREE = ["Weak grip strength", "Slow walking speed", "Unintentional weight loss"];

// --- H4: the closed strip says a score is declared ------------------------------------------------------------

test.describe("score strip status (H4)", () => {
  test("@gate1 nothing declared and nothing derived: no status — the strip stays an invitation", () => {
    expect(stripStatus({}, null)).toBeNull();
    expect(stripStatus(null, undefined)).toBeNull();
    expect(stripStatus({ composite_swap: {} }, null)).toBeNull();
  });

  test("@gate1 a declared score names itself, counts its components, and says it is not matched yet", () => {
    expect(stripStatus(indexOf(declared(SCORE, THREE)), null)).toBe(
      `${SCORE} · 3 components declared · not matched yet`,
    );
    // One component is "component", not "components".
    expect(stripStatus(indexOf(declared(SCORE, ["Weak grip strength"])), null)).toBe(
      `${SCORE} · 1 component declared · not matched yet`,
    );
  });

  test("@gate1 a match under the score's own name (any case) gives the match state: N of M found", () => {
    const spec = specOf(SCORE.toUpperCase(), THREE, 2);
    expect(stripStatus(indexOf(declared(SCORE, THREE)), spec)).toBe(
      `${SCORE} · 3 components declared · matched: 2 of 3 found`,
    );
    // A spec derived under ANOTHER score's name is not this score's match.
    expect(stripStatus(indexOf(declared(SCORE, THREE)), specOf("SES index", THREE, 3))).toBe(
      `${SCORE} · 3 components declared · not matched yet`,
    );
  });

  test("@gate1 a score derived with no declaration behind it still reads as a score, not an invitation", () => {
    expect(stripStatus({}, specOf("SES index", THREE, 1))).toBe("SES index · 3 components · matched: 1 of 3 found");
  });

  test("@gate1 a second declared score is counted, not hidden", () => {
    const index = indexOf(declared(SCORE, THREE), declared("SES index", ["Income"]));
    expect(stripStatus(index, null)).toBe(`${SCORE} · 3 components declared · not matched yet · and 1 more score`);
    const three = indexOf(declared(SCORE, THREE), declared("SES index", ["Income"]), declared("IC score", ["Gait"]));
    expect(stripStatus(three, null)).toMatch(/· and 2 more scores$/);
  });
});

// --- the record of a pasted source --------------------------------------------------------------------------

const PASTED = "Weak grip strength\n\n  Slow walking speed\nUnintentional weight loss\n";

test.describe("pasted source record", () => {
  test("@gate1 a declaration with no document read is PASTED text, kept exactly as entered", () => {
    expect(declarationSource(PASTED, null, 10)).toEqual({ kind: "paste", text: PASTED, at: 10 });
  });

  test("@gate1 a declaration made with a document read is that DOCUMENT's — its handle only, never its text", () => {
    const doc = { text: "the whole paper", provenance: "searle-2008.pdf", sha256: "a".repeat(64), nChars: 15 };
    const source = declarationSource("Help Bathing", doc, 11);
    expect(source).toEqual({ kind: "document", provenance: "searle-2008.pdf", sha256: "a".repeat(64), at: 11 });
    expect(JSON.stringify(source)).not.toContain("the whole paper");
  });

  test("@gate1 a pasted declaration reads back as its record; rows with no source make none", () => {
    const pasted = declared(SCORE, THREE, { source: declarationSource(PASTED, null, 10) });
    expect(pastedRecords(indexOf(pasted))).toEqual([{ scoreName: SCORE, text: PASTED }]);
    // Declared before sources were recorded: nothing to show, and nothing is reconstructed.
    expect(pastedRecords(indexOf(declared(SCORE, THREE)))).toEqual([]);
    expect(pastedRecords(null)).toEqual([]);
    expect(pastedRecords({})).toEqual([]);
  });

  test("@gate1 the NEWEST declaration of a score decides: a later document declaration has no pasted record", () => {
    const first = declared(SCORE, THREE, { source: declarationSource(PASTED, null, 10) });
    // Re-declared from a document: the rows it rewrites carry the document; a row only the paste named keeps its
    // older paste source, and must not resurrect the record.
    const doc = { text: "t", provenance: "searle-2008.pdf", sha256: "b".repeat(64), nChars: 1 };
    const second = declared(SCORE, THREE.slice(0, 2), { source: declarationSource("x", doc, 20) });
    expect(pastedRecords(indexOf(first, second))).toEqual([]);
    // A later PASTE replaces the earlier one's text.
    const third = declared(SCORE, THREE.slice(0, 2), { source: declarationSource("Weak grip strength\nSlow walking speed", null, 30) });
    expect(pastedRecords(indexOf(first, second, third))).toEqual([
      { scoreName: SCORE, text: "Weak grip strength\nSlow walking speed" },
    ]);
  });

  test("@gate1 one record per declared score, in declared order; a malformed source is ignored", () => {
    const a = declared(SCORE, THREE, { source: declarationSource(PASTED, null, 10) });
    const b = declared("SES index", ["Income"], { source: declarationSource("Income", null, 12) });
    const bad = declared("IC score", ["Gait"], { source: { kind: "paste", text: 42, at: 13 } });
    expect(pastedRecords(indexOf(a, b, bad))).toEqual([
      { scoreName: SCORE, text: PASTED },
      { scoreName: "SES index", text: "Income" },
    ]);
  });

  test("@gate1 LONG is more than the document record's box shows before it scrolls", () => {
    const lines = (n: number) => Array.from({ length: n }, (_, i) => `Component ${i + 1}`).join("\n");
    expect(RECORD_OPEN_LINES).toBe(15);
    expect(isLongRecord(lines(RECORD_OPEN_LINES))).toBe(false);
    expect(isLongRecord(`${lines(RECORD_OPEN_LINES)}\n\n`)).toBe(false); // trailing newlines are not lines
    expect(isLongRecord(lines(RECORD_OPEN_LINES + 1))).toBe(true);
    // A paragraph wraps: few lines, but long.
    expect(isLongRecord("x".repeat(RECORD_OPEN_CHARS))).toBe(false);
    expect(isLongRecord("x".repeat(RECORD_OPEN_CHARS + 1))).toBe(true);
  });

  test("@gate1 the record states its size", () => {
    expect(recordSize("Weak grip strength\nSlow walking speed\n")).toBe("2 lines · 37 characters");
    expect(recordSize("Income")).toBe("1 line · 6 characters");
    expect(recordSize("x".repeat(1234))).toBe("1 line · 1,234 characters");
  });
});

// --- the screen (static build) ---------------------------------------------------------------------------------

const TRIGGER = "[data-testid='score-panel-toggle']";
const STATUS = "[data-testid='score-strip-status']";

async function openGate1(page: Page): Promise<void> {
  await page.goto(`/run/${PAUSED_JOB}/gate1`);
  await page.waitForLoadState("networkidle");
  await expect(page.locator("[data-testid='ledger']")).toBeVisible();
}

/** Seed the demo's browser sandbox with declaration rows, as a reviewer's earlier Declare left them. */
async function seedDeclaration(page: Page, rows: GateDecision[]): Promise<void> {
  const byItem = Object.fromEntries(rows.map((r) => [decisionItemKey("composite_swap", r), r]));
  await page.addInitScript(
    ([key, state]) => sessionStorage.setItem(key, state),
    [`${SANDBOX_PREFIX}${PAUSED_JOB}`, JSON.stringify({ gateDecisions: { composite_swap: byItem } })] as const,
  );
}

/** Declare through the panel the way a reviewer does: name, components, Declare. */
async function declareThroughPanel(page: Page, scoreName: string, components: string): Promise<void> {
  await page.locator(TRIGGER).click();
  await expect(page.locator("[data-testid='score-panel']")).toBeVisible();
  await page.locator("#score-name").fill(scoreName);
  await page.locator("[data-testid='score-components']").fill(components);
  await page.getByRole("button", { name: "Declare these components" }).click();
  await expect(page.locator("[data-testid='score-component']")).toHaveCount(declaredComponents(components).length);
}

test.describe("score strip on the static build (H4)", () => {
  test("@gate1 nothing declared: the closed strip is still the invitation, charge and all", async ({ page }) => {
    await openGate1(page);
    await expect(page.locator(TRIGGER)).toContainText(STRIP_SUMMARY);
    await expect(page.locator(STATUS)).toHaveCount(0);
    await expect(page.locator("[data-testid='score-strip']")).toHaveAttribute("data-declared", "false");
  });

  test("@gate1 after a declaration the CLOSED strip names the score — and still does after a reload", async ({
    page,
  }) => {
    await openGate1(page);
    await declareThroughPanel(page, SCORE, THREE.join("\n"));
    // Close it again: the claim is about the strip as a returning reviewer meets it, closed.
    await page.locator(TRIGGER).click();
    await expect(page.locator("[data-testid='score-panel']")).toHaveCount(0);
    const want = `${SCORE} · 3 components declared · not matched yet`;
    await expect(page.locator(STATUS)).toHaveText(want);
    await expect(page.locator(TRIGGER)).not.toContainText(STRIP_SUMMARY);
    await expect(page.locator("[data-testid='score-strip']")).toHaveAttribute("data-declared", "true");
    // Screen readers hear it too: the trigger's accessible name carries the status, not only its pixels.
    await expect(page.getByRole("button", { name: `Show the declared-score panel — ${want}` })).toBeVisible();

    await page.reload();
    await page.waitForLoadState("networkidle");
    // Closed by default after a reload, and the status is the persisted declaration's, not component state.
    await expect(page.locator("[data-testid='score-panel']")).toHaveCount(0);
    await expect(page.locator(STATUS)).toHaveText(want);
  });

  test("@gate1 the status keeps the strip ONE line, the how-to strip's height", async ({ page }) => {
    // Long enough that the line cannot fit at 1440px: it must ellipsize, never wrap the strip onto two lines.
    const long = "A frailty index built from the deficit-accumulation model with every domain the paper lists ".repeat(3);
    await seedDeclaration(page, declared(long.trim(), THREE));
    await openGate1(page);
    await expect(page.locator(STATUS)).toBeVisible();
    // Truncated, with the whole line kept as its title.
    const clipped = await page.locator(STATUS).evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(clipped).toBe(true);
    await expect(page.locator(STATUS)).toHaveAttribute("title", `${long.trim()} · 3 components declared · not matched yet`);
    // Compared against the how-to COLLAPSED — it opens by default since 2026-10-06.
    await page.getByRole("button", { name: "Hide how to use this screen" }).click();
    const howto = await page.locator("[data-testid='how-to']").boundingBox();
    const strip = await page.locator("[data-testid='score-strip']").boundingBox();
    expect(Math.abs(strip!.height - howto!.height)).toBeLessThanOrEqual(2);
  });

  test("@gate1 a matched score: the closed strip gives the match state", async ({ page }) => {
    await serveRun(page, (run) => {
      run.composites = [specOf(SCORE, THREE, 2)];
    });
    await seedDeclaration(page, declared(SCORE, THREE));
    await openGate1(page);
    await expect(page.locator(STATUS)).toHaveText(`${SCORE} · 3 components declared · matched: 2 of 3 found`);
  });
});

test.describe("pasted source record on the static build", () => {
  const RECORD = "[data-testid='score-paste-record']";
  const TEXT = "[data-testid='score-paste-text']";
  const TOGGLE = "[data-testid='score-paste-toggle']";
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `Deficit item ${i + 1}`).join("\n");
  /** The record's text EXACTLY — `toHaveText` would normalise the whitespace the record must keep. */
  const exactText = (page: Page) => page.locator(TEXT).evaluate((el) => el.textContent);
  const openPanel = async (page: Page) => {
    await page.locator(TRIGGER).click();
    await expect(page.locator("[data-testid='score-panel']")).toBeVisible();
  };

  test("@gate1 a pasted declaration shows what was entered, read-only, as pasted text — and after a reload", async ({
    page,
  }) => {
    await openGate1(page);
    await declareThroughPanel(page, SCORE, PASTED);
    const record = page.locator(RECORD);
    await expect(record).toBeVisible();
    await expect(record).toContainText(/pasted text/i);
    await expect(record).toContainText("4 lines"); // the blank line the reviewer left counts: it is what was entered
    expect(await exactText(page)).toBe(PASTED);
    // READ-ONLY: a record, not a second place to edit the declaration.
    await expect(page.locator(TEXT)).toHaveJSProperty("tagName", "PRE");
    await expect(record.locator("textarea, input, [contenteditable='true']")).toHaveCount(0);
    // Short: shown whole, nothing to open.
    await expect(page.locator(TOGGLE)).toHaveCount(0);

    await page.reload();
    await page.waitForLoadState("networkidle");
    await openPanel(page);
    // The box is empty again (it is a draft) — so what still shows is the PERSISTED record, not component state.
    await expect(page.locator("[data-testid='score-components']")).toHaveValue("");
    await expect(page.locator(RECORD)).toBeVisible();
    expect(await exactText(page)).toBe(PASTED);
  });

  test("@gate1 a long paste starts collapsed, says its size, and opens on demand — after a reload too", async ({
    page,
  }) => {
    const long = lines(30);
    await openGate1(page);
    await declareThroughPanel(page, SCORE, long);
    const record = page.locator(RECORD);
    await expect(record).toHaveAttribute("data-long", "true");
    await expect(record).toContainText("30 lines");
    await expect(page.locator(TEXT)).toHaveCount(0);
    const toggle = page.locator(TOGGLE);
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(await exactText(page)).toBe(long);
    await toggle.click();
    await expect(page.locator(TEXT)).toHaveCount(0);

    await page.reload();
    await page.waitForLoadState("networkidle");
    await openPanel(page);
    await expect(page.locator(RECORD)).toHaveAttribute("data-long", "true");
    await expect(page.locator(TEXT)).toHaveCount(0);
  });

  test("@gate1 re-declaring with a long paste after a short one starts collapsed, by the NEW text's length", async ({
    page,
  }) => {
    await openGate1(page);
    await declareThroughPanel(page, SCORE, "Weak grip strength");
    await expect(page.locator(RECORD)).toHaveAttribute("data-long", "false");
    await expect(page.locator(TEXT)).toBeVisible();
    // The same score, declared again from a longer paste: the record is the new text, and it is long.
    await page.locator("[data-testid='score-components']").fill(lines(30));
    await page.getByRole("button", { name: "Declare these components" }).click();
    await expect(page.locator(RECORD)).toHaveCount(1);
    await expect(page.locator(RECORD)).toHaveAttribute("data-long", "true");
    await expect(page.locator(TEXT)).toHaveCount(0);
  });

  test("@gate1 the collapse threshold is the document box's: 15 lines fit it unscrolled, 16 would not", async ({
    page,
  }) => {
    await seedDeclaration(page, [
      ...declared(SCORE, ["a"], { source: declarationSource(lines(RECORD_OPEN_LINES), null, 1) }),
      ...declared("SES index", ["b"], { source: declarationSource(lines(RECORD_OPEN_LINES + 1), null, 2) }),
    ]);
    await openGate1(page);
    await openPanel(page);
    const fits = page.locator(`${RECORD}[data-score='${SCORE}']`);
    const over = page.locator(`${RECORD}[data-score='SES index']`);
    await expect(fits).toHaveAttribute("data-long", "false");
    const scrolls = (box: typeof fits) =>
      box.locator(TEXT).evaluate((el) => el.scrollHeight > el.clientHeight);
    expect(await scrolls(fits)).toBe(false);
    await expect(over).toHaveAttribute("data-long", "true");
    await over.locator(TOGGLE).click();
    expect(await scrolls(over)).toBe(true);
    // Two records, so each names its score.
    await expect(fits).toContainText(SCORE);
    await expect(over).toContainText("SES index");
  });

  test("@gate1 a declaration made from a read document leaves no pasted record, and stores no document text", async ({
    page,
  }) => {
    const read = { text: "A frailty index. Table 1: Help Bathing, Help Dressing.", provenance: "searle-2008.pdf", sha256: "a".repeat(64), nChars: 55 };
    await page.route("**/api/harmonize/score/extract", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(read) }),
    );
    await openGate1(page);
    await openPanel(page);
    await page
      .locator("[data-testid='score-upload'] input[type='file']")
      .setInputFiles({ name: "searle-2008.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 stub") });
    await expect(page.locator("[data-testid='score-doc-text']")).toBeVisible();
    await page.locator("[data-testid='score-components']").fill("Help Bathing\nHelp Dressing");
    await page.getByRole("button", { name: "Declare these components" }).click();
    await expect(page.locator("[data-testid='score-component']")).toHaveCount(2);
    await expect(page.locator(RECORD)).toHaveCount(0);
    // What was stored: the document's handle, never its text.
    const held = await page.evaluate((key) => sessionStorage.getItem(key) ?? "", `${SANDBOX_PREFIX}${PAUSED_JOB}`);
    const rows = Object.values(JSON.parse(held).gateDecisions.composite_swap) as { source?: { kind: string } }[];
    expect(rows.map((r) => r.source?.kind)).toEqual(["document", "document"]);
    expect(held).not.toContain(read.text);
  });

  test("@gate1 the record shows beside a matched score, and on a Gate 1 the run has passed", async ({ page }) => {
    await serveRun(page, (run) => {
      run.gatePosition = "gate2";
      run.result!.gatePosition = "gate2";
      run.composites = [specOf(SCORE, THREE, 0)];
      return asOwnedRun(run); // a record only on a run of the reviewer's own — the demo stays open to practise
    });
    await seedDeclaration(page, declared(SCORE, THREE, { source: declarationSource(PASTED, null, 5) }));
    await openGate1(page);
    await expect(page.locator("[data-testid='gate-frozen']")).toBeVisible();
    await openPanel(page);
    await expect(page.locator(RECORD)).toBeVisible();
    expect(await exactText(page)).toBe(PASTED);
  });
});
