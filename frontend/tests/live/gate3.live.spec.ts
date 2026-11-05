/**
 * Gate 3 display invariants, against the real run.
 *
 *   I8 — a spec that could not be produced (kind `none`, empty code map) never reads "No transform required"
 *        (F16: the diabetes yes/no → 35-value disease list read as already matching).
 *   I7 — the mapping editor OPENS on the model's own mapping (F19: for a GenCDE target whose codes differ from
 *        its labels, `codeMapToBuckets` matched codes against labels and showed the model's -121→9 UNMAPPED),
 *        and an edit made in the editor is SAVED in the target's CODES (F18: it saved labels, so one column
 *        mixed "1"/"0" from the model with "Yes"/"No" from the reviewer).
 *
 * The edit test drives the real drag-and-drop editor, because what I7 guards is what the screen seeds and
 * writes — an API write would only prove the store holds whatever the test sent.
 */
import { expect, test, type Page } from "@playwright/test";
import { artifacts, checkpoint, gotoGate, onlyAt } from "./live";

const MISSING = "__missing__";
const DROP = "__drop__";

type Rec = any;

function gencdeTarget(r: Rec, t: any): boolean {
  return !!r.gencde && t.targetCdeId === r.gencde.gencdeId;
}

/** The target value a code map entry points at, as a bucket title may show it (label or code). */
function targetNames(r: Rec, value: string): string[] {
  const pv = (r.gencde?.permissibleValues ?? []).find((v: any) => String(v.code) === String(value));
  return pv ? [String(pv.code), String(pv.label)] : [String(value)];
}

async function openRecord(page: Page, gid: string): Promise<void> {
  const row = page.getByTestId("gate3-rows").locator(`[data-concept-id="${gid}"]`);
  await row.scrollIntoViewIfNeeded();
  await row.click();
  await expect(page.getByTestId("gate3-detail")).toBeVisible();
}

