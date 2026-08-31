import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  PARTICIPANT_ID_HEADERS,
  assignRole,
  nameCheck,
  normalizeHeader,
  participantLevelColumn,
} from "@/lib/dictionary";
import { SCOPE_VERDICT_COPY, declaredComponents } from "@/lib/score-scope";
import { PROVIDER_KEY_INFO, keyPlaceholderFor } from "@/lib/provider-keys";
import { PAUSED_RUN_FIXTURE } from "./routes";
import { RETIRED_GATE, setupPathFor, startedPathFor } from "@/lib/gate-routes";

/**
 * Setup — the first of the six staged-review screens (08-13).
 *
 * Setup's whole job is INFORMED CONSENT TO SPEND, so the assertions here are weighted towards the two
 * things a reviewer is asked to believe: that nothing has been charged yet, and that the quoted figure is
 * the one they will be billed. Everything else on the screen exists to stop a variable disappearing
 * silently before either claim is made.
 *
 *   run: npm run test:e2e -- --grep "@setup"
 *
 * THE PURE HALF FIRST, deliberately. The duplicate-name check and the participant-level refusal are both
 * decisions about a file, and both are the kind of thing that gets weakened by accident — so they live in
 * `@/lib/dictionary` as plain functions and are asserted here without a browser. A rule that can only be
 * checked by driving a page is a rule that stops being checked.
 */

const SETUP = `/run/${PAUSED_RUN_FIXTURE}/setup`;
/** A jobId no fixture answers for — Setup's COMPOSE mode, which is the normal pre-run case. */
const DRAFT = "/run/draft-08-13/setup";

function csv(rows: string[][]): string {
  return rows.map((r) => r.join(",")).join("\n");
}

/** A dictionary: one row per VARIABLE. */
function dictionaryCsv(n: number, { repeat = false }: { repeat?: boolean } = {}): string {
  const header = ["variable_name", "description", "units"];
  const body = Array.from({ length: n }, (_, i) => [
    repeat && i % 2 === 1 ? `var_${i - 1}` : `var_${i}`,
    `a description of variable ${i}`,
    "kg",
  ]);
  return csv([header, ...body]);
}

/** Participant records: one row per PERSON, with a per-row-unique identifier. */
function participantCsv(n: number): string {
  const header = ["participant_id", "age", "bmi"];
  const body = Array.from({ length: n }, (_, i) => [`P${1000 + i}`, String(40 + (i % 30)), "24.1"]);
  return csv([header, ...body]);
}

// --- the pure half -------------------------------------------------------------------------------------

test.describe("Setup — the file decisions, as functions", () => {
  test("@setup a repeated variable name is reported as rows versus unique names, and the repeats are named", () => {
    const rows = [
      { variable_name: "bmi", description: "body mass index" },
      { variable_name: "bmi", description: "BMI, second definition" },
      { variable_name: "age", description: "age at visit" },
    ];
    const report = nameCheck(rows, "variable_name");
    expect(report.rowCount).toBe(3);
    expect(report.uniqueNameCount).toBe(2);
    expect(report.dropped).toBe(1);
    expect(report.fired).toBe(true);
    expect(report.repeated).toEqual(["bmi"]);

    // The clean case still REPORTS both figures. A check that only renders when it fires is
    // indistinguishable from a check that was never run.
    const clean = nameCheck(rows.slice(1), "variable_name");
    expect(clean.rowCount).toBe(2);
    expect(clean.uniqueNameCount).toBe(2);
    expect(clean.fired).toBe(false);
    expect(clean.dropped).toBe(0);
  });

  test("@setup with no variable-name column mapped there is nothing to check, and that is not a pass", () => {
    const rows = [{ description: "a" }, { description: "a" }];
    const report = nameCheck(rows, undefined);
    expect(report.checkable).toBe(false);
    expect(report.fired).toBe(false);
    // The row count is still knowable; the unique-name count is not, and is not invented as equal to it.
    expect(report.rowCount).toBe(2);
    expect(report.uniqueNameCount).toBeNull();
  });

  test("@setup an empty value is not a name, so blanks are not counted as one repeated variable", () => {
    const rows = [
      { variable_name: "", description: "a" },
      { variable_name: "", description: "b" },
      { variable_name: "bmi", description: "c" },
    ];
    const report = nameCheck(rows, "variable_name");
    // Two blanks are two rows the loader cannot key at all — reported as unnamed, never folded into a
    // single "repeated" name, which would understate the loss.
    expect(report.unnamed).toBe(2);
    expect(report.uniqueNameCount).toBe(1);
    expect(report.repeated).toEqual([]);
  });

  test("@setup a participant-level file is refused only when BOTH conditions hold", () => {
    const participantRows = Array.from({ length: 20 }, (_, i) => ({
      participant_id: `P${i}`,
      age: "50",
      bmi: "24",
    }));
    expect(participantLevelColumn(["participant_id", "age", "bmi"], participantRows)).toBe("participant_id");

    // Condition 1 alone: a real dictionary that DESCRIBES a participant id. Its `participant_id` appears
    // as a VALUE of the variable-name column, not as a header — so nothing is refused.
    const realDictionary = [
      { variable_name: "participant_id", description: "the participant's study identifier" },
      { variable_name: "age", description: "age at visit" },
    ];
    expect(participantLevelColumn(["variable_name", "description"], realDictionary)).toBeNull();

    // Condition 2 alone: a participant-id HEADER whose values repeat — a long-format dictionary keyed by
    // something else. Not per-row-unique, so not participant records.
    const repeating = Array.from({ length: 20 }, (_, i) => ({ subject_id: "S1", visit: String(i) }));
    expect(participantLevelColumn(["subject_id", "visit"], repeating)).toBeNull();

    // Fewer than two rows proves nothing about uniqueness either way.
    expect(participantLevelColumn(["participant_id"], [{ participant_id: "P1" }])).toBeNull();
  });

  test("@setup bare `id` is not a participant-id header, and the header set is normalized", () => {
    // `id` is the one name a dictionary plausibly uses for its OWN key, so it is deliberately absent —
    // the same carve-out the server-side refusal makes.
    expect(PARTICIPANT_ID_HEADERS.has("id")).toBe(false);
    expect(PARTICIPANT_ID_HEADERS.has("participant_id")).toBe(true);
    // Punctuation and case are folded before the lookup, so `Participant ID` is caught too.
    expect(normalizeHeader("Participant ID")).toBe("participant_id");
    expect(normalizeHeader("  USUBJID  ")).toBe("usubjid");
    const rows = Array.from({ length: 10 }, (_, i) => ({ "Participant ID": `P${i}` }));
    expect(participantLevelColumn(["Participant ID"], rows)).toBe("Participant ID");

    // THE CARVE-OUT AS BEHAVIOUR, not as a comment. A dictionary keyed by its own `id` column — unique on
    // every row, exactly as a variable-name column always is — must not be refused. This is the browser
    // mirror of `tests/test_content_drift.py::test_the_bare_id_carve_out_still_earns_its_place`; the two
    // together mean the exemption cannot silently die on one side while holding on the other.
    const idKeyed = Array.from({ length: 20 }, (_, i) => ({
      id: String(i + 1),
      variable_name: `var_${i}`,
      description: "a description",
    }));
    expect(participantLevelColumn(["id", "variable_name", "description"], idKeyed)).toBeNull();
  });

  test("@setup a role is single-valued per file: assigning it moves it off the column that held it", () => {
    const before = { variable_name: "name", description: "comment" };
    const after = assignRole(before, "label", "description");
    expect(after).toEqual({ variable_name: "name", description: "label" });
    // Two columns cannot both be `description` — that mapping is not expressible, so it cannot be made.
    expect(Object.values(after).filter((c) => c === "label")).toHaveLength(1);
    // Clearing a column's role removes the entry rather than storing a sentinel.
    expect(assignRole(after, "label", "")).toEqual({ variable_name: "name" });
  });
});

// --- the rendered screen -------------------------------------------------------------------------------

test.describe("Setup — the screen", () => {
  test("@setup it renders inside the shared gate chrome as Set up, not as a numbered gate", async ({ page }) => {
    await page.goto(SETUP);
    await page.waitForLoadState("networkidle");
    await expect(page.getByTestId("not-built-yet")).toHaveCount(0);
    await expect(page.locator("h1")).toContainText("Set up");
    // The rail is present and Setup's own column states a cost of nothing rather than forecasting $0.
    await expect(page.getByTestId("gate-rail")).toBeVisible();
  });

  test("@setup the run's dictionaries render with their own parse state each", async ({ page }) => {
    await page.goto(SETUP);
    await page.waitForLoadState("networkidle");
    const cards = page.getByTestId("dict-card");
    await expect(cards).toHaveCount(5);
    // EVERY card carries a state of its own — not one banner covering the set.
    for (let i = 0; i < 5; i++) {
      await expect(cards.nth(i).getByTestId("dict-parse-state")).toBeVisible();
    }
  });

  test("@setup a run-seeded dictionary says the unique-name count is unknown rather than assuming it", async ({
    page,
  }) => {
    await page.goto(SETUP);
    await page.waitForLoadState("networkidle");
    // The source file is not part of the run record, so the unique-name count cannot be computed. That is
    // stated, with the reason — never rendered as "all names unique", which would be a claim we cannot make.
    const unavailable = page.getByTestId("name-check-unavailable").first();
    await expect(unavailable).toBeVisible();
    await expect(unavailable).toContainText(/not available/i);
  });

  test("@setup a repeated variable name is surfaced on screen with both counts", async ({ page }) => {
    await page.goto(DRAFT);
    await page.waitForLoadState("networkidle");
    await page.getByTestId("dict-upload").setInputFiles({
      name: "repeats.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(dictionaryCsv(10, { repeat: true })),
    });
    const check = page.getByTestId("name-check");
    await expect(check).toBeVisible();
    await expect(check).toHaveAttribute("data-fired", "true");
    await expect(check).toHaveAttribute("data-rows", "10");
    await expect(check).toHaveAttribute("data-unique", "5");
    // BOTH figures on screen, not merely in an attribute, and named as the silent drop it is.
    await expect(check).toContainText("10");
    await expect(check).toContainText("5");
    await expect(check).toContainText(/silently/i);
  });

  test("@setup a clean file still shows the row count against the unique-name count", async ({ page }) => {
    await page.goto(DRAFT);
    await page.waitForLoadState("networkidle");
    await page.getByTestId("dict-upload").setInputFiles({
      name: "clean.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(dictionaryCsv(8)),
    });
    const check = page.getByTestId("name-check");
    await expect(check).toHaveAttribute("data-fired", "false");
    await expect(check).toHaveAttribute("data-rows", "8");
    await expect(check).toHaveAttribute("data-unique", "8");
  });

  test("@setup a participant-shaped file is refused in the browser and issues no upload", async ({ page }) => {
    const posts: string[] = [];
    await page.route("**/api/**", async (route) => {
      if (route.request().method() !== "GET") posts.push(route.request().url());
      await route.continue();
    });
    await page.goto(DRAFT);
    await page.waitForLoadState("networkidle");
    await page.getByTestId("dict-upload").setInputFiles({
      name: "participants.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(participantCsv(30)),
    });
    const refusal = page.getByTestId("participant-refusal");
    await expect(refusal).toBeVisible();
    // UI-SPEC §8.4, verbatim in substance: what was expected, and that nothing was uploaded.
    await expect(refusal).toContainText("looks like participant data");
    await expect(refusal).toContainText("one row per variable");
    await expect(refusal).toContainText("Nothing was uploaded");
    // The refused file never becomes a dictionary, and no request carried it anywhere.
    await expect(page.getByTestId("dict-card")).toHaveCount(0);
    expect(posts).toEqual([]);
  });

  test("@setup an unparseable file renders the problem and the next step", async ({ page }) => {
    await page.goto(DRAFT);
    await page.waitForLoadState("networkidle");
    await page.getByTestId("dict-upload").setInputFiles({
      name: "not-a-table.csv",
      mimeType: "text/csv",
      // No delimiter, no header row worth the name: nothing a dictionary loader can key on.
      buffer: Buffer.from("\n\n\n"),
    });
    const problem = page.getByTestId("dict-unparseable");
    await expect(problem).toBeVisible();
    await expect(problem).toContainText(/could not be read/i);
    await expect(problem).toContainText(/comma|tab|delimit/i);
  });

  test("@setup zero, one and many dictionaries render distinctly", async ({ page }) => {
    await page.goto(DRAFT);
    await page.waitForLoadState("networkidle");
    // ZERO — an empty state with a next step, never a blank pane.
    await expect(page.getByTestId("gate-empty-state")).toBeVisible();
    await expect(page.getByTestId("single-dictionary-notice")).toHaveCount(0);

    // ONE — CDE-mapping, not harmonization, and the copy says so.
    await page.getByTestId("dict-upload").setInputFiles({
      name: "one.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(dictionaryCsv(6)),
    });
    await expect(page.getByTestId("dict-card")).toHaveCount(1);
    const notice = page.getByTestId("single-dictionary-notice");
    await expect(notice).toBeVisible();
    await expect(notice).toContainText(/CDE.mapping/i);
    await expect(notice).toContainText(/not harmoni/i);

    // MANY — the notice is gone, because two dictionaries genuinely is harmonization.
    await page.getByTestId("dict-upload").setInputFiles({
      name: "two.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(dictionaryCsv(7)),
    });
    await expect(page.getByTestId("dict-card")).toHaveCount(2);
    await expect(page.getByTestId("single-dictionary-notice")).toHaveCount(0);
  });

  test("@setup an incomplete form disables Start WITH the reason named", async ({ page }) => {
    await page.goto(DRAFT);
    await page.waitForLoadState("networkidle");
    const start = page.getByTestId("start-run");
    const reason = page.getByTestId("start-blocked");
    // Zero dictionaries: disabled, and the reason is on screen rather than implied by the greying.
    await expect(start).toBeDisabled();
    await expect(reason).toBeVisible();
    await expect(reason).toContainText(/dictionary/i);

    // A file with NO meaning-bearing column mapped: still blocked, and the reason now names the file.
    await page.getByTestId("dict-upload").setInputFiles({
      name: "unmapped.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(csv([["col_a", "col_b"], ["1", "2"], ["3", "4"]])),
    });
    await expect(page.getByTestId("dict-card")).toHaveCount(1);
    await expect(start).toBeDisabled();
    await expect(reason).toContainText("unmapped.csv");
  });

  test("@setup Start is a live control, not a dead one: it is enabled only when it will do something", async ({
    page,
  }) => {
    // An ENABLED button that does nothing is the same defect as a disabled one with no reason, arrived at
    // from the other side. Static builds cannot start a run at all, so the control stays disabled and the
    // key blocker names the remaining step — which is what a reviewer on the deployed app would see next.
    await page.goto(DRAFT);
    await page.waitForLoadState("networkidle");
    await page.getByTestId("dict-upload").setInputFiles({
      name: "ready.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(dictionaryCsv(12)),
    });
    await expect(page.getByTestId("dict-card")).toHaveCount(1);
    // The remaining blocker is the provider key, and it says so rather than leaving the control mute.
    const blockers = page.getByTestId("blocker");
    await expect(blockers.filter({ hasText: /API key/i })).toHaveCount(1);

    // Switching to Preview removes the need for a key, so that blocker clears — the control's state
    // tracks a real precondition rather than a hardcoded gate.
    await page.getByTestId("run-mode").selectOption("preview");
    await expect(blockers.filter({ hasText: /API key/i })).toHaveCount(0);
    await expect(page.getByTestId("start-blocked")).toHaveCount(0);
  });

  test("@setup mapping a meaning-bearing column clears the blocker it was named for", async ({ page }) => {
    await page.goto(DRAFT);
    await page.waitForLoadState("networkidle");
    await page.getByTestId("dict-upload").setInputFiles({
      name: "mapme.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(csv([["col_a", "col_b"], ["1", "2"], ["3", "4"]])),
    });
    const row = page.getByTestId("mapping-row").filter({ has: page.locator('[data-column="col_a"]') });
    await expect(row).toHaveCount(1);
    await row.getByTestId("role-select").selectOption("description");
    // The blocker that named this file is gone; the mapping is what cleared it. Asserted against the
    // blocker ITEMS rather than the container, which disappears entirely once nothing is blocking —
    // `not.toContainText` on an absent element proves nothing.
    await expect(page.getByTestId("blocker").filter({ hasText: "mapme.csv" })).toHaveCount(0);
  });

  test("@setup the mapping table scrolls inside its card and the page never scrolls sideways", async ({
    page,
  }) => {
    await page.goto(DRAFT);
    await page.waitForLoadState("networkidle");
    // A wide dictionary: 40 source columns, each of which becomes a mapping row.
    const wide = Array.from({ length: 40 }, (_, i) => `a_very_long_source_column_name_number_${i}`);
    await page.getByTestId("dict-upload").setInputFiles({
      name: "wide.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(csv([wide, wide.map((_, i) => `v${i}`), wide.map((_, i) => `w${i}`)])),
    });
    await expect(page.getByTestId("mapping-row")).toHaveCount(40);

    // The table owns its overflow.
    const scroller = page.getByTestId("mapping-scroll");
    const own = await scroller.evaluate((el) => ({
      scrolls: el.scrollHeight > el.clientHeight,
      overflow: getComputedStyle(el).overflowY,
    }));
    expect(own.overflow).not.toBe("visible");
    expect(own.scrolls).toBe(true);

    // And the PAGE does not scroll horizontally at the design canvas width.
    const page_ = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(page_.scrollWidth).toBeLessThanOrEqual(page_.clientWidth);
  });

  test("@setup a long filename and a long column name are clamped with the full value available", async ({
    page,
  }) => {
    await page.goto(DRAFT);
    await page.waitForLoadState("networkidle");
    const longCol = "a_source_column_name_so_long_it_would_reflow_the_table_if_it_were_not_clamped_at_all";
    const longName = "a_dictionary_filename_so_long_that_it_would_push_the_card_header_wider_than_the_page.csv";
    await page.getByTestId("dict-upload").setInputFiles({
      name: longName,
      mimeType: "text/csv",
      buffer: Buffer.from(csv([[longCol, "b"], ["1", "2"], ["3", "4"]])),
    });
    const nameEl = page.getByTestId("dict-filename").first();
    await expect(nameEl).toHaveAttribute("title", longName);
    const colEl = page.locator(`[data-column="${longCol}"]`).first();
    await expect(colEl).toHaveAttribute("title", longCol);
    // Clamped means truncated in the box, not wrapped into a taller one.
    expect(await colEl.evaluate((el) => getComputedStyle(el).textOverflow)).toBe("ellipsis");
  });
});

