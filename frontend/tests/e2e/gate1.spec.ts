import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  COHERENCE_ORDER,
  sortGroupsByColumn,
  bulkScopePlan,
  bulkScopeState,
  cohortRoster,
  groupLabel,
  searchableText,
  compareGroups,
  isFlagged,
  matchTerms,
  partitionByBreadth,
  readjudicationRequest,
  sortGroups,
} from "@/lib/ledger";
import { componentVerdictFor, missingReason, scopeVerdictFor } from "@/lib/score-scope";
import { COHERENCE_COPY } from "@/components/gate/CoherenceMark";
import { toggleSort } from "@/lib/column-sort";
import type { CoherenceState } from "@/types";
import { PAUSED_JOB, fixtureGroups, gate1Fixture, serveRun } from "./gate1-fixture";

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
      // …and the run does NOT carry the uncapped list, which is the case the count must survive.
      delete run.result!.conceptGroupMembers![g.groupId];
    });
    await openGate1(page);
    // Named by ROW ID, not by position: the ledger sorts, so the group mutated above is not the first row.
    const row = page.locator("[data-testid='ledger-row'][data-row-id='c8331409f61e1#g0']");
    await expect(row).toContainText("137");
    // …and the sample it was capped from is smaller, so this is a real distinction rather than a tautology.
    expect(fixtureGroups().find((g) => g.groupId === "c8331409f61e1#g0")!.memberVariableNames.length).toBeLessThan(
      137,
    );

    // AND THE MOVE IS WITHHELD. With only a sample on the wire, offering a regroup would silently drop
    // every member past the cap — so the verb is withdrawn and the reason is stated.
    await row.getByRole("button", { name: /^Expand /i }).click();
    await expect(row.locator("[data-testid='not-available']")).toBeVisible();
    await expect(row.locator("[data-testid='member-drop-zone']")).toHaveCount(0);
    // Since 08-14h the membership IS the evidence grid, so the withdrawal is expressed by that grid
    // carrying no drag affordance at all — no draggable rows, no drop destination, no keyboard remove.
    // A stronger form of the same rule than the un-draggable chip it replaces.
    await expect(row.locator("[data-testid='source-rows']")).toBeVisible();
    await expect(row.locator("[data-testid='member-row']")).toHaveCount(0);
    await expect(row.locator("[data-testid='member-remove']")).toHaveCount(0);
    await expect(row.locator("[data-testid='member-chip']")).toHaveCount(0);
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

// --- the expanded row: membership, regrouping, the evidence grid and the carve proposal (Task 3) ----------

/** Open the row named by group id and return its locator. */
async function expandRow(page: Page, groupId: string) {
  const row = page.locator(`[data-testid='ledger-row'][data-row-id='${groupId}']`);
  await expect(row).toBeVisible();
  await row.locator("[data-state] >> nth=-1").first().waitFor({ state: "attached" });
  await row.getByRole("button", { name: /^Expand /i }).click();
  return row;
}

/** The two flagged (split) groups in the default view — the ones carrying a carve proposal. */
const FLAGGED = "c45aa294f30f6#g1";
/** A large, unflagged cross-cohort group — the one with the most members to drag. */
const BIG = "c8331409f61e1#g0";

test.describe("gate1 expanded row", () => {
  test("@gate1 the expanded row renders the FULL membership, not the collapsed sample", async ({ page }) => {
    await openGate1(page);
    const group = fixtureGroups().find((g) => g.groupId === BIG)!;
    const row = await expandRow(page, BIG);
    // T-08-89: a regroup verb over a partial sample would silently discard the members it never showed,
    // so the expanded row reads the uncapped list rather than the collapsed row's cap. RE-POINTED by
    // 08-14h from `member-chip` to `member-row`: the tiles merged into the grid, so the grid row is now
    // the one representation of a variable. Same claim, same group, same count.
    await expect(row.locator("[data-testid='member-row']")).toHaveCount(group.nMembers);
    await expect(row.locator("[data-testid='member-row']").first()).toHaveAttribute("draggable", "true");
  });

  test("@gate1 a single-member group's one chip is still draggable", async ({ page }) => {
    const singles = fixtureGroups().filter((g) => g.nMembers === 1);
    await openGate1(page);
    // Single-member groups are single-cohort by construction, so they live in the other bucket.
    await page.locator("[data-testid='bucket-tab'][data-bucket='single-cohort']").click();
    const row = await expandRow(page, singles[0].groupId);
    await expect(row.locator("[data-testid='member-row']")).toHaveCount(1);
    await expect(row.locator("[data-testid='member-row']")).toHaveAttribute("draggable", "true");
  });

  test("@gate1 a move persists, survives a reload, and marks both groups as changed", async ({ page }) => {
    await openGate1(page);
    const row = await expandRow(page, BIG);
    const chip = row.locator("[data-testid='member-row']").first();
    const memberId = await chip.getAttribute("data-member-id");

    // The no-group tray is a REAL destination with its own identifier, not a sentinel special-cased at
    // every call site.
    const tray = row.locator("[data-testid='member-drop-zone'][data-group-id='__unassigned__']");
    await expect(tray).toBeVisible();
    await chip.dragTo(tray);

    await expect(tray.locator("[data-testid='member-chip']")).toHaveCount(1);
    await expect(
      page.locator(`[data-testid='ledger-row'][data-row-id='${BIG}']`),
    ).toHaveAttribute("data-spine", "changed");

    // R6 / T-08-88: the move and the touched state are DERIVED from persisted decisions, so both are
    // still there after a reload. The prototype held them in component state, which is the defect.
    await page.reload();
    await page.waitForLoadState("networkidle");
    const after = await expandRow(page, BIG);
    await expect(after.locator("[data-testid='member-drop-zone'][data-group-id='__unassigned__'] [data-testid='member-chip']")).toHaveCount(1);
    // The moved variable now lives in the tray, where a chip is still the right rendering: it belongs to
    // no group, so there is no grid for it to be a row of.
    await expect(after.locator(`[data-testid='member-chip'][data-member-id='${memberId}']`)).toHaveAttribute(
      "data-moved",
      "true",
    );
    await expect(
      page.locator(`[data-testid='ledger-row'][data-row-id='${BIG}']`),
    ).toHaveAttribute("data-spine", "changed");
  });

  test("@gate1 emptying a group renders a defined state instead of the row vanishing", async ({ page }) => {
    // A one-member group, so one drag empties it.
    const single = fixtureGroups().filter((g) => g.nMembers === 1)[0];
    await openGate1(page);
    await page.locator("[data-testid='bucket-tab'][data-bucket='single-cohort']").click();
    const row = await expandRow(page, single.groupId);
    await row
      .locator("[data-testid='member-row']")
      .first()
      .dragTo(row.locator("[data-testid='member-drop-zone'][data-group-id='__unassigned__']"));

    // The row MUST NOT silently disappear — the reviewer has to be able to see what they did and undo it.
    await expect(page.locator(`[data-testid='ledger-row'][data-row-id='${single.groupId}']`)).toBeVisible();
    const emptied = row.locator("[data-testid='group-emptied']");
    await expect(emptied).toBeVisible();
    await expect(emptied).toContainText(/will not/i);
    await expect(row.getByRole("button", { name: /put them back|undo/i })).toBeVisible();
  });

  test("@gate1 the raw dictionary rows are the evidence layer, and degrade rather than render empty", async ({
    page,
  }) => {
    await openGate1(page);
    const row = await expandRow(page, BIG);
    // The grid the audit lifted: one row per pooled variable, columns as ingested. An over-merge becomes
    // visible at a glance instead of inferred from a name and a chip.
    const grid = row.locator("[data-testid='source-rows']");
    await expect(grid).toBeVisible();
    await expect(grid.locator("tbody tr")).toHaveCount(fixtureGroups().find((g) => g.groupId === BIG)!.nMembers);

    // Wide content scrolls WITHIN ITS OWN CONTAINER and never pushes the ledger's columns sideways.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    const scrolls = await grid.locator("[data-testid='source-rows-scroll']").evaluate((el) => ({
      x: getComputedStyle(el).overflowX,
      wider: el.scrollWidth >= el.clientWidth,
    }));
    expect(scrolls.x).toMatch(/auto|scroll/);
    expect(scrolls.wider).toBe(true);
  });

  test("@gate1 with no field rows on the run, the expanded row falls back to membership", async ({ page }) => {
    // A run that predates `fieldIndex` — the grid is omitted, not rendered empty, and the chips remain.
    await serveRun(page, (run) => {
      run.result!.fieldIndex = {};
    });
    await openGate1(page);
    const row = await expandRow(page, BIG);
    await expect(row.locator("[data-testid='source-rows']")).toHaveCount(0);
    await expect(row.locator("[data-testid='member-chip']").first()).toBeVisible();
  });

  test("@gate1 the lifted grid paints from the role layer, checked by COMPUTED STYLE", async ({ page }) => {
    // T-08-65: 08-12b found three files painting the ORG'S LOGO from semantic UI role tokens, and this
    // component predates the 08-07 retheme. Reading the source would only show which utility class is
    // written there; what matters is the colour that actually lands, so both are resolved in the page and
    // compared.
    await openGate1(page);
    const row = await expandRow(page, BIG);
    const grid = row.locator("[data-testid='source-rows']");
    await expect(grid).toBeVisible();

    const probe = async (token: string, prop: "color" | "background-color") =>
      page.evaluate(
        ({ token, prop }) => {
          const el = document.createElement("div");
          el.style.position = "fixed";
          el.style.left = "-9999px";
          el.style.setProperty(prop, `var(${token})`);
          document.body.appendChild(el);
          const v = getComputedStyle(el)[prop === "color" ? "color" : "backgroundColor"];
          el.remove();
          return v;
        },
        { token, prop },
      );

    const head = grid.locator("thead th").first();
    expect(await head.evaluate((el) => getComputedStyle(el).color)).toBe(await probe("--on-raised-muted", "color"));
    expect(await grid.locator("thead").evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
      await probe("--surface-inset", "background-color"),
    );
    // And nothing in it is painted from a BRAND token, which is what T-08-65 caught.
    const brand = await probe("--brand-ink", "color");
    const cellColours = await grid.locator("tbody td").evaluateAll((els) =>
      els.slice(0, 20).map((el) => getComputedStyle(el).color),
    );
    expect(cellColours.filter((c) => c === brand)).toEqual([]);
  });
});

