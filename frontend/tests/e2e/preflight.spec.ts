import { expect, test, type Page } from "@playwright/test";
import {
  RULE_FACETS,
  examplesFor,
  noRuleFired,
  outcomeLabel,
  placeholderStrings,
  preflightRead,
  qualitySignals,
  reconcile,
} from "@/lib/preprocess-report";
import { afterOf, beforeOf, describeInvisibleChange, wordDiff } from "@/lib/text-diff";
import type { PreprocessDiff, PreprocessReport, PreprocessRule } from "@/types";
import { PAUSED_RUN_FIXTURE } from "./routes";

/**
 * The free PRE-FLIGHT on Setup — what preparation found (08-14, demoted onto Setup by 08-14b).
 *
 *   run: npm run test:e2e -- --grep "@preflight"
 *
 * THIS WAS GATE 0'S SPEC and it is the same 60-odd assertions, re-pointed. `08-DECISION-GATE0.md` (D-2)
 * retired the SCREEN, not the stage: the preparation rules, their order and their output are unchanged
 * (D-1), and the surface they report on is now a panel on Setup rather than the flow's second screen. The
 * assertions moved with it because what they hold the surface to did not change at all.
 *
 * TWO THINGS THE MOVE ADDED. The rule pipeline, the worked examples and the row-to-vector panel now sit
 * behind a collapsed disclosure (pre-build question Q2 — reachable, frozen), so the tests over them
 * expand it first. And the panel is reached at Setup's route, because the retired one redirects.
 *
 * WHAT THIS SURFACE IS ASKED TO BE HONEST ABOUT, which is what the assertions are weighted towards:
 *
 *  1. **Three outcomes that a careless implementation collapses into one.** A rule that ran and changed
 *     nothing, a rule that did not run, and a rule that threw are three different claims. Merging them is
 *     the same defect class as rendering an unjudged group as coherent — so each is asserted separately,
 *     and a failed rule is asserted to read as neither of the other two.
 *  2. **One denominator, stated.** Every count on this screen is out of VARIABLES (dictionary rows). A
 *     count of metadata attributes is a different kind of number and never appears as the same one.
 *  3. **Two things the pipeline does not record**, which must render as declared gaps rather than be
 *     quietly omitted — an omitted panel reads as "nothing to say here".
 *  4. **No composite.** The input-quality read is separate denominator-labelled numbers, never a tier,
 *     grade, letter, star or score: a single grade hides which signal is the problem.
 *
 * THE PURE HALF FIRST, deliberately. The rule→example join, the reconciliation arithmetic and the signal
 * derivation are all decisions about data rather than about layout, and all three are the kind of thing
 * weakened by accident. They live in `@/lib/preprocess-report` and are asserted here with no browser: a
 * rule that can only be checked by driving a page is a rule that stops being checked.
 *
 * THE RENDERED HALF drives the real screen. The committed fixture carries a MEASURED preparation report
 * (`scripts/build_gate_fixture.py` reconstructs each cohort from the demo's own field index and runs
 * core's preprocessing over it, at $0), so the populated path needs no interception. The states that
 * fixture cannot honestly contain — a rule that threw, a dictionary where nothing fired, a cohort still
 * running — are driven by intercepting the fixture fetch, which exercises the same render path against
 * test-supplied data rather than inventing a rule failure in a committed file.
 */

const PREFLIGHT = `/run/${PAUSED_RUN_FIXTURE}/setup`;

/**
 * Open the frozen audit trail — the rule pipeline and the row-to-vector panel live behind it now (Q2).
 *
 * Called after every navigation rather than only where it is needed, so no assertion depends on the
 * disclosure's default state. That the default IS closed is asserted once, on its own, below.
 */
async function openAuditTrail(page: Page): Promise<void> {
  const trail = page.getByTestId("frozen-audit-trail").filter({ visible: true }).first();
  if ((await trail.count()) === 0) return;
  if ((await trail.getAttribute("data-state")) === "open") return;
  await trail.getByRole("button").first().click();
  await expect(trail).toHaveAttribute("data-state", "open");
}

/** Navigate to the pre-flight, with the frozen surface expanded. */
async function gotoPreflight(page: Page): Promise<void> {
  await page.goto(PREFLIGHT);
  await page.waitForLoadState("networkidle");
  await openAuditTrail(page);
}

// --- the pure half -------------------------------------------------------------------------------------

function rule(over: Partial<PreprocessRule> = {}): PreprocessRule {
  return {
    rule: "administrative_text_stripping",
    label: "Stripped instrument-administration wrappers and markup",
    outcome: "changed",
    nChanged: 3,
    nVariables: 100,
    detail: "",
    error: "",
    ...over,
  };
}

function diffRow(over: Partial<PreprocessDiff> = {}): PreprocessDiff {
  return {
    variableName: "bmi",
    rawVariableName: "bmi",
    rawDescription: "Body mass index",
    cleanedDescription: "Body mass index",
    nameChanged: false,
    descChanged: false,
    embedNameSuppressed: false,
    ...over,
  };
}

function report(over: Partial<PreprocessReport> = {}): PreprocessReport {
  return {
    cohort: "TestCohort",
    nVariables: 100,
    nUniqueVariableNames: 100,
    nDuplicateVariableNames: 0,
    nNothingToEmbed: 0,
    namesChanged: 0,
    descriptionsChanged: 0,
    ran: true,
    failed: false,
    error: "",
    rules: [rule()],
    diff: [],
    nChangedVariables: 3,
    diffTruncated: false,
    ...over,
  };
}

test.describe("The pre-flight — the report's own arithmetic and provenance, as functions", () => {
  test("@preflight a zero-change rule and a one-change rule produce DIFFERENT words, and neither is silence", () => {
    const none = outcomeLabel(rule({ outcome: "no_change", nChanged: 0 }));
    const one = outcomeLabel(rule({ outcome: "changed", nChanged: 1 }));
    const many = outcomeLabel(rule({ outcome: "changed", nChanged: 4 }));

    expect(none).not.toBe(one);
    // The singular is not cosmetic: "changed 1 variables" is the tell of a count nobody read.
    expect(one).toContain("1 variable");
    expect(one).not.toContain("1 variables");
    expect(many).toContain("4 variables");
    // A zero-change rule states that the check HAPPENED, rather than rendering as absence.
    expect(none).toContain("ran");
    expect(none).toContain("0 variables");
  });

  test("@preflight did-not-run and failed are each distinct from changed-nothing — three claims, three labels", () => {
    const labels = (["no_change", "not_run", "failed"] as const).map((o) =>
      outcomeLabel(rule({ outcome: o, nChanged: 0 })),
    );
    expect(new Set(labels).size).toBe(3);
    // A failure must not read as a clean pass: it may not claim a count at all.
    expect(labels[2]).not.toContain("0 variables");
    expect(labels[2].toLowerCase()).toContain("unknown");
    // ...and "did not run" must not claim a check that never happened.
    expect(labels[1]).not.toContain("changed");
  });

  test("@preflight examples are narrowed by the facet a rule can touch, never attributed to it", () => {
    const rows = [
      diffRow({ variableName: "a", descChanged: true }),
      diffRow({ variableName: "b", nameChanged: true }),
      diffRow({ variableName: "c", embedNameSuppressed: true }),
    ];
    // A description rule may only show description changes.
    expect(examplesFor(rule({ rule: "administrative_text_stripping" }), rows).map((r) => r.variableName)).toEqual(["a"]);
    // A name rule may only show name changes.
    expect(examplesFor(rule({ rule: "common_prefix_stripping" }), rows).map((r) => r.variableName)).toEqual(["b"]);
    // Name-in-description dedup changes NEITHER string — its only evidence is the suppression flag.
    expect(examplesFor(rule({ rule: "name_in_description_dedup" }), rows).map((r) => r.variableName)).toEqual(["c"]);
    // An unknown rule shows NOTHING rather than everything: no provenance means show less, not guess more.
    expect(examplesFor(rule({ rule: "some_rule_added_later" }), rows)).toEqual([]);
  });

  test("@preflight every rule the backend reports has a declared facet, so no rule silently loses its examples", () => {
    // The contract's rule ids come from the adapter's `_PREPROCESS_RULES`. If one is added there and not
    // here, its accordion would expand to an empty body with no error anywhere — so this is the gate.
    for (const id of [
      "unicode_normalization",
      "administrative_text_stripping",
      "option_echo_clearing",
      "placeholder_description_replacement",
      "common_prefix_stripping",
      "stopword_removal",
      "name_in_description_dedup",
      "whitespace_normalization",
    ]) {
      expect(RULE_FACETS[id], `rule ${id} has no declared facet`).toBeTruthy();
    }
  });

  test("@preflight the reconciliation closes against the VARIABLE count, and names the silent drop separately", () => {
    const r = reconcile(report({ nVariables: 120, nUniqueVariableNames: 100, nDuplicateVariableNames: 20, nChangedVariables: 30 }));
    expect(r.variables).toBe(100);
    expect(r.changed + r.untouched).toBe(r.variables);
    // Rows and variables are TWO numbers, because rows minus variables is a silent last-wins drop and
    // folding it into one total is how that loss stays invisible.
    expect(r.rows).toBe(120);
    expect(r.droppedSilently).toBe(20);
    expect(r.ok).toBe(true);
  });

  test("@preflight a rule claiming more changes than there are variables fails the reconciliation", () => {
    const r = reconcile(report({ nUniqueVariableNames: 10, rules: [rule({ nChanged: 11 })], nChangedVariables: 4 }));
    expect(r.ok).toBe(false);
  });

  test("@preflight no-rule-fired is a state of the whole report, and a failed report is not it", () => {
    expect(noRuleFired(report({ rules: [rule({ outcome: "no_change", nChanged: 0 })], nChangedVariables: 0 }))).toBe(true);
    expect(noRuleFired(report({ rules: [rule({ outcome: "changed", nChanged: 1 })] }))).toBe(false);
    // A failure is not "nothing changed" — the outcome is unknown.
    expect(noRuleFired(report({ failed: true, rules: [rule({ outcome: "failed", nChanged: 0 })] }))).toBe(false);
    // Neither is a report that never ran.
    expect(noRuleFired(report({ ran: false, rules: [rule({ outcome: "not_run", nChanged: 0 })] }))).toBe(false);
  });
});

