import { expect, test, type Locator, type Page } from "@playwright/test";
import { NO_FILTERS, applyFilters } from "@/lib/ledger";
import { cohortInitials, tickedOfShown } from "@/lib/queue-controls";
import type { CoherenceState, ConceptGroup } from "@/types";
import { fixtureGroups } from "./gate1-fixture";
import { serveFinished } from "./gate23-fixture";

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

    // The state tag, then the variable count, under the strip (review round 1 stacked them); the per-row price is gone.
    const facts = row.locator("[data-testid='row-vars']").locator("xpath=..");
    await expect(facts.locator("[data-testid='coherence-mark'] + [data-testid='row-vars']")).toHaveCount(1);
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

// --- review round 1 on the live build (Lavish session 63f9db85f44e22f4) --------------------------------------

test.describe("controls review round 1", () => {
  test("@controls Gate 1's detail pane carries no 'same layout, later gates' note", async ({ page }) => {
    await openGate1(page);
    await expect(page.locator("[data-testid='gate1-detail']")).not.toContainText("Same layout, later gates");
  });

  test("@controls under the strip the state tag comes first and the variable count sits beneath it", async ({ page }) => {
    await openGate1(page);
    const row = rows(page).first();
    const tag = await row.locator("[data-testid='coherence-mark']").boundingBox();
    const vars = await row.locator("[data-testid='row-vars']").boundingBox();
    const strip = await row.locator("[data-testid='cohort-strip']").boundingBox();
    expect(tag!.y).toBeGreaterThanOrEqual(strip!.y + strip!.height - 1);
    expect(vars!.y).toBeGreaterThanOrEqual(tag!.y + tag!.height - 1);
  });

  test("@controls the legend stays over its squares when the list shows a classic scrollbar", async ({ page }) => {
    await openGate1(page);
    // A mouse-driven Mac (or "always show scrollbars") gives the scrolling list a real ~15px gutter. Headless
    // Chromium hides scrollbars outright, so stand in for the gutter with the same width of padding on the list:
    // whatever narrows the list must move the legend with the squares — true only if the legend is IN the list.
    const list = page.locator("[data-testid='gate1-rows']");
    await expect(list.locator("[data-testid='cohort-legend']")).toHaveCount(1);
    await list.evaluate((el) => {
      el.style.paddingRight = "15px";
    });
    const centres = (l: Locator) =>
      l.locator("[data-cohort]").evaluateAll((els) =>
        els.map((e) => {
          const r = e.getBoundingClientRect();
          return Math.round(r.left + r.width / 2);
        }),
      );
    const legend = page.locator("[data-testid='gate1-queue'] [data-testid='cohort-legend']");
    expect(await centres(rows(page).first().locator("[data-testid='cohort-strip']"))).toEqual(await centres(legend));
  });

  test("@controls Gate 4's bar is the same height as the other gates' — its assurance shares the button's row", async ({
    page,
  }) => {
    const height = async (gate: string) => {
      await open(page, `/run/${FINISHED}/${gate}`);
      return page.locator("[data-testid='commit-bar']").evaluate((e) => Math.round(e.getBoundingClientRect().height));
    };
    const g3 = await height("gate3");
    const g4 = await height("gate4");
    await expect(page.locator("[data-testid='commit-assurance']")).toBeVisible();
    expect(g4).toBe(g3);
  });

  test("@controls the spend summary says each fact once, briefly", async ({ page }) => {
    await openGate1(page);
    const sum = page.locator("[data-testid='sum-block']");
    await expect(sum.locator("[data-sum-line='realized']")).toHaveText(/^Spent so far: /);
    await expect(sum.locator("[data-sum-line='in-scope']")).toHaveText(/^0 of \d+ groups ticked · \$[\d.]+ to match at Gate 2$/);
    // Nothing ticked, so the whole-corpus figure is the comparison worth showing.
    await expect(sum.locator("[data-sum-line='whole-corpus']")).toHaveText(/^All \d+ groups: \$[\d.]+$/);
    // With every group ticked the two figures are the same number, so the comparison is dropped.
    await page.locator("[data-testid='bulk-scope-toggle']").click();
    await expect(page.locator("[data-testid='bulk-scope']")).toHaveAttribute("data-state", "all");
    await expect(sum.locator("[data-sum-line='whole-corpus']")).toHaveCount(0);
    expect(((await sum.textContent()) ?? "").length).toBeLessThan(120);
  });

  test("@controls Gate 3 states the recommended-mapping caption once, not on every value-map tile", async ({ page }) => {
    await open(page, `/run/${FINISHED}/gate3`);
    const concepts = page.locator("[data-testid='gate3-concept']");
    const editors = page.locator("[data-testid='gate3-detail'] [data-testid='spec-mapping-editor']");
    // Walk to a concept with two or more value-map tiles.
    for (let i = 0; i < (await concepts.count()) && (await editors.count()) < 2; i++) await concepts.nth(i).click();
    expect(await editors.count()).toBeGreaterThan(1);
    await expect(page.locator("[data-testid='gate3-detail']").getByText(/drag a value to change where it lands/i)).toHaveCount(1);
  });

  test("@controls a Gate 3 recode tile folds, and Approve folds it and says so — after a reload too", async ({ page }) => {
    await open(page, `/run/${FINISHED}/gate3`);
    const tile = page.locator("[data-testid='gate3-detail'] [data-testid='spec-row']").first();
    const fold = tile.locator("[data-testid='spec-collapse']");
    const body = tile.locator("[data-testid='spec-body']");
    await expect(fold).toHaveAttribute("aria-expanded", "true");
    await expect(body).toBeVisible();
    await fold.click();
    await expect(fold).toHaveAttribute("aria-expanded", "false");
    await expect(body).toBeHidden();
    await fold.click();
    await expect(body).toBeVisible();

    const source = await tile.getAttribute("data-source");
    await tile.locator("[data-testid='spec-approve']").click();
    await expect(tile).toHaveAttribute("data-approved", "true");
    await expect(body).toBeHidden();
    await expect(tile.locator("[data-testid='spec-approved-badge']")).toBeVisible();

    await page.reload();
    await page.waitForLoadState("networkidle");
    const again = page.locator(`[data-testid='gate3-detail'] [data-testid='spec-row'][data-source='${source}']`);
    await expect(again).toHaveAttribute("data-approved", "true");
    await expect(again.locator("[data-testid='spec-body']")).toBeHidden();
    // Approval is undone from the folded tile's header.
    await again.locator("[data-testid='spec-unapprove']").click();
    await expect(again).toHaveAttribute("data-approved", "false");
  });
});

