import { expect, test, type Page } from "@playwright/test";
import { conceptTitle, groupLabel, namedGroupsById, searchableText, sortGroupsByColumn } from "@/lib/ledger";
import { conceptLabel, leftoverLabel } from "@/types";
import type { ConceptGroup, UIRecord } from "@/types";
import { PAUSED_JOB, fixtureGroups, serveRun } from "./gate1-fixture";
import { FINISHED_JOB, finishedRecords, serveFinished } from "./gate23-fixture";

/**
 * An unnamed split LEFTOVER says so, instead of borrowing its cluster's name (08-28).
 *
 * THE DEFECT. Core's split (`prepare_group_assign`) names the groups the model returned and sweeps every member
 * it did not place into one residual group with `concept: ""`, APPENDED after the model's groups — so its id is
 * `<cluster>#g<n>` with n >= 1. Every group of a cluster carries the CLUSTER's ideal description (`idealCde`),
 * and `groupLabel` fell back to it for any unnamed group, so the leftover was titled as though it were the whole
 * cluster's concept. The fixture's own blood-pressure cluster shows the harm exactly: its second group is the
 * SYSTOLIC readings, and its `idealCde` describes DIASTOLIC.
 *
 * THE OTHER UNNAMED CASE IS UNCHANGED. A cluster with no usable split falls back to ONE group over every member,
 * `<cluster>#g0` — that group IS the cluster, so the cluster's ideal is an accurate title for it.
 *
 * Neither state occurs in the shipped fixtures (every group in both is named), so both are constructed here from
 * real groups, visibly, as `gate1-fixture.ts` prescribes.
 *
 *   run: npm run test:e2e -- --grep "@leftover"
 */

const LEFTOVER_TEXT = (n: number) =>
  `Not named by the split — ${n} ${n === 1 ? "variable" : "variables"} the model left over`;

function grp(over: Partial<ConceptGroup>): ConceptGroup {
  return {
    groupId: "c1#g2",
    clusterId: "c1",
    concept: "",
    conceptIsGenerated: true,
    idealCde: "Diastolic blood pressure measurement: the cluster's ideal",
    nMembers: 9,
    cohorts: ["aou", "ukbb"],
    crossCohort: true,
    top1Cos: null,
    memberVariableNames: [],
    membersTruncated: false,
    coherence: "single",
    coherenceSummary: "Systolic readings across the cohorts",
    coherenceAxis: "",
    coherenceDistinctValues: [],
    coherenceOutliers: [],
    incoherent: false,
    matrixSuspect: false,
    ...over,
  } as ConceptGroup;
}

// --- the rule, in Node ---------------------------------------------------------------------------------------

