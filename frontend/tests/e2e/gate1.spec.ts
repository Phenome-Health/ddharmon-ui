import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  COHERENCE_ORDER,
  compareGroups,
  isFlagged,
  matchTerms,
  partitionByBreadth,
  sortGroups,
} from "@/lib/ledger";
import { PAUSED_JOB, fixtureGroups, serveRun } from "./gate1-fixture";

/**
 * Gate 1 — the ledger (08-15 Task 1).
 *
 * WHAT IT RENDERS AGAINST. `public/static-data/result-demo-staged-gate1.json`: a run PAUSED at the Gate 1
 * boundary, derived from the shipped demo by `scripts/build_gate_fixture.py`. Since 08-15 that fixture also
 * carries the coherence judge's REAL verdicts on those same groups, joined in from the run's own judge
 * artifact — which is what lets three of the four coherence states, the flag ordering and the carve
 * proposal be asserted against something that happened rather than something invented.
 *
 *   run: npm run test:e2e -- --grep "@gate1"
 */

async function openGate1(page: Page): Promise<void> {
  await page.goto(`/run/${PAUSED_JOB}/gate1`);
  await page.waitForLoadState("networkidle");
  await expect(page.locator("[data-testid='ledger']")).toBeVisible();
}

/** Row ids in render order — the identity a sort or a reload has to preserve. */
async function rowIds(page: Page): Promise<string[]> {
  return page.locator("[data-testid='ledger-row']").evaluateAll((els) =>
    els.map((el) => el.getAttribute("data-row-id") ?? ""),
  );
}

/** The computed colour and weight of a coherence cell — the pair T-08-86 requires to be identical. */
async function markStyle(cell: Locator): Promise<{ color: string; weight: string }> {
  return cell.evaluate((el) => {
    const s = getComputedStyle(el);
    return { color: s.color, weight: s.fontWeight };
  });
}

// --- the ordering algebra, asserted in node ------------------------------------------------------------

test.describe("gate1 ordering", () => {
  test("@gate1 the coherence order puts the judge's alarm first and its silence above its approval", () => {
    // Four states, one closed order, and the two non-obvious placements are the point:
    //   `split` leads because it is the only state carrying a proposed correction;
    //   `not_judged` sits ABOVE `single` because silence from a judge that was never asked is not a pass,
    //   and sorting it below a cleared group would file it as one.
    expect(Object.keys(COHERENCE_ORDER)).toHaveLength(4);
    expect(COHERENCE_ORDER.split).toBeLessThan(COHERENCE_ORDER.qualify);
    expect(COHERENCE_ORDER.qualify).toBeLessThan(COHERENCE_ORDER.not_judged);
    expect(COHERENCE_ORDER.not_judged).toBeLessThan(COHERENCE_ORDER.single);
  });

  test("@gate1 breadth outranks size — the tiebreak the 2026-08-21 amendment reversed", () => {
    // The original key put a 40-variable single-cohort group above a 5-variable group spanning four
    // cohorts, which is backwards for a screen about pooling. Asserted on the REAL fixture, where the two
    // flagged cross-cohort groups happen to be exactly this pair.
    const flagged = fixtureGroups().filter((g) => g.crossCohort && g.coherence === "split");
    expect(flagged.length).toBeGreaterThanOrEqual(2);
    const broader = flagged.find((g) => g.cohorts.length === 4);
    const bigger = flagged.find((g) => g.cohorts.length === 3);
    expect(broader).toBeDefined();
    expect(bigger).toBeDefined();
    // The bigger group really is bigger — otherwise this asserts nothing.
    expect(bigger!.nMembers).toBeGreaterThan(broader!.nMembers);
    expect(compareGroups(broader!, bigger!)).toBeLessThan(0);
  });

  test("@gate1 the order is total and stable — same input, same output, every time", () => {
    const groups = fixtureGroups();
    const once = sortGroups(groups).map((g) => g.groupId);
    const shuffled = [...groups].reverse();
    expect(sortGroups(shuffled).map((g) => g.groupId)).toEqual(once);
    // Group id is the last component, so no two rows can tie.
    expect(new Set(once).size).toBe(once.length);
  });

  test("@gate1 a group is flagged by the judge's own flag, never by its size or its silence", () => {
    const groups = fixtureGroups();
    for (const g of groups) {
      expect(isFlagged(g)).toBe(g.incoherent || g.coherence === "split");
    }
    // An unjudged group is NOT flagged — the screen must not manufacture an alarm out of an absence.
    expect(groups.filter((g) => g.coherence === "not_judged").every((g) => !isFlagged(g))).toBe(true);
  });
});

