import { expect, test, type Page } from "@playwright/test";
import { DECISION_IDENTITY_FIELDS, GATE_DECISION_KINDS, decisionItemKey } from "@/lib/gate-decisions";
import { SANDBOX_PREFIX } from "@/lib/sandbox";
import {
  COMBINE_COALESCE,
  COMBINE_SEPARATE,
  combineAlternatives,
  combineChoice,
  combineGroups,
} from "@/lib/combine-rules";
import { FINISHED_JOB, serveFinished } from "./gate23-fixture";

/**
 * 08-28 item 1d — several variables of ONE cohort landing on ONE target column (F1).
 *
 * The notebook wrote each same-cohort variable over the one before it. Q4: the reviewer chooses per
 * (cohort, target) — coalesce (the default: first non-blank in member order + a `TARGET__source` column),
 * keep separate columns, or one named source — recorded as a `gate3_combine_rule` decision, and Gate 3 offers
 * the choice ONLY where a cohort has two or more variables on one target. The grouping mirrors
 * `backend/combine_rules.py::combine_groups` (the same edge rule the notebook applies).
 */

const rec = (groupId: string, members: string[], target: string | null, transforms: object[] = []) =>
  ({ groupId, members, cde: target ? { id: target, externalId: "" } : null, transforms }) as never;

test.describe("combine-rule algebra (08-28 1d)", () => {
  test("@gate3 the kind is registered, keyed on the (cohort, target) column it governs", () => {
    expect(GATE_DECISION_KINDS).toContain("gate3_combine_rule");
    expect(DECISION_IDENTITY_FIELDS.gate3_combine_rule).toEqual(["cohort", "targetId"]);
    expect(decisionItemKey("gate3_combine_rule", { cohort: "CLSA", targetId: "T" })).toBe("CLSA|T");
  });

  test("@gate3 a group is two or more variables of one cohort on one target, across records", () => {
    const records = [
      rec("g1", ["CLSA:a", "CLSA:b", "AoU:x"], "T", [{ sourceVariable: "CLSA:b", targetCdeId: "T" }]),
      rec("g2", ["CLSA:c"], "T"),
      rec("g3", ["CLSA:d"], null), // a novel with no target writes no column
      rec("g4", ["AoU:y"], "U"),
    ];
    expect(combineGroups(records)).toEqual([{ cohort: "CLSA", targetId: "T", members: ["CLSA:a", "CLSA:b", "CLSA:c"] }]);
    // a rejected recode writes nothing, so it is not one of the column's writers
    expect(combineGroups(records, new Set(["CLSA:a"]))).toEqual([
      { cohort: "CLSA", targetId: "T", members: ["CLSA:b", "CLSA:c"] },
    ]);
    expect(combineGroups(records, new Set(["CLSA:a", "CLSA:b"]))).toEqual([]);
    // a spec that re-targets its member moves it to that column
    expect(
      combineGroups([rec("g5", ["MESA:p", "MESA:q"], "T", [{ sourceVariable: "MESA:q", targetCdeId: "REF:1" }])]),
    ).toEqual([]);
  });

  test("@gate3 the rule: the reviewer's choice, else the stated default", () => {
    const members = ["CLSA:a", "CLSA:b"];
    expect(combineAlternatives(members)).toEqual([COMBINE_COALESCE, COMBINE_SEPARATE, ...members]);
    expect(combineChoice(undefined, members)).toEqual({ rule: "coalesce", source: "", decidedBy: "default" });
    expect(combineChoice({ chosen: "separate" }, members)).toEqual({
      rule: "separate",
      source: "",
      decidedBy: "reviewer",
    });
    expect(combineChoice({ chosen: "CLSA:b" }, members)).toEqual({
      rule: "source",
      source: "CLSA:b",
      decidedBy: "reviewer",
    });
    // a source that no longer writes the column cannot be its writer: the default applies, and says why
    expect(combineChoice({ chosen: "CLSA:z" }, members)).toMatchObject({ rule: "coalesce", decidedBy: "default" });
  });
});

// --- on screen ---------------------------------------------------------------------------------------------

const PAIR = "c46be33d9a542#g5"; // a real adopt concept: two AoU variables on one catalog CDE
const SPREAD = "c46be33d9a542#g0"; // four variables, four cohorts: nothing to combine

async function open(page: Page, groupId: string): Promise<void> {
  await serveFinished(
    page,
    (run) => {
      run.result!.records = [run.result!.records!.find((x) => x.groupId === groupId)!];
    },
    { keep: 0 },
  );
  await page.goto(`/run/${FINISHED_JOB}/gate3`);
  await page.waitForLoadState("networkidle");
}

test.describe("gate3 combine rule on screen (08-28 1d)", () => {
  test("@gate3 the control appears only where a cohort has two or more variables on one target", async ({ page }) => {
    await open(page, SPREAD);
    await expect(page.locator("[data-testid='spec-row']").first()).toBeVisible();
    await expect(page.getByTestId("combine-rule")).toHaveCount(0);

    await open(page, PAIR);
    const control = page.getByTestId("combine-rule");
    await expect(control).toHaveCount(1);
    await expect(control).toHaveAttribute("data-cohort", "AoU");
    await expect(control).toHaveAttribute("data-target", "Age when stopped smoking cigarettes completely");
    await expect(control).toHaveAttribute("data-rule", "coalesce");
    await expect(control).toHaveAttribute("data-decided-by", "default");
    await expect(control).toContainText("attemptquitsmoking_completelyquit");
    await expect(control).toContainText("attemptquitsmoking_completelyquitage");
  });

  test("@gate3 choosing a rule records a gate3_combine_rule decision that survives a reload", async ({ page }) => {
    await open(page, PAIR);
    const control = page.getByTestId("combine-rule");
    await control.getByTestId("combine-rule-select").selectOption("separate");
    await expect(control).toHaveAttribute("data-rule", "separate");
    await expect(control).toHaveAttribute("data-decided-by", "reviewer");
    const stored = await page.evaluate(
      (key) => JSON.parse(sessionStorage.getItem(key) ?? "{}"),
      `${SANDBOX_PREFIX}${FINISHED_JOB}`,
    );
    const d = stored.gateDecisions.gate3_combine_rule["AoU|Age when stopped smoking cigarettes completely"];
    expect(d).toMatchObject({
      cohort: "AoU",
      targetId: "Age when stopped smoking cigarettes completely",
      chosen: "separate",
      alternatives: [
        "coalesce",
        "separate",
        "AoU:attemptquitsmoking_completelyquit",
        "AoU:attemptquitsmoking_completelyquitage",
      ],
    });
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(page.getByTestId("combine-rule")).toHaveAttribute("data-rule", "separate");

    // one named source
    await page.getByTestId("combine-rule-select").selectOption("AoU:attemptquitsmoking_completelyquitage");
    await expect(page.getByTestId("combine-rule")).toHaveAttribute("data-rule", "source");
  });
});
