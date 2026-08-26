import { expect, test, type Page } from "@playwright/test";
import {
  RULE_FACETS,
  examplesFor,
  noRuleFired,
  outcomeLabel,
  placeholderStrings,
  qualitySignals,
  reconcile,
} from "@/lib/preprocess-report";
import type { PreprocessDiff, PreprocessReport, PreprocessRule } from "@/types";
import { PAUSED_RUN_FIXTURE } from "./routes";

/**
 * Gate 0 — Load & prepare (08-14).
 *
 *   run: npm run test:e2e -- --grep "@gate0"
 *
 * WHAT THIS SCREEN IS ASKED TO BE HONEST ABOUT, which is what the assertions are weighted towards:
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

const GATE0 = `/run/${PAUSED_RUN_FIXTURE}/gate0`;

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

test.describe("Gate 0 — the report's own arithmetic and provenance, as functions", () => {
  test("@gate0 a zero-change rule and a one-change rule produce DIFFERENT words, and neither is silence", () => {
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

  test("@gate0 did-not-run and failed are each distinct from changed-nothing — three claims, three labels", () => {
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

  test("@gate0 examples are narrowed by the facet a rule can touch, never attributed to it", () => {
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

  test("@gate0 every rule the backend reports has a declared facet, so no rule silently loses its examples", () => {
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

  test("@gate0 the reconciliation closes against the VARIABLE count, and names the silent drop separately", () => {
    const r = reconcile(report({ nVariables: 120, nUniqueVariableNames: 100, nDuplicateVariableNames: 20, nChangedVariables: 30 }));
    expect(r.variables).toBe(100);
    expect(r.changed + r.untouched).toBe(r.variables);
    // Rows and variables are TWO numbers, because rows minus variables is a silent last-wins drop and
    // folding it into one total is how that loss stays invisible.
    expect(r.rows).toBe(120);
    expect(r.droppedSilently).toBe(20);
    expect(r.ok).toBe(true);
  });

  test("@gate0 a rule claiming more changes than there are variables fails the reconciliation", () => {
    const r = reconcile(report({ nUniqueVariableNames: 10, rules: [rule({ nChanged: 11 })], nChangedVariables: 4 }));
    expect(r.ok).toBe(false);
  });

  test("@gate0 no-rule-fired is a state of the whole report, and a failed report is not it", () => {
    expect(noRuleFired(report({ rules: [rule({ outcome: "no_change", nChanged: 0 })], nChangedVariables: 0 }))).toBe(true);
    expect(noRuleFired(report({ rules: [rule({ outcome: "changed", nChanged: 1 })] }))).toBe(false);
    // A failure is not "nothing changed" — the outcome is unknown.
    expect(noRuleFired(report({ failed: true, rules: [rule({ outcome: "failed", nChanged: 0 })] }))).toBe(false);
    // Neither is a report that never ran.
    expect(noRuleFired(report({ ran: false, rules: [rule({ outcome: "not_run", nChanged: 0 })] }))).toBe(false);
  });
});

test.describe("Gate 0 — the input-quality signals, as functions", () => {
  test("@gate0 every signal carries a count AND a variables denominator, and none is a composite", () => {
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

  test("@gate0 the boilerplate signal carries the actual placeholder strings, not only their count", () => {
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

  test("@gate0 descriptionsChanged is never a quality signal — it measures OUR cleaning, not the input", () => {
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

  test("@gate0 a signal reads 0 when its rule did not RUN, and the rule list is where that is disclosed", () => {
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

test.describe("Gate 0 — the rule pipeline, rendered", () => {
  test("@gate0 every rule that ran is listed, including the ones that changed nothing", async ({ page }) => {
    await page.goto(GATE0);
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

  test("@gate0 a zero-change row and a one-or-more-change row render distinct text, both visible", async ({ page }) => {
    await withPayload(page, (p) => {
      const r = reportsOf(p)[0];
      r.rules = [
        { ...r.rules[0], rule: "option_echo_clearing", label: "Cleared echoed descriptions", outcome: "no_change", nChanged: 0, detail: "", error: "" },
        { ...r.rules[0], rule: "administrative_text_stripping", label: "Stripped administration wrappers", outcome: "changed", nChanged: 1, detail: "", error: "" },
      ];
      r.nChangedVariables = 1;
    });
    await page.goto(GATE0);

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

  test("@gate0 a rule that threw renders a THIRD state, distinct from changed-nothing and from not-run", async ({ page }) => {
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
    await page.goto(GATE0);

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

  test("@gate0 a rule that fired shows at least one worked before/after example", async ({ page }) => {
    await page.goto(GATE0);
    const fired = page.locator('[data-testid="rule-row"][data-outcome="changed"]').first();
    await fired.getByRole("button").first().click();
    const example = fired.getByTestId("rule-example").first();
    await expect(example).toBeVisible();
    // Both halves, labelled — an "after" with no "before" is not a worked example.
    await expect(example.getByTestId("example-before")).toBeVisible();
    await expect(example.getByTestId("example-after")).toBeVisible();
  });

  test("@gate0 the reconciled total is stated on screen and equals the dictionary's variable count", async ({ page }) => {
    await page.goto(GATE0);
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

  test("@gate0 mojibake in an example is displayed as text and never executed", async ({ page }) => {
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
    await page.goto(GATE0);

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

  test("@gate0 a long example is clamped, the full value is reachable, and the list does not reflow", async ({ page }) => {
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
    await page.goto(GATE0);

    const fired = page.locator('[data-testid="rule-row"][data-outcome="changed"]').first();
    await fired.getByRole("button").first().click();
    const before = fired.getByTestId("example-before").first();
    await expect(before).toBeVisible();

    // Clamped: the rendered box is far shorter than the text would be unclamped.
    const clamped = await before.evaluate((el) => ({
      shown: el.clientHeight,
      full: el.scrollHeight,
      clamp: getComputedStyle(el).webkitLineClamp,
    }));
    expect(clamped.clamp).not.toBe("none");
    expect(clamped.full).toBeGreaterThan(clamped.shown);
    // The full value is available rather than lost.
    await expect(before).toHaveAttribute("title", LONG);

    // The card scrolls; the page does not grow past the design canvas because of it.
    const scroller = page.getByTestId("rule-pipeline-scroll");
    const fits = await scroller.evaluate((el) => el.scrollHeight <= el.clientHeight + 1 || getComputedStyle(el).overflowY === "auto");
    expect(fits).toBe(true);
  });

  test("@gate0 a dictionary where no rule fired renders the no-changes copy, and it says how that differs from not-run", async ({ page }) => {
    await withPayload(page, (p) => {
      const r = reportsOf(p)[0];
      r.rules = r.rules.map((x) => ({ ...x, outcome: "no_change" as const, nChanged: 0, detail: "", error: "" }));
      r.diff = [];
      r.nChangedVariables = 0;
      r.diffTruncated = false;
    });
    await page.goto(GATE0);

    const empty = page.getByTestId("gate-empty-state").first();
    await expect(empty).toBeVisible();
    const words = (await empty.innerText()).replace(/\s+/g, " ");
    expect(words).toContain("No changes");
    // The contrast is the point: silence here would be read as "the rules did not run".
    expect(words.toLowerCase()).toContain("not running");
    // The rule list still renders beneath it, each row with its count of zero.
    await expect(page.locator('[data-testid="rule-row"][data-outcome="no_change"]').first()).toBeVisible();
  });

  test("@gate0 there is no raw-HTML injection anywhere on this surface", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const { dirname, resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = dirname(fileURLToPath(import.meta.url));

    // GLOBBED rather than listed. An uploaded dictionary's text is echoed onto this screen, so the whole
    // surface has to be covered — and a hardcoded list is dodged for free by adding a file to it, which is
    // the failure mode a security gate cannot afford. The page, everything it composes from and the module
    // that derives what it shows.
    const gateDir = resolve(here, "../../src/components/gate");
    const files = [
      resolve(here, "../../src/pages/run/gate0.tsx"),
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