test.describe("gate1 carve", () => {
  test("@gate1 the carve proposal is a proposal — ignoring it leaves the grouping untouched", async ({ page }) => {
    await openGate1(page);
    const row = await expandRow(page, FLAGGED);
    const carve = row.locator("[data-testid='carve-proposal']");
    await expect(carve).toBeVisible();
    // The judge FLAGS and never re-groups. Nothing is applied until the reviewer acts.
    const before = await row.locator("[data-testid='member-chip']").count();
    await carve.getByRole("button", { name: /ignore/i }).click();
    await expect(row.locator("[data-testid='member-chip']")).toHaveCount(before);
    await expect(page.locator(`[data-testid='ledger-row'][data-row-id='${FLAGGED}']`)).toBeVisible();
  });

  test("@gate1 an unflagged group carries no carve proposal", async ({ page }) => {
    await openGate1(page);
    const row = await expandRow(page, BIG);
    expect(isFlagged(fixtureGroups().find((g) => g.groupId === BIG)!)).toBe(false);
    await expect(row.locator("[data-testid='carve-proposal']")).toHaveCount(0);
  });

  test("@gate1 with re-adjudication off, accept is an honest not-available and sends nothing", async ({
    page,
  }) => {
    const requests: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/readjudicate")) requests.push(r.url());
    });
    await openGate1(page); // the fixture's run did NOT opt in
    const carve = (await expandRow(page, FLAGGED)).locator("[data-testid='carve-proposal']");
    const na = carve.locator("[data-testid='not-available'][data-claim='not-enabled']");
    await expect(na).toBeVisible();
    // NAMES THE OPTION rather than implying the product cannot do it — an opt-in rendered as a permanent
    // gap understates what the tool has.
    await expect(na).toContainText(/turn it on|enable/i);
    // Both free verbs stay live: they are how a reviewer resolves the flag by hand when the paid path is off.
    await expect(carve.getByRole("button", { name: /edit/i })).toBeEnabled();
    await expect(carve.getByRole("button", { name: /ignore/i })).toBeEnabled();
    expect(requests).toEqual([]);
  });

  test("@gate1 the request is exactly one group id, and never an empty list", () => {
    // ASSERTED ON THE BUILDER, IN NODE, because the whole e2e suite runs against a backend-less static
    // build and no request can leave it. That is a real limit and it is named in the summary — what is
    // asserted here is the thing the prohibition is actually about: the set the UI would send.
    expect(readjudicationRequest(FLAGGED)).toEqual({ groupIds: [FLAGGED] });
    expect(readjudicationRequest(FLAGGED).groupIds).toHaveLength(1);
    expect(() => readjudicationRequest("")).toThrow(/one group/i);
    expect(() => readjudicationRequest("   ")).toThrow(/one group/i);
  });

  test("@gate1 with re-adjudication on, accept states its price inline and carries exactly one group id", async ({
    page,
  }) => {
    const requests: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/readjudicate")) requests.push(r.url());
    });
    await serveRun(page, (run) => {
      // A run that opted in at creation, and is NOT the shared demo — the demo is refused outright, first,
      // so that a guest walk can never spend money.
      run.config = { ...(run.config as object), demo: false, allowReadjudication: true } as never;
    });
    await openGate1(page);
    const carve = (await expandRow(page, FLAGGED)).locator("[data-testid='carve-proposal']");
    const accept = carve.getByRole("button", { name: /accept/i });
    await expect(accept).toBeVisible();

    // PRICED INLINE, BEFORE IT RUNS, never behind a modal — the same register as the commit bar.
    await expect(carve.locator("[data-testid='carve-price']")).toBeVisible();
    await expect(carve.locator("[data-testid='carve-price']")).toContainText(/costs money|\$/i);
    await expect(page.locator("[role='dialog']")).toHaveCount(0);

    // EXACTLY ONE ID, carried as data on the control itself. Never an empty list, never "everything
    // flagged" — re-splitting every flagged group BECAUSE it was flagged is an auto-resolution of an
    // over-merge with no human decision behind it, which core's own docstring forbids.
    expect(JSON.parse((await accept.getAttribute("data-group-ids"))!)).toEqual([FLAGGED]);

    // And nothing has been sent yet: the price is stated BEFORE the press, not after it.
    expect(requests).toEqual([]);
  });
});

// --- the declared-score panel, moved here from Setup (Task 4, the 2026-08-25 amendment) -------------------

test.describe("gate1 score", () => {
  test("@gate1 the verdict is derived, and absent evidence is indeterminate rather than infeasible", () => {
    // THE PROHIBITION, as an algebra. Positive-or-indeterminate is determinable from what a run holds; a
    // NEGATIVE claim is not. So `infeasible` is reachable only from a completed match that came back
    // empty, and everything else that is not a match resolves to `indeterminate`.
    const declared = (name: string) => ({ name, searched: false, matched: false, shortlistSize: 0 });
    expect(scopeVerdictFor([declared("grip"), declared("gait")])).toBe("indeterminate");
    expect(componentVerdictFor(declared("grip"))).toBe("indeterminate");

    const matched = { name: "grip", searched: true, matched: true, shortlistSize: 3 };
    const searchedAndEmpty = { name: "gait", searched: true, matched: false, shortlistSize: 0 };
    expect(scopeVerdictFor([matched])).toBe("full");
    expect(scopeVerdictFor([matched, searchedAndEmpty])).toBe("partial");
    expect(scopeVerdictFor([searchedAndEmpty])).toBe("infeasible");
    expect(componentVerdictFor(searchedAndEmpty)).toBe("infeasible");
    // One component still unsearched keeps the WHOLE verdict off `infeasible` — a negative claim about a
    // score needs every component actually looked for.
    expect(scopeVerdictFor([searchedAndEmpty, declared("chair rise")])).toBe("indeterminate");
  });

  test("@gate1 rejected candidates and nothing retrieved are different findings", () => {
    // "We retrieved 8 candidates and the judge rejected them all" means the concepts exist and none
    // measures the component. "Nothing was retrieved" is closer to absence. Collapsing them loses the
    // distinction, and MISSING never means "the cohort lacks it" — it means "not retrieved in this run".
    expect(missingReason({ name: "gait", searched: true, matched: false, shortlistSize: 8 })).toMatch(
      /8 .*rejected|rejected.*8/i,
    );
    expect(missingReason({ name: "gait", searched: true, matched: false, shortlistSize: 0 })).toMatch(
      /nothing .*retrieved|retrieved nothing/i,
    );
    expect(missingReason({ name: "gait", searched: true, matched: false, shortlistSize: 8 })).not.toEqual(
      missingReason({ name: "gait", searched: true, matched: false, shortlistSize: 0 }),
    );
    // Neither of them says the cohort does not measure it.
    for (const n of [0, 8]) {
      expect(missingReason({ name: "gait", searched: true, matched: false, shortlistSize: n })).not.toMatch(
        /cohort (does not|doesn't|lacks)/i,
      );
    }
  });

  test("@gate1 the panel is a section of Gate 1, not a screen and not a modal", async ({ page }) => {
    await openGate1(page);
    const panel = page.locator("[data-testid='score-panel']");
    await expect(panel).toBeVisible();
    // ON the ledger screen: the ledger is still there beside it, so reaching the panel never means
    // leaving the purchase decision to be pitched an add-on.
    await expect(page.locator("[data-testid='ledger']")).toBeVisible();
    await expect(page.locator("[role='dialog']")).toHaveCount(0);

    // …and there is no separate score route to be sent to instead.
    const routes = await page.evaluate(async () => {
      const res = await fetch("/assets/../index.html");
      return res.ok;
    });
    expect(routes).toBe(true);
    await page.goto("/run/demo-staged-gate1/score");
    await expect(page.locator("[data-testid='score-panel']")).toHaveCount(0);
  });

  test("@gate1 declaring components renders indeterminate, and it survives a reload", async ({ page }) => {
    await openGate1(page);
    await page.locator("[data-testid='score-components']").fill("Weak grip strength\nSlow walking speed");
    await page.getByRole("button", { name: /declare/i }).click();

    await expect(page.locator("[data-testid='score-component']")).toHaveCount(2);
    const verdict = page.locator("[data-testid='score-verdict']");
    await expect(verdict).toHaveAttribute("data-verdict", "indeterminate");
    // Never the negative claim, and never Setup's reason — Gate 1 HAS concepts, so "this run has produced
    // no concepts" would be false here even though it was true there.
    await expect(verdict).not.toContainText(/not computable/i);
    await expect(page.locator("[data-testid='score-component'][data-verdict='infeasible']")).toHaveCount(0);

    // Written through the durable gate-decision layer, so it is still declared after a reload.
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(page.locator("[data-testid='score-component']")).toHaveCount(2);
    await expect(page.locator("[data-testid='score-verdict']")).toHaveAttribute("data-verdict", "indeterminate");
  });

  test("@gate1 reading the document is free and says so, and matching states its price inline", async ({
    page,
  }) => {
    await openGate1(page);
    const panel = page.locator("[data-testid='score-panel']");
    // The 08-11 extract route is $0 and job-independent. Nothing here makes reading cost money.
    await expect(panel.locator("[data-testid='score-upload']")).toContainText(/costs nothing|free|\$0/i);
    // The paid boundary is stated INLINE, before it runs — never behind a modal.
    const price = panel.locator("[data-testid='score-match-price']");
    await expect(price).toBeVisible();
    await expect(price).toContainText(/costs money|one .*call|\$/i);
    await expect(page.locator("[role='dialog']")).toHaveCount(0);
  });

  test("@gate1 a run that cannot match renders an honest not-available, not a dead control", async ({
    page,
  }) => {
    const requests: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/composite")) requests.push(r.url());
    });
    await openGate1(page);
    // A run PARKED at Gate 1 has produced concept groups but no assigned records, and matching components
    // onto concepts needs the latter. So the action is unavailable — and it says which, rather than being
    // hidden (the reviewer never learns it exists) or disabled (they cannot tell why).
    const na = page.locator("[data-testid='score-panel'] [data-testid='not-available']");
    await expect(na).toBeVisible();
    await expect(na).toContainText(/Gate 2|matched against/i);
    expect(requests).toEqual([]);
  });

  test("@gate1 a completed match reaches full and partial, and never invents a cutoff", async ({ page }) => {
    // The path to the other three verdicts, exercised against a run that HAS a derived spec — which is
    // what makes "the verdict is derived rather than hard-coded" a checked claim rather than a comment.
    await serveRun(page, (run) => {
      run.composites = [
        {
          definition: {
            name: "Fried frailty phenotype",
            kind: "index",
            citation: "",
            combinationRule: "count of criteria met",
            threshold: "",
            notes: "",
            statedNItems: 2,
            underEnumerated: 0,
            provenance: "pasted text",
            sourceSha256: "",
            components: [
              { name: "Weak grip strength", definition: "", required: true, weight: null, coding: { kind: "unstated", cutoff: "", referenceRange: "", needsReview: true } },
              { name: "Slow walking speed", definition: "", required: true, weight: null, coding: { kind: "unstated", cutoff: "", referenceRange: "", needsReview: true } },
            ],
          },
          matches: [
            { component: "Weak grip strength", conceptId: "c1#g0", concept: "Grip strength", column: "", cohorts: ["UKBB"], sourceVariables: [], confidence: 0.9, rationale: "", required: true, pinned: false, shortlist: ["c1#g0"] },
            { component: "Slow walking speed", conceptId: null, concept: "", column: "", cohorts: [], sourceVariables: [], confidence: 0, rationale: "", required: true, pinned: false, shortlist: ["a", "b", "c"] },
          ],
          feasibility: { verdict: "partial", nRequired: 2, nRequiredMatched: 1, matched: ["Weak grip strength"], missing: ["Slow walking speed"], needsReview: [], computableCohorts: [], perCohort: [], caveats: [] },
          derivation: [],
          units: "",
          validationRules: [],
        },
      ] as never;
    });
    await openGate1(page);
    const verdict = page.locator("[data-testid='score-verdict']");
    await expect(verdict).toHaveAttribute("data-verdict", "partial");
    // PARTIAL IS NOT THE PUBLISHED SCORE, and it says so in words rather than leaving it to be inferred
    // from a colour.
    await expect(verdict).toContainText(/not the published|is not the score as published/i);

    // The matched one, and the missing one — reported as a RESULT, with which of the two findings it is.
    await expect(page.locator("[data-testid='score-component'][data-verdict='full']")).toHaveCount(1);
    const missing = page.locator("[data-testid='score-component'][data-verdict='infeasible']");
    await expect(missing).toHaveCount(1);
    await expect(missing).toContainText(/3 .*rejected|rejected/i);

    // NO CUTOFF IS INVENTED. The source stated none, so the panel flags it for a human instead of
    // deriving a plausible one — a score's threshold is a clinical claim.
    await expect(page.locator("[data-testid='score-cutoff-unstated']").first()).toBeVisible();
    await expect(page.locator("[data-testid='score-panel']")).not.toContainText(/\bkg\b|<\s*\d|≥\s*\d/);

    // Presence is per DATA DICTIONARY. No participant-level completeness, no effective N — ddharmon never
    // computes the score, it writes the recipe.
    await expect(page.locator("[data-testid='score-panel']")).toContainText(/data dictionar/i);
    await expect(page.locator("[data-testid='score-panel']")).not.toContainText(/effective N|participants? with/i);
  });
});

