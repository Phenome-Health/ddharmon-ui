import { expect, test, type Page } from "@playwright/test";
import { GROUP_SELECT_THRESHOLD, scoreSeededGroups } from "@/lib/score-scope";
import type { ComponentCoding, CompositeSpec, ConceptGroup } from "@/types";
import { PAUSED_JOB, fixtureGroups, serveRun } from "./gate1-fixture";

/**
 * Gate 1's score-builder AUTO-SELECT threshold — does it actually work? (final review round 1, item 3)
 *
 * Bhargav: *"is the auto select threshold functional? It not being tuned can be an internal note, not surfaced on
 * the UI"*. The rule: a concept group the declared score's match reaches with aggregate confidence at/above
 * `GROUP_SELECT_THRESHOLD` (0.80) starts IN Gate 1 scope (and is checked in the score panel); everything else
 * starts OUT. An explicit scope decision always wins.
 *
 * Proved here on the STATIC fixture's own groups, three ways: the rule moves with the threshold (node); the
 * screen applies it to the ledger and the Continue scope (browser); and it never rewrites a FROZEN Gate 1, where
 * the scope Continue actually sent is the truth (browser).
 *
 *   run: npx playwright test tests/e2e/score-auto-select.spec.ts
 */

/** Four real fixture groups and the aggregate confidence the score's one component reached each with. */
function reached(): { group: ConceptGroup; confidence: number }[] {
  const groups = fixtureGroups();
  const at = (i: number) => groups[i]!;
  return [
    { group: at(0), confidence: 0.95 },
    { group: at(1), confidence: 0.85 },
    { group: at(2), confidence: 0.8 }, // exactly AT the threshold: selected (the rule is >=)
    { group: at(3), confidence: 0.79 },
    { group: at(4), confidence: 0.5 },
  ];
}

/** A derived spec with ONE matched component reaching the groups above — the shape `derive_composite` emits. */
function spec(): CompositeSpec {
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
  const r = reached();
  return {
    definition: {
      name: "Test frailty index",
      kind: "criteria_count",
      citation: "",
      combinationRule: "count of criteria met",
      threshold: "",
      notes: "",
      statedNItems: 1,
      underEnumerated: 0,
      provenance: "pasted text",
      sourceSha256: "",
      components: [{ name: "Grip strength", definition: "", required: true, weight: null, coding }],
    },
    matches: [
      {
        component: "Grip strength",
        conceptId: r[0].group.groupId,
        concept: r[0].group.concept,
        column: "grip",
        cohorts: r[0].group.cohorts,
        sourceVariables: [],
        confidence: r[0].confidence,
        rationale: "measures grip strength",
        required: true,
        pinned: false,
        shortlist: r.map((x) => x.group.groupId),
        groupCandidates: r.map((x) => ({ groupId: x.group.groupId, confidence: x.confidence })),
      },
    ],
    feasibility: {
      verdict: "full",
      nRequired: 1,
      nRequiredMatched: 1,
      matched: ["Grip strength"],
      missing: [],
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

const scopeOf = (page: Page, gid: string) =>
  page.locator(`[data-testid='ledger-row'][data-row-id='${gid}']`).locator("[data-testid='queue-scope']");

test.describe("score builder auto-select threshold", () => {
  test("@gate1 the rule moves with the threshold: raising it drops groups, lowering it adds them", () => {
    const matches = spec().matches;
    const ids = reached().map((x) => x.group.groupId);
    const seeded = (threshold?: number) => [...scoreSeededGroups(matches, threshold).keys()].sort();

    // The shipped threshold, by default — and AT it counts (>=).
    expect(GROUP_SELECT_THRESHOLD).toBe(0.8);
    expect(seeded()).toEqual([ids[0], ids[1], ids[2]].sort());
    expect(seeded(GROUP_SELECT_THRESHOLD)).toEqual(seeded());
    // Changing it changes the selection, in both directions.
    expect(seeded(0.9)).toEqual([ids[0]]);
    expect(seeded(0.5)).toEqual([...ids].sort());
    expect(seeded(0.79)).toEqual([ids[0], ids[1], ids[2], ids[3]].sort());
    expect(seeded(1.01)).toEqual([]);
    // Each seeded group names the component that put it there.
    expect(scoreSeededGroups(matches).get(ids[0])).toEqual(["Grip strength"]);
  });

  test("@gate1 on the static fixture, groups at/above 0.80 start IN scope and the rest OUT — and Continue sends them", async ({
    page,
  }) => {
    await serveRun(page, (run) => {
      run.composites = [spec()];
    });
    await page.goto(`/run/${PAUSED_JOB}/gate1`);
    await page.waitForLoadState("networkidle");
    await expect(page.locator("[data-testid='ledger']")).toBeVisible();

    const r = reached();
    for (const { group, confidence } of r) {
      await expect(scopeOf(page, group.groupId), `${confidence}`).toHaveAttribute(
        "aria-checked",
        String(confidence >= GROUP_SELECT_THRESHOLD),
      );
    }
    // The sum block counts exactly the auto-selected groups — the set the commit bar prices and Continue sends.
    const selected = r.filter((x) => x.confidence >= GROUP_SELECT_THRESHOLD).length;
    await expect(page.locator("[data-testid='sum-block'] [data-sum-line='in-scope']")).toContainText(
      new RegExp(`^${selected} of `),
    );
    await expect(page.locator("[data-testid='commit-bar'] button")).toBeEnabled();
  });

  test("@gate1 the score builder states the threshold, and nothing on screen calls it untuned or provisional", async ({
    page,
  }) => {
    await serveRun(page, (run) => {
      run.composites = [spec()];
    });
    await page.goto(`/run/${PAUSED_JOB}/gate1`);
    await page.waitForLoadState("networkidle");
    await page.locator("[data-testid='score-panel-toggle']").click();
    const info = page.locator("[data-testid='score-builder-info']");
    await expect(info).toBeVisible();
    await expect(info).toContainText(GROUP_SELECT_THRESHOLD.toFixed(2));
    // The tuning caveat is an INTERNAL note now (a code comment in `lib/score-scope.ts`), not reviewer copy. Scoped
    // to the score panel: the site-wide status banner's own "treat results as provisional" is a different claim.
    await expect(page.locator("[data-testid='score-panel']")).not.toContainText(
      /provisional|to be tuned|not (yet )?tuned|benchmark/i,
    );
  });

  test("@gate1 a score derived later never rewrites a FROZEN Gate 1: the scope Continue sent is what it shows", async ({
    page,
  }) => {
    const r = reached();
    const sent = r[4].group.groupId; // 0.50 — below threshold, but the reviewer had put it in scope
    await serveRun(page, (run) => {
      // Gate 1 was continued with ONE group in scope; the score was matched afterwards (at Gate 4).
      run.gatePosition = "gate2";
      run.result!.gatePosition = "gate2";
      run.config = { ...(run.config as object), gate1_scope: [sent] } as never;
      run.composites = [spec()];
    });
    await page.goto(`/run/${PAUSED_JOB}/gate1`);
    await page.waitForLoadState("networkidle");
    await expect(page.locator("[data-testid='gate-frozen']")).toBeVisible();

    await expect(scopeOf(page, sent)).toHaveAttribute("aria-checked", "true");
    for (const { group } of r.slice(0, 4)) {
      // Above the threshold in the LATER score, but not what Gate 1 sent — the record must not claim it was.
      await expect(scopeOf(page, group.groupId)).toHaveAttribute("aria-checked", "false");
    }
    await expect(page.locator("[data-testid='sum-block'] [data-sum-line='in-scope']")).toContainText(/^1 of /);
  });
});
