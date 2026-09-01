import { expect, test } from "@playwright/test";

/**
 * The staged-review gate walk — the tracer's end-to-end assertion.
 *
 * WHY THE FIXTURES MATTER HERE MORE THAN ANYWHERE ELSE. Since UI-SPEC §0.1's reversal, reaching Gate 1 on
 * a real run pays for concept generation, splitting and the coherence judge. No test in this phase may
 * incur that. So this walks the bundled static fixture
 * `frontend/public/static-data/result-demo-staged-gate1.json` — a run PAUSED at the Gate 1 boundary,
 * derived from the shipped demo result by `scripts/build_gate_fixture.py`, so the rows on screen are real
 * groups from a real run rather than invented ones.
 *
 *   run: npm run test:e2e -- --grep "resume at gate"
 */

/** The fixture's job id. Its result file is `result-<id>.json`, which is all `getResult` needs. */
const PAUSED_JOB = "demo-staged-gate1";

/**
 * Group ids, in render order, as the page reports them. The identity the reload has to preserve.
 *
 * READ OFF THE LEDGER ROW since 08-15. The tracer's own `concept-group` list item was expanded IN PLACE
 * into the ledger row it was always standing in for, so the row is now `ledger-row`/`data-row-id`. The
 * assertion is unchanged in substance — same groups, same order, same reload — and re-pointing it here is
 * what keeps that true rather than leaving a selector matching nothing.
 */
async function conceptGroupIds(page: import("@playwright/test").Page): Promise<string[]> {
  const rows = page.locator("[data-testid='ledger-row']");
  await expect(rows.first()).toBeVisible();
  return rows.evaluateAll((els) => els.map((el) => el.getAttribute("data-row-id") ?? ""));
}

test.describe("staged review", () => {
  test("@gates the reviewer can resume at gate 1 with the same concept groups after a reload", async ({ page }) => {
    await page.goto(`/run/${PAUSED_JOB}/gate1`);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForLoadState("networkidle");

    // The screen is Gate 1, and it says so to assistive technology as well as visually.
    await expect(page.getByRole("heading", { level: 1, name: "Concept groups" })).toBeVisible();
    const rail = page.locator("[data-testid='gate-rail'] > li");
    await expect(rail).toHaveCount(5);
    await expect(page.locator("[data-testid='gate-rail'] li[aria-current='step']")).toHaveAttribute(
      "data-gate",
      "gate1",
    );

    // Rows are POST-SPLIT CONCEPT GROUPS, each carrying its parent cluster as provenance and its
    // generated name marked as generated — no catalog badge, no identifier link, no endorsement.
    const before = await conceptGroupIds(page);
    expect(before.length).toBeGreaterThan(0);
    await expect(page.locator("[data-testid='ledger-row']").first().getByText("generated")).toBeVisible();
    await expect(page.locator("[data-testid='ledger-row']").first()).toContainText("from cluster");

    // A run rejoined at a gate says so, and its banner carries NO countdown: retention is indefinite
    // until the reviewer deletes the run, so a timer would be a threat the product never carries out.
    const banner = page.locator("[data-testid='resume-banner']");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("resume any time");
    await expect(banner).not.toContainText(/expires|deleted in|days left|remaining/i);

    // THE TRACER'S CLAIM: close and reopen, and the run is still at Gate 1 with the same groups.
    await page.reload();
    await page.evaluate(() => document.fonts.ready);
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("heading", { level: 1, name: "Concept groups" })).toBeVisible();
    await expect(page.locator("[data-testid='gate-rail'] li[aria-current='step']")).toHaveAttribute(
      "data-gate",
      "gate1",
    );
    expect(await conceptGroupIds(page)).toEqual(before);
  });

  test("@gates gate 1 tells the reviewer what reaching it already cost, not what it might cost", async ({ page }) => {
    await page.goto(`/run/${PAUSED_JOB}/gate1`);
    await page.waitForLoadState("networkidle");

    // Reaching Gate 1 spent money, so its figure is REALIZED. A forecast here would invite reading
    // committed spend as an estimate — the confusion UI-SPEC §7.1.3 asks the rail to prevent.
    await expect(page.locator("[data-testid='gate-rail'] li[data-gate='gate1'] [data-cost]")).toHaveAttribute(
      "data-cost",
      "realized",
    );
    await expect(page.locator("[data-testid='gate-rail'] li[data-gate='gate2'] [data-cost]")).toHaveAttribute(
      "data-cost",
      "forecast",
    );
    await expect(page.getByText(/Already spent to reach this gate/)).toBeVisible();
  });

  test("@gates the how-to panel names where spending starts", async ({ page }) => {
    await page.goto(`/run/${PAUSED_JOB}/gate1`);
    await page.waitForLoadState("networkidle");

    // Written for someone who has never used the tool: numbered actions, in order, naming their control,
    // and saying plainly when money starts being spent. Since §0.1's reversal that is the run's FIRST
    // charge, and since the Gate 0 demotion (2026-08-26) that press lives on Set up.
    const toggle = page.getByRole("button", { name: /how to use this screen/i });
    await expect(toggle).toBeVisible();
    await toggle.click();
    await expect(page.getByText(/already charged on Set up/i)).toBeVisible();
    // …and it does not still send the reviewer to a screen that no longer exists.
    await expect(page.getByText(/Gate 0/i)).toHaveCount(0);
  });
});