test.describe("controls review round 1 — found on the way", () => {
  test("@controls Gate 2 says the concept-match check is off only on a run that left it off", async ({ page }) => {
    const tile = page.locator("[data-testid='not-available'][data-thing='concept-gate']");
    await serveFinished(page, (run) => {
      run.config = { ...(run.config as object), conceptGate: true };
    });
    await open(page, `/run/${FINISHED}/gate2`);
    await expect(page.locator("[data-testid='gate2-detail']")).toBeVisible();
    await expect(tile).toHaveCount(0);
  });
});

test.describe("controls repeated copy (review round 1)", () => {
  test("@controls Gate 3's tiles carry no per-tile instructions; the one explainer names only the editors shown", async ({
    page,
  }) => {
    await open(page, `/run/${FINISHED}/gate3`);
    const detail = page.locator("[data-testid='gate3-detail']");
    const concepts = page.locator("[data-testid='gate3-concept']");
    const n = Math.min(await concepts.count(), 8);
    const repeated = /Numeric target —|Categorical target —|safe default; never fabricates|outside every band → Missing|Entered directly as a number/;
    for (let i = 0; i < n; i++) {
      await concepts.nth(i).click();
      await expect(detail.getByText(repeated)).toHaveCount(0);
      const explainer = detail.locator("[data-testid='value-map-explainer']");
      await expect(explainer).toHaveCount(1);
      const editors = {
        map: await detail.locator("[data-testid='spec-mapping-editor']").count(),
        number: await detail.locator("[data-testid='spec-number-map']").count(),
        bands: await detail.locator("[data-testid='spec-binning']").count(),
      };
      const text = (await explainer.textContent()) ?? "";
      expect(/drag a value/i.test(text)).toBe(editors.map > 0);
      expect(/Missing, never a made-up number/.test(text)).toBe(editors.number > 0);
      expect(/outside every band/.test(text)).toBe(editors.bands > 0);
    }
  });
});

