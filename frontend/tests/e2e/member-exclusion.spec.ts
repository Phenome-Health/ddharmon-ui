import { expect, test, type Page } from "@playwright/test";
import {
  DECISION_IDENTITY_FIELDS,
  GATE_DECISION_KINDS,
  decisionItemKey,
  indexDecisions,
  optionSetKey,
  type GateDecision,
} from "@/lib/gate-decisions";
import { seedBases, splitServedRows, writeAgainstBase } from "@/lib/gate-conflicts";
import { combineGroups } from "@/lib/combine-rules";
import {
  MEMBER_EXCLUDE,
  MEMBER_EXCLUSION_ALTERNATIVES,
  canRemoveMember,
  removalWrite,
  removedMembersOf,
  withoutRemovedMembers,
} from "@/lib/member-exclusion";
import { decisionLogCsvRows, decisionLogRows } from "@/lib/gate4";
import { SANDBOX_PREFIX } from "@/lib/sandbox";
import type { ArtifactWriteResponse, HarmonizationResult, UIRecord } from "@/types";
import { asOwnedRun } from "./gate1-fixture";
import { FINISHED_JOB, serveFinished } from "./gate23-fixture";

/**
 * Removing a rogue variable from one concept at Gate 3 (review round 2, Gate 3 note 2).
 *
 * Bhargav: "take a look at 'LV renamed · Self-reported overall general health sta', somehow a self-reported weight
 * var slipped in. User should have ability at this gate to remove a rogue var from a group."
 *
 * A reviewer decision of its own kind, `gate3_member_exclusion`, keyed on the (group, variable) pair it removes,
 * written through the one decision hook — so it rehydrates, carries a version for the two-tab notice, lands in the
 * guest sandbox on the pinned demo, and refuses on a frozen gate like every other kind. The variable leaves that
 * concept's transform specs and every export (`backend/export_decisions.py::effective_records`, pinned by
 * `tests/test_member_exclusion.py`) and the decision log lists the removal. Undo deletes the row. Nothing re-runs.
 *
 *   run: E2E_PORT=4213 npx playwright test member-exclusion
 */

const KIND = "gate3_member_exclusion" as const;
const SPREAD = "c46be33d9a542#g0"; // adopt; four variables in four cohorts, each with its own recode
const PAIR = "c46be33d9a542#g5"; // adopt; two AoU variables on one catalog CDE — a combine group
const ROGUE = "UKBB:Light smokers, at least 100 smokes in lifetime";

const removal = (groupId: string, memberId: string): GateDecision => ({
  groupId,
  memberId,
  chosen: MEMBER_EXCLUDE,
  alternatives: [...MEMBER_EXCLUSION_ALTERNATIVES],
  optionSetKey: optionSetKey(MEMBER_EXCLUSION_ALTERNATIVES),
});

// --- the algebra (node) ---------------------------------------------------------------------------------------

