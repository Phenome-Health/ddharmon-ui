import { expect, test, type Locator, type Page } from "@playwright/test";
import type { JobResult, UIRecord } from "@/types";
import { gate1BillableGroups, gate1ScopePayload, inheritedGate1Scope } from "@/lib/gate-decisions";
import { mergeSpecEdit } from "@/lib/gate23";
import { optionSetKey } from "@/lib/gate-decisions";
import { SANDBOX_PREFIX, withGateDecision } from "@/lib/sandbox";
import {
  SKOS_RELATIONS,
  affectedSpecCount,
  autoAdoptsSingleCandidate,
  candidateListState,
  citeCandidateOrdinals,
  conceptMatchState,
  needsRepickConfirmation,
  parseBandRange,
  recodeShape,
  repickConfirmation,
  routesToReview,
  seedBinning,
  seedNumberMap,
  specForm,
  specRowsFor,
  specState,
  suggestedRelation,
  targetIsNumeric,
  targetValueKind,
  targetValuesFromSpecs,
  unmappedState,
} from "@/lib/gate23";
import {
  FINISHED_JOB,
  PAUSED_JOB,
  finishedRecords,
  serveFinished,
  servePaused,
} from "./gate23-fixture";

/**
 * Gate 2 (concepts to elements) and Gate 3 (transform specs) — 08-16.
 *
 *   run: npm run test:e2e -- --grep "@gate2"
 *        npm run test:e2e -- --grep "@gate3"
 *        npm run test:e2e -- --grep "re-decide finished run"
 *
 * WHAT THIS SUITE CAN AND CANNOT SEE, stated up front because one shipped bug already hid here. It runs
 * against a STATIC build, which is backend-less: `IS_STATIC` routes every gate decision to the browser
 * sandbox, so a "persists across a reload" assertion below proves the SCREEN re-reads its decision — it
 * does NOT prove the write reached a store. 08-15 lost exactly that distinction (`pinned` resolved from
 * `config.demo`, undefined on every real run, so every decision was silently confined to sessionStorage
 * and the static suite stayed green). The store round-trip is asserted where it can actually be seen:
 * server-side in `tests/test_backend.py` (`test_repick_makes_no_llm_call` and its two neighbours), and
 * once by hand against a wired build. Both halves are needed; neither substitutes for the other.
 */

async function openGate2(page: Page, job = FINISHED_JOB): Promise<void> {
  await page.goto(`/run/${job}/gate2`);
  await page.waitForLoadState("networkidle");
}

async function openGate3(page: Page, job = FINISHED_JOB): Promise<void> {
  await page.goto(`/run/${job}/gate3`);
  await page.waitForLoadState("networkidle");
}

/**
 * Reduce a served run to a SINGLE adopt concept that carries ranked candidates and at least one source
 * member. The gates are master-detail and auto-select the first visible concept, so trimming to one makes
 * the candidate / re-pick / spec assertions deterministic instead of depending on which concept sorts to
 * the top — the demo's real first record is a novel (no candidates), which is the wrong subject for them.
 */
function oneRankedConcept(run: JobResult): void {
  const recs = run.result?.records ?? [];
  const r = recs.find(
    (x) =>
      x.verdict === "adopt" &&
      x.candidates.length >= 2 &&
      x.members.length >= 1,
  );
  if (r && run.result) run.result.records = [r];
}

/** Re-pick a candidate that is not currently chosen: expand its row, then click its select button. The
 *  chosen row auto-expands and shows `candidate-selected` instead of a select button, so a re-pick is
 *  always driven through a different, collapsed row. */
async function pickCandidate(page: Page, row: Locator): Promise<void> {
  await row.locator("[data-testid='candidate-expand']").click();
  await row.locator("[data-testid='candidate-select']").click();
}

/** The candidate rows for the auto-selected concept, once the detail pane has rendered them. */
function candidateRows(page: Page): Locator {
  return page.locator("[data-testid='candidate-row']");
}

// --- the algebra, asserted in node ---------------------------------------------------------------------