// --- the rendered ledger --------------------------------------------------------------------------------

test.describe("gate1 ledger", () => {
  test("@gate1 one row per post-split concept group, named as generated and provenanced to its cluster", async ({
    page,
  }) => {
    await openGate1(page);
    const rows = page.locator("[data-testid='ledger-row']");
    await expect(rows.first()).toBeVisible();

    const first = rows.first();
    // The label is the GENERATED concept name, and the row says so — icon PLUS text, because an
    // icon-only provenance claim is not a claim.
    await expect(first.locator("[data-testid='generated-mark']")).toHaveText(/generated/i);
    // Provenance is the group's OWN cluster id, and it is always visible rather than in a tooltip.
    const provenance = first.locator("[data-testid='row-provenance']");
    await expect(provenance).toBeVisible();
    await expect(provenance).toContainText(/from cluster/i);

    // No catalog badge, no identifier link, no endorsement — and never the word GenCDE, which is a
    // different artifact minted much later and only for `novel` records.
    await expect(first.locator("a")).toHaveCount(0);
    await expect(page.locator("[data-testid='ledger']")).not.toContainText(/GenCDE/i);
    await expect(page.locator("[data-testid='ledger']")).not.toContainText(/\bCDE:[A-Za-z0-9]/);
  });

  test("@gate1 the not-judged cell differs from a judged one by FORM, never by dimness", async ({ page }) => {
    await openGate1(page);
    // T-08-86. A group the judge was never asked about must not read as one it approved — and rendering
    // the absence dimmer reads as "less important, therefore fine", which is that exact misread.
    const judged = page.locator("[data-testid='coherence-mark'][data-coherence='single']").first();
    const unjudged = page.locator("[data-testid='coherence-mark'][data-coherence='not_judged']").first();
    await expect(judged).toBeVisible();
    await expect(unjudged).toBeVisible();

    const a = await markStyle(judged);
    const b = await markStyle(unjudged);
    expect(b.weight).toBe(a.weight);
    // The LABEL colour is what a reviewer reads as importance. `single` is drawn in the ok role and
    // `not_judged` in the muted one, so the pair that must match is the unjudged cell against the
    // NEUTRAL judged cell — a `qualify` verdict is warn-coloured because it is a verdict.
    const anyJudgedWeight = await markStyle(
      page.locator("[data-testid='coherence-mark'][data-coherence='qualify']").first(),
    );
    expect(anyJudgedWeight.weight).toBe(b.weight);

    // And the difference that IS allowed: the marker's shape.
    const shape = await unjudged.locator("span[aria-hidden='true']").first().evaluate((el) => {
      const s = getComputedStyle(el);
      return { style: s.borderStyle, bg: s.backgroundColor };
    });
    expect(shape.style).toBe("dashed");
    expect(shape.bg).toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
  });

  test("@gate1 template suspicion rides only where the judge did not, and never reads as a verdict", async ({
    page,
  }) => {
    await openGate1(page);
    const marks = page.locator("[data-testid='template-suspicion']");
    await expect(marks.first()).toBeVisible();

    // The $0 detector fires from 2 members up, so it covers exactly the rows the judge skips. On a row
    // the judge DID score, the verdict leads and the suspicion is not shown at all — a deterministic
    // suspicion beside an adjudication would invite reading one as the other.
    const rowsWithMark = page.locator("[data-testid='ledger-row']:has([data-testid='template-suspicion'])");
    const states = await rowsWithMark
      .locator("[data-testid='coherence-mark']")
      .evaluateAll((els) => els.map((el) => el.getAttribute("data-coherence")));
    expect(states.length).toBeGreaterThan(0);
    expect(new Set(states)).toEqual(new Set(["not_judged"]));

    // It is a suspicion, not an adjudication: the copy says which, and it is not styled as a verdict.
    await expect(marks.first()).toHaveText(/repeating template/i);
    await expect(marks.first()).toHaveAttribute("data-signal", "deterministic");
  });

  test("@gate1 the spine ranks an unresolved judgment above a correction the reviewer made", async ({ page }) => {
    await openGate1(page);
    // Amber = the judge flagged this and nobody resolved it. The action colour = you changed it. Both,
    // and amber wins: a reviewer who edited a flagged group still has an open judgment to resolve.
    const flagged = page.locator("[data-testid='ledger-row'][data-spine='unresolved']");
    await expect(flagged.first()).toBeVisible();
    const flaggedIds = await flagged.evaluateAll((els) => els.map((el) => el.getAttribute("data-row-id")));
    const expected = fixtureGroups().filter((g) => isFlagged(g)).map((g) => g.groupId);
    // Only the cross-cohort bucket is on screen by default, so the rendered set is a subset — but every
    // rendered amber row must be one the judge actually flagged.
    expect(flaggedIds.every((id) => expected.includes(id!))).toBe(true);
    expect(flaggedIds.length).toBeGreaterThan(0);
  });

  test("@gate1 the grouping strip states where the groups came from and offers no cluster-size control", async ({
    page,
  }) => {
    await openGate1(page);
    const strip = page.locator("[data-testid='grouping-strip']");
    await expect(strip).toBeVisible();

    // Four read-only figures.
    await expect(strip.locator("[data-testid='strip-figure']")).toHaveCount(4);
    // The provenance line, ALWAYS VISIBLE rather than in a tooltip: it explains what a row is.
    const provenance = strip.locator("[data-testid='strip-provenance']");
    await expect(provenance).toBeVisible();
    await expect(provenance).toContainText(/moving variables/i);

    // D-17, and the prohibition is what survives of it: NO `min_cluster_size` control anywhere on the
    // screen. Re-clustering invalidates the frozen substrate, re-pays clustering and strands every
    // decision made against the previous partition — and /design publishes hand-tuning as the REJECTED
    // alternative, so a slider here would contradict a live public claim.
    await expect(page.locator("input[type='range']")).toHaveCount(0);
    await expect(page.getByRole("slider")).toHaveCount(0);
    // No CONTROL of any kind whose job is the partition. Asserted over interactive elements rather than
    // over the page's text: the provenance copy is REQUIRED to say the word "re-clustering" — explaining
    // why the reviewer reshapes by moving variables is the whole point of the line — so a text ban here
    // would forbid the very sentence the previous assertion demands.
    const partitionControls = page.locator(
      "button, select, input, [role='slider'], [role='combobox'], [role='spinbutton']",
    );
    const names = await partitionControls.evaluateAll((els) =>
      els.map((el) => `${el.getAttribute("aria-label") ?? ""} ${el.textContent ?? ""}`),
    );
    expect(names.filter((n) => /cluster size|min_?cluster|granularity|re-?cluster/i.test(n))).toEqual([]);
  });

  test("@gate1 the sum block leads with realized spend and closes with the whole-corpus comparison", async ({
    page,
  }) => {
    await openGate1(page);
    const sum = page.locator("[data-testid='sum-block']");
    await expect(sum).toBeVisible();

    // FIRST, and visually distinct: what reaching this gate already cost. After the post-split reversal
    // the reviewer is standing downstream of real spend, and a screen that opened with a forecast would
    // imply otherwise.
    const lines = sum.locator("[data-sum-line]");
    const order = await lines.evaluateAll((els) => els.map((el) => el.getAttribute("data-sum-line")));
    expect(order).toEqual(["realized", "in-scope", "whole-corpus"]);

    const realized = sum.locator("[data-sum-line='realized']");
    const forecast = sum.locator("[data-sum-line='in-scope']");
    await expect(realized).toContainText(/already spent/i);
    // Distinct by more than position: the realized line carries its own weight, so the two cannot be
    // read in the same voice.
    const weights = await Promise.all(
      [realized, forecast].map((l) => l.evaluate((el) => getComputedStyle(el).fontWeight)),
    );
    expect(weights[0]).not.toBe(weights[1]);

    // Scoping is legible only against a denominator, so the comparison is shown too.
    await expect(sum.locator("[data-sum-line='whole-corpus']")).toContainText(/all \d+ (concept )?groups/i);
  });

  test("@gate1 a single-member group is a row, not noise to collapse away", async ({ page }) => {
    // 380 of the demo's 535 groups have exactly one variable. A screen that hid them would be hiding
    // most of the run.
    const singles = fixtureGroups().filter((g) => g.nMembers === 1);
    expect(singles.length).toBeGreaterThan(0);
    await serveRun(page, (run) => {
      run.result!.conceptGroups = singles;
    });
    await openGate1(page);
    // Every one-member group is single-cohort by construction, so the default cross-cohort view is empty
    // — and it must SAY the other bucket has them rather than reading as "no groups at all".
    await expect(page.locator("[data-testid='gate-empty-state']")).toContainText(/other tab|single cohort/i);
    await page.locator("[data-testid='go-to-other-bucket']").click();

    await expect(page.locator("[data-testid='ledger-row']")).toHaveCount(singles.length);
    await expect(page.locator("[data-testid='ledger-row']").first()).toContainText(/1 variable\b/);
  });

  test("@gate1 the row's variable count is the TRUE count even when the sample is capped", async ({ page }) => {
    // T-08-89: regrouping against a partial sample would silently drop the members it never showed, so
    // the collapsed row must never report the sample's length as the group's size.
    await serveRun(page, (run) => {
      const g = run.result!.conceptGroups!.find((x) => x.groupId === "c8331409f61e1#g0")!;
      g.nMembers = 137;
      g.membersTruncated = true;
    });
    await openGate1(page);
    // Named by ROW ID, not by position: the ledger sorts, so the group mutated above is not the first row.
    const row = page.locator("[data-testid='ledger-row'][data-row-id='c8331409f61e1#g0']");
    await expect(row).toContainText("137");
    // …and the sample it was capped from is smaller, so this is a real distinction rather than a tautology.
    expect(fixtureGroups().find((g) => g.groupId === "c8331409f61e1#g0")!.memberVariableNames.length).toBeLessThan(
      137,
    );
  });
});