test.describe("member-exclusion algebra", () => {
  test("@gate3 the kind is registered, keyed on the group and the variable it removes", () => {
    expect(GATE_DECISION_KINDS).toContain(KIND);
    expect(DECISION_IDENTITY_FIELDS[KIND]).toEqual(["groupId", "memberId"]);
    expect(decisionItemKey(KIND, { groupId: "c1#g0", memberId: "B:weight" })).toBe("c1#g0|B:weight");
    expect(MEMBER_EXCLUSION_ALTERNATIVES).toEqual(["keep", "exclude"]);
  });

  test("@gate3 the write a removal makes is the payload the store accepts", () => {
    const { fields, options } = removalWrite("c1#g0", "B:weight");
    expect(fields).toEqual({ groupId: "c1#g0", memberId: "B:weight" });
    expect(options).toEqual({ chosen: "exclude", alternatives: ["keep", "exclude"] });
  });

  test("@gate3 a removal belongs to the concept it was made on", () => {
    const decisions = indexDecisions({
      [KIND]: [removal("g1", "A:x"), removal("g2", "A:y"), { ...removal("g1", "A:z"), chosen: "keep" }],
    })[KIND];
    expect([...removedMembersOf(decisions, "g1")]).toEqual(["A:x"]); // a non-removal row removes nothing
    expect([...removedMembersOf(decisions, "g2")]).toEqual(["A:y"]);
    expect(removedMembersOf(decisions, "g3").size).toBe(0);
    expect(removedMembersOf(undefined, "g1").size).toBe(0);
  });

  test("@gate3 a concept keeps at least one variable", () => {
    const members = ["A:x", "B:y"];
    expect(canRemoveMember(members, new Set(), "A:x")).toBe(true);
    expect(canRemoveMember(members, new Set(["B:y"]), "A:x")).toBe(false); // the last one left
    expect(canRemoveMember(members, new Set(["A:x"]), "A:x")).toBe(false); // already out
    expect(canRemoveMember(["A:x"], new Set(), "A:x")).toBe(false);
  });

  test("@gate3 a removed variable writes no column, so it is no one's combine partner", () => {
    const rec = (groupId: string, members: string[]) =>
      ({ groupId, members, cde: { id: "T", externalId: "" }, transforms: [] }) as unknown as UIRecord;
    const records = [rec("g1", ["CLSA:a", "CLSA:b"]), rec("g2", ["AoU:x"])];
    expect(combineGroups(records)).toHaveLength(1);
    const decisions = indexDecisions({ [KIND]: [removal("g1", "CLSA:b")] })[KIND];
    const kept = withoutRemovedMembers(records, decisions);
    expect(kept[0].members).toEqual(["CLSA:a"]);
    expect(kept[1]).toBe(records[1]); // an untouched concept is passed through as is
    expect(combineGroups(kept)).toEqual([]);
    expect(records[0].members).toEqual(["CLSA:a", "CLSA:b"]); // never mutated
  });

  test("@gate3 two tabs removing on one run: the version rides the save, so the second blind save is reported", async () => {
    let clock = 1_790_000_000.25;
    const rows = new Map<string, { payload: GateDecision; updatedAt: number }>();
    const put = async (payload: GateDecision, base: number | undefined): Promise<ArtifactWriteResponse> => {
      const itemKey = decisionItemKey(KIND, payload);
      const prior = rows.get(itemKey);
      const conflict = prior && prior.updatedAt !== base ? { replacedUpdatedAt: prior.updatedAt, message: "x" } : null;
      clock += 1.5;
      rows.set(itemKey, { payload, updatedAt: clock });
      return { kind: KIND, itemKey, updatedAt: clock, conflict };
    };
    const read = () => ({ [KIND]: [...rows.values()].map((r) => ({ ...r.payload, updatedAt: r.updatedAt })) });
    const tab = () => {
      const bases = seedBases({}, splitServedRows(read()).versions[KIND]);
      return (d: GateDecision) => writeAgainstBase(put, bases, decisionItemKey(KIND, d), d, { kind: KIND });
    };
    await tab()(removal("g1", "A:x"));
    const a = tab();
    const b = tab();
    expect(await a(removal("g1", "A:x"))).toBeNull();
    expect(await b(removal("g1", "A:x"))).toMatchObject({ kind: KIND, itemKey: "g1|A:x", sentBase: true });
  });

  test("@gate3 the decision log lists a removal, on screen and in the file", () => {
    const record = {
      id: "g1",
      groupId: "g1",
      concept: "Smoking status",
      members: ["A:smoke", "B:weight"],
      transforms: [],
      candidates: [],
    } as unknown as UIRecord;
    const result = { records: [record] } as unknown as HarmonizationResult;
    const index = indexDecisions({ [KIND]: [removal("g1", "B:weight"), removal("zz#g9", "B:weight")] });

    const shown = decisionLogRows(index, result).filter((r) => r.kind === KIND);
    expect(shown[0]).toMatchObject({
      gate: "Gate 3",
      action: "Removed a variable from a concept",
      label: "Smoking status",
      detail: "removed B:weight",
    });

    const rows = decisionLogCsvRows(index, result, {}, {}).filter((r) => r[1] === KIND);
    expect(rows).toEqual([
      ["Gate 3", KIND, "Removed a variable from a concept", "g1|B:weight", "g1", "removed", "", "", "false"],
      [
        "Gate 3",
        KIND,
        "Removed a variable from a concept",
        "zz#g9|B:weight",
        "zz#g9",
        "removed",
        "",
        '{"notApplied":"no record for this group in the run\'s results"}',
        "false",
      ],
    ]);
  });
});

// --- on screen (the pinned demo, so every write lands in the guest sandbox) ------------------------------------

async function open(page: Page, groupId: string, gatePosition?: "gate4"): Promise<void> {
  await serveFinished(
    page,
    (run) => {
      run.result!.records = [run.result!.records!.find((x) => x.groupId === groupId)!];
      // A passed gate is a record only on a run of the reviewer's own: the shared demo stays open to practise on.
      if (gatePosition) {
        run.gatePosition = gatePosition;
        asOwnedRun(run);
      }
    },
    { keep: 0 },
  );
  await page.goto(`/run/${FINISHED_JOB}/gate3`);
  await page.waitForLoadState("networkidle");
}