test.describe("split leftover label", () => {
  test("@leftover an unnamed split leftover says it was not named, never the cluster's ideal", () => {
    expect(groupLabel(grp({}))).toEqual({ text: LEFTOVER_TEXT(9), source: "leftover" });
    expect(leftoverLabel(9)).toBe(LEFTOVER_TEXT(9));
  });

  test("@leftover one leftover variable reads singular", () => {
    expect(groupLabel(grp({ nMembers: 1 })).text).toBe("Not named by the split — 1 variable the model left over");
  });

  test("@leftover a group with no usable split IS the cluster, so it keeps the cluster's ideal", () => {
    expect(groupLabel(grp({ groupId: "c1#g0" }))).toEqual({
      text: "Diastolic blood pressure measurement: the cluster's ideal",
      source: "generated",
    });
  });

  test("@leftover a NAMED split group is unchanged, whatever its index", () => {
    expect(groupLabel(grp({ concept: "Systolic blood pressure" }))).toEqual({
      text: "Systolic blood pressure",
      source: "generated",
    });
  });

  test("@leftover the reviewer's own name still outranks the leftover label", () => {
    expect(groupLabel(grp({}), "My systolic items")).toEqual({ text: "My systolic items", source: "reviewer" });
  });

  test("@leftover a re-split child's leftover is a leftover too; a reviewer's own group never is", () => {
    // A re-split is namespaced under its parent group (`<parent>#g<n>`), and only the LAST index is the split's.
    expect(groupLabel(grp({ groupId: "c1#g0#g3" })).source).toBe("leftover");
    expect(groupLabel(grp({ groupId: "c1#g2#g0" })).source).toBe("generated");
    expect(groupLabel(grp({ groupId: "rev:00000000-0000-4000-8000-000000000001" })).source).toBe("generated");
  });

  test("@leftover Gates 2 and 3 title a leftover record by the same rule — through groupLabel, not a copy", () => {
    const rec = {
      groupId: "c1#g2",
      clusterId: "c1",
      concept: "",
      idealCde: "Diastolic blood pressure measurement: the cluster's ideal",
      coherence: "single",
      coherenceSummary: "",
      nMembers: 3,
      gencde: { gencdeId: "systolic_bp", preferredName: "systolic_bp" },
    } as unknown as UIRecord;
    expect(conceptTitle(rec, undefined)).toBe(LEFTOVER_TEXT(3));
    expect(conceptTitle(rec, undefined)).toBe(groupLabel(grp({ nMembers: 3, coherenceSummary: "" })).text);
    expect(conceptTitle({ ...rec, groupId: "c1#g0" }, undefined)).toBe(
      "Diastolic blood pressure measurement: the cluster's ideal",
    );
    expect(conceptTitle(rec, { chosen: "Mine" })).toBe("Mine");
  });

  test("@leftover a renamed leftover claims no generated name — ddharmon never named it", () => {
    const left = grp({});
    const byId = namedGroupsById([left], [], () => "My systolic items");
    expect(byId.get(left.groupId)).toMatchObject({ name: "My systolic items" });
    expect(byId.get(left.groupId)!.generatedName).toBeUndefined();
  });

  test("@leftover the leftover label is a placeholder: it sorts with the unnamed, after every real name", () => {
    const named = grp({ groupId: "c2#g0", clusterId: "c2", concept: "Zinc intake" });
    const left = grp({ groupId: "c1#g1" });
    const order = sortGroupsByColumn([left, named], { key: "concept", dir: "asc" }).map((g) => g.groupId);
    expect(order).toEqual(["c2#g0", "c1#g1"]);
  });

  test("@leftover the placeholder's own words are not searchable text", () => {
    // "left" or "split" typed as a clinical term must not hit every leftover in the run.
    expect(searchableText(grp({}))).not.toContain("left over");
    expect(searchableText(grp({}))).not.toContain("not named");
  });

  test("@leftover the review-queue concept label follows the same rule", () => {
    const rec = {
      groupId: "c1#g2",
      clusterId: "c1",
      concept: "",
      idealCde: "Diastolic blood pressure measurement. The cluster's ideal",
      nMembers: 4,
      gencde: null,
    } as unknown as UIRecord;
    expect(conceptLabel(rec)).toBe(LEFTOVER_TEXT(4));
    // ...a leftover with its OWN generated element is titled by that element, as before.
    expect(conceptLabel({ ...rec, gencde: { title: "Systolic BP" } as UIRecord["gencde"] })).toBe("Systolic BP");
    // ...and a no-split group still reads its cluster's ideal.
    expect(conceptLabel({ ...rec, groupId: "c1#g0" })).toBe("Diastolic blood pressure measurement");
  });
});

// --- Gate 1, in the browser ----------------------------------------------------------------------------------

/** A fixture cluster split into two named groups whose shared `idealCde` describes only the FIRST of them. */
const BP_NAMED = "cb2a6e2cd6fd3#g0"; // "Diastolic blood pressure measurement (numeric, mmHg)"
const BP_LEFTOVER = "cb2a6e2cd6fd3#g1"; // "Systolic …", made the leftover below
const WHOLE = "c8331409f61e1#g0"; // alone in its cluster — made a no-usable-split group below

async function openGate1(page: Page): Promise<void> {
  await page.goto(`/run/${PAUSED_JOB}/gate1`);
  await page.waitForLoadState("networkidle");
  await expect(page.locator("[data-testid='ledger']")).toBeVisible();
}

