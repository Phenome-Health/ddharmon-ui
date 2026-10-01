import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { indexDecisions, type DecisionIndex, type GroupedDecisions } from "@/lib/gate-decisions";
import type { HarmonizationResult } from "@/types";
import {
  DECISION_LOG_CSV_COLS,
  NOT_AVAILABLE_GAPS,
  REAL_ARTIFACTS,
  SUBSTANTIVE_EDIT_KINDS,
  decisionCount,
  decisionLogCsvRows,
  decisionLogEntryCount,
  decisionLogRows,
  modelRelation,
  scopeSummary,
  artifactPreview,
  downloadLabel,
  exportedRecords,
  previewFor,
  previewTable,
  resolveFormat,
  revisionRate,
  unassignedBreakdown,
  verdictBreakdown,
} from "@/lib/gate4";
import { buildSankeyData } from "@/lib/sankey";
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
  expect(by("composite_swap").action).toBe("Declared a score");
});

test("@gate4 the decision log lists a New group by its name, and a move into it names it too (08-28 Wave 2)", () => {
  const d = (extra: Record<string, unknown>) => ({ alternatives: [], optionSetKey: "k", ...extra });
  const rev = "rev:5b1f8d6e-2c3a-4f7b-9e0d-1a2b3c4d5e6f";
  const index: DecisionIndex = {
    gate1_new_group: { [rev]: d({ groupId: rev, chosen: "Eye conditions", name: "Eye conditions" }) },
    gate1_regroup: { "A:cat": d({ memberId: "A:cat", chosen: rev, fromGroupId: "g0" }) },
  };
  // No record carries the New group yet (the log is read at Gate 1 too): its name comes from the decision.
  const result = { records: [{ groupId: "g0", concept: "Glaucoma", members: [], candidates: [] }] } as unknown as HarmonizationResult;
  const rows = decisionLogRows(index, result);
  const made = rows.find((r) => r.kind === "gate1_new_group")!;
  expect(made.action).toBe("Created a group");
  expect(made.label).toBe("Eye conditions");
  expect(made.gate).toBe("Gate 1");
  expect(rows.find((r) => r.kind === "gate1_regroup")!.detail).toBe("from Glaucoma to Eye conditions");
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
  // A field carrying the separator is quoted, the way the downloaded CSV quotes it. (A Gate 2 relation note since
  // 3f: the fixture's relation rows moved the Gate 3 "checked, ok" row past the preview's 12-row cap.)
  expect(preview).toContain('"visit age, broader"');
  // A legacy one-shot run (no gate position, no gate decisions) keeps the per-record verdict preview.
  const legacy = previewFor("decisions_csv", "py", PARITY.result, PARITY.legacyDecisions, {
    index: {},
    config: {},
    gatePosition: null,
  });
  expect(legacy.split("\n")[0]).toBe("record_id,concept,verdict,chosen_cde,your_decision,note");
});

// --- final review round 2: the Sankey on Gate 4 draws the records the EXPORT carries -------------------------

/**
 * Pinned by BOTH sides: `tests/test_export_staged.py` asserts the backend's `effective_records` projects to each
 * case's `expected`, and this asserts the client's `exportedRecords` does too — so the chart Gate 4 draws cannot
 * show a flow the downloaded files do not carry.
 */
const EXPORTED = JSON.parse(readFileSync(resolve(HERE, "fixtures/exported-records-parity.json"), "utf8")) as {
  cases: {
    name: string;
    useParityDecisions?: boolean;
    config?: Record<string, unknown>;
    grouped?: GroupedDecisions;
    expected: { groupId: string; concept: string; verdict: string; cohorts: string[]; members: string[] }[];
  }[];
};

test("@gate4 review 2 — the exported records match the backend's effective records, case for case", () => {
  for (const c of EXPORTED.cases) {
    const config = c.useParityDecisions ? PARITY.config : (c.config ?? {});
    const index = indexDecisions(c.useParityDecisions ? PARITY.grouped : (c.grouped ?? {}));
    const got = exportedRecords(PARITY.result, config, index).map((r) => ({
      groupId: r.groupId,
      concept: r.concept,
      verdict: r.verdict,
      cohorts: r.cohorts,
      members: r.members,
    }));
    expect(got, c.name).toEqual(c.expected);
  }
  // Never the raw pipeline output: the input is not mutated, and the raw run carries the group the scope dropped.
  expect(PARITY.result.records.map((r) => r.groupId)).toContain("c2#g0");
  expect(PARITY.result.records.find((r) => r.groupId === "c0#g0")?.concept).toBe("Age in years");
});

