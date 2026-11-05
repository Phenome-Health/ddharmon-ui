import { expect, test, type Page } from "@playwright/test";
import type { JobResult, UIRecord, UITransform } from "@/types";
import { specTargetMismatch } from "@/lib/gate23";
import { FINISHED_JOB, finishedFixture, serveFinished } from "./gate23-fixture";

/**
 * 08-27b — Gate 3's transforms must be the ones built for the target the reviewer picked at Gate 2.
 *
 * The backend now regenerates a re-picked group's specs for the reviewer's target on the Gate 2 -> Gate 3
 * leg. A run that crossed that leg BEFORE the fix (live 573cf61f) still carries specs built for the model's
 * CDE, and Gate 3 must say so rather than label them with the reviewer's pick.
 *
 *   run: npx playwright test tests/e2e/gate3-pick-target.spec.ts
 */

const spec = (target: string, sourceVariable = "A:x"): UITransform =>
  ({
    sourceVariable,
    targetCdeId: target,
    kind: "categorical",
    confidence: 0.9,
    coverage: 1,
    needsUnits: false,
    needsData: false,
    needsReview: false,
    rationale: "",
    generatedBy: "llm",
  }) as UITransform;

test.describe("gate3 pick-target algebra", () => {
  test("@gate3 specs built for the picked target are consistent", () => {
    expect(specTargetMismatch([spec("CDE:2"), spec("CDE:2", "B:y")], "CDE:2")).toEqual([]);
  });

  test("@gate3 specs built for the model's CDE under a re-pick are a mismatch naming that CDE", () => {
    expect(specTargetMismatch([spec("CDE:1"), spec("CDE:1", "B:y")], "CDE:2")).toEqual(["CDE:1"]);
  });

  test("@gate3 a 'none of these' pick over existing specs is a mismatch", () => {
    expect(specTargetMismatch([spec("CDE:1")], "")).toEqual(["CDE:1"]);
  });

  test("@gate3 no specs is never a mismatch", () => {
    expect(specTargetMismatch([], "CDE:2")).toEqual([]);
  });

  test("@gate3 a refine record's derived element is an accepted second target", () => {
    expect(specTargetMismatch([spec("CDE:1"), spec("REFCDE:g", "B:y")], "CDE:1", ["REFCDE:g"])).toEqual([]);
  });
});

/** Trim the served run to one adopt concept with >= 2 candidates, and return its model CDE + an alternative. */
function oneAdopt(run: JobResult): { rec: UIRecord; model: string; other: string } {
  const recs = run.result!.records!;
  const rec = recs.find((x) => x.verdict === "adopt" && x.candidates.length >= 2 && x.transforms.length > 0)!;
  const model = rec.candidates.find((c) => c.isChosen)!.cdeId;
  const other = rec.candidates.find((c) => !c.isChosen)!.cdeId;
  run.result!.records = [rec];
  return { rec, model, other };
}

async function seedPick(page: Page, groupId: string, chosen: string): Promise<void> {
  await page.addInitScript(
    ([jobId, gid, pick]) => {
      sessionStorage.setItem(
        `ddharmon.sandbox.${jobId}`,
        JSON.stringify({
          gateDecisions: {
            gate2_candidate_pick: {
              [gid]: { groupId: gid, chosen: pick, alternatives: [pick], optionSetKey: "seed" },
            },
          },
        }),
      );
    },
    [FINISHED_JOB, groupId, chosen],
  );
}

test.describe("gate3 pick-target screen", () => {
  test("@gate3 specs generated for the model's CDE under a re-pick show a visible notice", async ({ page }) => {
    const seeded = oneAdopt(finishedFixture());
    await seedPick(page, seeded.rec.groupId, seeded.other);
    await serveFinished(page, (run) => {
      oneAdopt(run);
      // Pre-fix shape: every spec still targets the MODEL's CDE.
      run.result!.records![0].transforms = run.result!.records![0].transforms.map((t) => ({
        ...t,
        targetCdeId: seeded.model,
      }));
    }, { keep: 0 });
    await page.goto(`/run/${FINISHED_JOB}/gate3`);
    await page.waitForLoadState("networkidle");
    const notice = page.getByTestId("spec-target-mismatch");
    await expect(notice).toBeVisible();
    await expect(notice).toContainText(seeded.model);
    await expect(notice).toContainText("not your pick");
  });

  test("@gate3 specs regenerated for the pick show no notice", async ({ page }) => {
    const seeded = oneAdopt(finishedFixture());
    await seedPick(page, seeded.rec.groupId, seeded.other);
    await serveFinished(page, (run) => {
      oneAdopt(run);
      const r = run.result!.records![0];
      r.transforms = r.transforms.map((t) => ({ ...t, targetCdeId: seeded.other }));
      r.cde = { id: seeded.other, externalId: "" };
      r.reviewerPick = { chosen: seeded.other, kind: "catalog", target: seeded.other, modelTarget: seeded.model, reason: "" };
    }, { keep: 0 });
    await page.goto(`/run/${FINISHED_JOB}/gate3`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByTestId("chosen-target")).toBeVisible();
    await expect(page.getByTestId("spec-target-mismatch")).toHaveCount(0);
  });

  test("@gate3 a pick with no target states why there are no specs", async ({ page }) => {
    const seeded = oneAdopt(finishedFixture());
    await seedPick(page, seeded.rec.groupId, "");
    const reason = "You picked “none of these” at Gate 2 and this group has no generated CDE to fall back on.";
    await serveFinished(page, (run) => {
      oneAdopt(run);
      const r = run.result!.records![0];
      r.transforms = [];
      r.cde = null;
      r.gencde = null;
      r.verdict = "novel";
      r.reviewerPick = { chosen: "", kind: "none", target: "", modelTarget: seeded.model, reason };
    }, { keep: 0 });
    await page.goto(`/run/${FINISHED_JOB}/gate3`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByTestId("reviewer-pick-reason")).toContainText("none of these");
    await expect(page.getByTestId("spec-target-mismatch")).toHaveCount(0);
  });
});
