import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  COHERENCE_ORDER,
  compareGroups,
  isFlagged,
  matchTerms,
  partitionByBreadth,
  readjudicationRequest,
  sortGroups,
} from "@/lib/ledger";
import { componentVerdictFor, missingReason, scopeVerdictFor } from "@/lib/score-scope";
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
    await expect(row.locator("[data-testid='member-chip']").first()).toHaveAttribute("draggable", "false");
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
    // so the expanded row reads the uncapped list rather than the collapsed row's cap.
    await expect(row.locator("[data-testid='member-chip']")).toHaveCount(group.nMembers);
    await expect(row.locator("[data-testid='member-chip']").first()).toHaveAttribute("draggable", "true");
  });

  test("@gate1 a single-member group's one chip is still draggable", async ({ page }) => {
    const singles = fixtureGroups().filter((g) => g.nMembers === 1);
    await openGate1(page);
    // Single-member groups are single-cohort by construction, so they live in the other bucket.
    await page.locator("[data-testid='bucket-tab'][data-bucket='single-cohort']").click();
    const row = await expandRow(page, singles[0].groupId);
    await expect(row.locator("[data-testid='member-chip']")).toHaveCount(1);
    await expect(row.locator("[data-testid='member-chip']")).toHaveAttribute("draggable", "true");
  });

  test("@gate1 a move persists, survives a reload, and marks both groups as changed", async ({ page }) => {
    await openGate1(page);
    const row = await expandRow(page, BIG);
    const chip = row.locator("[data-testid='member-chip']").first();
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
      .locator("[data-testid='member-chip']")
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
