import { expect, test } from "@playwright/test";
import {
  PARTICIPANT_ID_HEADERS,
  assignRole,
  nameCheck,
  normalizeHeader,
  participantLevelColumn,
} from "@/lib/dictionary";
import { SCOPE_VERDICT_COPY, declaredComponents } from "@/lib/score-scope";
import { PAUSED_RUN_FIXTURE } from "./routes";

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
    expect(lines).toContain("splitAssign");
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

  test("@setup the primary action carries the nothing-is-charged-yet statement", async ({ page }) => {
    await page.goto(SETUP);
    await page.waitForLoadState("networkidle");
    const statement = page.getByTestId("nothing-charged-yet");
    await expect(statement).toBeVisible();
    await expect(statement).toContainText("Nothing is charged yet");
    await expect(page.getByTestId("start-run")).toBeVisible();
  });

  test("@setup the per-gate breakdown names Gate 0's Continue as the first charge, and what it buys", async ({
    page,
  }) => {
    await page.goto(SETUP);
    await page.waitForLoadState("networkidle");
    const first = page.getByTestId("first-charge");
    await expect(first).toBeVisible();
    // UI-SPEC §0.1 after the plan-review reversal: the first charge is Gate 0's Continue, NOT Gate 1's.
    await expect(first).toContainText(/Continue at Gate 0|Gate 0's Continue/);
    // Pay-as-you-go is the headline now, and the per-gate re-quote promise sits beside it.
    await expect(first).toContainText(/pay gate by gate/i);
    await expect(first).toContainText(/quotes its own cost/i);
    // What the press pays for is still stated — it moved into the tooltip at review, because the panel was
    // too dense to read. Asserted on the tooltip's TEXT, so moving it cannot silently delete it.
    const tip = first.getByRole("button", { name: /what the first charge buys/i });
    await expect(tip).toHaveCount(1);
    await tip.hover();
    const tipText = page.getByRole("tooltip");
    await expect(tipText).toContainText(/generat/i);
    await expect(tipText).toContainText(/split/i);
    await expect(tipText).toContainText(/coherence|judge/i);

    // The per-gate rows are present, and the two free gates say so rather than forecasting a figure.
    const gates = page.locator("[data-gate-forecast]");
    await expect(gates).toHaveCount(6);
    await expect(page.locator("[data-gate-forecast='gate0']")).toContainText(/local|no model/i);
    await expect(page.locator("[data-gate-forecast='gate4']")).toContainText(/no charge|nothing/i);
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

  test("@setup the three run options are shown, priced and defaulted — but decided at their gate", async ({
    page,
  }) => {
    await page.goto(SETUP);
    await page.waitForLoadState("networkidle");
    // Still VISIBLE — an option nobody sees is an unavailable feature, which was the original point of
    // this assertion and survives the move. What changed at review is that Setup no longer DECIDES them:
    // each is a call you make better once you can see what it applies to.
    const gate = page.getByTestId("concept-gate-toggle");
    await expect(gate).toBeVisible();
    await expect(gate).toHaveAttribute("data-default", "false"); // STGD-16 still defaults OFF
    await expect(gate).toContainText(/Gate 2/); // and names where the decision now lives
    // Defaults-off means the run is not quoted for it.
    await expect(page.locator("[data-cost-line='conceptGate']")).toHaveCount(0);

    // The other two are shown the same way, with their own gate named.
    await expect(page.getByTestId("gen-specs-toggle")).toHaveAttribute("data-default", "true");
    await expect(page.getByTestId("suggest-ideas-toggle")).toHaveAttribute("data-default", "true");

    // NOT A CONTROL any more: no checkbox survives in this panel. Asserted directly, because "the
    // decision moved to the gate" is only true if Setup stopped offering it.
    await expect(page.getByTestId("concept-gate-toggle").locator("input[type=checkbox]")).toHaveCount(0);
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