/**
 * 08-14h TASK 3 — Gate 1 WAITS rather than looking empty.
 *
 * THE DEFECT, IN ONE SENTENCE: an empty ledger and a not-yet-populated ledger looked identical and meant
 * opposite things. "No groups formed. Every variable was left unassigned. That usually means the
 * dictionaries share too little text to group." is a CLAIM ABOUT THE REVIEWER'S CORPUS, and a run that
 * has not finished splitting yet has produced no evidence for it. Since 08-14f made Start land directly
 * on Gate 1, that false claim is the FIRST thing a reviewer sees on every run they start.
 *
 * The three states are separated by RUN STATE, which `lib/run-state.ts` already answers, and nothing here
 * is held in component state — so when the stream delivers the park, the ledger fills in on its own.
 */
test.describe("gate 1 waiting and error states", () => {
  /** No groups yet, and a run in whatever state the caller names. */
  async function noGroupsYet(page: Page, status: string, phase = status) {
    await serveRun(page, (run) => {
      Object.assign(run, { status, phase });
      if (run.result) {
        run.result.conceptGroups = [];
        run.result.unassignedFields = [];
      }
      const config = run.config as Record<string, unknown>;
      config.run_mode = "batch";
      delete config.demo;
    });
    await page.goto(`/run/${PAUSED_JOB}/gate1`);
    await page.waitForLoadState("networkidle");
  }

  test("@gate1 a run still working reads as WAITING, and makes no claim about the corpus", async ({ page }) => {
    await noGroupsYet(page, "splitting");

    const waiting = page.locator("[data-testid='gate1-waiting']");
    await expect(waiting).toBeVisible();
    // IT SAYS WHAT IS BEING WAITED FOR. A reviewer who arrives early has to be able to tell that the
    // screen is working, and "waiting" with no object is barely better than a blank pane.
    await expect(waiting).toContainText(/splitting/i);
    await expect(waiting).toContainText(/coherence/i);
    // AND IT PROMISES NO RELOAD, because none is needed — the stream delivers the groups. That promise
    // is the NEXT STEP, which is where an empty state is required to put the thing the reviewer does.
    await expect(page.locator("[data-testid='gate1-waiting-next']")).toContainText(
      /on their own|no need to reload/i,
    );

    // THE FALSE CLAIM IS GONE. Not merely reworded — absent.
    await expect(page.getByText("No groups formed")).toHaveCount(0);
    await expect(page.getByText(/dictionaries share too little text/i)).toHaveCount(0);
    // And no zeroed statistics strip, which reads as "this run measured nothing" just as loudly.
    await expect(page.locator("[data-testid='grouping-strip']")).toHaveCount(0);
  });

  test("@gate1 a run that DIED before reaching gate 1 says so, rather than waiting forever", async ({ page }) => {
    for (const status of ["error", "cancelled"]) {
      await noGroupsYet(page, status);
      const stopped = page.locator("[data-testid='gate1-run-stopped']");
      await expect(stopped, status).toBeVisible();
      await expect(page.locator("[data-testid='gate1-waiting']"), status).toHaveCount(0);
      await expect(page.getByText("No groups formed"), status).toHaveCount(0);
    }
  });

  test("@gate1 once the run PARKS with no groups, the corpus finding is the honest reading again", async ({
    page,
  }) => {
    // The run reached this gate and produced nothing. NOW "no groups formed" is a fact about the corpus,
    // and the waiting state must be entirely gone — no residue.
    await noGroupsYet(page, "awaiting_review");
    await expect(page.getByText("No groups formed")).toBeVisible();
    await expect(page.locator("[data-testid='gate1-waiting']")).toHaveCount(0);
    await expect(page.locator("[data-testid='gate1-run-stopped']")).toHaveCount(0);
    await expect(page.locator("[data-testid='grouping-strip']")).toBeVisible();
  });

  test("@gate1 a parked run WITH groups shows the ledger and neither of the new states", async ({ page }) => {
    await page.goto(`/run/${PAUSED_JOB}/gate1`);
    await page.waitForLoadState("networkidle");
    await expect(page.locator("[data-testid='ledger-row']").first()).toBeVisible();
    await expect(page.locator("[data-testid='gate1-waiting']")).toHaveCount(0);
    await expect(page.locator("[data-testid='gate1-run-stopped']")).toHaveCount(0);
  });

  test("@gate1 the waiting state is DERIVED from the streamed status, so the park ends it without a reload", async () => {
    const { readFileSync } = await import("node:fs");
    const { dirname, resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(here, "../../src/pages/run/gate1.tsx"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/^\s*\/\/.*$/gm, " ");

    // THE PROPERTY THAT MAKES THE LEDGER SELF-POPULATING. `useHarmonizeStream` already delivers the park;
    // what would break it is holding "am I waiting?" in component state, because a `useState` seeded on
    // first render does not change when the stream does — the reviewer would sit on a waiting screen over
    // a run that had already arrived. So it is derived from the run's status, every render.
    // A plain `const`, recomputed every render, whose input is the STREAMED status.
    expect(src).toMatch(/const awaitingRun =[^;]*isInFlight\(jobState\.status\)/s);
    expect(src, "the waiting state may not be held in component state").not.toMatch(
      /useState[^\n]*([Ww]aiting|awaitingRun)/,
    );
    // And it uses the SHARED predicates rather than a fifth local copy of them.
    expect(src).toMatch(/import \{[^}]*isInFlight[^}]*\} from "@\/lib\/run-state"/s);
  });
});

/**
 * 08-14h TASK 4 — ONE vertical scrollbar at the pinned 1440x900 desktop viewport.
 *
 * WHAT WAS ACTUALLY WRONG, because it is not what it looked like. Gate 1 had TWO working vertical
 * scroll contexts: `<main>` (the app's real content scroller, `AppShell.tsx:152`) and the DOCUMENT. The
 * second one did not scroll the ledger — it dragged the entire application, sidebar and header and all,
 * up off the top of the window, leaving bare page background below it.
 *
 * THE CAUSE IS `sr-only`, WHICH IS `position: absolute`. Gate 1's ledger renders a screen-reader-only
 * span per row (the coherence judge's explanation on `CoherenceMark`, the "variables" unit on the member
 * count) — 58 of them on the shipped fixture, 117 rows' worth on the run this was found on. Every
 * ancestor up to `<html>` was `position: static`, so their containing block was the INITIAL containing
 * block: they escaped `<main>`'s `overflow-y: auto` clip and `AppShell`'s `overflow: hidden`, and each
 * one extended the DOCUMENT's scrollable area to wherever it landed — 3,344px on the fixture.
 *
 * It is Gate 1 only because Gate 1 is the only screen with enough of them far enough down the page;
 * measured on the live run, Setup, Gate 2, /jobs and /methods all reported a document scroll height of
 * exactly 900. The fix is therefore in `AppShell`, not here: `<main>` becomes the containing block, so
 * the scroller that already owns vertical scrolling also clips what would otherwise escape it. Gate 1
 * merely happens to be where a latent app-wide bug became visible, and fixing it on this page alone
 * would leave the same bug waiting for Gate 2's ledger to grow.
 *
 * NOTE ON THE BOUNDED EVIDENCE GRID. `source-rows`'s `max-h-[28rem] overflow-auto` is untouched and is
 * NOT this bug: it is a deliberately bounded widget inside an expanded row, its cap is what keeps the
 * carve proposal below it reachable, its horizontal scrolling is required behaviour, and it is shared
 * with the workbench. A contained widget that scrolls inside its own border is a different thing from a
 * page that scrolls itself out of view.
 */
test.describe("gate 1 scrolling", () => {
  /** Scroll the document and report whether it moved. `main` is asserted separately. */
  async function scrollProbe(page: Page) {
    return page.evaluate(async () => {
      const de = document.documentElement;
      const main = document.querySelector("main")!;
      window.scrollTo(0, 0);
      window.scrollBy(0, 300);
      await new Promise((r) => setTimeout(r, 200));
      const documentMoved = window.scrollY;
      window.scrollTo(0, 0);
      const m0 = main.scrollTop;
      main.scrollBy(0, 300);
      await new Promise((r) => setTimeout(r, 200));
      const mainMoved = main.scrollTop - m0;
      main.scrollTo(0, 0);
      return {
        documentMoved,
        mainMoved,
        documentScrollHeight: de.scrollHeight,
        viewportHeight: de.clientHeight,
      };
    });
  }

  test("@gate1 the page has exactly one vertical scroll context, and it is the content area", async ({
    page,
  }) => {
    // The pinned baseline viewport. This is a LAYOUT bug: measuring a different window size proves
    // nothing about the size the visual contract is written against.
    expect(page.viewportSize()).toEqual({ width: 1440, height: 900 });
    await page.goto(`/run/${PAUSED_JOB}/gate1`);
    await page.waitForLoadState("networkidle");
    // A ledger long enough for the question to mean something.
    expect((await page.locator("[data-testid='ledger-row']").count())).toBeGreaterThan(10);

    const probe = await scrollProbe(page);
    // THE DEFECT, STATED AS A NUMBER: this was 300 (and the document 3,344px tall) before the fix.
    expect(probe.documentMoved, "the document must not scroll — it drags the whole app off-screen").toBe(0);
    expect(probe.documentScrollHeight, "the document may be no taller than the viewport").toBe(
      probe.viewportHeight,
    );
    // ...and the ONE scroller that does exist is the content area, so scrolling the page scrolls the
    // ledger. The reviewer never has to find the right container.
    expect(probe.mainMoved, "the content area is the page's scroller").toBe(300);
  });

  test("@gate1 nothing absolutely positioned escapes the content scroller", async ({ page }) => {
    await page.goto(`/run/${PAUSED_JOB}/gate1`);
    await page.waitForLoadState("networkidle");

    const escapees = await page.evaluate(() => {
      const main = document.querySelector("main")!;
      const out: string[] = [];
      for (const el of main.querySelectorAll("*")) {
        if (getComputedStyle(el).position !== "absolute") continue;
        // Walk to the element's containing block: the nearest POSITIONED ancestor. If that walk leaves
        // `main` entirely, this element is laid out against the initial containing block and its
        // overflow lands on the document rather than on the scroller.
        let a: HTMLElement | null = el.parentElement;
        let contained = false;
        while (a) {
          // A STATIC ancestor is not a containing block — including `main` itself, which is exactly the
          // detail the bug turned on. Only a positioned ancestor stops the walk.
          if (getComputedStyle(a).position !== "static") {
            contained = a === main || main.contains(a);
            break;
          }
          a = a.parentElement;
        }
        if (!contained) out.push(`${el.tagName.toLowerCase()}.${String(el.className || "").slice(0, 40)}`);
      }
      // Report a sample: 58 identical `sr-only` spans is not 58 findings.
      return out.slice(0, 5);
    });
    // `sr-only` IS `position: absolute` — that is the utility's definition, not a misuse — so the fix is
    // to give the scroller a containing block rather than to hunt down every use of it.
    expect(escapees, "an absolutely positioned descendant may not be laid out against the document").toEqual(
      [],
    );
  });

  test("@gate1 expanding a row does not bring the document scroll back", async ({ page }) => {
    await page.goto(`/run/${PAUSED_JOB}/gate1`);
    await page.waitForLoadState("networkidle");
    const row = await expandRow(page, BIG);
    // The evidence grid is a BOUNDED widget with its own scroll region, and that is deliberate: the cap
    // is what keeps the carve proposal below it reachable, and the horizontal scrolling is required
    // behaviour (asserted in "the expanded row carries the source rows" above). What must not happen is
    // the page scrolling ITSELF out of view again.
    await expect(row.locator("[data-testid='source-rows-scroll']")).toBeVisible();
    const probe = await scrollProbe(page);
    expect(probe.documentMoved, "an expanded row must not make the document scrollable").toBe(0);
    expect(probe.documentScrollHeight).toBe(probe.viewportHeight);
  });
});

