import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { indexDecisions, type DecisionIndex, type GroupedDecisions } from "@/lib/gate-decisions";
import type { HarmonizationResult } from "@/types";
import {
  NOT_AVAILABLE_GAPS,
  REAL_ARTIFACTS,
  SUBSTANTIVE_EDIT_KINDS,
  decisionLogCsvRows,
  decisionLogRows,
  scopeSummary,
  downloadLabel,
  previewFor,
  resolveFormat,
  revisionRate,
  verdictBreakdown,
} from "@/lib/gate4";
import { FINISHED_JOB, finishedFixture, serveFinished } from "./gate23-fixture";

/**
 * Gate 4 — Export — the terminal screen (08-17, STGD-15/R15).
 *
 *   run: npm run test:e2e -- --grep "@gate4"
 *
 * WHAT THIS SUITE CAN SEE, stated up front: it runs against a STATIC (backend-less) build. `serveFinished`
 * serves the finished demo for every `/result` fetch; the decision log reads the browser SANDBOX (there is
 * no artifact store), which is why the "log lists a decision" test seeds `sessionStorage` rather than a
 * server row. The failed-artifact-vs-not-available distinction and the no-new-backend-endpoint guarantee are
 * asserted from source, the same way `gate-components.spec.ts` asserts statically-decidable properties.
 */

const GATE4 = `/run/${FINISHED_JOB}/gate4`;
const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "../../src");
const read = (rel: string) => readFileSync(resolve(SRC, rel), "utf8");

async function gotoGate4(page: Page): Promise<void> {
  await page.goto(GATE4);
  await page.waitForLoadState("networkidle");
}

// --- pure logic (no page) -----------------------------------------------------------------------------

test("@gate4 the download label is singular for one and carries the count above one", () => {
  expect(downloadLabel(0)).toBe("Download 0 artifacts");
  expect(downloadLabel(1)).toBe("Download 1 artifact");
  expect(downloadLabel(4)).toBe("Download 4 artifacts");
});

test("@gate4 the export catalog covers EXACTLY the five shipping formats", () => {
  // Four tiles, because the two notebook formats collapse behind the language toggle.
  expect(REAL_ARTIFACTS).toHaveLength(4);
  const formats = new Set([
    ...REAL_ARTIFACTS.map((a) => resolveFormat(a.id, "py")),
    ...REAL_ARTIFACTS.map((a) => resolveFormat(a.id, "r")),
  ]);
  expect([...formats].sort()).toEqual(
    ["decisions_csv", "eitl_tsv", "notebook_py", "notebook_r", "records_json"].sort(),
  );
  // The three gaps are stated, never omitted.
  expect(NOT_AVAILABLE_GAPS.map((g) => g.slug).sort()).toEqual(
    ["composite-notebook", "mapping-table", "run-report"].sort(),
  );
});

test("@gate4 the revision rate excludes cosmetic renames (P5) and stamps its denominator (P2)", () => {
  const index: DecisionIndex = {
    gate2_candidate_pick: { g0: { chosen: "CDE:1", alternatives: ["CDE:1"], optionSetKey: "x", groupId: "g0" } },
    gate3_spec_edit: {
      "A:v1": { chosen: "A:v1", alternatives: [], optionSetKey: "y", sourceVariable: "A:v1", mapping: { "1": "No" } },
    },
    gate1_rename: { g2: { chosen: "My label", alternatives: [], optionSetKey: "z", groupId: "g2" } },
  };
  const result = {
    records: [
      { groupId: "g0", members: ["A:v0"], candidates: [] },
      { groupId: "g1", members: ["A:v1"], candidates: [] },
      { groupId: "g2", members: [], candidates: [] },
      { groupId: "g3", members: [], candidates: [] },
    ],
  } as unknown as HarmonizationResult;
  const rr = revisionRate(index, result, "1.2.0");
  // Two substantive edits (candidate pick on g0 + spec edit on g1's variable); the rename is excluded as cosmetic.
  expect(rr.edited).toBe(2);
  expect(rr.excludedCosmetic).toBe(1);
  expect(rr.shown).toBe(4);
  expect(rr.denominator).toBe("concept records reviewed");
  expect(rr.hygieneVersion).toBe("1.2.0");
  expect(SUBSTANTIVE_EDIT_KINDS).not.toContain("gate1_rename");
});

