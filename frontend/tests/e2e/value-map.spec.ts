import { expect, test, type Page } from "@playwright/test";
import { SANDBOX_PREFIX, withGateDecision } from "@/lib/sandbox";
import {
  DROP_BUCKET,
  MISSING_BUCKET,
  catalogTargetValues,
  codeMapToBuckets,
  generatedTargetValues,
  mappingForSave,
  mappingHeadline,
  mappingInCodes,
  mappingSummary,
  recommendedMapping,
  rowTargetValues,
  withModelTargets,
} from "@/lib/value-map";
import { FINISHED_JOB, serveFinished } from "./gate23-fixture";

/**
 * 08-28 item 1c — the Gate 3 value-map editor's algebra, asserted in node (the frontend has no unit runner).
 *
 * F19: `codeMapToBuckets` matched the model's TARGET CODES ("9") against bucket LABELS ("Don't know"), so on a
 * GenCDE target whose codes differ from its labels it never hit, and the editor showed a $0 label heuristic as
 * "ddharmon's recommended mapping" — with the model's -121 → 9 displayed as UNMAPPED.
 * F18: whatever the editor then saved was LABELS, so one harmonized column mixed "1"/"0" (the model's recodes)
 * with "Yes"/"No" (the reviewer's).
 *
 * The fix routes every value through the target's permissible-value TABLE: buckets are keyed by target CODE,
 * the model's map is placed by code, and a save writes codes. A catalog CDE's value IS its label (the catalog
 * lists values, not code/label pairs), so its table is label = code.
 */

// The live walk's case: a GenCDE edited at Gate 2 to 1=Yes / 0=No / 9=Don't know (run 6c66731c, migraine).
const GENERATED = generatedTargetValues([
  { code: "1", label: "Yes" },
  { code: "0", label: "No" },
  { code: "9", label: "Don't know" },
]);
const SOURCE = [
  { code: "1", label: "Yes" },
  { code: "2", label: "No" },
  { code: "-121", label: "Do not know" },
  { code: "-818", label: "Prefer not to answer" },
];
const MODEL_MAP = { "1": "1", "2": "0", "-121": "9" };

