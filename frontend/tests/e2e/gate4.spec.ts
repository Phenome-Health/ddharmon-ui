import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import type { DecisionIndex } from "@/lib/gate-decisions";
import type { HarmonizationResult } from "@/types";
import {
  NOT_AVAILABLE_GAPS,
  REAL_ARTIFACTS,
  SUBSTANTIVE_EDIT_KINDS,
  decisionLogRows,
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
    gate3_spec_edit: { v1: { chosen: "edited", alternatives: [], optionSetKey: "y", sourceVariable: "v1" } },
    gate1_rename: { g2: { chosen: "My label", alternatives: [], optionSetKey: "z", groupId: "g2" } },
  };
  const result = { records: [{ groupId: "g0" }, { groupId: "g1" }, { groupId: "g2" }, { groupId: "g3" }] } as unknown as HarmonizationResult;
  const rr = revisionRate(index, result, "1.2.0");
  // Two substantive edits (candidate pick + spec edit); the rename is excluded as cosmetic.
  expect(rr.edited).toBe(2);
  expect(rr.excludedCosmetic).toBe(1);
  expect(rr.shown).toBe(4);
  expect(rr.denominator).toBe("concept records reviewed");
  expect(rr.hygieneVersion).toBe("1.2.0");
  // The rename kind is NOT counted as a substantive edit.
  expect(SUBSTANTIVE_EDIT_KINDS).not.toContain("gate1_rename");
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
