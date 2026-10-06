import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { estimateRunCostBreakdown } from "@/lib/estimate";
import { decisionLogCsvRows } from "@/lib/gate4";
import {
  AUTO_ACCEPTED_LABEL,
  AUTO_DECIDED_AFTER,
  AUTO_REVISABLE_KINDS,
  DEMO_PRACTICE_COPY,
  REVIEW_MODE_COPY,
  autoAcceptedGates,
  autoGateStates,
  autoPausedReason,
  fullAutoCharge,
  isGateLocked,
  reviewModeOf,
} from "@/lib/review-mode";
import { SANDBOX_PREFIX, sandboxStateFrom, sandboxWorkCount } from "@/lib/sandbox";
import { FINISHED_JOB, autoRun, serveAutoRun } from "./full-auto-fixture";

/**
 * Full auto (08-30) — the review mode where the server commits each gate itself, and the guest demo it builds.
 *
 *   Setup      — Review: Guided (default) / Full auto, one plain sentence each; Full auto's Start quotes the WHOLE
 *                run (every gate, every group), not the first charge, and sends `reviewMode: "auto"`.
 *   In flight  — the run is seen moving through the gates without stopping; a run that stopped short says why.
 *   Gates      — each auto-committed gate wears "Auto-accepted — not reviewed" and stays open to review for what
 *                the export applies without a re-run; Gate 1's grouping stays as committed. Guided is unchanged.
 *   Exports    — the decision log names each auto-accepted gate (the client mirror of the server's rows).
 *   Demo       — the pinned staged demo: a guest walks Gates 1-4 and nothing they do leaves the tab.
 *
 *   run: npm run test:e2e -- --grep "@full-auto"
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");

// --- the pure half ------------------------------------------------------------------------------------------

test.describe("Full auto — the rules, as functions", () => {
  test("@full-auto a run is guided unless its config says auto", () => {
    expect(reviewModeOf(undefined)).toBe("guided");
    expect(reviewModeOf({})).toBe("guided");
    expect(reviewModeOf({ review_mode: "something else" })).toBe("guided");
    expect(reviewModeOf({ review_mode: "auto" })).toBe("auto");
  });

  test("@full-auto Full auto's Start quotes every gate's work, never less than a guided first charge", () => {
    for (const mode of ["batch", "sync"] as const) {
      const est = estimateRunCostBreakdown(1000, 5, mode, true, true);
      const whole = fullAutoCharge(est);
      expect(whole).toBeCloseTo(est.byGate.gate1.forecast + est.byGate.gate2.forecast + est.byGate.gate3.forecast, 10);
      expect(whole).toBeGreaterThan(est.firstCharge);
      // The ideas pass runs on the results page, never in a Full-auto run, so it is the only line left out.
      const after = est.lines.filter((l) => l.gate === "after").reduce((s, l) => s + l.cost, 0);
      expect(whole).toBeCloseTo(est.total.mid - after, 10);
    }
    expect(fullAutoCharge(estimateRunCostBreakdown(1000, 5, "preview", true))).toBe(0);
  });

  test("@full-auto an auto-accepted gate stays open to what the export applies without a re-run", () => {
    const auto = { review_mode: "auto", gate_decided_by: { gate1: "auto", gate2: "auto", gate3: "auto" } };
    // Passed and auto-committed: names, targets and recodes stay open; Gate 1's grouping does not.
    expect(isGateLocked("gate2", "gate4", auto, "gate2_candidate_pick")).toBe(false);
    expect(isGateLocked("gate3", "gate4", auto, "gate3_spec_edit")).toBe(false);
    expect(isGateLocked("gate1", "gate4", auto, "gate1_rename")).toBe(false);
    for (const kind of ["gate1_group_scope", "gate1_regroup", "gate1_new_group", "composite_swap"])
      expect(isGateLocked("gate1", "gate4", auto, kind), kind).toBe(true);
    // A guided run's passed gate is a record, whatever the kind; a gate not yet passed is open.
    expect(isGateLocked("gate2", "gate4", {}, "gate2_candidate_pick")).toBe(true);
    expect(isGateLocked("gate4", "gate4", auto, "gate4_export_selection")).toBe(false);
    // The client's list is the server's, so a control is never offered that the server would refuse.
    const py = readFileSync(resolve(REPO, "backend/artifact_kinds.py"), "utf8");
    const block = /AUTO_REVISABLE_KINDS[^=]*=\s*frozenset\(\s*\{([\s\S]*?)\}\s*\)/.exec(py)?.[1] ?? "";
    const names = [...block.matchAll(/([A-Z0-9_]+),/g)].map((m) => m[1].toLowerCase());
    expect(names.sort()).toEqual([...AUTO_REVISABLE_KINDS].sort());
  });

  test("@full-auto on the shared demo every gate stays open to practise on", () => {
    // A guest learns the controls there. Their edits stay in the tab and never reach the run (the server refuses
    // every write to the demo), so nothing on it is a record — whoever committed the gate.
    const demo = { demo: true, review_mode: "auto", gate_decided_by: { gate1: "auto", gate2: "auto", gate3: "auto" } };
    for (const kind of ["gate1_group_scope", "gate1_regroup", "gate1_new_group", "gate1_rename", "composite_swap"])
      expect(isGateLocked("gate1", "gate4", demo, kind), kind).toBe(false);
    expect(isGateLocked("gate1", "gate4", demo)).toBe(false);
    expect(isGateLocked("gate2", "gate4", { demo: true }, "gate2_candidate_pick")).toBe(false);
    // Setup holds no review decision to practise: on the demo it stays the read-back of how the run was built.
    expect(isGateLocked("setup", "gate4", demo)).toBe(true);
  });

  test("@full-auto the walk is read gate by gate, from the run's own position and record", () => {
    const cfg = (gates: string[]) => ({ review_mode: "auto", gate_decided_by: Object.fromEntries(gates.map((g) => [g, "auto"])) });
    // The first step is running: nothing has parked yet.
    expect(autoGateStates({ status: "splitting", gatePosition: null, config: cfg([]) })).toEqual({
      gate1: "running", gate2: "waiting", gate3: "waiting", gate4: "waiting",
    });
    // Parked at Gate 1 for the instant the server takes to commit it and start the next step.
    expect(autoGateStates({ status: "awaiting_review", gatePosition: "gate1", autoAdvancing: true, config: cfg([]) })).toEqual({
      gate1: "accepted", gate2: "running", gate3: "waiting", gate4: "waiting",
    });
    // Gate 1 committed, the Gate 2 step running.
    expect(autoGateStates({ status: "assigning", gatePosition: "gate1", config: cfg(["gate1"]) })).toEqual({
      gate1: "accepted", gate2: "running", gate3: "waiting", gate4: "waiting",
    });
    // Done: every gate committed, waiting at the export screen.
    expect(autoGateStates({ status: "awaiting_review", gatePosition: "gate4", config: cfg(["gate1", "gate2", "gate3"]) })).toEqual({
      gate1: "accepted", gate2: "accepted", gate3: "accepted", gate4: "reached",
    });
    // Stopped at Gate 1 (a failed step, no key, a restart): it waits there, and nothing after it was reached.
    expect(autoGateStates({ status: "awaiting_review", gatePosition: "gate1", config: cfg([]) })).toEqual({
      gate1: "reached", gate2: "stopped", gate3: "stopped", gate4: "stopped",
    });
  });

  test("@full-auto a Full-auto run waiting short of Gate 4 says why; one at Gate 4 or still moving does not", () => {
    const base = { config: { review_mode: "auto" }, status: "awaiting_review" as const };
    expect(autoPausedReason({ ...base, gatePosition: "gate2", errorMessage: "Full auto stopped at Gate 2: no key." })).toBe(
      "Full auto stopped at Gate 2: no key.",
    );
    expect(autoPausedReason({ ...base, gatePosition: "gate1" })).toMatch(/restarted, or the run was stopped/);
    expect(autoPausedReason({ ...base, gatePosition: "gate1", autoAdvancing: true })).toBeNull();
    expect(autoPausedReason({ ...base, gatePosition: "gate4" })).toBeNull();
    expect(autoPausedReason({ config: {}, status: "awaiting_review", gatePosition: "gate1" })).toBeNull();
  });

  test("@full-auto the decision log names each auto-accepted gate first in its gate, exactly as the server writes it", () => {
    const run = autoRun();
    const rows = decisionLogCsvRows({}, run.result, run.config, {});
    const auto = rows.filter((r) => r[1] === "gate_auto_accepted");
    expect(auto).toEqual(
      ["gate1", "gate2", "gate3"].map((g) => [`Gate ${g.slice(4)}`, "gate_auto_accepted", AUTO_ACCEPTED_LABEL, g, "", AUTO_DECIDED_AFTER, "", "", "false"]),
    );
    // Gate 1's row leads the log, ahead of the frozen scope; the others follow in gate order.
    expect(rows.slice(1, 5).map((r) => r[1])).toEqual([
      "gate_auto_accepted",
      "gate1_scope_frozen",
      "gate_auto_accepted",
      "gate_auto_accepted",
    ]);
    // A guided run's log gains nothing.
    expect(decisionLogCsvRows({}, run.result, { gate1_scope: ["x"] }, {}).some((r) => r[1] === "gate_auto_accepted")).toBe(false);
    expect(autoAcceptedGates({ gate_decided_by: { gate2: "auto", gate1: "auto" } })).toEqual(["gate1", "gate2"]);
  });
});

// --- Setup: the control and the estimate --------------------------------------------------------------------

const DRAFT = "/run/draft-08-30/setup";

function dictionaryCsv(n: number): string {
  const rows = Array.from({ length: n }, (_, i) => `var_${i},a description of variable ${i},kg`);
  return ["variable_name,description,units", ...rows].join("\n");
}

/** Every Start's `config` form field, answered with a refusal so no run is ever started. */
async function captureStarts(page: Page): Promise<Record<string, unknown>[]> {
  const sent: Record<string, unknown>[] = [];
  await page.route("**/api/harmonize/batch", async (route) => {
    const body = route.request().postDataBuffer()?.toString("utf8") ?? "";
    const m = /name="config"\r\n\r\n([\s\S]*?)\r\n--/.exec(body);
    sent.push(JSON.parse(m![1]) as Record<string, unknown>);
    await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ detail: "captured" }) });
  });
  return sent;
}