test.describe("The pre-flight — the input-quality signals, as functions", () => {
  test("@preflight every signal carries a count AND a variables denominator, and none is a composite", () => {
    const signals = qualitySignals(report({ nUniqueVariableNames: 200 }));
    expect(signals.length).toBeGreaterThanOrEqual(3);
    for (const s of signals) {
      expect(s.of).toBe(200);
      // The denominator is VARIABLES — dictionary rows — never metadata attributes (P2).
      expect(s.denominator).toBe("variables");
      expect(s.denominator).not.toContain("field");
      expect(s.denominator).not.toContain("attribute");
      expect(Number.isFinite(s.count)).toBe(true);
    }
    // No signal is an average, a share of a grade, or a rollup of the others.
    const ids = signals.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.join(" ")).not.toMatch(/\b(tier|grade|score|rating|composite|overall|index)\b/i);
  });

  test("@preflight the boilerplate signal carries the actual placeholder strings, not only their count", () => {
    const detail = "Field description available on the study website; Selected variable is part of a skip pattern";
    const r = report({
      rules: [rule({ rule: "placeholder_description_replacement", outcome: "changed", nChanged: 45, detail })],
    });
    expect(placeholderStrings(r)).toEqual([
      "Field description available on the study website",
      "Selected variable is part of a skip pattern",
    ]);
    const boilerplate = qualitySignals(r).find((s) => s.id === "boilerplate-description")!;
    expect(boilerplate.count).toBe(45);
    // "45 placeholder descriptions" is an abstraction; the sentence itself is evidence.
    expect(boilerplate.evidence.length).toBe(2);
  });

  test("@preflight descriptionsChanged is never a quality signal — it measures OUR cleaning, not the input", () => {
    // A report whose rules all found nothing but whose descriptionsChanged is high must still read clean:
    // if the derivation leaned on that field, this would report a sparse dictionary that is not one.
    const r = report({
      descriptionsChanged: 180,
      nUniqueVariableNames: 200,
      rules: [
        rule({ rule: "option_echo_clearing", outcome: "no_change", nChanged: 0 }),
        rule({ rule: "placeholder_description_replacement", outcome: "no_change", nChanged: 0 }),
        rule({ rule: "name_in_description_dedup", outcome: "no_change", nChanged: 0 }),
      ],
    });
    for (const s of qualitySignals(r)) expect(s.count).toBe(0);
  });

  test("@preflight a signal reads 0 when its rule did not RUN, and the rule list is where that is disclosed", () => {
    // A `not_run` rule cannot contribute a count — claiming one would report a check that never happened.
    const r = report({
      rules: [rule({ rule: "option_echo_clearing", outcome: "not_run", nChanged: 0 })],
    });
    expect(qualitySignals(r).find((s) => s.id === "echoed-description")!.count).toBe(0);
  });
});

// --- the rendered half ---------------------------------------------------------------------------------

/** The committed fixture, so a variant can be built by mutating the real payload rather than inventing one. */
async function fixturePayload(page: Page): Promise<Record<string, unknown>> {
  const res = await page.request.get(`/static-data/result-${PAUSED_RUN_FIXTURE}.json`);
  return (await res.json()) as Record<string, unknown>;
}

/**
 * Serve a MUTATED copy of the fixture for the states a committed file cannot honestly contain.
 *
 * The mutation is applied to the real payload, so the screen still renders against the true shape of the
 * contract — only the specific fact under test is substituted.
 */
async function withPayload(
  page: Page,
  mutate: (payload: Record<string, unknown>) => void,
): Promise<void> {
  const payload = await fixturePayload(page);
  mutate(payload);
  await page.route("**/static-data/result-*.json", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(payload) }),
  );
}

function reportsOf(payload: Record<string, unknown>): PreprocessReport[] {
  return (payload.result as { preprocessing: PreprocessReport[] }).preprocessing;
}

test.describe("The pre-flight — the word diff that makes a small edit findable", () => {
  /**
   * The defect: preparation's edits are frequently a few characters inside a paragraph, and two blocks of
   * prose side by side do not show them. The reviewer is then asked to authorise the run's first charge on
   * a difference they cannot locate. Every assertion below is about the diff being both VISIBLE and TRUE —
   * a marking that is merely plausible is worse than none, because it invents an edit the run did not make.
   */

  test("@preflight the diff is lossless — each side rebuilds its own string exactly", () => {
    const before = "Current smoking status. <p>Acquired from central registry, updated by participant.";
    const after = "Current smoking status. Acquired from central registry, updated by participant.";

    const d = wordDiff(before, after);

    expect(beforeOf(d)).toBe(before);
    expect(afterOf(d)).toBe(after);
    expect(d.changed).toBe(true);
  });

  test("@preflight an unchanged pair marks nothing, which is different from rendering nothing", () => {
    const d = wordDiff("Age in years", "Age in years");

    expect(d.changed).toBe(false);
    expect(d.segments.every((s) => s.kind === "same")).toBe(true);
    expect(beforeOf(d)).toBe("Age in years");
  });

  test("@preflight only the tokens that actually moved are marked, not the paragraph around them", () => {
    const d = wordDiff("a b c d e", "a b d e");

    const removed = d.segments.filter((s) => s.kind === "removed").map((s) => s.text.trim());
    expect(removed).toEqual(["c"]);
    expect(d.segments.some((s) => s.kind === "added")).toBe(false);
  });

  test("@preflight a pure whitespace change still reads as a change", () => {
    // The normalisation rules exist to collapse these. If the diff dropped whitespace the panel would
    // report "changed" while displaying two identical-looking strings — the exact confusion the second
    // pair was added to end.
    const d = wordDiff("Body  mass\tindex", "Body mass index");

    expect(d.changed).toBe(true);
    expect(beforeOf(d)).toBe("Body  mass\tindex");
    expect(afterOf(d)).toBe("Body mass index");
  });

  test("@preflight an emptied value is a removal, not an empty panel", () => {
    const d = wordDiff("See accompanying documentation", "");

    expect(afterOf(d)).toBe("");
    expect(d.segments.filter((s) => s.kind === "removed").length).toBeGreaterThan(0);
  });

  test("@preflight a pair too large to diff degrades to a whole-value replacement AND says so", () => {
    // Silently returning a coarse result would let the screen claim the entire value changed. `coarse`
    // exists so the UI can label it instead.
    const long = Array.from({ length: 900 }, (_, i) => `w${i}`).join(" ");
    const other = Array.from({ length: 900 }, (_, i) => `x${i}`).join(" ");

    const d = wordDiff(long, other);

    expect(d.coarse).toBe(true);
    expect(beforeOf(d)).toBe(long);
    expect(afterOf(d)).toBe(other);
  });
});

test.describe("The pre-flight — a change you cannot see is named in words", () => {
  /**
   * Found while reviewing the marking on this run's own data. `cmtrt_glcs` reads
   * `...blood glucose levels?\u00a0 Examples:` before and `...blood glucose levels? Examples:` after — a
   * NO-BREAK SPACE collapsed to an ordinary one. The mark is correct and the two halves are genuinely
   * different, but they render identically, so the screen shows a reviewer two matching words and asks
   * them to accept that one of them changed. Marking is not enough when the difference has no glyph: it
   * has to be SAID.
   */

  test("@preflight a difference with no glyph is reported as invisible", () => {
    // Both classes, because they fail differently: a no-break space IS whitespace to a regex, and a
    // zero-width space is NOT — `\s` does not match it, so a whitespace-only test misses it entirely.
    expect(wordDiff("blood glucose levels?\u00a0 Examples", "blood glucose levels? Examples").invisibleOnly).toBe(
      true,
    );
    expect(wordDiff("a\u200bb", "ab").invisibleOnly).toBe(true);
  });

  test("@preflight a real word change is NOT reported as invisible", () => {
    // The failure mode of an over-eager normaliser: calling a substantive edit invisible.
    expect(wordDiff("Age in years", "Age at visit").invisibleOnly).toBe(false);
    expect(wordDiff("Age in years", "Age in years too").invisibleOnly).toBe(false);
    expect(wordDiff("See documentation", "").invisibleOnly).toBe(false);
  });

  test("@preflight the invisible character is NAMED, not called 'whitespace'", () => {
    /**
     * "The difference is whitespace" leaves the reviewer unable to check it against their own file.
     * Naming the codepoint makes it findable — which is the whole point of a preparation report.
     */
    expect(describeInvisibleChange("levels?\u00a0 Examples", "levels? Examples")).toMatch(/no-break space/i);
    expect(describeInvisibleChange("a\tb", "a b")).toMatch(/tab/i);
    expect(describeInvisibleChange("a\u200bb", "ab")).toMatch(/zero-width/i);
    expect(describeInvisibleChange("a  b", "a b")).toMatch(/repeated space|extra space/i);
    // Nothing invisible to report → null, so the caller renders no note rather than an empty one.
    expect(describeInvisibleChange("Age in years", "Age at visit")).toBeNull();
  });

  test("@preflight the screen says so where the pair renders identically", async ({ page }) => {
    await gotoPreflight(page);
    await page.waitForLoadState("networkidle");
    await page.locator('[data-testid="rule-row"][data-outcome="changed"]').first().click();

    // This fixture's `cmtrt_glcs` is the no-break-space case. If it ever stops being, this assertion
    // should be re-pointed at whatever row carries an invisible change rather than deleted.
    const note = page.getByTestId("invisible-change-note").first();
    await expect(note).toBeVisible();
    await expect(note).toContainText(/no-break space/i);
  });
});