test("@gate4 the revision rate counts RECORDS, skips no-op decisions, and uses the frozen scope (08-27 audit)", () => {
  // Live 573cf61f read 15/20 when the truth was ~7/20: identity keys mixed variable ids, group ids and score
  // names; empty-note saves and back-to-the-model picks counted as corrections.
  const pick = (groupId: string, chosen: string, extra = {}) => ({ groupId, chosen, alternatives: [], optionSetKey: "k", ...extra });
  const spec = (sv: string, extra = {}) => ({ sourceVariable: sv, chosen: sv, alternatives: [], optionSetKey: "k", ...extra });
  const index: DecisionIndex = {
    gate2_candidate_pick: {
      g0: pick("g0", "CDE:model"), // equals the model's pick -> not an edit
      g1: pick("g1", "CDE:other"), // a real re-pick
      g3: pick("g3", "", { gencdeEdit: { definition: "x" } }), // a GenCDE edit -> an edit
    },
    gate3_spec_edit: {
      "A:a": spec("A:a", { note: "" }), // empty note only -> not an edit
      "A:b": spec("A:b", { mapping: { "1": "No" } }), // g1 again -> same record, counted once
      "A:c": spec("A:c", { rejected: true, chosen: "" }), // g2
    },
    gate1_regroup: {
      "A:d": { memberId: "A:d", chosen: "__unassigned__", fromGroupId: "g4", alternatives: [], optionSetKey: "k" },
    },
    composite_swap: { "S|c": { scoreName: "S", componentName: "c", chosen: "", alternatives: [], optionSetKey: "k" } },
  };
  const rec = (groupId: string, members: string[], model = "") => ({
    groupId,
    members,
    candidates: model ? [{ cdeId: model, isChosen: true }] : [],
  });
  const result = {
    records: [rec("g0", ["A:a"], "CDE:model"), rec("g1", ["A:b"], "CDE:model"), rec("g2", ["A:c"]), rec("g3", []), rec("g4", ["A:d"]), rec("g5", [])],
  } as unknown as HarmonizationResult;
  const rr = revisionRate(index, result, "1", { gate1_scope: ["g0", "g1", "g2", "g3", "g4"] });
  expect(rr.shown).toBe(5); // g5 was not in the frozen scope
  expect(rr.edited).toBe(4); // g1, g2, g3, g4 — never g0 (no-op pick, empty note) nor the composite
  expect(rr.rate).toBeLessThanOrEqual(1);
});

test("@gate4 the decision log enumerates every kind and marks nothing stale without an upstream", () => {
  const index: DecisionIndex = {
    gate1_rename: { g0: { chosen: "Blood pressure", alternatives: [], optionSetKey: "a", groupId: "g0" } },
    gate2_candidate_pick: { g1: { chosen: "CDE:42", alternatives: ["CDE:42"], optionSetKey: "b", groupId: "g1" } },
  };
  const rows = decisionLogRows(index);
  expect(rows).toHaveLength(2);
  expect(rows.find((r) => r.kind === "gate1_rename")?.gate).toBe("Gate 1");
  expect(rows.find((r) => r.kind === "gate2_candidate_pick")?.chosen).toBe("CDE:42");
  expect(rows.every((r) => r.stale === false)).toBe(true);
});

test("@gate4 the decision log says WHAT each decision did, by name, with scope collapsed (08-27 audit)", () => {
  const d = (extra: Record<string, unknown>) => ({ alternatives: [], optionSetKey: "k", ...extra });
  const index: DecisionIndex = {
    gate1_group_scope: { g0: d({ groupId: "g0", chosen: "in" }), g1: d({ groupId: "g1", chosen: "out" }), g2: d({ groupId: "g2", chosen: "out" }) },
    gate1_regroup: { "A:x": d({ memberId: "A:x", chosen: "__unassigned__", fromGroupId: "g0" }) },
    gate1_rename: { g0: d({ groupId: "g0", chosen: "Smoked 100", generatedName: "Tobacco use" }) },
    gate2_candidate_pick: {
      g0: d({ groupId: "g0", chosen: "Reviewer CDE" }),
      g1: d({ groupId: "g1", chosen: "", gencdeEdit: { definition: "mine" } }),
    },
    gate3_spec_edit: { "A:y": d({ sourceVariable: "A:y", chosen: "", rejected: true, note: "wrong target" }) },
    composite_swap: { "S|grip": d({ scoreName: "S", componentName: "grip", chosen: "" }) },
  };
  const result = {
    records: [
      { groupId: "g0", concept: "Tobacco use", members: ["A:y"], candidates: [{ cdeId: "Model CDE", isChosen: true }, { cdeId: "Reviewer CDE" }] },
      { groupId: "g1", concept: "Vaping", members: [], candidates: [] },
    ],
  } as unknown as HarmonizationResult;
  const rows = decisionLogRows(index, result);
  expect(rows.some((r) => r.kind === "gate1_group_scope")).toBe(false); // collapsed, not 3 rows
  expect(scopeSummary(index)).toEqual({ in: 1, out: 2 });
  const by = (k: string) => rows.find((r) => r.kind === k)!;
  expect(by("gate1_regroup").detail).toBe("from Smoked 100 to no group"); // the reviewer's name wins
  expect(by("gate1_rename").detail).toBe("“Tobacco use” → “Smoked 100”");
  const picks = rows.filter((r) => r.kind === "gate2_candidate_pick");
  expect(picks.find((r) => r.thing === "g0")!.label).toBe("Smoked 100");
  expect(picks.find((r) => r.thing === "g1")!.label).toBe("Vaping");
  expect(picks.find((r) => r.thing === "g0")!.detail).toBe("Reviewer CDE (model picked Model CDE)");
  expect(picks.find((r) => r.thing === "g1")!.detail).toBe("your own CDE, edited");
  expect(by("gate3_spec_edit").detail).toBe("rejected · note: “wrong target”");
  expect(by("composite_swap").action).toBe("Declared a score component");
});