async function setupWithOneDictionary(page: Page): Promise<void> {
  await page.goto(DRAFT);
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => localStorage.clear());
  await page.getByTestId("dict-upload").setInputFiles({
    name: "cohort.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(dictionaryCsv(40)),
  });
  await expect(page.getByTestId("dict-card")).toHaveCount(1);
  await page.getByTestId("api-key").fill("sk-ant-e2e-not-a-real-key");
  await expect(page.getByTestId("start-blocked")).toHaveCount(0);
  await expect(page.getByTestId("estimate-total")).toBeVisible();
}

test.describe("Full auto — Setup", () => {
  test("@full-auto Setup offers Guided (the default) and Full auto, one plain sentence each", async ({ page }) => {
    await page.goto(DRAFT);
    await page.waitForLoadState("networkidle");
    const control = page.getByTestId("review-mode");
    await expect(control).toBeVisible();
    for (const mode of ["guided", "auto"] as const) {
      const option = control.getByTestId(`review-mode-${mode}`);
      await expect(option.getByRole("radio")).toBeVisible();
      await expect(option).toContainText(REVIEW_MODE_COPY[mode].label);
      await expect(option.getByTestId("review-mode-sentence")).toHaveText(REVIEW_MODE_COPY[mode].sentence);
    }
    await expect(control.getByRole("radio", { name: /Guided/ })).toBeChecked();
    await expect(control.getByRole("radio", { name: /Full auto/ })).not.toBeChecked();
  });

  test("@full-auto in Full auto the estimate and the Start bar quote the whole run, every group in scope", async ({ page }) => {
    await setupWithOneDictionary(page);
    const bar = page.getByTestId("commit-bar");
    const guidedTotal = Number(await bar.getAttribute("data-total"));
    expect(guidedTotal).toBeGreaterThan(0);
    await expect(page.getByTestId("first-charge")).toBeVisible();
    await expect(page.getByTestId("full-auto-charge")).toHaveCount(0);

    await page.getByTestId("review-mode").getByRole("radio", { name: /Full auto/ }).check();
    const charge = page.getByTestId("full-auto-charge");
    await expect(charge).toBeVisible();
    await expect(charge).toContainText("every gate");
    await expect(charge).toContainText("every group");
    await expect(page.getByTestId("first-charge")).toHaveCount(0);
    const autoTotal = Number(await bar.getAttribute("data-total"));
    expect(autoTotal).toBeGreaterThan(guidedTotal);
    expect(Number(await charge.getAttribute("data-total"))).toBeCloseTo(autoTotal, 10);
    await expect(bar).toContainText("every group in scope");
  });

  test("@full-auto Start sends reviewMode auto for Full auto, and nothing new for Guided", async ({ page }) => {
    const sent = await captureStarts(page);
    await setupWithOneDictionary(page);
    await page.getByTestId("start-run").click();
    await expect.poll(() => sent.length).toBe(1);
    expect("reviewMode" in sent[0]).toBe(false);

    await page.getByTestId("review-mode").getByRole("radio", { name: /Full auto/ }).check();
    await page.getByTestId("start-run").click();
    await expect.poll(() => sent.length).toBe(2);
    expect(sent[1].reviewMode).toBe("auto");
  });
});