test.describe("value-map algebra (08-28 1c)", () => {
  test("@gate3 F19 the model's code map is placed BY CODE on a target whose codes differ from its labels", () => {
    expect(codeMapToBuckets(MODEL_MAP, GENERATED)).toEqual({ "1": "1", "2": "0", "-121": "9" });
  });

  test("@gate3 a catalog target's table is its value list, label = code", () => {
    const catalog = catalogTargetValues(["Yes", "No", "Unknown"]);
    expect(catalog.map((v) => [v.code, v.label])).toEqual([
      ["Yes", "Yes"],
      ["No", "No"],
      ["Unknown", "Unknown"],
    ]);
    expect(codeMapToBuckets({ "1": "Yes", "2": "No" }, catalog)).toEqual({ "1": "Yes", "2": "No" });
  });

  test("@gate3 a value written as a LABEL resolves to its code; an unknown one is kept, never dropped", () => {
    // a legacy / label-keyed map still lands on the right bucket …
    expect(codeMapToBuckets({ "-121": "don't know", "1": "Yes" }, GENERATED)).toEqual({ "-121": "9", "1": "1" });
    // … and a target the carried list does not show is KEPT (the catalog list is capped on the wire), so a
    // reviewer who saves never silently turns the model's placement into "missing".
    expect(codeMapToBuckets({ "5": "77" }, GENERATED)).toEqual({ "5": "77" });
    const buckets = withModelTargets(GENERATED, { "5": "77", "1": "1" });
    expect(buckets.map((b) => [b.code, b.listed])).toEqual([
      ["1", true],
      ["0", true],
      ["9", true],
      ["77", false],
    ]);
  });

  test("@gate3 the recommendation IS the model's map when it produced one — no heuristic mixed in", () => {
    // -818 "Prefer not to answer" reads like a missing-data label, but the model left it unmapped: the editor
    // opens on what the model said, not on a $0 guess dressed up as the model's.
    expect(recommendedMapping(SOURCE, GENERATED, MODEL_MAP)).toEqual({
      mapping: { "1": "1", "2": "0", "-121": "9" },
      from: "model",
    });
  });

  test("@gate3 with no model map the $0 heuristic seeds in CODES and says it is a heuristic", () => {
    expect(recommendedMapping(SOURCE, GENERATED, undefined)).toEqual({
      mapping: { "1": "1", "2": "0", "-818": MISSING_BUCKET },
      from: "heuristic",
    });
    expect(recommendedMapping(SOURCE, GENERATED, {}).from).toBe("heuristic");
  });

  test("@gate3 F18 a persisted label mapping is shown in codes", () => {
    expect(
      mappingInCodes({ "1": "Yes", "2": "No", "-121": "Don't know", "-818": MISSING_BUCKET, x: DROP_BUCKET }, GENERATED),
    ).toEqual({ "1": "1", "2": "0", "-121": "9", "-818": MISSING_BUCKET, x: DROP_BUCKET });
  });

  test("@gate3 Q3 a save stores the WHOLE mapping; an unplaced code is an explicit 'missing'", () => {
    const codes = SOURCE.map((o) => o.code);
    expect(mappingForSave(codes, { "1": "1", "2": "0", "-121": "" })).toEqual({
      "1": "1",
      "2": "0",
      "-121": MISSING_BUCKET,
      "-818": MISSING_BUCKET,
    });
    // a code the mapping carries but the source list does not is kept, not dropped
    expect(mappingForSave(["1"], { "1": "1", "7": "0" })).toEqual({ "1": "1", "7": "0" });
  });

  test("@gate3 the row headline counts the REVIEWER's mapping", () => {
    const codes = SOURCE.map((o) => o.code);
    const s = mappingSummary(codes, { "1": "1", "2": "0", "-121": MISSING_BUCKET, "-818": DROP_BUCKET });
    expect(s).toEqual({ mapped: 2, missing: 1, dropped: 1, unplaced: 0, total: 4, coverage: 0.5 });
    expect(mappingHeadline(s)).toBe("2 codes mapped, 1 set missing, 1 dropped");
    const partial = mappingSummary(codes, { "1": "1" });
    expect(partial).toEqual({ mapped: 1, missing: 0, dropped: 0, unplaced: 3, total: 4, coverage: 0.25 });
    expect(mappingHeadline(partial)).toBe("1 code mapped, 3 unplaced (exported as missing)");
  });

  test("@gate3 each row maps into the table of the target ITS spec writes", () => {
    const gencde = { gencdeId: "REFCDE:x#g0", permissibleValues: [{ code: "98", label: "Prefer not to answer" }] };
    const candidates = [{ cdeId: "Catalog", permissibleValues: ["Yes", "No"] }];
    const fallback = catalogTargetValues(["Yes", "No"]);
    // a refine record's spec writes its DERIVED element, not the catalog CDE the panel shows
    expect(rowTargetValues({ transform: { targetCdeId: "REFCDE:x#g0" }, gencde, candidates, fallback })).toEqual(
      generatedTargetValues(gencde.permissibleValues),
    );
    expect(rowTargetValues({ transform: { targetCdeId: "Catalog" }, gencde, candidates, fallback })).toEqual(
      catalogTargetValues(["Yes", "No"]),
    );
    // no spec (a failed row) → the target the reviewer is shown
    expect(rowTargetValues({ transform: undefined, gencde, candidates, fallback })).toEqual(fallback);
  });
});

// --- on screen: the Gate 3 editor against a constructed F19 case ------------------------------------------

const JOB = FINISHED_JOB;
const GROUP = "c5351b9c25c6a#g1"; // a real novel concept whose GenCDE is coded 1=Yes / 0=No
const SRC = "CLSA:SMK_OTREG_TRM";

/** Re-shape the real record into the live walk's case: target codes 1/0/9 whose labels differ from them. */
async function serveF19(page: Page): Promise<void> {
  await serveFinished(
    page,
    (run) => {
      const r = run.result!.records!.find((x) => x.groupId === GROUP)!;
      r.gencde!.permissibleValues = [
        { code: "1", label: "Yes" },
        { code: "0", label: "No" },
        { code: "9", label: "Don't know" },
      ];
      const t = r.transforms.find((x) => x.sourceVariable === SRC)!;
      t.kind = "categorical";
      t.codeMap = { ...MODEL_MAP };
      t.unmappedSourceCodes = ["-818"];
      t.coverage = 0.75;
      run.result!.fieldIndex = {
        ...run.result!.fieldIndex,
        [SRC]: { ...(run.result!.fieldIndex?.[SRC] ?? { name: "SMK_OTREG_TRM", text: "" }), responseOptions: SOURCE },
      };
      run.result!.records = [r];
    },
    { keep: 0 },
  );
  await page.goto(`/run/${JOB}/gate3`);
  await page.waitForLoadState("networkidle");
}