// --- the score definition, the run configuration and the estimate (Task 2) -----------------------------

test.describe("Setup — the honest estimate", () => {
  test("@setup the estimate is itemised and always carries a coherence line", async ({ page }) => {
    await page.goto(SETUP);
    await page.waitForLoadState("networkidle");
    const panel = page.getByTestId("estimate-panel");
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute("data-pending", "false");

    // The five cohorts are 200 variables each, so a group clears the judge's six-member floor and the
    // judge is priced for real work.
    const coherence = page.locator("[data-cost-line='coherence']");
    await expect(coherence).toBeVisible();
    await expect(coherence).not.toHaveText(/\$0$/);
    await expect(coherence).toContainText("judge");

    // Itemised, not one number: every stage that will run is NAMED.
    const lines = await page.locator("[data-cost-line]").evaluateAll((els) =>
      els.map((e) => e.getAttribute("data-cost-line")),
    );
    expect(lines).toContain("ideal");
    // UNFUSED at review 2026-08-26. `splitAssign` was one line spanning two gates, so it was the only
    // item that could not be filed under the gate that pays for it. `byGate` had always divided the share
    // by SPLIT_ASSIGN_DIVISION; the rendered line now does too.
    expect(lines).toContain("split");
    expect(lines).toContain("assign");
    expect(lines).not.toContain("splitAssign");
    expect(lines).toContain("coherence");
    expect(lines).toContain("gencde");
  });

  test("@setup the variable count on screen is the same one the estimate is priced from", async ({ page }) => {
    // A REGRESSION GATE FOR A BUG THIS SCREEN ACTUALLY HAD. The dictionaries header summed a stored
    // per-file row count while the estimate summed a derived one, so the header read "5 dictionaries · 0
    // variables" beside a correctly-priced $2.20-$5.86 quote. Two readings of one number, silently
    // disagreeing — and the cheaper-looking one was the one a reviewer would have believed.
    await page.goto(SETUP);
    await page.waitForLoadState("networkidle");
    const header = (await page.getByTestId("dictionary-count").textContent()) ?? "";
    const shown = Number((header.match(/([\d,]+) variables/)?.[1] ?? "").replace(/,/g, ""));
    expect(shown).toBeGreaterThan(0);
    const priced = ((await page.getByTestId("estimate-panel").textContent()) ?? "").match(
      /([\d,]+) variables/,
    );
    expect(Number((priced?.[1] ?? "").replace(/,/g, ""))).toBe(shown);
    // And the per-card row counts add up to it, so no dictionary is silently contributing nothing.
    const perCard = await page.getByTestId("dict-card").evaluateAll((cards) =>
      cards.map((c) => {
        const m = (c.textContent ?? "").match(/·\s*([\d,]+) rows/);
        return m ? Number(m[1].replace(/,/g, "")) : 0;
      }),
    );
    expect(perCard.reduce((a, b) => a + b, 0)).toBe(shown);
  });

  test("@setup the coherence line renders $0 rather than vanishing when no group can qualify", async ({
    page,
  }) => {
    await page.goto(DRAFT);
    await page.waitForLoadState("networkidle");
    // Four variables cannot make a single group of the judge's six-member minimum.
    await page.getByTestId("dict-upload").setInputFiles({
      name: "tiny.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(dictionaryCsv(4)),
    });
    const coherence = page.locator("[data-cost-line='coherence']");
    await expect(coherence).toBeVisible();
    await expect(coherence).toContainText("$0");
    // And it says WHY it is zero. A $0 with no reason is indistinguishable from a stage that was forgotten.
    await expect(coherence).toContainText(/not asked|reaches/i);
    // Never rendered as "coherent": the judge was not asked, which is not a pass.
    await expect(coherence).not.toContainText(/coherent\b/i);
  });

  test("@setup while the corpus size is still unknown the estimate is pending, not a low figure", async ({
    page,
  }) => {
    // The demo catalogue carries the run's per-dictionary variable counts. Hold it in flight and the
    // corpus size is genuinely unknown — at which point a total computed from what has arrived so far
    // would be an UNDER-QUOTE, which is the one direction R8 forbids. So: no figure at all.
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route("**/static-data/demos.json", async (route) => {
      await held;
      await route.continue();
    });
    await page.goto(SETUP);

    const panel = page.getByTestId("estimate-panel");
    await expect(panel).toHaveAttribute("data-pending", "true");
    await expect(page.getByTestId("estimate-pending")).toBeVisible();
    // THE INVARIANT: no figure is on screen while the inputs are unresolved. Not a stale one, not a zero.
    await expect(page.getByTestId("estimate-total")).toHaveCount(0);

    release!();
    await expect(panel).toHaveAttribute("data-pending", "false");
    await expect(page.getByTestId("estimate-total")).toBeVisible();
    await expect(page.getByTestId("estimate-pending")).toHaveCount(0);
  });

  test("@setup the primary action carries the nothing-is-charged-yet statement, ABOVE it", async ({ page }) => {
    // ON THE COMPOSE SCREEN, which is where the primary action lives since 08-14f. It used to be asserted
    // against a started run because Start bought nothing then and the real charge was one screen later;
    // Start IS the charge now, so a started run correctly offers no charge control at all and this
    // pairing is only meaningful before the press.
    await page.goto(DRAFT);
    await page.waitForLoadState("networkidle");
    const statement = page.getByTestId("nothing-charged-yet");
    await expect(statement).toBeVisible();
    await expect(statement).toContainText("Nothing is charged yet");
    await expect(page.getByTestId("start-run")).toBeVisible();
    // ABOVE, not merely present: a statement a reviewer needs BEFORE they press must not be discoverable
    // only after they have scrolled past the button.
    const above = (await statement.boundingBox())!.y;
    const control = (await page.getByTestId("start-run").boundingBox())!.y;
    expect(above).toBeLessThan(control);
  });

  test("@setup the per-gate breakdown names THIS screen's Continue as the first charge, and what it buys", async ({
    page,
  }) => {
    await page.goto(SETUP);
    await page.waitForLoadState("networkidle");
    const first = page.getByTestId("first-charge");
    await expect(first).toBeVisible();
    // UI-SPEC §0.1 after the plan-review reversal placed the first charge at Gate 0's Continue; the
    // 2026-08-26 demotion re-sited that control HERE (D-3's amendment). The bill names where it lands.
    await expect(first).toContainText(/on this\s+screen/i);
    await expect(first).not.toContainText(/Gate 0/);
    // Pay-as-you-go is the headline. The per-gate re-quote promise moved into the tooltip at the
    // 2026-08-26 review — long prose does not earn main-display space — so it is asserted there.
    await expect(first).toContainText(/pay gate by gate/i);
    const tip = first.getByRole("button", { name: /what the first charge buys/i });
    await expect(tip).toHaveCount(1);
    await tip.hover();
    const tipText = page.getByRole("tooltip");
    await expect(tipText).toContainText(/re-quotes|quotes/i);
    await expect(tipText).toContainText(/abandon/i);

    // The per-gate rows are present, and the free gates say so rather than forecasting a figure.
    await expect(page.locator("[data-gate-forecast='setup']")).toContainText(/local|no charge/i);
    await expect(page.locator("[data-gate-forecast='gate4']")).toContainText(/no charge|nothing/i);

    // THE RETIRED POSITION DRAWS NO ROW. It used to, labelled "Load & prepare", beside Setup's own row
    // describing the very same free local leg — one leg, two lines, one of them naming a screen the flow
    // no longer has. Its COST LINES were re-homed rather than dropped: embedding and clustering are still
    // itemised, under Setup, which is where that work is now read.
    await expect(page.locator("[data-gate-forecast='gate0']")).toHaveCount(0);
    await expect(
      page.locator("[data-gate-forecast='setup']").locator("[data-cost-line='embedding']"),
    ).toHaveCount(1);

    // THE POINT OF THE CONSOLIDATION (review 2026-08-26): every cost line sits INSIDE the gate whose
    // Continue buys it. Previously the stage costs and the per-gate forecasts were two disconnected
    // lists, so a reviewer could read what the judge costs and what Gate 1 costs without being told the
    // first is part of the second. This asserts the containment, which is the thing that was missing.
    const gate1 = page.locator("[data-gate-forecast='gate1']");
    for (const id of ["ideal", "split", "coherence"]) {
      await expect(gate1.locator(`[data-cost-line='${id}']`)).toHaveCount(1);
    }
    const gate2 = page.locator("[data-gate-forecast='gate2']");
    for (const id of ["assign", "gencde"]) {
      await expect(gate2.locator(`[data-cost-line='${id}']`)).toHaveCount(1);
    }
    await expect(page.locator("[data-gate-forecast='gate3']").locator("[data-cost-line='specgen']")).toHaveCount(1);
    // And no line is orphaned outside a gate group — an unfiled cost is the old bug in miniature.
    const orphans = await page.evaluate(() =>
      Array.from(document.querySelectorAll("[data-cost-line]"))
        .filter((el) => !el.closest("[data-gate-forecast]"))
        .map((el) => el.getAttribute("data-cost-line")),
    );
    expect(orphans).toEqual([]);
  });

  test("@setup nothing on this screen claims the flow stays free until you pick what to buy", async ({
    page,
  }) => {
    await page.goto(SETUP);
    await page.waitForLoadState("networkidle");
    const text = ((await page.locator("main").textContent()) ?? "").replace(/\s+/g, " ");
    // The reversal killed this claim: spending now begins at Gate 0's Continue, BEFORE the reviewer has
    // chosen any concept. Copy implying otherwise would be the exact misstatement R8 exists to prevent.
    expect(text).not.toMatch(/free until/i);
    expect(text).not.toMatch(/no charge until you (choose|pick|select)/i);
    expect(text).not.toMatch(/nothing is charged until Gate 1/i);
    expect(text).not.toMatch(/scope before you spend/i);
  });

  test("@setup the three run options are shown priced under their gate, with no control here", async ({
    page,
  }) => {
    await page.goto(SETUP);
    await page.waitForLoadState("networkidle");

    // HISTORY OF THIS ASSERTION, because its location has moved twice and its INTENT has not.
    // 08-13 made these three real checkboxes at Setup. The 08-16 amendment removed the controls and left
    // informational cards — shown, priced, naming the gate that decides. The 2026-08-26 review then found
    // the cards redundant with the estimate directly beneath them, so they collapsed INTO the bill: each
    // option is now a cost line under its own gate, carrying its default, its owning gate and its help.
    // What must stay true throughout: the option is VISIBLE (an option nobody sees is an unavailable
    // feature with extra code behind it), it is PRICED, it names WHERE it is decided, and Setup does not
    // decide it.

    // Transform specs: on by default, so it is quoted, and it sits under Gate 3.
    const specs = page.locator("[data-cost-line='specgen']");
    await expect(specs).toBeVisible();
    await expect(specs).toContainText(/on/i);
    await expect(specs).toContainText(/Gate 3/);
    await expect(page.locator("[data-gate-forecast='gate3']").locator("[data-cost-line='specgen']")).toHaveCount(1);

    // Analysis ideas: on by default, but NO gate buys it — it is a post-run add, filed after the run.
    const ideas = page.locator("[data-cost-line='analysisIdeas']");
    await expect(ideas).toBeVisible();
    await expect(ideas).toContainText(/results page/i);
    await expect(page.locator("[data-gate-forecast='after']").locator("[data-cost-line='analysisIdeas']")).toHaveCount(1);

    // Concept-match check: OFF by default (STGD-16). It is still shown — as an OFFER carrying no figure,
    // because an opt-in that produces no cost line would otherwise vanish from the very bill that is
    // telling the reviewer they can turn it on.
    const conceptGate = page.locator("[data-cost-line='conceptGate']");
    await expect(conceptGate).toBeVisible();
    await expect(conceptGate).toHaveAttribute("data-offered", "true");
    await expect(conceptGate).toContainText(/off/i);
    await expect(conceptGate).toContainText(/Gate 2/);
    await expect(conceptGate).toContainText(/not included/i);
    await expect(page.locator("[data-gate-forecast='gate3']").locator("[data-cost-line='conceptGate']")).toHaveCount(1);

    // NOT A CONTROL. No checkbox, radio or switch anywhere in the estimate panel — "the decision moved to
    // the gate" is only true if Setup stopped offering it.
    const panel = page.getByTestId("estimate-panel");
    await expect(panel.locator("input[type=checkbox], input[type=radio], [role=switch]")).toHaveCount(0);

    // The retired cards are gone, not merely hidden.
    for (const id of ["concept-gate-toggle", "gen-specs-toggle", "suggest-ideas-toggle", "transform-specs-toggle"]) {
      await expect(page.getByTestId(id)).toHaveCount(0);
    }
  });

  test("@setup the run mode is selectable and changes what the run is quoted at", async ({ page }) => {
    await page.goto(SETUP);
    await page.waitForLoadState("networkidle");
    const before = Number(await page.getByTestId("estimate-total").getAttribute("data-mid"));
    // Synchronous is roughly twice batch. The figure must MOVE — a control that does not reach the quote
    // is a control that misleads about what is being bought.
    await page.getByTestId("run-mode").selectOption("sync");
    await expect(page.getByTestId("estimate-panel")).toHaveAttribute("data-pending", "false");
    const after = Number(await page.getByTestId("estimate-total").getAttribute("data-mid"));
    expect(after).toBeGreaterThan(before);

    // Preview calls no model at all, so the run is free and says so.
    await page.getByTestId("run-mode").selectOption("preview");
    await expect(page.getByTestId("estimate-free")).toBeVisible();
  });
});