test("@gate4 a preview is REAL generated content, not a description", () => {
  const run = finishedFixture().result as HarmonizationResult;
  const recordsJson = previewFor("records_json", "py", run, {});
  // A description would not be parseable JSON carrying the real record fields.
  const parsed = JSON.parse(recordsJson) as Array<{ id: string; verdict: string }>;
  expect(parsed.length).toBeGreaterThan(0);
  expect(parsed[0]).toHaveProperty("verdict");
  expect(parsed[0].id).toBe(run.records[0].id);
  // The notebook preview reflects the chosen language.
  expect(previewFor("notebook", "r", run, {})).toContain("(R)");
  expect(previewFor("notebook", "py", run, {})).toContain("(Python)");
});

// --- 08-27: the decision-log CSV preview reads what the download carries ---------------------------------

/**
 * The PARITY fixture is pinned by BOTH sides: `tests/test_export_staged.py` asserts the backend's
 * `decision_log_rows` produces `expectedRows`, and this asserts the client's `decisionLogCsvRows` does too —
 * so the Gate 4 preview of the log cannot drift from the file the download serves.
 */
const PARITY = JSON.parse(readFileSync(resolve(HERE, "fixtures/decision-log-parity.json"), "utf8")) as {
  result: HarmonizationResult;
  config: Record<string, unknown>;
  grouped: GroupedDecisions;
  legacyDecisions: Record<string, { decision?: string; note?: string }>;
  columns: string[];
  expectedRows: string[][];
};

test("@gate4 the decision-log CSV rows match the backend's, row for row", () => {
  const rows = decisionLogCsvRows(indexDecisions(PARITY.grouped), PARITY.result, PARITY.config, PARITY.legacyDecisions);
  expect(rows[0]).toEqual(PARITY.columns);
  expect(rows.slice(1)).toEqual(PARITY.expectedRows);
});

test("@gate4 the decision-log CSV preview on a staged run reads gate decisions, not legacy verdicts", () => {
  const index = indexDecisions(PARITY.grouped);
  const preview = previewFor("decisions_csv", "py", PARITY.result, PARITY.legacyDecisions, {
    index,
    config: PARITY.config,
    gatePosition: "gate4",
  });
  const lines = preview.split("\n");
  expect(lines[0]).toBe(PARITY.columns.join(","));
  expect(preview).toContain("gate1_rename");
  expect(preview).toContain("Participant âge");
  // A field carrying the separator is quoted, the way the downloaded CSV quotes it.
  expect(preview).toContain('"checked, ok"');
  // A legacy one-shot run (no gate position, no gate decisions) keeps the per-record verdict preview.
  const legacy = previewFor("decisions_csv", "py", PARITY.result, PARITY.legacyDecisions, {
    index: {},
    config: {},
    gatePosition: null,
  });
  expect(legacy.split("\n")[0]).toBe("record_id,concept,verdict,chosen_cde,your_decision,note");
});

test("@gate4 the verdict breakdown counts the real records", () => {
  const run = finishedFixture().result as HarmonizationResult;
  const b = verdictBreakdown(run);
  expect(b.total).toBe(run.records.length);
  expect(b.adopt + b.refine + b.novel).toBeLessThanOrEqual(b.total);
});