test.describe("gate23 algebra", () => {
  test("@gate2 a retrieval failure and a genuine novel are different states", () => {
    // The pair the contract carries no flag for, and the reason this function is derived rather than read.
    // An ASSESSED absence is a decision; an UNASSESSED one is silence, and rendering silence as "no match
    // exists" is the tool vouching for a conclusion no stage reached.
    expect(
      candidateListState({ candidates: [], verdict: "novel", gencde: null }),
    ).toBe("novel");
    expect(
      candidateListState({
        candidates: [],
        verdict: "unclassified",
        gencde: null,
      }),
    ).toBe("failed");
    expect(
      candidateListState({
        candidates: [{ rank: 1 } as never],
        verdict: "adopt",
        gencde: null,
      }),
    ).toBe("ranked");
  });

  test("@gate2 a lone candidate is never auto-adopted", () => {
    // Stated as a rule rather than left as an omission: "only one option" is not evidence the option fits,
    // and the adopt floor exists because a single far-cosine hit is the case most likely to be wrong.
    expect(autoAdoptsSingleCandidate()).toBe(false);
  });

  test("@gate2 the relation vocabulary is SKOS and the suggestion follows the verdict", () => {
    expect(SKOS_RELATIONS).toContain("skos:exactMatch");
    expect(suggestedRelation({ verdict: "adopt", gencde: null })).toBe(
      "skos:exactMatch",
    );
    // A refined element carries core's own stamped predicate, so the browser proposes what core wrote
    // rather than a second opinion.
    expect(
      suggestedRelation({
        verdict: "refine",
        gencde: { relation: "skos:narrowMatch" } as never,
      }),
    ).toBe("skos:narrowMatch");
  });

  test("@gate3 arithmetic always routes to review, regardless of the pipeline's own flag", () => {
    // A category of risk, not a property of one row: an arithmetic recode produces plausible numbers when
    // it is wrong, so no value of `needsReview` may switch this off.
    expect(routesToReview({ kind: "arithmetic", needsReview: false })).toBe(
      true,
    );
    expect(routesToReview({ kind: "categorical", needsReview: false })).toBe(
      false,
    );
    expect(routesToReview({ kind: "categorical", needsReview: true })).toBe(
      true,
    );
    // 08-28 1c (F16): a spec that could not be produced always comes to the reviewer, whatever its flag says.
    expect(routesToReview({ kind: "none", needsReview: false })).toBe(true);
    expect(routesToReview({ kind: "unit", needsReview: false })).toBe(true);
    expect(routesToReview({ kind: "unit", needsReview: false, factor: 2.54 })).toBe(false);
  });

  test("@gate3 zero, one and many unmapped values are three states", () => {
    expect(unmappedState({ unmappedSourceCodes: [] })).toBe("none");
    expect(unmappedState({ unmappedSourceCodes: ["9"] })).toBe("one");
    expect(unmappedState({ unmappedSourceCodes: ["9", "8"] })).toBe("many");
  });

  test("@gate3 a failed spec, a no-transform spec and a not-generated run are three states", () => {
    // The pair that matters: `failed` means the stage ran and produced nothing for this variable;
    // `not-generated` means the run never bought the stage. Opposite claims, identical emptiness.
    expect(specState({ kind: "categorical" }, { specsGenerated: true })).toBe(
      "ok",
    );
    expect(specState({ kind: "identity" }, { specsGenerated: true })).toBe(
      "no-transform",
    );
    expect(specState(undefined, { specsGenerated: true })).toBe("failed");
    expect(specState(undefined, { specsGenerated: false })).toBe(
      "not-generated",
    );
  });

  test("@gate3 F16 a spec that could not be produced is its own state, never 'no transform required'", () => {
    // kind `none` = the model produced an EMPTY code map: nothing was mapped, so "the values already match"
    // is the one reading it must never get. A unit spec with no conversion factor is the same failure.
    expect(specState({ kind: "none" }, { specsGenerated: true })).toBe("needs-you");
    expect(specState({ kind: "unit" }, { specsGenerated: true })).toBe("needs-you");
    expect(specState({ kind: "unit", factor: 1000 }, { specsGenerated: true })).toBe("ok");
    expect(specState({ kind: "identity" }, { specsGenerated: true })).toBe("no-transform");
  });

  test("@gate3 spec rows are driven by the MEMBERS so a failed spec still gets a row", () => {
    // Iterating the transforms can only show variables that produced one, which makes the failure
    // invisible — the omission the whole three-state split exists to prevent.
    const rows = specRowsFor(
      {
        members: ["UKBB:age", "AOU:age"],
        // a unit spec WITH a factor: one without is `needs-you` (08-28 1c), which is not what this test is about
        transforms: [{ sourceVariable: "UKBB:age", kind: "unit", factor: 2.54 } as never],
      },
      { specsGenerated: true },
    );
    expect(rows.map((r) => r.state)).toEqual(["ok", "failed"]);
    expect(rows[1].sourceVariable).toBe("AOU:age");
  });

  test("@gate3 an absent concept-match verdict is NOT a pass", () => {
    // `conceptMismatch` is absent, not false, on a run that did not opt in. Reading absence as `false`
    // turns "nobody checked" into "checked, and fine".
    expect(
      conceptMatchState({ conceptMismatch: undefined }, { optedIn: false }),
    ).toBe("not-enabled");
    expect(
      conceptMatchState({ conceptMismatch: undefined }, { optedIn: true }),
    ).toBe("not-enabled");
    expect(
      conceptMatchState({ conceptMismatch: false }, { optedIn: true }),
    ).toBe("clear");
    expect(
      conceptMatchState({ conceptMismatch: true }, { optedIn: true }),
    ).toBe("flagged");
  });

  test("@gate3 specForm maps the contract's kinds onto the three editing surfaces", () => {
    expect(specForm("categorical")).toBe("categorical");
    expect(specForm("unit")).toBe("unit");
    expect(specForm("arithmetic")).toBe("arithmetic");
    expect(specForm("none")).toBe("no-spec");
    expect(specForm("identity")).toBe("passthrough");
    expect(specForm("wide_to_long")).toBe("other");
  });

  test("@gate3 a target is numeric only when it DECLARES a number type and has no enumerated values", () => {
    expect(targetIsNumeric("Number", [])).toBe(true);
    expect(targetIsNumeric("integer", [])).toBe(true);
    expect(targetIsNumeric("categorical", ["Yes", "No"])).toBe(false);
    expect(targetIsNumeric("categorical", [])).toBe(false); // explicit categorical wins the no-PV tiebreak
    expect(targetIsNumeric("text", [])).toBe(false);
    expect(targetIsNumeric("date", [])).toBe(false);
    // 08-26 (#7): the NIH catalog's own vocabulary. "Value List" is the catalog's categorical — reading it
    // as a number is what put Yes/No targets on the code->number editor.
    expect(targetIsNumeric("Value List", [])).toBe(false);
    expect(targetIsNumeric("Externally Defined", [])).toBe(false);
    // No declared type and no values is NOT evidence of a number — it is the absence of evidence (a run whose
    // candidates reached the wire without catalog metadata, e.g. 573cf61f). It used to default to numeric.
    expect(targetIsNumeric(undefined, [])).toBe(false);
    expect(targetValueKind(undefined, [])).toBe("unknown");
    expect(targetValueKind("", [])).toBe("unknown");
    expect(targetValueKind("Number", [])).toBe("numeric");
    expect(targetValueKind("Value List", [])).toBe("non-numeric");
    expect(targetValueKind(undefined, ["Yes", "No"])).toBe("non-numeric");
  });

  test("@gate3 #7 an UNKNOWN target type never gets the code→number editor", () => {
    // The live-test-2 case: coded source, categorical spec (1->Yes, 2->No), and a target with no declared
    // type and no values on the wire. The spec itself is the evidence — it mapped codes onto LABELS.
    expect(
      recodeShape({
        targetDataType: undefined,
        targetValues: [],
        hasSourceOptions: true,
        kind: "categorical",
      }),
    ).toBe("value-map");
    // With no categorical evidence either, stay read-only rather than assert a number.
    for (const kind of [undefined, "none", "identity"])
      expect(
        recodeShape({
          targetDataType: undefined,
          targetValues: [],
          hasSourceOptions: true,
          kind,
        }),
      ).toBe("recode-detail");
    // A declared Number target keeps ② (susmkstoage is unchanged).
    expect(
      recodeShape({
        targetDataType: "Number",
        targetValues: [],
        hasSourceOptions: true,
        kind: "categorical",
      }),
    ).toBe("code-to-number");
  });

  test("@gate3 #7 target values are recovered from the specs' code maps when the wire has none", () => {
    const t = (
      sourceVariable: string,
      codeMap?: Record<string, string>,
      targetCdeId = "Preg",
    ) => ({
      sourceVariable,
      targetCdeId,
      kind: "categorical",
      confidence: 1,
      coverage: 1,
      needsUnits: false,
      needsData: false,
      needsReview: false,
      codeMap,
    });
    // union across the concept's specs INTO this target, first-seen order, case-folded de-dupe
    expect(
      targetValuesFromSpecs(
        [
          t("a", { "1": "Yes", "2": "No" }),
          t("b", { x: "no", y: "Unknown" }),
          t("c", { "1": "Other target" }, "Else"),
        ],
        "Preg",
      ),
    ).toEqual(["Yes", "No", "Unknown"]);
    // a code map onto NUMBERS is not a value list — nothing is invented for a numeric landing
    expect(
      targetValuesFromSpecs([t("a", { "98": "60", "1": "1.5" })], "Preg"),
    ).toEqual([]);
    expect(targetValuesFromSpecs([t("a")], "Preg")).toEqual([]);
  });

  test("@gate3 #7 a coded categorical target with no metadata on the wire renders the CATEGORICAL editor", async ({
    page,
  }) => {
    // Mirrors run 573cf61f (clsa_baseline:_ROW_00129 -> Current Pregnancy Indicator): the chosen candidate
    // reached the wire with NO dataType and NO permissibleValues, and the row rendered SpecNumberMap
    // ("numeric responses pass through") for a Yes/No recode.
    await serveFinished(
      page,
      (run) => {
        const r = run.result!.records!.find(
          (x) => x.groupId === "c46be33d9a542#g0",
        )!;
        for (const c of r.candidates) {
          delete c.dataType;
          delete c.permissibleValues;
        }
        run.result!.records = [r];
      },
      { keep: 0 },
    );
    await openGate3(page);
    const row = page.locator(
      "[data-testid='spec-row'][data-source='AI-READI:susmkncf']",
    );
    await expect(row).toBeVisible();
    await expect(
      row.locator("[data-testid='spec-mapping-editor']"),
    ).toBeVisible();
    await expect(page.locator("[data-testid='spec-number-map']")).toHaveCount(
      0,
    );
    await expect(page.getByText("numeric responses pass through")).toHaveCount(
      0,
    );
    // the buckets are the values the spec mapped into, so the model's Yes/No land where it put them
    await expect(
      row.locator("[data-testid='spec-bucket'][data-bucket='Yes']"),
    ).toBeVisible();
    await expect(
      row.locator("[data-testid='spec-bucket'][data-bucket='No']"),
    ).toBeVisible();
    // and the screen says where those buckets came from, instead of passing them off as the catalog's list
    await expect(
      page.locator("[data-testid='target-values-inferred']"),
    ).toContainText(/\bYes\b.*\bNo\b|\bNo\b.*\bYes\b/);
    await expect(
      page.locator("[data-testid='target-permissible-values']"),
    ).toHaveCount(0);
  });

  test("@gate3 #7 an ENRICHED Value List target keeps the categorical editor and states no inference", async ({
    page,
  }) => {
    await serveFinished(
      page,
      (run) => {
        run.result!.records = [
          run.result!.records!.find((x) => x.groupId === "c46be33d9a542#g0")!,
        ];
      },
      { keep: 0 },
    );
    await openGate3(page);
    const row = page.locator(
      "[data-testid='spec-row'][data-source='AI-READI:susmkncf']",
    );
    await expect(
      row.locator("[data-testid='spec-mapping-editor']"),
    ).toBeVisible();
    await expect(
      page.locator("[data-testid='target-permissible-values']"),
    ).toBeVisible();
    await expect(
      page.locator("[data-testid='target-values-inferred']"),
    ).toHaveCount(0);
  });

  test("@gate3 the recode surface follows the TARGET type, not the source's coded options", () => {
    // susmkstoage: source carries coded options (98='more than 60', 999='prefer not') but the target is a
    // Number -> a code->number table, NOT chips-into-buckets (there are no buckets on a numeric target).
    expect(
      recodeShape({
        targetDataType: "Number",
        targetValues: [],
        hasSourceOptions: true,
      }),
    ).toBe("code-to-number");
    // a genuine categorical target with source options -> the drag-drop value map (unchanged).
    expect(
      recodeShape({
        targetDataType: "categorical",
        targetValues: ["Yes", "No"],
        hasSourceOptions: true,
      }),
    ).toBe("value-map");
    // a numeric source (no options) with a banded categorical target -> binning.
    expect(
      recodeShape({
        targetDataType: "categorical",
        targetValues: ["18-29", "30-44"],
        hasSourceOptions: false,
      }),
    ).toBe("binning");
    // unit / arithmetic / data-dependent keep read-only detail regardless of the value lists.
    expect(
      recodeShape({
        kind: "unit",
        targetDataType: "Number",
        targetValues: [],
        hasSourceOptions: false,
      }),
    ).toBe("recode-detail");
    expect(
      recodeShape({
        kind: "arithmetic",
        targetValues: [],
        hasSourceOptions: true,
      }),
    ).toBe("recode-detail");
    // numeric -> numeric with no method and no value list: nothing to sort, read-only.
    expect(
      recodeShape({
        targetDataType: "Number",
        targetValues: [],
        hasSourceOptions: false,
      }),
    ).toBe("recode-detail");
  });

  test("@gate3 ② the code→number map defaults every code to Missing, never a fabricated number", () => {
    const seeded = seedNumberMap([{ code: "98" }, { code: "999" }]);
    expect(seeded["98"]).toEqual({ action: "missing", value: null });
    expect(seeded["999"]).toEqual({ action: "missing", value: null });
    // a persisted edit (a deliberate representative number) wins over the default.
    const edited = seedNumberMap([{ code: "98" }, { code: "999" }], {
      "98": { action: "number", value: 60 },
    });
    expect(edited["98"]).toEqual({ action: "number", value: 60 });
    expect(edited["999"]).toEqual({ action: "missing", value: null });
  });

  test("@gate3 ③ band labels parse into proposed ranges; open-ended and named bands are handled", () => {
    expect(parseBandRange("18-29")).toEqual({ min: 18, max: 29 });
    expect(parseBandRange("18–29")).toEqual({ min: 18, max: 29 }); // en dash
    expect(parseBandRange("18 to 29")).toEqual({ min: 18, max: 29 });
    expect(parseBandRange("65+")).toEqual({ min: 65, max: null });
    expect(parseBandRange("65 or older")).toEqual({ min: 65, max: null });
    expect(parseBandRange("under 18")).toEqual({ min: null, max: 18 });
    expect(parseBandRange("adult")).toBeNull(); // a named band the reviewer must bound by hand
  });

  test("@gate3 ③ binning seeds one bin per band from the labels; persisted boundaries win", () => {
    const seeded = seedBinning(["18-29", "30-44", "65+"]);
    expect(seeded).toEqual([
      { band: "18-29", min: 18, max: 29 },
      { band: "30-44", min: 30, max: 44 },
      { band: "65+", min: 65, max: null },
    ]);
    const edited = seedBinning(
      ["18-29", "30-44"],
      [{ band: "18-29", min: 21, max: 29 }],
    );
    expect(edited[0]).toEqual({ band: "18-29", min: 21, max: 29 });
    expect(edited[1]).toEqual({ band: "30-44", min: 30, max: 44 });
  });

  test("re-decide finished run — the confirmation counts real affected specs and states the zero cost", () => {
    const decisions = {
      "UKBB:age": { upstream: { kind: "gate2_candidate_pick", itemKey: "g1" } },
      "AOU:age": { upstream: { kind: "gate2_candidate_pick", itemKey: "g1" } },
      "AOU:sex": { upstream: { kind: "gate2_candidate_pick", itemKey: "g2" } },
    };
    expect(affectedSpecCount(decisions, "g1")).toBe(2);
    expect(affectedSpecCount(decisions, "g9")).toBe(0);
    expect(repickConfirmation(2)).toContain("2 transform specs");
    expect(repickConfirmation(1)).toContain("1 transform spec at Gate 3 stale");
    expect(repickConfirmation(2)).toContain(
      "costs nothing — the candidates were already retrieved",
    );
    // Nothing downstream means no confirmation and no regeneration step — a dead control otherwise.
    expect(needsRepickConfirmation(0)).toBe(false);
    expect(needsRepickConfirmation(1)).toBe(true);
  });

  test("@gate2 #3 a rationale's candidate ordinals are cited by NAME, keyed to the model's rank", () => {
    const cands = [
      { rank: 1, cdeId: "Age" },
      { rank: 2, cdeId: "Current Pregnancy Indicator" },
      { rank: 3, cdeId: "Marital Status" },
    ];
    // the ordinal the model wrote is its RANK (the order it saw them in), never the displayed row index
    expect(citeCandidateOrdinals("Candidate 2 is the best fit; candidate #3 is too broad.", cands)).toBe(
      "Candidate 2 (Current Pregnancy Indicator) is the best fit; candidate #3 (Marital Status) is too broad.",
    );
    // an ordinal no candidate carries is left alone rather than pinned to the wrong element
    expect(citeCandidateOrdinals("Candidate 9 is out of range.", cands)).toBe("Candidate 9 is out of range.");
    // idempotent: an already-named citation is not named twice
    const once = citeCandidateOrdinals("Candidate 2 fits.", cands);
    expect(citeCandidateOrdinals(once, cands)).toBe(once);
  });

  test("@gate2 the shipped demo really does carry the shapes these screens are built on", () => {
    // Guards the fixture itself: every assertion below is only evidence while the demo still contains a
    // generated element, an arithmetic spec and a spread of unmapped values.
    const recs = finishedRecords();
    expect(recs.length).toBeGreaterThan(100);
    expect(recs.some((r) => r.gencde)).toBe(true);
    expect(recs.every((r) => r.candidates.length > 0)).toBe(true);
    const kinds = new Set(recs.flatMap((r) => r.transforms.map((t) => t.kind)));
    expect(kinds).toContain("arithmetic");
    expect(kinds).toContain("categorical");
    expect(kinds).toContain("unit");
    // The concept gate did NOT run on the demo, which is what makes it the default-path fixture.
    expect(recs.every((r) => r.conceptMismatch === undefined)).toBe(true);
  });
});