test("@gate4 review 2 — the Sankey's flows are the exported records': a scoped-out novel group draws no Novel flow", () => {
  const exported = exportedRecords(PARITY.result, PARITY.config, indexDecisions(PARITY.grouped));
  const data = buildSankeyData(exported);
  const names = data.nodes.map((n) => n.name);
  // c2 (the only novel group) was scoped out at Gate 1, and c3's applied re-pick took it from novel to adopt.
  expect(names).toEqual(["A", "B", "Adopt", "Refine", "Existing CDE"]);
  const flow = (from: string, to: string) =>
    data.links.find((l) => names[l.source] === from && names[l.target] === to)?.value ?? 0;
  expect(flow("A", "Adopt")).toBe(2); // A:age, A:dm
  expect(flow("B", "Adopt")).toBe(2); // B:age_yrs, B:dm
  expect(flow("A", "Refine")).toBe(1);
  expect(flow("Adopt", "Existing CDE")).toBe(4);
  expect(flow("Refine", "Existing CDE")).toBe(2);
  // The raw run would have drawn the scoped-out group.
  expect(buildSankeyData(PARITY.result.records).nodes.map((n) => n.name)).toContain("Novel");
});

// --- final review round 2: CSV / TSV previews render as a table, parsed by a real CSV parser -----------------

test("@gate4 review 2 — the table parser keeps a quoted field with a comma and a newline as ONE cell", () => {
  const { columns, rows } = previewTable('gate,note\nGate 3,"line one, with a comma\nline two"\nGate 1,""\n', ",");
  expect(columns).toEqual(["gate", "note"]);
  expect(rows).toEqual([
    ["Gate 3", "line one, with a comma\nline two"],
    ["Gate 1", ""],
  ]);
  expect(previewTable("a\tb\n1\t2\n", "\t")).toEqual({ columns: ["a", "b"], rows: [["1", "2"]] });
});

test("@gate4 review 2 — the decision-log preview's TABLE is the backend's rows, cell for cell", () => {
  const index = indexDecisions(PARITY.grouped);
  const preview = artifactPreview("decisions_csv", "py", PARITY.result, PARITY.legacyDecisions, {
    index,
    config: PARITY.config,
    gatePosition: "gate4",
  });
  expect(preview.kind).toBe("table");
  if (preview.kind !== "table") return;
  const { columns, rows } = previewTable(preview.text, preview.delimiter);
  expect(columns).toEqual(PARITY.columns);
  // The cap is unchanged (12 decisions); every cell — quoted notes included — survives the round trip.
  expect(rows).toEqual(PARITY.expectedRows.slice(0, 12));
  expect(preview.note).toBe(`… ${PARITY.expectedRows.length - 12} more decision(s) in the file`);
});

test("@gate4 review 2 — a note with a comma stays one cell of the decision-log table (a newline is flattened, as the file does)", () => {
  const d = (extra: Record<string, unknown>) => ({ alternatives: [], optionSetKey: "k", ...extra });
  const index: DecisionIndex = {
    gate3_spec_edit: { "A:y": d({ sourceVariable: "A:y", chosen: "", rejected: true, note: "wrong target,\nsee codebook" }) },
  };
  const preview = artifactPreview("decisions_csv", "py", PARITY.result, {}, { index, config: {}, gatePosition: "gate4" });
  if (preview.kind !== "table") throw new Error("expected a table");
  const { columns, rows } = previewTable(preview.text, preview.delimiter);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toHaveLength(columns.length);
  // The downloaded log writes every cell on one line (`clean` in both implementations), so the file — and its
  // preview — carries the note's newline as a space; its comma is what the quoting has to survive.
  expect(rows[0][columns.indexOf("note")]).toBe("wrong target, see codebook");
});