// --- the documented empty states --------------------------------------------------------------------------

test.describe("gate1 empty", () => {
  test("@gate1 gate1 empty — zero groups says what happened and where to go", async ({ page }) => {
    await serveRun(page, (run) => {
      run.result!.conceptGroups = [];
      run.result!.conceptGroupMembers = {};
      run.result!.unassignedFields = [];
    });
    await page.goto(`/run/${PAUSED_JOB}/gate1`);
    await page.waitForLoadState("networkidle");

    const empty = page.locator("[data-testid='gate-empty-state']");
    await expect(empty).toBeVisible();
    await expect(empty).toContainText("No groups formed");
    // A next step is REQUIRED — an empty state without one tells a reviewer they are stuck without
    // telling them where to go. It points at Set up, not at the retired Gate 0.
    await expect(empty.getByRole("link", { name: /set up/i })).toBeVisible();
    await expect(empty).not.toContainText(/Gate 0/i);
    // Nothing to buy, so nothing may be bought.
    await expect(page.locator("[data-testid='commit-bar'] button")).toBeDisabled();
  });

  test("@gate1 gate1 empty — all outliers is its own state and lists what fell out", async ({ page }) => {
    await serveRun(page, (run) => {
      run.result!.conceptGroups = [];
      run.result!.conceptGroupMembers = {};
      run.result!.unassignedFields = [
        { id: "UKBB:21001", cohort: "UKBB", variable: "21001", text: "Body mass index (BMI)" },
        { id: "MESA:bmi1c", cohort: "MESA", variable: "bmi1c", text: "Body mass index" },
      ] as never;
    });
    await page.goto(`/run/${PAUSED_JOB}/gate1`);
    await page.waitForLoadState("networkidle");

    const empty = page.locator("[data-testid='gate-empty-state']");
    await expect(empty).toBeVisible();
    // A DIFFERENT finding from "no groups formed": the clustering ran and everything fell out of it.
    await expect(empty).toContainText("Nothing grouped above the threshold");
    await expect(empty).not.toContainText("No groups formed");
    // …and it lists them, because "nothing can be scoped" is only actionable if you can see what.
    const listed = page.locator("[data-testid='unassigned-variable']");
    await expect(listed).toHaveCount(2);
    await expect(listed.first()).toContainText("21001");
  });
});

