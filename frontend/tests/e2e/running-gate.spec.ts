import { expect, test, type Page } from "@playwright/test";
import { railCosts } from "@/lib/gate-rail";
import { runningGateOf } from "@/lib/gate-routes";
import type { JobResult } from "@/types";
import { FINISHED_JOB, serveFinished } from "./gate23-fixture";
import { asOwnedRun } from "./gate1-fixture";

/**
 * THE GATE A LEG IS RUNNING TOWARD is a place on the rail you can go to (user test 2026-11-25).
 *
 * Bhargav pressed Continue on Gate 2 of "gate 1 testing AoU", so Gate 3's leg was running ("Specs 92 / 819"). The
 * rail still highlighted Gate 2, the progress panel sat on Gate 2's screen, and the Gate 3 cell read "est. pending"
 * and could not be clicked: "when a gate is in progress, the progress bar appears on the previous gate. I want to be
 * able to click on the cell for the gate itself that's running and instead of 'est. pending' can instead say 'in
 * progress'."
 *
 * So, while a leg runs: its gate's cell says "in progress" and is a link; the progress panel is on THAT gate's screen
 * and nowhere else (the rail already says the run is working, once); every gate the run has reached stays a read-back.
 * The live-shaped walk — Continue, click back, click forward, reload, stop — is `tests/stream/running-gate.spec.ts`.
 *
 *   run: E2E_PORT=4420 npx playwright test running-gate
 */

/** A per-stage ledger like the screenshot's run: Gate 1 $0.19, Gate 2 $0.16. */
const REALIZED = { gate1: 0.19, gate2: 0.16 };

test.describe("which gate a run is working on", () => {
  test("@running-gate a resumed leg runs toward the gate after the one it left; a first leg toward Gate 1", () => {
    expect(runningGateOf({ status: "specs", gatePosition: "gate2" })).toBe("gate3");
    expect(runningGateOf({ status: "assigning", gatePosition: "gate1" })).toBe("gate2");
    expect(runningGateOf({ status: "clustering", gatePosition: null })).toBe("gate1");
    expect(runningGateOf({ status: "pending", gatePosition: "setup" })).toBe("gate1");
  });

  test("@running-gate a run with no worker is working on nothing", () => {
    expect(runningGateOf({ status: "awaiting_review", gatePosition: "gate2" })).toBeNull();
    expect(runningGateOf({ status: "complete", gatePosition: null })).toBeNull();
    expect(runningGateOf({ status: "cancelled", gatePosition: "gate2" })).toBeNull();
    expect(runningGateOf(null)).toBeNull();
  });

  test("@running-gate Full auto's hand-off between a park and its next leg is already working on the next gate", () => {
    expect(runningGateOf({ status: "awaiting_review", gatePosition: "gate2", autoAdvancing: true })).toBe("gate3");
    expect(runningGateOf({ status: "awaiting_review", gatePosition: "gate2", autoAdvancing: false })).toBeNull();
  });
});

test.describe("the running gate's rail column", () => {
  test("@running-gate @rail viewed from the gate before it: the running gate says 'in progress', not an estimate", () => {
    const costs = railCosts("gate2", { realizedByGate: REALIZED, totalRealized: 0.35, runPosition: "gate2", running: "gate3" });
    const byGate = Object.fromEntries(costs.map((c) => [c.gate, c.cost]));
    expect(byGate.gate3).toEqual({ kind: "state", text: "in progress" });
    // Only the running gate changes: what is spent stays spent, and Gate 4 keeps its own copy.
    expect(byGate.gate1).toEqual({ kind: "realized", text: "spent $0.19" });
    expect(byGate.gate2).toEqual({ kind: "realized", text: "spent $0.16" });
    expect(byGate.gate4).toEqual({ kind: "state", text: "no charge" });
  });

  test("@running-gate @rail viewed from the running gate itself it still says 'in progress'", () => {
    const costs = railCosts("gate3", { realizedByGate: REALIZED, totalRealized: 0.35, runPosition: "gate2", running: "gate3" });
    const byGate = Object.fromEntries(costs.map((c) => [c.gate, c.cost]));
    expect(byGate.gate3).toEqual({ kind: "state", text: "in progress" });
    expect(byGate.gate2).toEqual({ kind: "realized", text: "spent $0.16" });
  });

  test("@running-gate @rail an unledgered total stays on the last gate the run REACHED, so the columns still sum to it", () => {
    // Standing on the running gate used to make it the frontier, so the whole total landed on a column that has not
    // finished. It belongs to the gate the run has actually reached.
    const costs = railCosts("gate3", { totalRealized: 0.35, runPosition: "gate2", running: "gate3" });
    const byGate = Object.fromEntries(costs.map((c) => [c.gate, c.cost]));
    expect(byGate.gate2).toEqual({ kind: "realized", text: "spent $0.35" });
    expect(byGate.gate3).toEqual({ kind: "state", text: "in progress" });
  });

  test("@running-gate @rail a first leg's Gate 1 says 'in progress'; the gates after it keep their estimates", () => {
    const costs = railCosts("gate1", { totalRealized: 0.05, runPosition: null, running: "gate1" });
    const byGate = Object.fromEntries(costs.map((c) => [c.gate, c.cost]));
    expect(byGate.gate1).toEqual({ kind: "state", text: "in progress" });
    expect(byGate.gate2.kind).toBe("forecast");
    expect(byGate.gate3.kind).toBe("forecast");
  });

  test("@running-gate @rail a Preview's Gate 1 says 'in progress' while it runs", () => {
    const costs = railCosts("gate1", { totalRealized: 0, runPosition: null, running: "gate1", preview: true });
    expect(costs.map((c) => c.cost.text)).toEqual(["local", "in progress"]);
  });
});