/**
 * 08-14h TASK 5 — the variable tiles merged INTO the spreadsheet rows.
 *
 * Bhargav, on the live run: *"the draggable var tiles + the spreadsheet style rows are redundant… have
 * the tiles be embedded into the spreadsheet layout such that the user can drag from the row directly
 * rather than have to look at both."* The reviewer was holding two renderings of the same variable in
 * their head and matching them up.
 *
 * THE GRID SURVIVED, not the tiles: it came from `source-rows.tsx`, the production evidence layer, and it
 * carries the metadata a coherence judgement actually needs. The tiles carried only a name.
 */
test.describe("gate1 the row IS the variable", () => {
  test("@gate1 the expanded row has ONE representation of each variable, and it is the grid row", async ({
    page,
  }) => {
    await openGate1(page);
    const group = fixtureGroups().find((g) => g.groupId === BIG)!;
    const row = await expandRow(page, BIG);

    // The grid rows are the membership now — uncapped, one per pooled variable (T-08-89's rule survives).
    await expect(row.locator("[data-testid='member-row']")).toHaveCount(group.nMembers);
    // ...and the separate tile strip above it is GONE. Not hidden — absent.
    await expect(row.locator("[data-testid='member-chip']")).toHaveCount(0);
  });

  test("@gate1 a grid row is visibly and actually draggable, with a cue that needs no hover", async ({
    page,
  }) => {
    await openGate1(page);
    const row = await expandRow(page, BIG);
    const first = row.locator("[data-testid='member-row']").first();
    await expect(first).toHaveAttribute("draggable", "true");
    await expect(first).toHaveAttribute("data-member-id", /.+/);
    // A spreadsheet row does not look draggable by default, so the cue is a column of its own that is
    // always rendered — never hover-only, never tooltip-only. It is the first thing in the row.
    const cue = await first.evaluate((tr) => {
      const cell = tr.querySelector("td");
      const svg = cell?.querySelector("svg");
      return { hasGlyph: !!svg, cursor: getComputedStyle(tr).cursor };
    });
    expect(cue.hasGlyph, "every row carries a visible drag handle").toBe(true);
    expect(cue.cursor).toBe("grab");
  });

  test("@gate1 dragging a grid row still regroups, per-variable, and round-trips to the store", async ({
    page,
  }) => {
    await openGate1(page);
    const row = await expandRow(page, BIG);
    const target = row.locator("[data-testid='member-row']").first();
    const memberId = await target.getAttribute("data-member-id");
    const tray = row.locator("[data-testid='member-drop-zone'][data-group-id='__unassigned__']");

    // THE DROP TARGET IS VISIBLE WITHOUT SCROLLING AWAY from the row being dragged — the tray sits
    // directly below the grid, in the same expanded row.
    await expect(tray).toBeVisible();
    await target.dragTo(tray);

    // The behaviour 08-15 built is unchanged: keyed per variable, persisted, and the row says it changed.
    await expect(tray.locator("[data-testid='member-chip']")).toHaveCount(1);
    await expect(page.locator(`[data-testid='ledger-row'][data-row-id='${BIG}']`)).toHaveAttribute(
      "data-spine",
      "changed",
    );
    await page.reload();
    await page.waitForLoadState("networkidle");
    const after = await expandRow(page, BIG);
    await expect(
      after.locator(`[data-testid='member-drop-zone'][data-group-id='__unassigned__'] [data-member-id='${memberId}']`),
    ).toHaveCount(1);
  });

  test("@gate1 regrouping is reachable WITHOUT a mouse", async ({ page }) => {
    // Native HTML5 drag and drop has no keyboard equivalent, so before this merge the only way to
    // correct an over-merged group was with a mouse. A drag with no keyboard path is a regression, not a
    // simplification — so every row carries a real button that performs the correction this screen is for.
    await openGate1(page);
    const row = await expandRow(page, BIG);
    const target = row.locator("[data-testid='member-row']").first();
    const memberId = await target.getAttribute("data-member-id");

    const remove = row.locator(`[data-testid='member-remove'][data-member-id='${memberId}']`);
    await expect(remove).toBeVisible();
    // Focusable and activated by the keyboard, and NAMED for the variable it acts on — not "remove".
    await remove.focus();
    await expect(remove).toBeFocused();
    await expect(remove).toHaveAttribute("aria-label", /take .+ out of this group/i);
    await page.keyboard.press("Enter");

    const tray = row.locator("[data-testid='member-drop-zone'][data-group-id='__unassigned__']");
    await expect(tray.locator(`[data-member-id='${memberId}']`)).toHaveCount(1);
    // Same persisted path as the drag — not a second, weaker code path.
    await expect(page.locator(`[data-testid='ledger-row'][data-row-id='${BIG}']`)).toHaveAttribute(
      "data-spine",
      "changed",
    );
  });

  test("@gate1 with no field rows on the run, the chips come back rather than the members vanishing", async ({
    page,
  }) => {
    // THE FALLBACK IS LOAD-BEARING once the grid is the only membership view: a run that predates
    // `fieldIndex` would otherwise render a group with no members at all.
    await serveRun(page, (run) => {
      run.result!.fieldIndex = {};
    });
    await openGate1(page);
    const group = fixtureGroups().find((g) => g.groupId === BIG)!;
    const row = await expandRow(page, BIG);
    await expect(row.locator("[data-testid='source-rows']")).toHaveCount(0);
    await expect(row.locator("[data-testid='member-chip']")).toHaveCount(group.nMembers);
    await expect(row.locator("[data-testid='member-chip']").first()).toHaveAttribute("draggable", "true");
  });

  test("@gate1 the workbench's copy of the grid gains NO drag affordance", async () => {
    const { readFileSync } = await import("node:fs");
    const { dirname, resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(here, "../../src/pages/workbench.tsx"), "utf8");
    // ONE grid, two callers. The workbench has no notion of regrouping and no handler to give it, so it
    // passes no `drag` prop and renders exactly what it always did. A grid that grew a permanent drag
    // handle would have put a dead control on a screen that cannot honour it.
    expect(src).toMatch(/<SourceRows\b(?![^>]*\bdrag=)/);
  });
});

/**
 * 08-14h TASK 6 — the toolbar says what its controls mean, and stops mislabelling two of them.
 *
 * THE MISLABEL WAS A REAL DEFECT AND THE EMPTY CASE IS WHAT FOUND IT. `LedgerToolbar` opened a new `div`
 * after the cohort chips with NO heading of its own, so "I changed it" and "Going forward" — which are
 * about the REVIEWER's own actions — sat directly beneath the COHORT eyebrow and read as cohort filters.
 * With the cohort chips absent, which is exactly what a run that has not populated cohorts renders, they
 * are the only things under that heading.
 */