test.describe("The pre-flight — the rule pipeline, rendered", () => {
  test("@preflight every rule that ran is listed, including the ones that changed nothing", async ({ page }) => {
    await gotoPreflight(page);
    const rows = page.getByTestId("rule-row");
    await expect(rows.first()).toBeVisible();

    const outcomes = await rows.evaluateAll((els) => els.map((e) => e.getAttribute("data-outcome")));
    // The fixture's cohorts each have rules that fired AND rules that found nothing. A list showing only
    // the ones that fired is indistinguishable from a shorter pipeline.
    expect(outcomes).toContain("changed");
    expect(outcomes).toContain("no_change");
    // Not one row is hidden: a hidden zero-count row cannot be told from a rule never in the pipeline.
    for (const row of await rows.all()) await expect(row).toBeVisible();
  });

  test("@preflight a zero-change row and a one-or-more-change row render distinct text, both visible", async ({ page }) => {
    await withPayload(page, (p) => {
      const r = reportsOf(p)[0];
      r.rules = [
        { ...r.rules[0], rule: "option_echo_clearing", label: "Cleared echoed descriptions", outcome: "no_change", nChanged: 0, detail: "", error: "" },
        { ...r.rules[0], rule: "administrative_text_stripping", label: "Stripped administration wrappers", outcome: "changed", nChanged: 1, detail: "", error: "" },
      ];
      r.nChangedVariables = 1;
    });
    await gotoPreflight(page);

    const zeroRow = page.locator('[data-testid="rule-row"][data-outcome="no_change"]').first();
    const oneRow = page.locator('[data-testid="rule-row"][data-outcome="changed"]').first();
    await expect(zeroRow).toBeVisible();
    await expect(oneRow).toBeVisible();

    const zeroText = (await zeroRow.innerText()).replace(/\s+/g, " ");
    const oneText = (await oneRow.innerText()).replace(/\s+/g, " ");
    expect(zeroText).not.toBe(oneText);
    expect(zeroText).toContain("changed 0 variables");
    expect(oneText).toContain("changed 1 variable");
    expect(oneText).not.toContain("changed 1 variables");
  });

  test("@preflight a rule that threw renders a THIRD state, distinct from changed-nothing and from not-run", async ({ page }) => {
    await withPayload(page, (p) => {
      const r = reportsOf(p)[0];
      r.rules = [
        { ...r.rules[0], rule: "option_echo_clearing", label: "Cleared echoed descriptions", outcome: "no_change", nChanged: 0, detail: "", error: "" },
        { ...r.rules[0], rule: "stopword_removal", label: "Removed configured stopwords", outcome: "not_run", nChanged: 0, detail: "", error: "" },
        {
          ...r.rules[0],
          rule: "placeholder_description_replacement",
          label: "Replaced boilerplate descriptions",
          outcome: "failed",
          nChanged: 0,
          detail: "",
          error: "ValueError: could not read the description column",
        },
      ];
    });
    await gotoPreflight(page);

    const text = async (outcome: string) =>
      (await page.locator(`[data-testid="rule-row"][data-outcome="${outcome}"]`).first().innerText()).replace(/\s+/g, " ");
    const [failed, noChange, notRun] = [await text("failed"), await text("no_change"), await text("not_run")];

    expect(new Set([failed, noChange, notRun]).size).toBe(3);
    // A failure may not claim a count — a clean pass is exactly what it must not read as.
    expect(failed).not.toContain("changed 0 variables");
    expect(failed.toLowerCase()).toContain("unknown");
    // It states the error rather than swallowing it.
    expect(failed).toContain("ValueError");
    // And it is not styled as the neutral did-not-apply row.
    const claim = await page.locator('[data-testid="rule-row"][data-outcome="failed"]').first().getAttribute("data-claim");
    expect(claim).toBe("failed");
  });

  test("@preflight a rule that fired shows at least one worked before/after example", async ({ page }) => {
    await gotoPreflight(page);
    const fired = page.locator('[data-testid="rule-row"][data-outcome="changed"]').first();
    await fired.getByRole("button").first().click();
    const example = fired.getByTestId("rule-example").first();
    await expect(example).toBeVisible();
    // Both halves, labelled — an "after" with no "before" is not a worked example.
    await expect(example.getByTestId("example-before")).toBeVisible();
    await expect(example.getByTestId("example-after")).toBeVisible();
  });

  test("@preflight the reconciled total is stated on screen and equals the dictionary's variable count", async ({ page }) => {
    await gotoPreflight(page);
    const strip = page.getByTestId("rule-reconciliation");
    await expect(strip).toBeVisible();

    const variables = Number(await strip.getAttribute("data-variables"));
    const changed = Number(await strip.getAttribute("data-changed"));
    const untouched = Number(await strip.getAttribute("data-untouched"));
    expect(variables).toBeGreaterThan(0);
    expect(changed + untouched).toBe(variables);
    expect(await strip.getAttribute("data-reconciles")).toBe("true");

    // The number is not only in an attribute: the reviewer reads it.
    const words = (await strip.innerText()).replace(/\s+/g, " ");
    expect(words).toContain(variables.toLocaleString());
    // And it says which number it reconciled against, in this project's terms.
    expect(words).toContain("variables");
    // "field" means a metadata ATTRIBUTE in this product, so it may not be used for a dictionary row.
    expect(words.toLowerCase()).not.toContain("field");
  });

  test("@preflight mojibake in an example is displayed as text and never executed", async ({ page }) => {
    const MOJIBAKE = 'PatientâÂs weight <img src=x onerror="window.__pwned=1"> Ã© <script>window.__pwned=1</script>';
    await withPayload(page, (p) => {
      const r = reportsOf(p)[0];
      r.rules = [
        { ...r.rules[0], rule: "unicode_normalization", label: "Fixed mojibake and encoding artifacts", outcome: "changed", nChanged: 1, detail: "", error: "" },
      ];
      r.diff = [
        {
          variableName: "weight",
          rawVariableName: "weight",
          rawDescription: MOJIBAKE,
          cleanedDescription: "Patient's weight é",
          nameChanged: false,
          descChanged: true,
          embedNameSuppressed: false,
        },
      ];
      r.nChangedVariables = 1;
    });
    await gotoPreflight(page);

    const fired = page.locator('[data-testid="rule-row"][data-outcome="changed"]').first();
    await fired.getByRole("button").first().click();
    const before = fired.getByTestId("example-before").first();
    await expect(before).toBeVisible();

    // The characters are the reviewer's to read...
    await expect(before).toContainText("â");
    await expect(before).toContainText("onerror");
    // ...and nothing in them became an element or ran.
    expect(await before.locator("img, script").count()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  });

  test("@preflight a long example is shown IN FULL — the clamp and the 80-char cap are both gone", async ({ page }) => {
    const LONG = `The participant was asked the following at the study visit: ${"a very long clause about the instrument ".repeat(30)}`;
    await withPayload(page, (p) => {
      const r = reportsOf(p)[0];
      r.rules = [
        { ...r.rules[0], rule: "administrative_text_stripping", label: "Stripped administration wrappers", outcome: "changed", nChanged: 1, detail: "", error: "" },
      ];
      r.diff = [
        {
          variableName: "long_one",
          rawVariableName: "long_one",
          rawDescription: LONG,
          cleanedDescription: "a very long clause about the instrument",
          nameChanged: false,
          descChanged: true,
          embedNameSuppressed: false,
        },
      ];
      r.nChangedVariables = 1;
    });
    await gotoPreflight(page);

    const fired = page.locator('[data-testid="rule-row"][data-outcome="changed"]').first();
    await fired.getByRole("button").first().click();
    const before = fired.getByTestId("example-before").first();
    await expect(before).toBeVisible();

    // SHOWN IN FULL (review 2026-08-26). This used to assert the opposite — that the box was clamped and
    // the whole string lived on `title`. The reviewer's verdict was that the user must see the whole text,
    // and the clamp was only half the problem: core also truncated at 80 characters, so `title` never held
    // the full value either. Now the element renders its entire content and nothing is hidden.
    const box = await before.evaluate((el) => ({
      shown: el.clientHeight,
      full: el.scrollHeight,
      clamp: getComputedStyle(el).webkitLineClamp,
    }));
    expect(box.clamp).toBe("none");
    // Nothing is scrolled out of view inside the element.
    expect(box.full).toBeLessThanOrEqual(box.shown + 1);
    // And the rendered text IS the whole string, not a prefix of it.
    await expect(before).toHaveText(LONG);

    // The card scrolls; the page does not grow past the design canvas because of it.
    const scroller = page.getByTestId("rule-pipeline-scroll");
    const fits = await scroller.evaluate((el) => el.scrollHeight <= el.clientHeight + 1 || getComputedStyle(el).overflowY === "auto");
    expect(fits).toBe(true);
  });

  test("@preflight a dictionary where no rule fired renders the no-changes copy, and it says how that differs from not-run", async ({ page }) => {
    await withPayload(page, (p) => {
      const r = reportsOf(p)[0];
      r.rules = r.rules.map((x) => ({ ...x, outcome: "no_change" as const, nChanged: 0, detail: "", error: "" }));
      r.diff = [];
      r.nChangedVariables = 0;
      r.diffTruncated = false;
    });
    await gotoPreflight(page);

    const empty = page.getByTestId("gate-empty-state").first();
    await expect(empty).toBeVisible();
    const words = (await empty.innerText()).replace(/\s+/g, " ");
    expect(words).toContain("No changes");
    // The contrast is the point: silence here would be read as "the rules did not run".
    expect(words.toLowerCase()).toContain("not running");
    // The rule list still renders beneath it, each row with its count of zero.
    await expect(page.locator('[data-testid="rule-row"][data-outcome="no_change"]').first()).toBeVisible();
  });

  test("@preflight there is no raw-HTML injection anywhere on this surface", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const { dirname, resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = dirname(fileURLToPath(import.meta.url));

    // GLOBBED rather than listed. An uploaded dictionary's text is echoed onto this screen, so the whole
    // surface has to be covered — and a hardcoded list is dodged for free by adding a file to it, which is
    // the failure mode a security gate cannot afford. The page, everything it composes from and the module
    // that derives what it shows.
    // The panel itself is now INSIDE the globbed directory (08-14b), so the page named here is the one
    // that hosts it — uploaded dictionary text is echoed on Setup now, which is the surface the guest
    // walk reaches.
    const gateDir = resolve(here, "../../src/components/gate");
    const files = [
      resolve(here, "../../src/pages/run/setup.tsx"),
      resolve(here, "../../src/lib/preprocess-report.ts"),
      ...readdirSync(gateDir)
        .filter((f) => f.endsWith(".tsx"))
        .map((f) => resolve(gateDir, f)),
    ];
    expect(files.length).toBeGreaterThan(5);
    // COMMENTS STRIPPED FIRST. Several of these files record, in their own docstring, that they use no
    // raw-HTML escape hatch — and a naive substring gate convicts the very sentence that documents the
    // rule (the trap `gate-components.spec.ts` already names). Code is what has to be clean.
    const code = (src: string) =>
      src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
    for (const f of files) {
      expect(code(readFileSync(f, "utf8")), `${f} must not inject raw HTML`).not.toContain(
        "dangerously" + "SetInnerHTML",
      );
    }
  });
});

test.describe("The pre-flight — the frozen surface is reachable, and it is not the headline", () => {
  test("@preflight the audit trail is COLLAPSED by default, with the findings above it", async ({ page }) => {
    // Pre-build question Q2, answered 2026-08-26: the rule pipeline, the worked examples and the
    // row-to-vector panel stay REACHABLE but are frozen, so they sit under a disclosure below the
    // findings. Leading with the provenance is what made the retired screen a receipt rather than a gate.
    await page.goto(PREFLIGHT);
    await page.waitForLoadState("networkidle");

    const trail = page.getByTestId("frozen-audit-trail").filter({ visible: true }).first();
    await expect(trail).toBeVisible();
    await expect(trail).toHaveAttribute("data-state", "closed");
    // Closed means the frozen content is not on screen — and the findings ARE.
    await expect(page.getByTestId("rule-row")).toHaveCount(0);
    await expect(page.getByTestId("row-to-vector")).toHaveCount(0);
    const findings = page.getByTestId("preflight-finding").first();
    await expect(findings).toBeVisible();
    expect((await findings.boundingBox())!.y).toBeLessThan((await trail.boundingBox())!.y);

    // Reachable, in one action, with an accessible name that says what it opens.
    await expect(trail.getByRole("button", { name: /what preparation changed/i })).toBeVisible();
    await openAuditTrail(page);
    await expect(page.getByTestId("rule-row").first()).toBeVisible();
    await expect(page.getByTestId("row-to-vector")).toBeVisible();
  });

  test("@preflight the facet-coverage assertion still has a subject after the move", async ({ page }) => {
    // D-6's RETIRED HAZARD, and the reason Q2's answer had to be "reachable". `RULE_FACETS` is a
    // hand-kept map: a rule added to core and not added to it renders ZERO examples, which reads as
    // "this rule changed nothing". The spec assertion that every reported rule has a declared facet is
    // the only thing standing between a new core rule and that silent misreport — and it asserts against
    // THIS surface. Had the surface been deleted, the assertion would have lost what it checks.
    await gotoPreflight(page);
    const rules = await page.getByTestId("rule-row").evaluateAll((els) =>
      els.map((e) => e.getAttribute("data-rule")),
    );
    expect(rules.length).toBeGreaterThan(0);
    for (const r of rules) {
      expect(RULE_FACETS[r!], `rule ${r} renders here but has no declared facet`).toBeDefined();
    }
  });
});

test.describe("The pre-flight — per-cohort tabs, the row-to-vector panel, and the two honest gaps", () => {
  test("@preflight each cohort gets its own tab, and switching tabs switches the report", async ({ page }) => {
    await gotoPreflight(page);
    const panel = page.getByTestId("cohort-panel");
    await expect(panel).toHaveAttribute("data-state-kind", "report");

    const tabs = page.getByRole("tab");
    // `data-cohort`, not `value`: Radix consumes the `value` prop and never puts it in the DOM, so
    // reading it back yields null — which then blows up inside the matcher rather than failing clearly.
    const names = await tabs.evaluateAll((els) => els.map((e) => e.getAttribute("data-cohort")));
    expect(names.length).toBeGreaterThan(1);
    expect(names.every(Boolean)).toBe(true);
    // One tab open at a time, and the open one is the panel's cohort — not one report re-labelled.
    await expect(panel).toHaveAttribute("data-cohort", names[0]!);

    await tabs.nth(1).click();
    await expect(panel).toHaveAttribute("data-cohort", names[1]!);
    await expect(panel).toHaveAttribute("data-state-kind", "report");
    // Each tab carries its OWN reconciliation, against its own dictionary — behind its own disclosure.
    await openAuditTrail(page);
    await expect(panel.getByTestId("rule-reconciliation")).toBeVisible();
  });

  test("@preflight a cohort still running shows progress, never a completed report", async ({ page }) => {
    await withPayload(page, (p) => {
      const reports = reportsOf(p);
      // One cohort finished, one still to come: the run declares five cohorts and carries four reports.
      const pending = reports.pop()!;
      (p.result as { summary: { cohorts: string[] } }).summary.cohorts = [
        ...reports.map((r) => r.cohort),
        pending.cohort,
      ];
      (p as { status: string; phase: string }).status = "embedding";
      (p as { status: string; phase: string }).phase = "embedding";
    });
    await gotoPreflight(page);

    const pendingTab = page.locator('[role="tab"][data-progress="pending"]').first();
    await expect(pendingTab).toBeVisible();
    await pendingTab.click();

    const panel = page.getByTestId("cohort-panel");
    // The panel says it is still working. It does NOT render a rule list, which would be a completed
    // report on a cohort that has not finished one.
    await expect(panel).toHaveAttribute("data-state-kind", "pending");
    await expect(panel.getByTestId("rule-reconciliation")).toHaveCount(0);
    await expect(panel.getByTestId("rule-row")).toHaveCount(0);

    // And the aggregate does not imply completeness it has not reached.
    const aggregate = page.getByTestId("prepare-aggregate");
    await expect(aggregate).toBeVisible();
    expect(await aggregate.getAttribute("data-complete")).toBe("false");
    const words = (await aggregate.innerText()).replace(/\s+/g, " ");
    expect(words).toMatch(/still (being prepared|preparing|to come)|of 5|not finished/i);
  });

  test("@preflight the aggregate says so plainly when every cohort IS finished", async ({ page }) => {
    await gotoPreflight(page);
    const aggregate = page.getByTestId("prepare-aggregate");
    expect(await aggregate.getAttribute("data-complete")).toBe("true");
  });

  test("@preflight the row-to-vector panel shows the exact grouping input, not the cleaned description", async ({ page }) => {
    await gotoPreflight(page);

    // Read the payload the screen is rendering, and assert the panel shows THAT string.
    const payload = await fixturePayload(page);
    // SEARCH EVERY COHORT, not just the first.
    //
    // This used to read `reportsOf(payload)[0]` and pass — but for the wrong reason. Until 2026-08-26
    // core's `preprocessing_diff` truncated `cleanedDescription` at 80 characters while `embedText` was
    // carried whole, so the two differed for almost every long-description row, artificially. With the
    // truncation removed they legitimately COINCIDE wherever the embedding text simply IS the
    // description — which is most rows, and correct. The genuine divergence is a variable with a real
    // question_text (the embedding text prefers it) or an opaque name; in this fixture that is CLSA, e.g.
    // `CR2_GNDR_TRM` whose description is "CR2 GNDR TRM" while the model reads "Is the person who
    // provided the most assistance male or female?". That is the near-miss the panel exists for.
    const reports = reportsOf(payload);
    let row: (typeof reports)[number]["diff"][number] | undefined;
    let report: (typeof reports)[number] | undefined;
    for (const r of reports) {
      const hit = r.diff.find((d) => d.embedText && d.embedText !== d.cleanedDescription);
      if (hit) {
        row = hit;
        report = r;
        break;
      }
    }
    expect(row, "the fixture must carry a variable whose embedding text differs from its description").toBeTruthy();
    expect(report).toBeTruthy();

    // THE COHORTS ARE TABS, so only the active one's content is mounted. Two mistakes to avoid, both made
    // while writing this: a global `getByTestId("row-to-vector")` resolves to whichever cohort happens to
    // be active and then waits forever for a variable belonging to another; and the tab TRIGGERS live in
    // the tab list, not inside `cohort-panel`, so scoping the trigger lookup to the panel finds nothing.
    // Activate the owning cohort first, then scope the panel by `data-cohort`.
    await page.getByRole("tab", { name: report!.cohort, exact: false }).first().click();
    // A COHORT'S FROZEN SURFACE IS ITS OWN DISCLOSURE. Radix mounts only the active tab's content, so
    // switching cohorts brings up a panel whose audit trail is closed again — and the row-to-vector panel
    // lives inside it (pre-build question Q2).
    await openAuditTrail(page);
    const panel = page
      .locator(`[data-testid="cohort-panel"][data-cohort="${report!.cohort}"]`)
      .getByTestId("row-to-vector");
    await expect(panel).toBeVisible();
    await panel.getByRole("combobox").selectOption(row!.variableName);
    const shown = panel.getByTestId("embed-text");
    await expect(shown).toHaveText(row!.embedText);
    // The near-miss is the whole point: the cleaned description is a DIFFERENT string, and showing it
    // here would answer "why did these group?" wrongly while looking right.
    await expect(shown).not.toHaveText(row!.cleanedDescription);
  });

  test("@preflight a long embedding text is readable in full — it scrolls, it is not cut off", async ({ page }) => {
    /**
     * The defect, found on the real screen: the box was `line-clamp-3`, so a long value ended mid-word
     * with no scrollbar and no control to reveal the rest. `toHaveText` still passed, because textContent
     * is complete — which is exactly why this asserts on the RENDERED box rather than on its text. The
     * full string being present in the DOM is not the same as the reviewer being able to read it, and
     * this panel is the one place the question "what does the model actually see?" can be answered.
     */
    await gotoPreflight(page);
    const payload = await fixturePayload(page);
    const reports = reportsOf(payload);

    // Pick the LONGEST embedding text the fixture carries — a short one cannot demonstrate the overflow.
    let longest: { cohort: string; variableName: string; embedText: string } | undefined;
    for (const r of reports) {
      for (const d of r.diff) {
        if (d.embedText && (!longest || d.embedText.length > longest.embedText.length)) {
          longest = { cohort: r.cohort, variableName: d.variableName, embedText: d.embedText };
        }
      }
    }
    expect(longest, "the fixture carries no embedding text to overflow").toBeTruthy();

    await page.getByRole("tab", { name: longest!.cohort, exact: false }).first().click();
    // Switching cohorts brings up a panel whose frozen disclosure is closed again — see above.
    await openAuditTrail(page);
    const panel = page
      .locator(`[data-testid="cohort-panel"][data-cohort="${longest!.cohort}"]`)
      .getByTestId("row-to-vector");
    await panel.getByRole("combobox").selectOption(longest!.variableName);
    const box = panel.getByTestId("embed-text");
    await expect(box).toHaveText(longest!.embedText);

    const metrics = await box.evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        lineClamp: cs.webkitLineClamp,
        overflowY: cs.overflowY,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
      };
    });
    expect(metrics.lineClamp, "the value is still clamped, so the tail is unreachable").toBe("none");
    expect(["auto", "scroll"]).toContain(metrics.overflowY);
    if (metrics.scrollHeight > metrics.clientHeight) {
      // Overflowing is fine — being unable to reach the overflow is not.
      const moved = await box.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
        return el.scrollTop > 0;
      });
      expect(moved, "the box overflows but will not scroll").toBe(true);
    }
  });

  test("@preflight the value states its own length, so a bounded box is not mistaken for the whole string", async ({
    page,
  }) => {
    // The box is capped and macOS hides its scrollbar until touched, so a truncated-looking value and a
    // short one are visually identical. The count is what separates them without a hover or a scroll.
    await gotoPreflight(page);
    const payload = await fixturePayload(page);
    const reports = reportsOf(payload);
    let longest: { cohort: string; variableName: string; embedText: string } | undefined;
    for (const r of reports) {
      for (const d of r.diff) {
        if (d.embedText && (!longest || d.embedText.length > longest.embedText.length)) {
          longest = { cohort: r.cohort, variableName: d.variableName, embedText: d.embedText };
        }
      }
    }
    expect(longest).toBeTruthy();
    await page.getByRole("tab", { name: longest!.cohort, exact: false }).first().click();
    // Switching cohorts brings up a panel whose frozen disclosure is closed again — see above.
    await openAuditTrail(page);
    const panel = page
      .locator(`[data-testid="cohort-panel"][data-cohort="${longest!.cohort}"]`)
      .getByTestId("row-to-vector");
    await panel.getByRole("combobox").selectOption(longest!.variableName);
    const len = panel.getByTestId("embed-text-length");
    await expect(len).toBeVisible();
    expect(await len.getAttribute("data-chars")).toBe(String(longest!.embedText.length));
  });

  test("@preflight the panel gives the width to the value, not to the picker", async ({ page }) => {
    /**
     * The other half of the same report: the card ran the full width of the page while its contents were
     * capped at a prose measure, so the string this screen exists to show sat in a narrow column with
     * empty space beside it. Prose keeps its measure; DATA gets the room.
     */
    await gotoPreflight(page);
    const panel = page.getByTestId("row-to-vector").first();
    const picker = panel.getByRole("combobox");
    const box = panel.getByTestId("embed-text");

    const pickerBox = await picker.boundingBox();
    const valueBox = await box.boundingBox();
    expect(pickerBox && valueBox).toBeTruthy();
    expect(valueBox!.width).toBeGreaterThan(pickerBox!.width * 1.5);
  });

  test("@preflight the nothing-to-embed count is rendered, out of variables", async ({ page }) => {
    // RE-POINTED, not weakened. The count used to sit at the foot of the row-to-vector panel; 08-14b Task
    // 3 made it the pre-flight's LEADING finding, because it is the one thing on this surface that only
    // running the rules could reveal. Same number, same denominator, read where a reader now meets it —
    // which is also outside the frozen disclosure, where it can be read without expanding anything.
    await gotoPreflight(page);
    const count = page.locator("[data-testid='preflight-finding'][data-finding='nothing-to-embed']").first();
    await expect(count).toBeVisible();
    const payload = await fixturePayload(page);
    expect(await count.getAttribute("data-count")).toBe(String(reportsOf(payload)[0].nNothingToEmbed));
    expect(await count.getAttribute("data-of")).toBe(String(reportsOf(payload)[0].nUniqueVariableNames));
    expect((await count.innerText()).toLowerCase()).toContain("variable");
  });

  test("@preflight both deferred capabilities render as neutral not-available tiles, with their contract copy", async ({ page }) => {
    await gotoPreflight(page);
    const tiles = page.getByTestId("not-available");
    // Settle on the two tiles THIS test is about, by their own copy. `evaluateAll` over an unsettled page
    // measures an empty list and pronounces the surface clean — blind rather than passing — and a total
    // count would break every time a tile is added anywhere else on the screen.
    await expect(tiles.filter({ hasText: /Which rule changed a variable/i })).toHaveCount(1);
    await expect(tiles.filter({ hasText: /value vector/i })).toHaveCount(1);
    // Neither may be quietly omitted: an absent panel reads as "nothing to say here".
    const texts = await tiles.evaluateAll((els) => els.map((e) => (e.textContent ?? "").replace(/\s+/g, " ")));
    expect(texts.some((t) => /Which rule changed a variable/i.test(t))).toBe(true);
    expect(texts.some((t) => /value vector/i.test(t))).toBe(true);

    // Deferred by design, not failed to build — so no destructive colour and no warning icon anywhere.
    for (const tile of await tiles.all()) {
      const bad = await tile.evaluate((el) => {
        const words = ["danger", "destructive", "warn", "error"];
        const hit: string[] = [];
        for (const node of [el, ...Array.from(el.querySelectorAll("*"))]) {
          const cls = node.getAttribute("class") ?? "";
          if (words.some((w) => cls.includes(w))) hit.push(cls);
          if (node.tagName.toLowerCase() === "svg" && node.getAttribute("aria-hidden") !== "true") {
            hit.push(`visible icon: ${node.getAttribute("class") ?? ""}`);
          }
        }
        return hit;
      });
      expect(bad, "a deferred tile must not look like a failure").toEqual([]);
    }
  });

  test("@preflight the rule grouping is labelled inferred, consistent with the provenance tile", async ({ page }) => {
    await gotoPreflight(page);
    const words = (await page.getByTestId("cohort-panel").innerText()).toLowerCase();
    expect(words).toContain("inferred");
  });

  // RETIRED, and this note is the record of it: `@gate0 Continue carries a non-zero amount and an INLINE
  // irreversible-spend statement` asserted a control this SURFACE no longer carries. The pre-flight is a
  // panel now; the control that commits the run's first charge belongs to the screen it sits on, and the
  // assertion was rebuilt there before this one was removed — `setup.spec.ts`:
  //
  //   @setup the commit control carries a non-zero amount and an INLINE irreversible-spend statement
  //   @setup `Nothing is charged yet` is true and visible ABOVE the commit control
  //   @setup the amount on the commit control equals the first charge in Setup's own bill
  //   @setup a PREVIEW run is quoted no amount and told it buys nothing
  //
  // Coverage went UP rather than down: the replacement also gates the two-surfaces-one-figure claim and
  // the preview branch, neither of which the original checked.

  test("@preflight nothing on this screen claims the flow is free until the reviewer chooses what to buy", async ({ page }) => {
    await gotoPreflight(page);
    const words = (await page.locator("main, body").first().innerText()).replace(/\s+/g, " ");
    // A blanket "free until you choose" claim is false anywhere in the staged flow: continuing from the
    // pre-flight is the run's first charge, and the reviewer scopes before the BULK of the spend, not
    // before all of it.
    expect(words).not.toMatch(/free until you (choose|decide|pick)/i);
    expect(words).not.toMatch(/step 1 is free/i);

    // `Nothing is charged yet` INVERTS with the move, and the inversion is the whole point of it. On the
    // retired screen that sentence would have been misleading — the reviewer was one press from the first
    // charge. On Setup it is simply TRUE until that press, and 08-DECISION-GATE0 D-3 requires it to stay
    // visible and true above the control. So it is asserted PRESENT here rather than absent.
    expect(words).toMatch(/nothing is charged yet/i);
    expect(words).toMatch(/first charge/i);
  });
});

