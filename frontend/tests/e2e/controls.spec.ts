import { expect, test, type Locator, type Page } from "@playwright/test";
import { NO_FILTERS, applyFilters } from "@/lib/ledger";
import { cohortInitials, tickedOfShown } from "@/lib/queue-controls";
import type { CoherenceState, ConceptGroup } from "@/types";
import { fixtureGroups } from "./gate1-fixture";

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

test.describe("controls queue logic", () => {
  test("@controls cohort initials are two characters, printed once, and never collide", () => {
    // The lab's legend, on the lab's seven-cohort roster.
    expect(cohortInitials(["AI-READI", "AoU", "CLSA", "MESA", "UKBB", "FHS", "PPMI"])).toEqual({
      "AI-READI": "AI",
      AoU: "Ao",
      CLSA: "CL",
      MESA: "ME",
      UKBB: "UK",
      FHS: "FH",
      PPMI: "PP",
    });
    // Two cohorts that would share initials get distinct ones — a legend that repeats itself names nothing.
    const clash = cohortInitials(["UKBB", "UK_imaging", "uk-pilot"]);
    expect(new Set(Object.values(clash)).size).toBe(3);
    for (const v of Object.values(clash)) expect(v).toHaveLength(2);
  });

  test("@controls ticking cohorts keeps the groups that span EVERY ticked cohort", () => {
    const g = (id: string, cohorts: string[]) => ({ groupId: id, cohorts, coherence: "single" }) as ConceptGroup;
    const groups = [g("a", ["CLSA", "UKBB"]), g("b", ["CLSA"]), g("c", ["UKBB", "MESA", "CLSA"]), g("d", ["MESA"])];
    const keep = (cohorts: string[]) =>
      applyFilters(groups, { ...NO_FILTERS, cohorts }, { isTouched: () => false, isInScope: () => false }).map(
        (x) => x.groupId,
      );
    expect(keep([])).toEqual(["a", "b", "c", "d"]);
    expect(keep(["CLSA"])).toEqual(["a", "b", "c"]);
    // CLSA + UKBB asks what those two SHARE — not what either one has.
    expect(keep(["CLSA", "UKBB"])).toEqual(["a", "c"]);
  });

  test("@controls the state filter is several boxes; none ticked shows every state", () => {
    const g = (id: string, coherence: CoherenceState) => ({ groupId: id, cohorts: ["X"], coherence }) as ConceptGroup;
    const groups = [g("s", "split"), g("q", "qualify"), g("n", "not_judged"), g("c", "single")];
    const keep = (verdicts: CoherenceState[]) =>
      applyFilters(groups, { ...NO_FILTERS, verdicts }, { isTouched: () => false, isInScope: () => false }).map(
        (x) => x.groupId,
      );
    expect(keep([])).toEqual(["s", "q", "n", "c"]);
    expect(keep(["split", "not_judged"])).toEqual(["s", "n"]);
  });

  test("@controls select-all counts are ticked of SHOWN, in groups and in variables", () => {
    const shown = [
      { id: "a", vars: 7, on: true },
      { id: "b", vars: 8, on: false },
      { id: "c", vars: 9, on: true },
    ];
    expect(tickedOfShown(shown.map((r) => r.id), (id) => shown.find((r) => r.id === id)!.on, (id) => shown.find((r) => r.id === id)!.vars)).toEqual({
      state: "some",
      groups: { on: 2, shown: 3 },
      vars: { on: 16, shown: 24 },
    });
    expect(tickedOfShown([], () => true, () => 1).state).toBe("none");
  });
});

// --- Gate 1's side panel, with every decision in place -------------------------------------------------------

const ROSTER = ["AI-READI", "AoU", "CLSA", "MESA", "UKBB"];

async function openGate1(page: Page): Promise<void> {
  await open(page, `/run/${PAUSED}/gate1`);
  await expect(page.locator("[data-testid='ledger-row']").first()).toBeVisible();
}