// --- Gate 2, rendered ----------------------------------------------------------------------------------

test.describe("gate2 screen", () => {
  test("@gate2 the author-your-own anchor renders AFTER the ranked candidates", async ({
    page,
  }) => {
    await serveFinished(page, oneRankedConcept);
    await openGate2(page);
    const list = page.locator("[data-testid='candidate-list']");
    const anchor = page.locator("[data-testid='ideal-anchor']");
    await expect(list).toBeVisible();
    await expect(anchor).toBeVisible();
    // Document order, not styling: the cluster-level ideal was dropped as a group anchor (#66) because it
    // described the whole pre-split cluster, not this group. The anchor is now the "author your own" escape
    // hatch BELOW the retrieved candidates, so the candidates lead and the anchor follows.
    const listFirst = await page.evaluate(() => {
      const l = document.querySelector("[data-testid='candidate-list']");
      const a = document.querySelector("[data-testid='ideal-anchor']");
      if (!a || !l) return false;
      return !!(
        l.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING
      );
    });
    expect(listFirst).toBe(true);
  });

  test("@gate2 #2 the ranked-candidates legend and row indicators are legible on the white card", async ({
    page,
  }) => {
    // Live-test-2 #2: the legend (model's pick, metadata richness, N PV, cos) and the column key were set
    // in `--on-raised-faint` — the HAIRLINE role, which index.css says is never text — and the empty
    // richness dots in `--surface-track` (~1.2:1 on white), so "3 of 5" read as three dots of nothing.
    await serveFinished(page, oneRankedConcept);
    await openGate2(page);
    await expect(page.locator("[data-testid='candidate-legend']")).toBeVisible();
    const ratios = await page.evaluate(() => {
      type Rgba = [number, number, number, number];
      const parse = (v: string): Rgba => {
        const legacy = /^rgba?\(([^)]+)\)$/i.exec(v.trim());
        if (legacy) {
          const p = legacy[1].split(/[,\s/]+/).filter(Boolean).map(Number);
          return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
        }
        const modern = /^color\(srgb\s+([^)]+)\)$/i.exec(v.trim());
        if (modern) {
          const p = modern[1].split(/[\s/]+/).filter(Boolean).map(Number);
          return [p[0] * 255, p[1] * 255, p[2] * 255, p.length > 3 ? p[3] : 1];
        }
        // Tailwind's `/40` opacity modifiers compute to oklab — convert to sRGB (Ottosson's matrices).
        const ok = /^oklab\(([^)]+)\)$/i.exec(v.trim());
        if (ok) {
          const [L, A, B, alpha] = ok[1].split(/[\s/]+/).filter(Boolean).map(Number);
          const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
          const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
          const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
          const lin = [
            4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
            -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
            -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
          ];
          const enc = (x: number) =>
            255 * Math.min(1, Math.max(0, x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055));
          return [enc(lin[0]), enc(lin[1]), enc(lin[2]), Number.isFinite(alpha) ? alpha : 1];
        }
        throw new Error(`unexpected colour ${v}`);
      };
      const over = (f: Rgba, b: Rgba): Rgba => [
        f[0] * f[3] + b[0] * (1 - f[3]),
        f[1] * f[3] + b[1] * (1 - f[3]),
        f[2] * f[3] + b[2] * (1 - f[3]),
        1,
      ];
      const lum = (c: Rgba) => {
        const ch = (x: number) => {
          const s = x / 255;
          return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
        };
        return 0.2126 * ch(c[0]) + 0.7152 * ch(c[1]) + 0.0722 * ch(c[2]);
      };
      // The ground an element is drawn on: every ancestor's background composited from the page down.
      const ground = (el: Element): Rgba => {
        const chain: Element[] = [];
        for (let e: Element | null = el.parentElement; e; e = e.parentElement) chain.unshift(e);
        let bg: Rgba = [255, 255, 255, 1];
        for (const e of chain) bg = over(parse(getComputedStyle(e).backgroundColor), bg);
        return bg;
      };
      const ratio = (fg: string, el: Element, onSelf = false) => {
        const b = onSelf ? over(parse(getComputedStyle(el).backgroundColor), ground(el)) : ground(el);
        const f = over(parse(fg), b);
        const [x, y] = [lum(f), lum(b)];
        return Math.round(((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)) * 100) / 100;
      };
      const q = (sel: string) => Array.from(document.querySelectorAll(sel));
      const text = (sel: string) => q(sel).map((e) => ratio(getComputedStyle(e).color, e));
      return {
        legend: text("[data-testid='candidate-legend']"),
        columns: text("[data-testid='candidate-columns']"),
        pv: q("[data-testid='candidate-pv']").map((e) => ratio(getComputedStyle(e).color, e, true)),
        chevron: q("[data-testid='candidate-expand'] svg[aria-hidden='true']").map((e) =>
          ratio(getComputedStyle(e).color, e),
        ),
        stars: q("[data-testid='pick-star']").map((e) => ratio(getComputedStyle(e).fill, e)),
        cosBars: q("[data-testid='cos-bar-fill']").map((e) => ratio(getComputedStyle(e).backgroundColor, e)),
        // a dot's mark is its fill when present, else its ring
        dots: q("[data-testid='richness-dot']").map((e) => {
          const cs = getComputedStyle(e);
          const filled = parse(cs.backgroundColor)[3] > 0;
          return ratio(filled ? cs.backgroundColor : cs.borderTopColor, e);
        }),
      };
    });
    expect(ratios.legend.length).toBeGreaterThan(0);
    expect(ratios.dots.length).toBeGreaterThan(0);
    expect(ratios.chevron.length).toBeGreaterThan(0);
    for (const r of [...ratios.legend, ...ratios.columns, ...ratios.pv])
      expect(r, "legend / column key / PV text must clear AA (4.5:1)").toBeGreaterThanOrEqual(4.5);
    expect(ratios.stars.length).toBeGreaterThan(0);
    expect(ratios.cosBars.length).toBeGreaterThan(0);
    for (const r of [...ratios.dots, ...ratios.chevron, ...ratios.stars, ...ratios.cosBars])
      expect(r, "a meaningful mark must clear the graphical floor (3:1)").toBeGreaterThanOrEqual(3);
  });

  test("@gate2 #3 the rationale's ordinal and the model's-pick row agree", async ({ page }) => {
    // Live-test-2 #3: the rationale said "Candidate 3" while the pick sat on displayed row #1 — the table
    // floats the chosen candidate to the top and numbered rows by POSITION, but the model's ordinal is the
    // candidate's RANK (the order it was shown them in). A reranked record: the model picked rank 3.
    await serveFinished(
      page,
      (run) => {
        run.result!.records = [run.result!.records!.find((x) => x.groupId === "c46be33d9a542#g1")!];
      },
      { keep: 0 },
    );
    await openGate2(page);
    const rationale = page.locator("[data-testid='model-rationale']");
    await expect(rationale).toContainText("Candidate 3 (Age when first started smoking cigarettes fairly regularly)");
    const pick = page.locator("[data-testid='candidate-row'][data-model-pick='true']");
    await expect(pick).toHaveCount(1);
    await expect(pick.locator("[data-testid='candidate-ordinal']")).toHaveText("3");
    await expect(pick).toHaveAttribute("data-cde-id", "Age when first started smoking cigarettes fairly regularly");
    // every row's number is its rank, so the list reads the same numbering the model used
    const ordinals = await page
      .locator("[data-testid='candidate-ordinal']")
      .allTextContents();
    expect(new Set(ordinals).size).toBe(ordinals.length);
    expect(ordinals).toContain("1");
  });

  test("@gate2 a re-pick moves the chosen marker and survives a reload", async ({
    page,
  }) => {
    await serveFinished(page, oneRankedConcept);
    await openGate2(page);
    await expect(candidateRows(page).first()).toBeVisible();
    // The model's pick is pre-chosen; re-pick a DIFFERENT candidate through its own (collapsed) row, then
    // read the chosen cde-id off the DOM (not via an attribute-value selector — a cdeId is a question string
    // that can carry quotes/spaces).
    const target = page
      .locator("[data-testid='candidate-row']:not([data-chosen='true'])")
      .first();
    const id = await target.getAttribute("data-cde-id");
    await pickCandidate(page, target);
    const chosenId = () =>
      page.evaluate(() =>
        document
          .querySelector("[data-testid='candidate-row'][data-chosen='true']")
          ?.getAttribute("data-cde-id"),
      );
    await expect.poll(chosenId).toBe(id);
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect.poll(chosenId).toBe(id);
  });

  test("@gate2 the authored target is labelled generated and wears no catalog endorsement", async ({
    page,
  }) => {
    // The novel path's target is authored, not retrieved (the demo's first concept is a novel), so its
    // anchor must say it is generated and must never carry a catalog element's NIH-endorsed badge.
    await serveFinished(page);
    await openGate2(page);
    const anchor = page.locator("[data-testid='ideal-anchor']");
    await expect(anchor).toBeVisible();
    await expect(anchor).toContainText("generated by ddharmon");
    await expect(anchor).not.toContainText("NIH-endorsed");
  });

  test("@gate2 the retired third abbreviation appears nowhere on the surface", async ({
    page,
  }) => {
    await serveFinished(page);
    await openGate2(page);
    // CDE = existing, GenCDE = generated. The third abbreviation is retired and must not resurface.
    await expect(page.locator("body")).not.toContainText(/\bCDV\b/);
  });

  test("@gate2 zero candidates and a retrieval failure render different, non-blank states", async ({
    page,
  }) => {
    await serveFinished(page, (run) => {
      const recs = run.result!.records!;
      // A genuine novel: assessed, nothing cleared the floor.
      recs[0].candidates = [];
      recs[0].verdict = "novel";
      // A retrieval failure: no candidates AND no verdict. Constructed here because the demo contains no
      // such record — it is a property of a different run, not of this one.
      recs[1].candidates = [];
      recs[1].verdict = "unclassified";
      recs[1].gencde = null;
    });
    await openGate2(page);

    await page.locator("[data-testid='gate2-concept']").first().click();
    await expect(page.locator("[data-testid='novel-path']")).toBeVisible();
    await expect(page.locator("[data-testid='retrieval-failed']")).toHaveCount(
      0,
    );

    await page.locator("[data-testid='gate2-concept']").nth(1).click();
    await expect(
      page.locator("[data-testid='retrieval-failed']"),
    ).toBeVisible();
    await expect(page.locator("[data-testid='novel-path']")).toHaveCount(0);
    // A failure must not claim no match exists — that is the whole distinction.
    await expect(
      page.locator("[data-testid='retrieval-failed']"),
    ).not.toContainText("no match");
  });

  test("@gate2 a single candidate is not adopted automatically, and the floor is stated", async ({
    page,
  }) => {
    await serveFinished(page, (run) => {
      oneRankedConcept(run);
      const rec = run.result!.records![0];
      rec.candidates = [{ ...rec.candidates[0], isChosen: false, rank: 1 }];
      rec.floored = true;
    });
    await openGate2(page);
    const rows = candidateRows(page);
    await expect(rows).toHaveCount(1);
    // "Only one option" is not evidence it fits (autoAdoptsSingleCandidate) — the lone row is not chosen.
    await expect(rows.first()).not.toHaveAttribute("data-chosen", "true");
    await expect(
      page.locator("[data-testid='adopt-floor-note']"),
    ).toBeVisible();
  });

  // Removed 08-16g (#72, #74): the knowledge-graph NotAvailable tile and the on-screen CDEMapper credit
  // were dropped from Gate 2 — the KG tile with the deferred knowledge-graph views, the CDEMapper
  // acknowledgment to the Related-work page. Their tests are retired with them.

  test("@gate2 an edit to a generated element survives a CONCEPT SWITCH, not only a reload", async ({
    page,
  }) => {
    // The write-through bug, on the Gate 2 half. A verdict POST that never patches the local record plus a
    // detail card that re-seeds its draft from the prop on id change = the stale original repaints the edit.
    await serveFinished(page);
    await openGate2(page);
    await page.locator("[data-testid='gate2-concept']").first().click();
    const field = page.locator("[data-testid='gencde-definition-input']");
    await expect(field).toBeVisible();
    await field.fill("A reviewer-corrected definition.");
    await page.locator("[data-testid='gencde-save']").click();
    await page.locator("[data-testid='gate2-concept']").nth(1).click();
    await page.locator("[data-testid='gate2-concept']").first().click();
    await expect(
      page.locator("[data-testid='gencde-definition-input']"),
    ).toHaveValue("A reviewer-corrected definition.");
  });

  test("@gate2 nothing sent to this gate renders the empty state, never a blank pane", async ({
    page,
  }) => {
    await servePaused(page);
    await openGate2(page, PAUSED_JOB);
    const empty = page.locator("[data-testid='gate-empty-state']");
    await expect(empty).toBeVisible();
    await expect(empty).toContainText("Nothing was passed from Gate 1");
  });

  test("@gate2 a result that fails to load reads as a load failure, not an empty scope", async ({
    page,
  }) => {
    // A 401 on /result (the key-cleared-on-reload case) leaves the page with no records — the SAME surface
    // condition as a genuine empty scope, but the opposite cause. The screen must not blame Gate 1's scope
    // for a fetch that never landed.
    await page.route("**/static-data/result-*.json", (route) =>
      route.fulfill({ status: 401, contentType: "application/json", body: "{}" }),
    );
    await openGate2(page, PAUSED_JOB);
    const empty = page.locator("[data-testid='gate-empty-state']");
    await expect(empty).toBeVisible();
    await expect(empty).not.toContainText("Nothing was passed from Gate 1");
    await expect(empty).toContainText(/load/i);
  });

  test("@gate2 the source rows are the shared component, themed from role tokens", async ({
    page,
  }) => {
    await serveFinished(page);
    await openGate2(page);
    const grid = page.locator("[data-testid='source-rows']");
    await expect(grid).toBeVisible();
    // Checked by COMPUTED STYLE, not by reading the source: 08-12b found three files painting the org's
    // logo from semantic UI role tokens, which reading class names would never have surfaced (T-08-65).
    const painted = await grid.evaluate((el) => {
      const s = getComputedStyle(el);
      return { color: s.color, background: s.backgroundColor };
    });
    const roles = await page.evaluate(() => {
      const s = getComputedStyle(document.documentElement);
      return ["--mark-primary", "--mark-secondary", "--mark-accent"]
        .map((k) => s.getPropertyValue(k).trim())
        .filter(Boolean);
    });
    // A logo role must never paint a data surface.
    for (const role of roles) {
      expect(painted.color).not.toBe(role);
      expect(painted.background).not.toBe(role);
    }
  });

  // Removed 08-16g (#72, #74): the retrieval-score histogram and the SKOS relation control were dropped
  // from Gate 2 in the declutter. Their tests are retired with them. (The `suggestedRelation` algebra
  // stays covered above; only the on-screen control is gone.)

  test("@gate2 the concept-match decision renders as an honest absence, not a dead control", async ({
    page,
  }) => {
    await serveFinished(page);
    await openGate2(page);
    const tile = page.locator(
      "[data-testid='not-available'][data-thing='concept-gate']",
    );
    await expect(tile).toBeVisible();
    // It names the option and does NOT read as a permanent product gap — the capability exists.
    await expect(tile).toContainText("Concept-match check");
    // And it is not a control: an enable button here would 409, because no route can add a paid stage to
    // a run that has already been created. See the summary's blocker.
    await expect(tile.locator("button")).toHaveCount(0);
  });
});