test("@gate4 review 2 — a legacy CSV / TSV preview quotes a concept with a comma, so every row keeps its columns", () => {
  const run = finishedFixture().result as HarmonizationResult;
  // The shipped demo's own concepts carry commas ("… (marijuana, cocaine, prescription stimulants, …)").
  expect(run.records.slice(0, 3).some((r) => r.concept.includes(","))).toBe(true);
  const legacy = { index: {}, config: {}, gatePosition: null };
  for (const id of ["decisions_csv", "eitl_tsv"] as const) {
    const preview = artifactPreview(id, "py", run, {}, legacy);
    if (preview.kind !== "table") throw new Error(`expected ${id} to preview as a table`);
    expect(preview.delimiter).toBe(id === "eitl_tsv" ? "\t" : ",");
    const { columns, rows } = previewTable(preview.text, preview.delimiter);
    expect(rows).toHaveLength(3);
    for (const [i, row] of rows.entries()) {
      expect(row, `${id} row ${i}`).toHaveLength(columns.length);
      expect(row[columns.indexOf("concept")]).toBe(run.records[i].concept);
    }
    // The cap is stated, not silent.
    expect(preview.note).toBe(`The first 3 of ${run.records.length} concepts — the file carries every one.`);
  }
});

test("@gate4 review 2 — JSON and the notebook stay code; an empty run says so instead of drawing an empty table", () => {
  const run = finishedFixture().result as HarmonizationResult;
  const json = artifactPreview("records_json", "py", run, {});
  expect(json.kind).toBe("code");
  expect(JSON.parse(json.text)).toHaveLength(3);
  expect(artifactPreview("notebook", "r", run, {}).kind).toBe("code");
  const empty = artifactPreview("eitl_tsv", "py", { ...run, records: [] }, {});
  expect(empty.kind).toBe("empty");
  // `previewFor` is the same content flattened to one string (the file's text, then its note).
  const table = artifactPreview("eitl_tsv", "py", run, {});
  expect(previewFor("eitl_tsv", "py", run, {})).toBe(`${table.text}\n${table.kind === "table" ? table.note : ""}`);
});

// --- 08-28 1e: provenance & the decision log (08-LIVE-VERIFY-3 F7 F17 F21 H9) ------------------------------

const dd = (extra: Record<string, unknown>) => ({ alternatives: [], optionSetKey: "k", ...extra });

/**
 * A record the Gate 2 -> 3 leg RE-TARGETED (`apply_reviewer_picks`): its candidates / cde already name the
 * reviewer's pick, so the model's own survives only on the `reviewerPick` stamp.
 */
const REPICKED = {
  groupId: "g1",
  concept: "Diabetes",
  verdict: "adopt",
  members: ["A:dm"],
  cde: { id: "CDE:pick", externalId: "" },
  gencde: null,
  candidates: [{ cdeId: "CDE:pick", isChosen: true }],
  reviewerPick: {
    chosen: "CDE:pick", kind: "catalog", target: "CDE:pick", modelTarget: "GEN:g1", reason: "",
    modelCde: null, modelVerdict: "novel", modelGencde: { gencdeId: "GEN:g1" },
  },
};

test("@gate4 an APPLIED re-pick counts as an edit and names the model's own pick (F17)", () => {
  const index: DecisionIndex = {
    gate2_candidate_pick: {
      g1: dd({ groupId: "g1", chosen: "CDE:pick" }),
      g2: dd({ groupId: "g2", chosen: "" }), // a novel group keeping its own generated element: not an edit
    },
  };
  const result = {
    records: [REPICKED, { groupId: "g2", concept: "Hair", members: [], candidates: [], gencde: { gencdeId: "GEN:g2" } }],
  } as unknown as HarmonizationResult;
  // Live 6c66731c read "1 of 8" when the truth was 2 of 8: the re-targeted record's own isChosen IS the pick.
  expect(revisionRate(index, result, "1").edited).toBe(1);
  const rows = decisionLogRows(index, result);
  expect(rows.find((r) => r.thing === "g1")!.detail).toBe("CDE:pick (model picked GEN:g1)");
});