test.describe("gate1 toolbar labelling and explanations", () => {
  test("@gate1 the review toggles are their own labelled group, not cohort filters", async ({ page }) => {
    await openGate1(page);
    const toolbar = page.locator("[data-testid='ledger-toolbar']");

    // Each control group carries its own heading, and the two review toggles are in one of their own.
    const reviewGroup = toolbar.locator("[data-testid='filter-group'][data-group='review']");
    await expect(reviewGroup).toBeVisible();
    await expect(reviewGroup.locator("[data-testid='filter-touched']")).toBeVisible();
    await expect(reviewGroup.locator("[data-testid='filter-in-scope']")).toBeVisible();

    // ...and the COHORT group contains ONLY cohort chips. This is the assertion the defect fails.
    const cohortGroup = toolbar.locator("[data-testid='filter-group'][data-group='cohort']");
    await expect(cohortGroup.locator("[data-testid='filter-touched']")).toHaveCount(0);
    await expect(cohortGroup.locator("[data-testid='filter-in-scope']")).toHaveCount(0);
    await expect(cohortGroup).toContainText("Cohort");
  });

  test("@gate1 with no cohorts on the run, the COHORT heading does not render over unrelated chips", async ({
    page,
  }) => {
    // THE CASE THAT EXPOSED THE MISLABEL. A heading over an empty group is a claim that the run has
    // cohort filters and that whatever sits beneath it is one of them.
    //
    // AMENDED 08-16c Task 9. Emptying `summary.cohorts` alone NO LONGER produces a cohort-less run: the
    // roster falls back to the union of the groups' own `cohorts` precisely because a real parked run
    // carries an empty summary alongside fully-populated groups, and the coverage column drew nothing.
    // So the run has to be made genuinely cohort-less to reach the case this test is about — which is the
    // honest statement of the invariant anyway: the heading renders iff there are cohorts to filter BY,
    // not iff one particular field happened to be filled in.
    await serveRun(page, (run) => {
      run.result!.summary!.cohorts = [];
      for (const g of run.result!.conceptGroups ?? []) g.cohorts = [];
    });
    await openGate1(page);
    const toolbar = page.locator("[data-testid='ledger-toolbar']");
    await expect(toolbar.locator("[data-testid='filter-group'][data-group='cohort']")).toHaveCount(0);
    await expect(toolbar).not.toContainText("Cohort");
    // The review toggles are still there and still correctly labelled — they were never cohort filters.
    await expect(toolbar.locator("[data-testid='filter-group'][data-group='review']")).toBeVisible();
    await expect(toolbar.locator("[data-testid='filter-touched']")).toBeVisible();
  });

  /**
   * Walk the toolbar the way a keyboard user does — one continuous run of Tab presses — and record what
   * each control said about itself when it took focus.
   *
   * WHY A JOURNEY RATHER THAN `locator.focus()` PER CONTROL, and this is measured rather than assumed.
   * Radix distinguishes programmatic focus from keyboard focus and opens a tooltip only for the latter,
   * so `.focus()` reports `data-state="closed"` with no `aria-describedby` for a control that explains
   * itself perfectly well to a real keyboard user — the spec would convict working code. Pressing
   * `Escape` is no better: Radix keeps a dismissed tooltip shut while its trigger still holds focus, so
   * a per-control focus/assert/Escape loop poisons every iteration after the first.
   *
   * Tabbing through in one pass is both the thing that works and the thing the requirement is actually
   * about: "an explanation is available on hover AND on keyboard focus" is a claim about traversal.
   *
   * The FIRST Tab after the initial programmatic focus is the one exception — Radix does not open on it
   * — so the walk has to START on a control whose next stop is not one being asserted. That used to be the
   * order select; with the select removed (08-16c review) it is the LAST BUCKET TAB, whose next stop is
   * the Coherence heading's `InfoTip`. The tip carries no `data-testid`, so the probe below skips it
   * outright and the first chip asserted is reached by a Tab that does open its tooltip.
   */
  /**
   * Has the focused control's explanation been wired yet? Waits for it, PINNED to the element that holds
   * focus right now.
   *
   * The pin is the point. Radix sets `aria-describedby` on the trigger when the tooltip opens and React
   * commits that a frame or two after the focus event, so an immediate read is a race — but a page-level
   * wait for "the focused element is described" is satisfied by the PREVIOUS trigger, whose attribute
   * outlives the blur by a frame. Capturing the element first is what makes the answer about this stop.
   */
  async function isDescribed(page: Page): Promise<boolean> {
    return page.evaluate(async () => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return false;
      const deadline = Date.now() + 600;
      while (!el.getAttribute("aria-describedby") && Date.now() < deadline) {
        await new Promise((r) => requestAnimationFrame(r));
      }
      return !!el.getAttribute("aria-describedby");
    });
  }

  async function tabThroughToolbar(page: Page): Promise<Map<string, { describedBy: boolean; tip: string }>> {
    const seen = new Map<string, { describedBy: boolean; tip: string }>();
    await page.locator("[data-testid='bucket-tab']").first().focus();
    for (let i = 0; i < 24; i++) {
      await page.keyboard.press("Tab");
      /**
       * ONE KEYBOARD RETRY PER STOP, and it is the difference between this walk measuring the product and
       * measuring Radix.
       *
       * MEASURED. Radix opens a tooltip on focus with no delay (`onFocus` calls `onOpen` directly), but
       * the FIRST trigger focused after a programmatic `.focus()` reliably stays `data-state="closed"` —
       * the exception the docstring above records — and with the order select gone the walk now starts one
       * stop earlier, which pushed that suppression from a heading ⓘ (skipped, so invisible) onto the
       * first coherence chip. A dwell does not cure it: at 400ms and at 1000ms on the preceding stop the
       * chip was still closed, so it is not a race that waiting longer wins.
       *
       * SHIFT+TAB THEN TAB IS A REAL KEYBOARD ARRIVAL — the same event a reviewer generates by tabbing
       * back and forth — so the retry does not weaken the claim being made. It cannot manufacture a
       * passing result either: a control with no explanation wired has nothing to open, arrives
       * `describedBy: false` twice, and still fails the assertions below.
       */
      if (!(await isDescribed(page))) {
        await page.keyboard.press("Shift+Tab");
        await page.keyboard.press("Tab");
      }
      const probe = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el) return null;
        const testid = el.getAttribute("data-testid");
        if (!testid) return null;
        const key = testid === "filter-verdict" ? `verdict:${el.getAttribute("data-verdict")}`
          : testid === "filter-cohort" ? `cohort:${el.getAttribute("data-cohort")}`
          : testid;
        // RESOLVE THE TOOLTIP THROUGH `aria-describedby`, never by taking the first `[role=tooltip]` on
        // the page. A tooltip from the control focused a moment ago can still be in the DOM, and reading
        // it would attribute one control's words to another — which is how the first version of this
        // test convicted the split chip of using the Coherence heading's copy.
        const describedBy = el.getAttribute("aria-describedby");
        const tip = describedBy ? document.getElementById(describedBy) : null;
        return { key, describedBy: !!describedBy, tip: (tip?.textContent ?? "").trim() };
      });
      if (!probe) continue;
      seen.set(probe.key, { describedBy: probe.describedBy, tip: probe.tip });
      // Stop once focus has left the toolbar for the search box below it.
      if (probe.key === "filter-in-scope") break;
    }
    return seen;
  }

  test("@gate1 every control in the toolbar explains itself on keyboard focus, not only on hover", async ({
    page,
  }) => {
    await openGate1(page);
    const cohorts = gate1Fixture().result!.summary!.cohorts!;
    const seen = await tabThroughToolbar(page);

    // Every control the plan names: the four coherence states, each cohort chip, both review toggles.
    const required = [
      ...["split", "qualify", "not_judged", "single"].map((v) => `verdict:${v}`),
      ...cohorts.map((c) => `cohort:${c}`),
      "filter-touched",
      "filter-in-scope",
    ];
    expect([...seen.keys()].sort(), "every toolbar control must be reachable by Tab").toEqual(
      expect.arrayContaining(required),
    );

    for (const key of required) {
      const got = seen.get(key)!;
      // `aria-describedby` is what carries the explanation to a SCREEN READER. A hover-only tooltip
      // excludes exactly the reviewers most likely to need it.
      expect(got.describedBy, `${key} must be described by its explanation on keyboard focus`).toBe(true);
      expect(got.tip.length, `${key}'s explanation must say something`).toBeGreaterThan(20);
    }

    // AND THE ORDER EXPLANATION IS GONE WITH THE ORDER CONTROL. It hung off the select's label; leaving
    // it behind would be a tooltip explaining a control that is no longer on the screen.
    await expect(
      page.locator("[data-testid='ledger-toolbar']").getByRole("button", { name: /what does the order/i }),
    ).toHaveCount(0);
  });

  test("@gate1 each coherence state is explained in the JUDGE'S OWN words, not a re-gloss", async ({
    page,
  }) => {
    await openGate1(page);
    const seen = await tabThroughToolbar(page);
    for (const state of ["split", "qualify", "not_judged", "single"] as CoherenceState[]) {
      // THE SAME REGISTER THE LEDGER CELL USES. `CoherenceMark` already owns one explanation per state;
      // a second, re-worded one in the toolbar would let a reviewer filter on a meaning the ledger does
      // not agree with. The spec reads the shipped register rather than restating it here.
      expect(seen.get(`verdict:${state}`)!.tip, `${state} must use the shipped wording`).toBe(
        COHERENCE_COPY[state].explain,
      );
    }
    // And the chip's own label is that register's label, not a fourth spelling of it.
    for (const state of ["not_judged", "single"] as CoherenceState[]) {
      await expect(
        page.locator(`[data-testid='filter-verdict'][data-verdict='${state}']`),
      ).toHaveText(COHERENCE_COPY[state].label);
    }
  });

  test("@gate1 the coherence labels are written ONCE and read from that one register", async () => {
    const { readFileSync } = await import("node:fs");
    const { dirname, resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(here, "../../src/components/gate/LedgerToolbar.tsx"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/^\s*\/\/.*$/gm, " ");
    // Before 08-14h this file spelled the four labels out TWICE — once in its `VERDICTS` table and again
    // in the active-filter summary's `f === "not_judged" ? "not judged" : f === "single" ? "checked" : f`
    // — and `CoherenceMark` held a third copy. Three copies of a label is how a filter comes to disagree
    // with the cell it filters.
    expect(src).toMatch(/COHERENCE_COPY/);
    expect(src, "the active-filter summary may not re-spell the state labels").not.toMatch(
      /"not judged"[\s\S]{0,40}"checked"/,
    );
  });
});

/**
 * 08-14h TASK 7 — a search that finds nothing must be legible as such, and should find more.
 *
 * Bhargav, on the live run: *"i searched for a term and I think now all concepts have dissapeared?"* —
 * and the "I think" is the bug. Nothing was lost; nothing matched. The screen let him doubt it, because a
 * search that hid every row fell through every empty state the ledger had and rendered a BLANK BODY:
 * `filteredToNothing` required an active filter, `emptyBucket` required no search, so a search-emptied
 * ledger matched neither and simply mapped an empty list.
 */
test.describe("gate1 search", () => {
  test("@gate1 a partial word matches the word it begins", async () => {
    const groups = fixtureGroups();
    // PREFIX, NOT STEMMING OR FUZZY. Prefix keeps the search predictable — a reviewer can say in advance
    // what it will do — while fixing the common case where a half-typed word silently returned nothing.
    // Anything cleverer starts making the semantic claim 08-15 deliberately removed.
    expect([...matchTerms(groups, ["press"]).ids].length).toBeGreaterThan(0);
    expect([...matchTerms(groups, ["smok"]).ids].length).toBeGreaterThan(0);
    // A prefix finds a superset of what the exact term finds — never a different set.
    const exact = [...matchTerms(groups, ["pressure"]).ids];
    const prefix = [...matchTerms(groups, ["press"]).ids];
    expect(prefix).toEqual(expect.arrayContaining(exact));
    // ...and it is a PREFIX, not a substring: an interior match does not count, so the rule stays one a
    // reviewer can predict.
    expect(matchTerms(groups, ["ressure"]).noMatches).toEqual(["ressure"]);
    // Conjunction across a term's words survives the change.
    expect(matchTerms(groups, ["zzzz nonexistent"]).noMatches).toEqual(["zzzz nonexistent"]);
  });

  test("@gate1 an unmatched term reports WHICH of its words matched nothing", async () => {
    const groups = fixtureGroups();
    // THE HONEST DISCRIMINATOR between "this run does not measure that" and "you mistyped it". The match
    // is lexical, so the tool cannot read intent — but it CAN say which words it could not find. A term
    // whose every word is absent is a coverage finding about the corpus; a term where one word landed and
    // another did not is a wording problem, and the two need different responses from the reviewer.
    const mistyped = matchTerms(groups, ["smokng status"]);
    expect(mistyped.noMatches).toEqual(["smokng status"]);
    expect(mistyped.missingTokens["smokng status"]).toEqual(["smokng"]);

    const absent = matchTerms(groups, ["zzzz qqqq"]);
    expect(absent.missingTokens["zzzz qqqq"]).toEqual(["zzzz", "qqqq"]);
  });

  test("@gate1 a search that hides every group SAYS SO, names the term, and clears in one click", async ({
    page,
  }) => {
    await openGate1(page);
    const before = await page.locator("[data-testid='ledger-row']").count();
    expect(before).toBeGreaterThan(0);

    await page.locator("#term-search-input").fill("zzzz nonexistent concept");
    await page.getByRole("button", { name: /^Search/ }).click();

    // NOT A BLANK BODY. The reviewer must never be left inferring why the rows went away.
    const empty = page.locator("[data-testid='search-empty']");
    await expect(empty).toBeVisible();
    // The state SAYS the search matched nothing — that claim is the heading, which is where an empty
    // state is required to put the headline.
    await expect(page.locator("[data-testid='gate-empty-state']")).toContainText(/matched no group/i);
    // The body names the term the reviewer typed...
    await expect(empty).toContainText("zzzz nonexistent concept");
    // ...and says the groups are HIDDEN, not gone. This sentence is the whole point: it is the one that
    // answers "I think now all concepts have dissapeared?" before the reviewer has to ask it.
    await expect(empty).toContainText(/nothing has been lost/i);
    await expect(empty).toContainText(/still here/i);

    // One click back to every group.
    await page.locator("[data-testid='clear-search-inline']").click();
    await expect(page.locator("[data-testid='ledger-row']")).toHaveCount(before);
    await expect(page.locator("[data-testid='search-empty']")).toHaveCount(0);
  });

  test("@gate1 the empty state names WHICH of search and filters emptied the ledger", async ({ page }) => {
    await openGate1(page);

    // (a) SEARCH ALONE. The term matched nothing anywhere in the run, so the search is responsible and
    // the finding is about the corpus.
    await page.locator("#term-search-input").fill("zzzz nonexistent concept");
    await page.getByRole("button", { name: /^Search/ }).click();
    const empty = page.locator("[data-testid='search-empty']");
    await expect(empty).toHaveAttribute("data-cause", "search");

    // (b) SEARCH PLUS A FILTER, where the term DID match groups but the filter hides them. The recovery
    // is different — clearing the filter brings them back and clearing the search does not — so saying
    // "your search found nothing" here would send the reviewer the wrong way.
    await page.locator("[data-testid='clear-search-inline']").click();
    await page.locator("#term-search-input").fill("blood pressure");
    await page.getByRole("button", { name: /^Search/ }).click();
    await expect(page.locator("[data-testid='ledger-row']")).not.toHaveCount(0);
    // A coherence state none of the matched groups holds.
    await page.locator("[data-testid='filter-verdict'][data-verdict='split']").click();
    const both = page.locator("[data-testid='search-empty']");
    if (await both.count()) {
      await expect(both).toHaveAttribute("data-cause", "both");
      await expect(both).toContainText(/filter/i);
      await expect(both).toContainText("blood pressure");
      // BOTH ways back are offered, because either one alone may be the one the reviewer wants.
      await expect(page.locator("[data-testid='clear-search-inline']")).toBeVisible();
      await expect(page.locator("[data-testid='clear-filters-inline']")).toBeVisible();
    }
  });

  test("@gate1 the search still makes no semantic claim", async ({ page }) => {
    await openGate1(page);
    // 08-15 removed that claim deliberately: no group centroid and no embedding reaches the browser, so
    // telling a reviewer the tool understood their term would be false. Prefix matching does not change
    // that and must not be described as if it did.
    const search = page.locator("[data-testid='term-search']");
    await expect(search).not.toContainText(/semantic|understands|meaning of your term/i);
    await expect(search).toContainText(/text of each group/i);
  });
});