// --- Gate 3, rendered ----------------------------------------------------------------------------------

test.describe("gate3 screen", () => {
  test("@gate3 a concept's detail renders one spec row per member with the form named", async ({
    page,
  }) => {
    // Master-detail now: a concept's specs live in its detail pane (no flat spec-group), one row per source
    // member with `data-form` naming the surface. Constructed on a single ≥2-member concept so both a
    // categorical and a unit form are present in the one auto-selected detail.
    await serveFinished(page, (run) => {
      const recs = run.result!.records!;
      const r = recs.find((x) => x.members.length >= 2)!;
      r.transforms = [
        {
          ...r.transforms[0],
          kind: "categorical",
          sourceVariable: r.members[0],
          codeMap: { "1": "Yes" },
          unmappedSourceCodes: [],
        },
        {
          ...r.transforms[0],
          kind: "unit",
          sourceVariable: r.members[1],
          factor: 2.54,
          sourceUnit: "in",
          targetUnit: "cm",
        },
      ];
      run.result!.records = [r];
    });
    await openGate3(page);
    await expect(
      page.locator("[data-testid='spec-row']").first(),
    ).toBeVisible();
    const forms = await page
      .locator("[data-testid='spec-row']")
      .evaluateAll((els) => [
        ...new Set(els.map((e) => e.getAttribute("data-form"))),
      ]);
    expect(forms).toContain("categorical");
    expect(forms).toContain("unit");
  });

  test("@gate3 arithmetic specs are reachable through a standing filter and all route to review", async ({
    page,
  }) => {
    await serveFinished(page, undefined, { keep: 0 });
    await openGate3(page);
    // A box in the filter menu inside the search since 08-30b; ticking it leaves a chip that says it is on.
    await page.locator("[data-testid='filter-open']").click();
    const filter = page.locator("[data-testid='filter-menu'] [data-testid='arithmetic-filter']");
    await expect(filter).toBeVisible();
    await filter.click();
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-testid='filter-chip']", { hasText: "Arithmetic recodes only" })).toBeVisible();
    const rows = page.locator("[data-testid='spec-row']");
    await expect(rows.first()).toBeVisible();
    const all = await rows.evaluateAll((els) =>
      els.map((e) => ({
        form: e.getAttribute("data-form"),
        review: e.getAttribute("data-review"),
      })),
    );
    expect(all.length).toBeGreaterThan(0);
    // A category of risk, not a property of one row.
    expect(
      all.every((r) => r.form === "arithmetic" && r.review === "true"),
    ).toBe(true);
  });

  // Removed 08-16g: the standalone `unmapped-decision` control (SpecEditor) is retired — an unmapped source
  // value is now handled INSIDE the editable recode surfaces (a chip left in SpecMappingEditor's "Unmapped"
  // bucket; a code defaulting to Missing in SpecNumberMap). The `unmappedState` algebra stays asserted above.

  test("@gate3 a failed spec renders as failed, routes to review, and is present in the list", async ({
    page,
  }) => {
    await serveFinished(page, (run) => {
      const rec = run.result!.records![0];
      // The stage ran for this run and produced nothing for this variable. Omitting the row would delete
      // the only evidence the variable was ever in scope.
      rec.transforms = rec.transforms.filter(
        (t) => t.sourceVariable !== rec.members[0],
      );
    });
    await openGate3(page);
    const failed = page
      .locator("[data-testid='spec-row'][data-state='failed']")
      .first();
    await expect(failed).toBeVisible();
    await expect(failed).toHaveAttribute("data-review", "true");
    await expect(failed).toContainText("did not generate");
  });

  test("@gate3 no-transform-required is distinct from not-generated", async ({
    page,
  }) => {
    await serveFinished(page, (run) => {
      const rec = run.result!.records![0];
      rec.transforms = [
        { ...rec.transforms[0], kind: "identity", sourceVariable: rec.members[0] },
      ];
    });
    await openGate3(page);
    const none = page
      .locator("[data-testid='spec-row'][data-state='no-transform']")
      .first();
    await expect(none).toBeVisible();
    // Said once, in the header ("identity (already aligned)") — not again in the body (review round 1).
    await expect(none).toContainText("already aligned");
    await expect(none).not.toContainText("did not generate");
  });

  test("@gate3 F16 a spec the model could not map reads 'couldn't map — needs you', never 'No transform required'", async ({
    page,
  }) => {
    await serveFinished(page, (run) => {
      const rec = run.result!.records![0];
      rec.transforms = [
        {
          ...rec.transforms[0],
          kind: "none",
          sourceVariable: rec.members[0],
          codeMap: undefined,
          coverage: 0,
          needsReview: false,
        },
      ];
    });
    await openGate3(page);
    const row = page.locator("[data-testid='spec-row'][data-state='needs-you']").first();
    await expect(row).toBeVisible();
    await expect(row).toContainText(/couldn.t map — needs you/i);
    await expect(row).not.toContainText("No transform required");
    await expect(row).toHaveAttribute("data-review", "true");
  });

  test("@gate3 with the opt-in off the concept-match check is an honest, named absence", async ({
    page,
  }) => {
    await serveFinished(page);
    await openGate3(page);
    const tile = page.locator(
      "[data-testid='not-available'][data-thing='concept-gate']",
    );
    await expect(tile).toBeVisible();
    await expect(tile).toHaveAttribute("data-claim", "not-enabled");
    await expect(tile).toContainText(
      "Concept-match check — not enabled for this run.",
    );
    // Never a silent pass, and never a permanent product gap: the capability exists, this run did not buy it.
    await expect(
      page.locator("[data-testid='concept-match-flag']"),
    ).toHaveCount(0);
    await expect(tile).not.toContainText(/not supported|cannot|never/i);
  });

  test("@gate3 on an opted-in run a flagged spec shows the flag and routes to review", async ({
    page,
  }) => {
    await serveFinished(page, (run) => {
      run.config = { ...(run.config as object), conceptGate: true };
      const rec = run.result!.records![0];
      rec.conceptMismatch = true;
      rec.transforms = [
        {
          ...rec.transforms[0],
          kind: "categorical",
          sourceVariable: rec.members[0],
        },
      ];
      run.result!.records![1].conceptMismatch = false;
    });
    await openGate3(page);
    const flag = page.locator("[data-testid='concept-match-flag']").first();
    await expect(flag).toBeVisible();
    // Right values, wrong concept — the failure the coherence gate structurally cannot see.
    const row = page
      .locator("[data-testid='spec-row'][data-concept-mismatch='true']")
      .first();
    await expect(row).toHaveAttribute("data-review", "true");
    await expect(
      page.locator("[data-testid='not-available'][data-thing='concept-gate']"),
    ).toHaveCount(0);
  });

  test("@gate3 a spec edit survives a reload", async ({ page }) => {
    await serveFinished(page);
    await openGate3(page);
    const input = page.locator("[data-testid='spec-note-input']").first();
    await expect(input).toBeVisible();
    await input.fill("Checked against the source dictionary.");
    await page.locator("[data-testid='spec-save']").first().click();
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(
      page.locator("[data-testid='spec-note-input']").first(),
    ).toHaveValue("Checked against the source dictionary.");
  });

  test("@gate3 #12 a Save visibly confirms it recorded, and the block stays marked edited", async ({ page }) => {
    // Live-test-2 #12: Save persisted (gate3_spec_edit) but showed nothing, so a reviewer could not tell
    // their decision had landed.
    await serveFinished(page);
    await openGate3(page);
    const row = page.locator("[data-testid='spec-row']").first();
    await expect(row.locator("[data-testid='spec-saved']")).toHaveCount(0);
    await expect(row.locator("[data-testid='spec-edited-badge']")).toHaveCount(0);
    await row.locator("[data-testid='spec-note-input']").fill("Checked.");
    await row.locator("[data-testid='spec-save']").click();
    // the write itself is confirmed, in the row that was saved...
    const saved = row.locator("[data-testid='spec-saved']");
    await expect(saved).toBeVisible();
    await expect(saved).toHaveAttribute("role", "status");
    await expect(saved).toContainText(/saved/i);
    // ...and as a toast, for the explicit button press
    await expect(page.getByText(/recode note saved/i)).toBeVisible();
    // the block carries a standing "edited" mark, which survives a reload because it is read off the store
    await expect(row.locator("[data-testid='spec-edited-badge']")).toBeVisible();
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(
      page.locator("[data-testid='spec-row']").first().locator("[data-testid='spec-edited-badge']"),
    ).toBeVisible();
  });

  test("@gate3 #12 an editor change (not only the note) confirms its save", async ({ page }) => {
    await serveFinished(page, (run) => {
      const r = run.result!.records!.find((x) => x.members.some((m) => m.includes("susmkstoage")));
      if (r) run.result!.records = [r];
    });
    await openGate3(page);
    const editor = page.locator("[data-testid='spec-number-map']").first();
    const row = page.locator("[data-testid='spec-row']", { has: editor });
    await expect(row.locator("[data-testid='spec-saved']")).toHaveCount(0);
    await editor
      .locator("[data-testid='number-row']")
      .first()
      .locator("[data-testid='number-action'][data-action='drop']")
      .click();
    await expect(row.locator("[data-testid='spec-saved']")).toBeVisible();
    await expect(row.locator("[data-testid='spec-edited-badge']")).toBeVisible();
  });

  test("@gate3 a spec edit survives a CONCEPT SWITCH with no reload", async ({
    page,
  }) => {
    // The distinct failure mode: the client patches its local record on a successful write instead of only
    // toasting, and the detail card does not re-seed its draft from a stale prop on id change.
    await serveFinished(page);
    await openGate3(page);
    const first = page.locator("[data-testid='gate3-concept']").first();
    await first.click();
    const input = page.locator("[data-testid='spec-note-input']").first();
    await input.fill("A reviewer's note that must survive.");
    await page.locator("[data-testid='spec-save']").first().click();
    await page.locator("[data-testid='gate3-concept']").nth(1).click();
    await first.click();
    await expect(
      page.locator("[data-testid='spec-note-input']").first(),
    ).toHaveValue("A reviewer's note that must survive.");
  });

  test("@gate3 rejecting a recode states exactly what rejection means", async ({
    page,
  }) => {
    await serveFinished(page);
    await openGate3(page);
    await page.locator("[data-testid='spec-reject']").first().click();
    const confirm = page.locator("[data-testid='reject-confirm']");
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText(
      "It will be excluded from the notebook and the mapping table, and recorded as rejected in the decision log.",
    );
  });

  test("@gate3 zero specs renders the empty state with its stated copy", async ({
    page,
  }) => {
    await servePaused(page);
    await openGate3(page, PAUSED_JOB);
    const empty = page.locator("[data-testid='gate-empty-state']");
    await expect(empty).toBeVisible();
    await expect(empty).toContainText("No transform specs to review");
  });

  test("@gate3 ② a coded source on a numeric target gets a code→number table, not chips", async ({
    page,
  }) => {
    // AI-READI susmkstoage ("years smoked") maps to a Number CDE. The drag-drop chip editor could not
    // express this — a numeric target has no permissible-value buckets to drop into — so it must render
    // SpecNumberMap: a standing pass-through row for the numeric body, and each coded value as an editable
    // Number / Missing / Drop decision, defaulting to Missing.
    await serveFinished(page, (run) => {
      const recs = run.result!.records!;
      const r = recs.find((x) =>
        x.members.some((m) => m.includes("susmkstoage")),
      );
      if (r) run.result!.records = [r];
    });
    await openGate3(page);
    const editor = page.locator("[data-testid='spec-number-map']").first();
    await expect(editor).toBeVisible();
    // The drag-drop value map is the wrong instrument for a numeric target and must not appear.
    await expect(
      page.locator("[data-testid='spec-mapping-editor']"),
    ).toHaveCount(0);
    await expect(
      editor.locator("[data-testid='number-passthrough']"),
    ).toBeVisible();
    const rows = editor.locator("[data-testid='number-row']");
    await expect(rows.first()).toBeVisible();
    const actions = await rows.evaluateAll((els) =>
      els.map((e) => e.getAttribute("data-action")),
    );
    expect(actions.length).toBeGreaterThan(0);
    // Never a silently fabricated number: every coded value opens at Missing.
    expect(actions.every((a) => a === "missing")).toBe(true);
    // A representative number is a deliberate upgrade, and it persists across a reload (R6).
    const first = rows.first();
    await first
      .locator("[data-testid='number-action'][data-action='number']")
      .click();
    await first.locator("[data-testid='number-value']").fill("60");
    await expect(first).toHaveAttribute("data-action", "number");
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(
      page
        .locator("[data-testid='spec-number-map'] [data-testid='number-row']")
        .first(),
    ).toHaveAttribute("data-action", "number");
  });

  test("@gate3 ③ a numeric source on a banded categorical target gets an editable range table", async ({
    page,
  }) => {
    // The mirror of ②: a numeric source with a categorical (banded) target has no source chips to sort, so
    // it needs a range→band table. Built from the demo's novel record (a source with no response options)
    // by giving its generated target range-labelled bands.
    await serveFinished(page, (run) => {
      const recs = run.result!.records!;
      const r = recs.find((x) =>
        x.members.some((m) => m.includes("viaocmpyn")),
      )!;
      r.verdict = "novel";
      r.candidates = [];
      r.gencde = {
        ...(r.gencde ?? {}),
        dataType: "categorical",
        permissibleValues: [
          { code: "1", label: "18-29" },
          { code: "2", label: "30-44" },
          { code: "3", label: "65+" },
        ],
      } as never;
      r.transforms = [];
      run.result!.records = [r];
    });
    await openGate3(page);
    const editor = page.locator("[data-testid='spec-binning']").first();
    await expect(editor).toBeVisible();
    await expect(editor.locator("[data-testid='bin-row']")).toHaveCount(3);
    // A range-labelled band pre-fills its boundaries (parseBandRange), so the reviewer edits rather than
    // starts blank.
    const firstBand = editor.locator(
      "[data-testid='bin-row'][data-band='18-29']",
    );
    await expect(firstBand.locator("[data-testid='bin-min']")).toHaveValue(
      "18",
    );
    await expect(firstBand.locator("[data-testid='bin-max']")).toHaveValue(
      "29",
    );
    // Editing a boundary persists across a reload.
    await firstBand.locator("[data-testid='bin-min']").fill("21");
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(
      page.locator(
        "[data-testid='bin-row'][data-band='18-29'] [data-testid='bin-min']",
      ),
    ).toHaveValue("21");
  });
});

