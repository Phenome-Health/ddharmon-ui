import { expect, test, type Page } from "@playwright/test";
import { conceptTitle, groupLabel } from "@/lib/ledger";
import type { UIRecord } from "@/types";
import { FINISHED_JOB, finishedRecords, serveFinished } from "./gate23-fixture";

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
});
