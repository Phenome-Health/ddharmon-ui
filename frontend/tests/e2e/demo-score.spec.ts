import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { shippedDeclaration, shippedSuggestions } from "@/lib/demo-score";
import { SANDBOX_PREFIX, sandboxStateFrom, sandboxWorkCount } from "@/lib/sandbox";
import { streamPayload } from "@/lib/stream-payload";
import type { CompositeSpec, DemoScore, JobResult } from "@/types";
import { FINISHED_JOB, autoRun } from "./full-auto-fixture";

/**
 * The shared demo's DECLARED SCORE, end to end: a declared frailty index on Gate 1 with the free search's hints, and
 * Gate 4's match with a verdict per component — the whole score-builder flow, shown to a guest without a paid call.
 *
 * The demo ships it (`backend/demos/score.json`, built offline by `scripts/build_demo_score.py`): the declaration and
 * Gate 1's hints ride the run as `demoScore`, the match as its `composites`. The declaration is a BASELINE — the
 * guest starts from it, can still edit it in the tab, and only their own edits count as unsaved work.
 *
 * THE FIXTURE IS THE SHIPPED SIDECAR, re-pointed at the static fixture's run. The sidecar names the shipped demo's
 * groups and variables, which the bundled static fixture (an older run) does not have, so every id in it is mapped,
 * deterministically, onto one of the fixture's — the score, its 49 components, the hints' scores and the match's
 * verdicts, coverage and recipe are the real ones. Constructed here, never committed as a file (`gate23-fixture.ts`).
 *
 *   run: E2E_PORT=4195 npx playwright test demo-score
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SIDECAR = resolve(HERE, "../../../backend/demos/score.json");
const SNAPSHOT = "aireadi_aou_clsa_mesa_ukbb.json";

interface ShippedScore {
  declaration: Record<string, unknown>[];
  suggestions: DemoScore["suggestions"];
  composite: CompositeSpec;
}

function shipped(): ShippedScore {
  return (JSON.parse(readFileSync(SIDECAR, "utf8")) as Record<string, ShippedScore>)[SNAPSHOT]!;
}

const GROUP_ID = /^c[0-9a-f]{6,}#g\d+$/;
const VARIABLE_ID = /^(AI-READI|AoU|CLSA|MESA|UKBB):/;

/**
 * Every shipped group id and variable id, mapped onto the fixture's own — the n-th distinct id seen to the n-th of
 * the fixture's (wrapping), so a rebuild of the sidecar re-maps without anyone touching this file.
 */
function repoint<T>(value: T, groups: string[], variables: string[]): T {
  const seen = new Map<string, string>();
  const map = (s: string, pool: string[]) => {
    if (!seen.has(s)) seen.set(s, pool[seen.size % pool.length]!);
    return seen.get(s)!;
  };
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      if (GROUP_ID.test(v)) return map(v, groups);
      if (VARIABLE_ID.test(v)) return map(v, variables);
      return v;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [GROUP_ID.test(k) || VARIABLE_ID.test(k) ? walk(k) : k, walk(x)]));
    }
    return v;
  };
  return walk(value) as T;
}

/** The staged demo, carrying the shipped score re-pointed at the fixture's records and variables. */
function demoWithScore({ demo = true }: { demo?: boolean } = {}): { run: JobResult; score: ShippedScore } {
  const run = autoRun({ demo });
  // A group id must name both a Gate 1 ledger row (the hints) and a final record (the match): records that are groups.
  const ledger = new Set((run.result!.conceptGroups ?? []).map((g) => g.groupId));
  const groups = run.result!.records.map((r) => r.id).filter((id) => ledger.has(id));
  const variables = Object.keys(run.result!.fieldIndex ?? {});
  const score = repoint(shipped(), groups, variables);
  run.demoScore = { declaration: score.declaration, suggestions: score.suggestions };
  run.composites = [score.composite];
  return { run, score };
}

async function serve(page: Page, run: JobResult): Promise<void> {
  await page.route(`**/static-data/result-${FINISHED_JOB}.json`, async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(run) });
  });
}

/** Anything that left the tab: a write of any kind, or any request to the API at all. */
function watchRequests(page: Page): string[] {
  const out: string[] = [];
  page.on("request", (r) => {
    if (r.method() !== "GET" || r.url().includes("/api/")) out.push(`${r.method()} ${r.url()}`);
  });
  return out;
}

async function open(page: Page, gate: string): Promise<void> {
  await page.goto(`/run/${FINISHED_JOB}/${gate}`);
  await page.waitForLoadState("networkidle");
}

