import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  COHERENCE_ORDER,
  sortGroupsByColumn,
  sortDestinations,
  unplacedFields,
  effectiveMembers,
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
import {
  componentVerdictFor,
  missingReason,
  scopeVerdictFor,
} from "@/lib/score-scope";
import { COHERENCE_COPY } from "@/components/gate/CoherenceMark";
import { toggleSort } from "@/lib/column-sort";
import { isOver, nextDepth } from "@/lib/drop-highlight";
import type {
  CoherenceState,
  ComponentCoding,
  CompositeSpec,
  ConceptGroup,
} from "@/types";
import {
  PAUSED_JOB,
  fixtureGroups,
  gate1Fixture,
  serveRun,
} from "./gate1-fixture";

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
  return page
    .locator("[data-testid='ledger-row']")
    .evaluateAll((els) =>
      els.map((el) => el.getAttribute("data-row-id") ?? ""),
    );
}

/** The computed colour and weight of a coherence cell — the pair T-08-86 requires to be identical. */
async function markStyle(
  cell: Locator,
): Promise<{ color: string; weight: string }> {
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
    const flagged = fixtureGroups().filter(
      (g) => g.crossCohort && g.coherence === "split",
    );
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
    expect(
      groups
        .filter((g) => g.coherence === "not_judged")
        .every((g) => !isFlagged(g)),
    ).toBe(true);
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
    /**
     * The label is the GENERATED concept name, and the row marks that by saying NOTHING (08-16c review).
     *
     * Bhargav: *"if everything has this generated tag then it has no value, right?"* Generated is the
     * default, so the pill was on every row of an untouched run and carried no signal. The provenance
     * the row still states is the machine-readable one, which is what a screen-reader user and this
     * spec both read; the PILLS are reserved for the two exceptions, asserted below.
     */
    await expect(
      first.locator("[data-label-source='generated']"),
    ).toBeVisible();
    await expect(first.locator("[data-testid='generated-mark']")).toHaveCount(
      0,
    );
    // Provenance moved to the detail pane in the workbench (08-16f); select the row to read it.
    await first.click();
    const provenance = page.locator(
      "[data-testid='gate1-detail'] [data-testid='row-provenance']",
    );
    await expect(provenance).toBeVisible();
    await expect(provenance).toContainText(/from cluster/i);

    // No catalog badge, no identifier link, no endorsement — and never the word GenCDE, which is a
    // different artifact minted much later and only for `novel` records.
    await expect(first.locator("a")).toHaveCount(0);
    await expect(page.locator("[data-testid='ledger']")).not.toContainText(
      /GenCDE/i,
    );
    await expect(page.locator("[data-testid='ledger']")).not.toContainText(
      /\bCDE:[A-Za-z0-9]/,
    );
  });

  test("@gate1 the not-judged cell differs from a judged one by FORM, never by dimness", async ({
    page,
  }) => {
    await openGate1(page);
    // T-08-86. A group the judge was never asked about must not read as one it approved — and rendering
    // the absence dimmer reads as "less important, therefore fine", which is that exact misread.
    const judged = page
      .locator("[data-testid='coherence-mark'][data-coherence='single']")
      .first();
    const unjudged = page
      .locator("[data-testid='coherence-mark'][data-coherence='not_judged']")
      .first();
    await expect(judged).toBeVisible();
    await expect(unjudged).toBeVisible();

    const a = await markStyle(judged);
    const b = await markStyle(unjudged);
    expect(b.weight).toBe(a.weight);
    // The LABEL colour is what a reviewer reads as importance. `single` is drawn in the ok role and
    // `not_judged` in the muted one, so the pair that must match is the unjudged cell against the
    // NEUTRAL judged cell — a `qualify` verdict is warn-coloured because it is a verdict.
    const anyJudgedWeight = await markStyle(
      page
        .locator("[data-testid='coherence-mark'][data-coherence='qualify']")
        .first(),
    );
    expect(anyJudgedWeight.weight).toBe(b.weight);

    // And the difference that IS allowed: the marker's shape.
    const shape = await unjudged
      .locator("span[aria-hidden='true']")
      .first()
      .evaluate((el) => {
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

    // The $0 detector fires from 2 members up. It rides the rows the judge skips (not_judged) AND, since
    // 08-16f, a CHECKED single group it suspects is a battery (coherent ≠ harmonizable) — but never a
    // FLAGGED verdict (split/qualify/incoherent), where reading a suspicion as an adjudication is the risk.
    const rowsWithMark = page.locator(
      "[data-testid='ledger-row']:has([data-testid='template-suspicion'])",
    );
    const states = await rowsWithMark
      .locator("[data-testid='coherence-mark']")
      .evaluateAll((els) => els.map((el) => el.getAttribute("data-coherence")));
    expect(states.length).toBeGreaterThan(0);
    for (const st of states) expect(["not_judged", "single"]).toContain(st);

    // It is a suspicion, not an adjudication: the copy says which, and it is not styled as a verdict.
    await expect(marks.first()).toHaveText(/repeating template/i);
    await expect(marks.first()).toHaveAttribute("data-signal", "deterministic");
  });

  test("@gate1 the spine ranks an unresolved judgment above a correction the reviewer made", async ({
    page,
  }) => {
    await openGate1(page);
    // Amber = the judge flagged this and nobody resolved it. The action colour = you changed it. Both,
    // and amber wins: a reviewer who edited a flagged group still has an open judgment to resolve.
    const flagged = page.locator(
      "[data-testid='ledger-row'][data-spine='unresolved']",
    );
    await expect(flagged.first()).toBeVisible();
    const flaggedIds = await flagged.evaluateAll((els) =>
      els.map((el) => el.getAttribute("data-row-id")),
    );
    const expected = fixtureGroups()
      .filter((g) => isFlagged(g))
      .map((g) => g.groupId);
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
      els.map(
        (el) =>
          `${el.getAttribute("aria-label") ?? ""} ${el.textContent ?? ""}`,
      ),
    );
    expect(
      names.filter((n) =>
        /cluster size|min_?cluster|granularity|re-?cluster/i.test(n),
      ),
    ).toEqual([]);
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
    const order = await lines.evaluateAll((els) =>
      els.map((el) => el.getAttribute("data-sum-line")),
    );
    expect(order).toEqual(["realized", "in-scope", "whole-corpus"]);

    const realized = sum.locator("[data-sum-line='realized']");
    const forecast = sum.locator("[data-sum-line='in-scope']");
    await expect(realized).toContainText(/already spent/i);
    // Distinct by more than position: the realized line carries its own weight, so the two cannot be
    // read in the same voice.
    const weights = await Promise.all(
      [realized, forecast].map((l) =>
        l.evaluate((el) => getComputedStyle(el).fontWeight),
      ),
    );
    expect(weights[0]).not.toBe(weights[1]);

    // Scoping is legible only against a denominator, so the comparison is shown too.
    await expect(sum.locator("[data-sum-line='whole-corpus']")).toContainText(
      /all \d+ (concept )?groups/i,
    );
  });

  test("@gate1 a single-member group is a row, not noise to collapse away", async ({
    page,
  }) => {
    // 380 of the demo's 535 groups have exactly one variable. A screen that hid them would be hiding
    // most of the run.
    const singles = fixtureGroups().filter((g) => g.nMembers === 1);
    expect(singles.length).toBeGreaterThan(0);
    await serveRun(page, (run) => {
      run.result!.conceptGroups = singles;
    });
    await openGate1(page);
    // The default view shows ALL groups now (08-16f: no bucket tabs), so single-cohort groups are on
    // screen immediately — they are rows, not noise hidden behind a tab.
    await expect(page.locator("[data-testid='ledger-row']")).toHaveCount(
      singles.length,
    );
    await expect(
      page.locator("[data-testid='ledger-row']").first(),
    ).toContainText(/1 var\b/);
  });

  test("@gate1 the row's variable count is the TRUE count even when the sample is capped", async ({
    page,
  }) => {
    // T-08-89: regrouping against a partial sample would silently drop the members it never showed, so
    // the collapsed row must never report the sample's length as the group's size.
    await serveRun(page, (run) => {
      const g = run.result!.conceptGroups!.find(
        (x) => x.groupId === "c8331409f61e1#g0",
      )!;
      g.nMembers = 137;
      g.membersTruncated = true;
      // …and the run does NOT carry the uncapped list, which is the case the count must survive.
      delete run.result!.conceptGroupMembers![g.groupId];
    });
    await openGate1(page);
    // Named by ROW ID, not by position: the ledger sorts, so the group mutated above is not the first row.
    const row = page.locator(
      "[data-testid='ledger-row'][data-row-id='c8331409f61e1#g0']",
    );
    await expect(row).toContainText("137");
    // …and the sample it was capped from is smaller, so this is a real distinction rather than a tautology.
    expect(
      fixtureGroups().find((g) => g.groupId === "c8331409f61e1#g0")!
        .memberVariableNames.length,
    ).toBeLessThan(137);

    // AND THE MOVE IS WITHHELD. With only a sample on the wire, offering a regroup would silently drop
    // every member past the cap — so the verb is withdrawn and the reason is stated.
    await row.click();
    const detail = page.locator("[data-testid='gate1-detail']");
    await expect(detail.locator("[data-testid='not-available']")).toBeVisible();
    await expect(
      detail.locator("[data-testid='member-drop-zone']"),
    ).toHaveCount(0);
    // Since 08-14h the membership IS the evidence grid, so the withdrawal is expressed by that grid
    // carrying no drag affordance at all — no draggable rows, no drop destination, no keyboard remove.
    // A stronger form of the same rule than the un-draggable chip it replaces.
    await expect(detail.locator("[data-testid='source-rows']")).toBeVisible();
    await expect(detail.locator("[data-testid='member-row']")).toHaveCount(0);
    await expect(detail.locator("[data-testid='member-remove']")).toHaveCount(
      0,
    );
    await expect(detail.locator("[data-testid='member-chip']")).toHaveCount(0);
  });
});

// --- the documented empty states --------------------------------------------------------------------------