// --- R13: re-deciding a run that has already finished ---------------------------------------------------

test.describe("re-decide finished run", () => {
  test("re-decide finished run — the confirmation shows the real count and the zero-cost statement", async ({
    page,
  }) => {
    await serveFinished(page, oneRankedConcept);
    // A gate2 pick for this concept must be HELD first: the gate3 spec's upstream link is recorded only
    // when the pick it points at actually exists (`write` stamps `upstream` iff the upstream decision is
    // held), so without an initial pick the re-pick has no downstream spec to count.
    await openGate2(page);
    await pickCandidate(
      page,
      page
        .locator("[data-testid='candidate-row']:not([data-chosen='true'])")
        .first(),
    );
    await openGate3(page);
    await page
      .locator("[data-testid='spec-note-input']")
      .first()
      .fill("downstream");
    await page.locator("[data-testid='spec-save']").first().click();

    await openGate2(page);
    // Re-pick again — now there is a downstream spec linked to this concept, so the confirmation appears.
    await pickCandidate(
      page,
      page
        .locator("[data-testid='candidate-row']:not([data-chosen='true'])")
        .first(),
    );
    const confirm = page.locator("[data-testid='repick-confirm']");
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText(
      "Regenerating them costs nothing — the candidates were already retrieved.",
    );
    await expect(confirm).not.toContainText("{N}");
    await expect(confirm).toContainText(/marks [1-9]\d* transform spec/);
  });

  test("re-decide finished run — the run stays finished and no scope-reopening control is reachable", async ({
    page,
  }) => {
    await serveFinished(page, oneRankedConcept);
    await openGate2(page);
    await pickCandidate(
      page,
      page
        .locator("[data-testid='candidate-row']:not([data-chosen='true'])")
        .first(),
    );
    // Buying more work is a later phase and must not become reachable from here.
    await expect(page.locator("[data-testid='reopen-scope']")).toHaveCount(0);
    await expect(page.locator("[data-testid='readjudicate']")).toHaveCount(0);
    await expect(page.locator("[data-testid='run-status']")).toHaveAttribute(
      "data-status",
      "complete",
    );
  });

  test("re-decide finished run — affected specs render stale after the change", async ({
    page,
  }) => {
    await serveFinished(page, oneRankedConcept);
    // Hold a gate2 pick for this concept first, so the gate3 spec below records its upstream link (see the
    // confirmation test) — otherwise the re-pick has nothing to mark stale.
    await openGate2(page);
    await pickCandidate(
      page,
      page
        .locator("[data-testid='candidate-row']:not([data-chosen='true'])")
        .first(),
    );
    await openGate3(page);
    await page
      .locator("[data-testid='spec-note-input']")
      .first()
      .fill("downstream");
    await page.locator("[data-testid='spec-save']").first().click();
    await expect(
      page.locator("[data-testid='spec-row'][data-stale='true']"),
    ).toHaveCount(0);

    await openGate2(page);
    await pickCandidate(
      page,
      page
        .locator("[data-testid='candidate-row']:not([data-chosen='true'])")
        .first(),
    );
    const confirm = page.locator("[data-testid='repick-confirm']");
    if (await confirm.isVisible())
      await page.locator("[data-testid='repick-accept']").click();

    await openGate3(page);
    // Staleness is DERIVED on read from the persisted upstream key, so it is here after a full navigation.
    await expect(
      page.locator("[data-testid='spec-row'][data-stale='true']").first(),
    ).toBeVisible();
  });

  test("re-decide finished run — with nothing downstream, no regeneration step is offered", async ({
    page,
  }) => {
    await serveFinished(page, oneRankedConcept);
    await openGate2(page);
    await pickCandidate(
      page,
      page
        .locator("[data-testid='candidate-row']:not([data-chosen='true'])")
        .first(),
    );
    // No spec decision exists, so there is nothing to regenerate and no confirmation to show.
    await expect(page.locator("[data-testid='repick-confirm']")).toHaveCount(0);
    await expect(page.locator("[data-testid='regenerate-specs']")).toHaveCount(
      0,
    );
  });

  test("re-decide finished run — staleness never cascades backwards from Gate 3 to Gate 2", async ({
    page,
  }) => {
    await serveFinished(page, oneRankedConcept);
    await openGate3(page);
    await page
      .locator("[data-testid='spec-note-input']")
      .first()
      .fill("an edit at gate 3");
    await page.locator("[data-testid='spec-save']").first().click();
    await openGate2(page);
    // A downstream edit says nothing about the upstream choice; marking Gate 2 stale for it would be a
    // notice reviewers learn to ignore.
    await expect(
      page.locator("[data-testid='candidate-row'][data-stale='true']"),
    ).toHaveCount(0);
  });
});