async function held(page: Page) {
  return sandboxStateFrom(await page.evaluate((k) => sessionStorage.getItem(k), `${SANDBOX_PREFIX}${FINISHED_JOB}`));
}

const SCORE_NAME = "Frailty index (Williams et al. 2019, 49 items)";

test.describe("The demo's declared score — the rules, as functions", () => {
  test("@demo-score only the shared demo reads the shipped score; a real run reads nothing from it", () => {
    const { run } = demoWithScore();
    expect(shippedDeclaration(run.demoScore, true)?.composite_swap).toHaveLength(49);
    expect(shippedSuggestions(run.demoScore, true)?.scores[0]?.scoreName).toBe(SCORE_NAME);
    for (const pinned of [false, undefined]) {
      expect(shippedDeclaration(run.demoScore, pinned)).toBeNull();
      expect(shippedSuggestions(run.demoScore, pinned)).toBeNull();
    }
    expect(shippedDeclaration(undefined, true)).toBeNull();
  });

  test("@demo-score a live run's payload carries the shipped score into the screens, as it carries composites", () => {
    // The static build hands the screens the whole fixture; a LIVE build folds the fetched /result payload into the
    // thin SSE frame key by key — so a key missing from that fold never reaches a screen, whatever the server sends.
    const { run } = demoWithScore();
    const folded = streamPayload(run);
    expect(folded.demoScore).toEqual(run.demoScore);
    expect(folded.composites).toEqual(run.composites);
    // Before the first fetch lands: the defaults every consumer reads unguarded, and no shipped score.
    const empty = streamPayload(undefined);
    expect(empty).toMatchObject({ result: null, decisions: {}, analysisIdeas: null, composites: null, config: {}, dictionaries: [] });
    expect(empty.demoScore).toBeUndefined();
  });

  test("@demo-score the shipped score is the frailty index, declared in full and matched in part", () => {
    const score = shipped();
    expect(score.declaration).toHaveLength(49);
    expect(new Set(score.declaration.map((r) => r.scoreName))).toEqual(new Set([SCORE_NAME]));
    expect(score.composite.definition.name).toBe(SCORE_NAME);
    expect(score.composite.sourceKind).toBe("declaration");
    expect(score.composite.feasibility.verdict).toBe("partial");
    expect(score.composite.feasibility.nRequired).toBe(49);
    expect(score.suggestions?.billedUsd).toBe(0);
  });
});