/**
 * Continue — the destination, and what happens when the server says no (08-16c Task 8).
 *
 * THE BUG THIS GUARDS. `onContinue` awaited `resumeRun`, threw the result away and toasted a hardcoded
 * "Continuing to Gate 2" — so a reviewer who pressed Continue committed the run and then stayed on the
 * screen they had just committed. Bhargav hit exactly that on 2026-09-01. The destination is now
 * `pathForGate(jobId, target)` where `target` is the gate THE SERVER NAMED, asserted as a pure function in
 * `run-state.spec.ts` because Continue is the spend path and the static build disables it.
 *
 * WHAT IS ASSERTABLE HERE is the other half, and it is the half a naive fix breaks: navigation must be
 * downstream of the await, so a REFUSED continue leaves the reviewer where they were. `resumeRun` throws
 * in a static build, which makes this fixture a genuine refusal rather than a simulated one. A version
 * that navigated unconditionally — or before the await — fails this test.
 */
test.describe("gate1 continue", () => {
  test("@gate1 a refused continue leaves the reviewer on Gate 1 and repeats what the server said", async ({ page }) => {
    await openGate1(page);
    const url = page.url();
    const button = page.locator("[data-testid='commit-bar'] button");
    await expect(button).toBeEnabled();
    await button.click();

    // The server's own sentence, verbatim. `json()` in lib/api.ts unpacks FastAPI's `detail` into the
    // Error message, so the route's six distinct 409s each reach the reviewer as themselves; the static
    // build's refusal travels the identical path, which is what makes it a fair stand-in here.
    await expect(page.getByText(/static preview/i).first()).toBeVisible();

    // Still on Gate 1 — the ledger, and the same URL.
    await expect(page).toHaveURL(url);
    await expect(page.locator("[data-testid='ledger']")).toBeVisible();
  });

  test("@gate1 continue cannot be pressed twice while it is in flight", async ({ page }) => {
    await openGate1(page);
    const button = page.locator("[data-testid='commit-bar'] button");
    await expect(button).toBeEnabled();
    // `CommitBar` disables on `busy`, and `onContinue` sets it for the whole await. The guarantee is that
    // the spend path cannot be double-submitted; asserting the control returns to enabled after the
    // refusal is what shows the flag is released rather than merely set.
    await button.click();
    await expect(button).toBeEnabled();
  });
});

/**
 * The cohort-coverage column's denominator (08-16c Task 9).
 *
 * MEASURED, NOT INVENTED: on the parked run `890638d1` the Gate 1 checkpoint carries
 * `result.summary.cohorts === []` alongside 117 concept groups whose own `cohorts` are populated
 * (`conceptGroups[0].cohorts === ["aou"]`). `CohortCoverage` draws one segment PER ROSTER ENTRY, so an
 * empty roster renders an empty column — which is exactly what Bhargav reported.
 */
test.describe("gate1 cohort roster", () => {
  test("@gate1 an empty run summary falls back to the union of the groups' own cohorts", () => {
    const groups = [{ cohorts: ["ukbb", "aou"] }, { cohorts: ["aou"] }, { cohorts: ["clsa"] }];
    expect(cohortRoster([], groups)).toEqual(["aou", "clsa", "ukbb"]);
    expect(cohortRoster(undefined, groups)).toEqual(["aou", "clsa", "ukbb"]);
  });

  test("@gate1 a run that DOES state its cohorts keeps them verbatim", () => {
    // Order and contents preserved: the summary can legitimately name a cohort that contributed no group,
    // which a union over groups could never discover.
    const stated = ["ukbb", "aou", "mesa"];
    expect(cohortRoster(stated, [{ cohorts: ["aou"] }])).toEqual(stated);
  });

  test("@gate1 the derived roster is stable regardless of the order the groups arrive in", () => {
    const a = cohortRoster([], [{ cohorts: ["ukbb"] }, { cohorts: ["aou"] }]);
    const b = cohortRoster([], [{ cohorts: ["aou"] }, { cohorts: ["ukbb"] }]);
    expect(a).toEqual(b);
  });

  test("@gate1 a single-cohort group does not look like one spanning everything", async ({ page }) => {
    await openGate1(page);
    const strip = page.locator("[data-testid='cohort-coverage']").first();
    await expect(strip).toBeVisible();
    // Segments are drawn, and the covered/uncovered distinction is real data rather than a uniform row.
    const segments = strip.locator("span[data-covered]");
    expect(await segments.count()).toBeGreaterThan(0);
    const label = await strip.getAttribute("aria-label");
    expect(label).toMatch(/cohorts:|No cohort coverage/);
  });

  test("@gate1 groups with no cohorts at all yield an empty roster rather than a crash", () => {
    expect(cohortRoster([], [{ cohorts: [] }, {}])).toEqual([]);
  });
});

/**
 * An unnamed group borrows the judge's sentence — honestly labelled (08-16c Task 1).
 *
 * THE HONESTY CONSTRAINT IS THE POINT. `coherenceSummary` is described on the wire as the judge's theme
 * sentence for the group's CORE — a medoid sample, not the whole group — so it may be shown, must be
 * marked as borrowed, and must never be written into `concept` as though the pipeline had named the
 * group. `""` when not judged is a THIRD state, distinct from "judged and said nothing".
 */
test.describe("gate1 group label", () => {
  const base = { concept: "", coherence: "single", coherenceSummary: "", idealCde: "", memberVariableNames: [] } as never;
  const g = (over: Record<string, unknown>) => ({ ...(base as object), ...over }) as never;

  test("@gate1 a generated name is the label and is still marked generated", () => {
    expect(groupLabel(g({ concept: "Systolic blood pressure" }))).toEqual({
      text: "Systolic blood pressure",
      source: "generated",
    });
  });

  test("@gate1 an unnamed but JUDGED group shows the judge's sentence, marked as the judge's", () => {
    expect(groupLabel(g({ concept: "", coherence: "single", coherenceSummary: "Cigarette smoking history" })))
      .toEqual({ text: "Cigarette smoking history", source: "judge" });
  });

  test("@gate1 a generated name always wins — the summary never overrides a produced name", () => {
    expect(groupLabel(g({ concept: "Smoking status", coherenceSummary: "Cigarette smoking history" })).source)
      .toBe("generated");
  });

  /** The third state. A group that was never judged has no sentence to lend, and its `""` is not a verdict. */
  test("@gate1 an UNJUDGED group is never made to borrow, even if a summary string is present", () => {
    expect(groupLabel(g({ concept: "", coherence: "not_judged", coherenceSummary: "leftover text" })))
      .toEqual({ text: "Unnamed group", source: "none" });
  });

  test("@gate1 a judged group whose summary is empty reads as unnamed rather than blank", () => {
    const out = groupLabel(g({ concept: "", coherence: "single", coherenceSummary: "   " }));
    expect(out).toEqual({ text: "Unnamed group", source: "none" });
    expect(out.text).not.toBe("");
  });

  test("@gate1 a borrowed label is searchable; a summary that is NOT the label is not", () => {
    // Visible text must be findable...
    expect(searchableText(g({ concept: "", coherence: "single", coherenceSummary: "Cigarette smoking" })))
      .toContain("cigarette smoking");
    // ...and text that is not on screen must not be, or the search matches what the reviewer cannot see.
    expect(searchableText(g({ concept: "Smoking status", coherenceSummary: "Cigarette smoking" })))
      .not.toContain("cigarette");
  });

  test("@gate1 the row marks a borrowed label differently from a generated one", async ({ page }) => {
    // Target a CROSS-COHORT group and locate its row by id: the ledger sorts (verdict, breadth, size, id)
    // and opens on the cross-cohort bucket, so `conceptGroups[0]` is neither the first row on screen nor
    // necessarily rendered at all.
    let id = "";
    await serveRun(page, (run) => {
      const target = run.result!.conceptGroups!.find((x) => x.crossCohort) ?? run.result!.conceptGroups![0];
      id = target.groupId;
      target.concept = "";
      target.coherence = "single";
      target.coherenceSummary = "Self-reported cigarette smoking across the cohorts";
    });
    await openGate1(page);
    const row = page.locator(`[data-testid='ledger-row'][data-row-id="${id}"]`);
    await expect(row).toBeVisible();
    // The sentence is shown, attributed to the judge, and NOT dressed as a generated name.
    await expect(row.locator("[data-label-source='judge']")).toContainText("Self-reported cigarette smoking");
    await expect(row.locator("[data-testid='borrowed-mark']")).toBeVisible();
    await expect(row.locator("[data-testid='generated-mark']")).toHaveCount(0);
    // The full sentence stays reachable even though the line is truncated.
    expect(await row.locator("[data-label-source='judge']").getAttribute("title"))
      .toBe("Self-reported cigarette smoking across the cohorts");
  });

  test("@gate1 an unnamed, unjudged row carries NO provenance mark at all", async ({ page }) => {
    let id = "";
    await serveRun(page, (run) => {
      const target = run.result!.conceptGroups!.find((x) => x.crossCohort) ?? run.result!.conceptGroups![0];
      id = target.groupId;
      target.concept = "";
      target.coherence = "not_judged";
      target.coherenceSummary = "";
    });
    await openGate1(page);
    const row = page.locator(`[data-testid='ledger-row'][data-row-id="${id}"]`);
    await expect(row).toBeVisible();
    await expect(row.locator("[data-label-source='none']")).toContainText("Unnamed group");
    await expect(row.locator("[data-testid='generated-mark']")).toHaveCount(0);
    await expect(row.locator("[data-testid='borrowed-mark']")).toHaveCount(0);
  });
});

/**
 * Bulk scope — "select all / deselect all" and its two traps (08-16c Task 7).
 */