test("@gate4 the in-app log: an empty Gate 3 save is the model's spec, a value map diffs per code, a score is one row (F7 Q3 H9)", () => {
  const index: DecisionIndex = {
    gate3_spec_edit: {
      "U:a": dd({ sourceVariable: "U:a", chosen: "U:a", note: "" }),
      "U:b": dd({ sourceVariable: "U:b", chosen: "U:b", mapping: { "1": "1", "-121": "__missing__" } }),
    },
    composite_swap: {
      "Frailty|grip": dd({ scoreName: "Frailty", componentName: "grip", chosen: "" }),
      "Frailty|gait": dd({ scoreName: "Frailty", componentName: "gait", chosen: "" }),
      "PHQ|mood": dd({ scoreName: "PHQ", componentName: "mood", chosen: "" }),
    },
  };
  const result = {
    records: [
      {
        groupId: "g0", concept: "Migraine", members: ["U:a", "U:b"], candidates: [],
        transforms: [
          { sourceVariable: "U:a", kind: "categorical", codeMap: { "1": "1" } },
          { sourceVariable: "U:b", kind: "categorical", codeMap: { "1": "1", "-121": "9" } },
        ],
      },
    ],
  } as unknown as HarmonizationResult;
  const rows = decisionLogRows(index, result);
  expect(rows.find((r) => r.thing === "U:a")!.detail).toBe("reverted to model spec");
  expect(rows.find((r) => r.thing === "U:b")!.detail).toBe("value map: -121: 9 → missing");
  const scores = rows.filter((r) => r.kind === "composite_swap");
  expect(scores.map((r) => r.thing)).toEqual(["Frailty", "PHQ"]); // not one row per component
  expect(scores[0].action).toBe("Declared a score");
  expect(scores[0].detail).toBe("2 components: grip, gait");
});

test("@gate4 the decision count is the number of entries the downloaded log carries (F21)", () => {
  const index = indexDecisions(PARITY.grouped);
  const n = decisionLogEntryCount(index, PARITY.result, PARITY.config, PARITY.legacyDecisions);
  expect(n).toBe(PARITY.expectedRows.length);
  // The raw decision count read "61 decisions" beside a 62-row file: it misses the frozen-scope row and counts
  // every declared component.
  expect(decisionCount(index)).not.toBe(n);
});