test.describe("Setup — the declared score, now ABSENT", () => {
  // ── the cut (08-13b Task 1) ────────────────────────────────────────────────────────────────────
  //
  // The declared-score panel MOVED to Gate 1 (08-15 AMENDMENT 2026-08-25): the run has happened
  // there, so feasibility becomes computable instead of hard-coded `indeterminate`, and a paid
  // `match_components` call is unsurprising on a screen that is already a spend decision.
  //
  // These three tests replace the three that asserted the panel's BEHAVIOUR. They are rewritten
  // rather than deleted on purpose — a deleted test proves nothing, and the load-bearing claim here
  // is the same one the 08-16 amendment made when the concept gate moved off Setup: "the decision
  // moved to the gate" is only true if Setup actually STOPPED OFFERING IT. So the assertion is
  // ABSENCE, not inertness: not a disabled control, not a collapsed stub, not a pointer to Gate 1
  // dressed up as an affordance.

  test("@setup Setup offers no score panel at all — every part of it is gone, not merely inert", async ({
    page,
  }) => {
    await page.goto(DRAFT);
    await page.waitForLoadState("networkidle");
    // The section itself.
    await expect(page.getByTestId("score-panel")).toHaveCount(0);
    // And each part of it independently, so a partial removal that left the band or the verdict
    // behind cannot pass on the section's testid alone.
    await expect(page.getByTestId("score-components")).toHaveCount(0);
    await expect(page.getByTestId("score-upload")).toHaveCount(0);
    await expect(page.getByTestId("score-scope-band")).toHaveCount(0);
    await expect(page.getByTestId("score-verdict")).toHaveCount(0);
    await expect(page.getByTestId("score-component")).toHaveCount(0);
    await expect(page.getByTestId("score-doc-read")).toHaveCount(0);
    await expect(page.getByTestId("score-doc-error")).toHaveCount(0);
    // The heading copy is gone too — a heading with no control under it is the collapsed stub this
    // cut is meant to avoid.
    await expect(page.locator("body")).not.toContainText(/score definition/i);
  });

  test("@setup Setup leaves behind no score control, disabled or otherwise, and does not advertise the move", async ({
    page,
  }) => {
    await page.goto(DRAFT);
    await page.waitForLoadState("networkidle");
    // The two controls the panel owned, addressed by SHAPE rather than by testid — so stripping the
    // testid off a leftover control (or disabling it) cannot make this pass. The components box was
    // Setup's ONLY textarea and the document field was its ONLY document-accepting file input; the
    // dictionary dropzone's own input accepts csv/tsv/xlsx, never pdf.
    await expect(page.locator("textarea")).toHaveCount(0);
    await expect(page.locator('input[type="file"][accept*="pdf"]')).toHaveCount(0);
    // And by accessible name, which is what a `disabled` leftover would still answer to: a disabled
    // input stays in the accessibility tree.
    await expect(page.getByRole("textbox", { name: /components/i })).toHaveCount(0);
    await expect(page.getByLabel(/components, one per line/i)).toHaveCount(0);
    // No signpost either. Telling the reviewer at Setup that the score decision lives at Gate 1 would
    // re-introduce the ask-at-minimum-information pattern in prose form: Setup's job is dictionaries,
    // mapping, run configuration and the estimate — nothing about a score.
    await expect(page.locator("body")).not.toContainText(/declared score/i);
    await expect(page.locator("body")).not.toContainText(/name its components|components, one per line/i);
    await expect(page.locator("body")).not.toContainText(/read a paper or supplement/i);
  });

  test("@setup the score CAPABILITY survives the cut — Gate 1 is the consumer now", () => {
    // T-08b-1: the failure mode this cut could have had is deleting `lib/score-scope.ts` alongside
    // its Setup consumer, which would break 08-15 Task 4 silently and surface much later as a
    // missing module on Gate 1. This plan removed a CONSUMER, not the capability — asserted here as
    // a plain function test so the claim is checked without driving a page.
    expect(typeof declaredComponents).toBe("function");
    expect(declaredComponents("Weak grip strength\n\nSlow walking speed\nWeak grip strength")).toEqual([
      "Weak grip strength",
      "Slow walking speed",
    ]);
    expect(typeof SCOPE_VERDICT_COPY).toBe("object");
    // All four states still named, and the indeterminate copy still refuses the negative claim.
    expect(Object.keys(SCOPE_VERDICT_COPY).sort()).toEqual([
      "full",
      "indeterminate",
      "infeasible",
      "partial",
    ]);
    expect(SCOPE_VERDICT_COPY.indeterminate).toMatch(/cannot be determined/i);
    expect(SCOPE_VERDICT_COPY.indeterminate).not.toMatch(/not computable/i);
  });
});

test.describe("Setup — the review pass: layout melded with the New Run form", () => {

  // ── review pass (08-13): the layout meld with the shipped New Run form ─────────────────────────
  //
  // Everything below covers a control the review ADDED or CHANGED. Each is a thing that fails silently:
  // a requirement flag that stops appearing, a disabled option that becomes selectable, an unvalidated
  // model that becomes choosable.

  test("@setup the meaning-requirement is flagged only while it is unmet", async ({ page }) => {
    await page.goto(DRAFT);
    await page.waitForLoadState("networkidle");
    await page.getByTestId("dict-upload").setInputFiles({
      name: "needsmeaning.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(csv([["col_a", "col_b"], ["1", "2"], ["3", "4"]])),
    });
    // Unmapped: the flag is up and says which roles would satisfy it.
    const flag = page.getByTestId("meaning-requirement");
    await expect(flag).toBeVisible();
    await expect(flag).toContainText(/description|question_text/);
    // Mapped: it goes away. A permanent readout was tried and removed at review — the dropdown groups and
    // per-option help already carry the distinction, so a standing "2 of 3" line only competed with the
    // name-check for attention.
    const row = page.getByTestId("mapping-row").filter({ has: page.locator('[data-column="col_a"]') });
    await row.getByTestId("role-select").selectOption("description");
    await expect(page.getByTestId("meaning-requirement")).toHaveCount(0);
  });

  test("@setup role options are grouped, carry help, and carry no requirement suffix", async ({ page }) => {
    await page.goto(DRAFT);
    await page.waitForLoadState("networkidle");
    await page.getByTestId("dict-upload").setInputFiles({
      name: "groups.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(csv([["col_a"], ["1"], ["2"]])),
    });
    const shape = await page.getByTestId("role-select").first().evaluate((el) => {
      const sel = el as HTMLSelectElement;
      return {
        groups: Array.from(sel.querySelectorAll("optgroup")).map((g) => (g as HTMLOptGroupElement).label),
        withHelp: Array.from(sel.querySelectorAll("optgroup option")).filter(
          (o) => (o as HTMLOptionElement).title.length > 20,
        ).length,
        total: sel.querySelectorAll("optgroup option").length,
        labels: Array.from(sel.querySelectorAll("option")).map((o) => o.textContent ?? ""),
      };
    });
    // The question/response split the New Run form makes, applied to the OPTIONS — grouping the rows would
    // re-sort the table on every change, and this table may not reflow.
    expect(shape.groups.some((g) => /^Question/.test(g))).toBe(true);
    expect(shape.groups.some((g) => /^Response/.test(g))).toBe(true);
    // Every grouped role explains itself, from the single ROLE_HELP register.
    expect(shape.withHelp).toBe(shape.total);
    // The " · meaning" / " · for specs" / " · recommended" suffixes were dropped at review as noise.
    expect(shape.labels.filter((l) => /·\s*(meaning|for specs|recommended)/.test(l))).toEqual([]);
  });

  test("@setup the CDE catalogue names counts, and bring-your-own is visible but unselectable", async ({
    page,
  }) => {
    await page.goto(DRAFT);
    await page.waitForLoadState("networkidle");
    const sel = page.getByTestId("cde-set");
    await expect(sel).toContainText("174");
    await expect(sel).toContainText("22.7k");
    // Offered so the gap is visible, disabled so it cannot promise what the backend cannot do.
    const upload = sel.locator('option[value="upload"]');
    await expect(upload).toHaveCount(1);
    await expect(upload).toBeDisabled();
  });

  test("@setup provider and model are choosable, and untested options are disabled", async ({ page }) => {
    await page.goto(DRAFT);
    await page.waitForLoadState("networkidle");
    // Present outside preview mode...
    await expect(page.getByTestId("provider")).toBeVisible();
    await expect(page.getByTestId("model")).toBeVisible();
    // ...and every model the picker leaves ENABLED is one the pipeline was validated against.
    const enabled = await page.getByTestId("model").evaluate((el) =>
      Array.from((el as HTMLSelectElement).options)
        .filter((o) => !o.disabled && o.value)
        .map((o) => o.value),
    );
    expect(enabled.length).toBeGreaterThan(0);
    for (const id of enabled) expect(id).toMatch(/sonnet.*4[.-]6/i);
    // Preview calls no provider, so neither control is shown.
    await page.getByTestId("run-mode").selectOption("preview");
    await expect(page.getByTestId("provider")).toHaveCount(0);
    await expect(page.getByTestId("model")).toHaveCount(0);
  });

  test("@setup the same dictionary added twice is flagged, and named", async ({ page }) => {
    await page.goto(DRAFT);
    await page.waitForLoadState("networkidle");
    const body = Buffer.from(csv([["variable_name", "description"], ["a", "Alpha"], ["b", "Beta"]]));
    await page.getByTestId("dict-upload").setInputFiles({ name: "same.csv", mimeType: "text/csv", buffer: body });
    await expect(page.getByTestId("duplicate-dictionaries")).toHaveCount(0);
    // Same file again — the failure this catches is silent: it would read as a second cohort agreeing.
    await page.getByTestId("dict-upload").setInputFiles({ name: "same.csv", mimeType: "text/csv", buffer: body });
    const warn = page.getByTestId("duplicate-dictionaries");
    await expect(warn).toBeVisible();
    await expect(warn).toContainText("same.csv");
    await expect(warn).toContainText(/cross-cohort/i);
    // FLAGGED, not blocked — a legitimate same-name pair from two cohorts must still be startable.
    await expect(page.getByTestId("blocker").filter({ hasText: /added more than once/i })).toHaveCount(0);
  });
});