// --- the gate screens ---------------------------------------------------------------------------------------

async function open(page: Page, gate: string): Promise<void> {
  await page.goto(`/run/${FINISHED_JOB}/${gate}`);
  await page.waitForLoadState("networkidle");
}

test.describe("Full auto — the gates", () => {
  test("@full-auto every auto-committed gate says it was not reviewed, and stays open to review", async ({ page }) => {
    await serveAutoRun(page);
    for (const gate of ["gate1", "gate2", "gate3"]) {
      await open(page, gate);
      const banner = page.getByTestId("auto-accepted-banner");
      await expect(banner, gate).toBeVisible();
      await expect(banner).toContainText(AUTO_ACCEPTED_LABEL);
      // Not a record that "can no longer change" — that notice is for a gate a person continued.
      await expect(page.getByTestId("gate-frozen"), gate).toHaveCount(0);
    }
    // Gate 2: the target can still be re-picked.
    await open(page, "gate2");
    const unchosen = page.locator("[data-testid='candidate-row']:not([data-chosen='true'])").first();
    await unchosen.locator("[data-testid='candidate-expand']").click();
    await expect(unchosen.locator("[data-testid='candidate-select']")).toBeEnabled();
    // Gate 1: a group can be renamed, but its scope stays as committed (every group in, and not changeable).
    await open(page, "gate1");
    await expect(page.getByTestId("rename-group")).toBeVisible();
    const scopeBoxes = page.locator("[data-testid='ledger-row'] [data-testid='queue-scope']");
    await expect(scopeBoxes.first()).toBeDisabled();
    await expect(page.getByTestId("auto-accepted-banner")).toContainText("re-run");
  });

  test("@full-auto a guided run's passed gates are unchanged: a record, with no auto banner", async ({ page }) => {
    await serveAutoRun(page, { guided: true });
    await open(page, "gate2");
    await expect(page.getByTestId("gate-frozen")).toBeVisible();
    await expect(page.getByTestId("auto-accepted-banner")).toHaveCount(0);
  });

  test("@full-auto in flight, the run is seen moving through the gates without stopping", async ({ page }) => {
    await serveAutoRun(page, { gate: "gate1", status: "assigning", decided: ["gate1"] });
    await open(page, "gate1");
    const strip = page.getByTestId("auto-progress");
    await expect(strip).toBeVisible();
    await expect(strip.locator("[data-auto-gate='gate1']")).toHaveAttribute("data-state", "accepted");
    await expect(strip.locator("[data-auto-gate='gate2']")).toHaveAttribute("data-state", "running");
    await expect(strip.locator("[data-auto-gate='gate4']")).toHaveAttribute("data-state", "waiting");
    await expect(strip).toContainText(AUTO_ACCEPTED_LABEL);
  });

  test("@full-auto the moment between a park and the next step still reads as a run moving on", async ({ page }) => {
    await serveAutoRun(page, { gate: "gate2", status: "awaiting_review", decided: ["gate1"], autoAdvancing: true });
    await open(page, "gate2");
    await expect(page.getByTestId("run-progress")).toBeVisible();
    await expect(page.getByTestId("auto-progress").locator("[data-auto-gate='gate3']")).toHaveAttribute(
      "data-state",
      "running",
    );
    await expect(page.getByTestId("auto-paused")).toHaveCount(0);
  });

  test("@full-auto a Full-auto run that stopped short of Gate 4 says why, and that it continues by hand", async ({ page }) => {
    await serveAutoRun(page, {
      gate: "gate2",
      status: "awaiting_review",
      decided: ["gate1"],
      errorMessage: "Full auto stopped at Gate 2: the provider fell over. Review this gate and continue it manually.",
    });
    await open(page, "gate2");
    const notice = page.getByTestId("auto-paused");
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("the provider fell over");
    await expect(notice).toContainText(/Continue/);
  });

  test("@full-auto Gate 4's decision log preview names the gates nobody reviewed", async ({ page }) => {
    await serveAutoRun(page);
    await open(page, "gate4");
    await page.locator('[data-testid="artifact-tile"][data-thing="decisions_csv"] [data-testid="artifact-preview"]').click();
    await expect(page.getByTestId("artifact-preview-content")).toContainText(AUTO_ACCEPTED_LABEL);
  });
});