test.describe("controls review round 2 (Gate 3 recode tiles)", () => {
  /** The first tile with all of its actions on show: not approved (Approve hidden) and not rejected (Un-reject instead). */
  async function openTile(page: Page): Promise<Locator> {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, `/run/${FINISHED}/gate3`);
    const tile = page
      .locator("[data-testid='gate3-detail'] [data-testid='spec-row'][data-approved='false'][data-rejected='false']")
      .first();
    await expect(tile.locator("[data-testid='spec-body']")).toBeVisible();
    return tile;
  }

  test("@controls a recode tile's fold arrow sits at the right end of its header", async ({ page }) => {
    // Bhargav: "dropdown arrow should be on the right to match UI convention" — as on every other fold (DisclosureChevron).
    const tile = await openTile(page);
    const fold = (await tile.locator("[data-testid='spec-collapse']").boundingBox())!;
    const box = (await tile.boundingBox())!;
    expect(fold.x, "the arrow is not on the right").toBeGreaterThan(box.x + box.width / 2);
    expect(box.x + box.width - (fold.x + fold.width), "the arrow is not at the tile's right edge").toBeLessThanOrEqual(24);
  });

  test("@controls a recode tile's actions: Approve, Reject, Remove on the left; the note and Save on the right", async ({
    page,
  }) => {
    // Bhargav: "Approve, Reject, Remove should be in that order & left aligned, note field and Save should be on right".
    const tile = await openTile(page);
    const at = async (id: string) => (await tile.locator(`[data-testid='${id}']`).boundingBox())!;
    const [approve, reject, remove, note, save] = [
      await at("spec-approve"),
      await at("spec-reject"),
      await at("spec-remove"),
      await at("spec-note-input"),
      await at("spec-save"),
    ];
    const box = (await tile.boundingBox())!;
    expect(approve.x).toBeLessThan(reject.x);
    expect(reject.x).toBeLessThan(remove.x);
    expect(remove.x + remove.width).toBeLessThan(note.x);
    expect(note.x).toBeLessThan(save.x);
    // One row, pushed to both edges.
    for (const b of [reject, remove, note, save]) expect(Math.abs(b.y + b.height / 2 - (approve.y + approve.height / 2))).toBeLessThanOrEqual(2);
    expect(approve.x - box.x, "Approve is not at the left edge").toBeLessThanOrEqual(20);
    expect(box.x + box.width - (save.x + save.width), "Save is not at the right edge").toBeLessThanOrEqual(20);
  });

  test("@controls Approve carries no tick — a tick reads as already approved", async ({ page }) => {
    // Bhargav: "I dont like the checkmark next to approve, it's confusing - makes it seems like the var has already been approved".
    const tile = await openTile(page);
    await expect(tile.locator("[data-testid='spec-approve']")).toHaveText("Approve");
    await expect(tile.locator("[data-testid='spec-approve'] svg")).toHaveCount(0);
  });

  test("@controls Value mapping is a bordered box, edge-aligned with the inherited panels above it", async ({ page }) => {
    // Bhargav: "I want a rounded border around this like Source variables and chosen target elements, this way the
    // alignment with those 2 elements can also be exact".
    await openTile(page);
    const detail = page.locator("[data-testid='gate3-detail']");
    const box = detail.locator("[data-testid='value-mapping']");
    const g = await geometry(box);
    expect(parseFloat(g.border)).toBeGreaterThanOrEqual(1);
    expect(parseFloat(g.radius)).toBeGreaterThan(0);
    const panel = detail.locator("[data-testid='inherited-source-rows']");
    const [b, p] = [(await box.boundingBox())!, (await panel.boundingBox())!];
    expect(Math.abs(b.x - p.x), "left edges differ").toBeLessThanOrEqual(1);
    expect(Math.abs(b.width - p.width), "widths differ").toBeLessThanOrEqual(1);
    // The heading sits as far in as the panels' labels do.
    const heading = (await box.getByRole("heading", { name: /value mapping/i }).boundingBox())!;
    const label = (await panel.locator("[data-disclosure-label]").boundingBox())!;
    expect(Math.abs(heading.x - b.x - (label.x - p.x)), "the heading's inset differs from the panels'").toBeLessThanOrEqual(1);
  });
});

