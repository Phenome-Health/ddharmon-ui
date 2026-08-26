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

test.describe("Gate 0 — per-cohort tabs, the row-to-vector panel, and the two honest gaps", () => {
  test("@gate0 each cohort gets its own tab, and switching tabs switches the report", async ({ page }) => {
    await page.goto(GATE0);
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
    // Each tab carries its OWN reconciliation, against its own dictionary.
    await expect(panel.getByTestId("rule-reconciliation")).toBeVisible();
  });

  test("@gate0 a cohort still running shows progress, never a completed report", async ({ page }) => {
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
    await page.goto(GATE0);

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

  test("@gate0 the aggregate says so plainly when every cohort IS finished", async ({ page }) => {
    await page.goto(GATE0);
    const aggregate = page.getByTestId("prepare-aggregate");
    expect(await aggregate.getAttribute("data-complete")).toBe("true");
  });

  test("@gate0 the row-to-vector panel shows the exact grouping input, not the cleaned description", async ({ page }) => {
    await page.goto(GATE0);
    const panel = page.getByTestId("row-to-vector");
    await expect(panel).toBeVisible();

    // Read the payload the screen is rendering, and assert the panel shows THAT string.
    const payload = await fixturePayload(page);
    const report = reportsOf(payload)[0];
    const row = report.diff.find((d) => d.embedText && d.embedText !== d.cleanedDescription);
    expect(row, "the fixture must carry a variable whose embedding text differs from its description").toBeTruthy();

    await panel.getByRole("combobox").selectOption(row!.variableName);
    const shown = panel.getByTestId("embed-text");
    await expect(shown).toHaveText(row!.embedText);
    // The near-miss is the whole point: the cleaned description is a DIFFERENT string, and showing it
    // here would answer "why did these group?" wrongly while looking right.
    await expect(shown).not.toHaveText(row!.cleanedDescription);
  });

  test("@gate0 the nothing-to-embed count is rendered, out of variables", async ({ page }) => {
    await page.goto(GATE0);
    const count = page.getByTestId("nothing-to-embed");
    await expect(count).toBeVisible();
    const payload = await fixturePayload(page);
    expect(await count.getAttribute("data-count")).toBe(String(reportsOf(payload)[0].nNothingToEmbed));
    expect((await count.innerText()).toLowerCase()).toContain("variable");
  });

  test("@gate0 both deferred capabilities render as neutral not-available tiles, with their contract copy", async ({ page }) => {
    await page.goto(GATE0);
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

  test("@gate0 the rule grouping is labelled inferred, consistent with the provenance tile", async ({ page }) => {
    await page.goto(GATE0);
    const words = (await page.getByTestId("cohort-panel").innerText()).toLowerCase();
    expect(words).toContain("inferred");
  });

  test("@gate0 Continue carries a non-zero amount and an INLINE irreversible-spend statement", async ({ page }) => {
    await page.goto(GATE0);
    const bar = page.getByTestId("commit-bar");
    await expect(bar).toBeVisible();

    const amount = Number(await bar.getAttribute("data-total"));
    expect(amount).toBeGreaterThan(0);
    const words = (await bar.innerText()).replace(/\s+/g, " ");
    // The amount is on the control the reviewer presses, not only in an attribute.
    expect(words).toMatch(/\$\d/);
    // The irreversible-spend statement is inline, in the bar being read.
    expect(words.toLowerCase()).toContain("not refundable");
    expect(words.toLowerCase()).toContain("spending begins");

    // No modal stands between the reviewer and the first charge: a modal on the primary path is met at
    // every gate, always says yes, and by the third gate is dismissed unread.
    expect(await page.locator('[role="dialog"], [role="alertdialog"]').count()).toBe(0);
  });

  test("@gate0 nothing on this screen claims the flow is free until the reviewer chooses what to buy", async ({ page }) => {
    await page.goto(GATE0);
    const words = (await page.locator("main, body").first().innerText()).replace(/\s+/g, " ");
    // Gate 0's own review work is free; CONTINUING from it is the run's first charge, so any blanket
    // "free until you choose" claim is false here.
    expect(words).not.toMatch(/free until you (choose|decide|pick)/i);
    expect(words).not.toMatch(/nothing is charged yet/i);
    expect(words).not.toMatch(/step 1 is free/i);
  });
});

test.describe("Gate 0 — the input-quality signals, rendered", () => {
  test("@gate0 every rendered signal carries its own count AND its own denominator", async ({ page }) => {
    await page.goto(GATE0);
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

  test("@gate0 NO composite is rendered anywhere on the quality panel", async ({ page }) => {
    await page.goto(GATE0);
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

  test("@gate0 the placeholder strings themselves are rendered, not only their count", async ({ page }) => {
    const PLACEHOLDER = "Selected variable is part of a skip pattern";
    await withPayload(page, (p) => {
      const r = reportsOf(p)[0];
      r.rules = r.rules.map((x) =>
        x.rule === "placeholder_description_replacement"
          ? { ...x, outcome: "changed" as const, nChanged: 45, detail: `${PLACEHOLDER}; See the study codebook` }
          : x,
      );
    });
    await page.goto(GATE0);

    const row = page.locator('[data-testid="quality-signal"][data-signal="boilerplate-description"]').first();
    await expect(row).toBeVisible();
    // "45 placeholder descriptions" is an abstraction; the sentence itself is evidence.
    await expect(row).toContainText(PLACEHOLDER);
    await expect(row).toContainText("See the study codebook");
    expect(await row.getAttribute("data-count")).toBe("45");
  });

  test("@gate0 the two unavailable signals are declared, with their reason, never approximated", async ({ page }) => {
    await page.goto(GATE0);
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

  test("@gate0 an all-clear dictionary reads as a positive finding, not as an empty region", async ({ page }) => {
    await withPayload(page, (p) => {
      const r = reportsOf(p)[0];
      r.rules = r.rules.map((x) => ({ ...x, outcome: "no_change" as const, nChanged: 0, detail: "" }));
      r.nNothingToEmbed = 0;
      r.nChangedVariables = 0;
      r.diff = [];
    });
    await page.goto(GATE0);

    const panel = page.getByTestId("input-quality");
    await expect(panel).toHaveAttribute("data-all-clear", "true");
    const words = (await panel.innerText()).replace(/\s+/g, " ");
    // Nothing-to-flag IS a result, and it is stated. An empty region says nothing was looked for.
    expect(words.length).toBeGreaterThan(60);
    expect(words).toMatch(/none of these|nothing.*flag|no .*(problem|weakness)/i);
    // The rows still render with their zeros — a hidden zero cannot be told from a check not made.
    expect(await panel.getByTestId("quality-signal").count()).toBeGreaterThanOrEqual(3);
  });

  test("@gate0 each cohort carries its own signals, and no cross-cohort average is computed", async ({ page }) => {
    await page.goto(GATE0);
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

  test("@gate0 descriptionsChanged is not read by the signals panel at all", async () => {
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

test.describe("Gate 0 — stopping an in-flight run from the gate chrome", () => {
  /** Put the fixture into a genuinely in-flight state: a worker is running and money is accruing. */
  async function inFlight(page: Page, over: Record<string, unknown> = {}) {
    await withPayload(page, (p) => {
      Object.assign(p, { status: "splitting", phase: "splitting", stopping: false }, over);
      // A priced run, so the confirmation can state the committed-versus-avoided split.
      const config = p.config as Record<string, unknown>;
      config.est_fields = 1000;
      config.est_cohorts = 5;
      config.run_mode = "batch";
      delete config.demo;
    });
  }

  test("@gate0 an in-flight run can be stopped from the gate chrome, with BOTH modes reachable", async ({ page }) => {
    await inFlight(page);
    await page.goto(GATE0);

    const stop = page.getByRole("button", { name: /stop/i }).first();
    await expect(stop).toBeVisible();
    await stop.click();

    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    // Both ways out, behind ONE confirmation — keeping the production wording.
    await expect(dialog.getByRole("button", { name: /stop & keep results/i })).toBeVisible();
    await expect(dialog.getByRole("button", { name: /discard now/i })).toBeVisible();
    // ...and a way to not stop at all.
    await expect(dialog.getByRole("button", { name: /keep running/i })).toBeVisible();
  });

  test("@gate0 the confirmation names the committed-versus-avoided cost split when the run is priced", async ({ page }) => {
    await inFlight(page);
    await page.goto(GATE0);
    await page.getByRole("button", { name: /stop/i }).first().click();

    const words = (await page.getByRole("alertdialog").innerText()).replace(/\s+/g, " ");
    // Stopping is a decision made against money, not in the dark.
    expect(words).toMatch(/already committed/i);
    expect(words).toMatch(/avoids/i);
    expect(words).toMatch(/\$\d/);
  });

  test("@gate0 no stop action renders for a finished, cancelled or PAUSED run, and that is not an error", async ({ page }) => {
    // A run parked at a gate is non-terminal but has NO worker — a pause is an exit, so nothing is
    // spending and a stop control there would claim to save money that is not being spent.
    for (const status of ["complete", "cancelled", "awaiting_review"]) {
      await page.unrouteAll();
      await withPayload(page, (p) => {
        Object.assign(p, { status, phase: status });
        delete (p.config as Record<string, unknown>).demo;
      });
      await page.goto(GATE0);
      await expect(page.getByTestId("cohort-panel")).toBeVisible();
      expect(await page.getByRole("button", { name: /^stop/i }).count(), `status ${status}`).toBe(0);
      // Absence, not a disabled control and not an error notice.
      expect(await page.getByTestId("stop-unavailable").count(), `status ${status}`).toBe(0);
    }
  });

  test("@gate0 the demo path degrades to an honest not-available, never a dead control", async ({ page }) => {
    await inFlight(page, {});
    // ...and then mark it the shared demo, whose replay has no backend to cancel.
    await page.unrouteAll();
    await withPayload(page, (p) => {
      Object.assign(p, { status: "splitting", phase: "splitting" });
      (p.config as Record<string, unknown>).demo = true;
    });
    await page.goto(GATE0);

    const tile = page.getByTestId("stop-unavailable");
    await expect(tile).toBeVisible();
    const words = (await tile.innerText()).replace(/\s+/g, " ");
    expect(words.length).toBeGreaterThan(30);
    // A control that looks live and does nothing is worse than a stated absence.
    expect(await page.getByRole("button", { name: /^stop/i }).count()).toBe(0);
  });

  test("@gate0 stopping leaves the reviewer on the gate they were on", async ({ page }) => {
    await inFlight(page);
    await page.goto(GATE0);
    await page.getByRole("button", { name: /stop/i }).first().click();
    await page.getByRole("button", { name: /stop & keep results/i }).click();

    // The run's state reflects the stop; the reviewer is not navigated away.
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe(GATE0);
    await expect(page.getByTestId("cohort-panel")).toBeVisible();
  });

  test("@gate0 the stop action is wired ONCE, in the shell, so all six gates inherit it", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const { dirname, resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = dirname(fileURLToPath(import.meta.url));

    const dirs = [resolve(here, "../../src/components/gate"), resolve(here, "../../src/pages/run")];
    const hits: string[] = [];
    for (const dir of dirs) {
      for (const f of readdirSync(dir).filter((x) => x.endsWith(".tsx"))) {
        const src = readFileSync(resolve(dir, f), "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, " ")
          .replace(/^\s*\/\/.*$/gm, " ");
        // Count JSX usages, not the import line — an import is not a placement.
        for (const _ of src.matchAll(/<StopRunAction\b/g)) hits.push(f);
      }
    }
    // ONE placement across the whole staged-review surface. The next five gates inherit it rather than
    // each re-adding it, which is how two implementations of the same control end up in the tree.
    expect(hits).toEqual(["GateShell.tsx"]);
  });

  test("@gate0 stop-run-action.tsx was CONSUMED, not rewritten", async () => {
    const { execSync } = await import("node:child_process");
    // It is already in production use on the dashboard and the runs list. A second implementation of a
    // control that spends or saves real money is the thing this lift exists to avoid.
    execSync("git diff --exit-code -- src/components/stop-run-action.tsx", {
      cwd: (await import("node:path")).resolve(
        (await import("node:path")).dirname((await import("node:url")).fileURLToPath(import.meta.url)),
        "../..",
      ),
    });
  });
});

test.describe("Gate 0 — the card holds the whole pipeline without hiding a rule", () => {
  test("@gate0 every rule row is inside the scroller's visible box, not below its fold", async ({ page }) => {
    await page.goto(GATE0);
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

  test("@gate0 the card still scrolls rather than growing the page when the pipeline is long", async ({ page }) => {
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
    await page.goto(GATE0);
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
