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

/** Group ids, in render order, as the page reports them. The identity the reload has to preserve. */
async function conceptGroupIds(page: import("@playwright/test").Page): Promise<string[]> {
  const rows = page.locator("[data-testid='concept-group']");
  await expect(rows.first()).toBeVisible();
  return rows.evaluateAll((els) => els.map((el) => el.getAttribute("data-group-id") ?? ""));
}

test.describe("staged review", () => {
  test("@gates the reviewer can resume at gate 1 with the same concept groups after a reload", async ({ page }) => {
    await page.goto(`/run/${PAUSED_JOB}/gate1`);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForLoadState("networkidle");

    // The screen is Gate 1, and it says so to assistive technology as well as visually.
    await expect(page.getByRole("heading", { level: 1, name: "Concept groups" })).toBeVisible();
    const rail = page.locator("[data-testid='gate-rail'] > li");
    await expect(rail).toHaveCount(6);
    await expect(page.locator("[data-testid='gate-rail'] li[aria-current='step']")).toHaveAttribute(
      "data-gate",
      "gate1",
    );

    // Rows are POST-SPLIT CONCEPT GROUPS, each carrying its parent cluster as provenance and its
    // generated name marked as generated — no catalog badge, no identifier link, no endorsement.
    const before = await conceptGroupIds(page);
    expect(before.length).toBeGreaterThan(0);
    await expect(page.locator("[data-testid='concept-group']").first().getByText("generated")).toBeVisible();
    await expect(page.locator("[data-testid='concept-group']").first()).toContainText("from cluster");

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
    // and saying plainly when money starts being spent. The honest answer since §0.1 is Gate 0's Continue.
    const toggle = page.getByRole("button", { name: /how to use this screen/i });
    await expect(toggle).toBeVisible();
    await toggle.click();
    await expect(page.getByText(/already charged at Gate 0/i)).toBeVisible();
  });
});

/**
 * The routing shell and the universal chrome, asserted across all six screens.
 *
 *   run: npm run test:e2e -- --grep "six gates"
 */
const GATES = ["setup", "gate0", "gate1", "gate2", "gate3", "gate4"] as const;

test.describe("six gates", () => {
  for (const [i, gate] of GATES.entries()) {
    test(`@gates six gates — ${gate} resolves and renders the universal chrome`, async ({ page }) => {
      await page.goto(`/run/${PAUSED_JOB}/${gate}`);
      await page.waitForLoadState("networkidle");

      // Resolves: NOT the 404 fallback, which is the only other thing a `/run/...` path could hit.
      await expect(page.getByText("404 — page not found")).toHaveCount(0);

      // (2) Masthead: an eyebrow, a display h1 and a subhead — on every screen, not just the built one.
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

      // (3) The rail is SIX columns on every screen, and marks THIS gate for assistive technology. Six
      // regardless of how many gates are behind the reviewer: a rail that shortens as gates complete makes
      // the reviewer's position mean something different on every screen.
      const rail = page.locator("[data-testid='gate-rail'] > li");
      await expect(rail).toHaveCount(6);
      const current = page.locator("[data-testid='gate-rail'] li[aria-current='step']");
      await expect(current).toHaveCount(1);
      await expect(current).toHaveAttribute("data-gate", gate);
      // Every column carries its own cost-or-state string; none is blank.
      for (let c = 0; c < 6; c++) {
        await expect(rail.nth(c).locator("[data-cost]")).not.toBeEmpty();
      }
      // Completed gates render distinctly — `data-state` covers 0..6 completed without the rail changing
      // length. Exactly `i` columns are behind this one.
      await expect(page.locator("[data-testid='gate-rail'] li[data-state='done']")).toHaveCount(i);
      await expect(page.locator("[data-testid='gate-rail'] li[data-state='ahead']")).toHaveCount(5 - i);

      // (4) The how-to panel is present on every screen.
      await expect(page.getByRole("button", { name: /how to use this screen/i })).toBeVisible();
    });
  }

  test("@gates six gates — a passed gate reads as realized while a future one reads as a forecast", async ({
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

  test("@gates six gates — every icon-only control in the chrome has an accessible name", async ({ page }) => {
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

  test("@gates six gates — the chrome renders no run chip when there is no run", async ({ page }) => {
    // A job id with no fixture: `getResult` 404s, so the hook never produces a job. The chip must be
    // ABSENT, not empty — an empty chip reads as a run with no name.
    await page.goto("/run/no-such-run/gate1");
    await page.waitForLoadState("networkidle");
    await expect(page.locator("[data-testid='run-chip']")).toHaveCount(0);
    // The chrome itself still renders, so the screen is never a blank page.
    await expect(page.locator("[data-testid='gate-rail'] > li")).toHaveCount(6);
  });

  test("@gates six gates — a long run name is clamped and the app bar height never reflows", async ({ page }) => {
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
});