test.describe("The pre-flight — the input-quality signals, rendered", () => {
  test("@preflight every rendered signal carries its own count AND its own denominator", async ({ page }) => {
    await gotoPreflight(page);
    const panel = page.getByTestId("input-quality");
    await expect(panel).toBeVisible();

    const rows = panel.getByTestId("quality-signal");
    await expect(rows.first()).toBeVisible();
    expect(await rows.count()).toBeGreaterThanOrEqual(3);

    for (const row of await rows.all()) {
      // A count, as data and as words.
      const count = await row.getAttribute("data-count");
      expect(count).toMatch(/^\d+$/);
      const words = (await row.innerText()).replace(/\s+/g, " ");
      // The denominator is named ON SCREEN, not implied by placement.
      expect(await row.getAttribute("data-denominator")).toBe("variables");
      expect(words).toContain("variables");
      // P2: this screen counts VARIABLES (dictionary rows). A count of metadata attributes is a
      // different kind of number and must never be presented as the same one.
      expect(words.toLowerCase()).not.toMatch(/\bfields?\b/);
      expect(words.toLowerCase()).not.toMatch(/\battributes?\b/);
    }
  });

  test("@preflight NO composite is rendered anywhere on the quality panel", async ({ page }) => {
    await gotoPreflight(page);
    const panel = page.getByTestId("input-quality");
    await expect(panel).toBeVisible();
    const words = (await panel.innerText()).replace(/\s+/g, " ");

    // A tier IS a composite, and a composite is the exact defect that got the published
    // Interoperability Score rejected: a single mean hides which of the signals is the problem.
    expect(words).not.toMatch(/\b(tier|grade|score|rating|out of 100|A\+|★)\b/i);
    // Nor a percentage dressed as a quality reading.
    expect(words).not.toMatch(/\d+\s*%/);
    // And no rollup vocabulary that would imply one. Narrowed to STATISTICAL usage on purpose: a bare
    // /\bmean\b/ convicts "variables that mean different things", and a gate that fires on correct prose
    // gets muted rather than fixed.
    expect(words).not.toMatch(/\b(composite|overall (score|reading|quality)|quality (score|index)|(the |an? )(average|mean) (of|across|reading|score))\b/i);
  });

  test("@preflight the placeholder strings themselves are rendered, not only their count", async ({ page }) => {
    const PLACEHOLDER = "Selected variable is part of a skip pattern";
    await withPayload(page, (p) => {
      const r = reportsOf(p)[0];
      r.rules = r.rules.map((x) =>
        x.rule === "placeholder_description_replacement"
          ? { ...x, outcome: "changed" as const, nChanged: 45, detail: `${PLACEHOLDER}; See the study codebook` }
          : x,
      );
    });
    await gotoPreflight(page);

    const row = page.locator('[data-testid="quality-signal"][data-signal="boilerplate-description"]').first();
    await expect(row).toBeVisible();
    // "45 placeholder descriptions" is an abstraction; the sentence itself is evidence.
    await expect(row).toContainText(PLACEHOLDER);
    await expect(row).toContainText("See the study codebook");
    expect(await row.getAttribute("data-count")).toBe("45");
  });

  test("@preflight the two unavailable signals are declared, with their reason, never approximated", async ({ page }) => {
    await gotoPreflight(page);
    const panel = page.getByTestId("input-quality");
    const gaps = panel.getByTestId("not-available");
    await expect(gaps).toHaveCount(2);

    const texts = await gaps.evaluateAll((els) => els.map((e) => (e.textContent ?? "").replace(/\s+/g, " ")));
    // The opaque-abbreviation share: computable inside the pipeline, reported by nothing.
    expect(texts.some((t) => /opaque code/i.test(t))).toBe(true);
    // Per-attribute population rates: on the dictionary, not on the preparation report.
    expect(texts.some((t) => /units, answer options or question wording/i.test(t))).toBe(true);
    // Each names WHY. "Not available" with no reason cannot be told from "zero".
    for (const t of texts) expect(t.length).toBeGreaterThan(80);
    // Declared as deferred, not as an error or a per-run opt-out.
    for (const gap of await gaps.all()) expect(await gap.getAttribute("data-claim")).toBe("deferred");
  });

  test("@preflight an all-clear dictionary reads as a positive finding, not as an empty region", async ({ page }) => {
    await withPayload(page, (p) => {
      const r = reportsOf(p)[0];
      r.rules = r.rules.map((x) => ({ ...x, outcome: "no_change" as const, nChanged: 0, detail: "" }));
      r.nNothingToEmbed = 0;
      r.nChangedVariables = 0;
      r.diff = [];
    });
    await gotoPreflight(page);

    const panel = page.getByTestId("input-quality");
    await expect(panel).toHaveAttribute("data-all-clear", "true");
    const words = (await panel.innerText()).replace(/\s+/g, " ");
    // Nothing-to-flag IS a result, and it is stated. An empty region says nothing was looked for.
    expect(words.length).toBeGreaterThan(60);
    expect(words).toMatch(/none of these|nothing.*flag|no .*(problem|weakness)/i);
    // The rows still render with their zeros — a hidden zero cannot be told from a check not made.
    expect(await panel.getByTestId("quality-signal").count()).toBeGreaterThanOrEqual(3);
  });

  test("@preflight each cohort carries its own signals, and no cross-cohort average is computed", async ({ page }) => {
    await gotoPreflight(page);
    // One panel per open tab, inside that tab's own cohort panel — never one panel for the run.
    await expect(page.getByTestId("input-quality")).toHaveCount(1);
    const panel = page.getByTestId("input-quality");
    const cohort = await page.getByTestId("cohort-panel").getAttribute("data-cohort");
    expect(await panel.getAttribute("data-cohort")).toBe(cohort);

    // Switching cohorts switches the signals with it.
    const tabs = page.getByRole("tab");
    const names = await tabs.evaluateAll((els) => els.map((e) => e.getAttribute("data-cohort")));
    await tabs.nth(1).click();
    await expect(panel).toHaveAttribute("data-cohort", names[1]!);

    // And nothing anywhere on the screen averages across cohorts.
    const all = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    expect(all).not.toMatch(/(average|mean) (quality|reading|score)|across (all )?cohorts[^.]*(quality|score)/i);
  });

  test("@preflight descriptionsChanged is not read by the signals panel at all", async () => {
    const { readFileSync } = await import("node:fs");
    const { dirname, resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(resolve(here, "../../src/components/gate/InputQualitySignals.tsx"), "utf8");
    // COMMENTS STRIPPED. The docstring records WHY this field is not a population signal — it counts how
    // many descriptions the RULES altered, which is cleaning effort, not how populated the source was —
    // and a naive substring gate convicts the sentence that documents the rule. Code is what must be clean.
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
    expect(src).not.toContain("descriptionsChanged");
    expect(src).not.toContain("descriptions_changed");
    // ...and the reasoning IS recorded somewhere, so this stays a documented refusal rather than an
    // accident that happens to hold.
    expect(raw).toContain("descriptionsChanged");
  });
});

// THE STOP CONTROL'S ASSERTIONS MOVED TO `gates.spec.ts` (08-14b Task 4).
//
// They were written here because this was the first screen on which a reviewer could see a run going
// wrong — but what they assert is the SHELL: one placement in `GateShell`, inherited by every screen,
// including the single-call-site claim, which is a statement about the shell and not about any page. A
// page spec was never their home; the demotion is just what made that obvious. They now sit beside the
// other chrome assertions, re-pointed at a gate route, and their wording no longer names a count of
// screens the flow does not have.

test.describe("The pre-flight — the card holds the whole pipeline without hiding a rule", () => {
  test("@preflight every rule row is inside the scroller's visible box, not below its fold", async ({ page }) => {
    await gotoPreflight(page);
    const scroller = page.getByTestId("rule-pipeline-scroll");
    await expect(scroller).toBeVisible();

    // The regression this catches: a scroll cap that hides the LAST rule. Every zero-count row was
    // visible and the eighth row was not, which is the same misinformation as hiding a zero — a rule
    // below the fold cannot be told from a rule not in the pipeline.
    const box = await scroller.evaluate((el) => ({
      client: el.clientHeight,
      scroll: el.scrollHeight,
      overflow: getComputedStyle(el).overflowY,
    }));
    expect(box.overflow).toBe("auto");
    expect(box.scroll, "the pipeline must fit — no rule below the fold").toBeLessThanOrEqual(box.client);

    // All eight rules of the fixed pipeline are rendered, each with a real box, and every one of them
    // inside the scroller's own content box. NOT `toBeInViewport`: the PAGE scrolls at 1440x900 and that
    // is fine — the defect is a row clipped away by the CARD, which is what this measures.
    const rows = page.getByTestId("rule-row");
    await expect(rows).toHaveCount(8);
    const clipped = await scroller.evaluate((el) => {
      const top = el.scrollTop;
      const bottom = top + el.clientHeight;
      return Array.from(el.querySelectorAll<HTMLElement>('[data-testid="rule-row"]'))
        .filter((r) => {
          const rTop = r.offsetTop - (el as HTMLElement).offsetTop;
          return r.offsetHeight === 0 || rTop < top || rTop + r.offsetHeight > bottom + 1;
        })
        .map((r) => r.getAttribute("data-rule"));
    });
    expect(clipped, "no rule may be clipped away by the card").toEqual([]);
  });

  test("@preflight the card still scrolls rather than growing the page when the pipeline is long", async ({ page }) => {
    await withPayload(page, (p) => {
      const r = reportsOf(p)[0];
      // A hypothetical longer pipeline. The backstop must engage rather than the page growing.
      r.rules = Array.from({ length: 40 }, (_, i) => ({
        ...r.rules[0],
        rule: `synthetic_rule_${i}`,
        label: `A synthetic preparation rule number ${i}`,
        outcome: "no_change" as const,
        nChanged: 0,
        detail: "",
        error: "",
      }));
      r.nChangedVariables = 0;
      r.diff = [];
    });
    await gotoPreflight(page);
    const box = await page.getByTestId("rule-pipeline-scroll").evaluate((el) => ({
      client: el.clientHeight,
      scroll: el.scrollHeight,
      overflow: getComputedStyle(el).overflowY,
    }));
    expect(box.overflow).toBe("auto");
    expect(box.scroll).toBeGreaterThan(box.client);
    // ...and no row is DROPPED to achieve it. Scrolled-past is not hidden; unrendered is.
    await expect(page.getByTestId("rule-row")).toHaveCount(40);
  });
});

// ── the review fixes of 2026-08-26 ────────────────────────────────────────────────────────────────
//
// Two findings from Bhargav's hands-on review, both about the worked examples:
//   1. the before/after text was cut mid-word — "…at recruitment, but in som"
//   2. for the rules whose whole effect is on the EMBEDDING text, the pair on screen was the
//      DESCRIPTION, which for name suppression is byte-identical on both sides
//
// (1) was NOT the CSS clamp it looked like: core's `preprocessing_diff` carried a hard `[:80]`, so the
// full string never reached the browser at all. (2) needed a new `rawEmbedText` on the wire, composed by
// core on the raw strings — deriving it in the UI is forbidden, because a plausible-looking wrong string
// on the one screen that explains grouping is worse than showing nothing.
test.describe("The pre-flight — the worked examples show the whole string, and the right pair", () => {
  test("@preflight a before/after example is never cut mid-word at 80 characters", async ({ page }) => {
    await gotoPreflight(page);
    await page.waitForLoadState("networkidle");
    const fired = page.locator('[data-testid="rule-row"][data-outcome="changed"]').first();
    await fired.click();

    // The old cap produced strings of EXACTLY 80 characters. Assert none of the rendered halves sits on
    // that boundary — a survivor of the cap would.
    const lens = await page.getByTestId("example-before").evaluateAll((els) =>
      els.map((e) => (e.textContent ?? "").trim().length),
    );
    expect(lens.length).toBeGreaterThan(0);
    expect(lens).not.toContain(80);

    // And no half is clamped by CSS either — the fix has to hold at both layers or the data is still
    // unreadable on screen.
    const clamped = await page.getByTestId("example-before").evaluateAll((els) =>
      els.filter((e) => getComputedStyle(e).webkitLineClamp !== "none").length,
    );
    expect(clamped).toBe(0);
  });

  test("@preflight an embedding-affecting rule shows the string the grouping stage reads, before and after", async ({
    page,
  }) => {
    await gotoPreflight(page);
    await page.waitForLoadState("networkidle");

    // Expand every fired rule so whichever one carries the embedding-affecting rows is open.
    const fired = page.locator('[data-testid="rule-row"][data-outcome="changed"]');
    for (let i = 0; i < (await fired.count()); i++) await fired.nth(i).click();

    const pairs = page.getByTestId("example-embed-pair");
    expect(await pairs.count()).toBeGreaterThan(0);

    const first = pairs.first();
    await expect(first).toContainText(/grouping stage reads/i);
    await expect(first.getByTestId("example-embed-before")).toBeVisible();
    await expect(first.getByTestId("example-embed-after")).toBeVisible();

    // THE HONEST-EQUALITY CASE. Where the two are equal the panel must SAY so and say why, rather than
    // showing two identical strings under "Before"/"After" and leaving the reviewer to wonder. This is
    // the true behaviour of name suppression on a variable that has a description: the name was never in
    // the embedding text, so dropping it changes nothing.
    const unchanged = page.locator('[data-testid="example-embed-pair"][data-embed-changed="false"]');
    if ((await unchanged.count()) > 0) {
      await expect(unchanged.first()).toContainText(/unchanged/i);
      await expect(unchanged.first()).toContainText(/never in this string|read on its own/i);
    }
    // And at least one row in this fixture DOES change, or the pair would be pointless to render.
    await expect(
      page.locator('[data-testid="example-embed-pair"][data-embed-changed="true"]').first(),
    ).toBeVisible();
  });
});



// ── the review fixes of 2026-08-27 ────────────────────────────────────────────────────────────────
//
// Three more findings from Bhargav's hands-on review of the same panels:
//   1. the before/after difference is often "very subtle" — two paragraphs of prose with a few
//      characters between them, and no way to find the change the screen claims to be reporting
//   2. the row-to-vector value was cut off with no scroll, in a card with unused width beside it
//   3. there was no way to get this for the WHOLE dictionary, against the reviewer's own file
test.describe("The pre-flight — the change is marked, not merely reported", () => {
  test("@preflight an expanded rule marks the words that moved, on both sides of the pair", async ({ page }) => {
    await gotoPreflight(page);
    await page.waitForLoadState("networkidle");
    await page.locator('[data-testid="rule-row"][data-outcome="changed"]').first().click();

    // At least one example carries marking. Not "every" — a rule can fire on a row whose visible pair is
    // unchanged (name suppression is exactly that), and marking such a row would be inventing an edit.
    const marks = page.locator('[data-diff="removed"], [data-diff="added"]');
    expect(await marks.count()).toBeGreaterThan(0);
  });

  test("@preflight marking does not alter the string — the rendered text is still the whole value", async ({ page }) => {
    /**
     * The failure this prevents is the one the 2026-08-26 review already fixed once, reintroduced by a
     * different mechanism: a diff that reflows, trims or drops a character would put a string on screen
     * that neither the file nor the model contains, while looking more authoritative than before.
     */
    await gotoPreflight(page);
    await page.waitForLoadState("networkidle");
    const payload = await fixturePayload(page);
    const known = new Set<string>();
    for (const r of reportsOf(payload)) {
      for (const d of r.diff) {
        if (d.rawDescription) known.add(d.rawDescription);
        if (d.cleanedDescription) known.add(d.cleanedDescription);
        if (d.rawEmbedText) known.add(d.rawEmbedText);
        if (d.embedText) known.add(d.embedText);
        if (d.rawVariableName) known.add(d.rawVariableName);
        if (d.variableName) known.add(d.variableName);
      }
    }
    await page.locator('[data-testid="rule-row"][data-outcome="changed"]').first().click();

    const rendered = await page
      .locator('[data-testid="example-before"], [data-testid="example-after"]')
      .evaluateAll((els) => els.map((e) => e.textContent ?? ""));
    expect(rendered.length).toBeGreaterThan(0);
    for (const text of rendered) {
      // "(empty)" / "(cleared)" are the declared placeholders for a genuinely absent side.
      if (text === "(empty)" || text === "(cleared)" || text === "(nothing)") continue;
      expect(known.has(text), `rendered a string the payload does not contain: ${JSON.stringify(text)}`).toBe(true);
    }
  });

  test("@preflight the marking is not carried by colour alone", async ({ page }) => {
    /**
     * There is deliberately NO legend (review 2026-08-27): struck-through under a Before heading and
     * underlined under an After heading is self-explanatory, and a key repeated under every fired rule is
     * noise. That puts the whole burden on the marks themselves being distinguishable without colour —
     * which is what this asserts. A <span> pair differing only in background would not survive it.
     */
    await gotoPreflight(page);
    await page.waitForLoadState("networkidle");
    await page.locator('[data-testid="rule-row"][data-outcome="changed"]').first().click();

    await expect(page.getByTestId("diff-legend")).toHaveCount(0);
    const marks = page.locator('[data-diff="removed"], [data-diff="added"]');
    expect(await marks.count()).toBeGreaterThan(0);
    const tags = await marks.evaluateAll((els) => els.map((e) => e.tagName));
    expect(tags.every((t) => t === "DEL" || t === "INS")).toBe(true);
  });

  test("@preflight the whole prepared dictionary is offered, with what it contains stated", async ({ page }) => {
    /**
     * The picker above it can only offer the variables preparation CHANGED — that is all the run carries
     * per-variable detail for. The export is how the reviewer reaches the rest, and their own file.
     *
     * The static preview has no backend to re-read an upload from, so what is asserted here is that the
     * control DECLARES its state rather than rendering a link that downloads a 404 named `.csv`.
     */
    await gotoPreflight(page);
    await page.waitForLoadState("networkidle");
    const section = page.getByTestId("prepared-export").first();
    await expect(section).toBeVisible();

    const link = section.getByTestId("prepared-export-link");
    const unavailable = section.getByTestId("prepared-export-unavailable");
    const wired = (await link.count()) > 0;
    if (wired) {
      await expect(link).toHaveAttribute("href", /prepared\.csv\?cohort=/);
      await expect(link).toHaveAttribute("download", "");
      // The three appended columns are NAMED, so the reviewer knows what they are getting before the
      // download rather than after opening it.
      await expect(section).toContainText("ddharmon_embedding_text");
    } else {
      await expect(unavailable).toBeVisible();
      await expect(section).toContainText(/no server|unavailable/i);
    }
  });
});


/**
 * The PRE-FLIGHT read (08-14b Task 3) — what only RUNNING the rules could reveal.
 *
 * NARROWER THAN THE DECISION FIRST ASKED FOR, on purpose. `08-DECISION-GATE0.md` D-4 made repeated
 * variable names the headline. The standing inherited-UI review (pre-build question Q3) then found that
 * finding already SHIPPED, pre-Start, on this same screen — `nameCheck` in `lib/dictionary.ts`, rendered
 * by `DictionaryMappingTable` — where it recomputes as the mapping changes and is fixable IN PLACE with
 * no restart. Restating it here would say the same thing later and less actionably, so D-4 now carries a
 * CORRECTED block and this derivation deliberately does not compute it.
 *
 * The load-bearing distinction under test: a finding the report can supply, versus one it CANNOT and must
 * declare. `diff` is a capped sample of variables something CHANGED, so when no rule fires it is EMPTY —
 * "nothing fired and the noise is still there" is not derivable from the report at any cap, and
 * approximating it from an empty sample would be inventing a measurement.
 */
test.describe("The pre-flight — the pre-flight read, as functions", () => {
  test("@preflight the nothing-to-embed finding carries its count AND a variables denominator", () => {
    const read = preflightRead(report({ nNothingToEmbed: 7, nUniqueVariableNames: 240 }), null);
    const finding = read.findings.find((f) => f.id === "nothing-to-embed");
    expect(finding, "the finding the report can always supply must be present").toBeDefined();
    expect(finding!.count).toBe(7);
    expect(finding!.of).toBe(240);
    // VARIABLES, in words, beside the number. A count of metadata attributes is a different kind of
    // number and must never be presented as the same one.
    expect(finding!.denominator).toBe("variables");
    // No grade, letter, star or composite anywhere in the read.
    expect(JSON.stringify(read)).not.toMatch(/\btier\b|\bgrade\b|\bscore\b|\b[A-F][+-]?\s*grade\b|★/i);
  });

  test("@preflight the pre-flight NEVER restates the repeated-variable-name finding", () => {
    // Q3's verdict, gated rather than trusted: that finding belongs to Setup's pre-Start mapping table.
    // The numbers it would need are RIGHT THERE on the report, which is exactly why this needs a test.
    const read = preflightRead(
      report({ nVariables: 6018, nUniqueVariableNames: 5518, nDuplicateVariableNames: 500 }),
      null,
    );
    const words = JSON.stringify(read);
    expect(words).not.toMatch(/unique (variable )?names?/i);
    expect(words).not.toMatch(/dropped silently|silently/i);
    expect(words).not.toMatch(/repeated/i);
    // And no finding quotes the collision count as its number.
    for (const f of read.findings) expect(f.count).not.toBe(500);
  });

  test("@preflight what the rules DID is stated per cohort, never as a cross-cohort mean", () => {
    const read = preflightRead(
      report({ cohort: "CLSA", nUniqueVariableNames: 5518, nChangedVariables: 97 }),
      null,
    );
    expect(read.summary.count).toBe(97);
    expect(read.summary.of).toBe(5518);
    expect(read.summary.denominator).toBe("variables");
    // A mean over cohorts hides which cohort is the problem — the same defect that got the composite
    // score rejected in 08-14. The derivation takes ONE report and cannot average anything.
    expect(preflightRead.length).toBe(2);
  });

  test("@preflight the class the report provably cannot supply is DECLARED, never synthesised from the diff", () => {
    // No rule fired, so `diff` is empty by construction — there is nothing to scan for residual noise.
    const quiet = report({
      rules: [rule({ outcome: "no_change", nChanged: 0 })],
      nChangedVariables: 0,
      diff: [],
    });
    const gap = preflightRead(quiet, null).gaps.find((g) => g.id === "unfired-noise");
    expect(gap, "an unavailable class must render as a declared gap, not be omitted").toBeDefined();
    expect(gap!.reason).toMatch(/changed/i);
    // …and it points at the answer rather than leaving a dead end.
    expect(gap!.pointer).toMatch(/export|download|prepared/i);
    // It is a GAP even when rules DID fire: the diff is a capped sample either way.
    expect(preflightRead(report(), null).gaps.map((g) => g.id)).toContain("unfired-noise");
  });

  test("@preflight the question-wording class is derived from the run's OWN mapping, or declared", () => {
    // AVAILABLE: the run recorded its column roles, so whether a participant-wording column was mapped
    // is a FACT about this run — not an estimate, and not a figure remembered from another cohort.
    const mapped = preflightRead(report(), { variable_name: "var", description: "desc", question_text: "q" });
    expect(mapped.findings.find((f) => f.id === "question-wording")).toBeUndefined();
    expect(mapped.gaps.find((g) => g.id === "question-wording")).toBeUndefined();

    const unmapped = preflightRead(report(), { variable_name: "var", description: "desc" });
    const finding = unmapped.findings.find((f) => f.id === "question-wording");
    expect(finding, "an unmapped wording column is a real finding about this run").toBeDefined();
    // Acting on it means a FRESH run: a run's column mapping is fixed at startHarmonize.
    expect(finding!.needsRestart).toBe(true);
    expect(finding!.detail).toMatch(/new run|fresh run|start.*again|another run/i);

    // UNAVAILABLE: the run kept no column roles (the demo path records dataset ids instead), so the
    // question cannot be answered from the run at all. Declared, with a pointer — never guessed.
    const gap = preflightRead(report(), null).gaps.find((g) => g.id === "question-wording");
    expect(gap, "with no recorded mapping this must be declared, not assumed clean").toBeDefined();
    expect(gap!.pointer).toMatch(/export|download|prepared/i);
  });

  test("@preflight the derivation contains no percentage literal and no remembered cohort figure", async () => {
    const { readFileSync } = await import("node:fs");
    const { dirname, resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const src = readFileSync(resolve(root, "src/lib/preprocess-report.ts"), "utf8");
    const body = src.slice(src.indexOf("--- the pre-flight read"));
    // A figure measured on one cohort is not a measurement of the dictionary on screen. There is no
    // honest reason for a literal percentage to appear in a derivation over the report in hand.
    expect(body.match(/\d+(?:\.\d+)?\s*%/g) ?? []).toEqual([]);
    expect(body).not.toMatch(/\b(UKBB|CLSA|Arivale|AoU|MESA|AI-READI|TwinsUK)\b/);
    // It measures the INPUT, never our own cleaning.
    expect(body).not.toMatch(/descriptionsChanged/);
  });

  test("@preflight a report with nothing to flag is a POSITIVE finding, not an empty region", () => {
    const clean = preflightRead(
      report({ nNothingToEmbed: 0 }),
      { variable_name: "var", description: "desc", question_text: "q" },
    );
    expect(clean.findings.filter((f) => f.concern)).toHaveLength(0);
    expect(clean.nothingToFlag).toBe(true);
    // …and it still says what the rules did, so the region is never blank.
    expect(clean.summary.label.length).toBeGreaterThan(0);
  });
});