test.describe("controls review round 3", () => {
  test("@controls the Continue bar keeps a band of ground around it mid-page, like the pinned rail", async ({ page }) => {
    // Bhargav: "i dont like how this box overlaps onto the main panels when i'm mid page. it should keep its separation
    // like the gate rail up top".
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, `/run/${FINISHED}/gate3`);
    const main = page.locator("main");
    await main.evaluate((el) => el.scrollTo(0, Math.max(0, (el.scrollHeight - el.clientHeight) / 2)));
    await page.waitForTimeout(300);
    const band = await page.getByTestId("commit-bar").evaluate((bar) => {
      const r = bar.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const above = document.elementFromPoint(x, r.top - 6);
      const scroller = bar.closest("main")!.getBoundingClientRect();
      return {
        aboveIsBand: !!above?.closest("[data-testid='commit-bar-pin']"),
        below: Math.round(scroller.bottom - r.bottom),
      };
    });
    expect(band.aboveIsBand, "content shows right above the bar").toBe(true);
    expect(band.below, "the bar touches the bottom of the screen").toBeGreaterThanOrEqual(10);
  });

  // Gate 1 on the PAUSED demo: the finished demo's static fixture has no groups at Gate 1.
  for (const [gate, row, run] of [
    ["gate1", "ledger-row", PAUSED],
    ["gate2", "gate2-concept", FINISHED],
    ["gate3", "gate3-concept", FINISHED],
  ] as const) {
    test(`@controls ${gate}: a search highlights what it matched in the queue's names`, async ({ page }) => {
      // Bhargav: "when i search something here, i want the matched text to be highlighted like gmail does".
      await open(page, `/run/${run}/${gate}`);
      const rows = page.locator(`[data-testid='${row}']`);
      await expect(rows.first()).toBeVisible();
      const name = ((await rows.first().getAttribute("data-search-label")) ?? "").trim();
      const word = name.split(/\s+/).find((w) => w.length >= 5) ?? name;
      // A word's first letters: Gate 1 matches the starts of words, Gates 2-3 anywhere — a prefix serves both.
      const term = word.slice(0, 4);
      await page.getByTestId("term-search").fill(term.toUpperCase());
      const hits = page.locator(`[data-testid='${row}'] mark[data-search-hit]`);
      await expect(hits.first()).toBeVisible();
      for (const t of await hits.allTextContents()) expect(t.toLowerCase()).toBe(term.toLowerCase());
      await page.getByTestId("term-search").fill("");
      await expect(page.locator(`[data-testid='${row}'] mark[data-search-hit]`)).toHaveCount(0);
    });
  }

  async function openTile(page: Page): Promise<Locator> {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, `/run/${FINISHED}/gate3`);
    const tile = page
      .locator("[data-testid='gate3-detail'] [data-testid='spec-row'][data-approved='false'][data-rejected='false']")
      .first();
    await expect(tile.locator("[data-testid='spec-body']")).toBeVisible();
    return tile;
  }
  /** A computed colour as [r, g, b], whatever syntax the browser reports it in (rgb(), color(srgb …), oklch …). */
  const rgbOf = (l: Locator) =>
    l.evaluate((el) => {
      const ctx = document.createElement("canvas").getContext("2d")!;
      ctx.fillStyle = getComputedStyle(el).backgroundColor;
      ctx.fillRect(0, 0, 1, 1);
      return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
    });

  test("@controls Approve is shaded green and Reject red", async ({ page }) => {
    const tile = await openTile(page);
    const [ar, ag, ab] = await rgbOf(tile.locator("[data-testid='spec-approve']"));
    expect(ag, "Approve is not green").toBeGreaterThan(ar);
    expect(ag, "Approve is not green").toBeGreaterThan(ab);
    const [rr, rg, rb] = await rgbOf(tile.locator("[data-testid='spec-reject']"));
    expect(rr, "Reject is not red").toBeGreaterThan(rg);
    expect(rr, "Reject is not red").toBeGreaterThan(rb);
  });

  test("@controls the whole header row of a recode tile folds it, not just the arrow", async ({ page }) => {
    // Bhargav: "similar to source variables or how to use this screen, I want dropdown click area to be as wide as the
    // element, not just the arrow".
    const tile = await openTile(page);
    const fold = tile.locator("[data-testid='spec-collapse']");
    const header = tile.locator("[data-testid='spec-row-header']");
    await expect(fold).toHaveAttribute("aria-expanded", "true");
    await header.click({ position: { x: 8, y: 8 } });
    await expect(fold).toHaveAttribute("aria-expanded", "false");
    await header.click({ position: { x: 8, y: 8 } });
    await expect(fold).toHaveAttribute("aria-expanded", "true");
    // The arrow still works on its own — one click, one fold (not two that cancel out).
    await fold.click();
    await expect(fold).toHaveAttribute("aria-expanded", "false");
  });

  test("@controls every recode tile wears the left shading, not only the ones routed to review", async ({ page }) => {
    // Bhargav: "some of these boxes have shading on the left side and others don't, why? i prefer the shading for all".
    await open(page, `/run/${FINISHED}/gate3`);
    const concepts = page.locator("[data-testid='gate3-concept']");
    const tiles = page.locator("[data-testid='gate3-detail'] [data-testid='spec-row']");
    let seen = { review: 0, plain: 0 };
    for (let i = 0; i < Math.min(await concepts.count(), 10); i++) {
      await concepts.nth(i).click();
      for (const t of await tiles.all()) {
        expect(await t.evaluate((el) => getComputedStyle(el).borderLeftWidth)).toBe("4px");
        (await t.getAttribute("data-review")) === "true" ? (seen.review += 1) : (seen.plain += 1);
      }
    }
    expect(seen.plain, "no tile outside review was checked").toBeGreaterThan(0);
  });

  test("@controls Gate 4: the notebook language toggle sits in the notebook's own tile", async ({ page }) => {
    // Bhargav: "move this toggle into/near the notebook export cell".
    await open(page, `/run/${FINISHED}/gate4`);
    const tile = page.locator("[data-testid='artifact-tile'][data-thing='notebook']");
    await expect(page.getByTestId("notebook-language")).toHaveCount(1);
    await expect(tile.getByTestId("notebook-language")).toBeVisible();
    await tile.getByTestId("notebook-lang-r").click();
    await expect(tile.getByTestId("artifact-filename")).toContainText(".r.ipynb");
  });

  test("@controls Gate 4: the export tiles sit two to a row", async ({ page }) => {
    // Bhargav: "so much whitespace, i think we can half the width and have 2 columns".
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, `/run/${FINISHED}/gate4`);
    const set = (await page.getByTestId("export-set").boundingBox())!;
    const tiles = page.locator("[data-testid='export-set'] [data-testid='artifact-tile']");
    const [a, b] = [(await tiles.nth(0).boundingBox())!, (await tiles.nth(1).boundingBox())!];
    expect(Math.abs(a.y - b.y), "the first two tiles are not side by side").toBeLessThanOrEqual(2);
    expect(a.width, "a tile still spans the full width").toBeLessThan(set.width * 0.6);
  });
});

