import { expect, test, type Page } from "@playwright/test";
import { decisionItemKey, optionSetKey, type GateDecision } from "@/lib/gate-decisions";
import { SANDBOX_PREFIX } from "@/lib/sandbox";
import {
  GROUP_SELECT_THRESHOLD,
  SUGGESTION_TAG_COPY,
  scoreScopeInput,
  scoreSeededGroups,
  scoreTaggedGroups,
  suggestionMatches,
} from "@/lib/score-scope";
import type { CompositeSpec, JobResult, ScoreSuggestions } from "@/types";
import { PAUSED_JOB, asOwnedRun, fixtureGroups, serveRun } from "./gate1-fixture";

/**
 * Gate 1's score SUGGESTIONS — the free half of the score match, seeding Gate 1's scope (08-28 Decision 6, option A).
 *
 * The paid match moved to Gate 4 (decision Q5), after Gate 1 is continued, so a live Gate 1 had no matches and the
 * score-seeded scope (`score-auto-select.spec.ts`) never seeded anything. Gate 1 now asks the server for the
 * retrieval-only half (`GET /jobs/{id}/score/suggestions`, $0, no judge): each reached group with the dense cosine of
 * its best member and core's calibrated cut-off. Groups that clear THAT cut-off start in scope and are tagged as
 * suggestions; the verdict stays on Gate 4.
 *
 * The rule is ONE rule: Gate 4 matches when the run has them, else the suggestions, both through
 * `scoreSeededGroups`. Proved in node (the input switch) and on the static fixture (the screen applies it, an
 * explicit opt-out still wins, and a PASSED Gate 1 still shows exactly the scope it sent).
 *
 *   run: npx playwright test tests/e2e/score-suggestions.spec.ts
 */

/** The payload carries core's calibrated cut-off; the screen reads it from there, never from a copy of its own. */
const TAU = 0.62;
const SCORE = "Frailty index (Williams 2019)";

/** Five real fixture groups and the cosine the free search scored each with. */
function reached() {
  const g = fixtureGroups();
  return [
    { group: g[0]!, score: 0.91, component: "Glaucoma" },
    { group: g[1]!, score: 0.7, component: "Glaucoma" },
    { group: g[2]!, score: TAU, component: "Hearing difficulty" }, // exactly AT the cut-off: suggested (>=)
    { group: g[3]!, score: 0.61, component: "Hearing difficulty" },
    { group: g[4]!, score: 0.3, component: "Glaucoma" },
  ];
}

function suggestions(over: Partial<ScoreSuggestions> = {}): ScoreSuggestions {
  const r = reached();
  return {
    scored: true,
    scoreKind: "dense_cosine",
    threshold: TAU,
    reason: "",
    billedUsd: 0,
    scores: [
      {
        scoreName: SCORE,
        nVariablesIndexed: 328,
        components: ["Glaucoma", "Hearing difficulty"].map((component) => ({
          component,
          groups: r
            .filter((x) => x.component === component)
            .map((x) => ({ groupId: x.group.groupId, score: x.score, bestMember: x.group.memberVariableNames[0] ?? "" })),
        })),
      },
    ],
    ...over,
  };
}

/** The rows "Declare these components" writes: one `composite_swap` per component, chosen "" (not matched). */
function declaration(components: string[]): GateDecision[] {
  return components.map((componentName) => ({
    scoreName: SCORE,
    componentName,
    chosen: "",
    alternatives: components,
    optionSetKey: optionSetKey(components),
  }));
}

function scopeDecision(groupId: string, chosen: "in" | "out"): GateDecision {
  return { groupId, chosen, alternatives: ["in", "out"], optionSetKey: optionSetKey(["in", "out"]) };
}

/** Seed the static build's browser sandbox, as a reviewer's earlier work left it. */
async function seedSandbox(page: Page, kinds: Record<string, GateDecision[]>): Promise<void> {
  const gateDecisions = Object.fromEntries(
    Object.entries(kinds).map(([kind, rows]) => [
      kind,
      Object.fromEntries(rows.map((r) => [decisionItemKey(kind as never, r), r])),
    ]),
  );
  await page.addInitScript(
    ([key, state]) => sessionStorage.setItem(key, state),
    [`${SANDBOX_PREFIX}${PAUSED_JOB}`, JSON.stringify({ gateDecisions })] as const,
  );
}

