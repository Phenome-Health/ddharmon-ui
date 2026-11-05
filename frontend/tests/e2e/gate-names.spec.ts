import { expect, test, type Page } from "@playwright/test";
import { conceptTitle, groupLabel, namedGroupsById, reviewerGroupRows } from "@/lib/ledger";
import { optionSetKey } from "@/lib/gate-decisions";
import { SANDBOX_PREFIX } from "@/lib/sandbox";
import type { ComponentCoding, CompositeSpec, ConceptGroup, UIRecord } from "@/types";
import { FINISHED_JOB, finishedRecords, serveFinished } from "./gate23-fixture";
import { PAUSED_JOB, fixtureGroups, serveRun } from "./gate1-fixture";

/**
 * A concept keeps the name it had at Gate 1 (phase-8 final review, round 1).
 *
 * Bhargav: *"I would rather the group names in Gate 1 carry over to gate 2 rather than the CDE name replacing the
 * group name."* Gate 2 titled each concept `gencde.preferredName || concept`, so a refine concept read as its
 * matched catalog element's question text and a novel one as its generated element's snake_case id (H6) — and,
 * since the title followed the target, a re-pick never brought the group's name back (H7). The target is still
 * on screen, as the detail's "target: …"; the TITLE is the group's.
 *
 *   run: npm run test:e2e -- --grep "@names"
 */

const NOVEL = "c20f12f09afa6#g0"; // generated element: transportation_via_company_involvement_ind
const REFINE = "c0a367d9fb0eb#g0"; // generated element named for a catalog question

function rec(over: Partial<UIRecord>): UIRecord {
  return {
    groupId: "c1#g0",
    concept: "Lifetime cigarette smoking status",
    idealCde: "Tobacco use history",
    coherence: "coherent",
    coherenceSummary: "",
    gencde: { gencdeId: "ever_smoked_100", preferredName: "ever_smoked_100" },
    ...over,
  } as UIRecord;
}

// --- the rule, in Node ---------------------------------------------------------------------------------------

test.describe("concept titles after Gate 1", () => {
  test("@names a concept is titled by its Gate 1 group name, never by its target's name", () => {
    expect(conceptTitle(rec({}), undefined)).toBe("Lifetime cigarette smoking status");
    // A catalog-question-shaped generated name (a refine target) does not replace it either.
    expect(
      conceptTitle(rec({ gencde: { preferredName: "Have you ever smoked 100 cigarettes?" } as UIRecord["gencde"] }), undefined),
    ).toBe("Lifetime cigarette smoking status");
  });

  test("@names the reviewer's Gate 1 rename wins, and an empty rename is no rename", () => {
    expect(conceptTitle(rec({}), { chosen: "Ever smoked 100" })).toBe("Ever smoked 100");
    expect(conceptTitle(rec({}), { chosen: "   " })).toBe("Lifetime cigarette smoking status");
  });

  test("@names a reviewer's New group is titled by the name they gave it", () => {
    // Core stamps a New group's record with the reviewer's name as its concept (ReviewerGroup.name).
    expect(conceptTitle(rec({ groupId: "rev:1", concept: "Eye conditions", gencde: null }), undefined)).toBe(
      "Eye conditions",
    );
  });

  test("@names an unnamed group falls back exactly as Gate 1 does — the same rule, not a second copy", () => {
    for (const r of [
      rec({ concept: "" }),
      rec({ concept: "", idealCde: "", coherence: "coherent", coherenceSummary: "Smoking items" }),
      rec({ concept: "", idealCde: "", coherence: "not_judged", coherenceSummary: "" }),
    ]) {
      const asGroup = groupLabel({
        concept: r.concept,
        idealCde: r.idealCde,
        coherence: r.coherence!,
        coherenceSummary: r.coherenceSummary!,
      });
      expect(conceptTitle(r, undefined)).toBe(asGroup.text);
      // ...and never the generated element's snake_case id.
      expect(conceptTitle(r, undefined)).not.toBe("ever_smoked_100");
    }
  });
});

// --- Gate 2, in the browser ----------------------------------------------------------------------------------

async function openGate2With(page: Page, groupIds: string[]): Promise<void> {
  await serveFinished(
    page,
    (run) => {
      run.result!.records = run.result!.records!.filter((r) => groupIds.includes(r.groupId));
    },
    { keep: 0 },
  );
  await page.goto(`/run/${FINISHED_JOB}/gate2`);
  await page.waitForLoadState("networkidle");
}