test.describe("Setup — the two functional lifts (08-13b)", () => {
  // ── the inherited-UI gaps (08-13b Task 2) ──────────────────────────────────────────────────────
  //
  // Setup was planned from the UI spec rather than from an inventory of what the shipped New Run form
  // already did, so two conveniences never crossed over:
  //
  //   1. it called `lookupPrefill` but never `rememberAssignment` — it READ a column-mapping cache that
  //      only `pages/home.tsx` ever WROTE, so the read path was fed by a writer on another screen; and
  //   2. it quoted a price but not a DURATION, though `types.ts` has carried `estimateRunTime` all along
  //      and a batch run can take a long time. A reviewer who was not told that reads it as a hang.
  //
  // A NOTE ON WHAT CAN BE ASSERTED HERE, because it shapes the two tests below. This gate runs against
  // the STATIC build, and Setup's Start button is `disabled={… || IS_STATIC}` (setup.tsx) because a
  // static build has no backend to post files to. So the plan's "click Start, then upload a same-shaped
  // file and watch it prefill" is NOT reachable in this harness — and the prefill module cannot be
  // imported into this spec either, because it pulls in the demo-manifest JSON and Playwright's node
  // loader rejects a bare JSON import.
  //
  // The write is therefore pinned from BOTH ENDS of the same contract instead:
  //   - the READ end, in the browser, against a localStorage payload written in exactly the shape
  //     `rememberAssignment` writes — same key, same header signature, same role map; and
  //   - the WRITE end, structurally, against setup.tsx's own source: that `rememberAssignment` is called
  //     once, with headers and roles only, and from `onStart` rather than from a mapping handler.
  // Together those cover the claim. `visual.spec.ts` already reads `App.tsx` off disk for the same reason.

  /** The cache's storage key and its header-signature rule, both fixed by `lib/column-prefill.ts`. */
  const CACHE_KEY = "ddharmon:column-assignments:v1";
  const signature = (headers: string[]) =>
    headers
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean)
      .sort()
      .join("|");

  /** Columns that are NOT role names, so a prefill can only have come from the CACHE. */
  const OPAQUE_HEADERS = ["varname", "desc", "unit"];
  const OPAQUE_ROLES = { variable_name: "varname", description: "desc", units: "unit" };
  const opaqueCsv = (n: number) =>
    csv([OPAQUE_HEADERS, ...Array.from({ length: n }, (_, i) => [`v_${i}`, `describes v_${i}`, "kg"])]);

  test("@setup a remembered header set prefills a same-shaped dictionary — and nothing else does", async ({
    page,
  }) => {
    // PART A — the control. With an empty cache these three columns prefill NOTHING: none of them is a
    // role name, so `initialRoles`' name-is-the-role identity rule finds no match. Without this half,
    // part B would pass on the identity rule and prove nothing about the cache.
    await page.goto(DRAFT);
    await page.waitForLoadState("networkidle");
    await page.evaluate((k) => localStorage.removeItem(k), CACHE_KEY);
    await page.goto(DRAFT);
    await page.waitForLoadState("networkidle");
    await page.getByTestId("dict-upload").setInputFiles({
      name: "unrecognised.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(opaqueCsv(6)),
    });
    const selects = page.getByTestId("role-select");
    await expect(selects).toHaveCount(3);
    for (let i = 0; i < 3; i++) await expect(selects.nth(i)).toHaveValue("");

    // PART B — the same file, against a cache holding exactly what a completed run start writes: the
    // header SIGNATURE as the key, and role -> source column as the value. This is the contract
    // `rememberAssignment` writes and `lookupPrefill` reads; asserting it here is what makes "a second
    // dictionary with the same headers maps itself" a checked claim rather than a hoped-for one.
    await page.evaluate(
      ([k, sig, roles]) =>
        localStorage.setItem(k as string, JSON.stringify({ [sig as string]: roles })),
      [CACHE_KEY, signature(OPAQUE_HEADERS), OPAQUE_ROLES] as const,
    );
    await page.goto(DRAFT);
    await page.waitForLoadState("networkidle");
    await page.getByTestId("dict-upload").setInputFiles({
      name: "same-shape.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(opaqueCsv(6)),
    });
    const prefilled = page.getByTestId("role-select");
    await expect(prefilled).toHaveCount(3);
    // Row order follows the FILE's header order: varname, desc, unit.
    await expect(prefilled.nth(0)).toHaveValue("variable_name");
    await expect(prefilled.nth(1)).toHaveValue("description");
    await expect(prefilled.nth(2)).toHaveValue("units");

    // T-08b-2 — THE CACHE MUST NOT WIDEN INTO VALUE DATA. Every value in the stored payload is one of
    // the file's own COLUMN NAMES. Column names and roles are dictionary metadata; the first-value
    // column the mapping table displays holds cell contents, and none of it may reach this cache.
    const stored = await page.evaluate(
      (k) => JSON.parse(localStorage.getItem(k) ?? "{}") as Record<string, Record<string, string>>,
      CACHE_KEY,
    );
    expect(Object.keys(stored)).toEqual([signature(OPAQUE_HEADERS)]);
    for (const column of Object.values(stored[signature(OPAQUE_HEADERS)])) {
      expect(OPAQUE_HEADERS).toContain(column);
    }
    // The cell values are on screen but NOT in the cache.
    expect(JSON.stringify(stored)).not.toContain("describes v_0");
  });

  test("@setup the cache is written at RUN START and from nowhere else on Setup", () => {
    // The call site, asserted structurally: the round-trip above proves the module works, and this proves
    // Setup actually calls it — and calls it in the one place production does. See the describe-block note
    // on why the browser cannot reach Start in a static build.
    const setupTsx = path.resolve(path.dirname(test.info().file), "..", "..", "src", "pages", "run", "setup.tsx");
    expect(existsSync(setupTsx), `expected Setup at ${setupTsx}`).toBe(true);
    const src = readFileSync(setupTsx, "utf8");

    // Imported from the shared module, not reimplemented.
    expect(src).toMatch(/import \{[^}]*\brememberAssignment\b[^}]*\} from "@\/lib\/column-prefill";/);

    // Exactly ONE call, and its arguments are the header list and the role map — nothing else, and
    // nothing derived from the first-value column (T-08b-2).
    const calls = [...src.matchAll(/rememberAssignment\(([^)]*)\)/g)].map((m) => m[1].trim());
    expect(calls).toEqual(["d.headers, d.roles"]);

    // And that one call sits inside `onStart`. Extracted by brace-matching from the function header, so
    // moving the write out to a mapping handler fails here rather than passing on a whole-file grep.
    const start = src.indexOf("async function onStart()");
    expect(start, "expected an `async function onStart()` in setup.tsx").toBeGreaterThan(-1);
    let depth = 0;
    let end = src.indexOf("{", start);
    for (let i = end; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) {
        end = i;
        break;
      }
    }
    const onStartBody = src.slice(start, end);
    expect(onStartBody).toContain("rememberAssignment(d.headers, d.roles)");

    // NOT on a mapping edit. `setRoles` is the per-keystroke role handler; caching from there would
    // persist a half-finished assignment as though it were the reviewer's answer.
    const setRoles = src.indexOf("function setRoles(");
    expect(setRoles).toBeGreaterThan(-1);
    const setRolesBody = src.slice(setRoles, src.indexOf("\n  }", setRoles));
    expect(setRolesBody).not.toContain("rememberAssignment");
  });

  test("@setup the run is quoted a duration RANGE beside its price, hedged as an estimate", async ({
    page,
  }) => {
    await page.goto(SETUP);
    await page.waitForLoadState("networkidle");
    const dur = page.getByTestId("estimate-duration");
    await expect(dur).toBeVisible();

    // A RANGE, not a bare figure: both ends are quoted and they differ.
    const low = Number(await dur.getAttribute("data-low"));
    const high = Number(await dur.getAttribute("data-high"));
    expect(low).toBeGreaterThan(0);
    expect(high).toBeGreaterThan(low);
    // The single blended range is the SYNC/PREVIEW rendering. Batch no longer shows one, because its
    // queue and its work have wildly different uncertainties and blending them hid which half was
    // uncertain — batch itemises instead (see the recalibration describe block below).
    await page.getByTestId("run-mode").selectOption("sync");
    await expect(dur).toHaveAttribute("data-mode", "sync");
    const shown = (await page.getByTestId("estimate-duration-range").innerText()).trim();
    // Two duration tokens either side of a dash, e.g. "about 3 min–21 min". A single token would be a
    // bare figure dressed as a span, which is the thing the plan's prohibition forbids.
    expect(shown).toMatch(/[–-]/);
    expect(shown.match(/\d+\s*(?:s|min|h)\b/g) ?? []).toHaveLength(2);

    // HEDGED. It reads as an estimate, and it never promises.
    await expect(dur).toContainText(/estimate|approximately|about|~/i);
    await expect(dur).not.toContainText(/guarantee|will take exactly/i);
    await expect(dur).not.toContainText(/\bexactly\b/i);

    // Beside the price, not on a screen of its own: same panel as the cost estimate.
    await expect(page.getByTestId("estimate-panel").getByTestId("estimate-duration")).toHaveCount(1);
  });

  test("@setup batch's duration is the WIDE, queue-caveated one — sync's is the narrow one", async ({
    page,
  }) => {
    await page.goto(SETUP);
    await page.waitForLoadState("networkidle");
    const dur = page.getByTestId("estimate-duration");

    await expect(dur).toHaveAttribute("data-mode", "batch");
    const batch = {
      low: Number(await dur.getAttribute("data-low")),
      high: Number(await dur.getAttribute("data-high")),
    };
    // Batch names the queue, because the queue — not the corpus — is what makes its span wide, and a
    // long quiet stretch has to read as normal rather than as a stalled run.
    await expect(dur).toContainText(/queue/i);

    await page.getByTestId("run-mode").selectOption("sync");
    await expect(dur).toHaveAttribute("data-mode", "sync");
    const sync = {
      low: Number(await dur.getAttribute("data-low")),
      high: Number(await dur.getAttribute("data-high")),
    };

    // Batch's span is far WIDER than sync's, and its width comes from the queue.
    //
    // HISTORY, so nobody re-derives the old numbers. Until 2026-08-26 `BATCH_QUEUE_SECS` was 300 with
    // high = mid x 3, which capped batch at ~17 min at this fixture size and made it read FASTER than
    // sync (411s mid against sync's 705s) for every corpus above roughly 500 variables. That inverted
    // the real tradeoff — batch buys cost with latency — and it contradicted the run-mode label's own
    // "can take hours". The queue is now modelled on the provider's documented behaviour instead.
    expect(batch.high - batch.low).toBeGreaterThan(sync.high - sync.low);
    expect(batch.high / batch.low).toBeGreaterThan(sync.high / sync.low);
    // Only batch carries the queue caveat — sync has no queue to wait in.
    await expect(dur).not.toContainText(/queue/i);
  });

  test("@setup preview quotes its OWN duration rather than blanking or borrowing a paid mode's", async ({
    page,
  }) => {
    await page.goto(SETUP);
    await page.waitForLoadState("networkidle");
    const dur = page.getByTestId("estimate-duration");
    const batchMid = Number(await dur.getAttribute("data-mid"));

    await page.getByTestId("run-mode").selectOption("preview");
    // The run is free — and the duration is still there. A blank duration on the one mode that costs
    // nothing would read as "unknown" for the mode that is in fact the quickest and most predictable.
    await expect(page.getByTestId("estimate-free")).toBeVisible();
    await expect(dur).toBeVisible();
    await expect(dur).toHaveAttribute("data-mode", "preview");
    const previewMid = Number(await dur.getAttribute("data-mid"));
    expect(previewMid).toBeGreaterThan(0);
    // Its own figure, not the paid mode's carried over.
    expect(previewMid).toBeLessThan(batchMid);
    // And it explains why it is quick, in terms of what preview does — no model call, so no queue.
    await expect(dur).not.toContainText(/queue/i);
  });
});