// --- DOM (static build) -------------------------------------------------------------------------------

test.describe("Gate 4 screen", () => {
  test.beforeEach(async ({ page }) => {
    await serveFinished(page);
  });

  test("@gate4 renders one tile per shipping format", async ({ page }) => {
    await gotoGate4(page);
    const tiles = page.getByTestId("artifact-tile");
    await expect(tiles).toHaveCount(REAL_ARTIFACTS.length);
    for (const a of REAL_ARTIFACTS) {
      await expect(page.locator(`[data-testid="artifact-tile"][data-thing="${a.id}"]`)).toBeVisible();
    }
  });

  test("@gate4 the three deferred gaps render as honest not-available tiles, never as errors", async ({ page }) => {
    await gotoGate4(page);
    const na = page.getByTestId("not-available");
    await expect(na).toHaveCount(NOT_AVAILABLE_GAPS.length);
    for (const g of NOT_AVAILABLE_GAPS) {
      const tile = page.locator(`[data-testid="not-available"][data-thing="${g.slug}"]`);
      await expect(tile).toBeVisible();
      await expect(tile).toHaveAttribute("data-claim", "deferred");
      // Not styled as an error: no destructive/danger colour anywhere in the tile.
      const cls = (await tile.getAttribute("class")) ?? "";
      expect(cls).not.toContain("status-danger");
      expect(cls).not.toContain("status-destructive");
    }
  });

  test("@gate4 a preview drawer opens real generated content", async ({ page }) => {
    await gotoGate4(page);
    await page.locator('[data-testid="artifact-tile"][data-thing="records_json"] [data-testid="artifact-preview"]').click();
    const content = page.getByTestId("artifact-preview-content");
    await expect(content).toBeVisible();
    // Real serialized content (JSON with the record fields), not a sentence describing the artifact.
    await expect(content).toContainText('"verdict"');
    await expect(content).toContainText("{");
  });

  test("@gate4 the download label reflects only ready artifacts and disables at zero", async ({ page }) => {
    await gotoGate4(page);
    const action = page.getByTestId("download-artifacts");
    await expect(action).toContainText(`Download ${REAL_ARTIFACTS.length} artifacts`);
    await expect(action).toBeEnabled();
    // Deselect every artifact → disabled, with the reason named.
    for (const a of REAL_ARTIFACTS) {
      await page.locator(`[data-testid="artifact-tile"][data-thing="${a.id}"] [data-testid="artifact-checkbox"]`).click();
    }
    await expect(action).toBeDisabled();
    await expect(
      page.getByTestId("gate-empty-state").filter({ hasText: "No artifacts selected" }),
    ).toBeVisible();
    // Re-select one → singular label, enabled.
    await page.locator(`[data-testid="artifact-tile"][data-thing="records_json"] [data-testid="artifact-checkbox"]`).click();
    await expect(action).toContainText("Download 1 artifact");
    await expect(action).toBeEnabled();
  });

  test("@gate4 both standing assurances are on screen", async ({ page }) => {
    await gotoGate4(page);
    await expect(page.getByTestId("commit-assurance")).toContainText(
      "Nothing here contains participant data. Every file is metadata, a decision, or code.",
    );
    await expect(page.getByText("The notebook runs where your data already lives. Your data never enters ddharmon.")).toBeVisible();
  });

  test("@gate4 the decision log lists a decision made earlier in the walk", async ({ page }) => {
    await page.addInitScript(
      ([jobId]) => {
        sessionStorage.setItem(
          `ddharmon.sandbox.${jobId}`,
          JSON.stringify({
            gateDecisions: {
              gate2_candidate_pick: {
                "seed-group": { groupId: "seed-group", chosen: "CDE:99999", alternatives: ["CDE:99999", "CDE:11111"], optionSetKey: "seed" },
              },
            },
          }),
        );
      },
      [FINISHED_JOB],
    );
    await gotoGate4(page);
    const log = page.getByTestId("decision-log");
    await expect(log).toBeVisible();
    const row = page.locator('[data-testid="decision-row"][data-kind="gate2_candidate_pick"]');
    await expect(row).toContainText("Gate 2");
    await expect(row).toContainText("CDE:99999");
    // The E3 revision rate is rendered, denominator-stamped (P2), never a bare number.
    await expect(page.getByTestId("revision-rate")).toHaveAttribute("data-denominator", "concept records reviewed");
    await expect(page.getByTestId("revision-rate")).toContainText("concept records reviewed");
  });

  test("@gate4 the decision-log CSV preview shows the gate decisions the download carries", async ({ page }) => {
    await page.addInitScript(
      ([jobId]) => {
        sessionStorage.setItem(
          `ddharmon.sandbox.${jobId}`,
          JSON.stringify({
            gateDecisions: {
              gate1_rename: {
                "seed-group": { groupId: "seed-group", chosen: "My name", alternatives: ["Gen", "My name"], optionSetKey: "s", generatedName: "Gen" },
              },
            },
          }),
        );
      },
      [FINISHED_JOB],
    );
    await gotoGate4(page);
    await page.locator('[data-testid="artifact-tile"][data-thing="decisions_csv"] [data-testid="artifact-preview"]').click();
    const content = page.getByTestId("artifact-preview-content");
    await expect(content).toContainText("gate,kind,action,item,before,after,note,detail,stale");
    await expect(content).toContainText("Gate 1,gate1_rename,Renamed a group,seed-group,Gen,My name");
    // Not the legacy per-record verdict header, which no gate writes to.
    await expect(content).not.toContainText("your_decision");
  });

  test("@gate4 a run with no decisions shows the log's empty state rather than a blank panel", async ({ page }) => {
    await gotoGate4(page);
    const log = page.getByTestId("decision-log");
    await expect(log).toBeVisible();
    await expect(log.getByTestId("gate-empty-state")).toContainText("No decisions recorded yet");
    await expect(page.getByTestId("revision-rate")).toHaveCount(0);
  });

  test("@gate4 the notebook language toggle changes the notebook filename", async ({ page }) => {
    await gotoGate4(page);
    const notebookTile = page.locator('[data-testid="artifact-tile"][data-thing="notebook"]');
    await expect(notebookTile.getByTestId("artifact-filename")).toContainText("harmonization.py.ipynb");
    await page.getByTestId("notebook-lang-r").click();
    await expect(notebookTile.getByTestId("artifact-filename")).toContainText("harmonization.r.ipynb");
  });

  test("@gate4 the export set states its two limitations rather than hiding them", async ({ page }) => {
    await gotoGate4(page);
    const limits = page.getByTestId("export-limitations");
    await expect(limits).toContainText("per format");
    await expect(limits).toContainText("by hand");
  });

  test("@gate4 the no-concept population is surfaced, never silently omitted", async ({ page }) => {
    // Give the served run some unassigned fields so the summary must render them.
    await serveFinished(page, (run) => {
      if (run.result) run.result.unassignedFields = [{ cohort: "AoU", variable: "x1", text: "an orphan variable" }];
    });
    await gotoGate4(page);
    await expect(page.getByTestId("unassigned-summary")).toContainText("reached no concept");
  });

  test("@gate4 the terminal next-actions route to analysis ideas and a new run", async ({ page }) => {
    await gotoGate4(page);
    await expect(page.getByTestId("analysis-ideas-link")).toHaveAttribute("href", `/job/${FINISHED_JOB}/analysis`);
    await expect(page.getByTestId("rerun-action")).toHaveAttribute("href", "/run/new/setup");
  });
});