test("@gate4 variables scoped out at Gate 1 are counted apart from those that reached no concept (F21)", () => {
  const result = {
    records: [{ groupId: "g0", members: ["A:in"], candidates: [] }],
    conceptGroups: [
      { groupId: "g0", memberVariableNames: ["A:in"] },
      { groupId: "g9", memberVariableNames: ["A:out1"] }, // a collapsed sample: the uncapped list wins
      { groupId: "g8", memberVariableNames: ["A:out3"] }, // no uncapped list: the sample is all there is
    ],
    conceptGroupMembers: { g0: ["A:in", "A:dropped"], g9: ["A:out1", "A:out2"] },
    unassignedFields: ["out1", "out2", "out3", "orphan", "dropped"].map((v) => ({ cohort: "A", variable: v, text: "" })),
  } as unknown as HarmonizationResult;
  // Live 6c66731c: "506 variables reached no concept" — 497 of them were scoped OUT at Gate 1.
  expect(unassignedBreakdown(result, { gate1_scope: ["g0"] }, {})).toEqual({ scopedOut: 3, noConcept: 2 });
  // No frozen scope: the legacy rule — only an explicit "out" scopes a group out.
  expect(unassignedBreakdown(result, {}, { g9: { chosen: "out" } })).toEqual({ scopedOut: 2, noConcept: 3 });
  expect(unassignedBreakdown(result, {}, {})).toEqual({ scopedOut: 0, noConcept: 5 });
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

  test("@gate4 the preview drawer's close X is drawn against the drawer, not inherited from the chrome (review 2)", async ({
    page,
  }) => {
    // Bhargav, final review round 2: "the close X on the preview sidebar is not rendering properly". The drawer
    // is portalled to <body>, whose text colour is the navy CHROME's white — so an X with no colour of its own
    // was drawn white on the white drawer, and all that showed was its focus outline: an empty box.
    await gotoGate4(page);
    await page.locator('[data-testid="artifact-tile"][data-thing="records_json"] [data-testid="artifact-preview"]').click();
    const dialog = page.getByRole("dialog");
    const close = dialog.getByRole("button", { name: "Close" });
    await expect(close).toBeVisible();
    const { ratio, icon, button, drawer } = await close.evaluate((btn) => {
      // Normalise any computed colour (rgb, color(srgb …), oklch …) through a canvas, painted OVER the colour
      // beneath it — the X's role is translucent, so its own channels alone would overstate the contrast.
      const ctx = document.createElement("canvas").getContext("2d")!;
      const rgb = (css: string, under = "#fff") => {
        ctx.fillStyle = under;
        ctx.fillRect(0, 0, 1, 1);
        ctx.fillStyle = css;
        ctx.fillRect(0, 0, 1, 1);
        const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
        return [r, g, b];
      };
      const lum = ([r, g, b]: number[]) => {
        const ch = (x: number) => {
          const s = x / 255;
          return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
        };
        return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
      };
      const svg = btn.querySelector("svg")!;
      const dlg = btn.closest('[role="dialog"]')!;
      const bg = getComputedStyle(dlg).backgroundColor;
      const a = lum(rgb(getComputedStyle(svg).color, bg));
      const b = lum(rgb(bg));
      const box = (el: Element) => {
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      };
      return {
        ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
        icon: box(svg),
        button: box(btn),
        drawer: box(dlg),
      };
    });
    // A control's glyph is non-text UI: WCAG 1.4.11 asks 3:1 against what it sits on.
    expect(ratio, "the close X must be visible against the drawer").toBeGreaterThanOrEqual(3);
    expect(icon.w).toBeGreaterThan(0);
    // Inside the drawer, at its top right, and a target a pointer can actually hit.
    expect(button.x + button.w).toBeLessThanOrEqual(drawer.x + drawer.w);
    expect(button.x).toBeGreaterThan(drawer.x + drawer.w / 2);
    expect(button.y).toBeGreaterThanOrEqual(drawer.y);
    expect(button.w).toBeGreaterThanOrEqual(24);
    expect(button.h).toBeGreaterThanOrEqual(24);
    await close.click();
    await expect(dialog).toHaveCount(0);
  });

  test("@gate4 review 2 — Gate 4 draws the run's Sankey from the records the export carries, not the raw run", async ({
    page,
  }) => {
    // Bhargav, review round 2: the run view's Sankey was only reachable by accident (analysis ideas -> back), so it
    // is surfaced here. It must draw what LEAVES THE TOOL: freeze the scope to five of the served twelve groups.
    let kept = 0;
    let variables = 0;
    await serveFinished(page, (run) => {
      const recs = run.result?.records ?? [];
      const inScope = recs.slice(0, 5);
      run.config = { ...(run.config ?? {}), gate1_scope: inScope.map((r) => r.groupId) };
      kept = inScope.length;
      variables = inScope.reduce((n, r) => n + (r.members.length || r.cohorts.length), 0);
    });
    await gotoGate4(page);
    const flows = page.getByTestId("gate4-sankey");
    await expect(flows).toBeVisible();
    await expect(flows).toHaveAttribute("data-concepts", String(kept));
    await expect(flows).toHaveAttribute("data-variables", String(variables));
    await expect(flows).toContainText(`${kept} concepts`);
    // The existing chart, drawn: recharts' surface with one path per flow. (A path is not asserted `visible`: a
    // flow that runs dead level has a zero-height box, which Playwright calls hidden.)
    await expect(flows.locator(".recharts-surface")).toBeVisible();
    expect(await flows.locator(".recharts-surface path").count()).toBeGreaterThan(0);
    // It sits above the export set — surfaced, not buried under the decision log.
    const [chartY, exportY] = await Promise.all([
      flows.evaluate((el) => el.getBoundingClientRect().top),
      page.getByTestId("export-set").evaluate((el) => el.getBoundingClientRect().top),
    ]);
    expect(chartY).toBeLessThan(exportY);
  });

  test("@gate4 review 2 — with nothing in the export, the Sankey says so instead of drawing an empty chart", async ({
    page,
  }) => {
    await serveFinished(page, (run) => {
      run.config = { ...(run.config ?? {}), gate1_scope: [] };
    });
    await gotoGate4(page);
    const flows = page.getByTestId("gate4-sankey");
    await expect(flows).toHaveAttribute("data-concepts", "0");
    await expect(flows.getByTestId("gate4-sankey-empty")).toContainText("Nothing is in this export");
    await expect(flows.locator(".recharts-surface")).toHaveCount(0);
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
    // Review 2: a TABLE of the file's cells, not its raw comma-joined text.
    const table = page.getByTestId("artifact-preview-table");
    await expect(table.locator("thead th")).toHaveText(DECISION_LOG_CSV_COLS);
    const row = table.locator("tbody tr").filter({ hasText: "gate1_rename" });
    await expect(row.locator("td")).toHaveText(["Gate 1", "gate1_rename", "Renamed a group", "seed-group", "Gen", "My name", "", "", "false"]);
    // Not the legacy per-record verdict header, which no gate writes to.
    await expect(page.getByTestId("artifact-preview-content")).not.toContainText("your_decision");
  });

  test("@gate4 review 2 — a CSV / TSV preview is a table: sticky header, aligned columns, sideways scroll inside the drawer", async ({
    page,
  }) => {
    await gotoGate4(page);
    await page.locator('[data-testid="artifact-tile"][data-thing="eitl_tsv"] [data-testid="artifact-preview"]').click();
    const content = page.getByTestId("artifact-preview-content");
    await expect(content).toHaveAttribute("data-kind", "table");
    const table = page.getByTestId("artifact-preview-table");
    await expect(table.locator("thead th")).toHaveText(["record_id", "concept", "verdict", "top_candidate", "n_members", "cohorts"]);
    // The row cap is today's (3 concepts), and it is stated under the table rather than left silent.
    const rows = table.locator("tbody tr");
    await expect(rows).toHaveCount(3);
    for (let i = 0; i < 3; i++) await expect(rows.nth(i).locator("td")).toHaveCount(6);
    await expect(page.getByTestId("artifact-preview-note")).toContainText(/^The first 3 of \d+ concepts/);
    const layout = await content.evaluate((el) => {
      const th = el.querySelector("thead th")!;
      const dialog = el.closest('[role="dialog"]')!;
      return {
        sticky: getComputedStyle(th).position,
        overflowX: getComputedStyle(el).overflowX,
        dialogScrolls: dialog.scrollWidth - dialog.clientWidth,
      };
    });
    expect(layout.sticky).toBe("sticky");
    // A wide file scrolls INSIDE its own box; the drawer itself never scrolls sideways.
    expect(["auto", "scroll"]).toContain(layout.overflowX);
    expect(layout.dialogScrolls).toBe(0);
  });

  test("@gate4 review 2 — the JSON preview stays code, indented as the file is", async ({ page }) => {
    await gotoGate4(page);
    await page.locator('[data-testid="artifact-tile"][data-thing="records_json"] [data-testid="artifact-preview"]').click();
    const content = page.getByTestId("artifact-preview-content");
    await expect(content).toHaveAttribute("data-kind", "code");
    await expect(page.getByTestId("artifact-preview-table")).toHaveCount(0);
    // Indentation survives: no wrapping that would push a nested key under its parent.
    expect(await content.evaluate((el) => getComputedStyle(el).whiteSpace)).toBe("pre");
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

  test("@gate4 the summary tells variables scoped out at Gate 1 apart from ones that reached no concept (F21)", async ({ page }) => {
    await serveFinished(page, (run) => {
      if (!run.result) return;
      run.config = { ...(run.config ?? {}), gate1_scope: [] };
      run.result.conceptGroupMembers = { "g-out": ["AoU:scoped1", "AoU:scoped2"] };
      run.result.unassignedFields = ["scoped1", "scoped2", "orphan"].map((v) => ({ cohort: "AoU", variable: v, text: v }));
    });
    await gotoGate4(page);
    const summary = page.getByTestId("unassigned-summary");
    await expect(summary).toContainText("1 variable reached no concept");
    await expect(summary).toContainText("2 variables were in groups you scoped out at Gate 1");
  });

  test("@gate4 the decision count names the entries the downloaded log carries (F21)", async ({ page }) => {
    await page.addInitScript(
      ([jobId]) => {
        const comp = (componentName: string) => ({
          scoreName: "Frailty", componentName, chosen: "", alternatives: ["grip", "gait"], optionSetKey: "s",
        });
        sessionStorage.setItem(
          `ddharmon.sandbox.${jobId}`,
          JSON.stringify({
            gateDecisions: {
              gate2_candidate_pick: { "seed-group": { groupId: "seed-group", chosen: "CDE:1", alternatives: ["CDE:1"], optionSetKey: "p" } },
              composite_swap: { "Frailty|grip": comp("grip"), "Frailty|gait": comp("gait") },
            },
          }),
        );
      },
      [FINISHED_JOB],
    );
    await gotoGate4(page);
    // Three stored decisions, but the log carries two entries: the pick, and ONE row for the declared score.
    await expect(page.getByTestId("decision-count")).toHaveText("2 entries in the decision log");
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

// --- 08-28 3f: the Gate 2 relation in the log and the revision rate ----------------------------------------

/** An adopt (the model's target taken as-is) and a refine whose derived element carries core's stamped predicate. */
const REL_RESULT = {
  records: [
    {
      groupId: "g0", concept: "Age", verdict: "adopt", members: ["A:age"], cde: { id: "AgeCDE", externalId: "" },
      gencde: null, candidates: [{ cdeId: "AgeCDE", isChosen: true }, { cdeId: "VisitCDE", isChosen: false }],
    },
    {
      groupId: "g1", concept: "Smoking", verdict: "refine", members: ["A:smk"], cde: { id: "SmokeCDE", externalId: "" },
      gencde: { gencdeId: "GEN:smk", parentCdeId: "SmokeCDE", relation: "skos:narrowMatch" },
      candidates: [{ cdeId: "SmokeCDE", isChosen: true }],
    },
  ],
} as unknown as HarmonizationResult;

test("@gate4 3f the model implies a relation only for its own catalog target", () => {
  const [age, smoke] = REL_RESULT.records!;
  expect(modelRelation(age, "AgeCDE")).toBe("skos:exactMatch"); // an adopt: the element taken as-is
  expect(modelRelation(age, "VisitCDE")).toBe(""); // a target the model never judged
  expect(modelRelation(smoke, "SmokeCDE")).toBe("skos:narrowMatch"); // core's own stamp on the refinement
  expect(modelRelation(smoke, "GEN:smk")).toBe(""); // the group's own element: nothing to assert
  // Re-targeted by the Gate 2 -> 3 leg: the model's target (from the stamp) was its own generated element.
  expect(modelRelation(REPICKED as never, "CDE:pick")).toBe("");
});

test("@gate4 3f the in-app log reads a relation against the model's, with its note, and says when it took no effect", () => {
  const index: DecisionIndex = {
    gate2_relation: {
      "g0|AgeCDE": dd({ groupId: "g0", targetId: "AgeCDE", chosen: "skos:closeMatch", note: "consent age" }),
      "g1|SmokeCDE": dd({ groupId: "g1", targetId: "SmokeCDE", chosen: "skos:narrowMatch" }),
      "g0|VisitCDE": dd({ groupId: "g0", targetId: "VisitCDE", chosen: "", note: "maybe" }),
    },
  };
  const rows = decisionLogRows(index, REL_RESULT);
  const by = (thing: string) => rows.find((r) => r.thing === thing)!;
  expect(by("g0|AgeCDE").action).toBe("Set a relation");
  expect(by("g0|AgeCDE").label).toBe("Age");
  expect(by("g0|AgeCDE").detail).toBe("skos:closeMatch (model: skos:exactMatch) · note: “consent age”");
  expect(by("g1|SmokeCDE").detail).toBe("skos:narrowMatch"); // agrees with the model: nothing to contrast
  expect(by("g0|VisitCDE").detail).toBe(
    "no relation asserted · note: “maybe” · not applied: not this group's current target",
  );
});

test("@gate4 3f a relation that restates the model's with no note is not an edit; an override or a note is", () => {
  const same = dd({ groupId: "g1", targetId: "SmokeCDE", chosen: "skos:narrowMatch" });
  expect(revisionRate({ gate2_relation: { "g1|SmokeCDE": same } }, REL_RESULT, "1").edited).toBe(0);
  const overridden = dd({ groupId: "g0", targetId: "AgeCDE", chosen: "skos:closeMatch" });
  expect(
    revisionRate({ gate2_relation: { "g1|SmokeCDE": same, "g0|AgeCDE": overridden } }, REL_RESULT, "1").edited,
  ).toBe(1);
  const noted = { ...same, note: "checked against the codebook" };
  expect(revisionRate({ gate2_relation: { "g1|SmokeCDE": noted } }, REL_RESULT, "1").edited).toBe(1);
});