function conceptOf(groupId: string): string {
  return finishedRecords().find((r) => r.groupId === groupId)!.concept;
}

test.describe("Gate 2 titles", () => {
  test("@names @gate2 the list and the detail header carry the Gate 1 group name; the target stays visible", async ({
    page,
  }) => {
    await openGate2With(page, [NOVEL, REFINE]);
    for (const gid of [NOVEL, REFINE]) {
      const row = page.locator(`[data-testid='gate2-concept'][data-concept-id='${gid}']`);
      await expect(row).toContainText(conceptOf(gid));
      await row.click();
      await expect(page.getByTestId("concept-title")).toHaveText(conceptOf(gid));
      // The target is not lost — it is shown AS the target.
      await expect(page.getByTestId("current-target")).toContainText("target:");
    }
    // H6: the novel concept is not titled by its generated element's snake_case id.
    await expect(page.locator(`[data-testid='gate2-concept'][data-concept-id='${NOVEL}']`)).not.toContainText(
      "transportation_via_company_involvement_ind",
    );
    // The refine concept is not titled by the catalog-question-shaped name.
    await expect(page.locator(`[data-testid='gate2-concept'][data-concept-id='${REFINE}']`)).not.toContainText(
      "Have you ever used any of these drugs",
    );
  });

  test("@names @gate2 a re-pick changes the target, not the title (H7)", async ({ page }) => {
    await openGate2With(page, [NOVEL]);
    const row = page.locator(`[data-testid='gate2-concept'][data-concept-id='${NOVEL}']`);
    await row.click();
    // Pick the second-ranked catalog element in place of the generated target.
    const second = page.locator("[data-testid='candidate-row']").nth(1);
    await second.locator("[data-testid='candidate-expand']").click();
    await second.locator("[data-testid='candidate-select']").click();
    await expect(page.getByTestId("current-target")).not.toContainText("your own CDE");
    await expect(row).toContainText(conceptOf(NOVEL));
    await expect(row).not.toContainText("transportation_via_company_involvement_ind");
    await expect(page.getByTestId("concept-title")).toHaveText(conceptOf(NOVEL));
  });

  test("@names @gate3 Gate 3 lists the same Gate 1 group name", async ({ page }) => {
    await serveFinished(
      page,
      (run) => {
        run.result!.records = run.result!.records!.filter((r) => r.groupId === NOVEL);
      },
      { keep: 0 },
    );
    await page.goto(`/run/${FINISHED_JOB}/gate3`);
    await page.waitForLoadState("networkidle");
    const row = page.locator(`[data-testid='gate3-concept'][data-concept-id='${NOVEL}']`);
    await expect(row).toContainText(conceptOf(NOVEL));
    await expect(row).not.toContainText("transportation_via_company_involvement_ind");
  });
});

// --- the score builder on Gate 1 -----------------------------------------------------------------------------

/**
 * The score builder names groups the way Gate 1 does (phase-8 final review, round 1).
 *
 * The declared-score panel resolved a matched group through a map of the PIPELINE's groups only, labelled without
 * the reviewer's rename. So a group the reviewer renamed read under its generated name, and a group the reviewer
 * MADE — a New group, or a part of an accepted division (both `rev:` ids, both renamed through their own decision)
 * — was not in the map at all and read "Unnamed group".
 */