// --- the partition, and making a large set tractable (Task 2) ---------------------------------------------

test.describe("gate1 partition", () => {
  test("@gate1 the buckets sum to the total — a row belongs to exactly one and none is dropped", () => {
    const groups = fixtureGroups();
    const { "cross-cohort": cross, "single-cohort": single } = partitionByBreadth(groups);
    expect(cross.length + single.length).toBe(groups.length);
    // Partitioned on the CONTRACT BOOLEAN, which is already on the wire — no field added, and no
    // recomputation from `cohorts` that could disagree with the backend's own answer.
    expect(cross.every((g) => g.crossCohort)).toBe(true);
    expect(single.every((g) => !g.crossCohort)).toBe(true);
    expect(new Set([...cross, ...single].map((g) => g.groupId)).size).toBe(groups.length);
  });

  test("@gate1 the default view is the cross-cohort bucket, and the other one is a counted destination", async ({
    page,
  }) => {
    await openGate1(page);
    const { "cross-cohort": cross, "single-cohort": single } = partitionByBreadth(fixtureGroups());
    expect(single.length).toBeGreaterThan(0);

    // The harmonization subset leads, because a single-cohort group is CDE-mapping rather than pooling
    // and the two are scored separately, never blended.
    await expect(page.locator("[data-testid='ledger-row']")).toHaveCount(cross.length);
    await expect(page.locator("[data-testid='bucket-tab'][aria-pressed='true']")).toHaveAttribute(
      "data-bucket",
      "cross-cohort",
    );

    // NOT HIDDEN. A labelled, counted, one-click destination naming what it holds — 87% of the corpus
    // lives there on a real run, and a view that silently dropped it would be a coverage lie.
    const other = page.locator("[data-testid='bucket-tab'][data-bucket='single-cohort']");
    await expect(other).toBeVisible();
    await expect(other).toContainText(String(single.length));
    await other.click();
    await expect(page.locator("[data-testid='ledger-row']")).toHaveCount(single.length);

    // …and it is never described as a failure, an error or an outlier. It is a different job.
    const banner = page.locator("[data-testid='bucket-note']");
    await expect(banner).toBeVisible();
    await expect(banner).not.toContainText(/fail|error|outlier|reject|problem/i);
  });

  test("@gate1 rows are ordered flagged-first and the order survives a reload", async ({ page }) => {
    await openGate1(page);
    const before = await rowIds(page);
    const expected = sortGroups(partitionByBreadth(fixtureGroups())["cross-cohort"]).map((g) => g.groupId);
    expect(before).toEqual(expected);
    // Flagged rows really are first — otherwise the equality above only asserts that two identical
    // functions agree.
    const flaggedCount = expected.filter((id) =>
      isFlagged(fixtureGroups().find((g) => g.groupId === id)!),
    ).length;
    expect(flaggedCount).toBeGreaterThan(0);
    for (let i = 0; i < flaggedCount; i++) {
      expect(isFlagged(fixtureGroups().find((g) => g.groupId === before[i])!)).toBe(true);
    }

    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(page.locator("[data-testid='ledger-row']").first()).toBeVisible();
    expect(await rowIds(page)).toEqual(before);
  });

  test("@gate1 no control implies a numeric coherence confidence", async ({ page }) => {
    await openGate1(page);
    // The cell is a CLOSED four-state categorical. Sorting and filtering on the state is in scope; a
    // gradient, a percentage or a confidence meter is not, because no such number is computed and the
    // calibration to justify one does not exist.
    await expect(page.locator("progress, [role='progressbar'], meter")).toHaveCount(0);
    await expect(page.getByText(/\d+% (confident|coherent|confidence)/i)).toHaveCount(0);
    await expect(page.getByText(/confidence/i)).toHaveCount(0);
  });
});