// --- source assertions (statically decidable) ---------------------------------------------------------

test("@gate4 a failed artifact tile is textually and visually distinct from a not-available tile", () => {
  const tile = read("components/gate/ArtifactTile.tsx");
  const na = read("components/gate/NotAvailable.tsx");
  // Failed: a defect — distinct testid, danger colour, and copy that says it is NOT an unoffered format.
  expect(tile).toContain('data-testid="artifact-failed"');
  expect(tile).toContain("text-status-danger");
  expect(tile).toContain("not a format we don't offer");
  // Not-available: a boundary — dashed neutral, a claim attribute, and NO destructive colour.
  expect(na).toContain("border-dashed");
  expect(na).toContain("data-claim");
  expect(na).not.toContain("status-danger");
  expect(na).not.toContain("status-destructive");
});

test("@gate4 the decision log adds no backend endpoint — it is a pure frontend read", () => {
  const log = read("components/gate/DecisionLog.tsx");
  const page = read("pages/run/gate4.tsx");
  // Neither the log nor the page opens a new fetch/route; the log reads the hook's hydrated index only.
  expect(log).not.toContain("fetch(");
  expect(log).not.toMatch(/\/api\/harmonize/);
  expect(page).not.toMatch(/\/api\/harmonize\/jobs\/[^"]*\/(log|decision-log)/);
});