test.describe("Gate 1 leftover rows", () => {
  test("@leftover @gate1 a leftover row says so; its named sibling and a no-split group are unchanged", async ({
    page,
  }) => {
    const fixture = new Map(fixtureGroups().map((g) => [g.groupId, g]));
    await serveRun(page, (run) => {
      for (const g of run.result!.conceptGroups!) if (g.groupId === BP_LEFTOVER || g.groupId === WHOLE) g.concept = "";
    });
    await openGate1(page);

    const leftover = page.locator(`[data-testid='ledger-row'][data-row-id='${BP_LEFTOVER}']`);
    await expect(leftover.locator("[data-label-source='leftover']")).toHaveText(
      LEFTOVER_TEXT(fixture.get(BP_LEFTOVER)!.nMembers),
    );
    // Not the cluster's ideal, which describes the OTHER group's readings.
    await expect(leftover).not.toContainText("Diastolic");
    // A placeholder, not a borrowed or renamed name: no provenance pill.
    await expect(leftover.locator("[data-testid='borrowed-mark']")).toHaveCount(0);
    await expect(leftover.locator("[data-testid='renamed-mark']")).toHaveCount(0);

    const named = page.locator(`[data-testid='ledger-row'][data-row-id='${BP_NAMED}']`);
    await expect(named.locator("[data-label-source='generated']")).toHaveText(fixture.get(BP_NAMED)!.concept);

    const whole = page.locator(`[data-testid='ledger-row'][data-row-id='${WHOLE}']`);
    await expect(whole.locator("[data-label-source='generated']")).toHaveText(fixture.get(WHOLE)!.idealCde);

    // The detail header is titled by the same rule.
    await leftover.click();
    await expect(page.locator("h2", { hasText: "Not named by the split" })).toHaveText(
      LEFTOVER_TEXT(fixture.get(BP_LEFTOVER)!.nMembers),
    );
  });
});

// --- Gates 2 and 3, in the browser ---------------------------------------------------------------------------

const SMOKE_NAMED = "c46be33d9a542#g0";
const SMOKE_LEFTOVER = "c46be33d9a542#g2"; // 3 members
const SMOKE_SINGLE = "c46be33d9a542#g3"; // 1 member
const ALONE = "c20f12f09afa6#g0";

async function serveLeftovers(page: Page): Promise<void> {
  const ids = [SMOKE_NAMED, SMOKE_LEFTOVER, SMOKE_SINGLE, ALONE];
  await serveFinished(
    page,
    (run) => {
      run.result!.records = run.result!.records!.filter((r) => ids.includes(r.groupId));
      for (const r of run.result!.records!) if (r.groupId !== SMOKE_NAMED) r.concept = "";
    },
    { keep: 0 },
  );
}

function record(groupId: string): UIRecord {
  return finishedRecords().find((r) => r.groupId === groupId)!;
}

test.describe("Gate 2 and 3 leftover titles", () => {
  test("@leftover @gate2 a leftover concept is titled as a leftover; a named one and a no-split one are not", async ({
    page,
  }) => {
    await serveLeftovers(page);
    await page.goto(`/run/${FINISHED_JOB}/gate2`);
    await page.waitForLoadState("networkidle");
    const row = (gid: string) => page.locator(`[data-testid='gate2-concept'][data-concept-id='${gid}']`);
    await expect(row(SMOKE_LEFTOVER)).toContainText(LEFTOVER_TEXT(record(SMOKE_LEFTOVER).nMembers));
    await expect(row(SMOKE_SINGLE)).toContainText("Not named by the split — 1 variable the model left over");
    await expect(row(SMOKE_NAMED)).toContainText(record(SMOKE_NAMED).concept);
    await expect(row(ALONE)).toContainText(record(ALONE).idealCde.slice(0, 40));
    await row(SMOKE_LEFTOVER).click();
    await expect(page.getByTestId("concept-title")).toHaveText(LEFTOVER_TEXT(record(SMOKE_LEFTOVER).nMembers));
  });

  test("@leftover @gate3 Gate 3 lists the same leftover title", async ({ page }) => {
    await serveLeftovers(page);
    await page.goto(`/run/${FINISHED_JOB}/gate3`);
    await page.waitForLoadState("networkidle");
    const row = page.locator(`[data-testid='gate3-concept'][data-concept-id='${SMOKE_LEFTOVER}']`);
    await expect(row).toContainText(LEFTOVER_TEXT(record(SMOKE_LEFTOVER).nMembers));
  });
});