test.describe("gate1 empty", () => {
  test("@gate1 gate1 empty — zero groups says what happened and where to go", async ({
    page,
  }) => {
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
    await expect(
      page.locator("[data-testid='commit-bar'] button"),
    ).toBeDisabled();
  });

  test("@gate1 gate1 empty — all outliers is its own state and lists what fell out", async ({
    page,
  }) => {
    await serveRun(page, (run) => {
      run.result!.conceptGroups = [];
      run.result!.conceptGroupMembers = {};
      run.result!.unassignedFields = [
        {
          id: "UKBB:21001",
          cohort: "UKBB",
          variable: "21001",
          text: "Body mass index (BMI)",
        },
        {
          id: "MESA:bmi1c",
          cohort: "MESA",
          variable: "bmi1c",
          text: "Body mass index",
        },
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
    //
    // RE-POINTED at the ONE pool (08-16c review). This used to be its own `unassigned-variable` list,
    // rendered only when the run produced no groups — so a run WITH groups showed the clustering's
    // leftovers nowhere at all. They now live in the shared pool on every run, under the origin label
    // that says the clustering, not the reviewer, left them out.
    const pool = page.locator("[data-testid='unassigned-pool']");
    // OPEN ALREADY, and that is the assertion rather than staging (08-16c item A). The pool is a
    // disclosure now, but on a run that grouped NOTHING it is the whole screen — and the empty state
    // above has just promised the reviewer that what fell out is "listed below". A closed pool would
    // make that copy false.
    await expect(pool.locator("[data-testid='pool-body']")).toBeVisible();
    const listed = pool.locator(
      "[data-testid='pool-pipeline'] :is([data-testid='member-row'],[data-testid='member-chip'])",
    );
    await expect(listed).toHaveCount(2);
    await expect(listed.first()).toContainText("21001");
    await expect(pool.locator("[data-testid='pool-pipeline']")).toContainText(
      "Body mass index (BMI)",
    );
    // Nothing is attributed to the reviewer, who has done nothing on this run.
    await expect(pool.locator("[data-testid='pool-reviewer']")).toHaveCount(0);
  });
});

// --- the partition, and making a large set tractable (Task 2) ---------------------------------------------

test.describe("gate1 partition", () => {
  test("@gate1 the buckets sum to the total — a row belongs to exactly one and none is dropped", () => {
    const groups = fixtureGroups();
    const { "cross-cohort": cross, "single-cohort": single } =
      partitionByBreadth(groups);
    expect(cross.length + single.length).toBe(groups.length);
    // Partitioned on the CONTRACT BOOLEAN, which is already on the wire — no field added, and no
    // recomputation from `cohorts` that could disagree with the backend's own answer.
    expect(cross.every((g) => g.crossCohort)).toBe(true);
    expect(single.every((g) => !g.crossCohort)).toBe(true);
    expect(new Set([...cross, ...single].map((g) => g.groupId)).size).toBe(
      groups.length,
    );
  });

  test("@gate1 the default view is every group; cross-cohort-only narrows to the harmonization subset", async ({
    page,
  }) => {
    await openGate1(page);
    const { "cross-cohort": cross, "single-cohort": single } =
      partitionByBreadth(fixtureGroups());
    expect(single.length).toBeGreaterThan(0);

    // 08-16f: the default shows ALL groups (the bucket tab strip is gone). The cross-cohort-only toggle
    // narrows to the harmonization subset — a single-cohort group is CDE-mapping, not pooling, and the
    // two are scored separately, never blended.
    await expect(page.locator("[data-testid='ledger-row']")).toHaveCount(
      cross.length + single.length,
    );

    const toggle = page.locator("[data-testid='cross-cohort-toggle']");
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("[data-testid='ledger-row']")).toHaveCount(
      cross.length,
    );
    // Toggling back restores every group — the other set was never hidden, just a click away.
    await toggle.click();
    await expect(page.locator("[data-testid='ledger-row']")).toHaveCount(
      cross.length + single.length,
    );
  });

  test("@gate1 rows are ordered flagged-first and the order survives a reload", async ({
    page,
  }) => {
    await openGate1(page);
    const before = await rowIds(page);
    const expected = sortGroups(fixtureGroups()).map((g) => g.groupId);
    expect(before).toEqual(expected);
    // Flagged rows really are first — otherwise the equality above only asserts that two identical
    // functions agree.
    const flaggedCount = expected.filter((id) =>
      isFlagged(fixtureGroups().find((g) => g.groupId === id)!),
    ).length;
    expect(flaggedCount).toBeGreaterThan(0);
    for (let i = 0; i < flaggedCount; i++) {
      expect(
        isFlagged(fixtureGroups().find((g) => g.groupId === before[i])!),
      ).toBe(true);
    }

    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(
      page.locator("[data-testid='ledger-row']").first(),
    ).toBeVisible();
    expect(await rowIds(page)).toEqual(before);
  });

  test("@gate1 no control implies a numeric coherence confidence", async ({
    page,
  }) => {
    await openGate1(page);
    // The cell is a CLOSED four-state categorical. Sorting and filtering on the state is in scope; a
    // gradient, a percentage or a confidence meter is not, because no such number is computed and the
    // calibration to justify one does not exist.
    await expect(
      page.locator("progress, [role='progressbar'], meter"),
    ).toHaveCount(0);
    await expect(
      page.getByText(/\d+% (confident|coherent|confidence)/i),
    ).toHaveCount(0);
    await expect(page.getByText(/confidence/i)).toHaveCount(0);
  });
});

test.describe("gate1 toolbar", () => {
  test("@gate1 the verdict select narrows to a coherence state, and All states restores every group", async ({
    page,
  }) => {
    await openGate1(page);
    const rows = page.locator("[data-testid='ledger-row']");
    const all = await rows.count();

    // 08-16f: the four-filter panel collapsed to two controls — the verdict select (a coherence state)
    // and the cross-cohort-only toggle. There is no cohort / touched / in-scope filter any more.
    await page.locator("[data-testid='verdict-select']").click();
    await page
      .getByRole("option", { name: COHERENCE_COPY["split"].label })
      .click();
    const split = fixtureGroups().filter((g) => g.coherence === "split");
    await expect(rows).toHaveCount(split.length);
    expect(split.length).toBeLessThan(all);

    await page.locator("[data-testid='verdict-select']").click();
    await page.getByRole("option", { name: "All states" }).click();
    await expect(rows).toHaveCount(all);
  });
  test("@gate1 a filter matching nothing and a term matching nothing read differently", async ({
    page,
  }) => {
    // A FILTER matching nothing is the reviewer's own doing. The only categorical filter is the verdict
    // select, and every state has matches on the real run — so force the empty case with a one-state run.
    await serveRun(page, (run) => {
      for (const gg of run.result!.conceptGroups!) gg.coherence = "not_judged";
    });
    await openGate1(page);
    await page.locator("[data-testid='verdict-select']").click();
    await page
      .getByRole("option", { name: COHERENCE_COPY["split"].label })
      .click();
    const filterEmpty = page.locator("[data-testid='filter-empty']");
    await expect(filterEmpty).toBeVisible();
    await expect(filterEmpty).toContainText(/no group matches this filter/i);
    await filterEmpty.locator("[data-testid='clear-filters-inline']").click();

    // A SEARCH TERM matching nothing reads differently: a distinct empty state, caused by the search,
    // with its own way back. (The old multi-term 'coverage finding' listing was dropped in 08-16f.)
    await page
      .locator("[data-testid='term-search']")
      .fill("zzzz nonexistent concept");
    const searchEmpty = page.locator("[data-testid='search-empty']");
    await expect(searchEmpty).toBeVisible();
    await expect(searchEmpty).toHaveAttribute("data-cause", "search");
    await expect(searchEmpty).toContainText(/matched no group/i);
    await expect(page.locator("[data-testid='filter-empty']")).toHaveCount(0);
  });
  test("@gate1 the search matches on the group's own text", async ({
    page,
  }) => {
    // Asserted in node against the real fixture, so the claim is about the corpus and not about a mock.
    const groups = fixtureGroups();
    expect(matchTerms(groups, ["blood pressure"]).noMatches).toEqual([]);
    expect(matchTerms(groups, ["zzzz nonexistent concept"]).noMatches).toEqual([
      "zzzz nonexistent concept",
    ]);
    // Order-insensitive within a term, so "pressure blood" finds the same groups as "blood pressure".
    expect([...matchTerms(groups, ["pressure blood"]).ids].sort()).toEqual(
      [...matchTerms(groups, ["blood pressure"]).ids].sort(),
    );

    await openGate1(page);
    // The live input is a plain text filter (08-16f dropped the explanatory copy that rode the old
    // multi-term box); its no-semantic-claim guard now lives in the search and toolbar-labelling blocks.
    await expect(page.locator("[data-testid='term-search']")).toBeVisible();
  });
  test("@gate1 the in-scope count is derived from persisted decisions and survives a reload", async ({
    page,
  }) => {
    await openGate1(page);
    // The "reviewed" readout was retired (08-16f); the in-scope count lives in the sum block, over the
    // WHOLE corpus — the sum block and the commit bar price the same set.
    const inScopeLine = page.locator(
      "[data-testid='sum-block'] [data-sum-line='in-scope']",
    );
    const total = fixtureGroups().length;
    // NEW DEFAULT (08-23b subset): nothing is in scope until the reviewer selects — the deliberate act.
    await expect(inScopeLine).toContainText(`0 of ${total}`);

    // Put one group IN scope — a real decision, written through the shared layer.
    const first = page.locator("[data-testid='ledger-row']").first();
    const id = await first.getAttribute("data-row-id");
    await first.locator("[data-testid='queue-scope']").click();
    await expect(inScopeLine).toContainText(`1 of ${total}`);

    // R6: derived from the persisted decisions, so it is still there after a reload.
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(
      page.locator("[data-testid='ledger-row']").first(),
    ).toBeVisible();
    await expect(inScopeLine).toContainText(`1 of ${total}`);
    await expect(
      page.locator(`[data-testid='ledger-row'][data-row-id='${id}']`),
    ).toHaveAttribute("data-spine", /changed|unresolved/);
  });
  test("@gate1 Continue is gated on having something in scope, not on a review count", async ({
    page,
  }) => {
    await openGate1(page);
    // NEW DEFAULT (08-23b subset): nothing is selected, so there is nothing to buy — Continue is disabled
    // until the reviewer scopes at least one group. There is still no triage-VOLUME gate: one is enough,
    // not N reviewed by hand.
    const button = page.locator("[data-testid='commit-bar'] button");
    await expect(button).toBeDisabled();
    await page
      .locator("[data-testid='ledger-row']")
      .first()
      .locator("[data-testid='queue-scope']")
      .click();
    await expect(button).toBeEnabled();
  });
  test("@gate1 the full row count renders without horizontal scroll and without a new package", async ({
    page,
  }) => {
    // Every group at once — the volume backstop, taken past the default view's 28 rows.
    await serveRun(page, (run) => {
      run.result!.conceptGroups = [...run.result!.conceptGroups!].map((g) => ({
        ...g,
        crossCohort: true,
      }));
    });
    await openGate1(page);
    await expect(page.locator("[data-testid='ledger-row']")).toHaveCount(
      fixtureGroups().length,
    );
    const overflow = await page.evaluate(() => ({
      doc:
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
      body: document.body.scrollWidth - document.body.clientWidth,
    }));
    expect(overflow.doc).toBeLessThanOrEqual(0);
    expect(overflow.body).toBeLessThanOrEqual(0);
  });
});

// --- the expanded row: membership, regrouping, the evidence grid and the carve proposal (Task 3) ----------

/** Open the row named by group id and return its locator. */
async function expandRow(page: Page, groupId: string) {
  const row = page.locator(
    `[data-testid='ledger-row'][data-row-id='${groupId}']`,
  );
  await expect(row).toBeVisible();
  // MASTER-DETAIL (08-16f): selecting a queue row renders its depth in the detail pane, not inline.
  await row.click();
  const detail = page.locator("[data-testid='gate1-detail']");
  await expect(detail).toBeVisible();
  return detail;
}

/**
 * Open the pool the way a reviewer does — the same chevron affordance a ledger row carries (08-16c item A).
 *
 * The pool used to render its listing flat and always. It is a group now, so reaching what is in it takes
 * the gesture reaching into any other group takes.
 */
async function expandPool(page: Page): Promise<void> {
  // The pool is a sidebar entry selected into the detail pane now (08-16f), not an inline chevron.
  const entry = page.locator("[data-testid='gate1-pool-entry']");
  await entry.scrollIntoViewIfNeeded();
  await entry.click();
}

/**
 * ONE VARIABLE AS THE POOL LISTS IT, whichever of its two renderings the run produces.
 *
 * The evidence grid's ROW where the run carries descriptive fields for that variable, and the CHIP
 * fallback where it does not — the grid's own `hasSourceRows` decides, exactly as it does inside a group.
 * A spec that named only one of them would pass or fail on a property of the FIXTURE rather than on the
 * behaviour it means to assert.
 */
function pooled(memberId: string): string {
  return `[data-testid='unassigned-pool'] :is([data-testid='member-row'],[data-testid='member-chip'])[data-member-id='${memberId}']`;
}

/**
 * Open the declared-score panel — a disclosure near the top of the screen since 08-16c's item E.
 *
 * It used to render expanded at the foot of the page. Bhargav: *"the placement is weird — it's below
 * everything"* → *"move score panel near top as a dropdown for now."* What it CONTAINS is unchanged, so
 * the specs below assert exactly what they did; they just have to open it first.
 */
async function openScorePanel(page: Page): Promise<void> {
  await page.locator("[data-testid='score-panel-toggle']").click();
  await expect(page.locator("[data-testid='score-panel']")).toBeVisible();
}

/** The two flagged (split) groups in the default view — the ones carrying a carve proposal. */
const FLAGGED = "c45aa294f30f6#g1";
/** A large, unflagged cross-cohort group — the one with the most members to drag. */
const BIG = "c8331409f61e1#g0";

test.describe("gate1 expanded row", () => {
  test("@gate1 the expanded row renders the FULL membership, not the collapsed sample", async ({
    page,
  }) => {
    await openGate1(page);
    const group = fixtureGroups().find((g) => g.groupId === BIG)!;
    const row = await expandRow(page, BIG);
    // T-08-89: a regroup verb over a partial sample would silently discard the members it never showed,
    // so the expanded row reads the uncapped list rather than the collapsed row's cap. RE-POINTED by
    // 08-14h from `member-chip` to `member-row`: the tiles merged into the grid, so the grid row is now
    // the one representation of a variable. Same claim, same group, same count.
    await expect(row.locator("[data-testid='member-row']")).toHaveCount(
      group.nMembers,
    );
    await expect(
      row.locator("[data-testid='member-row']").first(),
    ).toHaveAttribute("draggable", "true");
  });

  test("@gate1 a single-member group's one chip is still draggable", async ({
    page,
  }) => {
    const singles = fixtureGroups().filter((g) => g.nMembers === 1);
    await openGate1(page);
    // Single-member groups are single-cohort — visible in the default all-groups view (08-16f: no bucket tabs).
    const row = await expandRow(page, singles[0].groupId);
    await expect(row.locator("[data-testid='member-row']")).toHaveCount(1);
    await expect(row.locator("[data-testid='member-row']")).toHaveAttribute(
      "draggable",
      "true",
    );
  });

  test("@gate1 a move persists, survives a reload, and marks both groups as changed", async ({
    page,
  }) => {
    await openGate1(page);
    const row = await expandRow(page, BIG);
    const chip = row.locator("[data-testid='member-row']").first();
    const memberId = await chip.getAttribute("data-member-id");

    // The no-group zone is a REAL destination with its own identifier, not a sentinel special-cased at
    // every call site. Since 08-16c's review it is a DOOR onto the shared pool rather than a list of its
    // own, so the variable is asserted where it now lands: the one pool below the ledger.
    const tray = row.locator(
      "[data-testid='member-drop-zone'][data-group-id='__unassigned__']",
    );
    await expect(tray).toBeVisible();
    await chip.dragTo(tray);

    await expandPool(page);
    const inPool = page.locator(
      "[data-testid='unassigned-pool'] [data-testid='pool-reviewer'] :is([data-testid='member-row'],[data-testid='member-chip'])",
    );
    await expect(inPool).toHaveCount(1);
    await expect(
      page.locator(`[data-testid='ledger-row'][data-row-id='${BIG}']`),
    ).toHaveAttribute("data-spine", "changed");

    // R6 / T-08-88: the move and the touched state are DERIVED from persisted decisions, so both are
    // still there after a reload. The prototype held them in component state, which is the defect.
    await page.reload();
    await page.waitForLoadState("networkidle");
    const after = await expandRow(page, BIG);
    await expandPool(page);
    await expect(inPool).toHaveCount(1);
    // Marked as the REVIEWER'S doing, wherever it is rendered — a persisted decision, read rather than
    // remembered, so the register survives the reload with it.
    await expect(page.locator(pooled(memberId!)).first()).toHaveAttribute(
      "data-moved",
      "true",
    );
    expect(await after.count()).toBeGreaterThan(0);
    await expect(
      page.locator(`[data-testid='ledger-row'][data-row-id='${BIG}']`),
    ).toHaveAttribute("data-spine", "changed");
  });

  test("@gate1 emptying a group renders a defined state instead of the row vanishing", async ({
    page,
  }) => {
    // A one-member group, so one drag empties it.
    const single = fixtureGroups().filter((g) => g.nMembers === 1)[0];
    await openGate1(page);
    const row = await expandRow(page, single.groupId);
    await row
      .locator("[data-testid='member-row']")
      .first()
      .dragTo(
        row.locator(
          "[data-testid='member-drop-zone'][data-group-id='__unassigned__']",
        ),
      );

    // The row MUST NOT silently disappear — the reviewer has to be able to see what they did and undo it.
    await expect(
      page.locator(
        `[data-testid='ledger-row'][data-row-id='${single.groupId}']`,
      ),
    ).toBeVisible();
    const emptied = row.locator("[data-testid='group-emptied']");
    await expect(emptied).toBeVisible();
    await expect(emptied).toContainText(/will not/i);
    await expect(
      row.getByRole("button", { name: /put them back|undo/i }),
    ).toBeVisible();
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
    await expect(grid.locator("tbody tr")).toHaveCount(
      fixtureGroups().find((g) => g.groupId === BIG)!.nMembers,
    );

    // Wide content scrolls WITHIN ITS OWN CONTAINER and never pushes the ledger's columns sideways.
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    const scrolls = await grid
      .locator("[data-testid='source-rows-scroll']")
      .evaluate((el) => ({
        x: getComputedStyle(el).overflowX,
        wider: el.scrollWidth >= el.clientWidth,
      }));
    expect(scrolls.x).toMatch(/auto|scroll/);
    expect(scrolls.wider).toBe(true);
  });

  test("@gate1 a loader-synthesized variable shows its generated id in the VARIABLE column, not a bare dash", async ({
    page,
  }) => {
    // A row whose source had no variable-name/id column gets a synthetic "_ROW_n" identity. It used to
    // render as a bare "—"; #11 shows the id (muted) so a reviewer can cite or track the row. Prepended so
    // it is within the grid's 100-row render cap.
    const synthId = "ukbb:_ROW_00042";
    await serveRun(page, (run) => {
      const members = run.result!.conceptGroupMembers ?? {};
      members[BIG] = [synthId, ...(members[BIG] ?? [])];
      run.result!.conceptGroupMembers = members;
      const fi = (run.result!.fieldIndex ?? {}) as Record<string, unknown>;
      fi[synthId] = {
        name: "_ROW_00042",
        text: "a row the loader gave a synthetic id",
        description: "a row with no source variable-name column",
      };
      run.result!.fieldIndex = fi as never;
    });
    await openGate1(page);
    const row = await expandRow(page, BIG);
    const idCell = row.locator("[data-testid='synthetic-var-id']");
    await expect(idCell.first()).toBeVisible();
    await expect(idCell.first()).toHaveText("_ROW_00042");
  });

  test("@gate1 with no field rows on the run, the expanded row falls back to membership", async ({
    page,
  }) => {
    // A run that predates `fieldIndex` — the grid is omitted, not rendered empty, and the chips remain.
    await serveRun(page, (run) => {
      run.result!.fieldIndex = {};
    });
    await openGate1(page);
    const row = await expandRow(page, BIG);
    await expect(row.locator("[data-testid='source-rows']")).toHaveCount(0);
    await expect(
      row.locator("[data-testid='member-chip']").first(),
    ).toBeVisible();
  });

  test("@gate1 the lifted grid paints from the role layer, checked by COMPUTED STYLE", async ({
    page,
  }) => {
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
          const v =
            getComputedStyle(el)[
              prop === "color" ? "color" : "backgroundColor"
            ];
          el.remove();
          return v;
        },
        { token, prop },
      );

    const head = grid.locator("thead th").first();
    expect(await head.evaluate((el) => getComputedStyle(el).color)).toBe(
      await probe("--on-raised-muted", "color"),
    );
    expect(
      await grid
        .locator("thead")
        .evaluate((el) => getComputedStyle(el).backgroundColor),
    ).toBe(await probe("--surface-inset", "background-color"));
    // And nothing in it is painted from a BRAND token, which is what T-08-65 caught.
    const brand = await probe("--brand-ink", "color");
    const cellColours = await grid
      .locator("tbody td")
      .evaluateAll((els) =>
        els.slice(0, 20).map((el) => getComputedStyle(el).color),
      );
    expect(cellColours.filter((c) => c === brand)).toEqual([]);
  });
});

test.describe("gate1 carve", () => {
  test("@gate1 the carve proposal is a proposal — ignoring it leaves the grouping untouched", async ({
    page,
  }) => {
    await openGate1(page);
    const row = await expandRow(page, FLAGGED);
    const carve = row.locator("[data-testid='carve-proposal']");
    await expect(carve).toBeVisible();
    // The judge FLAGS and never re-groups. Nothing is applied until the reviewer acts.
    const before = await row.locator("[data-testid='member-chip']").count();
    await carve.getByRole("button", { name: /ignore/i }).click();
    await expect(row.locator("[data-testid='member-chip']")).toHaveCount(
      before,
    );
    await expect(
      page.locator(`[data-testid='ledger-row'][data-row-id='${FLAGGED}']`),
    ).toBeVisible();
  });

  /**
   * LIGHTENED, BUT THE STATE CLAIM SURVIVES (08-16c review). Bhargav: *"this box is heavy handed. re-write
   * along the lines of 'LLM judgement proposes splitting this group' / 'rationale: ____'."*
   *
   * The assertion is about what the lightening may NOT drop. "Nothing has been changed" is a claim about
   * the run, not a caption: the pipeline flags an over-merge and never resolves it, and that sentence is
   * why a reviewer can walk past this panel safely. Copy trimming is the standing pressure on it, so it
   * is pinned here rather than left to survive on judgement.
   */
  test("@gate1 the carve proposal states its proposer, its rationale, and that nothing was applied", async ({
    page,
  }) => {
    await openGate1(page);
    const carve = (await expandRow(page, FLAGGED)).locator(
      "[data-testid='carve-proposal']",
    );

    // The finding names the coherence state, in the register the Coherence column already uses (the
    // proposer is the coherence judge, via the shared COHERENCE_COPY label).
    await expect(carve).toContainText(/Coherence finding/i);
    await expect(carve).toContainText(/split/i);
    // ...and the state of the run is stated outright.
    await expect(carve.locator("[data-testid='carve-unapplied']")).toHaveText(
      "Nothing has been changed — this is a proposal.",
    );
    // Edit and Ignore are live controls; Accept is off by default (a NotAvailable pointing to Setup —
    // the enabled-accept path is asserted separately), so its verb is present as copy either way.
    await expect(carve.getByRole("button", { name: /edit/i })).toBeVisible();
    await expect(carve.getByRole("button", { name: /ignore/i })).toBeVisible();
    await expect(carve).toContainText(/accept/i);
  });
  test("@gate1 a checked group carries no carve proposal", async ({ page }) => {
    await openGate1(page);
    // A `single` (checked) group is not flagged AND is not advisory — so no carve proposal. (A `qualify`
    // group is unflagged but DOES show an advisory carve, which is why this targets `single` by id.)
    const CHECKED = "cb2a6e2cd6fd3#g0";
    expect(fixtureGroups().find((g) => g.groupId === CHECKED)!.coherence).toBe(
      "single",
    );
    const row = await expandRow(page, CHECKED);
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
    const carve = (await expandRow(page, FLAGGED)).locator(
      "[data-testid='carve-proposal']",
    );
    const na = carve.locator(
      "[data-testid='not-available'][data-claim='not-enabled']",
    );
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
      run.config = {
        ...(run.config as object),
        demo: false,
        readjudication: true,
      } as never;
    });
    await openGate1(page);
    const carve = (await expandRow(page, FLAGGED)).locator(
      "[data-testid='carve-proposal']",
    );
    const accept = carve.getByRole("button", { name: /accept/i });
    await expect(accept).toBeVisible();

    // PRICED INLINE, BEFORE IT RUNS, never behind a modal — the same register as the commit bar.
    await expect(carve.locator("[data-testid='carve-price']")).toBeVisible();
    await expect(carve.locator("[data-testid='carve-price']")).toContainText(
      /costs money|\$/i,
    );
    await expect(page.locator("[role='dialog']")).toHaveCount(0);

    // EXACTLY ONE ID, carried as data on the control itself. Never an empty list, never "everything
    // flagged" — re-splitting every flagged group BECAUSE it was flagged is an auto-resolution of an
    // over-merge with no human decision behind it, which core's own docstring forbids.
    expect(JSON.parse((await accept.getAttribute("data-group-ids"))!)).toEqual([
      FLAGGED,
    ]);

    // And nothing has been sent yet: the price is stated BEFORE the press, not after it.
    expect(requests).toEqual([]);
  });

  /**
   * ACCEPTING A DIVISION REPLACES THE PARENT WITH ITS CHILDREN (08-23b Task 2, Option A). The accept is
   * split-only, so what a reviewer sees afterward is the persisted GROUPING: the over-merged parent is
   * gone from the ledger and in its place stand the child concept-groups it was carved into, each marked
   * "re-split from <parent>". Assignment is NOT part of this — the children are unassigned until Gate 2.
   *
   * Asserted against the RENDERED post-accept state (a fixture carrying the children), because the whole
   * e2e suite runs against a backend-less static build and the paid accept itself cannot fire there — the
   * live paid accept is a manual walk, named in the summary. What this pins is the durable contract: a
   * group carrying `readjudicatedFrom` renders as a re-split child, and the parent it replaced is absent.
   */
  test("@gate1 an accepted division shows its children marked 're-split from', and the parent is gone", async ({
    page,
  }) => {
    await serveRun(page, (run) => {
      const groups = run.result?.conceptGroups ?? [];
      const parent = groups.find((g) => g.groupId === FLAGGED)!;
      const child = (i: number) => ({
        ...parent,
        groupId: `${FLAGGED}#g${i}`,
        concept: `${parent.concept} — part ${i + 1}`,
        // Provenance: this is what the marker reads, and what a records-only check would have missed.
        readjudicatedFrom: FLAGGED,
        // Freshly split children are not themselves flagged.
        coherence: "single" as const,
        incoherent: false,
        membersTruncated: false,
      });
      run.result!.conceptGroups = groups.flatMap((g) =>
        g.groupId === FLAGGED ? [child(0), child(1)] : [g],
      );
    });
    await openGate1(page);

    // The accepted parent is gone from the ledger — its grouping was replaced, not annotated.
    await expect(
      page.locator(`[data-testid='ledger-row'][data-row-id='${FLAGGED}']`),
    ).toHaveCount(0);

    // Its two children stand in its place, each marked as a re-split child that names the parent.
    for (const i of [0, 1]) {
      const childRow = page.locator(
        `[data-testid='ledger-row'][data-row-id='${FLAGGED}#g${i}']`,
      );
      await expect(childRow).toBeVisible();
      const mark = childRow.locator("[data-testid='resplit-mark']");
      await expect(mark).toBeVisible();
      await expect(mark).toHaveAttribute("data-parent", FLAGGED);
      await expect(mark).toContainText(/re-split/i);
    }
  });
});

