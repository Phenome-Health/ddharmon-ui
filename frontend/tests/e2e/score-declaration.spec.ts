import { expect, test, type Page } from "@playwright/test";
import { decisionItemKey, optionSetKey, type DecisionIndex, type GateDecision } from "@/lib/gate-decisions";
import { SANDBOX_PREFIX } from "@/lib/sandbox";
import { stripStatus } from "@/lib/score-declaration";
import { STRIP_SUMMARY } from "@/lib/score-proposal";
import { declaredComponents } from "@/lib/score-scope";
import type { CompositeSpec } from "@/types";
import { PAUSED_JOB, serveRun } from "./gate1-fixture";

/**
 * What Gate 1's score panel says about the declaration it holds (phase-8 final review, round 2).
 *
 *  - H4, Bhargav: *"still there — fix now"*: the COLLAPSED score strip gave no hint that a score was already
 *    declared. Closed, it read as the same invitation whether the reviewer had declared 48 components or none.
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