// --- the guest demo (task 4) --------------------------------------------------------------------------------

function watchWrites(page: Page): string[] {
  const writes: string[] = [];
  page.on("request", (r) => {
    if (r.method() !== "GET" || r.url().includes("/api/")) writes.push(`${r.method()} ${r.url()}`);
  });
  return writes;
}

async function held(page: Page) {
  return sandboxStateFrom(await page.evaluate((k) => sessionStorage.getItem(k), `${SANDBOX_PREFIX}${FINISHED_JOB}`));
}

test.describe("Full auto — the guest demo it builds", () => {
  test("@full-auto a guest walks Gates 1-4 on the staged demo, edits on the way, and nothing leaves the tab", async ({
    page,
    context,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await serveAutoRun(page, { demo: true });
    const writes = watchWrites(page);

    await open(page, "gate1");
    await expect(page.getByTestId("sandbox-banner")).toBeVisible();
    await expect(page.getByTestId("auto-accepted-banner")).toBeVisible();
    await expect(page.getByTestId("gate-frozen")).toHaveCount(0);
    // Every group was sent on by Full auto, and the screen says so.
    const rows = page.locator("[data-testid='ledger-row']");
    await expect(rows.first().locator("[data-testid='queue-scope']")).toBeChecked();
    await rows.first().click();
    await page.getByTestId("rename-group").click();
    const rename = page.getByRole("textbox", { name: "Rename group" });
    await rename.fill("A guest's name for it");
    await rename.press("Enter");
    await expect(page.getByTestId("sandbox-banner")).toHaveAttribute("data-unsaved", "1");

    // Continue WALKS on the demo: no price, no request.
    await page.getByTestId("commit-bar").getByRole("button", { name: /Continue to Gate 2/ }).click();
    await expect(page).toHaveURL(new RegExp(`/run/${FINISHED_JOB}/gate2$`));
    await expect(page.getByTestId("auto-accepted-banner")).toBeVisible();
    const unchosen = page.locator("[data-testid='candidate-row']:not([data-chosen='true'])").first();
    await unchosen.locator("[data-testid='candidate-expand']").click();
    await unchosen.locator("[data-testid='candidate-select']").click();
    const confirm = page.locator("[data-testid='repick-confirm']");
    if (await confirm.isVisible().catch(() => false)) await page.locator("[data-testid='repick-accept']").click();
    await expect(page.getByTestId("sandbox-banner")).toHaveAttribute("data-unsaved", "2");

    await page.locator("[data-testid='gate2-continue']").click();
    await expect(page).toHaveURL(new RegExp(`/run/${FINISHED_JOB}/gate3$`));
    await expect(page.getByTestId("auto-accepted-banner")).toBeVisible();
    await page.locator("[data-testid='gate3-concept']").first().click();
    await page.locator("[data-testid='spec-note-input']").first().fill("Checked by a guest.");
    await page.locator("[data-testid='spec-save']").first().click();
    await expect(page.getByTestId("sandbox-banner")).toHaveAttribute("data-unsaved", "3");

    await page.locator("[data-testid='gate3-continue']").click();
    await expect(page).toHaveURL(new RegExp(`/run/${FINISHED_JOB}/gate4$`));
    await expect(page.getByTestId("sandbox-banner")).toBeVisible();

    const state = await held(page);
    expect(sandboxWorkCount(state)).toBe(3);
    expect(Object.keys(state.gateDecisions ?? {}).sort()).toEqual(["gate1_rename", "gate2_candidate_pick", "gate3_spec_edit"]);
    // NOTHING LEFT THE BROWSER, and a fresh tab starts from the demo as shipped.
    expect(writes).toEqual([]);
    expect(errors).toEqual([]);
    const fresh = await context.newPage();
    await serveAutoRun(fresh, { demo: true });
    await fresh.goto(`/run/${FINISHED_JOB}/gate1`);
    await expect(fresh.getByTestId("sandbox-banner")).toHaveAttribute("data-unsaved", "0");
  });

  test("@full-auto a guest practises Gate 1's grouping on the demo, and none of it leaves the tab", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await serveAutoRun(page, { demo: true });
    const writes = watchWrites(page);
    await open(page, "gate1");
    // The banner says the controls are there to try, not that the grouping is locked.
    await expect(page.getByTestId("auto-accepted-banner")).toContainText(DEMO_PRACTICE_COPY);

    // Scope starts as the run sent it (every group in), and a guest can take a group out.
    const rows = page.locator("[data-testid='ledger-row']");
    const box = rows.first().locator("[data-testid='queue-scope']");
    await expect(box).toBeChecked();
    await box.click();
    await expect(box).not.toBeChecked();

    // A variable can be dragged from one group onto another.
    const target = rows.nth(2);
    await rows.nth(1).click();
    const member = page.locator("[data-testid='gate1-detail'] [data-testid='member-row']").first();
    await target.scrollIntoViewIfNeeded();
    await member.dragTo(target);

    // And a group of the guest's own can be made.
    await page.locator("[data-testid='new-group']").click();
    const name = page.locator("[data-testid='new-group-name']");
    await name.fill("A guest's group");
    await name.press("Enter");
    await expect(page.locator("[data-testid='ledger-row'][data-reviewer='true']", { hasText: "A guest's group" })).toBeVisible();

    const state = await held(page);
    expect(Object.keys(state.gateDecisions ?? {}).sort()).toEqual(["gate1_group_scope", "gate1_new_group", "gate1_regroup"]);
    await expect(page.getByTestId("sandbox-banner")).toHaveAttribute("data-unsaved", String(sandboxWorkCount(state)));
    expect(writes).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("@full-auto the demo page opens a staged demo at Gate 1, and skipping goes to Gate 4", async ({ page }) => {
    await page.route("**/static-data/demos.json", async (route) => {
      const res = await route.fetch();
      const body = (await res.json()) as { combos: { staged?: boolean }[] };
      body.combos = body.combos.map((c) => ({ ...c, staged: true }));
      await route.fulfill({ response: res, json: body });
    });
    await serveAutoRun(page, { demo: true });
    await page.goto("/demo");
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "Load demo" }).click();
    await expect(page).toHaveURL(new RegExp(`/run/${FINISHED_JOB}/gate1$`));
    await page.goto("/demo");
    await page.getByRole("button", { name: /Skip to/ }).click();
    await expect(page).toHaveURL(new RegExp(`/run/${FINISHED_JOB}/gate4$`));
  });
});