test.describe("score builder group names", () => {
  const RENAMED = "cb2a6e2cd6fd3#g0";
  const PLAIN = "c8331409f61e1#g0";
  const MADE = "rev:00000000-0000-4000-8000-0000000000e1";

  function group(id: string): ConceptGroup {
    return fixtureGroups().find((g) => g.groupId === id)!;
  }

  test("@names a renamed group carries the reviewer's name, with the generated one kept beside it", () => {
    const g = group(RENAMED);
    const byId = namedGroupsById([g, group(PLAIN)], [], (id) => (id === RENAMED ? "My grip items" : undefined));
    expect(byId.get(RENAMED)).toMatchObject({ name: "My grip items", generatedName: g.concept });
    // An untouched group reads its generated name, with nothing beside it.
    expect(byId.get(PLAIN)).toMatchObject({ name: group(PLAIN).concept });
    expect(byId.get(PLAIN)!.generatedName).toBeUndefined();
  });

  test("@names a group the reviewer made is in the map, under the name they gave it", () => {
    const made = reviewerGroupRows(
      { [MADE]: { groupId: MADE, chosen: "Eye conditions", name: "Eye conditions", createdAt: 1 } },
      () => [],
    );
    const byId = namedGroupsById([group(PLAIN)], made, () => undefined);
    expect(byId.get(MADE)).toMatchObject({ name: "Eye conditions" });
    // It never had a generated name, so none is claimed for it.
    expect(byId.get(MADE)!.generatedName).toBeUndefined();
  });

  function spec(candidates: { groupId: string; confidence: number }[]): CompositeSpec {
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
        statedNItems: 1,
        underEnumerated: 0,
        provenance: "pasted text",
        sourceSha256: "",
        components: [{ name: "Grip strength", definition: "", required: true, weight: null, coding }],
      },
      matches: [
        {
          component: "Grip strength",
          conceptId: candidates[0].groupId,
          concept: "",
          column: "grip",
          cohorts: [],
          sourceVariables: [],
          confidence: candidates[0].confidence,
          rationale: "measures grip strength",
          required: true,
          pinned: false,
          shortlist: candidates.map((c) => c.groupId),
          matchedMembers: [],
          groupCandidates: candidates.map((c) => ({ ...c, nMatched: 1, nTotal: 1 })),
        },
      ],
      feasibility: {
        verdict: "partial",
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
    } as CompositeSpec;
  }

  test("@names @gate1 the score builder shows a renamed group by its new name and a New group by its own", async ({
    page,
  }) => {
    const member = group(PLAIN).memberVariableNames[0];
    await serveRun(page, (run) => {
      run.composites = [
        spec([
          { groupId: MADE, confidence: 0.9 },
          { groupId: RENAMED, confidence: 0.85 },
        ]),
      ];
    });
    await page.goto(`/run/${PAUSED_JOB}/gate1`);
    await page.waitForLoadState("networkidle");
    // Seeded exactly as Gate 1 writes them: a rename, a New group, and a move that fills it.
    const alts = [PLAIN, "__unassigned__", MADE];
    const gateDecisions = {
      gate1_rename: {
        [RENAMED]: {
          groupId: RENAMED,
          chosen: "My grip items",
          alternatives: [group(RENAMED).concept, "My grip items"],
          optionSetKey: optionSetKey([group(RENAMED).concept, "My grip items"]),
          generatedName: group(RENAMED).concept,
        },
      },
      gate1_new_group: {
        [MADE]: {
          groupId: MADE,
          chosen: "Eye conditions",
          alternatives: ["Eye conditions"],
          optionSetKey: optionSetKey(["Eye conditions"]),
          name: "Eye conditions",
          createdAt: 1,
        },
      },
      gate1_regroup: {
        [member]: { memberId: member, fromGroupId: PLAIN, chosen: MADE, alternatives: alts, optionSetKey: optionSetKey(alts), movedAt: 1 },
      },
    };
    await page.evaluate(
      ({ key, value }) => sessionStorage.setItem(key, value),
      { key: `${SANDBOX_PREFIX}${PAUSED_JOB}`, value: JSON.stringify({ gateDecisions }) },
    );
    await page.reload();
    await page.waitForLoadState("networkidle");

    await page.locator("[data-testid='score-panel-toggle']").click();
    const grip = page.locator("[data-testid='score-match'][data-component='Grip strength']");
    await grip.locator("[data-testid='score-component-expand']").click();
    const renamed = grip.locator(`[data-testid='score-group'][data-group='${RENAMED}']`);
    const made = grip.locator(`[data-testid='score-group'][data-group='${MADE}']`);
    await expect(renamed.locator("[data-testid='score-open-group']")).toContainText("My grip items");
    await expect(renamed.locator("[data-testid='score-group-generated']")).toHaveText(
      `ddharmon called it ${group(RENAMED).concept}`,
    );
    await expect(made.locator("[data-testid='score-open-group']")).toContainText("Eye conditions");
    await expect(made.locator("[data-testid='score-group-generated']")).toHaveCount(0);
    await expect(grip).not.toContainText("Unnamed group");
  });
});