const specRow = (page: Page, source: string) => page.locator(`[data-testid='spec-row'][data-source='${source}']`);
const removedRow = (page: Page, source: string) => page.locator(`[data-testid='removed-row'][data-source='${source}']`);
const held = (page: Page) =>
  page.evaluate((k) => JSON.parse(sessionStorage.getItem(k) ?? "{}"), `${SANDBOX_PREFIX}${FINISHED_JOB}`);

test.describe("removing a variable from a concept on Gate 3", () => {
  test("@gate3 Remove takes the variable out of the concept, records it, survives a reload, and Undo puts it back", async ({
    page,
  }) => {
    await open(page, SPREAD);
    await expect(page.locator("[data-testid='spec-row']")).toHaveCount(4);
    await specRow(page, ROGUE).getByTestId("spec-remove").click();

    // The row folds to a removed line with its Undo; its recode editors are gone, and the counts follow.
    await expect(specRow(page, ROGUE)).toHaveCount(0);
    await expect(removedRow(page, ROGUE)).toContainText("Removed from this concept");
    await expect(page.locator("[data-testid='spec-row']")).toHaveCount(3);
    await expect(page.getByTestId("gate3-removed-count")).toHaveText("1 removed");
    // The queue row counts what is left, and the cohort the variable was the only one from is gone with it.
    await expect(page.locator("[data-testid='gate3-concept']")).toContainText("3 vars");
    await expect(page.locator("[data-testid='gate3-concept']")).not.toContainText("UKBB");

    // The decision, in the guest sandbox — never a request (the demo is read-only on the server).
    const stored = await held(page);
    expect(stored.gateDecisions[KIND][`${SPREAD}|${ROGUE}`]).toMatchObject({
      groupId: SPREAD,
      memberId: ROGUE,
      chosen: "exclude",
      alternatives: ["keep", "exclude"],
    });
    await expect(page.getByTestId("sandbox-banner")).toHaveAttribute("data-unsaved", "1");

    // Rehydrates.
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(removedRow(page, ROGUE)).toBeVisible();

    // Undo: the row and its recode are back; the decision is gone.
    await removedRow(page, ROGUE).getByTestId("spec-remove-undo").click();
    await expect(removedRow(page, ROGUE)).toHaveCount(0);
    await expect(specRow(page, ROGUE)).toBeVisible();
    await expect(page.locator("[data-testid='spec-row']")).toHaveCount(4);
    await expect(page.getByTestId("gate3-removed-count")).toHaveCount(0);
    expect(Object.keys((await held(page)).gateDecisions[KIND] ?? {})).toEqual([]);
    await expect(page.getByTestId("sandbox-banner")).toHaveAttribute("data-unsaved", "0");
  });

  test("@gate3 removing one of two same-cohort variables leaves nothing to combine; the last one cannot go", async ({
    page,
  }) => {
    await open(page, PAIR);
    await expect(page.getByTestId("combine-rule")).toHaveCount(1);
    await specRow(page, "AoU:attemptquitsmoking_completelyquit").getByTestId("spec-remove").click();
    await expect(page.getByTestId("combine-rule")).toHaveCount(0);
    // A concept keeps at least one variable — the remaining one says why it cannot be removed.
    const last = specRow(page, "AoU:attemptquitsmoking_completelyquitage").getByTestId("spec-remove");
    await expect(last).toBeDisabled();
    expect(await last.getAttribute("title")).toMatch(/at least one variable/i);
  });

  test("@gate3 a past Gate 3 is a record: no removal, and no undo of one", async ({ page }) => {
    await page.addInitScript(
      ([key, groupId, memberId, kind]) => {
        const alternatives = ["keep", "exclude"];
        sessionStorage.setItem(
          key,
          JSON.stringify({
            gateDecisions: {
              [kind]: { [`${groupId}|${memberId}`]: { groupId, memberId, chosen: "exclude", alternatives, optionSetKey: "x" } },
            },
          }),
        );
      },
      [`${SANDBOX_PREFIX}${FINISHED_JOB}`, SPREAD, ROGUE, KIND],
    );
    await open(page, SPREAD, "gate4");
    await expect(removedRow(page, ROGUE)).toBeVisible();
    await expect(removedRow(page, ROGUE).getByTestId("spec-remove-undo")).toBeDisabled();
    const buttons = await page.locator("[data-testid='spec-row'] [data-testid='spec-remove']").all();
    expect(buttons).toHaveLength(3);
    for (const button of buttons) {
      await expect(button).toBeDisabled();
    }
  });
});