/** Fulfil the suggestions request (the static build has no backend) and record every request that reached it. */
async function serveSuggestions(page: Page, body: ScoreSuggestions): Promise<string[]> {
  const methods: string[] = [];
  await page.route("**/api/harmonize/jobs/*/score/suggestions", async (route) => {
    methods.push(route.request().method());
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  return methods;
}

/**
 * Serve the fixture as the REVIEWER'S OWN run (its config without `demo`). Suggestions are asked for only on an owned
 * run: the shared demo keeps its declaration in the browser, which the server never sees, and nothing a guest does
 * there leaves the browser (`sandbox.spec.ts`). `mutate` shapes the run further, as `serveRun` does.
 */
async function serveOwned(page: Page, mutate: (run: JobResult) => void = () => {}): Promise<void> {
  await serveRun(page, (run) => {
    asOwnedRun(run);
    mutate(run);
  });
}

async function openGate1(page: Page): Promise<void> {
  await page.goto(`/run/${PAUSED_JOB}/gate1`);
  await page.waitForLoadState("networkidle");
  await expect(page.locator("[data-testid='ledger']")).toBeVisible();
}

const rowOf = (page: Page, gid: string) => page.locator(`[data-testid='ledger-row'][data-row-id='${gid}']`);
const scopeOf = (page: Page, gid: string) => rowOf(page, gid).locator("[data-testid='queue-scope']");
const tagsOf = (page: Page, gid: string) => rowOf(page, gid).locator("[data-testid='queue-score-tag']");

/** A Gate 4 spec whose one match reaches the first fixture group — the shape `derive_composite` emits. */
function gate4Spec(): CompositeSpec {
  const g = fixtureGroups()[0]!;
  return {
    definition: {
      name: SCORE,
      kind: "custom",
      citation: "",
      combinationRule: "",
      threshold: "",
      notes: "",
      statedNItems: 2,
      underEnumerated: 0,
      provenance: "",
      sourceSha256: "",
      components: [],
    },
    matches: [
      {
        component: "Glaucoma",
        conceptId: g.groupId,
        concept: g.concept,
        column: "glaucoma",
        cohorts: g.cohorts,
        sourceVariables: [],
        confidence: 0.95,
        rationale: "measures glaucoma",
        required: true,
        pinned: false,
        shortlist: [g.groupId],
        groupCandidates: [{ groupId: g.groupId, confidence: 0.95 }],
      },
    ],
    feasibility: {
      verdict: "partial",
      nRequired: 2,
      nRequiredMatched: 1,
      matched: ["Glaucoma"],
      missing: ["Hearing difficulty"],
      needsReview: [],
      computableCohorts: [],
      perCohort: [],
      caveats: [],
    },
    derivation: [],
    units: "",
    validationRules: [],
  } as unknown as CompositeSpec;
}

// --- the rule (node) ---------------------------------------------------------------------------------------------

test.describe("Gate 1 score suggestions — the rule", () => {
  test("@gate1 a suggestion offers only groups that clear the payload's OWN cut-off", () => {
    const matches = suggestionMatches(suggestions());
    const offered = matches.flatMap((m) => (m.groupCandidates ?? []).map((g) => g.groupId)).sort();
    const above = reached()
      .filter((x) => x.score >= TAU)
      .map((x) => x.group.groupId)
      .sort();
    expect(offered).toEqual(above);
    // No dense score, no suggestion — a lexical score is never thresholded in its place.
    expect(suggestionMatches(suggestions({ scored: false, scores: [] }))).toEqual([]);
    expect(suggestionMatches(null)).toEqual([]);
  });

  test("@gate1 ONE input: Gate 4's matches when the run has them, else the suggestions — fed to scoreSeededGroups", () => {
    const fromMatch = scoreScopeInput(gate4Spec(), suggestions());
    expect(fromMatch.source).toBe("match");
    expect(fromMatch.threshold).toBe(GROUP_SELECT_THRESHOLD);
    expect([...scoreSeededGroups(fromMatch.matches, fromMatch.threshold).keys()]).toEqual([fixtureGroups()[0]!.groupId]);

    const fromSuggestion = scoreScopeInput(null, suggestions());
    expect(fromSuggestion.source).toBe("suggestion");
    expect(fromSuggestion.threshold).toBe(TAU);
    const seeded = [...scoreSeededGroups(fromSuggestion.matches, fromSuggestion.threshold).keys()].sort();
    expect(seeded).toEqual(
      reached()
        .filter((x) => x.score >= TAU)
        .map((x) => x.group.groupId)
        .sort(),
    );
    // A suggestion is tagged exactly where it seeds: a group below the cut-off is neither.
    expect([...scoreTaggedGroups(fromSuggestion.matches).keys()].sort()).toEqual(seeded);
    expect(scoreSeededGroups(fromSuggestion.matches, fromSuggestion.threshold).get(fixtureGroups()[0]!.groupId)).toEqual([
      "Glaucoma",
    ]);

    expect(scoreScopeInput(null, null).source).toBe("none");
    expect(scoreScopeInput(null, suggestions({ scored: false, scores: [] })).matches).toEqual([]);
  });
});

// --- the screen (static build) -----------------------------------------------------------------------------------

test.describe("Gate 1 score suggestions — the screen", () => {
  test("@gate1 groups at/above the cut-off start IN scope, tagged as suggestions; groups below are neither", async ({
    page,
  }) => {
    await seedSandbox(page, { composite_swap: declaration(["Glaucoma", "Hearing difficulty"]) });
    const requests = await serveSuggestions(page, suggestions());
    await serveOwned(page);
    await openGate1(page);

    for (const { group, score, component } of reached()) {
      const suggested = score >= TAU;
      await expect(scopeOf(page, group.groupId), `${score}`).toHaveAttribute("aria-checked", String(suggested));
      await expect(tagsOf(page, group.groupId)).toHaveCount(suggested ? 1 : 0);
      if (suggested) {
        const tag = tagsOf(page, group.groupId).first();
        await expect(tag).toHaveAttribute("data-tag-source", "suggestion");
        await expect(tag).toContainText("Suggested");
        await expect(tag).toContainText(component);
        await expect(tag).toHaveAttribute("title", new RegExp(SUGGESTION_TAG_COPY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      }
    }
    const nSuggested = reached().filter((x) => x.score >= TAU).length;
    await expect(page.locator("[data-testid='sum-block'] [data-sum-line='in-scope']")).toContainText(
      new RegExp(`^${nSuggested} of `),
    );
    // A read, and the only one: the free search is a GET with nothing to bill.
    expect(requests.length).toBeGreaterThan(0);
    expect(new Set(requests)).toEqual(new Set(["GET"]));
  });

  test("@gate1 the score panel says these are suggestions from a free search and the verdict is on Gate 4", async ({
    page,
  }) => {
    await seedSandbox(page, { composite_swap: declaration(["Glaucoma", "Hearing difficulty"]) });
    await serveSuggestions(page, suggestions());
    await serveOwned(page);
    await openGate1(page);
    await page.locator("[data-testid='score-panel-toggle']").click();
    const note = page.locator("[data-testid='score-suggestions-note']");
    await expect(note).toBeVisible();
    await expect(note).toContainText(/free search/i);
    await expect(note).toContainText(/verdict is on Gate 4/i);
    await expect(note).toContainText(`${reached().filter((x) => x.score >= TAU).length} groups`);
  });

  test("@gate1 an explicit opt-out wins over a suggestion", async ({ page }) => {
    const top = reached()[0]!.group.groupId;
    await seedSandbox(page, {
      composite_swap: declaration(["Glaucoma", "Hearing difficulty"]),
      gate1_group_scope: [scopeDecision(top, "out")],
    });
    await serveSuggestions(page, suggestions());
    await serveOwned(page);
    await openGate1(page);
    await expect(scopeOf(page, top)).toHaveAttribute("aria-checked", "false");
    await expect(tagsOf(page, top)).toHaveCount(1); // still named as suggested — the reviewer just declined it
    await expect(scopeOf(page, reached()[1]!.group.groupId)).toHaveAttribute("aria-checked", "true");
    const nSuggested = reached().filter((x) => x.score >= TAU).length;
    await expect(page.locator("[data-testid='sum-block'] [data-sum-line='in-scope']")).toContainText(
      new RegExp(`^${nSuggested - 1} of `),
    );
  });

  test("@gate1 a PASSED Gate 1 shows exactly the scope it sent — no suggestion is fetched or drawn", async ({ page }) => {
    const r = reached();
    const sent = r[4]!.group.groupId; // below the cut-off, but the reviewer had put it in scope
    await seedSandbox(page, { composite_swap: declaration(["Glaucoma", "Hearing difficulty"]) });
    const requests = await serveSuggestions(page, suggestions());
    await serveOwned(page, (run) => {
      run.gatePosition = "gate2";
      run.result!.gatePosition = "gate2";
      run.config = { ...(run.config as object), gate1_scope: [sent] } as never;
    });
    await openGate1(page);
    await expect(page.locator("[data-testid='gate-frozen']")).toBeVisible();
    await expect(scopeOf(page, sent)).toHaveAttribute("aria-checked", "true");
    for (const { group } of r.slice(0, 4)) {
      await expect(scopeOf(page, group.groupId)).toHaveAttribute("aria-checked", "false");
    }
    await expect(page.locator("[data-testid='queue-score-tag']")).toHaveCount(0);
    await expect(page.locator("[data-testid='sum-block'] [data-sum-line='in-scope']")).toContainText(/^1 of /);
    expect(requests).toEqual([]);
  });

  test("@gate1 a run that carries a Gate 4 match uses the match, never the suggestions", async ({ page }) => {
    await seedSandbox(page, { composite_swap: declaration(["Glaucoma", "Hearing difficulty"]) });
    const requests = await serveSuggestions(page, suggestions());
    await serveOwned(page, (run) => {
      run.composites = [gate4Spec()];
    });
    await openGate1(page);
    const matched = fixtureGroups()[0]!.groupId;
    await expect(scopeOf(page, matched)).toHaveAttribute("aria-checked", "true");
    await expect(tagsOf(page, matched).first()).toHaveAttribute("data-tag-source", "match");
    // The suggestion-only groups are not seeded: the match is the input, not a blend of the two.
    await expect(scopeOf(page, reached()[1]!.group.groupId)).toHaveAttribute("aria-checked", "false");
    expect(requests).toEqual([]);
  });

  test("@gate1 with no dense encoder nothing is suggested, and the panel says why", async ({ page }) => {
    const reason = "No suggestions: the dense encoder is unavailable, and lexical scores are not comparable.";
    await seedSandbox(page, { composite_swap: declaration(["Glaucoma", "Hearing difficulty"]) });
    const empty = suggestions().scores.map((sc) => ({ ...sc, components: sc.components.map((c) => ({ ...c, groups: [] })) }));
    await serveSuggestions(page, suggestions({ scored: false, reason, scores: empty }));
    await serveOwned(page);
    await openGate1(page);
    for (const { group } of reached()) {
      await expect(scopeOf(page, group.groupId)).toHaveAttribute("aria-checked", "false");
    }
    await expect(page.locator("[data-testid='queue-score-tag']")).toHaveCount(0);
    await page.locator("[data-testid='score-panel-toggle']").click();
    await expect(page.locator("[data-testid='score-suggestions-note']")).toContainText(reason);
  });

  test("@gate1 on the shared demo nothing is asked for: its declaration lives in the browser, and stays there", async ({
    page,
  }) => {
    await seedSandbox(page, { composite_swap: declaration(["Glaucoma", "Hearing difficulty"]) });
    const requests = await serveSuggestions(page, suggestions());
    await openGate1(page); // the committed fixture IS the demo (`config.demo: true`)
    await expect(page.locator("[data-testid='queue-score-tag']")).toHaveCount(0);
    expect(requests).toEqual([]);
  });

  test("@gate1 nothing declared: no suggestion is asked for", async ({ page }) => {
    const requests = await serveSuggestions(page, suggestions());
    await serveOwned(page);
    await openGate1(page);
    await expect(page.locator("[data-testid='queue-score-tag']")).toHaveCount(0);
    expect(requests).toEqual([]);
  });
});