/**
 * 08-27 #3 — Gate 2/3 inherit the scope Gate 1 SHOWED, not a re-derivation.
 *
 * Gate 1 displays default-OUT (08-23b), but Gate 2's display filter and the backend's paid assign were
 * default-in (`chosen !== "out"`), so a group the reviewer never checked was billed and listed at Gate 2.
 * Continue now freezes the displayed scope on `config.gate1_scope`; every later screen reads THAT list.
 * A run with no frozen list (passed Gate 1 before 08-27) keeps the legacy default-in rule.
 */
test.describe("gate1 scope inheritance", () => {
  test("@gate2 the frozen Gate 1 list wins over decisions; no list keeps default-in", () => {
    const decisions = { a: { chosen: "in" }, b: { chosen: "out" } } as never;
    const frozen = inheritedGate1Scope({ gate1_scope: ["c"] }, decisions);
    expect([frozen("a"), frozen("b"), frozen("c")]).toEqual([false, false, true]);
    const legacy = inheritedGate1Scope({}, decisions);
    expect([legacy("a"), legacy("b"), legacy("c")]).toEqual([true, false, true]);
  });

  test("@gate1 an in-scope group emptied by moves is neither priced nor sent (08-27 audit B3)", () => {
    const groups = [{ groupId: "g0" }, { groupId: "g1" }, { groupId: "g2" }];
    const members: Record<string, number> = { g0: 0, g1: 3, g2: 2 };
    const billable = gate1BillableGroups(groups, () => true, (g) => members[g.groupId]);
    expect(billable.map((g) => g.groupId)).toEqual(["g1", "g2"]);
    // the Continue payload is built from the SAME list the price counts
    expect(gate1ScopePayload(billable.map((g) => g.groupId), () => true)).toEqual({ gate1Scope: ["g1", "g2"] });
  });

  test("@gate1 Continue sends exactly the groups Gate 1 shows in scope, in row order", () => {
    const shown = new Set(["g2", "g0"]);
    expect(gate1ScopePayload(["g0", "g1", "g2"], (g) => shown.has(g))).toEqual({ gate1Scope: ["g0", "g2"] });
  });

  test("@gate2 a run with a frozen scope lists only those groups", async ({ page }) => {
    let keptGroup = "";
    let keptCount = 0;
    await serveFinished(page, (run) => {
      const recs = run.result!.records;
      keptGroup = recs[0].groupId;
      keptCount = recs.filter((r) => r.groupId === keptGroup).length;
      run.config = { ...(run.config ?? {}), gate1_scope: [keptGroup] };
    });
    await openGate2(page);
    await expect(page.locator("[data-testid='gate2-concept']")).toHaveCount(keptCount);
  });

  test("@gate3 a run whose frozen scope matches no record lists nothing", async ({ page }) => {
    await serveFinished(page, (run) => {
      run.config = { ...(run.config ?? {}), gate1_scope: ["no-such-group"] };
    });
    await openGate3(page);
    await expect(page.locator("[data-testid='gate3-concept']")).toHaveCount(0);
  });
});


