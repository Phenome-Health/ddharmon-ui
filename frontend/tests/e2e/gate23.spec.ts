import { expect, test, type Locator, type Page } from "@playwright/test";
import type { JobResult } from "@/types";
import {
  SKOS_RELATIONS,
  affectedSpecCount,
  autoAdoptsSingleCandidate,
  candidateListState,
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
    expect(specState({ kind: "none" }, { specsGenerated: true })).toBe(
      "no-transform",
    );
    expect(specState(undefined, { specsGenerated: true })).toBe("failed");
    expect(specState(undefined, { specsGenerated: false })).toBe(
      "not-generated",
    );
  });

  test("@gate3 spec rows are driven by the MEMBERS so a failed spec still gets a row", () => {
    // Iterating the transforms can only show variables that produced one, which makes the failure
    // invisible — the omission the whole three-state split exists to prevent.
    const rows = specRowsFor(
      {
        members: ["UKBB:age", "AOU:age"],
        transforms: [{ sourceVariable: "UKBB:age", kind: "unit" } as never],
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
    expect(specForm("none")).toBe("passthrough");
    expect(specForm("identity")).toBe("passthrough");
    expect(specForm("wide_to_long")).toBe("other");
  });

  test("@gate3 a target is numeric when it has no enumerated permissible values", () => {
    expect(targetIsNumeric("Number", [])).toBe(true);
    expect(targetIsNumeric(undefined, [])).toBe(true); // no PVs, no declared type -> nothing to map INTO
    expect(targetIsNumeric("categorical", ["Yes", "No"])).toBe(false);
    expect(targetIsNumeric("categorical", [])).toBe(false); // explicit categorical wins the no-PV tiebreak
    expect(targetIsNumeric("text", [])).toBe(false);
    expect(targetIsNumeric("date", [])).toBe(false);
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
    const filter = page.locator("[data-testid='arithmetic-filter']");
    await expect(filter).toBeVisible();
    await filter.click();
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
        { ...rec.transforms[0], kind: "none", sourceVariable: rec.members[0] },
      ];
    });
    await openGate3(page);
    const none = page
      .locator("[data-testid='spec-row'][data-state='no-transform']")
      .first();
    await expect(none).toBeVisible();
    await expect(none).toContainText("No transform required");
    await expect(none).not.toContainText("did not generate");
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
