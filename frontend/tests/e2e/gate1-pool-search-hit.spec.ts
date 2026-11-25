import { expect, test, type Locator, type Page } from "@playwright/test";
import { matchTerms, matchTermsIn } from "@/lib/ledger";
import { PAUSED_JOB, fixtureGroups, serveRun } from "./gate1-fixture";

/**
 * Gate 1 — "In no group" says when the queue's search has a hit inside it (user test 2026-11-25).
 *
 * Bhargav: *"gate 1 - unless I'm already looking in 'in no group' there's no indication that my search term has a
 * hit in 'in no group'. give the 'in no group' box a yellow outline in the same color of the highlight if there is
 * a search term hit in 'in no group', that way user knows to look there as well"*
 *
 * THE OUTLINE IS THE ONE SIGNAL, and its colour is the search highlight's own — asserted against a REAL highlight
 * mark rendered by the same search, not against a colour value written into the spec.
 *
 * THE MATCH IS THE QUEUE'S OWN RULE (`matchTerms`'s word-prefix, every word of the term), applied to each pooled
 * variable's text, so "hit" means here exactly what it means for a concept group.
 *
 *   run: npm run test:e2e -- tests/e2e/gate1-pool-search-hit.spec.ts
 */

/** A variable the clustering left in no group, worded so its term can hit nothing else in the fixture. */
const POOLED = {
  cohort: "UKBB",
  variable: "quokka_wk",
  text: "Quokka sightings in the past week",
  description: "How many quokkas the participant saw in the past seven days",
};
const POOLED_ID = `${POOLED.cohort}:${POOLED.variable}`;
/** Hits the pooled variable only. */
const POOL_ONLY_TERM = "quokka";
/** Hits concept groups, and not the pooled variable. */
const GROUPS_ONLY_TERM = "blood pressure";

async function openWithPooledVariable(page: Page): Promise<Locator> {
  await serveRun(page, (run) => {
    run.result!.unassignedFields = [{ cohort: POOLED.cohort, variable: POOLED.variable, text: POOLED.text }];
    // A field detail, so the pool renders its evidence grid — whose cells carry the search highlight.
    run.result!.fieldIndex = {
      ...(run.result!.fieldIndex ?? {}),
      [POOLED_ID]: { name: POOLED.variable, text: POOLED.text, description: POOLED.description },
    };
  });
  await page.goto(`/run/${PAUSED_JOB}/gate1`);
  await page.waitForLoadState("networkidle");
  await expect(page.locator("[data-testid='ledger']")).toBeVisible();
  const entry = page.locator("[data-testid='gate1-pool-entry']");
  await expect(entry).toBeVisible();
  return entry;
}

const outlineOf = (el: Locator) =>
  el.evaluate((n) => {
    const s = getComputedStyle(n);
    return { color: s.outlineColor, style: s.outlineStyle, width: s.outlineWidth };
  });

test.describe("gate1 in-no-group search hit", () => {
  test("@gate1 the spec's two terms mean what they claim, by the queue's own matcher", () => {
    // Guards the fixture rather than the screen: if a group ever gained the word "quokka", or the pooled
    // variable a word of "blood pressure", the two screen tests below would be asserting the wrong thing.
    const groups = fixtureGroups();
    expect(matchTerms(groups, [POOL_ONLY_TERM]).ids.size).toBe(0);
    expect(matchTerms(groups, [GROUPS_ONLY_TERM]).ids.size).toBeGreaterThan(0);
    const pooled = [{ id: POOLED_ID, text: [POOLED.variable, POOLED.text, POOLED.description].join(" ") }];
    expect(matchTermsIn(pooled, [POOL_ONLY_TERM]).ids.has(POOLED_ID)).toBe(true);
    expect(matchTermsIn(pooled, [GROUPS_ONLY_TERM]).ids.size).toBe(0);
  });

  test("@gate1 a search hit only in 'In no group' outlines that box in the highlight's colour", async ({ page }) => {
    const entry = await openWithPooledVariable(page);
    const search = page.locator("[data-testid='term-search']");
    await expect(entry).not.toHaveAttribute("data-search-hit", /.*/);

    // THE HIGHLIGHT'S COLOUR, read off a real mark: a term that hits a group marks it in the queue.
    await search.fill(GROUPS_ONLY_TERM);
    const queueMark = page.locator("[data-testid='ledger-row'] mark[data-search-hit]").first();
    await expect(queueMark).toBeVisible();
    const highlight = await queueMark.evaluate((n) => getComputedStyle(n).backgroundColor);

    await search.fill(POOL_ONLY_TERM);
    // The box says so while the reviewer is NOT looking in it — the case the request is about.
    await expect(entry).toHaveAttribute("data-search-hit", "true");
    // Polled: the entry's `transition-colors` fades the outline in from the text colour over ~150ms.
    await expect.poll(async () => (await outlineOf(entry)).color).toBe(highlight);
    const closed = await outlineOf(entry);
    expect(closed.style).not.toBe("none");
    expect(parseFloat(closed.width)).toBeGreaterThan(0);

    // Open, the box shows WHY: the same search marks the variable inside it, in that same colour.
    await entry.click();
    const poolMark = page.locator("[data-testid='unassigned-pool'] mark[data-search-hit]").first();
    await expect(poolMark).toBeVisible();
    expect(await poolMark.evaluate((n) => getComputedStyle(n).backgroundColor)).toBe(highlight);
    // Still true once open, so it still says so.
    await expect(entry).toHaveAttribute("data-search-hit", "true");
    await expect.poll(async () => (await outlineOf(entry)).color).toBe(highlight);
  });

  test("@gate1 a search with no hit in 'In no group' leaves that box unoutlined", async ({ page }) => {
    const entry = await openWithPooledVariable(page);
    await page.locator("[data-testid='term-search']").fill(GROUPS_ONLY_TERM);
    await expect(page.locator("[data-testid='ledger-row']")).not.toHaveCount(0);
    await expect(entry).not.toHaveAttribute("data-search-hit", /.*/);
    expect((await outlineOf(entry)).style).toBe("none");
  });

  test("@gate1 clearing the search takes the 'In no group' outline away", async ({ page }) => {
    const entry = await openWithPooledVariable(page);
    const search = page.locator("[data-testid='term-search']");
    await search.fill(POOL_ONLY_TERM);
    await expect(entry).toHaveAttribute("data-search-hit", "true");

    await search.fill("");
    await expect(entry).not.toHaveAttribute("data-search-hit", /.*/);
    expect((await outlineOf(entry)).style).toBe("none");
  });
});