/**
 * 08-27 audit B1 — a Gate 3 save MERGES into the persisted decision; it never replaces it.
 *
 * Every control wrote a partial payload and the store replaces the row, so a note save wiped the value map,
 * Reject wiped the note + map, and any later edit silently dropped `rejected` (audit CBR ×3).
 */
test.describe("gate3 spec edits merge", () => {
  const SRC = "AI-READI:susmkncf";
  async function oneRow(page: Page): Promise<Locator> {
    await serveFinished(
      page,
      (run) => {
        run.result!.records = [run.result!.records!.find((x) => x.groupId === "c46be33d9a542#g0")!];
      },
      { keep: 0 },
    );
    await openGate3(page);
    const row = page.locator(`[data-testid='spec-row'][data-source='${SRC}']`);
    await expect(row).toBeVisible();
    return row;
  }
  const chip = (row: Locator, code: string) => row.locator(`[data-testid='spec-value-chip'][data-code='${code}']`);
  const bucket = (row: Locator, b: string) => row.locator(`[data-testid='spec-bucket'][data-bucket='${b}']`);

  test("@gate3 mergeSpecEdit overlays the patch on every persisted edit field and drops a cleared reject", () => {
    const prev = { note: "n", mapping: { "1": "No" }, rejected: true, chosen: "", optionSetKey: "k" };
    expect(mergeSpecEdit(prev, { note: "m" })).toEqual({ note: "m", mapping: { "1": "No" }, rejected: true });
    expect(mergeSpecEdit(prev, { rejected: false })).toEqual({ note: "n", mapping: { "1": "No" } });
    expect(mergeSpecEdit(undefined, { bins: [] })).toEqual({ bins: [] });
  });

  test("@gate3 saving a note after a drag keeps the drag, across a reload", async ({ page }) => {
    const row = await oneRow(page);
    await chip(row, "1").dragTo(bucket(row, "No"));
    await expect(bucket(row, "No").locator("[data-code='1']")).toBeVisible();
    await row.locator("[data-testid='spec-note-input']").fill("checked the recode");
    await row.locator("[data-testid='spec-save']").click();
    await expect(row.locator("[data-testid='spec-saved']")).toBeVisible();
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(bucket(row, "No").locator("[data-code='1']")).toBeVisible();
    await expect(row.locator("[data-testid='spec-note-input']")).toHaveValue("checked the recode");
  });

  test("@gate3 reject keeps the note and map, locks the editor, and un-reject restores them", async ({ page }) => {
    const row = await oneRow(page);
    await chip(row, "1").dragTo(bucket(row, "No"));
    await row.locator("[data-testid='spec-note-input']").fill("why");
    await row.locator("[data-testid='spec-save']").click();
    await row.locator("[data-testid='spec-reject']").click();
    await row.locator("[data-testid='reject-accept']").click();
    await expect(row.locator("[data-testid='spec-edited-badge']")).toHaveText("rejected");
    // a rejected recode is not silently un-rejected by a drag: its editor is folded away (H10), and read-only when
    // the reviewer opens it to look
    await row.locator("[data-testid='spec-rejected-toggle']").click();
    await expect(chip(row, "0")).toHaveAttribute("draggable", "false");
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(row.locator("[data-testid='spec-edited-badge']")).toHaveText("rejected");
    await expect(row.locator("[data-testid='spec-note-input']")).toHaveValue("why");
    await row.locator("[data-testid='spec-unreject']").click();
    await expect(row.locator("[data-testid='spec-edited-badge']")).toHaveText("edited");
    await expect(bucket(row, "No").locator("[data-code='1']")).toBeVisible();
    await expect(row.locator("[data-testid='spec-note-input']")).toHaveValue("why");
  });

  test("@gate3 H10 — a rejected row folds its mapping away, says what rejecting did, and asks why", async ({ page }) => {
    // Bhargav 2026-10-05 ("build as proposed"): a rejected row still showed the whole editor, and its header still
    // read "→ 5 codes mapped · coverage 100%" as if the recode would be exported.
    const row = await oneRow(page);
    const summary = row.locator("[data-testid='spec-row-summary']");
    const before = (await summary.textContent()) ?? "";
    await expect(row.locator("[data-testid='spec-mapping-editor']")).toHaveCount(1);
    await row.locator("[data-testid='spec-reject']").click();
    await row.locator("[data-testid='reject-accept']").click();

    await expect(row).toHaveAttribute("data-rejected", "true");
    await expect(row).toHaveCSS("border-top-style", "dashed");
    await expect(row.locator("[data-testid='spec-mapping-editor']")).toHaveCount(0);
    await expect(row.locator("[data-testid='spec-rejected-note']")).toContainText(
      /left out of the notebook and the mapping table/i,
    );
    await expect(row.locator("[data-testid='spec-rejected-note']")).toContainText(/Un-reject/);
    await expect(summary).toHaveText("not exported — rejected");
    await expect(row.locator("[data-testid='spec-row-coverage']")).toHaveCount(0);
    await expect(row.locator("[data-testid='spec-note-input']")).toHaveAttribute(
      "placeholder",
      "Why was it rejected? (optional)",
    );
    await expect(row.locator("[data-testid='spec-save']")).toHaveText("Save note");

    // The disclosure shows the rejected mapping read-only, and folds it again.
    const toggle = row.locator("[data-testid='spec-rejected-toggle']");
    await expect(toggle).toHaveText(/Show the rejected mapping/);
    await toggle.click();
    await expect(row.locator("[data-testid='spec-mapping-editor']")).toHaveCount(1);
    await expect(toggle).toHaveText(/Hide the rejected mapping/);
    await toggle.click();
    await expect(row.locator("[data-testid='spec-mapping-editor']")).toHaveCount(0);

    // Un-reject puts the row back exactly as it was.
    await row.locator("[data-testid='spec-unreject']").click();
    await expect(row).toHaveAttribute("data-rejected", "false");
    await expect(row).toHaveCSS("border-top-style", "solid");
    await expect(row.locator("[data-testid='spec-mapping-editor']")).toHaveCount(1);
    await expect(row.locator("[data-testid='spec-rejected-toggle']")).toHaveCount(0);
    await expect(summary).toHaveText(before);
    await expect(row.locator("[data-testid='spec-note-input']")).toHaveAttribute("placeholder", "Your note on this recode");
    await expect(row.locator("[data-testid='spec-save']")).toHaveText("Save");
  });

  test("@gate3 an unsaved note in one row survives typing in another", async ({ page }) => {
    await serveFinished(page);
    await openGate3(page);
    const inputs = page.locator("[data-testid='spec-note-input']");
    // pick the first concept that carries at least two spec rows
    const concepts = page.locator("[data-testid='gate3-concept']");
    const n = await concepts.count();
    for (let i = 0; i < n && (await inputs.count()) < 2; i++) await concepts.nth(i).click();
    expect(await inputs.count()).toBeGreaterThanOrEqual(2);
    await inputs.nth(0).fill("draft A");
    await inputs.nth(1).fill("draft B");
    await expect(inputs.nth(0)).toHaveValue("draft A");
  });
});