async function openFilters(page: Page): Promise<Locator> {
  const menu = page.locator("[data-testid='filter-menu']");
  if (!(await menu.isVisible())) await page.locator("[data-testid='filter-open']").click();
  await expect(menu).toBeVisible();
  return menu;
}

const rows = (page: Page) => page.locator("[data-testid='gate1-rows'] [data-testid='ledger-row']");

test.describe("controls gate1 panel", () => {
  test("@controls the filters live inside the search box: cohorts first, then the four states", async ({ page }) => {
    await openGate1(page);
    const field = page.locator("[data-testid='term-search']").locator("xpath=..");
    await expect(field.locator("[data-testid='filter-open']")).toBeVisible();
    // No standalone toggle or select left on the toolbar.
    await expect(page.locator("[data-testid='ledger-toolbar'] [role='combobox']")).toHaveCount(0);
    await expect(page.locator("[data-testid='verdict-select']")).toHaveCount(0);

    const menu = await openFilters(page);
    const sections = menu.locator("[role='group']");
    await expect(sections.nth(0)).toHaveAttribute("aria-label", "Cohorts");
    await expect(sections.nth(1)).toHaveAttribute("aria-label", "State");
    const groups = fixtureGroups();
    await expect(menu.locator("[data-testid='cross-cohort-count']")).toHaveText(
      String(groups.filter((g) => g.crossCohort).length),
    );
    // One box per cohort, in the run's own order.
    expect(
      await menu.locator("[data-testid^='filter-cohort-']").evaluateAll((els) => els.map((e) => e.getAttribute("data-testid"))),
    ).toEqual(ROSTER.map((c) => `filter-cohort-${c}`));
    // The four coherence states, each with the count ticking it would keep — no "All states" entry.
    for (const st of ["split", "qualify", "not_judged", "single"] as CoherenceState[]) {
      await expect(menu.locator(`[data-testid='filter-state-${st}-count']`)).toHaveText(
        String(groups.filter((g) => g.coherence === st).length),
      );
    }
    await expect(menu.getByText("All states")).toHaveCount(0);
  });

  test("@controls each ticked filter is a removable chip; Clear restores every group", async ({ page }) => {
    await openGate1(page);
    const groups = fixtureGroups();
    const all = groups.length;
    await expect(rows(page)).toHaveCount(all);
    await expect(page.locator("[data-testid='filter-dot']")).toHaveCount(0);

    const menu = await openFilters(page);
    await menu.locator("[data-testid='filter-state-split']").click();
    await menu.locator("[data-testid='filter-state-not_judged']").click();
    // The menu stays open while several filters are set.
    await expect(menu).toBeVisible();
    const kept = groups.filter((g) => g.coherence === "split" || g.coherence === "not_judged").length;
    await expect(rows(page)).toHaveCount(kept);
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();

    const chips = page.locator("[data-testid='filter-chip']");
    await expect(chips).toHaveCount(2);
    await expect(page.locator("[data-testid='filter-dot']")).toBeVisible();
    await chips.filter({ hasText: "split" }).getByRole("button").click();
    await expect(chips).toHaveCount(1);
    await expect(rows(page)).toHaveCount(groups.filter((g) => g.coherence === "not_judged").length);

    await page.locator("[data-testid='filter-clear']").click();
    await expect(chips).toHaveCount(0);
    await expect(rows(page)).toHaveCount(all);
  });

  test("@controls ticking cohorts keeps the groups that span every one of them", async ({ page }) => {
    await openGate1(page);
    const menu = await openFilters(page);
    await menu.locator("[data-testid='filter-cohort-CLSA']").click();
    await menu.locator("[data-testid='filter-cohort-UKBB']").click();
    const both = fixtureGroups().filter((g) => g.cohorts.includes("CLSA") && g.cohorts.includes("UKBB"));
    expect(both.length).toBeGreaterThan(0);
    await expect(rows(page)).toHaveCount(both.length);
    await expect(page.locator("[data-testid='filter-chip']")).toHaveCount(2);
  });

  test("@controls select all is one three-state box with ticked-of-shown counts", async ({ page }) => {
    await openGate1(page);
    const groups = fixtureGroups();
    const vars = groups.reduce((n, g) => n + g.nMembers, 0);
    const bulk = page.locator("[data-testid='bulk-scope']");
    const box = bulk.locator("[data-testid='bulk-scope-toggle']");
    await expect(bulk).toHaveAttribute("data-state", "none");
    await expect(bulk.locator("[data-testid='bulk-count-groups']")).toHaveText(`0/${groups.length} groups`);
    await expect(bulk.locator("[data-testid='bulk-count-vars']")).toHaveText(`0/${vars} vars`);
    // No sentence, no pair of buttons.
    await expect(page.locator("[data-testid='bulk-scope-in'], [data-testid='bulk-scope-out']")).toHaveCount(0);

    // One row ticked → the box reads "some", as a minus.
    const first = rows(page).first();
    await first.locator("[data-testid='queue-scope']").click();
    await expect(bulk).toHaveAttribute("data-state", "some");
    await expect(box).toHaveAttribute("data-state", "indeterminate");
    await expect(bulk.locator("[data-testid='bulk-count-groups']")).toHaveText(`1/${groups.length} groups`);

    // Pressing it from "some" selects every shown row; pressing it again clears them.
    await box.click();
    await expect(bulk).toHaveAttribute("data-state", "all", { timeout: 30_000 });
    await expect(bulk.locator("[data-testid='bulk-count-vars']")).toHaveText(`${vars}/${vars} vars`);
    await box.click();
    await expect(bulk).toHaveAttribute("data-state", "none", { timeout: 30_000 });

    // The counts are over the SHOWN rows.
    const menu = await openFilters(page);
    await menu.locator("[data-testid='filter-state-split']").click();
    const split = groups.filter((g) => g.coherence === "split");
    await expect(bulk.locator("[data-testid='bulk-count-groups']")).toHaveText(`0/${split.length} groups`);
  });

  test("@controls sort is a segmented control and a direction button, with no Sort label", async ({ page }) => {
    await openGate1(page);
    const sort = page.locator("[data-testid='gate1-queue'] [data-testid='segmented-sort']");
    await expect(sort).toBeVisible();
    await expect(page.locator("[data-testid='gate1-queue']").getByText("Sort", { exact: true })).toHaveCount(0);
    for (const k of ["concept", "verdict", "cohorts", "vars"]) {
      await expect(sort.locator(`[data-testid='sort-${k}']`)).toHaveAttribute("aria-pressed", "false");
    }
    // Before a column is picked the screen's own flag-first order applies, so there is nothing to reverse.
    await expect(sort.locator("[data-testid='sort-direction']")).toBeDisabled();

    await sort.locator("[data-testid='sort-vars']").click();
    await expect(sort.locator("[data-testid='sort-vars']")).toHaveAttribute("aria-pressed", "true");
    const counts = async () =>
      rows(page).locator("[data-testid='row-vars']").evaluateAll((els) => els.map((e) => parseInt(e.textContent ?? "0", 10)));
    const asc = await counts();
    expect(asc).toEqual([...asc].sort((a, b) => a - b));
    await sort.locator("[data-testid='sort-direction']").click();
    const desc = await counts();
    expect(desc).toEqual([...desc].sort((a, b) => b - a));
  });

  test("@controls a row: the name alone on the left; strip, vars and state on the right, under one legend", async ({ page }) => {
    await openGate1(page);
    const legend = page.locator("[data-testid='gate1-queue'] [data-testid='cohort-legend']");
    await expect(legend).toHaveCount(1);
    await expect(legend).toHaveText(ROSTER.map((c) => cohortInitials(ROSTER)[c]).join(""));

    const row = rows(page).first();
    const strip = row.locator("[data-testid='cohort-strip']");
    await expect(strip.locator("[data-cohort]")).toHaveCount(ROSTER.length);
    // Every cell sits under its initial: the strip and the legend share x-centres.
    const centres = (l: Locator) =>
      l.locator("[data-cohort]").evaluateAll((els) => els.map((e) => {
        const r = e.getBoundingClientRect();
        return Math.round(r.left + r.width / 2);
      }));
    expect(await centres(strip)).toEqual(await centres(legend));

    // Vars, then the state tag, under the strip; the per-row price is gone.
    const facts = row.locator("[data-testid='row-vars']").locator("xpath=..");
    await expect(facts.locator("[data-testid='row-vars'] + [data-testid='coherence-mark']")).toHaveCount(1);
    await expect(row.locator("[data-testid='coherence-mark']")).toHaveAttribute("data-variant", "tag");
    await expect(row).not.toContainText("$");
    // The price is said once, under the list.
    await expect(page.locator("[data-testid='sum-block']")).toHaveCount(1);
  });
});