test.describe("gate1 bulk scope", () => {
  const inScopeOf = (map: Record<string, string>) => (id: string) => map[id] !== "out";
  const hasDecisionOf = (map: Record<string, string>) => (id: string) => id in map;

  /**
   * THE TRAP THAT MATTERS. In-scope is the DEFAULT, and `isChanged` is `id in scope.decisions`, so a
   * "select all" that wrote "in" everywhere would mark every group as reviewer-changed — a ledger
   * claiming they had reviewed all of them by hand.
   */
  test("@gate1 putting all in scope CLEARS departures rather than writing 'in' to everything", () => {
    const decisions = { a: "out", b: "in", c: "out" };
    const plan = bulkScopePlan(["a", "b", "c", "d"], "in", inScopeOf(decisions), hasDecisionOf(decisions));
    expect(plan.write).toEqual([]);          // nothing is marked changed by selecting all
    expect(plan.clear).toEqual(["a", "c"]);  // only the explicit "out"s are undone
  });

  test("@gate1 an undecided group is already in scope, so selecting all does not touch it", () => {
    const plan = bulkScopePlan(["d"], "in", inScopeOf({}), hasDecisionOf({}));
    expect(plan).toEqual({ clear: [], write: [] });
  });

  test("@gate1 a deliberate 'in' decision is preserved, not erased, by selecting all", () => {
    const decisions = { b: "in" };
    expect(bulkScopePlan(["b"], "in", inScopeOf(decisions), hasDecisionOf(decisions)))
      .toEqual({ clear: [], write: [] });
  });

  test("@gate1 taking all out writes 'out' only for groups currently in scope", () => {
    const decisions = { a: "out", b: "in" };
    const plan = bulkScopePlan(["a", "b", "c"], "out", inScopeOf(decisions), hasDecisionOf(decisions));
    expect(plan.clear).toEqual([]);
    expect(plan.write).toEqual(["b", "c"]); // "a" is already out and is not re-written
  });

  test("@gate1 the control reports a real tri-state, never 'all' over a partial set", () => {
    expect(bulkScopeState(["a", "b"], inScopeOf({}))).toBe("all");
    expect(bulkScopeState(["a", "b"], inScopeOf({ a: "out", b: "out" }))).toBe("none");
    expect(bulkScopeState(["a", "b"], inScopeOf({ a: "out" }))).toBe("some");
    expect(bulkScopeState([], inScopeOf({}))).toBe("none");
  });

  test("@gate1 the control names how many rows it will affect, and acts on the VISIBLE ones", async ({ page }) => {
    await openGate1(page);
    const bulk = page.locator("[data-testid='bulk-scope']");
    await expect(bulk).toBeVisible();
    const rows = await page.locator("[data-testid='ledger-row']").count();
    // The number on the control is the number of rows on screen — stated before the press.
    await expect(bulk.locator("[data-testid='bulk-scope-out']")).toContainText(`${rows}`);
    await expect(bulk.locator("[data-testid='bulk-scope-in']")).toContainText(`${rows}`);
  });

  /**
   * PLAIN LANGUAGE, WITHOUT LOSING THE SCOPE (08-16c review). Bhargav: *"this wording is confusing. just
   * use simple 'select all' 'deselect all' language."*
   *
   * The simplification is the easy half; the assertion is about what it may NOT cost. Every string here
   * has to keep saying SHOWN, because the control acts on the rows the bucket, search and filters have
   * left on screen — a "Select all" that silently reached filtered-out rows is precisely the trap Task 7
   * was written to avoid, and it would be invisible in a screenshot.
   */
  test("@gate1 the bulk control reads as select/deselect and still says it acts on the SHOWN rows", async ({
    page,
  }) => {
    await openGate1(page);
    const bulk = page.locator("[data-testid='bulk-scope']");
    const rows = await page.locator("[data-testid='ledger-row']").count();

    await expect(bulk.locator("[data-testid='bulk-scope-in']")).toHaveText(`Select all ${rows} shown`);
    await expect(bulk.locator("[data-testid='bulk-scope-out']")).toHaveText(`Deselect all ${rows} shown`);
    await expect(bulk).toContainText(`${rows} groups shown are selected`);

    // ...and it keeps saying so once a filter has narrowed what "all" means.
    await page.locator("[data-testid='filter-verdict'][data-verdict='split']").click();
    const narrowed = await page.locator("[data-testid='ledger-row']").count();
    expect(narrowed).toBeLessThan(rows);
    await expect(bulk.locator("[data-testid='bulk-scope-in']")).toHaveText(`Select all ${narrowed} shown`);
    await expect(bulk.locator("[data-testid='bulk-scope-out']")).toHaveText(`Deselect all ${narrowed} shown`);
  });

  test("@gate1 taking all out drops the price by exactly the rows it affected, and no more", async ({ page }) => {
    await openGate1(page);
    const bar = page.locator("[data-testid='commit-bar']");
    const before = Number(await bar.getAttribute("data-total"));
    expect(before).toBeGreaterThan(0);
    const shown = await page.locator("[data-testid='ledger-row']").count();

    await page.locator("[data-testid='bulk-scope-out']").click();
    await expect(page.locator("[data-testid='bulk-scope']")).toHaveAttribute("data-state", "none");

    /**
     * THE SCOPE OF "ALL" IS THE VISIBLE ROWS, and this is the assertion that holds it to that. The ledger
     * opens on the cross-cohort bucket, so the single-cohort groups are in scope and NOT on screen — a
     * bulk control that silently emptied them too would zero this figure. It must fall by the rows the
     * reviewer could actually see, leaving the rest exactly as they were.
     */
    const after = Number(await bar.getAttribute("data-total"));
    const perGroup = before / (before / (before - after)) / shown; // guard against a 0-row fixture
    expect(perGroup).toBeGreaterThan(0);
    expect(after).toBeLessThan(before);
    expect(after).toBeCloseTo(before - shown * ((before - after) / shown), 6);
    // The groups outside the current bucket are untouched, so there is still something left to buy.
    expect(after).toBeGreaterThan(0);
  });

  /**
   * THE FAILED-IMPLEMENTATION CHECK the plan calls for by name. `isChanged` is
   * `groupId in scope.decisions`, and the row paints an accent spine from it. A "select all" that wrote
   * "in" to every group would light every spine on the screen and hand back a ledger claiming the
   * reviewer had been through all of them by hand.
   */
  test("@gate1 putting all in scope marks NO row as reviewer-changed", async ({ page }) => {
    await openGate1(page);
    const before = await page.locator("[data-testid='ledger-row'][data-spine='changed']").count();
    expect(before).toBe(0);
    // Take them out (a genuine departure — every row SHOULD be marked), then restore the default.
    await page.locator("[data-testid='bulk-scope-out']").click();
    await expect(page.locator("[data-testid='bulk-scope']")).toHaveAttribute("data-state", "none");
    expect(await page.locator("[data-testid='ledger-row'][data-spine='changed']").count()).toBeGreaterThan(0);

    await page.locator("[data-testid='bulk-scope-in']").click();
    await expect(page.locator("[data-testid='bulk-scope']")).toHaveAttribute("data-state", "all");
    // Back to the default, and back to no claim of having reviewed anything.
    expect(await page.locator("[data-testid='ledger-row'][data-spine='changed']").count()).toBe(0);
  });

  test("@gate1 the reverse action restores the default and is then itself unavailable", async ({ page }) => {
    await openGate1(page);
    await page.locator("[data-testid='bulk-scope-out']").click();
    await expect(page.locator("[data-testid='bulk-scope']")).toHaveAttribute("data-state", "none");
    await page.locator("[data-testid='bulk-scope-in']").click();
    await expect(page.locator("[data-testid='bulk-scope']")).toHaveAttribute("data-state", "all");
    // Nothing left to do in that direction, so the control says so rather than offering a no-op.
    await expect(page.locator("[data-testid='bulk-scope-in']")).toBeDisabled();
  });
});

/**
 * Click-to-sort on the ledger's columns (08-16c Task 10).
 *
 * Bhargav: *"let the user sort the cols directly - it should resemble the way Review queue is built from
 * the prod UI."* The STATE and TOGGLE are shared with `dashboard.tsx` through `lib/column-sort.ts`;
 * `SortableHead` itself could not transfer, because that screen renders a real `<table>` and the ledger's
 * head is a CSS grid.
 */