test.describe("Setup — the key field and the disclosure polish (08-13b)", () => {
  // ── the four production lifts, and the one DROP (08-13b Task 3) ────────────────────────────────
  //
  // `08-INHERITED-UI-AUDIT.md` § "Setup (08-13)" records five candidates from the shipped New Run form.
  // Items 1-4 were LIFTED (the provider key hint + get-a-key link, the show/hide reveal, the counted
  // advanced-roles disclosure, the fuller data-handling copy). Item 5 — advanced RUN KNOBS — was
  // DROPPED, on principle rather than on effort: asking for tuning parameters before any data has been
  // read is the ask-at-minimum-information pattern the whole staged-gate review exists to remove. The
  // last test in this block asserts the drop, because a decision nobody checks is a decision that
  // quietly comes back.

  test("@setup the key field is single-sourced from the shared provider map, not a second copy", () => {
    // The constant was a local `const` in `pages/home.tsx`. It is now declared ONCE and imported twice —
    // a hint map copied into the second screen is a hint map that goes stale there, and a stale
    // placeholder is worse than none because it looks authoritative.
    const declarations = ["src/lib/provider-keys.ts", "src/pages/home.tsx", "src/pages/run/setup.tsx"]
      .map((rel) => path.resolve(path.dirname(test.info().file), "..", "..", rel))
      .flatMap((abs) => {
        expect(existsSync(abs), `expected ${abs}`).toBe(true);
        return [...readFileSync(abs, "utf8").matchAll(/PROVIDER_KEY_INFO\s*[:=]/g)].map(() => abs);
      });
    expect(declarations).toHaveLength(1);
    expect(declarations[0]).toContain("lib/provider-keys.ts");

    // Both screens IMPORT it.
    for (const rel of ["src/pages/home.tsx", "src/pages/run/setup.tsx"]) {
      const src = readFileSync(
        path.resolve(path.dirname(test.info().file), "..", "..", rel),
        "utf8",
      );
      expect(src, `${rel} must import the shared map`).toMatch(
        /import \{[^}]*\bPROVIDER_KEY_INFO\b[^}]*\} from "@\/lib\/provider-keys";/,
      );
    }

    // Every hint we carry is complete and safe to render: a real placeholder, and an https link or none
    // at all. A half-populated entry is what produces the empty anchor the next test rules out.
    for (const [provider, info] of Object.entries(PROVIDER_KEY_INFO)) {
      expect(info.placeholder, `${provider} needs a placeholder`).toBeTruthy();
      if (info.link !== undefined) expect(info.link).toMatch(/^https:\/\/\S+$/);
    }
    // And the providers `PROVIDER_LABELS` carries but this map does not are the ones that must degrade:
    // `local` needs no provider key at all, `other` has nowhere to send anyone.
    expect(PROVIDER_KEY_INFO.local).toBeUndefined();
    expect(PROVIDER_KEY_INFO.other).toBeUndefined();
    expect(keyPlaceholderFor("local")).toBe("your API key");
    expect(keyPlaceholderFor("anthropic")).toBe(PROVIDER_KEY_INFO.anthropic.placeholder);
  });

  test("@setup the key field is hinted for the selected provider, with a working get-a-key link", async ({
    page,
  }) => {
    await page.goto(SETUP);
    await page.waitForLoadState("networkidle");

    const key = page.getByTestId("api-key");
    await expect(key).toBeVisible();
    // The placeholder is the SELECTED provider's, read from the shared map rather than hard-coded here —
    // so this fails if the field stops being provider-driven, not merely if the string changes.
    await expect(page.getByTestId("provider")).toHaveValue("anthropic");
    await expect(key).toHaveAttribute("placeholder", PROVIDER_KEY_INFO.anthropic.placeholder);
    // Named for its provider, so the field says WHOSE key it wants.
    await expect(key).toHaveAttribute("aria-label", /anthropic/i);

    // A real link, to a real place. Asserted as the map's href rather than as "some anchor".
    const link = page.getByTestId("api-key-help-link");
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", PROVIDER_KEY_INFO.anthropic.link!);
    await expect(link).toHaveAttribute("rel", /noreferrer/);

    // Switching provider re-hints the field. `openai` is offered-but-disabled here (only Anthropic is
    // validated end to end), so the change is driven on the native control the component listens to
    // rather than by clicking an option the UI deliberately does not let you pick.
    await page.getByTestId("provider").evaluate((el) => {
      (el as HTMLSelectElement).value = "openai";
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await expect(key).toHaveAttribute("placeholder", PROVIDER_KEY_INFO.openai.placeholder);
    expect(PROVIDER_KEY_INFO.openai.placeholder).not.toBe(PROVIDER_KEY_INFO.anthropic.placeholder);
    await expect(page.getByTestId("api-key-help-link")).toHaveAttribute(
      "href",
      PROVIDER_KEY_INFO.openai.link!,
    );
    await expect(key).toHaveAttribute("aria-label", /openai/i);
  });

  test("@setup an unhinted provider degrades to a generic field rather than a broken link", async ({
    page,
  }) => {
    await page.goto(SETUP);
    await page.waitForLoadState("networkidle");
    // `local` (on-prem) has no entry in the map. The field must still work: generic placeholder, and NO
    // anchor at all — an <a> with an empty href is a dead control, and this screen does not render them.
    await page.getByTestId("provider").evaluate((el) => {
      (el as HTMLSelectElement).value = "local";
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await expect(page.getByTestId("api-key")).toHaveAttribute("placeholder", "your API key");
    await expect(page.getByTestId("api-key-help-link")).toHaveCount(0);
    // Nowhere on the screen is there an anchor with nothing behind it.
    const deadLinks = await page.$$eval("a", (as) =>
      as.filter((a) => {
        const href = a.getAttribute("href");
        return href === null || href.trim() === "" || href.trim() === "#";
      }).length,
    );
    expect(deadLinks).toBe(0);
  });

  test("@setup the key can be revealed, and the reveal says which way it is about to go", async ({
    page,
  }) => {
    await page.goto(SETUP);
    await page.waitForLoadState("networkidle");
    const key = page.getByTestId("api-key");
    const reveal = page.getByTestId("api-key-reveal");

    // Masked by default — the reveal is opt-in, never the starting state.
    await expect(key).toHaveAttribute("type", "password");
    await expect(reveal).toHaveAttribute("aria-label", "Show API key");

    await reveal.click();
    await expect(key).toHaveAttribute("type", "text");
    // The label names the ACTION, so it changes with state. A static "Toggle key visibility" would tell
    // a screen-reader user nothing about which state they are in — this is production's pattern.
    await expect(reveal).toHaveAttribute("aria-label", "Hide API key");

    await reveal.click();
    await expect(key).toHaveAttribute("type", "password");
    await expect(reveal).toHaveAttribute("aria-label", "Show API key");

    // Revealing is a RENDERING change only: the value is untouched and nothing is persisted.
    await key.fill("sk-ant-test-value");
    await reveal.click();
    await expect(key).toHaveValue("sk-ant-test-value");
    const persisted = await page.evaluate(() => ({
      local: JSON.stringify(localStorage).includes("sk-ant-test-value"),
      session: JSON.stringify(sessionStorage).includes("sk-ant-test-value"),
    }));
    expect(persisted).toEqual({ local: false, session: false });
  });

  test("@setup every column role is offered in the dropdown by default, with no disclosure to open", async ({
    page,
  }) => {
    await page.goto(DRAFT);
    await page.waitForLoadState("networkidle");
    await page.getByTestId("dict-upload").setInputFiles({
      name: "roles.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(dictionaryCsv(4)),
    });

    // REVIEW FEEDBACK 2026-08-26: the advanced roles were held behind a "Show advanced column roles (3)"
    // disclosure. The reviewer's verdict was to show them in the dropdown by default. A dropdown is
    // already a closed list the reviewer opens deliberately — putting three of its options behind a
    // SECOND disclosure made the reviewer open two things to answer one question, and the roles it hid
    // (`category`, `field_id`, `standard_code`) are ordinary mapping targets, not dangerous ones.
    const select = page.getByTestId("role-select").first();
    for (const role of ["category", "field_id", "standard_code"]) {
      await expect(select.locator(`option[value="${role}"]`)).toHaveCount(1);
    }
    // The primary roles are of course still there, and still grouped.
    await expect(select.locator('option[value="description"]')).toHaveCount(1);
    await expect(select.locator("optgroup")).not.toHaveCount(0);

    // The disclosure is GONE, not merely defaulted open — a trigger that never hides anything is a
    // control with no state, which reads as broken.
    await expect(page.getByTestId("advanced-roles-toggle")).toHaveCount(0);
    await expect(page.getByTestId("advanced-roles-in-use")).toHaveCount(0);

    // And selecting one of the formerly-hidden roles still works and still sticks.
    await page.getByTestId("role-select").nth(2).selectOption("category");
    await expect(page.getByTestId("role-select").nth(2)).toHaveValue("category");
  });

  test("@setup the data-handling copy is the fuller production wording", async ({ page }) => {
    await page.goto(SETUP);
    await page.waitForLoadState("networkidle");
    const handling = page.getByTestId("api-key-handling");
    await expect(handling).toBeVisible();
    // The short form said only where the key goes. The fuller wording also says what it is NOT written
    // to, and that a reload clears it — which is the part a reviewer being asked to paste a credential
    // into a browser actually wants to read.
    await expect(handling).toContainText(/this run/i);
    await expect(handling).toContainText(/HTTPS/);
    await expect(handling).toContainText(/disk/i);
    await expect(handling).toContainText(/logs?/i);
    await expect(handling).toContainText(/saved run configuration/i);
    await expect(handling).toContainText(/reload/i);
    // And it never claims more than it can: no encryption promise, no "secure" hand-wave.
    await expect(handling).not.toContainText(/encrypted|bank-grade|military/i);
  });

  test("@setup Setup offers NO run-tuning control — item 5 was dropped, and stays dropped", async ({
    page,
  }) => {
    await page.goto(SETUP);
    await page.waitForLoadState("networkidle");

    // Asking for a tuning parameter before any dictionary has been read is asking at the moment of least
    // information. Named individually rather than as one regex so a future addition fails against the
    // specific knob it added.
    for (const knob of [
      /temperature/i,
      /top[-_ ]?[pk]\b/i,
      /max[-_ ]?tokens/i,
      /\bseed\b/i,
      /min[-_ ]?cluster[-_ ]?size/i,
      /n[-_ ]?neighbou?rs/i,
      /min[-_ ]?samples/i,
      /\bepsilon\b/i,
      /retrieval[-_ ]?floor/i,
      /adopt[-_ ]?floor/i,
      /\btop[-_ ]?k\b/i,
      /chunk[-_ ]?size/i,
      /\bthreshold\b/i,
      /advanced (options|settings|parameters)/i,
    ]) {
      await expect(page.locator("body"), `Setup must not offer ${knob}`).not.toContainText(knob);
    }

    // And the run-configuration panel's controls are EXACTLY the known set: what to match against, how
    // to run it, what to call it, who runs it, on what, and with whose key. Nothing tunable.
    const ids = await page.$$eval("select, input:not([type=file]), textarea", (els) =>
      els.map((e) => e.getAttribute("data-testid") ?? e.getAttribute("id") ?? "").filter(Boolean),
    );
    const expected = ["cde-set", "run-mode", "run-name", "provider", "model", "api-key"];
    for (const id of expected) expect(ids).toContain(id);
    // Everything else on the screen is a role select in a mapping table, never a knob.
    const unexpected = ids.filter((id) => !expected.includes(id) && id !== "role-select");
    expect(unexpected).toEqual([]);
  });
});

// ── the batch-duration recalibration + itemisation (2026-08-26) ────────────────────────────────
//
// WHY THIS EXISTS. 08-13b lifted the duration estimate onto Setup and, in doing so, exposed a
// contradiction between two pieces of already-shipped code:
//
//   `setup.tsx` run-mode label  ->  "Batch — about half the cost, CAN TAKE HOURS"
//   `types.ts`  estimateRunTime ->  BATCH_QUEUE_SECS = 300, high = mid x 3  ->  ~17 min at 1k vars
//
// The estimator structurally could not quote what the picker promised: to reach even two hours it
// needed ~40,000 variables, more than three times our largest bundled cohort. Worse, above roughly
// 500 variables it showed batch as FASTER than sync, inverting the actual tradeoff.
//
// The label was right and the model was wrong. Under-quoting a DURATION is the same class of error as
// under-quoting a COST, which this phase already prohibits ("MUST NOT quote a cost lower than what
// will be charged"), so the model was recalibrated to the provider's documented behaviour: most
// batches inside an hour, up to 24 hours permitted.
//
// And because a 5-minute-to-24-hour span is nearly useless as one blended figure, batch now ITEMISES
// — processing and queue wait as two labelled lines — so the reader can see which half is uncertain.
test.describe("Setup — the batch duration is modelled on the queue, and itemised", () => {
  test("@setup batch's high end reaches HOURS, so the estimator can quote what the label promises", async ({
    page,
  }) => {
    await page.goto(SETUP);
    await page.waitForLoadState("networkidle");
    const dur = page.getByTestId("estimate-duration");
    await expect(dur).toHaveAttribute("data-mode", "batch");

    const high = Number(await dur.getAttribute("data-high"));
    // "Can take hours" has to be reachable at a REALISTIC corpus size, not only at a hypothetical one.
    expect(high).toBeGreaterThanOrEqual(2 * 3600);
    // And the run-mode label that makes the promise is still on the page making it.
    await expect(page.getByTestId("run-mode")).toContainText(/hours/i);
  });

  test("@setup batch's WORST case always exceeds sync's, so it never reads as the quicker option", async ({
    page,
  }) => {
    await page.goto(SETUP);
    await page.waitForLoadState("networkidle");
    const dur = page.getByTestId("estimate-duration");

    await expect(dur).toHaveAttribute("data-mode", "batch");
    const bMid = Number(await dur.getAttribute("data-mid"));
    const bHigh = Number(await dur.getAttribute("data-high"));

    await page.getByTestId("run-mode").selectOption("sync");
    await expect(dur).toHaveAttribute("data-mode", "sync");
    const sMid = Number(await dur.getAttribute("data-mid"));
    const sHigh = Number(await dur.getAttribute("data-high"));

    // THE UNIVERSAL PROPERTY, and the one that matters: batch's CEILING always exceeds sync's, at
    // every bundled cohort size (it holds until ~107,000 variables, where sync's per-variable term
    // finally outgrows the 24h queue — our largest bundled cohort is UKBB at 11,800). So a reviewer
    // choosing batch to save money is never told the worst case is also shorter.
    expect(bHigh).toBeGreaterThan(sHigh);

    // The MID comparison is size-dependent and deliberately asserted only here, at this fixture's
    // 1,000 variables. Batch genuinely parallelises, so above roughly 4,000 variables its typical
    // case really IS shorter than sequential sync's — that is true, not a modelling artefact, and it
    // must not be "fixed". What the old 300s floor got wrong was different: it made batch look faster
    // at EVERY size including small ones, and capped its ceiling below sync's, so the latency cost of
    // batch disappeared from the quote entirely.
    expect(bMid).toBeGreaterThan(sMid);
  });

  test("@setup batch itemises processing and queue wait, and shows no single blended figure", async ({
    page,
  }) => {
    await page.goto(SETUP);
    await page.waitForLoadState("networkidle");
    await expect(page.getByTestId("estimate-duration")).toHaveAttribute("data-mode", "batch");

    const proc = page.getByTestId("estimate-duration-processing");
    const queue = page.getByTestId("estimate-duration-queue");
    await expect(proc).toBeVisible();
    await expect(queue).toBeVisible();

    // The whole point of splitting: NO blended span for batch. One figure spanning 5 min to 24 hours
    // hides that the work is minutes and the wait is the unknown.
    await expect(page.getByTestId("estimate-duration-range")).toHaveCount(0);

    // Each line says which thing it is timing.
    await expect(proc).toContainText(/processing|work/i);
    await expect(queue).toContainText(/queue/i);
    // The queue line carries a TYPICAL case as well as a span, or a 24-hour ceiling reads as the
    // expected outcome rather than the worst one.
    await expect(queue).toContainText(/typical/i);
  });

  test("@setup the queue is shown as the uncertain half — its span is wider than the work's", async ({
    page,
  }) => {
    await page.goto(SETUP);
    await page.waitForLoadState("networkidle");
    const proc = page.getByTestId("estimate-duration-processing");
    const queue = page.getByTestId("estimate-duration-queue");

    const pLow = Number(await proc.getAttribute("data-low"));
    const pHigh = Number(await proc.getAttribute("data-high"));
    const qLow = Number(await queue.getAttribute("data-low"));
    const qHigh = Number(await queue.getAttribute("data-high"));

    expect(pHigh).toBeGreaterThan(pLow);
    expect(qHigh).toBeGreaterThan(qLow);
    // This asymmetry is the justification for itemising at all. If it ever stops holding, the split
    // has stopped earning its place and this test should fail rather than be deleted.
    expect(qHigh - qLow).toBeGreaterThan(pHigh - pLow);
    // The queue dominates the total, which is why the copy tells the reviewer to expect quiet.
    expect(qHigh).toBeGreaterThan(pHigh);
  });

  test("@setup sync and preview carry no queue line — they have no queue to wait in", async ({
    page,
  }) => {
    await page.goto(SETUP);
    await page.waitForLoadState("networkidle");
    const dur = page.getByTestId("estimate-duration");

    for (const mode of ["sync", "preview"] as const) {
      await page.getByTestId("run-mode").selectOption(mode);
      await expect(dur).toHaveAttribute("data-mode", mode);
      await expect(page.getByTestId("estimate-duration-queue")).toHaveCount(0);
      await expect(page.getByTestId("estimate-duration-processing")).toHaveCount(0);
      // And they keep the single blended range, which is honest when there is only one term.
      await expect(page.getByTestId("estimate-duration-range")).toHaveCount(1);
      await expect(dur).not.toContainText(/queue/i);
    }
  });
});


/**
 * Setup's THIRD STATE — the free BOUNDARY, with the preprocessing report RETIRED (08-14d).
 *
 * WHAT CHANGED AND WHY. 08-14b demoted Gate 0 and moved its 444 reviewed lines onto this screen as a
 * pre-flight panel. Reviewing that live on 2026-08-31, Bhargav retired the content outright: the
 * verbosity buried the screen, and the phase's remaining value is in Gates 1-4. So the PANEL is gone —
 * `PreFlightPanel.tsx`, `lib/preprocess-report.ts`, `lib/text-diff.ts` and the components built to serve
 * them, plus the 1,497-line `preflight.spec.ts` that covered it.
 *
 * WHAT SURVIVES, and it is the point of this block. The BOUNDARY is not the panel. `08-DECISION-GATE0.md`
 * D-3 keeps the backend pause at `gate0: before_harmonize` exactly as built, so a run still parks here,
 * still costs nothing to reach, and still needs its first charge committed from this screen. The panel was
 * the receipt; the boundary is the money. Deleting the first must not disturb the second, and these
 * assertions are what says so.
 *
 * ASSERTED FROM SOURCE AS WELL AS FROM THE DOM. A deleted component that is still imported somewhere is a
 * build error, but a deleted component whose *copy* was pasted into its replacement is not — and copy is
 * exactly what was being complained about. The grep gate below reads the source tree.
 */
test.describe("Setup — the boundary, with the report retired", () => {
  /**
   * Serve a MUTATED copy of the committed fixture, so the state under test is a real payload with one
   * fact substituted. Same technique the retired panel's spec used, and for the same reason: the shipped
   * fixture is parked at Gate 1, and a file cannot honestly be parked at two boundaries at once.
   */
  async function withRun(
    page: import("@playwright/test").Page,
    mutate: (payload: Record<string, unknown>) => void,
  ): Promise<void> {
    const res = await page.request.get(`/static-data/result-${PAUSED_RUN_FIXTURE}.json`);
    const payload = (await res.json()) as Record<string, unknown>;
    mutate(payload);
    await page.route("**/static-data/result-*.json", (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify(payload) }),
    );
  }

  /**
   * The fixture, re-parked at the RETIRED boundary.
   *
   * This used to be described as "where a real run sits after Start". It is not, since 08-14f: a fresh
   * run enters the staged flow at Gate 1 and never parks here. It is where the six runs that predate the
   * change are parked, which is exactly why the position and its screen must keep working.
   */
  const atBoundary = (p: Record<string, unknown>): void => {
    (p as { status: string; phase: string }).status = "awaiting_review";
    (p as { status: string; phase: string }).phase = "awaiting_review";
    (p as { gatePosition: string }).gatePosition = RETIRED_GATE;
    (p.result as { gatePosition: string }).gatePosition = RETIRED_GATE;
  };

  test("@setup the source tree no longer reaches for the retired report, in any file", async () => {
    // THE DELETION GATE. A component with no importer still ships in the bundle if something imports it
    // for a type, and a stray import is how "deleted" quietly becomes "unrendered". Read the tree.
    const { readdirSync, readFileSync, statSync, existsSync: exists } = await import("node:fs");
    const { dirname, join, resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

    // The files themselves are GONE — not emptied, not commented out.
    for (const gone of [
      "src/components/gate/PreFlightPanel.tsx",
      "src/components/gate/InputQualitySignals.tsx",
      "src/components/gate/RulePipelineList.tsx",
      "src/components/gate/DiffText.tsx",
      "src/lib/preprocess-report.ts",
      "src/lib/text-diff.ts",
      "tests/e2e/preflight.spec.ts",
    ]) {
      expect(exists(resolve(root, gone)), `${gone} must be deleted, not left behind`).toBe(false);
    }

    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((e) => {
        const p = join(dir, e);
        return statSync(p).isDirectory() ? walk(p) : [p];
      });
    const offenders = walk(resolve(root, "src"))
      .filter((f) => /\.tsx?$/.test(f))
      .filter((f) => /PreFlightPanel|preprocess-report|text-diff|DiffText|RulePipelineList|InputQualitySignals/.test(readFileSync(f, "utf8")));
    expect(offenders.map((f) => f.slice(root.length + 1))).toEqual([]);
  });

  test("@setup a run at the boundary renders no preprocessing report at all", async ({ page }) => {
    await withRun(page, atBoundary);
    await page.goto(SETUP);
    await page.waitForLoadState("networkidle");

    // Every testid the report owned, gone — including the ones behind its disclosure, which is why the
    // count is asserted rather than the visibility.
    for (const id of [
      "preflight",
      "prepare-aggregate",
      "preflight-finding",
      "preflight-gap",
      "preflight-summary",
      "preflight-all-clear",
      "frozen-audit-trail",
      "cohort-panel",
      "example-before",
      "example-after",
    ]) {
      await expect(page.getByTestId(id), `${id} belonged to the retired report`).toHaveCount(0);
    }
    // And its prose is not paraphrased somewhere else on the screen either.
    const text = await page.locator("main").innerText();
    expect(text).not.toMatch(/what preparation found/i);
    expect(text).not.toMatch(/before you spend/i);
  });

  test("@setup the boundary still parks the run, collapses the mapping and offers the first charge", async ({
    page,
  }) => {
    // THE BOUNDARY IS NOT THE PANEL (D-3). Deleting the report must leave a parked run exactly as
    // committable as it was — this is the assertion that separates the two.
    await withRun(page, atBoundary);
    await page.goto(SETUP);
    await page.waitForLoadState("networkidle");

    await expect(page.getByTestId("commit-bar")).toBeVisible();
    await expect(page.getByTestId("nothing-charged-yet")).toBeVisible();
    // The mapping is COLLAPSED, not deleted: the column roles are fixed for this run, so five open tables
    // would be five tables of decisions that can no longer be made.
    const disclosure = page.getByTestId("setup-dictionaries-disclosure");
    await expect(disclosure).toBeVisible();
    await expect(page.getByTestId("dict-card")).toHaveCount(0);
    await expect(page.getByTestId("setup-dictionaries-summary")).toContainText(/dictionaries/);
    await disclosure.getByRole("button").first().click();
    await expect(page.getByTestId("dict-card")).toHaveCount(5);
    // And the read-back's honest absence survived the collapse.
    await expect(page.getByTestId("name-check-unavailable").first()).toBeVisible();
  });

  test("@setup a run past the boundary says so and points at where to rejoin", async ({ page }) => {
    // The committed fixture is parked at Gate 1, i.e. PAST this boundary. The note is what stops this
    // screen reading as a live decision, and it must not offer a charge that has already happened.
    await page.goto(SETUP);
    await page.waitForLoadState("networkidle");
    const note = page.getByTestId("past-boundary-note");
    await expect(note).toBeVisible();
    await expect(note).toContainText(/moved on/i);
    await expect(note.getByRole("link")).toBeVisible();
    await expect(page.getByTestId("commit-bar")).toHaveCount(0);
    // The mapping is NOT collapsed here: there is no finding above it competing for attention.
    await expect(page.getByTestId("setup-dictionaries-disclosure")).toHaveCount(0);
    await expect(page.getByTestId("dict-card")).toHaveCount(5);
  });

  test("@setup reaching the boundary never hops through the retired gate path", async ({ page }) => {
    // ASSERT THE HOP, NOT THE DESTINATION. After the demotion the retired URL redirects to this screen,
    // so Setup -> retired path -> Setup leaves the correct final URL and fails nothing — it is visible
    // only as a flicker. `framenavigated` fires for the history-API pushes this router uses, so the whole
    // path is observable.
    const seen: string[] = [];
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) seen.push(new URL(frame.url()).pathname);
    });
    await withRun(page, atBoundary);
    await page.goto(SETUP);
    await page.waitForLoadState("networkidle");
    await expect(page.getByTestId("commit-bar")).toBeVisible();
    expect(seen.filter((u) => u.endsWith(`/${RETIRED_GATE}`)), `navigated: ${seen.join(" -> ")}`).toEqual(
      [],
    );
  });

  test("@setup the post-Start destination is Gate 1, and no input makes it the retired one", async () => {
    // ASSERTED AS A PURE FUNCTION because the button that calls it is DISABLED in the static build this
    // suite runs against (`setup.tsx`'s IS_STATIC guard), so a click-through is untestable here — and an
    // untestable destination is exactly how this line came to still point at a retired route.
    //
    // IT IS GATE 1 SINCE 08-14f. It used to come back to Setup, into a "pre-flight" state whose Continue
    // was the real first charge. Start IS that charge now, so there is no screen between the press and
    // the first gate.
    expect(startedPathFor("abc123")).toBe("/run/abc123/gate1");
    for (const id of ["abc123", "", "demo-staged-gate1", "0", "a/b"]) {
      expect(startedPathFor(id), `startedPathFor(${JSON.stringify(id)})`).not.toContain(`/${RETIRED_GATE}`);
      expect(startedPathFor(id)).toMatch(/\/gate1$/);
      // AND IT IS NOT SETUP EITHER. Landing back here is what produced the intermediate screen.
      expect(startedPathFor(id)).not.toMatch(/\/setup$/);
    }
    // The retired position is still a legal RESUME target's input — six runs carry it and must not 404.
    expect(setupPathFor("abc123")).toBe("/run/abc123/setup");
  });

  test("@setup Setup holds ONE subscription to the run, not two", async () => {
    const { readFileSync } = await import("node:fs");
    const { dirname, resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const src = readFileSync(resolve(root, "src/pages/run/setup.tsx"), "utf8");
    // Matched on the ASSIGNMENT, so a comment naming the hook cannot push the count to two. A second
    // subscription beside the page's own is two sources for one run's state, which is the defect the
    // shell's own stop control was written to avoid. The panel that used to be checked here for the same
    // property is gone; the export that replaced it is a pure render over props and opens none either.
    expect([...src.matchAll(/=\s*useHarmonizeStream\(/g)]).toHaveLength(1);
    const exp = readFileSync(resolve(root, "src/components/gate/PreparedExport.tsx"), "utf8");
    expect(exp).not.toContain("useHarmonizeStream");
  });

  test("@setup there is no raw-HTML injection on Setup or on what it still renders", async () => {
    const { readFileSync } = await import("node:fs");
    const { dirname, resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    // Uploaded dictionary text is echoed on a screen the guest walk reaches. The before/after examples
    // that made this rule urgent are deleted, but the cohort names on the export are still the user's.
    for (const f of [
      "src/pages/run/setup.tsx",
      "src/components/gate/PreparedExport.tsx",
      "src/components/gate/DictionaryTipsPanel.tsx",
    ]) {
      expect(readFileSync(resolve(root, f), "utf8"), f).not.toContain("dangerouslySetInnerHTML");
    }
  });
});


/**
 * The run's FIRST CHARGE, re-sited onto Setup (08-14b Task 3).
 *
 * `08-DECISION-GATE0.md` D-3 amends UI-SPEC §0.1: the control that commits the run's first charge used to
 * be Gate 0's Continue and is now the pre-flight's own, on this screen. The RULE is unchanged and still
 * binds — R8's *never quote a cost lower than what will be charged*, the amount on the button, the
 * irreversible-spend statement inline rather than in a modal.
 */
test.describe("Setup — the run's first charge", () => {
  async function atPreflight(page: import("@playwright/test").Page, extra?: (p: Record<string, unknown>) => void) {
    const res = await page.request.get(`/static-data/result-${PAUSED_RUN_FIXTURE}.json`);
    const payload = (await res.json()) as Record<string, unknown>;
    (payload as { status: string; phase: string }).status = "awaiting_review";
    (payload as { status: string; phase: string }).phase = "awaiting_review";
    (payload as { gatePosition: string }).gatePosition = RETIRED_GATE;
    (payload.result as { gatePosition: string }).gatePosition = RETIRED_GATE;
    extra?.(payload);
    await page.route("**/static-data/result-*.json", (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify(payload) }),
    );
  }

  test("@setup the commit control carries a non-zero amount and an INLINE irreversible-spend statement", async ({
    page,
  }) => {
    await atPreflight(page);
    await page.goto(SETUP);
    await page.waitForLoadState("networkidle");

    const bar = page.getByTestId("commit-bar");
    await expect(bar).toBeVisible();
    // THE AMOUNT AS DATA, so this reads the figure rather than parsing it back out of a sentence.
    expect(Number(await bar.getAttribute("data-total"))).toBeGreaterThan(0);
    await expect(bar).toHaveAttribute("data-first-charge", "true");
    // The statement is IN the bar, and it says the two things R8 requires.
    await expect(bar).toContainText(/not refundable/i);
    await expect(bar).toContainText(/spending begins/i);
    // NO MODAL stands between the reviewer and the charge: a modal on the primary path is met at every
    // gate, always says yes, and by the third gate is dismissed unread.
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
  });

  test("@setup `Nothing is charged yet` is true and visible ABOVE the commit control", async ({ page }) => {
    await atPreflight(page);
    await page.goto(SETUP);
    await page.waitForLoadState("networkidle");
    const statement = page.getByTestId("nothing-charged-yet");
    await expect(statement).toBeVisible();
    await expect(statement).toContainText("Nothing is charged yet");
    const above = (await statement.boundingBox())!.y;
    const bar = (await page.getByTestId("commit-bar").boundingBox())!.y;
    expect(above).toBeLessThan(bar);
  });

  test("@setup the amount on the commit control equals the first charge in Setup's own bill", async ({
    page,
  }) => {
    // TWO SURFACES, ONE FUNCTION. A reviewer can see the figure twice on this screen, and two readings of
    // one number silently disagreeing is the defect `@setup the variable count on screen…` was written
    // for. Both read `estimateRunCostBreakdown(...).firstCharge`.
    await atPreflight(page);
    await page.goto(SETUP);
    await page.waitForLoadState("networkidle");
    const onButton = Number(await page.getByTestId("commit-bar").getAttribute("data-total"));
    const inBill = ((await page.getByTestId("first-charge").innerText()) ?? "").match(/\$([\d,.]+)/);
    expect(inBill, "the bill must still quote a first charge").not.toBeNull();
    expect(Number(inBill![1].replace(/,/g, ""))).toBeCloseTo(onButton, 2);
  });

  test("@setup a PREVIEW run is quoted no amount and told it buys nothing", async ({ page }) => {
    // Preview calls no model, so it must not be told it is about to spend. Quoting a charge that will not
    // happen is the same class of error as under-quoting one, and R8 binds in both directions.
    await atPreflight(page, (p) => {
      (p as { config: Record<string, unknown> }).config = {
        ...((p as { config: Record<string, unknown> }).config ?? {}),
        run_mode: "preview",
      };
    });
    await page.goto(SETUP);
    await page.waitForLoadState("networkidle");
    const bar = page.getByTestId("commit-bar");
    await expect(bar).toBeVisible();
    await expect(bar).toHaveAttribute("data-total", "");
    await expect(bar).toHaveAttribute("data-first-charge", "false");
    await expect(bar).not.toContainText(/not refundable/i);
    await expect(bar).toContainText(/buys nothing|calls no model/i);
  });

  test("@setup the commit control stays above the fold at 1440x900", async ({ page }) => {
    // THE PROPERTY PRE-BUILD QUESTION Q1 WAS DECIDED ON. The screen carrying the run's first charge keeps
    // the amount and the reason on screen together — the sticky column is what guarantees it whatever the
    // left column is doing, and appending under five mapping tables is the defect the 08-13 two-column
    // review was opened to fix.
    await atPreflight(page);
    await page.goto(SETUP);
    await page.waitForLoadState("networkidle");
    const box = (await page.getByTestId("commit-bar").boundingBox())!;
    expect(box.y, "the commit control must be visible without scrolling").toBeLessThan(900);
    expect(box.y + box.height).toBeLessThanOrEqual(900 + 1);
  });

  test("@setup NO screen in the staged flow still names the retired gate as the charge point", async ({
    page,
  }) => {
    // READ FROM THE DOM, not by grepping source: a comment recording where the charge USED to land must
    // not fail this gate, and a rendered string must not be able to pass it.
    for (const screen of ["setup", "gate1", "gate2", "gate3", "gate4"]) {
      await page.goto(`/run/${PAUSED_RUN_FIXTURE}/${screen}`);
      await page.waitForLoadState("networkidle");
      // Expand every disclosure, so copy behind one is still read.
      for (const t of await page.getByRole("button", { name: /how to use this screen/i }).all()) {
        await t.click();
      }
      const text = await page.locator("main").innerText();
      expect(text, `${screen}: first charge still attributed to the retired gate`).not.toMatch(
        /first charge[^.]*Gate 0/i,
      );
      expect(text, `${screen}: still tells the reviewer to Continue at the retired gate`).not.toMatch(
        /Continue at Gate 0/i,
      );
      expect(text, `${screen}: still names the retired gate at all`).not.toMatch(/\bGate 0\b/i);
    }
  });

  test("@setup the prepared-dictionary export survives the report, as a primary affordance", async ({
    page,
  }) => {
    // D-5 SURVIVES 08-14d. The export was always the one part of this surface a reviewer could use: their
    // own columns back, verbatim and in order, with the embedding text appended. It is independent of the
    // report — it re-reads and re-prepares the file on request rather than reading the run's capped diff —
    // and with the report deleted it is the ONLY way to see what preparation did.
    await atPreflight(page);
    await page.goto(SETUP);
    await page.waitForLoadState("networkidle");
    const exp = page.getByTestId("prepared-export").first();
    await expect(exp).toBeVisible();
    // REACHABLE WITHOUT EXPANDING ANYTHING. It is the answer, not a footnote behind a disclosure — and the
    // disclosure it used to sit beside is deleted, so there is nothing left to hide it behind.
    await expect(exp.getByRole("heading")).toBeVisible();

    // THE STATIC BUILD HAS NO SERVER TO RE-READ THE UPLOAD FROM, so `preparedExportUrl` returns null here
    // and what renders is the honest-absence branch. That branch is asserted for what it is — a stated
    // reason and a next step, never a dead link — and the AVAILABLE branch's copy is asserted below,
    // since no run in this suite can produce it.
    await expect(exp.getByTestId("prepared-export-unavailable")).toBeVisible();
    await expect(exp).toContainText(/no server to re-read/i);
    await expect(exp.getByRole("link")).toHaveCount(0);
  });

  test("@setup the export states what it contains, for every variable rather than a sample", async () => {
    const { readFileSync } = await import("node:fs");
    const { dirname, resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    // READ FROM SOURCE because the branch that renders it is unreachable in a static build. It is a claim
    // about COPY, and the copy is what makes the export an answer rather than a link. Its file moved out
    // of the deleted panel and into its own component, which is the whole reason this path is re-pointed.
    const src = readFileSync(resolve(root, "src/components/gate/PreparedExport.tsx"), "utf8");
    expect(src).toMatch(/EVERY variable/i);
    expect(src).toContain("ddharmon_embedding_text");
    expect(src).toMatch(/not only the ones that changed/i);
  });

  test("@setup nothing on Setup claims the staged flow is free until you pick what to buy", async ({
    page,
  }) => {
    await atPreflight(page);
    await page.goto(SETUP);
    await page.waitForLoadState("networkidle");
    const text = await page.locator("main").innerText();
    expect(text).not.toMatch(/free until you (choose|decide|pick)/i);
    expect(text).not.toMatch(/costs nothing until you (choose|decide|pick)/i);
    // The true statement IS made: where the money starts is named.
    expect(text).toMatch(/first charge/i);
  });
});


/**
 * The dictionary-hygiene tips (08-14d Task 2) — what replaces the deleted report.
 *
 * DELIBERATELY MODEST, and the modesty is the requirement. The report was retired for verbosity, so a
 * wall of tips would be the same failure in a friendlier voice: five or six pitfalls, closed by default,
 * one line of what-to-do each.
 *
 * WHY IT IS ON THE COMPOSE STATE ONLY. The advice is *"tidy the file before you upload it"*, and a run's
 * column mapping is fixed at `startHarmonize` — so at the boundary and past it, none of this is actionable
 * without starting a fresh run. That is the same reasoning `08-DECISION-GATE0.md` D-4 settled for the
 * duplicate-name finding: a recommendation belongs where it can be acted on, and restating it later and
 * less actionably is how two surfaces make one finding untrustworthy.
 *
 * WHERE THE CONTENT COMES FROM. Not from imagination — from the rules core's `preprocess_dictionary`
 * already implements, which are the empirical record of what real dictionaries get wrong, plus this
 * repo's three recorded gotchas. Generic to any dictionary; no cohort is named as an example of doing it
 * wrong.
 */
test.describe("Setup — the dictionary-hygiene tips", () => {
  test("@setup the tips are a CLOSED disclosure, costing one row until asked", async ({ page }) => {
    await page.goto(DRAFT);
    await page.waitForLoadState("networkidle");
    const tips = page.getByTestId("dictionary-tips");
    await expect(tips).toBeVisible();
    await expect(tips).toHaveAttribute("data-state", "closed");
    // CLOSED MEANS CLOSED: not a styled-away block. Nothing inside is in the tree until it is opened.
    await expect(page.getByTestId("dictionary-tip")).toHaveCount(0);
    // One row, not a panel. Measured against the screen's other closed disclosure, which is the pattern
    // this one was told to match rather than invent a second of.
    const box = (await tips.boundingBox())!;
    expect(box.height, "a closed disclosure is a row").toBeLessThan(72);
  });

  test("@setup the disclosure's accessible name says what it reveals, both ways", async ({ page }) => {
    await page.goto(DRAFT);
    await page.waitForLoadState("networkidle");
    const trigger = page.getByTestId("dictionary-tips").getByRole("button").first();
    // An icon-only control whose name does not say what it operates on is a defect, not a style choice
    // (UI-SPEC §6). Asserted in BOTH states, because a name that stops describing the action once
    // toggled is half a name.
    await expect(trigger).toHaveAccessibleName(/show .*(dictionary|file)/i);
    await trigger.click();
    await expect(trigger).toHaveAccessibleName(/hide .*(dictionary|file)/i);
  });

  // The 08-14d bound ("five or six pitfalls, each with a what / why / fix") is SUPERSEDED by 08-14f, which
  // rewrote the panel as imperative one-liners with one example each and re-bounded it at seven. Its
  // replacement lives with the other 08-14f checklist assertions at the end of this file; keeping both
  // would leave two specs disagreeing about the same panel's shape. The rules that were NOT about shape —
  // it leads with the repeated name, it never claims we clean the file, it names no cohort — are all
  // still asserted below, unchanged.

  test("@setup it LEADS with the repeated-variable-name trap, and points at the live check", async ({
    page,
  }) => {
    await page.goto(DRAFT);
    await page.waitForLoadState("networkidle");
    await page.getByTestId("dictionary-tips").getByRole("button").first().click();
    const first = page.getByTestId("dictionary-tip").first();
    // IT IS FIRST because it is the only one here the product cannot fix for the reviewer: the loader
    // keys on the variable name and the last row wins, so the earlier ones are gone before any rule runs.
    await expect(first).toContainText(/variable name/i);
    const text = await first.innerText();
    expect(text).toMatch(/(last|only the last|silently|vanish|dropped)/i);
    // AND IT CROSS-REFERENCES the check already on this screen rather than duplicating it. The tips
    // explain the class; `nameCheck` reports the reviewer's actual file, live, as the mapping changes.
    // Read from the PANEL rather than the bullet: 08-14f made every bullet a one-line directive, so the
    // pointer moved to the panel's closing line. The rule is unchanged; only where it is written is.
    const panel = await page.getByTestId("dictionary-tips").innerText();
    expect(panel).toMatch(/(this screen|the mapping|below|checks your file)/i);
  });

  test("@setup the copy says automated preparation is FORTHCOMING and claims nothing about today", async ({
    page,
  }) => {
    await page.goto(DRAFT);
    await page.waitForLoadState("networkidle");
    await page.getByTestId("dictionary-tips").getByRole("button").first().click();
    const text = await page.getByTestId("dictionary-tips").innerText();
    expect(text).toMatch(/forthcoming|coming|not yet/i);
    expect(text).toMatch(/before you upload|before uploading/i);
    // NOTHING IS PROMISED ABOUT PREPARATION THAT RUNS TODAY. 08-14e turns the pipeline stage off, and
    // this plan must not depend on having landed first — so a present-tense claim in either direction is
    // a claim this screen cannot keep.
    expect(text).not.toMatch(/we (clean|prepare|fix|strip|normalis|normaliz)/i);
    expect(text).not.toMatch(/ddharmon (cleans|prepares|fixes|strips)/i);
    expect(text).not.toMatch(/(is|are) (cleaned|prepared|stripped|normalised|normalized) (for you|automatically)/i);
  });

  test("@setup the guidance is generic — no cohort is named as an example of doing it wrong", async ({
    page,
  }) => {
    await page.goto(DRAFT);
    await page.waitForLoadState("networkidle");
    await page.getByTestId("dictionary-tips").getByRole("button").first().click();
    const text = await page.getByTestId("dictionary-tips").innerText();
    // Cohort-agnostic by construction is a project rule, not a copy preference: rules must be generic and
    // discovered, never hardcoded to the cohorts we happened to test. Naming one here would also
    // publish an internal judgement about a partner's data on a screen a guest can reach.
    for (const cohort of ["UKBB", "UK Biobank", "CLSA", "Arivale", "HPP", "TwinsUK", "MESA", "AI-READI", "All of Us", "AoU", "PPMI", "FHS"]) {
      expect(text, `${cohort} is named as an example`).not.toContain(cohort);
    }
  });

  test("@setup the tips are absent once the run is started, where they cannot be acted on", async ({
    page,
  }) => {
    // D-4's rule, applied to this panel. The column mapping is fixed at `startHarmonize`, so advice about
    // the FILE is un-actionable from here without a fresh run — and advice you cannot take is noise on a
    // screen that was just cleared of noise.
    await page.goto(SETUP);
    await page.waitForLoadState("networkidle");
    await expect(page.getByTestId("dictionary-tips")).toHaveCount(0);
  });
});

// --- the per-dictionary flow: map, confirm, export (08-14f) ---------------------------------------------
//
// THE SHAPE BHARGAV ASKED FOR, after stress-testing the live screen on 2026-08-31: upload a dictionary,
// map its columns, mark THAT dictionary complete, and its embedding-text CSV becomes available on the same
// page. When every dictionary is marked, the workbook becomes available. Nothing on this path charges
// anything, and proceeding afterwards goes straight to Gate 1.
//
// WHAT THE STATIC BUILD CAN AND CANNOT SEE. There is no backend here, so the DOWNLOAD itself is
// unreachable and its absence branch is what renders. That is asserted for what it is. The state machine —
// unconfirmed → confirmed → invalidated by a re-map — is fully exercisable and is the half that carries the
// defect this task exists to prevent.

test.describe("Setup — per-dictionary confirmation and the embedding export", () => {
  async function uploadMapped(page: import("@playwright/test").Page, name = "mapme.csv") {
    await page.goto(DRAFT);
    await page.waitForLoadState("networkidle");
    await page.getByTestId("dict-upload").setInputFiles({
      name,
      mimeType: "text/csv",
      buffer: Buffer.from(csv([["col_a", "col_b"], ["v1", "d1"], ["v2", "d2"]])),
    });
    const row = page.getByTestId("mapping-row").filter({ has: page.locator('[data-column="col_b"]') });
    await row.getByTestId("role-select").selectOption("description");
    return page.getByTestId("dict-embedding-export").first();
  }

  test("@setup an unmapped dictionary offers no export, and says what the mapping still needs", async ({
    page,
  }) => {
    await page.goto(DRAFT);
    await page.waitForLoadState("networkidle");
    await page.getByTestId("dict-upload").setInputFiles({
      name: "bare.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(csv([["col_a", "col_b"], ["1", "2"], ["3", "4"]])),
    });
    const panel = page.getByTestId("dict-embedding-export").first();
    await expect(panel).toHaveAttribute("data-confirmed", "false");
    await expect(page.getByTestId("dict-embedding-download")).toHaveCount(0);
    // A DISABLED CONTROL WITH NO REASON IS A DEAD END, and this screen already has five tables above it.
    await expect(panel.getByTestId("dict-mapping-confirm")).toBeDisabled();
    await expect(panel.getByTestId("dict-mapping-blocked")).toContainText(/variable name|description|question/i);
  });

  test("@setup marking one dictionary complete offers ITS export, on the same page and with no run", async ({
    page,
  }) => {
    const posts: string[] = [];
    await page.route("**/api/**", async (route) => {
      if (route.request().method() !== "GET") posts.push(route.request().url());
      await route.continue();
    });
    const panel = await uploadMapped(page);

    await panel.getByTestId("dict-mapping-confirm").click();

    await expect(panel).toHaveAttribute("data-confirmed", "true");
    await expect(panel.getByTestId("dict-mapping-confirmed")).toBeVisible();
    await expect(panel.getByTestId("dict-embedding-download")).toBeVisible();
    // ON THE SAME PAGE: confirming navigated nowhere.
    expect(new URL(page.url()).pathname).toBe(DRAFT);
    // AND STARTED NOTHING. The whole point of the job-less endpoint is that this path is free; a run
    // created here would be a charge the reviewer did not ask for.
    expect(posts, `unexpected writes: ${posts.join(", ")}`).toEqual([]);
  });

  test("@setup re-mapping a confirmed dictionary invalidates it and withdraws the export", async ({ page }) => {
    // THE DEFECT THIS STATE SHAPE EXISTS FOR. A reviewer who downloads a CSV, edits the mapping, and then
    // reads the CSV as current is reading a description of a mapping that no longer exists — and nothing
    // on the screen would have told them. Confirmation holds the MAPPING, so the edit invalidates it
    // structurally rather than through an effect that has to remember to fire.
    const panel = await uploadMapped(page);
    await panel.getByTestId("dict-mapping-confirm").click();
    await expect(panel).toHaveAttribute("data-confirmed", "true");

    const row = page.getByTestId("mapping-row").filter({ has: page.locator('[data-column="col_a"]') });
    await row.getByTestId("role-select").selectOption("variable_name");

    await expect(panel).toHaveAttribute("data-confirmed", "false");
    await expect(page.getByTestId("dict-embedding-download")).toHaveCount(0);
    await expect(panel.getByTestId("dict-mapping-confirm")).toBeEnabled();
  });

  test("@setup the workbook control names what is outstanding rather than sitting inert", async ({ page }) => {
    const panel = await uploadMapped(page);
    const workbook = page.getByTestId("workbook-export");
    await expect(workbook).toBeVisible();
    await expect(workbook).toHaveAttribute("data-remaining", "1");
    await expect(workbook.getByTestId("workbook-remaining")).toContainText("1 of 1");
    await expect(workbook.getByTestId("workbook-confirm")).toBeDisabled();

    await panel.getByTestId("dict-mapping-confirm").click();

    await expect(workbook).toHaveAttribute("data-remaining", "0");
    await expect(workbook.getByTestId("workbook-confirm")).toBeEnabled();
    await workbook.getByTestId("workbook-confirm").click();
    await expect(workbook).toHaveAttribute("data-confirmed", "true");
    await expect(workbook.getByTestId("workbook-download")).toBeVisible();
  });

  test("@setup editing a mapping withdraws the workbook too", async ({ page }) => {
    const panel = await uploadMapped(page);
    await panel.getByTestId("dict-mapping-confirm").click();
    const workbook = page.getByTestId("workbook-export");
    await workbook.getByTestId("workbook-confirm").click();
    await expect(workbook.getByTestId("workbook-download")).toBeVisible();

    const row = page.getByTestId("mapping-row").filter({ has: page.locator('[data-column="col_a"]') });
    await row.getByTestId("role-select").selectOption("variable_name");

    await expect(workbook.getByTestId("workbook-download")).toHaveCount(0);
    await expect(workbook).toHaveAttribute("data-confirmed", "false");
  });

  test("@setup the whole per-dictionary path is free, and the page says so", async ({ page }) => {
    const panel = await uploadMapped(page);
    await panel.getByTestId("dict-mapping-confirm").click();
    await expect(panel).toContainText(/costs nothing|starts no run/i);
    await expect(page.getByTestId("nothing-charged-yet")).toBeVisible();
  });

  test("@setup the repeated-name check still fires pre-Start, alongside the new flow", async ({ page }) => {
    // THIS FLOW MUST NOT DISPLACE THE ONE CHECK THAT ALREADY WORKED. The loader's silent last-wins drop is
    // the project's longest-standing data loss, and it is reported live from the reviewer's own file.
    await page.goto(DRAFT);
    await page.waitForLoadState("networkidle");
    await page.getByTestId("dict-upload").setInputFiles({
      name: "repeats.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(dictionaryCsv(10, { repeat: true })),
    });
    await expect(page.getByTestId("name-check")).toHaveAttribute("data-fired", "true");
    await expect(page.getByTestId("dict-embedding-export").first()).toBeVisible();
  });

  test("@setup a dictionary read back from a started run offers no confirmation control", async ({ page }) => {
    // Its column roles are FIXED at `startHarmonize`, so a control that marks the mapping complete would
    // be a control that changes nothing — worse than a disabled one, because it lies about what it does.
    await page.goto(SETUP);
    await page.waitForLoadState("networkidle");
    await expect(page.getByTestId("dict-card").first()).toBeVisible();
    await expect(page.getByTestId("dict-embedding-export")).toHaveCount(0);
    await expect(page.getByTestId("workbook-export")).toHaveCount(0);
  });
});


// --- Start is the first charge, and it lands on Gate 1 (08-14f) -----------------------------------------

test.describe("Setup — Start is the charge, Gate 1 is the destination", () => {
  /** Serve a MUTATED copy of the committed fixture — one fact substituted on a real payload. */
  async function withParkedRun(page: import("@playwright/test").Page): Promise<void> {
    const res = await page.request.get(`/static-data/result-${PAUSED_RUN_FIXTURE}.json`);
    const payload = (await res.json()) as Record<string, unknown>;
    // Re-parked at the RETIRED position: the state the six existing runs are in, which nothing new can
    // reach any more and which must still resolve.
    (payload as { status: string; phase: string }).status = "awaiting_review";
    (payload as { status: string; phase: string }).phase = "awaiting_review";
    (payload as { gatePosition: string }).gatePosition = RETIRED_GATE;
    ((payload as { result: { gatePosition: string } }).result).gatePosition = RETIRED_GATE;
    await page.route("**/static-data/result-*.json", (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify(payload) }),
    );
  }

  test("@setup the Start control states the amount and the irreversible-spend sentence", async ({ page }) => {
    // THE OBLIGATION MOVED WITH THE CHARGE. It used to sit on the pre-flight's Continue one screen later;
    // deleting that screen relocated the charge here, and both duties came with it rather than being
    // dropped in transit.
    await page.goto(DRAFT);
    await page.waitForLoadState("networkidle");
    await page.getByTestId("dict-upload").setInputFiles({
      name: "charged.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(dictionaryCsv(40)),
    });
    await expect(page.getByTestId("dict-card")).toHaveCount(1);

    const bar = page.getByTestId("commit-bar");
    await expect(bar).toBeVisible();
    // THE AMOUNT AS DATA, so this reads the figure rather than parsing it back out of a sentence.
    expect(Number(await bar.getAttribute("data-total"))).toBeGreaterThan(0);
    await expect(bar).toHaveAttribute("data-first-charge", "true");
    await expect(bar).toContainText(/not refundable/i);
    await expect(bar).toContainText(/spending begins/i);
    // NO MODAL stands between the reviewer and the charge (R8 / UI-SPEC §8.5).
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
  });

  test("@setup the amount on Start equals the first charge in Setup's own bill", async ({ page }) => {
    // TWO SURFACES, ONE FUNCTION. A reviewer can see the figure twice on this screen, and two readings of
    // one number silently disagreeing is the defect this pairing exists to prevent. Both read
    // `estimateRunCostBreakdown(...).firstCharge`.
    await page.goto(DRAFT);
    await page.waitForLoadState("networkidle");
    await page.getByTestId("dict-upload").setInputFiles({
      name: "billed.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(dictionaryCsv(40)),
    });
    await expect(page.getByTestId("dict-card")).toHaveCount(1);
    const onButton = Number(await page.getByTestId("commit-bar").getAttribute("data-total"));
    const inBill = ((await page.getByTestId("first-charge").innerText()) ?? "").match(/\$([\d,.]+)/);
    expect(inBill, "the bill must still quote a first charge").not.toBeNull();
    expect(Number(inBill![1].replace(/,/g, ""))).toBeCloseTo(onButton, 2);
  });

  test("@setup a PREVIEW run is quoted no amount at Start and told it buys nothing", async ({ page }) => {
    // R8 binds in BOTH directions: quoting a charge that will not happen is the same class of error as
    // under-quoting one.
    await page.goto(DRAFT);
    await page.waitForLoadState("networkidle");
    await page.getByTestId("dict-upload").setInputFiles({
      name: "previewed.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(dictionaryCsv(40)),
    });
    await expect(page.getByTestId("dict-card")).toHaveCount(1);
    await page.getByTestId("run-mode").selectOption("preview");
    const bar = page.getByTestId("commit-bar");
    await expect(bar).toHaveAttribute("data-total", "");
    await expect(bar).toHaveAttribute("data-first-charge", "false");
    await expect(bar).not.toContainText(/not refundable/i);
    await expect(bar).toContainText(/buys nothing|calls no model/i);
  });

  test("@setup the bill names Start run as the first charge, not a Continue on another screen", async ({
    page,
  }) => {
    await page.goto(DRAFT);
    await page.waitForLoadState("networkidle");
    await page.getByTestId("dict-upload").setInputFiles({
      name: "named.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(dictionaryCsv(40)),
    });
    const first = page.getByTestId("first-charge");
    await expect(first).toContainText(/Start run/i);
    await expect(first).not.toContainText(/Gate 0/);
  });

  test("@setup a run parked at the retired position still resolves and can still be continued", async ({
    page,
  }) => {
    // SIX RUNS ARE PARKED THERE RIGHT NOW. Nothing new enters that position, but the wire value and its
    // redirect stay (D-3) — ripping them out would strand those runs behind a 404, which is the one
    // outcome this change is not allowed to have.
    await withParkedRun(page);
    await page.goto(`/run/${PAUSED_RUN_FIXTURE}/${RETIRED_GATE}`);
    await page.waitForLoadState("networkidle");
    expect(new URL(page.url()).pathname).toMatch(/\/setup$/);
    const bar = page.getByTestId("commit-bar");
    await expect(bar).toBeVisible();
    await expect(bar).toHaveAttribute("data-first-charge", "true");
  });

  test("@setup a COMPOSE screen offers exactly one charge control", async ({ page }) => {
    // The pre-flight control and the Start control must never both be on screen: two bars each claiming
    // to be the first charge is worse than either one being wrong, because the reviewer cannot tell
    // which figure binds.
    await page.goto(DRAFT);
    await page.waitForLoadState("networkidle");
    await page.getByTestId("dict-upload").setInputFiles({
      name: "one-bar.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(dictionaryCsv(12)),
    });
    await expect(page.getByTestId("dict-card")).toHaveCount(1);
    await expect(page.getByTestId("commit-bar")).toHaveCount(1);
  });
});

// --- the two reference disclosures (08-14f Task 5) ------------------------------------------------------
//
// TWO QUESTIONS, TWO DISCLOSURES, asked at different moments: *"is my file clean enough to upload?"* and
// *"which column is which?"*. Merging them reproduces the verbosity that got the first version rewritten
// — Bhargav read the 08-14d panel live on 2026-08-31 and called it too wordy, which is why the checklist
// is now imperative one-liners with one real example each rather than what/why/fix paragraphs.

test.describe("Setup — the pre-upload checklist and the column-roles reference", () => {
  test("@setup the checklist is at most seven imperative one-liners, each with one example", async ({
    page,
  }) => {
    await page.goto(DRAFT);
    await page.waitForLoadState("networkidle");
    const tips = page.getByTestId("dictionary-tips");
    await expect(tips).toBeVisible();
    // CLOSED by default: it costs one row until it is asked for.
    await expect(page.getByTestId("dictionary-tip")).toHaveCount(0);
    await tips.getByRole("button").first().click();

    const bullets = page.getByTestId("dictionary-tip");
    const n = await bullets.count();
    expect(n).toBeGreaterThan(0);
    expect(n, "the checklist grew past the bound that keeps it readable").toBeLessThanOrEqual(7);
    for (let i = 0; i < n; i += 1) {
      const bullet = bullets.nth(i);
      // ONE EXAMPLE EACH, and it is a distinct element rather than prose — so it renders visibly AS an
      // example and cannot be read as part of the directive.
      await expect(bullet.getByTestId("dictionary-tip-example")).toHaveCount(1);
      const directive = (await bullet.getByTestId("dictionary-tip-do").innerText()).trim();
      expect(directive.length, `bullet ${i} is a paragraph, not a directive: ${directive}`).toBeLessThan(120);
    }
  });

  test("@setup the checklist leads with the repeated variable name and points at the live check", async ({
    page,
  }) => {
    // THE ONE NOTHING CAN FIX FOR THEM. `load_dictionary` keys on the variable name and the last row with
    // a repeat wins, so the earlier rows are gone before any other rule runs. The checklist names the
    // CLASS; the live check on this same screen reports their actual file.
    await page.goto(DRAFT);
    await page.waitForLoadState("networkidle");
    await page.getByTestId("dictionary-tips").getByRole("button").first().click();
    const first = page.getByTestId("dictionary-tip").first();
    await expect(first).toContainText(/variable name/i);
    await expect(first).toContainText(/once|unique|repeat/i);
  });

  test("@setup the expanded checklist fits a desktop viewport without scrolling", async ({ page }) => {
    await page.goto(DRAFT);
    await page.waitForLoadState("networkidle");
    await page.getByTestId("dictionary-tips").getByRole("button").first().click();
    const box = (await page.getByTestId("dictionary-tips").boundingBox())!;
    expect(box.height, "the checklist is taller than the viewport it has to be read in").toBeLessThan(900);
  });

  test("@setup the roles panel states the bare minimum, and that question_text beats description", async ({
    page,
  }) => {
    await page.goto(DRAFT);
    await page.waitForLoadState("networkidle");
    const roles = page.getByTestId("column-roles");
    await expect(roles).toBeVisible();
    // CLOSED by default, like its sibling.
    await expect(page.getByTestId("column-role")).toHaveCount(0);
    await roles.getByRole("button").first().click();

    // THE BARE MINIMUM IS THE POINT. A reviewer who thinks they must map twelve columns will not start.
    const minimum = roles.getByTestId("roles-bare-minimum");
    await expect(minimum).toBeVisible();
    await expect(minimum).toContainText(/at least one of/i);
    await expect(minimum).toContainText(/question_text/);
    await expect(minimum).toContainText(/description/);

    // THE PRECEDENCE, stated as what it means for MAPPING rather than as an implementation note. Getting
    // these two round the wrong way silently changes what is clustered.
    const precedence = roles.getByTestId("roles-precedence");
    await expect(precedence).toContainText(/question_text/);
    await expect(precedence).toContainText(/wins|beats|outranks/i);
    await expect(precedence).toContainText(/verbatim|asked|wording/i);
  });

  test("@setup the roles panel marks required against what to_embedding_text actually does", async ({
    page,
  }) => {
    await page.goto(DRAFT);
    await page.waitForLoadState("networkidle");
    await page.getByTestId("column-roles").getByRole("button").first().click();

    const byRole = async (role: string) => page.getByTestId("column-role").filter({ has: page.locator(`[data-role="${role}"]`) });

    // `category` is OPTIONAL but it DOES enter the clustered string — core appends "Category: …". Marking
    // it "does not affect clustering" alongside units would be the easy, wrong grouping.
    await expect((await byRole("category")).first()).toHaveAttribute("data-clustered", "true");
    // These three feed PROMPTS, never the semantic vector. Value metadata is routed symbolically on
    // purpose: it is geometric noise in the embedding.
    for (const role of ["value_encoding", "data_type", "units"]) {
      await expect((await byRole(role)).first(), role).toHaveAttribute("data-clustered", "false");
    }
    await expect((await byRole("question_text")).first()).toHaveAttribute("data-clustered", "true");
  });

  test("@setup value_encoding shows its inline structure with a worked example", async ({ page }) => {
    await page.goto(DRAFT);
    await page.waitForLoadState("networkidle");
    await page.getByTestId("column-roles").getByRole("button").first().click();
    const row = page.getByTestId("column-role").filter({ has: page.locator('[data-role="value_encoding"]') });
    await expect(row).toContainText("1=Male|2=Female|3=Other");
    await expect(row).toContainText(/transform[- ]spec/i);
  });

  test("@setup both disclosures name what they reveal, for a screen reader", async ({ page }) => {
    await page.goto(DRAFT);
    await page.waitForLoadState("networkidle");
    for (const id of ["dictionary-tips", "column-roles"]) {
      const trigger = page.getByTestId(id).getByRole("button").first();
      const name = await trigger.getAttribute("aria-label");
      expect(name, `${id} has no accessible name`).toBeTruthy();
      expect(name!.length, `${id}'s accessible name says nothing`).toBeGreaterThan(20);
    }
  });

  test("@setup neither disclosure is rendered once the run has started", async ({ page }) => {
    // A run's column roles are fixed at `startHarmonize`, so neither question is still answerable —
    // advice you cannot take is noise on a screen this phase has twice cleared of noise.
    await page.goto(SETUP);
    await page.waitForLoadState("networkidle");
    await expect(page.getByTestId("dictionary-tips")).toHaveCount(0);
    await expect(page.getByTestId("column-roles")).toHaveCount(0);
  });
});

// --- Setup's orientation text, second pass (08-14g Task 1) ----------------------------------------------
//
// The numbered how-to predates TWO structural changes — the Gate 0 demotion and 08-14f's per-dictionary
// rebuild — and still walked the reviewer through a pre-flight screen that no longer exists: press Start,
// download a prepared dictionary, then press Continue for the first charge. All three of those are wrong
// now. Start run IS the first charge and it lands on Gate 1 with nothing in between, and the check worth
// naming happens BEFORE it, per dictionary.
//
// Bhargav's words on 2026-08-31: "'How to use this screen' is now outdated on setup. should mention that
// you can check embedded text for each mapped dict before pressing continue and starting spend."

test.describe("Setup — the how-to describes the screen that exists (08-14g)", () => {
  /** Open the shell's numbered how-to on Setup and hand back its text. */
  const openHowTo = async (page: import("@playwright/test").Page) => {
    await page.goto(DRAFT);
    await page.waitForLoadState("networkidle");
    const panel = page.getByTestId("how-to");
    await expect(panel).toBeVisible();
    await panel.getByRole("button").first().click();
    return panel;
  };

  test("@setup the how-to names the embedded-text check, and places it before the charge", async ({ page }) => {
    const panel = await openHowTo(page);
    const steps = panel.locator("li");
    const texts = await steps.allInnerTexts();

    // THE SCREEN'S MAIN AFFORDANCE. Mark a dictionary complete and you can read the exact string that
    // will be clustered, for your own rows, before committing to anything.
    const checkIdx = texts.findIndex((t) => /clustered/i.test(t) && /download|export/i.test(t));
    expect(checkIdx, `no step offers the embedded-text check:\n${texts.join("\n")}`).toBeGreaterThanOrEqual(0);

    // ORDER IS THE POINT, not mere presence: the check is only useful if it is taken before the money.
    const chargeIdx = texts.findIndex((t) => /start run/i.test(t) && /first charge/i.test(t));
    expect(chargeIdx, `no step names Start run as the first charge:\n${texts.join("\n")}`).toBeGreaterThanOrEqual(0);
    expect(checkIdx, "the check is offered after the reviewer has already paid").toBeLessThan(chargeIdx);
  });

  test("@setup the how-to sends the reviewer to no screen that was deleted", async ({ page }) => {
    const panel = await openHowTo(page);
    const text = await panel.innerText();

    // The pre-flight screen, its preparation report, and the Continue that used to carry the charge are
    // all gone. Copy that still routes through them is worse than no copy: it is a confident wrong map.
    expect(text).not.toMatch(/press continue/i);
    expect(text).not.toMatch(/gate 0/i);
    expect(text).not.toMatch(/prepared dictionary|preparation report/i);
  });

  test("@setup the how-to stays orientation, not documentation", async ({ page }) => {
    const panel = await openHowTo(page);
    const n = await panel.locator("li").count();
    expect(n, "the orientation list grew into a manual").toBeLessThanOrEqual(6);
    const text = await panel.innerText();
    expect(text.length, "the orientation panel is too long to read in one pass").toBeLessThan(700);
  });
});