// --- Gates 2 and 3 wear the same panel -----------------------------------------------------------------------

test.describe("controls gates 2-3 panel", () => {
  test("@controls Gate 2: the same search, filter menu, chips, sort and strip — with the verdict as its section", async ({
    page,
  }) => {
    await open(page, `/run/${FINISHED}/gate2`);
    const queue = page.locator("[data-testid='gate2-queue']");
    const rowsG2 = queue.locator("[data-testid='gate2-concept']");
    await expect(rowsG2.first()).toBeVisible();
    const all = await rowsG2.count();
    await expect(page.locator("[data-testid='verdict-select']")).toHaveCount(0);
    await expect(queue.locator("[data-testid='cohort-legend']")).toHaveCount(1);
    await expect(queue.locator("[data-testid='segmented-sort']")).toBeVisible();
    await expect(rowsG2.first().locator("[data-testid='cohort-strip']")).toBeVisible();
    await expect(rowsG2.first().locator("[data-testid='verdict-pill']")).toHaveAttribute("data-variant", "tag");

    const menu = await openFilters(page);
    await expect(menu.locator("[role='group']").nth(0)).toHaveAttribute("aria-label", "Cohorts");
    await expect(menu.locator("[role='group']").nth(1)).toHaveAttribute("aria-label", "Verdict");
    await menu.locator("[data-testid='filter-verdict-adopt']").click();
    await page.keyboard.press("Escape");
    const adopts = await rowsG2.count();
    expect(adopts).toBeLessThan(all);
    expect(
      await rowsG2.locator("[data-testid='verdict-pill']").evaluateAll((els) => [...new Set(els.map((e) => e.getAttribute("data-verdict")))]),
    ).toEqual(["adopt"]);
    await expect(page.locator("[data-testid='filter-chip']")).toHaveCount(1);
    await page.locator("[data-testid='filter-clear']").click();
    await expect(rowsG2).toHaveCount(all);
  });

  test("@controls Gate 3: the same panel, with arithmetic recodes as its filter", async ({ page }) => {
    await open(page, `/run/${FINISHED}/gate3`);
    const queue = page.locator("[data-testid='gate3-queue']");
    await expect(queue.locator("[data-testid='gate3-concept']").first()).toBeVisible();
    await expect(queue.locator("[data-testid='cohort-legend']")).toHaveCount(1);
    await expect(queue.locator("[data-testid='gate3-concept']").first().locator("[data-testid='cohort-strip']")).toBeVisible();
    const menu = await openFilters(page);
    await expect(menu.locator("[role='group']").nth(0)).toHaveAttribute("aria-label", "Cohorts");
    await expect(menu.locator("[data-testid='arithmetic-filter']")).toBeVisible();
  });
});

test.describe("controls how-to copy", () => {
  test("@controls Gate 1's how-to names the controls the panel actually has", async ({ page }) => {
    await openGate1(page);
    const howTo = page.locator("[data-testid='how-to']");
    // The totals line and the standalone cross-cohort toggle are gone: the counts ride the select-all box and
    // the narrowing lives in the filters inside the search.
    await expect(howTo).toContainText("select-all box");
    await expect(howTo).toContainText("filters in the search box");
    // The search is one line; "one term per line" described the multi-term box 08-16f removed.
    await expect(howTo).not.toContainText("one term per line");
  });
});