/**
 * The routing shell and the universal chrome, asserted across all FIVE screens of the staged flow.
 *
 * FIVE, not six, since `08-DECISION-GATE0.md` (2026-08-26) demoted Gate 0: it was a gate whose only
 * control was Continue, so it is a receipt rather than a gate, and its content now lives on Setup as a
 * free pre-flight. The rail is still FIXED-LENGTH and still never collapses — what changed is the length,
 * not the rule. A rail that shortened as gates completed would make the reviewer's position mean something
 * different on every screen, which is the opposite of what a progress rail is for.
 *
 *   run: npm run test:e2e -- --grep "five screens"
 */
const GATES = ["setup", "gate1", "gate2", "gate3", "gate4"] as const;

/** The one retired position. It is still a live WIRE value — see the constants test at the end. */
const RETIRED_GATE = "gate0";

test.describe("five screens", () => {
  for (const [i, gate] of GATES.entries()) {
    test(`@gates five screens — ${gate} resolves and renders the universal chrome`, async ({ page }) => {
      await page.goto(`/run/${PAUSED_JOB}/${gate}`);
      await page.waitForLoadState("networkidle");

      // Resolves: NOT the 404 fallback, which is the only other thing a `/run/...` path could hit.
      await expect(page.getByText("404 — page not found")).toHaveCount(0);

      // (2) Masthead: an eyebrow, a display h1 and a subhead — on every screen, not just the built one.
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

      // (2b) The eyebrow. Setup is not a gate number; the four gates read 1..4 OF FOUR. Asserted from the
      // DOM rather than from `eyebrowFor`'s source, because the formula was deliberately left untouched by
      // the demotion and the only evidence it is still right is what it renders.
      // Scoped to `main`: AppShell renders its own <header> for the app bar, outside <main>.
      const eyebrow = (await page.locator("main header p").first().textContent())?.trim() ?? "";
      if (gate === "setup") {
        expect(eyebrow).toBe("Set up");
        expect(eyebrow).not.toMatch(/gate\s*\d/i);
      } else {
        expect(eyebrow).toBe(`Gate ${gate.slice(4)} of 4`);
      }

      // (3) The rail is FIVE columns on every screen, and marks THIS gate for assistive technology. Five
      // regardless of how many gates are behind the reviewer: a rail that shortens as gates complete makes
      // the reviewer's position mean something different on every screen.
      const rail = page.locator("[data-testid='gate-rail'] > li");
      await expect(rail).toHaveCount(5);
      // …and five in the LAYOUT too, not only in the markup. A list of five items inside a six-track grid
      // renders a phantom empty column, which the DOM count alone would not catch.
      const tracks = await page
        .locator("[data-testid='gate-rail']")
        .evaluate((el) => getComputedStyle(el).gridTemplateColumns.trim().split(/\s+/).length);
      expect(tracks, "the rail's grid must declare exactly five tracks").toBe(5);
      // The retired position draws NO column anywhere in the flow.
      await expect(page.locator(`[data-testid='gate-rail'] li[data-gate='${RETIRED_GATE}']`)).toHaveCount(0);
      const current = page.locator("[data-testid='gate-rail'] li[aria-current='step']");
      await expect(current).toHaveCount(1);
      await expect(current).toHaveAttribute("data-gate", gate);
      // Every column carries its own cost-or-state string; none is blank.
      for (let c = 0; c < 5; c++) {
        await expect(rail.nth(c).locator("[data-cost]")).not.toBeEmpty();
      }
      // Completed gates render distinctly — `data-state` covers 0..5 completed without the rail changing
      // length. Exactly `i` columns are behind this one.
      await expect(page.locator("[data-testid='gate-rail'] li[data-state='done']")).toHaveCount(i);
      await expect(page.locator("[data-testid='gate-rail'] li[data-state='ahead']")).toHaveCount(4 - i);

      // (4) The how-to panel is present on every screen.
      await expect(page.getByRole("button", { name: /how to use this screen/i })).toBeVisible();
    });
  }

  test("@gates five screens — a passed gate reads as realized while a future one reads as a forecast", async ({
    page,
  }) => {
    // Standing at Gate 2, Gate 1 is BEHIND the reviewer and its money is committed. Quoting it as an
    // estimate is the exact confusion UI-SPEC §7.1.3 asks the rail to prevent, and after §0.1's reversal
    // there is always committed spend behind a reviewer from Gate 1 onward.
    await page.goto(`/run/${PAUSED_JOB}/gate2`);
    await page.waitForLoadState("networkidle");
    const passed = page.locator("[data-testid='gate-rail'] li[data-gate='gate1'] [data-cost]");
    const ahead = page.locator("[data-testid='gate-rail'] li[data-gate='gate3'] [data-cost]");
    await expect(passed).toHaveAttribute("data-cost", "realized");
    await expect(ahead).toHaveAttribute("data-cost", "forecast");
    // Distinguishable IN WORDS, not only by weight: a colour or weight difference alone is not a statement.
    await expect(passed).toContainText(/spent/i);
    await expect(ahead).toContainText(/est\./i);
    expect(await passed.textContent()).not.toBe(await ahead.textContent());
  });

  test("@gates five screens — every icon-only control in the chrome has an accessible name", async ({ page }) => {
    await page.goto(`/run/${PAUSED_JOB}/gate1`);
    await page.waitForLoadState("networkidle");

    // An icon-only control with no accessible name is a defect, not a style choice (UI-SPEC §6). Scoped to
    // the gate chrome: AppShell's own bar is another plan's surface and asserting it here would make this
    // test fail for reasons that have nothing to do with the gates.
    const nameless = await page.evaluate(() => {
      const root = document.querySelector("main");
      if (!root) return ["no <main> found"];
      const bad: string[] = [];
      for (const el of Array.from(root.querySelectorAll<HTMLElement>("button, a[href], [role='button']"))) {
        if (el.getAttribute("aria-hidden") === "true") continue;
        const text = (el.textContent ?? "").trim();
        const name = el.getAttribute("aria-label") ?? el.getAttribute("title") ?? "";
        if (!text && !name.trim()) bad.push(el.outerHTML.slice(0, 120));
      }
      return bad;
    });
    expect(nameless, `icon-only control(s) with no accessible name: ${nameless.join(" | ")}`).toEqual([]);
  });

  test("@gates five screens — the chrome renders no run chip when there is no run", async ({ page }) => {
    // A job id with no fixture: `getResult` 404s, so the hook never produces a job. The chip must be
    // ABSENT, not empty — an empty chip reads as a run with no name.
    await page.goto("/run/no-such-run/gate1");
    await page.waitForLoadState("networkidle");
    await expect(page.locator("[data-testid='run-chip']")).toHaveCount(0);
    // The chrome itself still renders, so the screen is never a blank page.
    await expect(page.locator("[data-testid='gate-rail'] > li")).toHaveCount(5);
  });

  test("@gates five screens — a long run name is clamped and the app bar height never reflows", async ({ page }) => {
    await page.goto(`/run/${PAUSED_JOB}/gate1`);
    await page.waitForLoadState("networkidle");
    const before = await page.locator("[data-testid='run-chip']").evaluate((el) => {
      const bar = el.parentElement!;
      return bar.getBoundingClientRect().height;
    });
    const after = await page.locator("[data-testid='run-chip']").evaluate((el) => {
      const label = el.firstElementChild as HTMLElement;
      label.textContent = "A run name so long that it would wrap several times over ".repeat(6);
      const bar = el.parentElement!;
      return {
        height: bar.getBoundingClientRect().height,
        clamped: label.scrollWidth > label.clientWidth,
      };
    });
    expect(after.height).toBe(before);
    expect(after.clamped, "a long run name must be clamped, not wrapped").toBe(true);
  });

  test("@gates five screens — the retired gate0 path lands on Setup rather than 404ing or dead-ending", async ({
    page,
  }) => {
    // The wire still parks runs at `gate0` (08-DECISION-GATE0 D-3 keeps the backend boundary exactly as
    // built), so its URL is a live value even though no screen answers to it any more. A live wire value
    // whose URL 404s is a landmine for every resume link built from `gatePosition`. Following D-16's
    // precedent in this phase, the route stays registered and REDIRECTS.
    await page.goto(`/run/${PAUSED_JOB}/${RETIRED_GATE}`);
    await page.waitForLoadState("networkidle");

    // The same run, on Setup. Not the 404 fallback, and not a blank main.
    expect(new URL(page.url()).pathname).toBe(`/run/${PAUSED_JOB}/setup`);
    await expect(page.getByText("404 — page not found")).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 1, name: "Set up" })).toBeVisible();
    await expect(page.locator("[data-testid='gate-rail'] li[aria-current='step']")).toHaveAttribute(
      "data-gate",
      "setup",
    );
    expect((await page.locator("main").innerText()).trim().length).toBeGreaterThan(0);
  });

  test("@gates five screens — the rail's shape constant and the WIRE's order constant differ in exactly the retired position", async () => {
    // TWO NEAR-IDENTICALLY-NAMED CONSTANTS WITH OPPOSITE JOBS, and after the demotion they deliberately
    // disagree. `GATE_SEQUENCE` (GateRail.tsx) declares what the RAIL DRAWS — five columns.
    // `GATE_ORDER` (lib/api.ts) is the client half of the WIRE contract and mirrors contract.py's
    // `GatePosition`, where `gate0` is still a real parked position: `next_gate("gate0") === "gate1"` is
    // what resumes a paused run. "Harmonising" the two would either put a dead column back on every
    // screen or break the resume. Read from the DECLARATIONS, which is what a later tidying edit touches.
    const { readFileSync } = await import("node:fs");
    const { dirname, resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

    const arrayFrom = (file: string, name: string): string[] => {
      const src = readFileSync(resolve(root, file), "utf8");
      const m = new RegExp(`${name}\\s*:\\s*GatePosition\\[\\]\\s*=\\s*\\[([^\\]]*)\\]`).exec(src);
      expect(m, `${name} not found in ${file}`).not.toBeNull();
      return [...m![1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
    };

    const rail = arrayFrom("src/components/gate/GateRail.tsx", "GATE_SEQUENCE");
    const wire = arrayFrom("src/lib/api.ts", "GATE_ORDER");

    expect(rail, "the rail draws Setup + four gates").toEqual(["setup", "gate1", "gate2", "gate3", "gate4"]);
    expect(
      wire,
      "GATE_ORDER is the WIRE contract and still carries the retired position — the backend parks runs there",
    ).toContain(RETIRED_GATE);
    expect(
      wire.filter((g) => !rail.includes(g)),
      "the two constants must differ in EXACTLY the retired position and nothing else",
    ).toEqual([RETIRED_GATE]);
    expect(
      rail.filter((g) => !wire.includes(g)),
      "the rail may not draw a column for a position the wire does not know",
    ).toEqual([]);
  });
});

/**
 * Serve a MUTATED copy of the committed fixture, for the states a committed file cannot honestly hold.
 * The mutation is applied to the real payload, so the screen still renders against the true contract.
 */
async function withPayload(
  page: import("@playwright/test").Page,
  mutate: (payload: Record<string, unknown>) => void,
): Promise<void> {
  const res = await page.request.get(`/static-data/result-${PAUSED_JOB}.json`);
  const payload = (await res.json()) as Record<string, unknown>;
  mutate(payload);
  await page.route("**/static-data/result-*.json", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(payload) }),
  );
}