test.describe("controls repeated copy (review round 3)", () => {
  for (const gate of ["gate2", "gate3"] as const) {
    test(`@controls ${gate}: the concept-match check being off is said once, in the how-to — not on every concept`, async ({
      page,
    }) => {
      // Bhargav: "Remove the box from each concept; say it once in the Gate 2 and Gate 3 'How to use this screen'
      // panels. this falls under examples of repetitive text".
      await open(page, `/run/${FINISHED}/${gate}`);
      const concepts = page.locator(`[data-testid='${gate}-concept']`);
      for (let i = 0; i < 2; i++) {
        await concepts.nth(i).click();
        await expect(page.locator("[data-testid='not-available'][data-thing='concept-gate']")).toHaveCount(0);
      }
      const note = page.getByTestId("how-to").getByTestId("how-to-concept-gate");
      await expect(note).toHaveCount(1);
      await expect(note).toBeVisible();
    });
  }

  test("@controls a run that bought the concept-match check says nothing about it in the how-to", async ({ page }) => {
    await serveFinished(page, (run) => {
      run.config = { ...(run.config as object), conceptGate: true };
    });
    await open(page, `/run/${FINISHED}/gate2`);
    await expect(page.getByTestId("how-to")).toBeVisible();
    await expect(page.getByTestId("how-to-concept-gate")).toHaveCount(0);
  });
});