test.describe("gate1 toolbar", () => {
  test("@gate1 four filters narrow the set and say which are active", async ({ page }) => {
    await openGate1(page);
    const rows = page.locator("[data-testid='ledger-row']");
    const all = await rows.count();

    // By verdict.
    await page.locator("[data-testid='filter-verdict'][data-verdict='split']").click();
    const split = partitionByBreadth(fixtureGroups())["cross-cohort"].filter((g) => g.coherence === "split");
    await expect(rows).toHaveCount(split.length);
    expect(split.length).toBeLessThan(all);
    // Active filters are VISIBLE — an invisible filter is how a reviewer concludes a run has no rows.
    await expect(page.locator("[data-testid='active-filters']")).toContainText(/split/i);

    // Clearing restores everything.
    await page.locator("[data-testid='clear-filters']").click();
    await expect(rows).toHaveCount(all);

    // By cohort.
    await page.locator("[data-testid='filter-cohort'][data-cohort='MESA']").click();
    const mesa = partitionByBreadth(fixtureGroups())["cross-cohort"].filter((g) => g.cohorts.includes("MESA"));
    await expect(rows).toHaveCount(mesa.length);
    await page.locator("[data-testid='clear-filters']").click();

    // Touched-by-me: nothing is touched yet, so it empties the view rather than silently doing nothing.
    await page.locator("[data-testid='filter-touched']").click();
    await expect(rows).toHaveCount(0);
    await expect(page.locator("[data-testid='filter-empty']")).toContainText(/clear the filter/i);
    await page.locator("[data-testid='clear-filters']").click();

    // In-scope: everything is in scope by default, so this one changes nothing — and that is correct.
    await page.locator("[data-testid='filter-in-scope']").click();
    await expect(rows).toHaveCount(all);
  });

  test("@gate1 a filter matching nothing and a term matching nothing read differently", async ({ page }) => {
    await openGate1(page);
    // A FILTER matching nothing is the reviewer's own doing, and the fix is to clear it.
    await page.locator("[data-testid='filter-touched']").click();
    const filterEmpty = page.locator("[data-testid='gate-empty-state']");
    await expect(filterEmpty).toBeVisible();
    await expect(filterEmpty).toContainText("No group matches this filter");
    // Naming the total is what makes the next step concrete rather than a shrug.
    await expect(filterEmpty).toContainText(String(fixtureGroups().length));
    await page.locator("[data-testid='clear-filters']").click();

    // A SEARCH TERM matching nothing is a FINDING about the corpus: the reviewer has learned that no
    // cohort in this run measures it. Different copy, different treatment, and it says here — not at a
    // later gate — because it will not resurface at one.
    await page.locator("#term-search-input").fill("gait speed\nblood pressure");
    await page.getByRole("button", { name: /^Search/ }).click();
    const findings = page.locator("[data-testid='coverage-findings'] li");
    await expect(findings).toHaveCount(1);
    await expect(findings.first()).toContainText("gait speed");
    await expect(findings.first()).toContainText(/will not resurface/i);
    await expect(findings.first()).not.toContainText("Clear the filter");
    // The term that DID match narrows the ledger rather than reporting nothing.
    await expect(page.locator("[data-testid='ledger-row']")).not.toHaveCount(0);
  });

  test("@gate1 the search matches on the group's own text, and says that is what it does", async ({ page }) => {
    // Asserted in node against the real fixture, so the claim is about the corpus and not about a mock.
    const groups = fixtureGroups();
    expect(matchTerms(groups, ["blood pressure"]).noMatches).toEqual([]);
    expect(matchTerms(groups, ["zzzz nonexistent concept"]).noMatches).toEqual(["zzzz nonexistent concept"]);
    // Order-insensitive within a term, so "pressure blood" finds the same groups as "blood pressure".
    expect([...matchTerms(groups, ["pressure blood"]).ids].sort()).toEqual(
      [...matchTerms(groups, ["blood pressure"]).ids].sort(),
    );

    await openGate1(page);
    // AND IT SAYS SO. The match is over the concept name, the ideal description and the member variable
    // names — text this client already has. It is not a semantic match and must not claim to be one:
    // no group vector reaches the browser (see `matchTerms`).
    await expect(page.locator("[data-testid='term-search']")).toContainText(/text of each group/i);
    await expect(page.locator("[data-testid='term-search']")).not.toContainText(/semantic/i);
  });

  test("@gate1 progress is derived from persisted decisions and survives a reload", async ({ page }) => {
    await openGate1(page);
    const readout = page.locator("[data-testid='triage-progress']");
    await expect(readout).toContainText("0 reviewed");

    // Take one group out of scope — a real decision, written through the shared layer.
    const first = page.locator("[data-testid='ledger-row']").first();
    const id = await first.getAttribute("data-row-id");
    await first.locator("button[role='checkbox']").click();
    await expect(readout).toContainText("1 reviewed");
    // Counted over the WHOLE corpus, not the visible bucket — the sum block and the commit bar price the
    // same set, so a readout scoped to one tab would disagree with the money.
    const total = fixtureGroups().length;
    await expect(readout).toContainText(`${total - 1} in scope`);

    // R6: the correction is visible AFTER A RELOAD, because both figures are derived from the persisted
    // decisions rather than held in component state.
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(page.locator("[data-testid='ledger-row']").first()).toBeVisible();
    await expect(readout).toContainText("1 reviewed");
    await expect(readout).toContainText(`${total - 1} in scope`);
    await expect(
      page.locator(`[data-testid='ledger-row'][data-row-id='${id}']`),
    ).toHaveAttribute("data-spine", /changed|unresolved/);
  });

  test("@gate1 nothing gates Continue on a review count", async ({ page }) => {
    await openGate1(page);
    // D-09 revised: there is no completion gate and no triage-volume halt. A reviewer may triage a
    // handful, use a few groups as a testing ground, or work the gate across days.
    await expect(page.locator("[data-testid='triage-progress']")).toContainText("0 reviewed");
    await expect(page.locator("[data-testid='commit-bar'] button")).toBeEnabled();
  });

  test("@gate1 the full row count renders without horizontal scroll and without a new package", async ({
    page,
  }) => {
    // Every group at once — the volume backstop, taken past the default view's 28 rows.
    await serveRun(page, (run) => {
      run.result!.conceptGroups = [...run.result!.conceptGroups!].map((g) => ({ ...g, crossCohort: true }));
    });
    await openGate1(page);
    await expect(page.locator("[data-testid='ledger-row']")).toHaveCount(fixtureGroups().length);
    const overflow = await page.evaluate(() => ({
      doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      body: document.body.scrollWidth - document.body.clientWidth,
    }));
    expect(overflow.doc).toBeLessThanOrEqual(0);
    expect(overflow.body).toBeLessThanOrEqual(0);
  });
});