test.describe("Gate 3", () => {
  test("I8: a spec that could not be produced never reads 'No transform required'", async ({ page, request }) => {
    onlyAt("gate3", "gate4");
    const records: Rec[] = (await checkpoint(request)).result?.records ?? [];
    const none = records.flatMap((r) =>
      (r.transforms ?? []).filter((t: any) => t.kind === "none").map((t: any) => ({ r, t })),
    );
    test.skip(none.length === 0, "this run produced no kind=none spec");
    await gotoGate(page, "gate3");
    for (const { r, t } of none) {
      await openRecord(page, r.groupId);
      const row = page.locator(`[data-testid="spec-row"][data-source="${t.sourceVariable}"]`);
      await expect(row).toBeVisible();
      await expect.soft(row, `${t.sourceVariable} (kind none, coverage ${t.coverage})`).not.toContainText(
        /No transform required/i,
      );
    }
  });

  test("I7: the mapping editor opens on the model's mapping", async ({ page, request }) => {
    onlyAt("gate3", "gate4");
    const records: Rec[] = (await checkpoint(request)).result?.records ?? [];
    const decided = new Set(((await artifacts(request)).gate3_spec_edit ?? []).map((d: any) => d.sourceVariable));
    const cases = records.flatMap((r) =>
      (r.transforms ?? [])
        .filter((t: any) => t.kind === "categorical" && Object.keys(t.codeMap ?? {}).length && !decided.has(t.sourceVariable))
        .map((t: any) => ({ r, t })),
    );
    test.skip(cases.length === 0, "no undecided categorical spec with a model code map");
    // The failure mode (F19) only shows where a target's CODES differ from its labels, so those cases go first.
    const codeDiffers = ({ r, t }: { r: Rec; t: any }) =>
      gencdeTarget(r, t) && (r.gencde?.permissibleValues ?? []).some((v: any) => String(v.code) !== String(v.label));
    cases.sort((x, y) => Number(codeDiffers(y)) - Number(codeDiffers(x)));
    await gotoGate(page, "gate3");
    let checked = 0;
    for (const { r, t } of cases.slice(0, 10)) {
      await openRecord(page, r.groupId);
      const row = page.locator(`[data-testid="spec-row"][data-source="${t.sourceVariable}"]`);
      const editor = row.getByTestId("spec-mapping-editor");
      if (!(await editor.count())) continue;
      for (const [code, value] of Object.entries(t.codeMap as Record<string, string>)) {
        const chip = editor.locator(`[data-testid="spec-value-chip"][data-code="${code}"]`);
        if (!(await chip.count())) continue;
        const bucket = chip.locator("xpath=ancestor::*[@data-testid='spec-bucket'][1]");
        const id = (await bucket.getAttribute("data-bucket")) ?? "";
        const want = value === MISSING ? [MISSING] : targetNames(r, value);
        expect.soft(id, `${t.sourceVariable}: code ${code} → model says ${value}, editor shows bucket "${id}"`).not.toBe("");
        if (id && id !== MISSING && id !== DROP) {
          expect.soft(want.includes(id), `${t.sourceVariable}: code ${code} sits in "${id}", model: ${want.join("/")}`).toBe(true);
        }
        checked += 1;
      }
    }
    test.skip(checked === 0, "no source code chip matched a model code map entry");
  });

  test("I7: an edit made in the editor is saved in the target's codes", async ({ page, request }) => {
    onlyAt("gate3");
    const records: Rec[] = (await checkpoint(request)).result?.records ?? [];
    const decided = new Set(((await artifacts(request)).gate3_spec_edit ?? []).map((d: any) => d.sourceVariable));
    // A GenCDE target whose codes differ from its labels — the case where saving labels corrupts the column.
    const target = records
      .flatMap((r) => (r.transforms ?? []).map((t: any) => ({ r, t })))
      .find(
        ({ r, t }) =>
          t.kind === "categorical" &&
          gencdeTarget(r, t) &&
          !decided.has(t.sourceVariable) &&
          (r.gencde?.permissibleValues ?? []).some((v: any) => String(v.code) !== String(v.label)),
      );
    test.skip(!target, "no GenCDE-targeted categorical spec with code ≠ label to edit");
    const { r, t } = target!;
    await gotoGate(page, "gate3");
    await openRecord(page, r.groupId);
    const row = page.locator(`[data-testid="spec-row"][data-source="${t.sourceVariable}"]`);
    const editor = row.getByTestId("spec-mapping-editor");
    await expect(editor).toBeVisible();
    const chip = editor.getByTestId("spec-value-chip").first();
    const code = (await chip.getAttribute("data-code")) ?? "";
    const from = (await chip.locator("xpath=ancestor::*[@data-testid='spec-bucket'][1]").getAttribute("data-bucket")) ?? "";
    // A TARGET bucket other than the chip's own, for a value whose code differs from its label — the only case
    // where saving the label instead of the code corrupts the column (never the missing / drop conventions).
    const differing = new Set(
      (r.gencde?.permissibleValues ?? [])
        .filter((v: any) => String(v.code) !== String(v.label))
        .flatMap((v: any) => [String(v.code), String(v.label)]),
    );
    const buckets = editor.getByTestId("spec-bucket");
    let dest = "";
    for (let i = 0; i < (await buckets.count()); i++) {
      const id = (await buckets.nth(i).getAttribute("data-bucket")) ?? "";
      if (id && id !== from && id !== MISSING && id !== DROP && differing.has(id)) {
        dest = id;
        break;
      }
    }
    test.skip(!dest, "the editor offers no second target value");
    const saved = page.waitForResponse((res) => res.url().includes("/artifacts/gate3_spec_edit") && res.request().method() === "PUT");
    await chip.dragTo(editor.locator(`[data-testid="spec-bucket"][data-bucket="${dest}"]`));
    expect((await saved).ok(), "the edit was stored").toBe(true);

    const stored = ((await artifacts(request)).gate3_spec_edit ?? []).find((d: any) => d.sourceVariable === t.sourceVariable);
    const mapping: Record<string, string> = stored?.mapping ?? {};
    const codes = new Set((r.gencde?.permissibleValues ?? []).map((v: any) => String(v.code)));
    const bad = Object.entries(mapping).filter(([, v]) => v && v !== MISSING && v !== DROP && !codes.has(String(v)));
    expect(bad, `saved mapping ${JSON.stringify(mapping)} must use target codes ${JSON.stringify([...codes])}`).toEqual([]);
    expect(mapping[code], `the moved code ${code} landed on the chosen value`).toBeTruthy();
  });
});