const GATE1 = `/run/${PAUSED_JOB}/gate1`;

async function gotoGate(page: import("@playwright/test").Page): Promise<void> {
  await page.goto(GATE1);
  await page.waitForLoadState("networkidle");
}

/**
 * THE STOP CONTROL — shell chrome, asserted from the shell's own spec (moved here by 08-14b Task 4).
 *
 * It is placed ONCE in `GateShell` and inherited by every screen in the flow, so a page spec was never
 * the right home for it: the single-call-site assertion below is a claim about the shell, and two
 * implementations of a control that spends or saves real money is precisely what that placement exists to
 * prevent. Driven from a GATE route rather than from the page it was first written against.
 */
test.describe("the stop control", () => {
  /** Put the fixture into a genuinely in-flight state: a worker is running and money is accruing. */
  async function inFlight(page: import("@playwright/test").Page, over: Record<string, unknown> = {}) {
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

  test("@gates an in-flight run can be stopped from the gate chrome, with BOTH modes reachable", async ({ page }) => {
    await inFlight(page);
    await gotoGate(page);

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

  test("@gates the confirmation names the committed-versus-avoided cost split when the run is priced", async ({ page }) => {
    await inFlight(page);
    await gotoGate(page);
    await page.getByRole("button", { name: /stop/i }).first().click();

    const words = (await page.getByRole("alertdialog").innerText()).replace(/\s+/g, " ");
    // Stopping is a decision made against money, not in the dark.
    expect(words).toMatch(/already committed/i);
    expect(words).toMatch(/avoids/i);
    expect(words).toMatch(/\$\d/);
  });

  test("@gates no stop action renders for a finished, cancelled or PAUSED run, and that is not an error", async ({ page }) => {
    // A run parked at a gate is non-terminal but has NO worker — a pause is an exit, so nothing is
    // spending and a stop control there would claim to save money that is not being spent.
    for (const status of ["complete", "cancelled", "awaiting_review"]) {
      await page.unrouteAll();
      await withPayload(page, (p) => {
        Object.assign(p, { status, phase: status });
        delete (p.config as Record<string, unknown>).demo;
      });
      await gotoGate(page);
      await expect(page.locator("[data-testid='gate-rail']")).toBeVisible();
      expect(await page.getByRole("button", { name: /^stop/i }).count(), `status ${status}`).toBe(0);
      // Absence, not a disabled control and not an error notice.
      expect(await page.getByTestId("stop-unavailable").count(), `status ${status}`).toBe(0);
    }
  });

  test("@gates the demo path degrades to an honest not-available, never a dead control", async ({ page }) => {
    await inFlight(page, {});
    // ...and then mark it the shared demo, whose replay has no backend to cancel.
    await page.unrouteAll();
    await withPayload(page, (p) => {
      Object.assign(p, { status: "splitting", phase: "splitting" });
      (p.config as Record<string, unknown>).demo = true;
    });
    await gotoGate(page);

    const tile = page.getByTestId("stop-unavailable");
    await expect(tile).toBeVisible();
    const words = (await tile.innerText()).replace(/\s+/g, " ");
    expect(words.length).toBeGreaterThan(30);
    // A control that looks live and does nothing is worse than a stated absence.
    expect(await page.getByRole("button", { name: /^stop/i }).count()).toBe(0);
  });

  test("@gates stopping leaves the reviewer on the gate they were on", async ({ page }) => {
    await inFlight(page);
    await gotoGate(page);
    await page.getByRole("button", { name: /stop/i }).first().click();
    await page.getByRole("button", { name: /stop & keep results/i }).click();

    // The run's state reflects the stop; the reviewer is not navigated away.
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe(GATE1);
    await expect(page.locator("[data-testid='gate-rail']")).toBeVisible();
  });

  test("@gates the stop action is wired ONCE, in the shell, so every screen inherits it", async () => {
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
    // ONE placement across the whole staged-review surface. Every screen inherits it rather than each
    // re-adding it, which is how two implementations of the same control end up in the tree. It served
    // six screens before the Gate 0 demotion and serves five now; the placement did not change.
    expect(hits).toEqual(["GateShell.tsx"]);
  });

  test("@gates stop-run-action.tsx was CONSUMED, not rewritten", async () => {
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

/**
 * THE RUN-PROGRESS READOUT — shell chrome, and asserted from the shell's own spec (08-14h Task 2).
 *
 * WHY IT IS HERE AT ALL. Bhargav, watching a real run on 2026-08-31: *"there's no progress bar or real
 * time population of stats on gate 1 screen while a run is going."* Every affordance already existed on
 * `pages/dashboard.tsx` — the screen 08-14f stopped routing anyone through when Start began landing
 * directly on Gate 1. So it was lifted (`lib/run-progress.ts` + `components/gate/RunProgress.tsx`) rather
 * than rewritten, and placed ONCE, here, so all five screens inherit it.
 *
 * THE ARITHMETIC IS ASSERTED IN `run-progress.spec.ts`, WITHOUT A BROWSER. What is left for this file is
 * the part only a render can show: that it appears while a run is in flight, that it disappears the
 * moment the run stops being in flight, and that the batch queue wait reads as a wait.
 */
test.describe("the run-progress readout", () => {
  /** Put the fixture into a genuinely in-flight state, with a run mode and phase the caller chooses. */
  async function running(
    page: import("@playwright/test").Page,
    { phase, mode }: { phase: string; mode: string },
  ) {
    await withPayload(page, (p) => {
      Object.assign(p, { status: phase, phase, stopping: false });
      const config = p.config as Record<string, unknown>;
      config.run_mode = mode;
      config.est_fields = 1000;
      config.est_cohorts = 5;
      delete config.demo;
    });
  }

  test("@gates a run that is still running says so, with its stage, its progress and its elapsed time", async ({
    page,
  }) => {
    await running(page, { phase: "clustering", mode: "sync" });
    await gotoGate(page);

    const readout = page.locator("[data-testid='run-progress']");
    await expect(readout).toBeVisible();
    // The stage REACHED, named as the stream names it — a new pipeline stage still displays.
    await expect(page.locator("[data-testid='run-progress-stage']")).toContainText(/clustering/i);
    // A progress indication carrying the percentage as DATA, so the assertion reads the number rather
    // than eyeballing a width.
    const bar = page.locator("[data-testid='run-progress-bar']");
    await expect(bar).toBeVisible();
    expect(Number(await bar.getAttribute("data-pct"))).toBeGreaterThan(0);
    await expect(page.locator("[data-testid='run-progress-elapsed']")).toBeVisible();
    // A sync run past the early noise CAN be projected, so it is.
    await expect(page.locator("[data-testid='run-progress-eta']")).toBeVisible();
  });

  test("@gates a batch run in the provider's queue says what it is waiting on, and shows no bar", async ({
    page,
  }) => {
    await running(page, { phase: "splitting", mode: "batch" });
    await gotoGate(page);

    await expect(page.locator("[data-testid='run-progress']")).toBeVisible();
    // THE CASE THIS PLAN EXISTS TO GET RIGHT. The queue is most of a batch run's wall clock and the stage
    // percentage does not move during it, so a bar that has not moved in twenty minutes reads as a hung
    // product. Say what is being waited on instead of animating a stalled number.
    const queue = page.locator("[data-testid='run-progress-queue']");
    await expect(queue).toBeVisible();
    await expect(queue).toContainText(/queue/i);
    await expect(page.locator("[data-testid='run-progress-bar']")).toHaveCount(0);
    // AND NO ETA. Projecting from a percentage that is standing still invents a number.
    await expect(page.locator("[data-testid='run-progress-eta']")).toHaveCount(0);
    // The elapsed figure is still real and still shown — it is measured, not projected.
    await expect(page.locator("[data-testid='run-progress-elapsed']")).toBeVisible();
  });

  test("@gates the LOCAL leg of a batch run is real progress and is shown as such", async ({ page }) => {
    // Embedding and clustering run on this machine even in batch mode. Suppressing the bar for the whole
    // of a batch run would hide progress that genuinely is happening.
    await running(page, { phase: "embedding", mode: "batch" });
    await gotoGate(page);
    await expect(page.locator("[data-testid='run-progress-bar']")).toBeVisible();
    await expect(page.locator("[data-testid='run-progress-queue']")).toHaveCount(0);
  });

  test("@gates no progress readout over a run that has parked or finished, and that is not an error", async ({
    page,
  }) => {
    // PARKED — the committed fixture's own state. The screen is about the review now, not the run, and a
    // readout here would be chrome competing with the thing the reviewer came for.
    await gotoGate(page);
    await expect(page.getByRole("heading", { level: 1, name: "Concept groups" })).toBeVisible();
    await expect(page.locator("[data-testid='run-progress']")).toHaveCount(0);

    for (const status of ["complete", "error", "cancelled"]) {
      await withPayload(page, (p) => Object.assign(p, { status, phase: status }));
      await gotoGate(page);
      await expect(page.locator("[data-testid='run-progress']"), status).toHaveCount(0);
    }
  });

  test("@gates the progress readout is wired ONCE, in the shell, so every screen inherits it", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const { dirname, resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = dirname(fileURLToPath(import.meta.url));

    const dirs = [resolve(here, "../../src/components/gate"), resolve(here, "../../src/pages/run")];
    const placements: string[] = [];
    const rederived: string[] = [];
    for (const dir of dirs) {
      for (const f of readdirSync(dir).filter((x) => x.endsWith(".tsx"))) {
        if (f === "RunProgress.tsx") continue; // the component's own definition, not a placement
        const src = readFileSync(resolve(dir, f), "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, " ")
          .replace(/^\s*\/\/.*$/gm, " ");
        for (const _ of src.matchAll(/<RunProgress\b/g)) placements.push(f);
        // A gate page computing its own percentage or its own elapsed figure is the duplication this
        // placement exists to prevent — four disagreeing copies of the in-flight predicate is what that
        // cost last time (see lib/run-state.ts).
        if (/function phasePercent|updatedAt\s*-\s*.*createdAt/.test(src)) rederived.push(f);
      }
    }
    expect(placements, "one placement, in the shell — every screen inherits it").toEqual(["GateShell.tsx"]);
    expect(rederived, "no gate screen may re-derive progress or elapsed").toEqual([]);
  });
});

/**
 * The collapsible chrome sidebar (08-16c Task 5).
 *
 * Bhargav: *"make the UI sidebar collapsible so we have more space to work with."* The aside is a fixed
 * `w-60` — 240px off every screen, including the two widest surfaces this phase has built.
 */
test.describe("app nav collapse", () => {
  const NAV = "[data-testid='app-nav']";
  const TOGGLE = "[data-testid='app-nav-toggle']";

  test("@gates collapsing the nav gives the width to the content", async ({ page }) => {
    await page.goto(`/run/${PAUSED_JOB}/gate1`);
    await page.waitForLoadState("networkidle");
    const nav = page.locator(NAV);
    await expect(nav).toHaveAttribute("data-collapsed", "false");
    const wide = (await nav.boundingBox())!.width;
    const contentWide = (await page.locator("main").boundingBox())!.width;

    await page.locator(TOGGLE).click();
    await expect(nav).toHaveAttribute("data-collapsed", "true");
    const narrow = (await nav.boundingBox())!.width;
    const contentNarrow = (await page.locator("main").boundingBox())!.width;

    expect(narrow).toBeLessThan(wide);
    // The freed width goes to the content rather than to empty space.
    expect(contentNarrow).toBeGreaterThan(contentWide);
    expect(contentNarrow - contentWide).toBeCloseTo(wide - narrow, 0);
  });

  test("@gates collapsing hides labels but removes no destination", async ({ page }) => {
    await page.goto("/jobs");
    await page.waitForLoadState("networkidle");
    const links = page.locator(`${NAV} nav a`);
    const before = await links.count();
    await page.locator(TOGGLE).click();
    await expect(page.locator(NAV)).toHaveAttribute("data-collapsed", "true");
    expect(await links.count()).toBe(before);
    // Every one still names itself, so the rail is navigable and announceable without its labels.
    for (let i = 0; i < before; i++) {
      expect(await links.nth(i).getAttribute("aria-label")).toBeTruthy();
    }
  });

  test("@gates the current page is still identifiable with the labels gone", async ({ page }) => {
    await page.goto("/jobs");
    await page.waitForLoadState("networkidle");
    await page.locator(TOGGLE).click();
    await expect(page.locator(`${NAV} a[data-nav-active='true']`)).toHaveCount(1);
    expect(await page.locator(`${NAV} a[data-nav-active='true']`).getAttribute("aria-label")).toBe("Runs");
  });

  test("@gates the choice survives a move to another page and a reload", async ({ page }) => {
    await page.goto("/jobs");
    await page.waitForLoadState("networkidle");
    await page.locator(TOGGLE).click();
    await expect(page.locator(NAV)).toHaveAttribute("data-collapsed", "true");

    await page.goto("/methods");
    await page.waitForLoadState("networkidle");
    await expect(page.locator(NAV)).toHaveAttribute("data-collapsed", "true");

    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(page.locator(NAV)).toHaveAttribute("data-collapsed", "true");

    // Restore, so this spec leaves no state behind for the next one.
    await page.locator(TOGGLE).click();
    await expect(page.locator(NAV)).toHaveAttribute("data-collapsed", "false");
  });

  test("@gates the toggle states which ACTION it performs, not merely its state", async ({ page }) => {
    await page.goto("/jobs");
    await page.waitForLoadState("networkidle");
    const toggle = page.locator(TOGGLE);
    await expect(toggle).toHaveAttribute("aria-label", "Collapse navigation");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-label", "Expand navigation");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click();
  });

  test("@gates below the lg breakpoint the nav is hidden and the toggle takes no space", async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 900 });
    await page.goto("/jobs");
    await page.waitForLoadState("networkidle");
    // The control lives INSIDE the aside, so it disappears with it rather than floating over the content.
    await expect(page.locator(NAV)).toBeHidden();
    await expect(page.locator(TOGGLE)).toBeHidden();
  });
});

/**
 * The rail navigates backwards, and a passed gate is a record (08-16c Task 2).
 *
 * The fixture run is parked at GATE 1, so Setup is behind it and Gates 2-4 are ahead — which makes this
 * one page enough to exercise all three rail states.
 */
test.describe("rail navigation and frozen gates", () => {
  test("@gates a gate the run has passed is a link back to it", async ({ page }) => {
    await page.goto(`/run/${PAUSED_JOB}/gate1`);
    await page.waitForLoadState("networkidle");
    const back = page.locator("[data-testid='rail-link-setup']");
    await expect(back).toBeVisible();
    // It names its destination rather than announcing itself as "link".
    expect(await back.getAttribute("aria-label")).toMatch(/Back to Set up/i);
    await back.click();
    await expect(page).toHaveURL(new RegExp(`/run/${PAUSED_JOB}/setup$`));
  });

  test("@gates a gate the run has NOT reached is visibly unreachable, not silently inert", async ({ page }) => {
    await page.goto(`/run/${PAUSED_JOB}/gate1`);
    await page.waitForLoadState("networkidle");
    for (const gate of ["gate2", "gate3", "gate4"]) {
      const ahead = page.locator(`[data-testid='rail-ahead-${gate}']`);
      await expect(ahead, gate).toBeVisible();
      await expect(ahead).toHaveAttribute("aria-disabled", "true");
      // Says WHY, rather than being a dead click.
      expect(await ahead.getAttribute("title")).toMatch(/has not reached this gate/i);
      // And it is not a link at all.
      await expect(page.locator(`[data-testid='rail-link-${gate}']`)).toHaveCount(0);
    }
  });

  test("@gates the current gate is neither a link nor marked unreachable", async ({ page }) => {
    await page.goto(`/run/${PAUSED_JOB}/gate1`);
    await page.waitForLoadState("networkidle");
    await expect(page.locator("[data-testid='rail-link-gate1']")).toHaveCount(0);
    await expect(page.locator("[data-testid='rail-ahead-gate1']")).toHaveCount(0);
    await expect(page.locator("[data-gate='gate1'][data-state='current']")).toHaveCount(1);
    // And it is not frozen — the current gate behaves exactly as it does today.
    await expect(page.locator("[data-testid='gate-frozen']")).toHaveCount(0);
  });

  test("@gates a passed gate says it is a record and offers the way back", async ({ page }) => {
    await page.goto(`/run/${PAUSED_JOB}/setup`);
    await page.waitForLoadState("networkidle");
    const frozen = page.locator("[data-testid='gate-frozen']");
    await expect(frozen).toBeVisible();
    await expect(frozen).toContainText(/moved on from here/i);
    // A reviewer must never be stranded in the past.
    const back = page.locator("[data-testid='gate-frozen-back']");
    await expect(back).toContainText(/Concept groups/i);
    await back.click();
    await expect(page).toHaveURL(new RegExp(`/run/${PAUSED_JOB}/gate1$`));
  });

  test("@gates from a passed gate, the gate the run is ON is still reachable", async ({ page }) => {
    // The reviewer clicked back to Setup; Gate 1 must remain a live destination, or looking back is a
    // one-way trip. This is why the rail asks the RUN's position, not the screen's.
    await page.goto(`/run/${PAUSED_JOB}/setup`);
    await page.waitForLoadState("networkidle");
    await expect(page.locator("[data-testid='rail-link-gate1']")).toBeVisible();
    await expect(page.locator("[data-testid='rail-ahead-gate2']")).toBeVisible();
  });

  /**
   * WHAT "FROZEN" ACTUALLY GUARANTEES, stated precisely rather than as a blanket claim.
   *
   * On a past SETUP the run-configuration controls stay interactive, and that is correct: in the `past`
   * stage the screen offers no submit path at all, so they drive nothing but the local cost read-out
   * beside them. Nothing there can change the run. The freeze that is ENFORCED is on gate DECISIONS,
   * which refuse at the write path — see the gate1 case below.
   */
  test("@gates a frozen Setup is a read-back: the parameters are visible and nothing commits", async ({ page }) => {
    await page.goto(`/run/${PAUSED_JOB}/setup`);
    await page.waitForLoadState("networkidle");
    // The run's parameters are exactly what the reviewer came back to read.
    await expect(page.getByTestId("cde-set")).toBeVisible();
    // ...and the screen offers no way to commit anything: no Start, no first-charge control.
    await expect(page.getByTestId("start-run")).toHaveCount(0);
    await expect(page.getByTestId("gate-frozen")).toBeVisible();
  });
});