test.describe("gate3 value map on screen (08-28 1c)", () => {
  const row = (page: Page) => page.locator(`[data-testid='spec-row'][data-source='${SRC}']`);
  const bucketOf = (page: Page, code: string) =>
    row(page)
      .locator(`[data-testid='spec-value-chip'][data-code='${code}']`)
      .locator("xpath=ancestor::*[@data-testid='spec-bucket'][1]");

  test("@gate3 F19 the editor opens on the MODEL's mapping, placed by target code", async ({ page }) => {
    await serveF19(page);
    await expect(row(page).getByTestId("spec-mapping-editor")).toBeVisible();
    await expect(bucketOf(page, "1")).toHaveAttribute("data-bucket", "1");
    await expect(bucketOf(page, "2")).toHaveAttribute("data-bucket", "0");
    // the model's -121 → 9 ("Don't know"), which the label heuristic showed as UNMAPPED
    await expect(bucketOf(page, "-121")).toHaveAttribute("data-bucket", "9");
    // the model left -818 unmapped: it is shown unplaced, not moved by a $0 guess the model never made
    await expect(bucketOf(page, "-818")).toHaveAttribute("data-bucket", "");
    await expect(row(page).locator("[data-testid='spec-bucket'][data-bucket='9']")).toContainText("Don't know");
    await expect(row(page).getByTestId("spec-mapping-source")).toHaveAttribute("data-from", "model");
  });

  test("@gate3 F18 a drag saves the WHOLE mapping in target codes, and the row header reflects it", async ({ page }) => {
    await serveF19(page);
    await row(page)
      .locator("[data-testid='spec-value-chip'][data-code='-121']")
      .dragTo(row(page).locator(`[data-testid='spec-bucket'][data-bucket='${MISSING_BUCKET}']`));
    await expect(row(page).getByTestId("spec-saved")).toBeVisible();
    const stored = await page.evaluate(
      (key) => JSON.parse(sessionStorage.getItem(key) ?? "{}"),
      `${SANDBOX_PREFIX}${JOB}`,
    );
    expect(stored.gateDecisions.gate3_spec_edit[SRC].mapping).toEqual({
      "1": "1",
      "2": "0",
      "-121": MISSING_BUCKET,
      "-818": MISSING_BUCKET,
    });
    await expect(row(page).getByTestId("spec-row-summary")).toHaveText("2 codes mapped, 2 set missing");
    await expect(row(page).getByTestId("spec-row-coverage")).toHaveText("coverage 50%");
    // …and after a reload the editor shows exactly what was saved
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(bucketOf(page, "-121")).toHaveAttribute("data-bucket", MISSING_BUCKET);
    await expect(bucketOf(page, "-818")).toHaveAttribute("data-bucket", MISSING_BUCKET);
    await expect(bucketOf(page, "2")).toHaveAttribute("data-bucket", "0");
  });

  test("@gate3 F18 a mapping saved in LABELS before the fix is shown in codes", async ({ page }) => {
    await serveF19(page);
    const state = withGateDecision({}, "gate3_spec_edit", SRC, {
      sourceVariable: SRC,
      chosen: SRC,
      alternatives: [SRC],
      optionSetKey: "k",
      mapping: { "1": "Yes", "2": "No", "-121": "Don't know", "-818": MISSING_BUCKET },
    });
    await page.evaluate(
      ({ key, state }) => sessionStorage.setItem(key, JSON.stringify(state)),
      { key: `${SANDBOX_PREFIX}${JOB}`, state },
    );
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(bucketOf(page, "2")).toHaveAttribute("data-bucket", "0");
    await expect(bucketOf(page, "-121")).toHaveAttribute("data-bucket", "9");
  });
});