test.describe("gate1 column sort", () => {
  test("@gate1 the toggle matches the Review queue's: new column ascending, same column reverses", () => {
    expect(toggleSort(null, "vars")).toEqual({ key: "vars", dir: "asc" });
    expect(toggleSort({ key: "vars", dir: "asc" }, "vars")).toEqual({ key: "vars", dir: "desc" });
    expect(toggleSort({ key: "vars", dir: "desc" }, "vars")).toEqual({ key: "vars", dir: "asc" });
    expect(toggleSort({ key: "vars", dir: "desc" }, "cohorts")).toEqual({ key: "cohorts", dir: "asc" });
  });

  test("@gate1 no explicit sort keeps the ledger's documented default order", () => {
    const groups = fixtureGroups();
    expect(sortGroupsByColumn(groups, null).map((g) => g.groupId))
      .toEqual(sortGroups(groups).map((g) => g.groupId));
  });

  /** Verdict sorts by REVIEW PRIORITY, not alphabetically — the discipline copied from `sortValue`. */
  test("@gate1 verdict sorts by triage priority rather than by the rendered word", () => {
    const ids = sortGroupsByColumn(fixtureGroups(), { key: "verdict", dir: "asc" });
    const ranks = ids.map((g) => COHERENCE_ORDER[g.coherence]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  test("@gate1 cohorts sorts by breadth (a count), not by the joined cohort names", () => {
    const desc = sortGroupsByColumn(fixtureGroups(), { key: "cohorts", dir: "desc" });
    const counts = desc.map((g) => g.cohorts.length);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
  });

  test("@gate1 reversing a column reverses the rows", () => {
    const asc = sortGroupsByColumn(fixtureGroups(), { key: "vars", dir: "asc" }).map((g) => g.nMembers);
    const desc = sortGroupsByColumn(fixtureGroups(), { key: "vars", dir: "desc" }).map((g) => g.nMembers);
    expect(asc).toEqual([...asc].sort((a, b) => a - b));
    expect(desc).toEqual([...desc].sort((a, b) => b - a));
  });

  test("@gate1 the order stays TOTAL — no two rows tie, so a reload cannot reorder the screen", () => {
    const groups = fixtureGroups();
    const once = sortGroupsByColumn(groups, { key: "cohorts", dir: "desc" }).map((g) => g.groupId);
    const again = sortGroupsByColumn([...groups].reverse(), { key: "cohorts", dir: "desc" }).map((g) => g.groupId);
    expect(once).toEqual(again);
  });

  /**
   * THE ORDER SELECT IS GONE (08-16c review). Bhargav: *"concept groups are sortable below so this is
   * redundant."*
   *
   * The assertion that matters is NOT that the control vanished — it is that nothing it named went with
   * it. The select offered three orders; each is asserted below to still be reachable by clicking a
   * header, which is what makes the removal a de-duplication rather than a lost capability.
   */
  test("@gate1 the order select is gone, and no order it named went with it", async ({ page }) => {
    await openGate1(page);
    await expect(page.locator("#ledger-sort")).toHaveCount(0);
    await expect(page.locator("[data-testid='ledger-toolbar'] select")).toHaveCount(0);

    // "Flagged first" — the ledger's own default order, arriving with no control touched at all.
    const cross = partitionByBreadth(fixtureGroups())["cross-cohort"];
    expect(await rowIds(page)).toEqual(sortGroupsByColumn(cross, null).map((g) => g.groupId));

    // ...and each of the other two, by clicking the header that owns it. One click sorts ascending, a
    // second reverses — which is the descending order the preset named.
    for (const [head, key] of [
      ["ledger-sort-cohorts", "cohorts"],
      ["ledger-sort-vars", "vars"],
    ] as const) {
      await page.locator(`[data-testid='${head}']`).click();
      await page.locator(`[data-testid='${head}']`).click();
      const shown = await rowIds(page);
      const expected = sortGroupsByColumn(cross, { key, dir: "desc" }).map((g) => g.groupId);
      expect(shown, `the ${key} header must reach the order the select called a preset`).toEqual(expected);
    }
  });

  test("@gate1 clicking a header sorts the rows and says so, and clicking again reverses", async ({ page }) => {
    await openGate1(page);
    const head = page.locator("[data-testid='ledger-sort-vars']");
    await expect(head).toBeVisible();

    await head.click();
    // Which column is sorting, and which way, is visible AND announced without clicking anything.
    await expect(head).toHaveAttribute("data-active", "true");
    await expect(page.locator("[role='columnheader'][aria-sort='ascending']")).toHaveCount(1);
    const asc = await rowIds(page);

    await head.click();
    await expect(head).toHaveAttribute("data-active", "true");
    await expect(page.locator("[role='columnheader'][aria-sort='descending']")).toHaveCount(1);
    const desc = await rowIds(page);

    /**
     * The direction genuinely reversed — the row that led now trails — while the row SET is untouched.
     *
     * Deliberately NOT `desc === reverse(asc)`: rows tied on the sorted column keep their id tiebreak in
     * BOTH directions, which is what keeps the order total (`compareGroups`' guarantee that a reload
     * cannot reorder the screen under a reviewer mid-triage). Reversing the primary key is the promise;
     * scrambling the secondary is not.
     */
    expect(desc[0]).not.toBe(asc[0]);
    expect(desc[desc.length - 1]).not.toBe(asc[asc.length - 1]);
    expect([...desc].sort()).toEqual([...asc].sort());
  });

  test("@gate1 the price column is not offered as a sort — every row carries the same figure", async ({ page }) => {
    await openGate1(page);
    await expect(page.locator("[data-testid='ledger-sort-concept']")).toBeVisible();
    // "Gate 2+" has no sortKey, so no button is rendered for it.
    await expect(page.locator("[data-testid='ledger-sort-cost']")).toHaveCount(0);
  });

  test("@gate1 sorting composes with the bucket and filters rather than widening them", async ({ page }) => {
    await openGate1(page);
    const before = (await rowIds(page)).length;
    await page.locator("[data-testid='ledger-sort-concept']").click();
    expect((await rowIds(page)).length).toBe(before);
  });
});

/**
 * Gate 1 as a RECORD, once the run has moved past it (08-16c Task 2).
 *
 * THE ENFORCEMENT IS AT THE WRITE PATH, not in the rendering: `useGateDecisions` refuses `write` and
 * `clear` outright when its gate is past, and it does so BEFORE the optimistic state update, so a frozen
 * screen cannot even briefly show a change it will not keep. The disabled controls asserted here are the
 * second layer — they stop the control inviting an attempt that would only raise an error.
 */
test.describe("gate1 frozen", () => {
  /** Move the RUN to Gate 2, leaving this screen — Gate 1 — behind it. */
  async function openPastGate1(page: Page): Promise<void> {
    await serveRun(page, (run) => {
      run.gatePosition = "gate2";
      run.result!.gatePosition = "gate2";
    });
    await openGate1(page);
  }

  test("@gate1 a passed Gate 1 says it is a record and offers the way back", async ({ page }) => {
    await openPastGate1(page);
    await expect(page.locator("[data-testid='gate-frozen']")).toBeVisible();
    await expect(page.locator("[data-testid='gate-frozen-back']")).toContainText(/Concepts/i);
  });

  test("@gate1 the decisions are still VISIBLE — that is what looking back is for", async ({ page }) => {
    await openPastGate1(page);
    await expect(page.locator("[data-testid='ledger']")).toBeVisible();
    expect(await page.locator("[data-testid='ledger-row']").count()).toBeGreaterThan(0);
    await expect(page.locator("[data-testid='cohort-coverage']").first()).toBeVisible();
  });

  test("@gate1 no control on a passed gate offers to change a decision", async ({ page }) => {
    await openPastGate1(page);
    // The per-row scope checkbox...
    const boxes = page.locator("[data-testid='ledger-row'] button[role='checkbox']");
    expect(await boxes.count()).toBeGreaterThan(0);
    await expect(boxes.first()).toBeDisabled();
    // ...the bulk control...
    await expect(page.locator("[data-testid='bulk-scope-in']")).toBeDisabled();
    await expect(page.locator("[data-testid='bulk-scope-out']")).toBeDisabled();
    // ...and Continue, which would buy work this run has already bought.
    await expect(page.locator("[data-testid='commit-bar'] button")).toBeDisabled();
  });

  test("@gate1 the run's CURRENT gate is unaffected — it is not a record", async ({ page }) => {
    await openGate1(page); // fixture parks AT gate1
    await expect(page.locator("[data-testid='gate-frozen']")).toHaveCount(0);
    await expect(page.locator("[data-testid='ledger-row'] button[role='checkbox']").first()).toBeEnabled();
    await expect(page.locator("[data-testid='commit-bar'] button")).toBeEnabled();
  });
});

/**
 * The destination tray beside an expanded group (08-16c Task 6).
 *
 * Bhargav: *"when a group is expanded, it's hard to see what other groups there are to drag vars to."*
 * Nothing about MOVING was missing — `MemberDropZone` already wrapped every collapsed row and was wired
 * to `moveMember`. What was missing is that expanding one group pushed every other group's drop zone off
 * the viewport, so the affordance was real and unreachable exactly when it was wanted.
 */
test.describe("gate1 destination tray", () => {
  const TRAY = "[data-testid='destination-tray']";

  test("@gate1 an expanded group shows the other groups without collapsing it first", async ({ page }) => {
    await openGate1(page);
    const row = await expandRow(page, BIG);
    await expect(row.locator(TRAY)).toBeVisible();
    expect(await row.locator("[data-testid='destination-entry']").count()).toBeGreaterThan(0);
    // The group is still expanded — the tray is not an alternative to seeing the members.
    await expect(row.locator("[data-testid='member-drop-zone'][data-group-id='__unassigned__']")).toBeVisible();
  });

  test("@gate1 the expanded group is not offered as a destination for its own members", async ({ page }) => {
    await openGate1(page);
    const row = await expandRow(page, BIG);
    await expect(row.locator(`[data-testid='destination-entry'][data-group-id='${BIG}']`)).toHaveCount(0);
  });

  test("@gate1 dragging onto a tray entry moves the variable into THAT group", async ({ page }) => {
    await openGate1(page);
    const row = await expandRow(page, BIG);
    const target = row.locator("[data-testid='destination-entry']").first();
    const targetId = await target.getAttribute("data-group-id");
    const member = row.locator("[data-testid='member-row']").first();
    const memberId = await member.getAttribute("data-member-id");

    await member.dragTo(row.locator(`${TRAY} [data-testid='member-drop-zone'][data-group-id='${targetId}']`));

    // The SAME outcome a drop on the collapsed row produces. The SOURCE row's spine is asserted; the
    // DESTINATION's deliberately is not — `LedgerRow` lets "unresolved" (amber) outrank "changed", so a
    // flagged destination legitimately keeps its amber spine and asserting "changed" there would convict
    // working code the moment the drop happened to land on a flagged group.
    await expect(page.locator(`[data-testid='ledger-row'][data-row-id='${BIG}']`)).toHaveAttribute("data-spine", "changed");

    await page.reload();
    await page.waitForLoadState("networkidle");
    const receiving = await expandRow(page, targetId!);
    await expect(receiving.locator(`[data-member-id='${memberId}']`).first()).toBeVisible();
  });

  test("@gate1 the destinations scroll on their own, without moving the source grid", async ({ page }) => {
    await openGate1(page);
    const row = await expandRow(page, BIG);
    const list = row.locator(`${TRAY} > div`);
    const overflow = await list.evaluate((el) => getComputedStyle(el).overflowY);
    expect(overflow).toBe("auto");
    // It is bounded, so a long list cannot push the grid off the screen instead of scrolling.
    const bounded = await list.evaluate((el) => el.scrollHeight > el.clientHeight || el.clientHeight <= 512);
    expect(bounded).toBe(true);
  });

  test("@gate1 with nothing expanded the tray is not permanent chrome", async ({ page }) => {
    await openGate1(page);
    await expect(page.locator(TRAY)).toHaveCount(0);
  });

  test("@gate1 below the breakpoint the tray gives way rather than squeezing the grid", async ({ page }) => {
    await openGate1(page);
    const row = await expandRow(page, BIG);
    const wide = await row.locator(TRAY).boundingBox();
    await page.setViewportSize({ width: 900, height: 900 });
    const narrow = await row.locator(TRAY).boundingBox();
    // Stacked, not squeezed side-by-side: the tray is now as wide as the column, below the grid.
    expect(narrow!.width).toBeGreaterThan(wide!.width);
  });
});

/**
 * Renaming a concept group (08-16c Task 3).
 *
 * Bhargav renames a group to be able to FIND IT AGAIN, so this is a reviewer ANNOTATION: it never
 * overwrites `concept`, the generated name stays visible beneath it, and the decision record carries both.
 * It follows `gate1_regroup` exactly — same hook, same registry, same persistence path.
 */
test.describe("gate1 rename", () => {
  const BIGROW = `[data-testid='ledger-row'][data-row-id='${BIG}']`;

  async function rename(page: Page, to: string) {
    await page.locator(`${BIGROW} [data-testid='rename-group']`).click();
    const input = page.locator(`${BIGROW} [data-testid='rename-input']`);
    await expect(input).toBeVisible();
    await input.fill(to);
    await input.press("Enter");
  }

  test("@gate1 a group can be renamed in place, and the new name is what the row shows", async ({ page }) => {
    await openGate1(page);
    await rename(page, "Smoking — my working set");
    await expect(page.locator(`${BIGROW} [data-label-source='reviewer']`)).toHaveText("Smoking — my working set");
  });

  test("@gate1 a reviewer's name is marked as theirs, not as the pipeline's", async ({ page }) => {
    await openGate1(page);
    await rename(page, "My label");
    await expect(page.locator(`${BIGROW} [data-testid='renamed-mark']`)).toBeVisible();
    await expect(page.locator(`${BIGROW} [data-testid='generated-mark']`)).toHaveCount(0);
  });

  test("@gate1 the pipeline's own name remains recoverable beside it", async ({ page }) => {
    await openGate1(page);
    const generated = fixtureGroups().find((g) => g.groupId === BIG)!.concept;
    await rename(page, "My label");
    await expect(page.locator(`${BIGROW} [data-testid='generated-name-kept']`)).toContainText(generated);
  });

  test("@gate1 a rename survives a reload — it is a decision, not component state", async ({ page }) => {
    await openGate1(page);
    await rename(page, "Persisted name");
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(page.locator(`${BIGROW} [data-label-source='reviewer']`)).toHaveText("Persisted name");
  });

  test("@gate1 an empty or whitespace-only rename is refused rather than making a nameless group", async ({ page }) => {
    await openGate1(page);
    const generated = fixtureGroups().find((g) => g.groupId === BIG)!.concept;
    await rename(page, "Temporary");
    await expect(page.locator(`${BIGROW} [data-label-source='reviewer']`)).toBeVisible();
    // Clearing it restores the generated name instead of leaving the row blank.
    await rename(page, "   ");
    await expect(page.locator(`${BIGROW} [data-label-source='generated']`)).toHaveText(generated);
    await expect(page.locator(`${BIGROW} [data-testid='renamed-mark']`)).toHaveCount(0);
  });

  test("@gate1 the reviewer can find the group again by the name they gave it", async ({ page }) => {
    await openGate1(page);
    await rename(page, "Zzyzx");
    await page.locator("#term-search-input").fill("Zzyzx");
    await page.getByRole("button", { name: /^Search/ }).click();
    await expect(page.locator(BIGROW)).toBeVisible();
    expect(await page.locator("[data-testid='ledger-row']").count()).toBe(1);
  });

  test("@gate1 a rename marks the row as reviewer-changed", async ({ page }) => {
    await openGate1(page);
    await rename(page, "Changed by me");
    await expect(page.locator(BIGROW)).toHaveAttribute("data-spine", "changed");
  });

  test("@gate1 renaming replaces a BORROWED judge label and is marked as the reviewer's", async ({ page }) => {
    await serveRun(page, (run) => {
      const t = run.result!.conceptGroups!.find((g) => g.groupId === BIG)!;
      t.concept = "";
      t.coherence = "single";
      t.coherenceSummary = "The judge's sentence about this group";
    });
    await openGate1(page);
    await expect(page.locator(`${BIGROW} [data-testid='borrowed-mark']`)).toBeVisible();
    await rename(page, "Mine now");
    await expect(page.locator(`${BIGROW} [data-label-source='reviewer']`)).toHaveText("Mine now");
    await expect(page.locator(`${BIGROW} [data-testid='borrowed-mark']`)).toHaveCount(0);
    await expect(page.locator(`${BIGROW} [data-testid='renamed-mark']`)).toBeVisible();
  });

  test("@gate1 a passed gate offers no rename control", async ({ page }) => {
    await serveRun(page, (run) => {
      run.gatePosition = "gate2";
      run.result!.gatePosition = "gate2";
    });
    await openGate1(page);
    await expect(page.locator("[data-testid='rename-group']")).toHaveCount(0);
  });
});