/** Gate 3's leg running, as the screenshot's run was: it left Gate 2, so its position is still Gate 2. */
function gate3LegRunning(run: JobResult): JobResult {
  run.status = "specs" as JobResult["status"];
  run.phase = "specs";
  run.gatePosition = "gate2";
  run.stopping = false;
  return asOwnedRun(run);
}

async function open(page: Page, gate: "gate1" | "gate2" | "gate3"): Promise<void> {
  await page.goto(`/run/${FINISHED_JOB}/${gate}`);
  await page.waitForLoadState("networkidle");
}

test.describe("the running gate on screen", () => {
  test("@running-gate from Gate 2, the running Gate 3 is a link that says 'in progress' — and Gate 2 shows no progress", async ({
    page,
  }) => {
    await serveFinished(page, gate3LegRunning);
    await open(page, "gate2");

    // Gate 2 is a read-back of what the run decided there: its concepts are on screen.
    await expect(page.getByTestId("gate2-concept").first()).toBeVisible();
    // The progress panel is not here — it belongs to the gate the leg is producing.
    await expect(page.getByTestId("run-progress")).toHaveCount(0);

    const cell = page.locator("[data-testid='gate-rail'] li[data-gate='gate3']");
    await expect(cell).toHaveAttribute("data-running", "true");
    await expect(cell).toContainText("in progress");
    await expect(cell).not.toContainText("est.");
    const link = page.getByTestId("rail-link-gate3");
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("aria-label", /Gate 3.*in progress/);

    // A gate after the running one is still ahead: not a link, and not "in progress".
    await expect(page.getByTestId("rail-ahead-gate4")).toBeVisible();
    await expect(page.locator("[data-testid='gate-rail'] li[data-gate='gate4']")).not.toContainText("in progress");
  });

  test("@running-gate clicking the running gate shows the progress there, with that gate current on the rail", async ({
    page,
  }) => {
    await serveFinished(page, gate3LegRunning);
    await open(page, "gate2");
    await page.getByTestId("rail-link-gate3").click();

    await expect(page).toHaveURL(new RegExp(`/run/${FINISHED_JOB}/gate3$`));
    await expect(page.getByTestId("run-progress")).toBeVisible();
    await expect(page.getByTestId("run-progress-stage")).toContainText(/specs/i);
    const cell = page.locator("[data-testid='gate-rail'] li[data-gate='gate3']");
    await expect(cell).toHaveAttribute("aria-current", "step");
    await expect(cell).toContainText("in progress");
    // And the way back is a plain link: Gate 2 is reached, so it is a read-back.
    await expect(page.getByTestId("rail-link-gate2")).toBeVisible();
  });

  test("@running-gate an earlier gate is a read-back with no progress panel either", async ({ page }) => {
    await serveFinished(page, gate3LegRunning);
    await open(page, "gate1");
    await expect(page.getByTestId("run-progress")).toHaveCount(0);
    await expect(page.getByTestId("rail-link-gate3")).toContainText("in progress");
  });
});