test.describe("controls review round 4", () => {
  /** The first word (≥5 letters) of `text`, cut to its first four — a prefix both search rules find. */
  const termFrom = (text: string) => ((text.split(/[^A-Za-z]+/).find((w) => w.length >= 5) ?? text).slice(0, 4));

  for (const [gate, run] of [
    ["gate2", FINISHED],
    ["gate3", FINISHED],
    ["gate1", PAUSED],
  ] as const) {
    test(`@controls ${gate}: a search also highlights its matches in the open concept's title`, async ({ page }) => {
      // Bhargav: "search highlighting should also extend here: if I search 'physical' then the match in the group name
      // should show highlighted".
      await page.setViewportSize({ width: 1440, height: 900 });
      await open(page, `/run/${run}/${gate}`);
      const title = page.locator(`[data-testid='${gate}-detail'] [data-testid='concept-title']`);
      await expect(title).toBeVisible();
      const term = termFrom((await title.textContent()) ?? "");
      await page.getByTestId("term-search").fill(term);
      await expect(title.locator("mark[data-search-hit]").first()).toBeVisible();
      for (const t of await title.locator("mark[data-search-hit]").allTextContents()) expect(t.toLowerCase()).toBe(term.toLowerCase());
    });
  }

  test("@controls gate1: a search highlights its matches in the variables table too, not only the names", async ({ page }) => {
    // Bhargav: "search highlighting should extend to any field thats being used for retrieval".
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, `/run/${PAUSED}/gate1`);
    const detail = page.getByTestId("gate1-detail");
    const firstName = detail.locator("[data-testid='source-rows'] tbody tr td span.font-mono").first();
    await expect(firstName).toBeVisible();
    const term = termFrom((await firstName.textContent()) ?? "");
    await page.getByTestId("term-search").fill(term);
    await expect(detail.locator("[data-testid='source-rows'] mark[data-search-hit]").first()).toBeVisible();
  });

  test("@controls the queue stays pinned under the rail while the detail scrolls", async ({ page }) => {
    // Bhargav: "during scroll, sidebar should remained pinned but right side panel can move".
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, `/run/${FINISHED}/gate3`);
    const main = page.locator("main");
    await main.evaluate((el) => el.scrollTo(0, 900));
    await expect.poll(() => main.evaluate((el) => el.scrollTop)).toBeGreaterThan(400);
    await page.waitForTimeout(400); // the rail's fold
    const pin = (await page.getByTestId("gate-rail-pin").boundingBox())!;
    const queue = (await page.getByTestId("gate3-queue").boundingBox())!;
    const search = (await page.getByTestId("term-search").boundingBox())!;
    const bar = (await page.getByTestId("commit-bar-pin").boundingBox())!;
    expect(queue.y, "the queue slid under the rail").toBeGreaterThanOrEqual(pin.y + pin.height - 1);
    expect(queue.y, "the queue is not pinned near the top").toBeLessThan(pin.y + pin.height + 24);
    expect(search.y, "the search box is hidden").toBeGreaterThanOrEqual(pin.y + pin.height);
    expect(queue.y + queue.height, "the queue runs under the Continue bar").toBeLessThanOrEqual(bar.y + 1);
  });

  async function rejectFirstTile(page: Page): Promise<Locator> {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, `/run/${FINISHED}/gate3`);
    // A tile with a summary line: a failed recode has none, and the test reads it. Walk the queue to one.
    const withSummary = page.locator(
      "[data-testid='gate3-detail'] [data-testid='spec-row'][data-rejected='false']:has([data-testid='spec-row-summary'])",
    );
    const concepts = page.locator("[data-testid='gate3-concept']");
    for (let i = 0; i < 12 && (await withSummary.count()) === 0; i++) await concepts.nth(i).click();
    const source = await withSummary.first().getAttribute("data-source");
    const tile = page.locator(`[data-testid='gate3-detail'] [data-testid='spec-row'][data-source='${source}']`);
    await tile.locator("[data-testid='spec-reject']").click();
    await page.getByTestId("reject-accept").click();
    await expect(tile).toHaveAttribute("data-rejected", "true");
    return tile;
  }
  const rgbOf = (l: Locator, prop: "backgroundColor" | "borderTopColor" | "color") =>
    l.evaluate((el, p) => {
      const ctx = document.createElement("canvas").getContext("2d")!;
      ctx.fillStyle = getComputedStyle(el)[p];
      ctx.fillRect(0, 0, 1, 1);
      return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
    }, prop);

  test("@controls the 'rejected' tag wears Reject's red", async ({ page }) => {
    // Bhargav: "should match the red color of the reject option".
    const tile = await rejectFirstTile(page);
    const tag = tile.locator("[data-testid='spec-edited-badge']");
    await expect(tag).toHaveText("rejected");
    const [r, g, b] = await rgbOf(tag, "backgroundColor");
    expect(r, "the tag is not red").toBeGreaterThan(g);
    expect(r, "the tag is not red").toBeGreaterThan(b);
  });

  test("@controls a rejected tile says so once: the tag — no dashed border, no 'rejected' in the summary", async ({ page }) => {
    // Bhargav: "when I reject, the cell gets both the reject tag and the dashed line left edge. this is redundant
    // messaging ... the reject tag is enough. keep left side shadow solid".
    const tile = await rejectFirstTile(page);
    const border = await tile.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { top: cs.borderTopStyle, left: cs.borderLeftStyle, leftW: cs.borderLeftWidth };
    });
    expect(border).toEqual({ top: "solid", left: "solid", leftW: "4px" });
    await expect(tile.locator("[data-testid='spec-row-summary']")).toHaveText("not exported");
  });
});