/** 08-27 audit B2 — saving anchor text never changes the target as a side effect. */
test.describe("gate2 anchor save keeps the target", () => {
  for (const [groupId, target] of [
    ["c46be33d9a542#g0", "Tobacco smoked 100 cigarettes indicator"], // adopt, no GenCDE
    ["c0a367d9fb0eb#g0", "Have you ever used any of these drugs"], // refine, a GenCDE exists
  ] as const) {
    test(`@gate2 saving anchor edits on ${groupId} keeps its catalog target`, async ({ page }) => {
      await serveFinished(
        page,
        (run) => {
          run.result!.records = [run.result!.records!.find((x) => x.groupId === groupId)!];
        },
        { keep: 0 },
      );
      await openGate2(page);
      const header = page.locator("[data-testid='current-target']");
      await expect(header).toContainText(target);
      await page.locator("[data-testid='gencde-definition-input']").fill("A reviewer's anchor wording.");
      await page.locator("[data-testid='gencde-save']").click();
      await expect(header).toContainText(target);
      await page.reload();
      await page.waitForLoadState("networkidle");
      await expect(header).toContainText(target);
      await expect(page.locator("[data-testid='gencde-definition-input']")).toHaveValue(
        "A reviewer's anchor wording.",
      );
    });
  }
});


/** 08-27 option C — a Gate 1 rename reaches Gate 2 and Gate 3 (it only ever showed on Gate 1 and in the log). */
test.describe("gate1 rename carries forward", () => {
  const GROUP = "c46be33d9a542#g0";
  async function seedRename(page: Page, gate: "gate2" | "gate3") {
    await serveFinished(page, (run) => {
      run.result!.records = [run.result!.records!.find((x) => x.groupId === GROUP)!];
    }, { keep: 0 });
    await page.goto(`/run/${FINISHED_JOB}/${gate}`);
    await page.waitForLoadState("networkidle");
    const state = withGateDecision({}, "gate1_rename", GROUP, {
      groupId: GROUP,
      chosen: "Ever smoked 100 cigarettes",
      alternatives: ["generated", "Ever smoked 100 cigarettes"],
      optionSetKey: optionSetKey(["generated", "Ever smoked 100 cigarettes"]),
    });
    await page.evaluate(
      ({ key, state }) => sessionStorage.setItem(key, JSON.stringify(state)),
      { key: `${SANDBOX_PREFIX}${FINISHED_JOB}`, state },
    );
    await page.reload();
    await page.waitForLoadState("networkidle");
  }
  test("@gate2 the reviewer's group name is what Gate 2 lists", async ({ page }) => {
    await seedRename(page, "gate2");
    await expect(page.locator("[data-testid='gate2-concept']").first()).toContainText("Ever smoked 100 cigarettes");
  });
  test("@gate3 the reviewer's group name is what Gate 3 lists", async ({ page }) => {
    await seedRename(page, "gate3");
    await expect(page.locator("[data-testid='gate3-concept']").first()).toContainText("Ever smoked 100 cigarettes");
  });
});

/**
 * 08-28 follow-ups #1 and #4 — what Gate 2 says about a group the reviewer reshaped at Gate 1.
 *
 * Option B (2026-09-18): an EDITED group was assigned against an ideal description regenerated for its final
 * members, and the record says so (`idealRegenerated`, set by the backend only where it happened). A PART of an
 * accepted division (`readjudicatedFrom`) says it is one. Neither claim is made for a record that lacks the flag.
 */
test.describe("gate2 reshaped at gate 1", () => {
  const GROUP = "c46be33d9a542#g0";
  const PART = "rev:00000000-0000-4000-8000-00000000000c";

  async function open(page: Page, shape: (r: UIRecord) => UIRecord, touch: string) {
    await serveFinished(
      page,
      (run) => {
        run.result!.records = [shape(run.result!.records!.find((x) => x.groupId === GROUP)!)];
        run.config = { ...(run.config as object), gate1_overrides: { moves: {}, newGroups: [] } } as never;
      },
      { keep: 0 },
    );
    await openGate2(page);
    const alts = [GROUP, "__unassigned__", touch];
    const state = withGateDecision({}, "gate1_regroup", "A:x", {
      memberId: "A:x",
      fromGroupId: GROUP,
      chosen: touch,
      alternatives: alts,
      optionSetKey: optionSetKey(alts),
    });
    await page.evaluate(
      ({ key, state }) => sessionStorage.setItem(key, JSON.stringify(state)),
      { key: `${SANDBOX_PREFIX}${FINISHED_JOB}`, state },
    );
    await page.reload();
    await page.waitForLoadState("networkidle");
    return page.locator("[data-testid='membership-changed']");
  }

  test("@gate2 an edited group whose ideal was regenerated says so", async ({ page }) => {
    const note = await open(page, (r) => ({ ...r, idealRegenerated: true }), "__unassigned__");
    await expect(note).toContainText(/ideal description was regenerated/i);
  });

  test("@gate2 an edited group WITHOUT the flag claims no regeneration", async ({ page }) => {
    const note = await open(page, (r) => r, "__unassigned__");
    await expect(note).toBeVisible();
    await expect(note).not.toContainText(/regenerated/i);
  });

  test("@gate2 a part of an accepted division says it is one", async ({ page }) => {
    const note = await open(page, (r) => ({ ...r, groupId: PART, id: PART, readjudicatedFrom: GROUP }), PART);
    await expect(note).toContainText(/one part of a division you accepted/i);
  });
});
