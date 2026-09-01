import { expect, test, type Page } from "@playwright/test";
import {
  SKOS_RELATIONS,
  affectedSpecCount,
  autoAdoptsSingleCandidate,
  candidateListState,
  conceptMatchState,
  needsRepickConfirmation,
  repickConfirmation,
  routesToReview,
  specForm,
  specRowsFor,
  specState,
  suggestedRelation,
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

// --- the algebra, asserted in node ---------------------------------------------------------------------

test.describe("gate23 algebra", () => {
  test("@gate2 a retrieval failure and a genuine novel are different states", () => {
    // The pair the contract carries no flag for, and the reason this function is derived rather than read.
    // An ASSESSED absence is a decision; an UNASSESSED one is silence, and rendering silence as "no match
    // exists" is the tool vouching for a conclusion no stage reached.
    expect(candidateListState({ candidates: [], verdict: "novel", gencde: null })).toBe("novel");
    expect(candidateListState({ candidates: [], verdict: "unclassified", gencde: null })).toBe("failed");
    expect(
      candidateListState({ candidates: [{ rank: 1 } as never], verdict: "adopt", gencde: null }),
    ).toBe("ranked");
  });

  test("@gate2 a lone candidate is never auto-adopted", () => {
    // Stated as a rule rather than left as an omission: "only one option" is not evidence the option fits,
    // and the adopt floor exists because a single far-cosine hit is the case most likely to be wrong.
    expect(autoAdoptsSingleCandidate()).toBe(false);
  });

  test("@gate2 the relation vocabulary is SKOS and the suggestion follows the verdict", () => {
    expect(SKOS_RELATIONS).toContain("skos:exactMatch");
    expect(suggestedRelation({ verdict: "adopt", gencde: null })).toBe("skos:exactMatch");
    // A refined element carries core's own stamped predicate, so the browser proposes what core wrote
    // rather than a second opinion.
    expect(
      suggestedRelation({ verdict: "refine", gencde: { relation: "skos:narrowMatch" } as never }),
    ).toBe("skos:narrowMatch");
  });

  test("@gate3 arithmetic always routes to review, regardless of the pipeline's own flag", () => {
    // A category of risk, not a property of one row: an arithmetic recode produces plausible numbers when
    // it is wrong, so no value of `needsReview` may switch this off.
    expect(routesToReview({ kind: "arithmetic", needsReview: false })).toBe(true);
    expect(routesToReview({ kind: "categorical", needsReview: false })).toBe(false);
    expect(routesToReview({ kind: "categorical", needsReview: true })).toBe(true);
  });

  test("@gate3 zero, one and many unmapped values are three states", () => {
    expect(unmappedState({ unmappedSourceCodes: [] })).toBe("none");
    expect(unmappedState({ unmappedSourceCodes: ["9"] })).toBe("one");
    expect(unmappedState({ unmappedSourceCodes: ["9", "8"] })).toBe("many");
  });

  test("@gate3 a failed spec, a no-transform spec and a not-generated run are three states", () => {
    // The pair that matters: `failed` means the stage ran and produced nothing for this variable;
    // `not-generated` means the run never bought the stage. Opposite claims, identical emptiness.
    expect(specState({ kind: "categorical" }, { specsGenerated: true })).toBe("ok");
    expect(specState({ kind: "none" }, { specsGenerated: true })).toBe("no-transform");
    expect(specState(undefined, { specsGenerated: true })).toBe("failed");
    expect(specState(undefined, { specsGenerated: false })).toBe("not-generated");
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
    expect(conceptMatchState({ conceptMismatch: undefined }, { optedIn: false })).toBe("not-enabled");
    expect(conceptMatchState({ conceptMismatch: undefined }, { optedIn: true })).toBe("not-enabled");
    expect(conceptMatchState({ conceptMismatch: false }, { optedIn: true })).toBe("clear");
    expect(conceptMatchState({ conceptMismatch: true }, { optedIn: true })).toBe("flagged");
  });

  test("@gate3 specForm maps the contract's kinds onto the three editing surfaces", () => {
    expect(specForm("categorical")).toBe("categorical");
    expect(specForm("unit")).toBe("unit");
    expect(specForm("arithmetic")).toBe("arithmetic");
    expect(specForm("none")).toBe("passthrough");
    expect(specForm("identity")).toBe("passthrough");
    expect(specForm("wide_to_long")).toBe("other");
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
    expect(repickConfirmation(2)).toContain("costs nothing — the candidates were already retrieved");
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
  test("@gate2 the anchor renders BEFORE the ranked candidates", async ({ page }) => {
    await serveFinished(page);
    await openGate2(page);
    const anchor = page.locator("[data-testid='ideal-anchor']");
    const list = page.locator("[data-testid='candidate-list']");
    await expect(anchor).toBeVisible();
    await expect(list).toBeVisible();
    // Document order, not styling: the anchor is the target the candidates are judged against, and
    // showing it after them inverts the reasoning.
    const anchorFirst = await page.evaluate(() => {
      const a = document.querySelector("[data-testid='ideal-anchor']");
      const l = document.querySelector("[data-testid='candidate-list']");
      if (!a || !l) return false;
      return !!(a.compareDocumentPosition(l) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    expect(anchorFirst).toBe(true);
  });

  test("@gate2 a re-pick moves the chosen marker and survives a reload", async ({ page }) => {
    await serveFinished(page);
    await openGate2(page);
    const cards = page.locator("[data-testid='candidate-card']");
    await expect(cards.first()).toBeVisible();
    const target = cards.nth(2);
    const id = await target.getAttribute("data-candidate-id");
    await target.click();
    await expect(page.locator(`[data-candidate-id='${id}']`)).toHaveAttribute("data-chosen", "true");
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(page.locator(`[data-candidate-id='${id}']`)).toHaveAttribute("data-chosen", "true");
  });

  test("@gate2 a generated element carries no catalog badge, no identifier link and no endorsement", async ({
    page,
  }) => {
    await serveFinished(page);
    await openGate2(page);
    const gen = page.locator("[data-testid='candidate-card'][data-generated='true']").first();
    await expect(gen).toBeVisible();
    await expect(gen).toContainText("generated by ddharmon");
    await expect(gen.locator("[data-testid='candidate-collection']")).toHaveCount(0);
    await expect(gen.locator("[data-testid='candidate-endorsement']")).toHaveCount(0);
    await expect(gen.locator("a")).toHaveCount(0);
  });

  test("@gate2 the retired third abbreviation appears nowhere on the surface", async ({ page }) => {
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
    await expect(page.locator("[data-testid='retrieval-failed']")).toHaveCount(0);

    await page.locator("[data-testid='gate2-concept']").nth(1).click();
    await expect(page.locator("[data-testid='retrieval-failed']")).toBeVisible();
    await expect(page.locator("[data-testid='novel-path']")).toHaveCount(0);
    // A failure must not claim no match exists — that is the whole distinction.
    await expect(page.locator("[data-testid='retrieval-failed']")).not.toContainText("no match");
  });

  test("@gate2 a single candidate shows its score and is not marked chosen automatically", async ({
    page,
  }) => {
    await serveFinished(page, (run) => {
      const rec = run.result!.records![0];
      rec.candidates = [{ ...rec.candidates[0], isChosen: false, rank: 1 }];
      rec.floored = true;
    });
    await openGate2(page);
    await page.locator("[data-testid='gate2-concept']").first().click();
    const cards = page.locator("[data-testid='candidate-card']");
    await expect(cards).toHaveCount(1);
    await expect(cards.first()).toHaveAttribute("data-chosen", "false");
    await expect(cards.first().locator("[data-testid='candidate-score']")).toBeVisible();
    await expect(page.locator("[data-testid='adopt-floor-note']")).toBeVisible();
  });

  test("@gate2 the knowledge-graph tile renders with its stated copy and no destructive colour", async ({
    page,
  }) => {
    await serveFinished(page);
    await openGate2(page);
    const tile = page.locator("[data-testid='not-available'][data-thing='knowledge-graph']");
    await expect(tile).toBeVisible();
    await expect(tile).toContainText("Knowledge-graph context — not available.");
    await expect(tile).toContainText("no query path into KRAKEN");
    // Deferred by design and failed to build are different claims and must not look alike.
    const destructive = await tile.evaluate((el) => {
      const seen: string[] = [];
      for (const node of [el, ...Array.from(el.querySelectorAll("*"))]) {
        const s = getComputedStyle(node as Element);
        seen.push(s.color, s.borderTopColor, s.backgroundColor);
      }
      const bad = getComputedStyle(document.documentElement)
        .getPropertyValue("--status-destructive")
        .trim();
      return { seen, bad };
    });
    expect(destructive.seen.join(" ")).not.toContain(destructive.bad);
  });

  test("@gate2 the CDEMapper credit cites the paper and claims no better recall", async ({ page }) => {
    await serveFinished(page);
    await openGate2(page);
    const credit = page.locator("[data-testid='cdemapper-credit']");
    await expect(credit).toBeVisible();
    await expect(credit).toContainText("JAMIA");
    await expect(credit).toContainText("10.1093/jamia/ocaf064");
    await expect(credit).toContainText("convergent method");
    // The standing framing constraint, asserted as an absence: we do not beat CDEMapper on recall.
    await expect(credit).not.toContainText(/better recall|outperform|beats|higher recall/i);
  });

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
    await expect(page.locator("[data-testid='gencde-definition-input']")).toHaveValue(
      "A reviewer-corrected definition.",
    );
  });

  test("@gate2 nothing sent to this gate renders the empty state, never a blank pane", async ({ page }) => {
    await servePaused(page);
    await openGate2(page, PAUSED_JOB);
    const empty = page.locator("[data-testid='gate-empty-state']");
    await expect(empty).toBeVisible();
    await expect(empty).toContainText("Nothing was sent to Gate 2");
  });

  test("@gate2 the source rows are the shared component, themed from role tokens", async ({ page }) => {
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

  test("@gate2 the retrieval-score histogram is present and the deferred views are not", async ({
    page,
  }) => {
    await serveFinished(page);
    await openGate2(page);
    // Taken from `analytics.tsx` because it shows where the retrieval floor is cutting, which is the
    // decision this screen makes. The other three views belong to Gate 4 and must not appear here.
    await expect(page.locator("[data-testid='retrieval-histogram']")).toBeVisible();
    await expect(page.locator("[data-testid='match-sankey']")).toHaveCount(0);
    await expect(page.locator("[data-testid='cohort-coverage-chart']")).toHaveCount(0);
    await expect(page.locator("[data-testid='overlap-heatmap']")).toHaveCount(0);
  });

  test("@gate2 the relation control persists a relation for the chosen target", async ({ page }) => {
    await serveFinished(page);
    await openGate2(page);
    const control = page.locator("[data-testid='relation-control']");
    await expect(control).toBeVisible();
    const option = control.locator("[data-relation='skos:narrowMatch']");
    await option.click();
    await expect(option).toHaveAttribute("data-state", "on");
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(
      page.locator("[data-testid='relation-control'] [data-relation='skos:narrowMatch']"),
    ).toHaveAttribute("data-state", "on");
  });

  test("@gate2 the concept-match decision renders as an honest absence, not a dead control", async ({
    page,
  }) => {
    await serveFinished(page);
    await openGate2(page);
    const tile = page.locator("[data-testid='not-available'][data-thing='concept-gate']");
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
  test("@gate3 specs group by concept and the three forms render distinctly", async ({ page }) => {
    await serveFinished(page);
    await openGate3(page);
    await expect(page.locator("[data-testid='spec-group']").first()).toBeVisible();
    const forms = await page
      .locator("[data-testid='spec-row']")
      .evaluateAll((els) => [...new Set(els.map((e) => e.getAttribute("data-form")))]);
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
      els.map((e) => ({ form: e.getAttribute("data-form"), review: e.getAttribute("data-review") })),
    );
    expect(all.length).toBeGreaterThan(0);
    // A category of risk, not a property of one row.
    expect(all.every((r) => r.form === "arithmetic" && r.review === "true")).toBe(true);
  });

  test("@gate3 zero, one and many unmapped values render distinct text", async ({ page }) => {
    await serveFinished(page, (run) => {
      const recs = run.result!.records!;
      recs[0].transforms = [
        { ...recs[0].transforms[0], kind: "categorical", sourceVariable: recs[0].members[0], unmappedSourceCodes: [] },
      ];
      recs[1].transforms = [
        { ...recs[1].transforms[0], kind: "categorical", sourceVariable: recs[1].members[0], unmappedSourceCodes: ["9"] },
      ];
      recs[2].transforms = [
        {
          ...recs[2].transforms[0],
          kind: "categorical",
          sourceVariable: recs[2].members[0],
          unmappedSourceCodes: ["9", "8", "7"],
        },
      ];
    });
    await openGate3(page);
    const texts = await page
      .locator("[data-testid='unmapped']")
      .evaluateAll((els) => els.map((e) => e.textContent ?? ""));
    // Singular is not a plural with a 1 in front of it.
    expect(texts.some((t) => /1 source value/.test(t))).toBe(true);
    expect(texts.some((t) => /3 source values/.test(t))).toBe(true);
    await expect(page.locator("[data-testid='unmapped'][data-state='none']").first()).toBeVisible();
  });

  test("@gate3 an unmapped value offers all three explicit outcomes", async ({ page }) => {
    await serveFinished(page, (run) => {
      const rec = run.result!.records![0];
      rec.transforms = [
        { ...rec.transforms[0], kind: "categorical", sourceVariable: rec.members[0], unmappedSourceCodes: ["9"] },
      ];
    });
    await openGate3(page);
    const decision = page.locator("[data-testid='unmapped-decision']").first();
    await expect(decision).toBeVisible();
    // Silently dropping the value is how a harmonization quietly loses data, so the loss is a CHOICE.
    for (const outcome of ["add", "missing", "accept-loss"]) {
      await expect(decision.locator(`[data-outcome='${outcome}']`)).toBeVisible();
    }
  });

  test("@gate3 a failed spec renders as failed, routes to review, and is present in the list", async ({
    page,
  }) => {
    await serveFinished(page, (run) => {
      const rec = run.result!.records![0];
      // The stage ran for this run and produced nothing for this variable. Omitting the row would delete
      // the only evidence the variable was ever in scope.
      rec.transforms = rec.transforms.filter((t) => t.sourceVariable !== rec.members[0]);
    });
    await openGate3(page);
    const failed = page.locator("[data-testid='spec-row'][data-state='failed']").first();
    await expect(failed).toBeVisible();
    await expect(failed).toHaveAttribute("data-review", "true");
    await expect(failed).toContainText("did not generate");
  });

  test("@gate3 no-transform-required is distinct from not-generated", async ({ page }) => {
    await serveFinished(page, (run) => {
      const rec = run.result!.records![0];
      rec.transforms = [{ ...rec.transforms[0], kind: "none", sourceVariable: rec.members[0] }];
    });
    await openGate3(page);
    const none = page.locator("[data-testid='spec-row'][data-state='no-transform']").first();
    await expect(none).toBeVisible();
    await expect(none).toContainText("No transform required");
    await expect(none).not.toContainText("did not generate");
  });

  test("@gate3 with the opt-in off the concept-match check is an honest, named absence", async ({
    page,
  }) => {
    await serveFinished(page);
    await openGate3(page);
    const tile = page.locator("[data-testid='not-available'][data-thing='concept-gate']");
    await expect(tile).toBeVisible();
    await expect(tile).toHaveAttribute("data-claim", "not-enabled");
    await expect(tile).toContainText("Concept-match check — not enabled for this run.");
    // Never a silent pass, and never a permanent product gap: the capability exists, this run did not buy it.
    await expect(page.locator("[data-testid='concept-match-flag']")).toHaveCount(0);
    await expect(tile).not.toContainText(/not supported|cannot|never/i);
  });

  test("@gate3 on an opted-in run a flagged spec shows the flag and routes to review", async ({ page }) => {
    await serveFinished(page, (run) => {
      run.config = { ...(run.config as object), conceptGate: true };
      const rec = run.result!.records![0];
      rec.conceptMismatch = true;
      rec.transforms = [{ ...rec.transforms[0], kind: "categorical", sourceVariable: rec.members[0] }];
      run.result!.records![1].conceptMismatch = false;
    });
    await openGate3(page);
    const flag = page.locator("[data-testid='concept-match-flag']").first();
    await expect(flag).toBeVisible();
    // Right values, wrong concept — the failure the coherence gate structurally cannot see.
    const row = page.locator("[data-testid='spec-row'][data-concept-mismatch='true']").first();
    await expect(row).toHaveAttribute("data-review", "true");
    await expect(page.locator("[data-testid='not-available'][data-thing='concept-gate']")).toHaveCount(0);
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
    await expect(page.locator("[data-testid='spec-note-input']").first()).toHaveValue(
      "Checked against the source dictionary.",
    );
  });

  test("@gate3 a spec edit survives a CONCEPT SWITCH with no reload", async ({ page }) => {
    // The distinct failure mode: the client patches its local record on a successful write instead of only
    // toasting, and the detail card does not re-seed its draft from a stale prop on id change.
    await serveFinished(page);
    await openGate3(page);
    const first = page.locator("[data-testid='spec-concept']").first();
    await first.click();
    const input = page.locator("[data-testid='spec-note-input']").first();
    await input.fill("A reviewer's note that must survive.");
    await page.locator("[data-testid='spec-save']").first().click();
    await page.locator("[data-testid='spec-concept']").nth(1).click();
    await first.click();
    await expect(page.locator("[data-testid='spec-note-input']").first()).toHaveValue(
      "A reviewer's note that must survive.",
    );
  });

  test("@gate3 rejecting a recode states exactly what rejection means", async ({ page }) => {
    await serveFinished(page);
    await openGate3(page);
    await page.locator("[data-testid='spec-reject']").first().click();
    const confirm = page.locator("[data-testid='reject-confirm']");
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText(
      "It will be excluded from the notebook and the mapping table, and recorded as rejected in the decision log.",
    );
  });

  test("@gate3 zero specs renders the empty state with its stated copy", async ({ page }) => {
    await servePaused(page);
    await openGate3(page, PAUSED_JOB);
    const empty = page.locator("[data-testid='gate-empty-state']");
    await expect(empty).toBeVisible();
    await expect(empty).toContainText("No transform specs to review");
  });
});

// --- R13: re-deciding a run that has already finished ---------------------------------------------------

test.describe("re-decide finished run", () => {
  test("re-decide finished run — the confirmation shows the real count and the zero-cost statement", async ({
    page,
  }) => {
    await serveFinished(page);
    await openGate2(page);
    // Make a spec decision downstream of this concept's pick first, so the count is non-zero and REAL.
    await page.locator("[data-testid='candidate-card']").nth(1).click();
    await openGate3(page);
    await page.locator("[data-testid='spec-note-input']").first().fill("downstream");
    await page.locator("[data-testid='spec-save']").first().click();

    await openGate2(page);
    await page.locator("[data-testid='candidate-card']").nth(3).click();
    const confirm = page.locator("[data-testid='repick-confirm']");
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText("Regenerating them costs nothing — the candidates were already retrieved.");
    await expect(confirm).not.toContainText("{N}");
    await expect(confirm).toContainText(/marks [1-9]\d* transform spec/);
  });

  test("re-decide finished run — the run stays finished and no scope-reopening control is reachable", async ({
    page,
  }) => {
    await serveFinished(page);
    await openGate2(page);
    await page.locator("[data-testid='candidate-card']").nth(2).click();
    // Buying more work is a later phase and must not become reachable from here.
    await expect(page.locator("[data-testid='reopen-scope']")).toHaveCount(0);
    await expect(page.locator("[data-testid='readjudicate']")).toHaveCount(0);
    await expect(page.locator("[data-testid='run-status']")).toHaveAttribute("data-status", "complete");
  });

  test("re-decide finished run — affected specs render stale after the change", async ({ page }) => {
    await serveFinished(page);
    await openGate2(page);
    await page.locator("[data-testid='candidate-card']").nth(1).click();
    await openGate3(page);
    await page.locator("[data-testid='spec-note-input']").first().fill("downstream");
    await page.locator("[data-testid='spec-save']").first().click();
    await expect(page.locator("[data-testid='spec-row'][data-stale='true']")).toHaveCount(0);

    await openGate2(page);
    await page.locator("[data-testid='candidate-card']").nth(4).click();
    const confirm = page.locator("[data-testid='repick-confirm']");
    if (await confirm.isVisible()) await page.locator("[data-testid='repick-accept']").click();

    await openGate3(page);
    // Staleness is DERIVED on read from the persisted upstream key, so it is here after a full navigation.
    await expect(page.locator("[data-testid='spec-row'][data-stale='true']").first()).toBeVisible();
  });

  test("re-decide finished run — with nothing downstream, no regeneration step is offered", async ({
    page,
  }) => {
    await serveFinished(page);
    await openGate2(page);
    await page.locator("[data-testid='candidate-card']").nth(2).click();
    // No spec decision exists, so there is nothing to regenerate and no confirmation to show.
    await expect(page.locator("[data-testid='repick-confirm']")).toHaveCount(0);
    await expect(page.locator("[data-testid='regenerate-specs']")).toHaveCount(0);
  });

  test("re-decide finished run — staleness never cascades backwards from Gate 3 to Gate 2", async ({
    page,
  }) => {
    await serveFinished(page);
    await openGate3(page);
    await page.locator("[data-testid='spec-note-input']").first().fill("an edit at gate 3");
    await page.locator("[data-testid='spec-save']").first().click();
    await openGate2(page);
    // A downstream edit says nothing about the upstream choice; marking Gate 2 stale for it would be a
    // notice reviewers learn to ignore.
    await expect(page.locator("[data-testid='candidate-card'][data-stale='true']")).toHaveCount(0);
  });
});