test.describe("The demo's declared score — on screen", () => {
  test("@demo-score a guest on a fresh demo tab sees the declared frailty index on Gate 1, with its hints", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    const { run, score } = demoWithScore();
    await serve(page, run);
    const requests = watchRequests(page);
    await open(page, "gate1");

    // The declaration is there, as shipped — and it is not the guest's work.
    await expect(page.getByTestId("sandbox-banner")).toHaveAttribute("data-unsaved", "0");
    const strip = page.getByTestId("score-strip");
    await expect(strip).toHaveAttribute("data-declared", "true");
    await expect(page.getByTestId("score-strip-status")).toContainText(SCORE_NAME);
    await expect(page.getByTestId("score-strip-status")).toContainText("49 components declared");

    // The free search's hints tag the groups they reached in the queue — as suggestions, never as a match.
    const tags = page.locator("[data-testid='queue-score-tag']");
    await expect(tags.first()).toBeVisible();
    await expect(page.locator("[data-testid='queue-score-tag'][data-tag-source='match']")).toHaveCount(0);
    const threshold = score.suggestions!.threshold;
    const hinted = new Set(
      score.suggestions!.scores.flatMap((s) => s.components.flatMap((c) => c.groups.filter((g) => g.score >= threshold).map((g) => g.groupId))),
    );
    for (const gid of hinted) {
      await expect(page.locator(`[data-testid='ledger-row'][data-row-id='${gid}'] [data-testid='queue-score-tag'][data-tag-source='suggestion']`).first()).toBeVisible();
    }

    // Opened, the panel shows the hint cards (not Gate 4's match — that waits on Gate 4), and the paid match is
    // honestly deferred to Gate 4 with the copy it always had.
    await page.getByTestId("score-panel-toggle").click();
    const panel = page.getByTestId("score-panel");
    await expect(panel.getByTestId("score-suggestions")).toBeVisible();
    await expect(panel.locator("[data-testid='score-suggestion']")).toHaveCount(49);
    await expect(panel.getByTestId("score-suggestions-note")).toBeVisible();
    await expect(panel.locator("[data-testid='score-match']")).toHaveCount(0);
    await expect(panel.getByTestId("score-match-price")).toBeVisible();

    expect(sandboxWorkCount(await held(page))).toBe(0);
    expect(requests).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("@demo-score Gate 4 shows the frailty index card with its match: a verdict, per component and per cohort", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    const { run, score } = demoWithScore();
    await serve(page, run);
    const requests = watchRequests(page);
    await open(page, "gate4");

    const card = page.getByTestId("gate4-score");
    await expect(card).toHaveCount(1);
    await expect(card).toHaveAttribute("data-score", SCORE_NAME);
    // Matched, on the folded header: the verdict and its count, not "not matched yet".
    await expect(card.getByTestId("gate4-score-state")).toHaveAttribute("data-state", score.composite.feasibility.verdict);
    await card.getByTestId("gate4-score-toggle").click();
    const verdict = card.getByTestId("gate4-score-verdict");
    await expect(verdict).toHaveAttribute("data-verdict", "partial");
    const f = score.composite.feasibility;
    await expect(verdict).toContainText(`${f.nRequiredMatched}/${f.nRequired}`);

    // One verdict per declared component: found where the match bound a concept, not found where it did not.
    const rows = card.locator("[data-testid='score-match']");
    await expect(rows).toHaveCount(49);
    const bound = score.composite.matches.filter((m) => m.conceptId).length;
    await expect(card.locator("[data-testid='score-match'][data-verdict='full']")).toHaveCount(bound);
    await expect(card.locator("[data-testid='score-match'][data-verdict='infeasible']")).toHaveCount(49 - bound);
    await expect(card.locator("[data-testid='gate4-score-cohort']")).toHaveCount(f.perCohort.length);

    // The paid control stays honestly refused on the demo, with its existing copy.
    await expect(card.getByTestId("gate4-score-match")).toHaveCount(0);
    await expect(card).toContainText("This is the shared demo, which never spends money.");

    await expect(page.getByTestId("sandbox-banner")).toHaveAttribute("data-unsaved", "0");
    expect(requests).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("@demo-score a guest can still re-declare in the tab; only that counts as theirs, and a fresh tab starts over", async ({
    page,
    context,
  }) => {
    const { run } = demoWithScore();
    await serve(page, run);
    const requests = watchRequests(page);
    await open(page, "gate1");
    await page.getByTestId("score-panel-toggle").click();
    await page.locator("#score-name").fill(SCORE_NAME);
    await page.getByTestId("score-components").fill("Glaucoma");
    await page.getByRole("button", { name: "Declare these components" }).click();

    // The re-declared component is the guest's (held in the tab); the other 48 are still the shipped baseline.
    await expect(page.getByTestId("sandbox-banner")).toHaveAttribute("data-unsaved", "1");
    const state = await held(page);
    expect(Object.keys(state.gateDecisions?.composite_swap ?? {})).toHaveLength(1);
    await expect(page.getByTestId("score-strip-status")).toContainText("49 components declared");
    expect(requests).toEqual([]);

    const fresh = await context.newPage();
    await serve(fresh, run);
    await open(fresh, "gate1");
    await expect(fresh.getByTestId("sandbox-banner")).toHaveAttribute("data-unsaved", "0");
    await expect(fresh.getByTestId("score-strip")).toHaveAttribute("data-declared", "true");
  });

  test("@demo-score a run of the reviewer's own never takes a shipped score, even one carried on its payload", async ({
    page,
  }) => {
    const { run } = demoWithScore({ demo: false });
    run.composites = null; // the reviewer has matched nothing; only the stray shipped score rides the payload
    await serve(page, run);
    await open(page, "gate1");
    await expect(page.getByTestId("score-strip")).toHaveAttribute("data-declared", "false");
    await expect(page.locator("[data-testid='queue-score-tag'][data-tag-source='suggestion']")).toHaveCount(0);
  });

  test("@demo-score the composite page shows the demo's shipped match and refuses to derive on the demo", async ({
    page,
  }) => {
    const { run } = demoWithScore();
    await serve(page, run);
    const requests = watchRequests(page);
    await page.goto(`/job/${FINISHED_JOB}/composite`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByTestId("composite-demo-refusal")).toBeVisible();
    await page.getByPlaceholder(/Paste the methods section/).fill("A frailty index of 49 deficits.");
    await expect(page.getByRole("button", { name: "Derive" })).toBeDisabled();
    await expect(page.locator("[data-testid='coverage-row']").first()).toBeVisible();
    expect(requests).toEqual([]);
  });
});