// --- the declared-score panel, moved here from Setup (Task 4, the 2026-08-25 amendment) -------------------

test.describe("gate1 score", () => {
  test("@gate1 the verdict is derived, and absent evidence is indeterminate rather than infeasible", () => {
    // THE PROHIBITION, as an algebra. Positive-or-indeterminate is determinable from what a run holds; a
    // NEGATIVE claim is not. So `infeasible` is reachable only from a completed match that came back
    // empty, and everything else that is not a match resolves to `indeterminate`.
    const declared = (name: string) => ({
      name,
      searched: false,
      matched: false,
      shortlistSize: 0,
    });
    expect(scopeVerdictFor([declared("grip"), declared("gait")])).toBe(
      "indeterminate",
    );
    expect(componentVerdictFor(declared("grip"))).toBe("indeterminate");

    const matched = {
      name: "grip",
      searched: true,
      matched: true,
      shortlistSize: 3,
    };
    const searchedAndEmpty = {
      name: "gait",
      searched: true,
      matched: false,
      shortlistSize: 0,
    };
    expect(scopeVerdictFor([matched])).toBe("full");
    expect(scopeVerdictFor([matched, searchedAndEmpty])).toBe("partial");
    expect(scopeVerdictFor([searchedAndEmpty])).toBe("infeasible");
    expect(componentVerdictFor(searchedAndEmpty)).toBe("infeasible");
    // One component still unsearched keeps the WHOLE verdict off `infeasible` — a negative claim about a
    // score needs every component actually looked for.
    expect(scopeVerdictFor([searchedAndEmpty, declared("chair rise")])).toBe(
      "indeterminate",
    );
  });

  test("@gate1 rejected candidates and nothing retrieved are different findings", () => {
    // "We retrieved 8 candidates and the judge rejected them all" means the concepts exist and none
    // measures the component. "Nothing was retrieved" is closer to absence. Collapsing them loses the
    // distinction, and MISSING never means "the cohort lacks it" — it means "not retrieved in this run".
    expect(
      missingReason({
        name: "gait",
        searched: true,
        matched: false,
        shortlistSize: 8,
      }),
    ).toMatch(/8 .*rejected|rejected.*8/i);
    expect(
      missingReason({
        name: "gait",
        searched: true,
        matched: false,
        shortlistSize: 0,
      }),
    ).toMatch(/nothing .*retrieved|retrieved nothing/i);
    expect(
      missingReason({
        name: "gait",
        searched: true,
        matched: false,
        shortlistSize: 8,
      }),
    ).not.toEqual(
      missingReason({
        name: "gait",
        searched: true,
        matched: false,
        shortlistSize: 0,
      }),
    );
    // Neither of them says the cohort does not measure it.
    for (const n of [0, 8]) {
      expect(
        missingReason({
          name: "gait",
          searched: true,
          matched: false,
          shortlistSize: n,
        }),
      ).not.toMatch(/cohort (does not|doesn't|lacks)/i);
    }
  });

  // A derived spec, built from two REAL fixture groups so the match ids resolve to groups the ledger holds
  // and the click-through can actually land. Mirrors what `derive_composite` (spec_to_dict) emits.
  function scoreSpec(
    matched: ConceptGroup,
    rejected: ConceptGroup,
    vars: string[],
  ): CompositeSpec {
    const coding: ComponentCoding = {
      kind: "threshold",
      cutoff: "",
      referenceRange: "",
      codeMap: {},
      formula: "",
      units: "",
      statedInSource: false,
      needsReview: true,
    };
    return {
      definition: {
        name: "Test frailty index",
        kind: "criteria_count",
        citation: "",
        combinationRule: "count of criteria met",
        threshold: "",
        notes: "",
        statedNItems: 2,
        underEnumerated: 0,
        provenance: "pasted text",
        sourceSha256: "",
        components: [
          {
            name: "Grip strength",
            definition: "",
            required: true,
            weight: null,
            coding,
          },
          {
            name: "Gait speed",
            definition: "",
            required: true,
            weight: null,
            coding,
          },
        ],
      },
      matches: [
        {
          component: "Grip strength",
          conceptId: matched.groupId,
          concept: matched.concept,
          column: "grip",
          cohorts: matched.cohorts,
          sourceVariables: vars,
          confidence: 0.72,
          rationale: "measures grip strength",
          required: true,
          pinned: false,
          shortlist: [matched.groupId],
          // Variable-only shape: the matched variables that rolled up to the group, and the deduped
          // group candidates the Swap list offers.
          matchedMembers: vars.map((v) => ({ variableId: v, confidence: 0.72 })),
          groupCandidates: [{ groupId: matched.groupId, confidence: 0.72 }],
        },
        {
          component: "Gait speed",
          conceptId: null,
          concept: "",
          column: "",
          cohorts: [],
          sourceVariables: [],
          confidence: 0,
          rationale: "no concept measured gait speed",
          required: true,
          pinned: false,
          // A MISSING component's shortlist is VARIABLE-level (no group rated on-topic → empty
          // groupCandidates). These variables all belong to one group, so the panel must roll them up to
          // that single group rather than list one dead, unlinkable variable row per variable.
          shortlist: rejected.memberVariableNames.slice(0, 3),
          groupCandidates: [],
        },
      ],
      feasibility: {
        verdict: "partial",
        nRequired: 2,
        nRequiredMatched: 1,
        matched: ["Grip strength"],
        missing: ["Gait speed"],
        needsReview: [],
        computableCohorts: [],
        perCohort: [],
        caveats: [],
      },
      derivation: [],
      units: "",
      validationRules: [],
    };
  }

  test("@gate1 with a declared score, its matched groups start IN scope and the rest start OUT", async ({
    page,
  }) => {
    // THE SCORE-BUILDER EXCEPTION to the new default-deselect (08-23b subset). The reviewer ran the score
    // builder, so the groups it matched are the ones they care about — those are pre-selected; every other
    // group starts deselected like on a run with no score.
    const groups = fixtureGroups();
    const matched = groups.find((g) => g.groupId === "cb2a6e2cd6fd3#g0")!;
    const rejected = groups.find((g) => g.groupId === "c8331409f61e1#g0")!;
    const vars = matched.memberVariableNames.slice(0, 2);
    await serveRun(page, (run) => {
      run.composites = [scoreSpec(matched, rejected, vars)];
    });
    await openGate1(page);

    // The score matched this group -> pre-selected.
    const matchedScope = page
      .locator(`[data-testid='ledger-row'][data-row-id='${matched.groupId}']`)
      .locator("[data-testid='queue-scope']");
    await expect(matchedScope).toHaveAttribute("aria-checked", "true");
    // A group the score did not match starts deselected, like every other group under the new default.
    const otherScope = page
      .locator(`[data-testid='ledger-row'][data-row-id='${rejected.groupId}']`)
      .locator("[data-testid='queue-scope']");
    await expect(otherScope).toHaveAttribute("aria-checked", "false");
    // ...and Continue is live, because the score's matched group is already in scope.
    await expect(page.locator("[data-testid='commit-bar'] button")).toBeEnabled();
  });

  test("@gate1 a matched component shows its group, coverage and members and links; a missing component's variable candidates roll up to one group", async ({
    page,
  }) => {
    const groups = fixtureGroups();
    const matched = groups.find((g) => g.groupId === "cb2a6e2cd6fd3#g0")!; // real vars, in conceptGroupMembers
    const rejected = groups.find((g) => g.groupId === "c8331409f61e1#g0")!;
    const vars = matched.memberVariableNames.slice(0, 2);
    expect(matched).toBeTruthy();
    expect(vars.length).toBeGreaterThan(0);
    expect(rejected.memberVariableNames.length).toBeGreaterThan(0);

    await serveRun(page, (run) => {
      run.composites = [scoreSpec(matched, rejected, vars)];
    });
    await openGate1(page);
    await openScorePanel(page);

    // A MATCHED component: the concept GROUP its source variables rolled up to, ONE match-confidence, the
    // coverage tell (variable-only matching surfaces the group but coverage is the over-merge signal), and
    // the matched members indented under it.
    const grip = page.locator(
      "[data-testid='score-match'][data-component='Grip strength']",
    );
    await grip.locator("[data-testid='score-component-expand']").click();
    await expect(grip.locator("[data-testid='score-confidence']")).toHaveText("0.72");
    const coverage = grip.locator("[data-testid='score-coverage']");
    await expect(coverage).toContainText(
      `${vars.length} of ${matched.nMembers} group members matched`,
    );
    // A minority of a multi-member group is the over-merge flag.
    await expect(coverage).toHaveAttribute("data-partial", "true");
    await expect(grip.locator("[data-testid='score-matched-member']")).toHaveCount(
      vars.length,
    );
    await expect(
      grip.locator("[data-testid='score-matched-member']").first(),
    ).toContainText(vars[0]);

    // The group link opens it in the drag-drop detail pane.
    await grip.locator("[data-testid='score-open-group']").click();
    const pane = page.locator("[data-testid='gate1-detail']");
    await expect(pane).toContainText(matched.concept.slice(0, 24));

    // A MISSING component's candidates are VARIABLE-level; they must roll up to the ONE group they belong
    // to — a single deduped, linkable row, not one dead row per variable.
    const gait = page.locator(
      "[data-testid='score-match'][data-component='Gait speed']",
    );
    await gait.locator("[data-testid='score-component-expand']").click();
    await gait.getByRole("button", { name: /Choose concept/i }).click();
    const candidates = gait.locator("[data-testid='swap-candidate']");
    await expect(candidates).toHaveCount(1);
    await expect(candidates.first()).toContainText(rejected.concept.slice(0, 20));

    // …and it links: opening the rolled-up group lands it in the detail pane.
    await gait.locator("[data-testid='swap-candidate-open']").first().click();
    await expect(pane).toContainText(rejected.concept.slice(0, 20));
  });

  test("@gate1 the panel is a section of Gate 1, not a screen and not a modal", async ({
    page,
  }) => {
    await openGate1(page);
    await openScorePanel(page);
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

  test("@gate1 declaring components renders indeterminate, and it survives a reload", async ({
    page,
  }) => {
    await openGate1(page);
    await openScorePanel(page);
    await page
      .locator("[data-testid='score-components']")
      .fill("Weak grip strength\nSlow walking speed");
    // NAMED EXACTLY. `/declare/i` also matches the disclosure's own "Hide the declared-score panel"
    // now that the panel is a dropdown (08-16c item E), and a loose name in a strict-mode locator is a
    // test that breaks on an unrelated label rather than on a behaviour.
    await page
      .getByRole("button", { name: "Declare these components" })
      .click();

    await expect(page.locator("[data-testid='score-component']")).toHaveCount(
      2,
    );
    const verdict = page.locator("[data-testid='score-verdict']");
    await expect(verdict).toHaveAttribute("data-verdict", "indeterminate");
    // Never the negative claim, and never Setup's reason — Gate 1 HAS concepts, so "this run has produced
    // no concepts" would be false here even though it was true there.
    await expect(verdict).not.toContainText(/not computable/i);
    await expect(
      page.locator(
        "[data-testid='score-component'][data-verdict='infeasible']",
      ),
    ).toHaveCount(0);

    // Written through the durable gate-decision layer, so it is still declared after a reload.
    await page.reload();
    await page.waitForLoadState("networkidle");
    await openScorePanel(page);
    await expect(page.locator("[data-testid='score-component']")).toHaveCount(
      2,
    );
    await expect(page.locator("[data-testid='score-verdict']")).toHaveAttribute(
      "data-verdict",
      "indeterminate",
    );
  });

  test("@gate1 reading the document is free and says so, and matching states its price inline", async ({
    page,
  }) => {
    await openGate1(page);
    await openScorePanel(page);
    const panel = page.locator("[data-testid='score-panel']");
    // The 08-11 extract route is $0 and job-independent. Nothing here makes reading cost money.
    await expect(panel.locator("[data-testid='score-upload']")).toContainText(
      /costs nothing|free|\$0/i,
    );
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
    await openScorePanel(page);
    // A run PARKED at Gate 1 has produced concept groups but no assigned records, and matching components
    // onto concepts needs the latter. So the action is unavailable — and it says which, rather than being
    // hidden (the reviewer never learns it exists) or disabled (they cannot tell why).
    const na = page.locator(
      "[data-testid='score-panel'] [data-testid='not-available']",
    );
    await expect(na).toBeVisible();
    await expect(na).toContainText(/Gate 2|matched against/i);
    expect(requests).toEqual([]);
  });

  test("@gate1 a completed match reaches full and partial, and never invents a cutoff", async ({
    page,
  }) => {
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
              {
                name: "Weak grip strength",
                definition: "",
                required: true,
                weight: null,
                coding: {
                  kind: "unstated",
                  cutoff: "",
                  referenceRange: "",
                  needsReview: true,
                },
              },
              {
                name: "Slow walking speed",
                definition: "",
                required: true,
                weight: null,
                coding: {
                  kind: "unstated",
                  cutoff: "",
                  referenceRange: "",
                  needsReview: true,
                },
              },
            ],
          },
          matches: [
            {
              component: "Weak grip strength",
              conceptId: "c1#g0",
              concept: "Grip strength",
              column: "",
              cohorts: ["UKBB"],
              sourceVariables: [],
              confidence: 0.9,
              rationale: "",
              required: true,
              pinned: false,
              shortlist: ["c1#g0"],
            },
            {
              component: "Slow walking speed",
              conceptId: null,
              concept: "",
              column: "",
              cohorts: [],
              sourceVariables: [],
              confidence: 0,
              rationale: "",
              required: true,
              pinned: false,
              shortlist: ["a", "b", "c"],
            },
          ],
          feasibility: {
            verdict: "partial",
            nRequired: 2,
            nRequiredMatched: 1,
            matched: ["Weak grip strength"],
            missing: ["Slow walking speed"],
            needsReview: [],
            computableCohorts: [],
            perCohort: [],
            caveats: [],
          },
          derivation: [],
          units: "",
          validationRules: [],
        },
      ] as never;
    });
    await openGate1(page);
    await openScorePanel(page);
    const panel = page.locator("[data-testid='score-panel']");

    // The verdict is DERIVED, not hard-coded: one required component matched and one did not, so the spec
    // reads "partially computable" with the required tally spelled out — never a colour left to be inferred.
    await expect(panel).toContainText(/partially computable/i);
    await expect(panel).toContainText("1/2 required components");

    // The matched one and the missing one — each reported as a result, distinguishable by whether it
    // reached a group.
    await expect(
      panel.locator("[data-testid='score-match'][data-matched='true']"),
    ).toHaveCount(1);
    const missing = panel.locator(
      "[data-testid='score-match'][data-matched='false']",
    );
    await expect(missing).toHaveCount(1);
    await expect(missing).toContainText(/3 retrieved|none fit/i);

    // NO CUTOFF IS INVENTED. The source stated none, so expanding the matched component flags it for a
    // human instead of deriving a plausible one, and no threshold number appears anywhere in the panel —
    // a score's threshold is a clinical claim.
    await panel
      .locator(
        "[data-testid='score-match'][data-matched='true'] [data-testid='score-component-expand']",
      )
      .click();
    await expect(panel).toContainText(/no coding rule in source/i);
    await expect(panel).not.toContainText(/\bkg\b|<\s*\d|≥\s*\d/);

    // Presence is per DATA DICTIONARY: participant-level missingness — and therefore effective N — cannot
    // be derived from metadata. ddharmon writes the recipe, it never computes the score.
    await expect(panel).toContainText(/per data dictionar/i);
    await expect(panel).toContainText(/cannot be derived from metadata/i);
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

  test("@gate1 a run still working reads as WAITING, and makes no claim about the corpus", async ({
    page,
  }) => {
    await noGroupsYet(page, "splitting");

    const waiting = page.locator("[data-testid='gate1-waiting']");
    await expect(waiting).toBeVisible();
    // IT SAYS WHAT IS BEING WAITED FOR. A reviewer who arrives early has to be able to tell that the
    // screen is working, and "waiting" with no object is barely better than a blank pane.
    await expect(waiting).toContainText(/splitting/i);
    await expect(waiting).toContainText(/coherence/i);
    // AND IT PROMISES NO RELOAD, because none is needed — the stream delivers the groups. That promise
    // is the NEXT STEP, which is where an empty state is required to put the thing the reviewer does.
    await expect(
      page.locator("[data-testid='gate1-waiting-next']"),
    ).toContainText(/on their own|no need to reload/i);

    // THE FALSE CLAIM IS GONE. Not merely reworded — absent.
    await expect(page.getByText("No groups formed")).toHaveCount(0);
    await expect(
      page.getByText(/dictionaries share too little text/i),
    ).toHaveCount(0);
    // And no zeroed statistics strip, which reads as "this run measured nothing" just as loudly.
    await expect(page.locator("[data-testid='grouping-strip']")).toHaveCount(0);
  });

  test("@gate1 a run that DIED before reaching gate 1 says so, rather than waiting forever", async ({
    page,
  }) => {
    for (const status of ["error", "cancelled"]) {
      await noGroupsYet(page, status);
      const stopped = page.locator("[data-testid='gate1-run-stopped']");
      await expect(stopped, status).toBeVisible();
      await expect(
        page.locator("[data-testid='gate1-waiting']"),
        status,
      ).toHaveCount(0);
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
    await expect(page.locator("[data-testid='gate1-run-stopped']")).toHaveCount(
      0,
    );
    await expect(page.locator("[data-testid='grouping-strip']")).toBeVisible();
  });

  test("@gate1 a parked run WITH groups shows the ledger and neither of the new states", async ({
    page,
  }) => {
    await page.goto(`/run/${PAUSED_JOB}/gate1`);
    await page.waitForLoadState("networkidle");
    await expect(
      page.locator("[data-testid='ledger-row']").first(),
    ).toBeVisible();
    await expect(page.locator("[data-testid='gate1-waiting']")).toHaveCount(0);
    await expect(page.locator("[data-testid='gate1-run-stopped']")).toHaveCount(
      0,
    );
  });

  test("@gate1 the waiting state is DERIVED from the streamed status, so the park ends it without a reload", async () => {
    const { readFileSync } = await import("node:fs");
    const { dirname, resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(
      resolve(here, "../../src/pages/run/gate1.tsx"),
      "utf8",
    )
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/^\s*\/\/.*$/gm, " ");

    // THE PROPERTY THAT MAKES THE LEDGER SELF-POPULATING. `useHarmonizeStream` already delivers the park;
    // what would break it is holding "am I waiting?" in component state, because a `useState` seeded on
    // first render does not change when the stream does — the reviewer would sit on a waiting screen over
    // a run that had already arrived. So it is derived from the run's status, every render.
    // A plain `const`, recomputed every render, whose input is the STREAMED status.
    expect(src).toMatch(
      /const awaitingRun =[^;]*isInFlight\(jobState\.status\)/s,
    );
    expect(
      src,
      "the waiting state may not be held in component state",
    ).not.toMatch(/useState[^\n]*([Ww]aiting|awaitingRun)/);
    // And it uses the SHARED predicates rather than a fifth local copy of them.
    expect(src).toMatch(
      /import \{[^}]*isInFlight[^}]*\} from "@\/lib\/run-state"/s,
    );
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
    expect(
      await page.locator("[data-testid='ledger-row']").count(),
    ).toBeGreaterThan(10);

    const probe = await scrollProbe(page);
    // THE DEFECT, STATED AS A NUMBER: this was 300 (and the document 3,344px tall) before the fix.
    expect(
      probe.documentMoved,
      "the document must not scroll — it drags the whole app off-screen",
    ).toBe(0);
    expect(
      probe.documentScrollHeight,
      "the document may be no taller than the viewport",
    ).toBe(probe.viewportHeight);
    // ...and the ONE scroller that does exist is the content area, so scrolling the page scrolls the
    // ledger. The reviewer never has to find the right container.
    expect(probe.mainMoved, "the content area is the page's scroller").toBe(
      300,
    );
  });

  test("@gate1 nothing absolutely positioned escapes the content scroller", async ({
    page,
  }) => {
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
        if (!contained)
          out.push(
            `${el.tagName.toLowerCase()}.${String(el.className || "").slice(0, 40)}`,
          );
      }
      // Report a sample: 58 identical `sr-only` spans is not 58 findings.
      return out.slice(0, 5);
    });
    // `sr-only` IS `position: absolute` — that is the utility's definition, not a misuse — so the fix is
    // to give the scroller a containing block rather than to hunt down every use of it.
    expect(
      escapees,
      "an absolutely positioned descendant may not be laid out against the document",
    ).toEqual([]);
  });

  test("@gate1 expanding a row does not bring the document scroll back", async ({
    page,
  }) => {
    await page.goto(`/run/${PAUSED_JOB}/gate1`);
    await page.waitForLoadState("networkidle");
    const row = await expandRow(page, BIG);
    // The evidence grid is a BOUNDED widget with its own scroll region, and that is deliberate: the cap
    // is what keeps the carve proposal below it reachable, and the horizontal scrolling is required
    // behaviour (asserted in "the expanded row carries the source rows" above). What must not happen is
    // the page scrolling ITSELF out of view again.
    await expect(
      row.locator("[data-testid='source-rows-scroll']"),
    ).toBeVisible();
    const probe = await scrollProbe(page);
    expect(
      probe.documentMoved,
      "an expanded row must not make the document scrollable",
    ).toBe(0);
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
    await expect(row.locator("[data-testid='member-row']")).toHaveCount(
      group.nMembers,
    );
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
    const tray = row.locator(
      "[data-testid='member-drop-zone'][data-group-id='__unassigned__']",
    );

    // THE DROP TARGET IS VISIBLE WITHOUT SCROLLING AWAY from the row being dragged — the tray sits
    // directly below the grid, in the same expanded row.
    await expect(tray).toBeVisible();
    await target.dragTo(tray);

    // The behaviour 08-15 built is unchanged: keyed per variable, persisted, and the row says it changed.
    // Only WHERE the result is read has moved — into the one pool (08-16c review).
    await expandPool(page);
    await expect(page.locator(pooled(memberId!))).toHaveCount(1);
    await expect(
      page.locator(`[data-testid='ledger-row'][data-row-id='${BIG}']`),
    ).toHaveAttribute("data-spine", "changed");
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expandPool(page);
    await expect(page.locator(pooled(memberId!))).toHaveCount(1);
  });

  test("@gate1 regrouping is reachable WITHOUT a mouse", async ({ page }) => {
    // Native HTML5 drag and drop has no keyboard equivalent, so before this merge the only way to
    // correct an over-merged group was with a mouse. A drag with no keyboard path is a regression, not a
    // simplification — so every row carries a real button that performs the correction this screen is for.
    await openGate1(page);
    const row = await expandRow(page, BIG);
    const target = row.locator("[data-testid='member-row']").first();
    const memberId = await target.getAttribute("data-member-id");

    const remove = row.locator(
      `[data-testid='member-remove'][data-member-id='${memberId}']`,
    );
    await expect(remove).toBeVisible();
    // Focusable and activated by the keyboard, and NAMED for the variable it acts on — not "remove".
    await remove.focus();
    await expect(remove).toBeFocused();
    await expect(remove).toHaveAttribute(
      "aria-label",
      /take .+ out of this group/i,
    );
    await page.keyboard.press("Enter");

    await expandPool(page);
    await expect(page.locator(pooled(memberId!))).toHaveCount(1);
    // Same persisted path as the drag — not a second, weaker code path.
    await expect(
      page.locator(`[data-testid='ledger-row'][data-row-id='${BIG}']`),
    ).toHaveAttribute("data-spine", "changed");
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
    await expect(row.locator("[data-testid='member-chip']")).toHaveCount(
      group.nMembers,
    );
    await expect(
      row.locator("[data-testid='member-chip']").first(),
    ).toHaveAttribute("draggable", "true");
  });

  test("@gate1 the workbench's copy of the grid gains NO drag affordance", async () => {
    const { readFileSync } = await import("node:fs");
    const { dirname, resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(
      resolve(here, "../../src/pages/workbench.tsx"),
      "utf8",
    );
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
  test("@gate1 the toolbar's narrowing controls are labelled and keyboard-reachable", async ({
    page,
  }) => {
    await openGate1(page);
    const toolbar = page.locator("[data-testid='ledger-toolbar']");
    // 08-16f: the four-filter panel collapsed to two named controls — a cross-cohort-only toggle and a
    // verdict select. Each is a real, reachable control (no unlabelled cohort/review chip groups).
    const xc = toolbar.locator("[data-testid='cross-cohort-toggle']");
    await expect(xc).toBeVisible();
    await xc.focus();
    await expect(xc).toBeFocused();
    await expect(
      toolbar.locator("[data-testid='verdict-select']"),
    ).toBeVisible();
  });

  test("@gate1 each coherence state is named in the JUDGE'S OWN words, not a re-gloss", async ({
    page,
  }) => {
    await openGate1(page);
    // The verdict select's options ARE the coherence states, labelled from the shared COHERENCE_COPY the
    // ledger cell also reads — one register, not a second gloss.
    await page.locator("[data-testid='verdict-select']").click();
    for (const state of ["split", "qualify", "not_judged", "single"] as const) {
      await expect(
        page.getByRole("option", { name: COHERENCE_COPY[state].label }),
      ).toBeVisible();
    }
  });

  test("@gate1 the coherence labels are written ONCE and read from that one register", async () => {
    const { readFileSync } = await import("node:fs");
    const { dirname, resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(
      resolve(here, "../../src/components/gate/LedgerToolbar.tsx"),
      "utf8",
    )
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/^\s*\/\/.*$/gm, " ");
    // Before 08-14h this file spelled the four labels out TWICE — once in its `VERDICTS` table and again
    // in the active-filter summary's `f === "not_judged" ? "not judged" : f === "single" ? "checked" : f`
    // — and `CoherenceMark` held a third copy. Three copies of a label is how a filter comes to disagree
    // with the cell it filters.
    expect(src).toMatch(/COHERENCE_COPY/);
    expect(
      src,
      "the active-filter summary may not re-spell the state labels",
    ).not.toMatch(/"not judged"[\s\S]{0,40}"checked"/);
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
    expect(matchTerms(groups, ["zzzz nonexistent"]).noMatches).toEqual([
      "zzzz nonexistent",
    ]);
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

  test("@gate1 a search that hides every group SAYS SO, and clears in one click", async ({
    page,
  }) => {
    await openGate1(page);
    const before = await page.locator("[data-testid='ledger-row']").count();
    expect(before).toBeGreaterThan(0);

    await page
      .locator("[data-testid='term-search']")
      .fill("zzzz nonexistent concept");

    // NOT A BLANK BODY. The reviewer must never be left inferring why the rows went away — a named
    // empty state says the search matched nothing, with one click back.
    const empty = page.locator("[data-testid='search-empty']");
    await expect(empty).toBeVisible();
    await expect(empty).toHaveAttribute("data-cause", "search");
    await expect(empty).toContainText(/matched no group/i);

    await page.locator("[data-testid='clear-search-inline']").click();
    await expect(page.locator("[data-testid='ledger-row']")).toHaveCount(
      before,
    );
    await expect(page.locator("[data-testid='search-empty']")).toHaveCount(0);
  });
  test("@gate1 the empty state names WHICH of search and filters emptied the ledger", async ({
    page,
  }) => {
    await openGate1(page);

    // (a) SEARCH ALONE: the term matched nothing anywhere in the run, so the search is responsible.
    await page
      .locator("[data-testid='term-search']")
      .fill("zzzz nonexistent concept");
    const empty = page.locator("[data-testid='search-empty']");
    await expect(empty).toHaveAttribute("data-cause", "search");

    // (b) SEARCH PLUS A FILTER: the term DID match groups but a verdict filter hides them — a different
    // cause with a different way back, so it must not read as 'your search found nothing'.
    await page.locator("[data-testid='clear-search-inline']").click();
    await page.locator("[data-testid='term-search']").fill("blood pressure");
    await expect(page.locator("[data-testid='ledger-row']")).not.toHaveCount(0);
    await page.locator("[data-testid='verdict-select']").click();
    await page
      .getByRole("option", { name: COHERENCE_COPY["split"].label })
      .click();
    const both = page.locator("[data-testid='search-empty']");
    if (await both.count()) {
      await expect(both).toHaveAttribute("data-cause", "both");
      await expect(both).toContainText(/filter|hiding/i);
      await expect(
        page.locator("[data-testid='clear-search-inline']"),
      ).toBeVisible();
    }
  });
  test("@gate1 the search still makes no semantic claim", async ({ page }) => {
    await openGate1(page);
    // 08-15 removed that claim deliberately: no group centroid and no embedding reaches the browser. The
    // explanatory copy rode the old multi-term box; the live input's placeholder must not smuggle it back.
    const ph = await page
      .locator("[data-testid='term-search']")
      .getAttribute("placeholder");
    expect(ph).not.toMatch(/semantic|understands|meaning of your term/i);
    expect(ph).toMatch(/search|concept|variable|cohort/i);
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
  test("@gate1 a refused continue leaves the reviewer on Gate 1 and repeats what the server said", async ({
    page,
  }) => {
    await openGate1(page);
    // NEW DEFAULT is deselected, so scope one group in to enable Continue before exercising the refusal.
    await page
      .locator("[data-testid='ledger-row']")
      .first()
      .locator("[data-testid='queue-scope']")
      .click();
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

  test("@gate1 continue cannot be pressed twice while it is in flight", async ({
    page,
  }) => {
    await openGate1(page);
    // NEW DEFAULT is deselected, so scope one group in to enable Continue.
    await page
      .locator("[data-testid='ledger-row']")
      .first()
      .locator("[data-testid='queue-scope']")
      .click();
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
    const groups = [
      { cohorts: ["ukbb", "aou"] },
      { cohorts: ["aou"] },
      { cohorts: ["clsa"] },
    ];
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

  test("@gate1 a single-cohort group does not look like one spanning everything", async ({
    page,
  }) => {
    await openGate1(page);
    // 08-16f: the segmented coverage strip was replaced by cohort chips on the row — a single-cohort
    // group shows one, a cross-cohort group several, so the two do not read alike.
    const groups = fixtureGroups();
    const single = groups.find((g) => !g.crossCohort)!;
    const cross = groups.find((g) => g.crossCohort && g.cohorts.length > 1)!;
    const singleRow = page.locator(
      `[data-testid='ledger-row'][data-row-id="${single.groupId}"]`,
    );
    const crossRow = page.locator(
      `[data-testid='ledger-row'][data-row-id="${cross.groupId}"]`,
    );
    await expect(singleRow).toContainText(new RegExp(single.cohorts[0], "i"));
    for (const c of cross.cohorts)
      await expect(crossRow).toContainText(new RegExp(c, "i"));
    expect(cross.cohorts.length).toBeGreaterThan(single.cohorts.length);
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
  const base = {
    concept: "",
    coherence: "single",
    coherenceSummary: "",
    idealCde: "",
    memberVariableNames: [],
  } as never;
  const g = (over: Record<string, unknown>) =>
    ({ ...(base as object), ...over }) as never;

  test("@gate1 a generated name is the label and is still marked generated", () => {
    expect(groupLabel(g({ concept: "Systolic blood pressure" }))).toEqual({
      text: "Systolic blood pressure",
      source: "generated",
    });
  });

  test("@gate1 an unnamed but JUDGED group shows the judge's sentence, marked as the judge's", () => {
    expect(
      groupLabel(
        g({
          concept: "",
          coherence: "single",
          coherenceSummary: "Cigarette smoking history",
        }),
      ),
    ).toEqual({ text: "Cigarette smoking history", source: "judge" });
  });

  test("@gate1 a generated name always wins — the summary never overrides a produced name", () => {
    expect(
      groupLabel(
        g({
          concept: "Smoking status",
          coherenceSummary: "Cigarette smoking history",
        }),
      ).source,
    ).toBe("generated");
  });

  /** The third state. A group that was never judged has no sentence to lend, and its `""` is not a verdict. */
  test("@gate1 an UNJUDGED group is never made to borrow, even if a summary string is present", () => {
    expect(
      groupLabel(
        g({
          concept: "",
          coherence: "not_judged",
          coherenceSummary: "leftover text",
        }),
      ),
    ).toEqual({ text: "Unnamed group", source: "none" });
  });

  test("@gate1 a judged group whose summary is empty reads as unnamed rather than blank", () => {
    const out = groupLabel(
      g({ concept: "", coherence: "single", coherenceSummary: "   " }),
    );
    expect(out).toEqual({ text: "Unnamed group", source: "none" });
    expect(out.text).not.toBe("");
  });

  test("@gate1 a borrowed label is searchable; a summary that is NOT the label is not", () => {
    // Visible text must be findable...
    expect(
      searchableText(
        g({
          concept: "",
          coherence: "single",
          coherenceSummary: "Cigarette smoking",
        }),
      ),
    ).toContain("cigarette smoking");
    // ...and text that is not on screen must not be, or the search matches what the reviewer cannot see.
    expect(
      searchableText(
        g({ concept: "Smoking status", coherenceSummary: "Cigarette smoking" }),
      ),
    ).not.toContain("cigarette");
  });

  test("@gate1 the row marks a borrowed label differently from a generated one", async ({
    page,
  }) => {
    // Target a CROSS-COHORT group and locate its row by id: the ledger sorts (verdict, breadth, size, id)
    // and opens on the cross-cohort bucket, so `conceptGroups[0]` is neither the first row on screen nor
    // necessarily rendered at all.
    let id = "";
    await serveRun(page, (run) => {
      const target =
        run.result!.conceptGroups!.find((x) => x.crossCohort) ??
        run.result!.conceptGroups![0];
      id = target.groupId;
      target.concept = "";
      // A judge label is borrowed ONLY when there is no concept AND no idealCde — groupLabel prefers the
      // generated idealCde over the judge's summary (08-16g). Clear it so this row is genuinely borrowed.
      target.idealCde = "";
      target.coherence = "single";
      target.coherenceSummary =
        "Self-reported cigarette smoking across the cohorts";
    });
    await openGate1(page);
    const row = page.locator(`[data-testid='ledger-row'][data-row-id="${id}"]`);
    await expect(row).toBeVisible();
    // The sentence is shown, attributed to the judge, and NOT dressed as a generated name.
    await expect(row.locator("[data-label-source='judge']")).toContainText(
      "Self-reported cigarette smoking",
    );
    await expect(row.locator("[data-testid='borrowed-mark']")).toBeVisible();
    // The full sentence stays reachable even though the line is truncated.
    expect(
      await row
        .locator("[data-label-source='judge']")
        .evaluate((el) => el.closest("[title]")?.getAttribute("title")),
    ).toBe("Self-reported cigarette smoking across the cohorts");
  });

  /**
   * A PILL MARKS THE EXCEPTION, NOT THE RULE (08-16c review). Bhargav: *"if everything has this
   * generated tag then it has no value, right?"*
   *
   * Asserted over the WHOLE default view rather than on one row, because the defect was a property of the
   * set: every row carrying the same pill. The two informative pills are asserted to still work in the
   * tests around this one.
   */
  test("@gate1 no row on an untouched run wears a provenance pill, because none is an exception yet", async ({
    page,
  }) => {
    await openGate1(page);
    const rows = page.locator("[data-testid='ledger-row']");
    expect(await rows.count()).toBeGreaterThan(0);
    // Generated is the default and the fixture is untouched, so there is nothing to report on any row.
    expect(await page.locator("[data-testid='generated-mark']").count()).toBe(
      0,
    );
    expect(await page.locator("[data-testid='renamed-mark']").count()).toBe(0);
    // ...and the provenance is still on the row for anything that needs to read it.
    expect(
      await page.locator("[data-label-source='generated']").count(),
    ).toBeGreaterThan(0);
  });

  test("@gate1 an unnamed, unjudged row carries NO provenance mark at all", async ({
    page,
  }) => {
    let id = "";
    await serveRun(page, (run) => {
      const target =
        run.result!.conceptGroups!.find((x) => x.crossCohort) ??
        run.result!.conceptGroups![0];
      id = target.groupId;
      target.concept = "";
      // No concept, no idealCde and unjudged → truly unnamed, so groupLabel falls all the way to "none".
      target.idealCde = "";
      target.coherence = "not_judged";
      target.coherenceSummary = "";
    });
    await openGate1(page);
    const row = page.locator(`[data-testid='ledger-row'][data-row-id="${id}"]`);
    await expect(row).toBeVisible();
    await expect(row.locator("[data-label-source='none']")).toContainText(
      "Unnamed group",
    );
    await expect(row.locator("[data-testid='borrowed-mark']")).toHaveCount(0);
    await expect(row.locator("[data-testid='renamed-mark']")).toHaveCount(0);
  });
});

/**
 * Bulk scope — "select all / deselect all" and its two traps (08-16c Task 7).
 */
test.describe("gate1 bulk scope", () => {
  // NEW DEFAULT (08-23b subset): a group is OUT unless an explicit "in" decision puts it in — the score
  // builder's auto-selection is modelled here by an explicit "in".
  const inScopeOf = (map: Record<string, string>) => (id: string) => map[id] === "in";

  /**
   * THE TRAP THAT MATTERS, INVERTED. With OUT the default and `isChanged` = `id in scope.decisions`, the
   * deliberate act is now SELECTING: "select all" writes "in" to exactly the shown rows that are out, and
   * "deselect all" writes "out" to exactly the ones that are in — neither re-writes a row already where it
   * is being sent, so a bulk press never fakes a departure on rows that would not move.
   */
  test("@gate1 selecting all writes 'in' for exactly the shown rows that are out", () => {
    const decisions = { a: "out", b: "in", c: "out" };
    const plan = bulkScopePlan(["a", "b", "c", "d"], "in", inScopeOf(decisions));
    expect(plan.clear).toEqual([]);
    // b is already in; a and c are explicitly out, d is out by default — admit all three.
    expect(plan.write).toEqual(["a", "c", "d"]);
  });

  test("@gate1 an already-in group is not re-written by selecting all", () => {
    const decisions = { b: "in" };
    expect(bulkScopePlan(["b"], "in", inScopeOf(decisions))).toEqual({ clear: [], write: [] });
  });

  test("@gate1 taking all out writes 'out' only for groups currently in scope", () => {
    const decisions = { a: "out", b: "in" };
    const plan = bulkScopePlan(["a", "b", "c"], "out", inScopeOf(decisions));
    expect(plan.clear).toEqual([]);
    // b is in — take it out; a is already out and c is out by default, so both are untouched.
    expect(plan.write).toEqual(["b"]);
  });

  test("@gate1 the control reports a real tri-state, never 'all' over a partial set", () => {
    expect(bulkScopeState(["a", "b"], inScopeOf({ a: "in", b: "in" }))).toBe("all");
    expect(bulkScopeState(["a", "b"], inScopeOf({}))).toBe("none");
    expect(bulkScopeState(["a", "b"], inScopeOf({ a: "in" }))).toBe("some");
    expect(bulkScopeState([], inScopeOf({}))).toBe("none");
  });

  test("@gate1 the control names how many rows it will affect, and acts on the VISIBLE ones", async ({
    page,
  }) => {
    await openGate1(page);
    const bulk = page.locator("[data-testid='bulk-scope']");
    await expect(bulk).toBeVisible();
    const rows = await page.locator("[data-testid='ledger-row']").count();
    // The number on the control is the number of rows on screen — stated before the press.
    await expect(bulk.locator("[data-testid='bulk-scope-out']")).toContainText(
      `${rows}`,
    );
    await expect(bulk.locator("[data-testid='bulk-scope-in']")).toContainText(
      `${rows}`,
    );
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

    await expect(bulk.locator("[data-testid='bulk-scope-in']")).toHaveText(
      `Select all ${rows} shown`,
    );
    await expect(bulk.locator("[data-testid='bulk-scope-out']")).toHaveText(
      `Deselect all ${rows} shown`,
    );
    await expect(bulk).toContainText(`${rows} groups shown are selected`);

    // ...and it keeps saying so once a filter has narrowed what "all" means.
    await page.locator("[data-testid='verdict-select']").click();
    await page
      .getByRole("option", { name: COHERENCE_COPY["split"].label })
      .click();
    const narrowed = await page.locator("[data-testid='ledger-row']").count();
    expect(narrowed).toBeLessThan(rows);
    await expect(bulk.locator("[data-testid='bulk-scope-in']")).toHaveText(
      `Select all ${narrowed} shown`,
    );
    await expect(bulk.locator("[data-testid='bulk-scope-out']")).toHaveText(
      `Deselect all ${narrowed} shown`,
    );
  });

  test("@gate1 taking all out drops the price by exactly the rows it affected, and no more", async ({
    page,
  }) => {
    await openGate1(page);
    const bar = page.locator("[data-testid='commit-bar']");
    // NEW DEFAULT is deselected: select everything first, so there is a full price to erode.
    await page.locator("[data-testid='bulk-scope-in']").click();
    const full = Number(await bar.getAttribute("data-total"));
    expect(full).toBeGreaterThan(0);
    // Narrow to the cross-cohort bucket so the single-cohort groups are OFF screen. Bulk "all" acts on
    // the SHOWN rows only, so it must leave the off-screen ones in scope (08-16f: the view is the filter).
    await page.locator("[data-testid='cross-cohort-toggle']").click();
    const shown = await page.locator("[data-testid='ledger-row']").count();
    expect(shown).toBeGreaterThan(0);

    await page.locator("[data-testid='bulk-scope-out']").click();
    await expect(page.locator("[data-testid='bulk-scope']")).toHaveAttribute(
      "data-state",
      "none",
    );

    // Back to the whole corpus: the single-cohort groups were off-screen and stayed IN, so the total
    // dropped by exactly the cross-cohort rows and no more.
    await page.locator("[data-testid='cross-cohort-toggle']").click();
    const after = Number(await bar.getAttribute("data-total"));
    expect(after).toBeLessThan(full);
    expect(after).toBeGreaterThan(0);
  });
  /**
   * BULK IS THE DELIBERATE ACT, and the spine tracks it honestly. With OUT the default (08-23b subset),
   * nothing is marked until the reviewer acts; "select all" then carries their own scope decisions, so the
   * rows are marked. The guarantee `bulkScopePlan` still holds — a bulk press never re-writes a row already
   * where it is being sent — is asserted in the unit test above; here it is the visible before/after.
   */
  test("@gate1 nothing is marked until a bulk press, then selecting all carries the decisions", async ({
    page,
  }) => {
    await openGate1(page);
    const changed = () =>
      page.locator("[data-testid='ledger-row'][data-spine='changed']").count();
    // New default: nothing selected, nothing marked.
    expect(await changed()).toBe(0);
    await page.locator("[data-testid='bulk-scope-in']").click();
    await expect(page.locator("[data-testid='bulk-scope']")).toHaveAttribute(
      "data-state",
      "all",
    );
    // The selections are the reviewer's own scope decisions, so the rows carry them.
    expect(await changed()).toBeGreaterThan(0);
    // ...and deselecting takes them all back out.
    await page.locator("[data-testid='bulk-scope-out']").click();
    await expect(page.locator("[data-testid='bulk-scope']")).toHaveAttribute(
      "data-state",
      "none",
    );
  });

  test("@gate1 once everything shown is selected, Select all is itself unavailable", async ({
    page,
  }) => {
    await openGate1(page);
    await page.locator("[data-testid='bulk-scope-in']").click();
    await expect(page.locator("[data-testid='bulk-scope']")).toHaveAttribute(
      "data-state",
      "all",
    );
    // Nothing left to select, so the control says so rather than offering a no-op.
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
    expect(toggleSort({ key: "vars", dir: "asc" }, "vars")).toEqual({
      key: "vars",
      dir: "desc",
    });
    expect(toggleSort({ key: "vars", dir: "desc" }, "vars")).toEqual({
      key: "vars",
      dir: "asc",
    });
    expect(toggleSort({ key: "vars", dir: "desc" }, "cohorts")).toEqual({
      key: "cohorts",
      dir: "asc",
    });
  });

  test("@gate1 no explicit sort keeps the ledger's documented default order", () => {
    const groups = fixtureGroups();
    expect(sortGroupsByColumn(groups, null).map((g) => g.groupId)).toEqual(
      sortGroups(groups).map((g) => g.groupId),
    );
  });

  /** Verdict sorts by REVIEW PRIORITY, not alphabetically — the discipline copied from `sortValue`. */
  test("@gate1 verdict sorts by triage priority rather than by the rendered word", () => {
    const ids = sortGroupsByColumn(fixtureGroups(), {
      key: "verdict",
      dir: "asc",
    });
    const ranks = ids.map((g) => COHERENCE_ORDER[g.coherence]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  test("@gate1 cohorts sorts by breadth (a count), not by the joined cohort names", () => {
    const desc = sortGroupsByColumn(fixtureGroups(), {
      key: "cohorts",
      dir: "desc",
    });
    const counts = desc.map((g) => g.cohorts.length);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
  });

  test("@gate1 reversing a column reverses the rows", () => {
    const asc = sortGroupsByColumn(fixtureGroups(), {
      key: "vars",
      dir: "asc",
    }).map((g) => g.nMembers);
    const desc = sortGroupsByColumn(fixtureGroups(), {
      key: "vars",
      dir: "desc",
    }).map((g) => g.nMembers);
    expect(asc).toEqual([...asc].sort((a, b) => a - b));
    expect(desc).toEqual([...desc].sort((a, b) => b - a));
  });

  test("@gate1 the order stays TOTAL — no two rows tie, so a reload cannot reorder the screen", () => {
    const groups = fixtureGroups();
    const once = sortGroupsByColumn(groups, {
      key: "cohorts",
      dir: "desc",
    }).map((g) => g.groupId);
    const again = sortGroupsByColumn([...groups].reverse(), {
      key: "cohorts",
      dir: "desc",
    }).map((g) => g.groupId);
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
  test("@gate1 the order select is gone, and no order it named went with it", async ({
    page,
  }) => {
    await openGate1(page);
    await expect(page.locator("#ledger-sort")).toHaveCount(0);
    await expect(
      page.locator("[data-testid='ledger-toolbar'] select"),
    ).toHaveCount(0);

    // "Flagged first" — the ledger's own default order over EVERY group (08-16f: no bucket default),
    // arriving with no control touched at all.
    const groups = fixtureGroups();
    expect(await rowIds(page)).toEqual(
      sortGroupsByColumn(groups, null).map((g) => g.groupId),
    );

    // ...and each of the other two, by clicking the header that owns it. One click sorts ascending, a
    // second reverses — the descending order the old preset named.
    for (const [head, key] of [
      ["sort-cohorts", "cohorts"],
      ["sort-vars", "vars"],
    ] as const) {
      await page.locator(`[data-testid='${head}']`).click();
      await page.locator(`[data-testid='${head}']`).click();
      const shown = await rowIds(page);
      const expected = sortGroupsByColumn(groups, { key, dir: "desc" }).map(
        (g) => g.groupId,
      );
      expect(
        shown,
        `the ${key} header must reach the order the select called a preset`,
      ).toEqual(expected);
    }
  });
  test("@gate1 clicking a header sorts the rows and says so, and clicking again reverses", async ({
    page,
  }) => {
    await openGate1(page);
    const head = page.locator("[data-testid='sort-vars']");
    await expect(head).toBeVisible();

    await head.click();
    // Which way it is sorting is visible on the header itself — an up arrow for ascending.
    await expect(head).toContainText("↑");
    const asc = await rowIds(page);

    await head.click();
    await expect(head).toContainText("↓");
    const desc = await rowIds(page);

    // The direction genuinely reversed — the row that led now trails — while the row SET is untouched.
    expect(desc[0]).not.toBe(asc[0]);
    expect(desc[desc.length - 1]).not.toBe(asc[asc.length - 1]);
    expect([...desc].sort()).toEqual([...asc].sort());
  });
  test("@gate1 the price column is not offered as a sort — every row carries the same figure", async ({
    page,
  }) => {
    await openGate1(page);
    await expect(page.locator("[data-testid='sort-concept']")).toBeVisible();
    // "Gate 2+" has no sortKey, so no button is rendered for it.
    await expect(page.locator("[data-testid='sort-cost']")).toHaveCount(0);
  });

  test("@gate1 sorting composes with the bucket and filters rather than widening them", async ({
    page,
  }) => {
    await openGate1(page);
    const before = (await rowIds(page)).length;
    await page.locator("[data-testid='sort-concept']").click();
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

  test("@gate1 a passed Gate 1 says it is a record and offers the way back", async ({
    page,
  }) => {
    await openPastGate1(page);
    await expect(page.locator("[data-testid='gate-frozen']")).toBeVisible();
    await expect(
      page.locator("[data-testid='gate-frozen-back']"),
    ).toContainText(/Concepts/i);
  });

  test("@gate1 the decisions are still VISIBLE — that is what looking back is for", async ({
    page,
  }) => {
    await openPastGate1(page);
    await expect(page.locator("[data-testid='ledger']")).toBeVisible();
    expect(
      await page.locator("[data-testid='ledger-row']").count(),
    ).toBeGreaterThan(0);
    // The decisions and their cohort chips are still legible looking back (the coverage strip was
    // replaced by chips in 08-16f).
    await expect(
      page.locator("[data-testid='ledger-row']").first(),
    ).toBeVisible();
  });

  test("@gate1 no control on a passed gate offers to change a decision", async ({
    page,
  }) => {
    await openPastGate1(page);
    // The per-row scope checkbox...
    const boxes = page.locator(
      "[data-testid='ledger-row'] button[role='checkbox']",
    );
    expect(await boxes.count()).toBeGreaterThan(0);
    await expect(boxes.first()).toBeDisabled();
    // ...the bulk control...
    await expect(page.locator("[data-testid='bulk-scope-in']")).toBeDisabled();
    await expect(page.locator("[data-testid='bulk-scope-out']")).toBeDisabled();
    // ...and Continue, which would buy work this run has already bought.
    await expect(
      page.locator("[data-testid='commit-bar'] button"),
    ).toBeDisabled();
  });

  test("@gate1 the run's CURRENT gate is unaffected — it is not a record", async ({
    page,
  }) => {
    await openGate1(page); // fixture parks AT gate1
    await expect(page.locator("[data-testid='gate-frozen']")).toHaveCount(0);
    const checkbox = page
      .locator("[data-testid='ledger-row'] button[role='checkbox']")
      .first();
    await expect(checkbox).toBeEnabled();
    // NEW DEFAULT is deselected, so scope one group in to show Continue is live on the current gate.
    await checkbox.click();
    await expect(
      page.locator("[data-testid='commit-bar'] button"),
    ).toBeEnabled();
  });
});

/**
 * The numbered how-to has to describe the screen that EXISTS — the same contract 08-14g held Setup's list
 * to, now applied to Gate 1's (08-16c review).
 *
 * Bhargav read the list against the screen: it covered the grouping strip, the search, the tick boxes and
 * opening a group, and never said the reviewer can drag variables between groups. That is the screen's
 * most powerful action and its least discoverable one — nothing about a row announces that it can be
 * picked up — so a list that omits it is a confident wrong map rather than merely incomplete.
 */
test.describe("gate1 how-to", () => {
  async function openHowTo(page: Page) {
    const panel = page.getByTestId("how-to");
    await panel.getByRole("button").first().click();
    return panel;
  }

  test("@gate1 the how-to tells the reviewer they can drag variables between groups", async ({
    page,
  }) => {
    await openGate1(page);
    const panel = await openHowTo(page);
    const text = await panel.innerText();
    expect(text.toLowerCase()).toContain("drag");
    // It names both destinations the gesture has, not just the neighbouring group.
    expect(text.toLowerCase()).toContain("in no group");
    // ...and it says the correction is not waiting on a save button, which is the other half of trusting it.
    expect(text.toLowerCase()).toMatch(/save|saved/);
  });

  /** The same guard 08-14g put on Setup's list: this panel is orientation, and may not grow into a manual. */
  test("@gate1 the how-to stays orientation, not documentation", async ({
    page,
  }) => {
    await openGate1(page);
    const panel = await openHowTo(page);
    const n = await panel.locator("li").count();
    expect(n, "the orientation list grew into a manual").toBeLessThanOrEqual(6);
    const text = await panel.innerText();
    expect(
      text.length,
      "the orientation panel is too long to read in one pass",
    ).toBeLessThan(700);
  });
});

/**
 * ONE POOL OF UNPLACED VARIABLES, NOT ONE PER GROUP (08-16c review, option b).
 *
 * Before this there were two disjoint things, and neither was the pool a reviewer needs. Each EXPANDED
 * GROUP carried its own "In no group" list filtered to the variables that had started in THAT group — so
 * the same conceptual place had 54 renderings, and a variable pulled out of group A was invisible from
 * group B. Separately, the clustering's OWN leftovers (`result.unassignedFields`) were rendered once, in a
 * section that only appeared when the run had produced NO groups at all — so on every real run they were
 * unreachable.
 *
 * WHAT REPLACES IT: one pool, rendered once, holding both. The in-row drop zone stays, because it is the
 * DOOR the gesture needs while a group is open — but it is a door onto the shared pool rather than a pool
 * of its own, and it no longer lists anything.
 *
 * THE TWO ORIGINS ARE LABELLED AND NEVER MERGED, which is the load-bearing part. "You took this out" and
 * "the clustering never placed this" are different facts about a variable — one is the reviewer's own
 * decision, the other is a property of the run — and a single undifferentiated list would report the
 * pipeline's leftovers as the reviewer's doing.
 */
test.describe("gate1 unassigned pool", () => {
  const POOL = "[data-testid='unassigned-pool']";
  /** Two pipeline leftovers, which the shipped fixture does not have (it carries zero). */
  const LEFTOVERS = [
    {
      cohort: "ukbb",
      variable: "zz_never_clustered_a",
      text: "A variable the clustering never placed",
    },
    {
      cohort: "aou",
      variable: "zz_never_clustered_b",
      text: "Another one the clustering never placed",
    },
  ];

  test("@gate1 a variable moved into a group from the pool actually lands there", () => {
    const groups = fixtureGroups().slice(0, 2);
    const byGroup = {
      [groups[0].groupId]: ["c:one"],
      [groups[1].groupId]: ["c:two"],
    };
    const out = effectiveMembers(groups, byGroup, {
      "ukbb:loose": groups[1].groupId,
    });
    expect(out.byGroup[groups[1].groupId]).toContain("ukbb:loose");
    expect(out.unassigned).not.toContain("ukbb:loose");
  });

  test("@gate1 a pipeline leftover the reviewer has placed stops being listed as unplaced", () => {
    const ids = ["g1", "g2"];
    expect(unplacedFields(LEFTOVERS, {}, ids).map((f) => f.variable)).toEqual([
      "zz_never_clustered_a",
      "zz_never_clustered_b",
    ]);
    expect(
      unplacedFields(LEFTOVERS, { "ukbb:zz_never_clustered_a": "g1" }, ids).map(
        (f) => f.variable,
      ),
    ).toEqual(["zz_never_clustered_b"]);
    // Moved to the pool is NOT a placement — it is where it already was.
    expect(
      unplacedFields(
        LEFTOVERS,
        { "ukbb:zz_never_clustered_a": "__unassigned__" },
        ids,
      ).map((f) => f.variable),
    ).toEqual(["zz_never_clustered_a", "zz_never_clustered_b"]);
  });

  test("@gate1 there is exactly ONE pool on the screen, expanded or not", async ({
    page,
  }) => {
    await serveRun(page, (run) => {
      run.result!.unassignedFields = LEFTOVERS;
    });
    await openGate1(page);
    // MASTER-DETAIL (08-16f): the pool is one sidebar entry always, and one detail panel when opened.
    const entry = page.locator("[data-testid='gate1-pool-entry']");
    await expect(entry).toHaveCount(1);
    await expandRow(page, BIG);
    await expect(entry).toHaveCount(1);
    await expect(page.locator(POOL)).toHaveCount(0);
    await expandPool(page);
    await expect(page.locator(POOL)).toHaveCount(1);
  });

  test("@gate1 the two origins are shown together but labelled, and never merged", async ({
    page,
  }) => {
    await serveRun(page, (run) => {
      run.result!.unassignedFields = LEFTOVERS;
    });
    await openGate1(page);
    // The move happens while the GROUP is selected (its pool door is in the group detail); only then do
    // we open the pool — the detail pane shows a group OR the pool, never both (08-16f).
    const row = await expandRow(page, BIG);
    const member = row.locator("[data-testid='member-row']").first();
    const memberId = await member.getAttribute("data-member-id");
    await member.dragTo(
      row.locator(
        "[data-testid='member-drop-zone'][data-group-id='__unassigned__']",
      ),
    );

    await expandPool(page);
    const fromPipeline = page.locator(
      `${POOL} [data-testid='pool-pipeline'] :is([data-testid='member-row'],[data-testid='member-chip'])`,
    );
    await expect(fromPipeline).toHaveCount(2);
    const fromReviewer = page.locator(
      `${POOL} [data-testid='pool-reviewer'] :is([data-testid='member-row'],[data-testid='member-chip'])`,
    );
    await expect(fromReviewer).toHaveCount(1);
    await expect(fromReviewer.first()).toHaveAttribute(
      "data-member-id",
      memberId!,
    );
    await expect(fromPipeline).toHaveCount(2);
    await expect(
      page.locator(`${POOL} [data-testid='pool-reviewer']`),
    ).toContainText(/you took/i);
    await expect(
      page.locator(`${POOL} [data-testid='pool-pipeline']`),
    ).toContainText(/clustering/i);
  });

  test("@gate1 the pool survives a reload, because it is derived from the decisions", async ({
    page,
  }) => {
    await openGate1(page);
    const row = await expandRow(page, BIG);
    const member = row.locator("[data-testid='member-row']").first();
    const memberId = await member.getAttribute("data-member-id");
    await member.dragTo(
      row.locator(
        "[data-testid='member-drop-zone'][data-group-id='__unassigned__']",
      ),
    );
    await expandPool(page);
    await expect(page.locator(pooled(memberId!))).toHaveCount(1);

    await page.reload();
    await page.waitForLoadState("networkidle");
    await expandPool(page);
    await expect(page.locator(pooled(memberId!))).toHaveCount(1);
  });

  /**
   * The pool is a HOLDING AREA, not a bin: what went in can come back out, into ANY group — not only the
   * one it came from.
   *
   * THE LEDGER IS NARROWED FIRST, and that is a statement about the product rather than test staging. A
   * native HTML5 drag cannot BEGIN from a source outside the viewport, and the pool sits below the
   * ledger: with 28 rows on screen the chip is off-screen while the rows are above it, so the browser
   * never fires `dragstart` (measured — zero drag events, `elementFromPoint` at the chip's centre returns
   * null). Filtering to two rows puts the pool beside them and the whole gesture fires as it should.
   * That limit is exactly why the keyboard path below exists rather than being a nicety.
   */
  test("@gate1 a variable in the pool can be dragged back into a group", async ({
    page,
  }) => {
    await openGate1(page);
    const row = await expandRow(page, BIG);
    const member = row.locator("[data-testid='member-row']").first();
    const memberId = await member.getAttribute("data-member-id");
    await member.dragTo(
      row.locator(
        "[data-testid='member-drop-zone'][data-group-id='__unassigned__']",
      ),
    );

    // The pool opens in the detail pane; the sidebar rows stay on screen beside it, so a pooled variable
    // drags straight onto a LEDGER ROW with none of the old narrow-the-ledger staging (08-16f).
    await expandPool(page);
    await expect(page.locator(pooled(memberId!))).toHaveCount(1);
    const target = page.locator("[data-testid='ledger-row']").first();
    const targetId = await target.getAttribute("data-row-id");
    expect(targetId).not.toBe(BIG); // a DIFFERENT group — "any group", not merely undo

    await page.locator(pooled(memberId!)).first().dragTo(target);

    await expect(page.locator(pooled(memberId!))).toHaveCount(0);
    const receiving = await expandRow(page, targetId!);
    await expect(
      receiving.locator(`[data-member-id='${memberId}']`).first(),
    ).toBeVisible();
  });

  /**
   * PUTTING A VARIABLE BACK IS REACHABLE WITHOUT A MOUSE.
   *
   * This screen already holds that "a drag with no keyboard equivalent is a regression, not a
   * simplification" — the × beside each row exists for that reason. The pool introduces a new drag, so it
   * needs the same, and here it is load-bearing twice over: the browser will not start a drag from an
   * off-screen source, which is the pool's ordinary position on a full ledger.
   */
  test("@gate1 a variable can be put back without a mouse, and the row stops being marked changed", async ({
    page,
  }) => {
    await openGate1(page);
    const row = await expandRow(page, BIG);
    const member = row.locator("[data-testid='member-row']").first();
    const memberId = await member.getAttribute("data-member-id");
    await member.dragTo(
      row.locator(
        "[data-testid='member-drop-zone'][data-group-id='__unassigned__']",
      ),
    );
    await expect(
      page.locator(`[data-testid='ledger-row'][data-row-id='${BIG}']`),
    ).toHaveAttribute("data-spine", "changed");
    await expandPool(page);

    const back = page.locator(
      `${POOL} [data-testid='pool-put-back'][data-member-id='${memberId}']`,
    );
    await back.focus();
    await expect(back).toBeFocused();
    // NAMED for the variable it acts on, not "undo".
    await expect(back).toHaveAttribute(
      "aria-label",
      /put .+ back in the group/i,
    );
    await page.keyboard.press("Enter");

    // It returned to the group it came from, and the pool no longer holds it.
    await expect(page.locator(pooled(memberId!))).toHaveCount(0);
    const backInGroup = await expandRow(page, BIG);
    await expect(
      backInGroup.locator(`[data-member-id='${memberId}']`).first(),
    ).toBeVisible();
    // A CLEARED decision, not a written one: the row is no longer marked as changed on its account.
    await expect(
      page.locator(`[data-testid='ledger-row'][data-row-id='${BIG}']`),
    ).not.toHaveAttribute("data-spine", "changed");
  });

  /** A pipeline leftover has no origin to return to, so it is not offered a put-back it cannot honour. */
  test("@gate1 a variable the clustering never placed is offered no put-back", async ({
    page,
  }) => {
    await serveRun(page, (run) => {
      run.result!.unassignedFields = LEFTOVERS;
    });
    await openGate1(page);
    await expandPool(page);
    await expect(
      page.locator(
        `${POOL} [data-testid='pool-pipeline'] [data-testid='pool-put-back']`,
      ),
    ).toHaveCount(0);
  });

  test("@gate1 the pool states its count, above the Continue bar", async ({
    page,
  }) => {
    await serveRun(page, (run) => {
      run.result!.unassignedFields = LEFTOVERS;
    });
    await openGate1(page);
    // The count is on the sidebar pool entry, visible without opening it, and above the Continue bar.
    await expect(
      page.locator("[data-testid='gate1-pool-entry']"),
    ).toContainText("2");

    const order = await page.evaluate(() => {
      const p = document.querySelector("[data-testid='gate1-pool-entry']");
      const bar = document.querySelector("[data-testid='commit-bar']");
      if (!p || !bar) return "missing";
      return p.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING
        ? "before"
        : "after";
    });
    expect(order).toBe("before");
  });

  test("@gate1 the pool does not describe itself as a one-way exclusion", async ({
    page,
  }) => {
    await serveRun(page, (run) => {
      run.result!.unassignedFields = LEFTOVERS;
    });
    await openGate1(page);
    await expandPool(page);
    // The copy that says what being in no group costs — and that it is reversible — is in the pool panel.
    const text = (await page.locator(POOL).innerText()).toLowerCase();
    expect(text).toMatch(/gate 2|assigned|matched/);
    expect(text).toMatch(/back|any group|put/);
  });

  test("@gate1 the pool search finds a variable past the 100-row cap and keeps it draggable", async ({
    page,
  }) => {
    // A pool big enough to trip the render cap, with the target LAST so it sits past the first 100 rows.
    // Rich fieldIndex so the capped evidence GRID engages (the uncapped chip fallback would hide the cap).
    const target = "clsa:country_of_birth";
    await serveRun(page, (run) => {
      const leftovers: { cohort: string; variable: string; text: string }[] = [];
      const fieldIndex: Record<string, { name: string; text: string; description: string }> = {};
      for (let i = 0; i < 130; i++) {
        const v = `filler_${String(i).padStart(3, "0")}`;
        leftovers.push({ cohort: "ukbb", variable: v, text: `filler variable ${i}` });
        fieldIndex[`ukbb:${v}`] = { name: v, text: `filler variable ${i}`, description: `filler description ${i}` };
      }
      leftovers.push({ cohort: "clsa", variable: "country_of_birth", text: "In what country were you born?" });
      fieldIndex[target] = {
        name: "country_of_birth",
        text: "In what country were you born?",
        description: "Country where the participant was born",
      };
      run.result!.unassignedFields = leftovers;
      run.result!.fieldIndex = { ...(run.result!.fieldIndex ?? {}), ...fieldIndex } as never;
    });
    await openGate1(page);
    await expandPool(page);

    const targetRow = page.locator(
      `${POOL} :is([data-testid='member-row'],[data-testid='member-chip'])[data-member-id='${target}']`,
    );
    // Before searching, the target is past the cap: the grid shows the first 100 and says so, and the
    // target — row 131 — is not rendered.
    await expect(page.locator(`${POOL}`)).toContainText(/showing the first 100 of 131/i);
    await expect(targetRow).toHaveCount(0);

    // Search surfaces it — filtering runs upstream of the cap, so a match at row 131 still appears.
    const search = page.locator("[data-testid='pool-search']");
    await expect(search).toBeVisible();
    await search.fill("country of birth");
    await expect(targetRow).toHaveCount(1);
    // ...and the fillers are gone, so the reviewer is looking at the match, not scrolling for it.
    await expect(
      page.locator(`${POOL} :is([data-testid='member-row'],[data-testid='member-chip'])[data-member-id='ukbb:filler_000']`),
    ).toHaveCount(0);
    // A match under the cap drops the "first 100 of" footer.
    await expect(page.locator(`${POOL}`)).not.toContainText(/showing the first 100/i);

    // It stays a draggable row (the whole point is to drag it onto a group).
    await expect(targetRow).toHaveAttribute("draggable", "true");

    // Clearing the search restores the capped view, target hidden again.
    await search.fill("");
    await expect(targetRow).toHaveCount(0);
  });
});

/**
 * THE TRAY LEADS WITH THE GROUPS YOU HAVE JUST BEEN FILLING (08-16c review).
 *
 * Bhargav: *"these should be ordered by 'most recently added to' groups at the top."* Recency of the
 * REVIEWER'S OWN moves, not of anything the pipeline did — a reviewer carving one concept out of several
 * groups goes back to the same destination repeatedly, and it should not have scrolled away.
 *
 * DERIVED FROM PERSISTED DECISIONS, NEVER REMEMBERED. R6, and the same rule that shaped Task 7: an order
 * held in component state is gone on reload, and this one has to survive it or it is a convenience that
 * disappears exactly when a reviewer comes back to finish.
 */
test.describe("gate1 tray recency", () => {
  const g = (id: string): ConceptGroup =>
    fixtureGroups().find((x) => x.groupId === id)!;

  test("@gate1 a group moved into most recently leads, and the rest keep their order", () => {
    const ids = fixtureGroups()
      .slice(0, 5)
      .map((x) => x.groupId);
    const groups = ids.map(g);
    const sorted = sortDestinations(groups, { [ids[3]]: 200, [ids[1]]: 100 });
    // Most recent first, then the next most recent, then the untouched ones in the order given.
    expect(sorted.map((x) => x.groupId)).toEqual([
      ids[3],
      ids[1],
      ids[0],
      ids[2],
      ids[4],
    ]);
  });

  test("@gate1 with no moves at all the tray order is exactly the order it was given", () => {
    const groups = fixtureGroups().slice(0, 6);
    expect(sortDestinations(groups, {}).map((x) => x.groupId)).toEqual(
      groups.map((x) => x.groupId),
    );
  });

  /** A move OUT of a group is not a move INTO it, so it may not promote the group it left. */
  test("@gate1 only the destination is promoted, never the origin", () => {
    const ids = fixtureGroups()
      .slice(0, 3)
      .map((x) => x.groupId);
    const groups = ids.map(g);
    // `lastMovedInto` is keyed on the DESTINATION, so an origin simply never appears in it.
    expect(
      sortDestinations(groups, { [ids[2]]: 50 }).map((x) => x.groupId),
    ).toEqual([ids[2], ids[0], ids[1]]);
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
test.describe("gate1 move between groups", () => {
  /**
   * MOVING A VARIABLE BETWEEN GROUPS (08-16f). The in-detail destination tray was removed — the sidebar
   * IS the destination list now, so a variable is dragged from the open group's rows straight onto
   * another group's row, and the move persists as a decision.
   */
  test("@gate1 dragging a variable onto another group's row moves it into THAT group", async ({
    page,
  }) => {
    await openGate1(page);
    const row = await expandRow(page, BIG);
    const member = row.locator("[data-testid='member-row']").first();
    const memberId = await member.getAttribute("data-member-id");

    const target = page
      .locator(`[data-testid='ledger-row']:not([data-row-id='${BIG}'])`)
      .first();
    const targetId = await target.getAttribute("data-row-id");
    await member.dragTo(target);

    await expect(
      page.locator(`[data-testid='ledger-row'][data-row-id='${BIG}']`),
    ).toHaveAttribute("data-spine", "changed");
    const receiving = await expandRow(page, targetId!);
    await expect(
      receiving.locator(`[data-member-id='${memberId}']`).first(),
    ).toBeVisible();

    // It survives a reload — a persisted decision, not component state.
    await page.reload();
    await page.waitForLoadState("networkidle");
    const again = await expandRow(page, targetId!);
    await expect(
      again.locator(`[data-member-id='${memberId}']`).first(),
    ).toBeVisible();
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
    // MASTER-DETAIL (08-16f): rename lives in the detail pane. Select the row, then edit there.
    await page.locator(BIGROW).click();
    const detail = page.locator("[data-testid='gate1-detail']");
    await detail.locator("[data-testid='rename-group']").click();
    const input = detail.getByRole("textbox", { name: "Rename group" });
    await expect(input).toBeVisible();
    await input.fill(to);
    await input.press("Enter");
  }

  test("@gate1 a group can be renamed in place, and the new name is what the row shows", async ({
    page,
  }) => {
    await openGate1(page);
    await rename(page, "Smoking — my working set");
    await expect(
      page.locator(`${BIGROW} [data-label-source='reviewer']`),
    ).toHaveText("Smoking — my working set");
  });

  test("@gate1 a reviewer's name is marked as theirs, not as the pipeline's", async ({
    page,
  }) => {
    await openGate1(page);
    await rename(page, "My label");
    await expect(
      page.locator(`${BIGROW} [data-testid='renamed-mark']`),
    ).toBeVisible();
  });

  test("@gate1 a rename survives a reload — it is a decision, not component state", async ({
    page,
  }) => {
    await openGate1(page);
    await rename(page, "Persisted name");
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(
      page.locator(`${BIGROW} [data-label-source='reviewer']`),
    ).toHaveText("Persisted name");
  });

  test("@gate1 an empty or whitespace-only rename is refused rather than making a nameless group", async ({
    page,
  }) => {
    await openGate1(page);
    const generated = fixtureGroups().find((g) => g.groupId === BIG)!.concept;
    await rename(page, "Temporary");
    await expect(
      page.locator(`${BIGROW} [data-label-source='reviewer']`),
    ).toBeVisible();
    // Clearing it restores the generated name instead of leaving the row blank.
    await rename(page, "   ");
    await expect(
      page.locator(`${BIGROW} [data-label-source='generated']`),
    ).toHaveText(generated);
    await expect(
      page.locator(`${BIGROW} [data-testid='renamed-mark']`),
    ).toHaveCount(0);
  });

  test("@gate1 the reviewer can find the group again by the name they gave it", async ({
    page,
  }) => {
    await openGate1(page);
    await rename(page, "Zzyzx");
    await page.locator("[data-testid='term-search']").fill("Zzyzx");
    await expect(page.locator(BIGROW)).toBeVisible();
    expect(await page.locator("[data-testid='ledger-row']").count()).toBe(1);
  });

  test("@gate1 a rename marks the row as reviewer-changed", async ({
    page,
  }) => {
    await openGate1(page);
    await rename(page, "Changed by me");
    await expect(page.locator(BIGROW)).toHaveAttribute("data-spine", "changed");
  });

  test("@gate1 renaming replaces a BORROWED judge label and is marked as the reviewer's", async ({
    page,
  }) => {
    await serveRun(page, (run) => {
      const t = run.result!.conceptGroups!.find((g) => g.groupId === BIG)!;
      t.concept = "";
      // Borrowed = no concept AND no idealCde (groupLabel prefers idealCde over the judge summary, 08-16g).
      t.idealCde = "";
      t.coherence = "single";
      t.coherenceSummary = "The judge's sentence about this group";
    });
    await openGate1(page);
    await expect(
      page.locator(`${BIGROW} [data-testid='borrowed-mark']`),
    ).toBeVisible();
    await rename(page, "Mine now");
    await expect(
      page.locator(`${BIGROW} [data-label-source='reviewer']`),
    ).toHaveText("Mine now");
    await expect(
      page.locator(`${BIGROW} [data-testid='borrowed-mark']`),
    ).toHaveCount(0);
    await expect(
      page.locator(`${BIGROW} [data-testid='renamed-mark']`),
    ).toBeVisible();
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

/**
 * LIVE DROP-TARGET HIGHLIGHTING (08-16c review, item D).
 *
 * Bhargav, annotating the live Gate 1: *"the drag drop behavior should have dynamic highlighting of which
 * group is being dragged onto (including no group area) so user knows that theyre dropping their var in
 * the intended place."*
 *
 * WHAT MAKES THIS HARDER THAN A `:hover` RULE, and why the algebra below is asserted in node rather than
 * only eyeballed in the browser:
 *
 *  1. **THE PAYLOAD IS NOT READABLE DURING `dragover`** in every browser — the rule already recorded on
 *     `MemberDropZone` and at `source-rows.tsx`'s grid handler. So a target cannot decide whether to light
 *     up by INSPECTING what is being dragged; it has to light up on ENTER/LEAVE GEOMETRY alone.
 *  2. **`dragleave` FIRES WHEN THE POINTER CROSSES INTO A CHILD.** A naive boolean therefore extinguishes
 *     the highlight the moment the cursor passes over any text or chip inside the zone it is over —
 *     the target flickers off exactly while the reviewer is aiming at it. A DEPTH COUNTER survives that,
 *     because the child's `dragenter` and the parent's `dragleave` are one balanced pair.
 *  3. **A DRAG CAN END WITHOUT A DROP** — released over nothing, or cancelled. No `dragleave` is
 *     guaranteed then, so a counter alone can strand a zone lit for the rest of the session, pointing at
 *     a destination nobody is aiming at. `end` is the reset that closes it.
 */
test.describe("gate1 drop highlighting", () => {
  const OVER = "[data-drop-over='true']";

  /** The centre of an element, for a mouse-driven drag that has to be observed mid-flight. */
  async function centre(l: Locator): Promise<{ x: number; y: number }> {
    const box = await l.boundingBox();
    if (!box) throw new Error("no bounding box — the element is not laid out");
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }

  /** Press on `from` and hold the pointer over `to`, WITHOUT releasing — the state item D is about. */
  async function dragOver(
    page: Page,
    from: Locator,
    to: Locator,
  ): Promise<void> {
    const a = await centre(from);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    const b = await centre(to);
    await page.mouse.move(b.x, b.y, { steps: 12 });
    await page.mouse.move(b.x, b.y);
  }

  test("@gate1 crossing a child does not extinguish the highlight — enter and leave are a balanced pair", () => {
    // The defect a boolean has: `dragleave` fires on the parent as the pointer moves onto a child, so a
    // zone containing so much as a label would flicker off under the cursor aiming at it.
    let d = 0;
    d = nextDepth(d, "enter"); // onto the zone
    expect(isOver(d)).toBe(true);
    d = nextDepth(d, "enter"); // onto a child of it
    d = nextDepth(d, "leave"); // ...and the parent's matching leave
    expect(isOver(d)).toBe(true);
    d = nextDepth(d, "leave"); // off the zone for real
    expect(isOver(d)).toBe(false);
  });

  test("@gate1 the depth never goes negative, so a stray leave cannot bank a debt", () => {
    // A `dragleave` with no matching `dragenter` is ordinary (the drag began inside the zone). If it
    // banked -1, the NEXT genuine enter would land on 0 and the zone would refuse to light at all.
    let d = nextDepth(0, "leave");
    expect(d).toBe(0);
    d = nextDepth(d, "enter");
    expect(isOver(d)).toBe(true);
  });

  test("@gate1 a drop clears the highlight outright, however deep the pointer was", () => {
    const deep = ["enter", "enter", "enter"].reduce<number>(
      (d, c) => nextDepth(d, c as "enter"),
      0,
    );
    expect(isOver(deep)).toBe(true);
    expect(isOver(nextDepth(deep, "drop"))).toBe(false);
  });

  test("@gate1 a drag that ends WITHOUT a drop clears it too — the stuck-highlight guard", () => {
    // Released over nothing, or cancelled: no `dragleave` is guaranteed, so without this reset a zone
    // stays lit for the rest of the session, pointing at a destination nobody is aiming at.
    const deep = nextDepth(nextDepth(0, "enter"), "enter");
    expect(isOver(nextDepth(deep, "end"))).toBe(false);
  });

  test("@gate1 the no-group area lights up while a variable is held over it", async ({
    page,
  }) => {
    await openGate1(page);
    const row = await expandRow(page, BIG);
    const door = row.locator(
      "[data-testid='member-drop-zone'][data-group-id='__unassigned__']",
    );
    await dragOver(
      page,
      row.locator("[data-testid='member-row']").first(),
      door,
    );
    // Bhargav named this one explicitly: "including no group area".
    await expect(door).toHaveAttribute("data-drop-over", "true");
    await page.mouse.up();
  });

  test("@gate1 exactly ONE target is lit, and it is the innermost one under the cursor", async ({
    page,
  }) => {
    await openGate1(page);
    const row = await expandRow(page, BIG);
    const door = row.locator(
      "[data-testid='member-drop-zone'][data-group-id='__unassigned__']",
    );
    await dragOver(
      page,
      row.locator("[data-testid='member-row']").first(),
      door,
    );

    await expect(door).toHaveAttribute("data-drop-over", "true");
    // The ROW encloses the door. Two lit targets is the ambiguity this feature exists to remove, so the
    // enclosing row must go dark while the thing inside it is the destination.
    await expect(row).not.toHaveAttribute("data-drop-over", "true");
    await expect(page.locator(OVER)).toHaveCount(1);
    await page.mouse.up();
  });

  test("@gate1 another group's row lights up while a variable is held over it", async ({
    page,
  }) => {
    await openGate1(page);
    const row = await expandRow(page, BIG);
    // The destinations are the sidebar rows now (08-16f): a different group's row lights on drag-over.
    const target = page
      .locator(`[data-testid='ledger-row']:not([data-row-id='${BIG}'])`)
      .first();
    await dragOver(
      page,
      row.locator("[data-testid='member-row']").first(),
      target,
    );
    await expect(target).toHaveAttribute("data-drop-over", "true");
    await page.mouse.up();
  });

  test("@gate1 the highlight does not interfere with the drop — the move still lands", async ({
    page,
  }) => {
    await openGate1(page);
    const row = await expandRow(page, BIG);
    const member = row.locator("[data-testid='member-row']").first();
    const memberId = await member.getAttribute("data-member-id");
    const door = row.locator(
      "[data-testid='member-drop-zone'][data-group-id='__unassigned__']",
    );
    await dragOver(page, member, door);
    await page.mouse.up();

    // The cue is decoration; the verb is not. A highlight that swallowed the drop would be a regression
    // dressed as an affordance.
    await expect(
      page.locator("[data-testid='gate1-pool-entry']"),
    ).toContainText("1");
    await expandPool(page);
    await expect(page.locator(pooled(memberId!)).first()).toBeVisible();
    // …and nothing is left lit once the pointer has gone.
    await expect(page.locator(OVER)).toHaveCount(0);
  });

  test("@gate1 a drag abandoned over a target leaves no stuck highlight", async ({
    page,
  }) => {
    await openGate1(page);
    const row = await expandRow(page, BIG);
    const door = row.locator(
      "[data-testid='member-drop-zone'][data-group-id='__unassigned__']",
    );

    /**
     * DISPATCHED, NOT MOUSE-DRIVEN, and that is the point of this one. The state under test is a drag
     * that ends with NO `dragleave` and NO `drop` — released over nothing, or cancelled — which a mouse
     * script cannot reliably produce. Dispatching the two events directly reproduces it exactly.
     *
     * It also asserts the constraint the browser imposes: these events carry NO `dataTransfer` here, so a
     * target that lit up by INSPECTING the payload would never light at all. Geometry only.
     */
    await door.evaluate((el) =>
      el.dispatchEvent(new DragEvent("dragenter", { bubbles: true })),
    );
    await expect(door).toHaveAttribute("data-drop-over", "true");
    await door.evaluate(() =>
      window.dispatchEvent(new DragEvent("dragend", { bubbles: true })),
    );
    await expect(page.locator(OVER)).toHaveCount(0);
  });
});

/**
 * THE POOL BEHAVES LIKE ANY OTHER GROUP (08-16c review, item A).
 *
 * Bhargav, annotating the live Gate 1 pool: *"this should operate the same way as any other group -
 * dropdown with full rows and sidebar with groups to be dragged to."*
 *
 * THIS IS A FIX, NOT A PREFERENCE, and the defect it closes was MEASURED in the previous session. A native
 * HTML5 drag CANNOT BEGIN FROM AN OFF-VIEWPORT SOURCE: with a group expanded, the flat chip list sat below
 * the whole ledger, zero drag events fired and `elementFromPoint` at a chip's centre returned `null`. The
 * only way to drag a variable back out was to narrow the ledger first until the pool happened to come into
 * view — which is why the previous session shipped a keyboard put-back as a MITIGATION rather than as the
 * feature it now is.
 *
 * GIVING THE POOL A GROUP'S OWN SHAPE DISSOLVES THAT. Expanded, it has its own destination tray sitting
 * beside its own rows, so dragging out is an ordinary between-groups drag over a few hundred pixels
 * instead of a scroll-length one. THE KEYBOARD PATH STAYS REGARDLESS — this screen holds that a drag with
 * no keyboard equivalent is a regression, and that does not stop being true because the drag got easier.
 *
 * THE TWO ORIGINS STAY LABELLED AND NEVER MERGED. "You took this out" is the reviewer's own decision;
 * "the clustering never placed this" is a property of the run. That distinction is why the flat-list
 * option was rejected in the first place, and expanding the pool does not licence collapsing it.
 */
test.describe("gate1 pool as a group", () => {
  const POOL = "[data-testid='unassigned-pool']";
  const LEFTOVERS = [
    {
      cohort: "ukbb",
      variable: "zz_never_clustered_a",
      text: "A variable the clustering never placed",
    },
    {
      cohort: "aou",
      variable: "zz_never_clustered_b",
      text: "Another one the clustering never placed",
    },
  ];

  /** Take one variable out of `BIG` — the only way to get anything into the reviewer's half of the pool. */
  async function removeOne(page: Page): Promise<string> {
    const row = await expandRow(page, BIG);
    const member = row.locator("[data-testid='member-row']").first();
    const memberId = (await member.getAttribute("data-member-id"))!;
    await member.dragTo(
      row.locator(
        "[data-testid='member-drop-zone'][data-group-id='__unassigned__']",
      ),
    );
    // The move wrote a persisted decision; the BIG sidebar row reflects it (the detail pane is `row`).
    await expect(
      page.locator(`[data-testid='ledger-row'][data-row-id='${BIG}']`),
    ).toHaveAttribute("data-spine", "changed");
    return memberId;
  }

  test("@gate1 the pool opens and closes like a row, and states its counts either way", async ({
    page,
  }) => {
    await serveRun(page, (run) => {
      run.result!.unassignedFields = LEFTOVERS;
    });
    await openGate1(page);

    // The pool opens into the detail pane and its body is open there; its own toggle collapses the body
    // while the count stays put (the count is what a reviewer meets on the way to Continue).
    await expandPool(page);
    await expect(page.locator("[data-testid='pool-count']")).toHaveText("2");
    await expect(
      page.locator(`${POOL} [data-testid='pool-body']`),
    ).toBeVisible();
    await page
      .getByRole("button", { name: /^Collapse the variables in no group/i })
      .click();
    await expect(page.locator(`${POOL} [data-testid='pool-body']`)).toHaveCount(
      0,
    );
    await expect(page.locator("[data-testid='pool-count']")).toHaveText("2");
    await page
      .getByRole("button", { name: /^Expand the variables in no group/i })
      .click();
    await expect(
      page.locator(`${POOL} [data-testid='pool-body']`),
    ).toBeVisible();
  });

  /**
   * THE DEFECT, CLOSED. This drag is performed with the ledger at its FULL width and its full row count —
   * no filter, no narrowing, nothing collapsed to bring a destination within reach. That was impossible
   * before: the destinations were the ledger rows, which were a scroll-length away from the pool, and the
   * browser refused to start the drag at all.
   */
  test("@gate1 a variable drags out of the pool into a group without narrowing the ledger first", async ({
    page,
  }) => {
    await openGate1(page);
    const memberId = await removeOne(page);
    await expandPool(page);

    // The destinations are the sidebar rows now (08-16f); they stay on screen beside the pool detail.
    const target = page.locator("[data-testid='ledger-row']").first();
    const targetId = await target.getAttribute("data-row-id");
    expect(targetId).not.toBe(BIG); // a DIFFERENT group — "any group", not merely an undo

    await page
      .locator(`${POOL} [data-member-id='${memberId}']`)
      .first()
      .dragTo(target);

    await expect(
      page.locator(`${POOL} [data-member-id='${memberId}']`),
    ).toHaveCount(0);
    const receiving = await expandRow(page, targetId!);
    await expect(
      receiving.locator(`[data-member-id='${memberId}']`).first(),
    ).toBeVisible();
  });

  test("@gate1 the expanded pool shows the FULL rows, not a name on a chip", async ({
    page,
  }) => {
    await openGate1(page);
    const memberId = await removeOne(page);
    await expandPool(page);
    // The same evidence grid every group's expanded row renders — "should this have been grouped?" is
    // answered from the dictionary row, not from a variable name.
    const gridRow = page.locator(
      `${POOL} [data-testid='source-rows'] [data-testid='member-row']`,
    );
    await expect(gridRow).toHaveAttribute("data-member-id", memberId);
    // A DICTIONARY ROW, not a relabelled chip: the columns the coherence judgement is actually made
    // against are present, which is the whole reason the grid is the survivor of the tile strip.
    await expect(
      page.locator(`${POOL} [data-testid='source-rows'] thead`),
    ).toContainText(/cohort/i);
    await expect(
      page.locator(`${POOL} [data-testid='source-rows'] thead`),
    ).toContainText(/variable/i);
  });

  test("@gate1 expanding does not merge the two origins — each is still labelled and counted", async ({
    page,
  }) => {
    await serveRun(page, (run) => {
      run.result!.unassignedFields = LEFTOVERS;
    });
    await openGate1(page);
    await removeOne(page);
    await expandPool(page);

    const mine = page.locator(`${POOL} [data-testid='pool-reviewer']`);
    const theirs = page.locator(`${POOL} [data-testid='pool-pipeline']`);
    await expect(mine).toContainText(/you took/i);
    await expect(theirs).toContainText(/clustering/i);
    // Two sections, never one list: the pipeline's leftovers must not be reported as the reviewer's doing.
    await expect(mine.locator(`[data-member-id]`).first()).toBeVisible();
    await expect(theirs.locator(`[data-member-id]`)).toHaveCount(2);
  });

  test("@gate1 a clustering leftover still gets no put-back, because it was never in a group", async ({
    page,
  }) => {
    await serveRun(page, (run) => {
      run.result!.unassignedFields = LEFTOVERS;
    });
    await openGate1(page);
    await expandPool(page);
    await expect(
      page.locator(
        `${POOL} [data-testid='pool-pipeline'] [data-testid='pool-put-back']`,
      ),
    ).toHaveCount(0);
  });

  test("@gate1 the keyboard put-back survives the pool becoming a group", async ({
    page,
  }) => {
    await openGate1(page);
    const memberId = await removeOne(page);
    await expandPool(page);

    const back = page.locator(
      `${POOL} [data-testid='pool-put-back'][data-member-id='${memberId}']`,
    );
    await back.focus();
    await expect(back).toBeFocused();
    await expect(back).toHaveAttribute(
      "aria-label",
      /put .+ back in the group/i,
    );
    await page.keyboard.press("Enter");
    await expect(
      page.locator(`${POOL} [data-member-id='${memberId}']`),
    ).toHaveCount(0);
  });

  test("@gate1 a passed gate can read the pool but not move anything out of it", async ({
    page,
  }) => {
    await serveRun(page, (run) => {
      run.gatePosition = "gate2";
      run.result!.gatePosition = "gate2";
      run.result!.unassignedFields = LEFTOVERS;
    });
    await openGate1(page);
    await expandPool(page);
    // Readable — that is what looking back is for.
    await expect(
      page.locator(`${POOL} [data-testid='pool-body']`),
    ).toBeVisible();
    // But nothing offers to change a decision the pipeline has already consumed.
    await expect(
      page.locator(`${POOL} [data-testid='destination-tray']`),
    ).toHaveCount(0);
    await expect(
      page.locator(`${POOL} [data-testid='pool-put-back']`),
    ).toHaveCount(0);
  });
});

/**
 * THE PARTITION MOVES ONTO THE COLUMN HEADER (08-16c review, item B).
 *
 * Bhargav, on the "Across cohorts 28 / Within one cohort 26" strip: *"all this should be part of the
 * column header sort/filter functionality."* Consistent with his earlier call to delete the ORDER select:
 * he is consolidating the ledger's controls onto the headers it already sorts by.
 *
 * WHAT MOVED IS THE CONTROL. WHAT DID NOT MOVE IS THE PARTITION, and the distinction is the whole of this
 * change. `lib/ledger.ts::partitionByBreadth` records a MEASUREMENT: on the full-5 artifact the judge
 * flags 351 of 1901 groups and 237 of those are single-cohort, so flag-first ordering ALONE spends 68% of
 * the reviewer's first attention on rows that are not harmonization at all. The judge is well aimed — it
 * fires on 45% of cross-cohort groups against 14% of single-cohort ones — which makes its verdict a good
 * SIGNAL and a bad PARTITION. So the ledger still partitions on the structural fact FIRST and orders
 * flag-first inside it, and cross-cohort still leads by default. Folding that into `LedgerFilters` would
 * have made it one more thing a reviewer can clear to nothing, and would have collapsed the two empty
 * states below into one.
 *
 * AND THE OTHER HALF IS STILL NEVER HIDDEN. It is 87% of the corpus on a real run and it holds real work.
 * A control that disappeared into a menu would leave the reviewer looking at 28 rows of 54 with nothing on
 * screen saying so — which is the coverage lie the tab strip existed to prevent, arrived at by a different
 * route. Both counts stay visible without opening anything, and the other half is one click away.
 */
test.describe("gate1 cross-cohort toggle", () => {
  test("@gate1 the bucket tab strip is gone; a single cross-cohort-only toggle stands in the toolbar", async ({
    page,
  }) => {
    await openGate1(page);
    await expect(page.locator("[data-testid='bucket-tab']")).toHaveCount(0);
    await expect(page.locator("[data-testid='breadth-filter']")).toHaveCount(0);
    await expect(
      page.locator(
        "[data-testid='ledger-toolbar'] [data-testid='cross-cohort-toggle']",
      ),
    ).toBeVisible();
  });

  test("@gate1 the default is every group; the toggle narrows to exactly the cross-cohort set", async ({
    page,
  }) => {
    await openGate1(page);
    const { "cross-cohort": cross } = partitionByBreadth(fixtureGroups());
    await expect(page.locator("[data-testid='ledger-row']")).toHaveCount(
      fixtureGroups().length,
    );
    await page.locator("[data-testid='cross-cohort-toggle']").click();
    await expect(page.locator("[data-testid='ledger-row']")).toHaveCount(
      cross.length,
    );
  });

  test("@gate1 the toggle is reachable and operable from the keyboard", async ({
    page,
  }) => {
    await openGate1(page);
    const toggle = page.locator("[data-testid='cross-cohort-toggle']");
    await toggle.focus();
    await expect(toggle).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
  });

  test("@gate1 the partition happens BEFORE the sort — sorting cannot widen the narrowed set", async ({
    page,
  }) => {
    await openGate1(page);
    const { "cross-cohort": cross } = partitionByBreadth(fixtureGroups());
    await page.locator("[data-testid='cross-cohort-toggle']").click();
    await page.locator("[data-testid='sort-vars']").click();
    await expect(page.locator("[data-testid='ledger-row']")).toHaveCount(
      cross.length,
    );
    await page.locator("[data-testid='sort-cohorts']").click();
    await expect(page.locator("[data-testid='ledger-row']")).toHaveCount(
      cross.length,
    );
  });

  test("@gate1 cross-cohort-only on an all-single-cohort run says so rather than reading as 'no rows at all'", async ({
    page,
  }) => {
    const singles = fixtureGroups().filter((g) => !g.crossCohort);
    expect(singles.length).toBeGreaterThan(0);
    await serveRun(page, (run) => {
      run.result!.conceptGroups = singles;
    });
    await openGate1(page);
    await expect(page.locator("[data-testid='ledger-row']")).toHaveCount(
      singles.length,
    );
    await page.locator("[data-testid='cross-cohort-toggle']").click();
    // A NAMED empty state, not a blank body: it says there are no cross-cohort groups and offers all back.
    await expect(page.locator("[data-testid='gate1-rows']")).toContainText(
      /no cross-cohort groups/i,
    );
    await page.getByRole("button", { name: /show all/i }).click();
    await expect(page.locator("[data-testid='ledger-row']")).toHaveCount(
      singles.length,
    );
  });
});

/**
 * THE CONCEPT SEARCH MOVES INTO THE TOOLBAR (08-16c review, item C).
 *
 * Bhargav, on Gate 1's search: *"build this into the tray area like current prod UI."* Prod's Review
 * queue (`dashboard.tsx`) puts its search in the card header beside the other narrowing controls, as a
 * compact single-line input; Gate 1's was its own full-width card with a heading of its own.
 *
 * THE PLACEMENT IS ADOPTED. THE TWO BEHAVIOURS THAT MAKE IT DIFFERENT ARE NOT GIVEN UP, because they are
 * the reason it exists rather than being a second copy of prod's box:
 *
 *  1. **IT TAKES A LIST.** A reviewer scoping a run has one — the components of a score, the variables a
 *     paper used, the twelve things this analysis needs. A one-term box makes them run twelve searches and
 *     remember twelve answers. So the control is compact at rest and GROWS to whatever is pasted into it.
 *  2. **A TERM THAT MATCHES NOTHING IS A COVERAGE FINDING, NOT AN EMPTY STATE.** "No results" tells the
 *     reviewer their search failed; "nothing in this run measures smoking" tells them something true about
 *     their corpus, which is what they came to find out.
 *
 * And it still never claims to be semantic — no group vector reaches the browser, so the match is lexical
 * and the copy says which text it is over. That claim was removed once already (08-15) and compactness is
 * not a reason to let it back in.
 */
test.describe("gate1 search in the toolbar", () => {
  const SEARCH = "[data-testid='term-search']";

  test("@gate1 the search lives in the toolbar, not in a section of its own", async ({
    page,
  }) => {
    await openGate1(page);
    const inToolbar = page.locator(`[data-testid='ledger-toolbar'] ${SEARCH}`);
    await expect(inToolbar).toBeVisible();
    // Exactly one, and it is the one in the toolbar — not a second copy left behind below it.
    await expect(page.locator(SEARCH)).toHaveCount(1);
  });

  test("@gate1 it is compact at rest — prod's single-line register, not a block", async ({
    page,
  }) => {
    await openGate1(page);
    const box = await page.locator("[data-testid='term-search']").boundingBox();
    // Prod's is `h-8`. The old Gate 1 control was a three-row textarea inside its own headed card, which
    // is what "build this into the tray area" was about.
    expect(box!.height).toBeLessThan(44);
  });

  test("@gate1 the compact input makes no semantic claim", async ({ page }) => {
    await openGate1(page);
    // Compactness must not be a reason to let the semantic claim back in: the input is a plain text
    // filter, and its placeholder says so without claiming the tool understood the term.
    const ph = await page.locator(SEARCH).getAttribute("placeholder");
    expect(ph).not.toMatch(/semantic|understands|meaning of your term/i);
    expect(ph).toMatch(/search|concept|variable|cohort/i);
  });
});

/**
 * THE DECLARED-SCORE PANEL MOVES TO THE TOP, AS A DISCLOSURE (08-16c review, item E).
 *
 * Bhargav: *"I just dont like the way this is built… the placement is weird — it's below everything"*,
 * settled as *"move score panel near top as a dropdown for now."* PLACEMENT ONLY — "for now" is his word,
 * and the panel's internals are not redesigned here.
 *
 * WHAT THE COLLAPSE MUST NOT DO. The FREE/PAID SPLIT IS THE SHAPE OF THIS PANEL: reading the document is
 * $0 and job-independent, while matching the components onto the run's concepts is ONE MODEL CALL AND
 * COSTS MONEY. On a screen whose entire job is deciding what to spend, the reviewer must not meet that
 * charge LATER than they do today. So the charge is named ON THE TRIGGER — visible without opening
 * anything, at the top of the screen — which is strictly EARLIER than the old placement, where it was
 * 3035px down the page. The priced copy itself stays exactly where it was, immediately above the button.
 *
 * IT STAYS ON GATE 1. Setup was ruled out by the 08-25 amendment (with no run there are no concepts, so
 * the verdict was hard-coded `indeterminate`), and Gate 2 would add nothing — the panel matches components
 * onto this run's CONCEPTS, not onto CDEs, so Gate 2's new information is information it never reads.
 */
test.describe("gate1 score panel placement", () => {
  const PANEL = "[data-testid='score-panel']";
  const TRIGGER = "[data-testid='score-panel-toggle']";

  test("@gate1 the panel is above the ledger, not below everything", async ({
    page,
  }) => {
    await openGate1(page);
    const trigger = await page.locator(TRIGGER).boundingBox();
    const ledger = await page.locator("[data-testid='ledger']").boundingBox();
    expect(trigger!.y).toBeLessThan(ledger!.y);
  });

  test("@gate1 it is collapsed by default, and opens on demand", async ({
    page,
  }) => {
    await openGate1(page);
    await expect(page.locator(PANEL)).toHaveCount(0);
    await page.locator(TRIGGER).click();
    await expect(page.locator(PANEL)).toBeVisible();
    // The declare control — the panel's own verb — is there, unchanged.
    await expect(
      page.locator("[data-testid='score-components']"),
    ).toBeVisible();
  });

  test("@gate1 the charge is named on the trigger, so collapsing does not bury it", async ({
    page,
  }) => {
    await openGate1(page);
    // WITHOUT OPENING ANYTHING. This is the constraint the collapse had to satisfy: a reviewer must not
    // meet the paid action later than they did when the panel was expanded at the foot of the page.
    const trigger = page.locator(TRIGGER);
    await expect(trigger).toContainText(/costs?/i);
    await expect(trigger).toContainText(/free|costs nothing|no charge/i);
  });

  test("@gate1 opening it still shows the free half and the priced half, in that order", async ({
    page,
  }) => {
    await openGate1(page);
    await page.locator(TRIGGER).click();
    // Reading the document is $0 and job-independent, and the copy says so.
    await expect(page.locator("[data-testid='score-upload']")).toContainText(
      /costs nothing/i,
    );
    // Matching is one model call, priced inline and never behind a modal — still immediately above the
    // paid control it prices.
    const price = page.locator("[data-testid='score-match-price']");
    await expect(price).toContainText(/costs money/i);

    /**
     * ON THIS RUN THE PAID CONTROL IS AN HONEST NOT-AVAILABLE, and that is the assertion rather than a
     * concession. A run PARKED AT GATE 1 has no assigned records — `match_components` runs over the
     * concepts the assign stage produces at Gate 2, and the backend's own derive route refuses a run
     * without them. So the panel names the reason instead of offering a button that would 409, which is
     * the rule it was built to keep. Moving the panel up must not turn that into a dead control.
     */
    const paid = page.locator(
      "[data-testid='score-panel'] [data-testid='not-available']",
    );
    await expect(paid).toContainText(/Gate 2/i);
    const priceBox = await price.boundingBox();
    const paidBox = await paid.boundingBox();
    expect(priceBox!.y).toBeLessThan(paidBox!.y);
  });

  test("@gate1 it does not compete with the ledger — it is one strip, like the how-to", async ({
    page,
  }) => {
    await openGate1(page);
    const howto = await page.locator("[data-testid='how-to']").boundingBox();
    const strip = await page
      .locator("[data-testid='score-strip']")
      .boundingBox();
    // CONTAINER AGAINST CONTAINER. The same register and the same height as the other collapsed strip on
    // this screen: a fourth CARD at the top would be exactly the "competing with the ledger" failure,
    // and every pixel here is spent out of the ledger's own budget on a screen whose first row already
    // starts below the fold.
    expect(Math.abs(strip!.height - howto!.height)).toBeLessThanOrEqual(2);
  });
});
