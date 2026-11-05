import { expect, test, type Page } from "@playwright/test";
import { decisionItemKey, optionSetKey, type GateDecision } from "@/lib/gate-decisions";
import {
  GATE_CONFLICT_EVENT,
  absorbServedRows,
  conflictForJob,
  seedBases,
  splitServedRows,
  writeAgainstBase,
  type GateConflictDetail,
} from "@/lib/gate-conflicts";
import type { ArtifactWriteResponse } from "@/types";
import { FINISHED_JOB, PAUSED_JOB, serveFinished } from "./gate23-fixture";

/**
 * Two tabs on one run (08-28 3f, audit Theme C "two-tab conflicts silent").
 *
 * The store already REPORTED a write against a stale base, but nothing showed it, and the first save after every
 * reload was reported as a conflict because the read served no version to send back. So there are three links,
 * and each is asserted where it can be seen:
 *
 *  1. the SERVER's rule — two writers with one base, the second is the conflict: `tests/test_artifacts.py`
 *     (`test_two_tabs_seeded_from_the_same_read_the_second_save_is_the_conflict`, through the real route);
 *  2. the CLIENT's write path — a base seeded from the read, carried write to write, a conflict response turned
 *     into the notice's detail: here, in Node, against a store that applies the same rule (the hook cannot be
 *     imported outside a bundle, so its write path is `lib/gate-conflicts.ts` and the hook calls it);
 *  3. the NOTICE — every gate screen shows it with Reload / Keep mine: here, in the browser. The static build is
 *     backend-less, so no write in it can come back conflicted; the notice is driven through the same window
 *     event the hook announces on.
 *
 *   run: npm run test:e2e -- --grep "@conflict"
 */

const KIND = "gate2_candidate_pick" as const;
const MESSAGE =
  "Another tab changed this run. Your last change was kept and theirs was applied on top. Reload to see the current state.";

function pick(groupId: string, chosen: string): GateDecision {
  const alternatives = ["CDE:1", "CDE:2"];
  return { groupId, chosen, alternatives, optionSetKey: optionSetKey(alternatives) };
}

/**
 * A store that applies the backend's conflict rule (`backend/app.py::_conflict_for`): a write over an existing row
 * is quiet only when it names the version stored. The rule itself is pinned server-side; this is the client's
 * counterpart, so the CLIENT's half — seeding and carrying the base — is what is under test.
 */
function fakeStore() {
  const rows = new Map<string, { payload: GateDecision; updatedAt: number }>();
  let clock = 1_790_000_000.25;
  return {
    list(): Record<string, unknown> {
      return { [KIND]: [...rows.values()].map((r) => ({ ...r.payload, updatedAt: r.updatedAt })) };
    },
    async put(payload: GateDecision, base: number | undefined): Promise<ArtifactWriteResponse> {
      const itemKey = decisionItemKey(KIND, payload);
      const prior = rows.get(itemKey);
      const conflict =
        prior && prior.updatedAt !== base ? { replacedUpdatedAt: prior.updatedAt, message: MESSAGE } : null;
      clock += 1.5;
      rows.set(itemKey, { payload, updatedAt: clock });
      return { kind: KIND, itemKey, updatedAt: clock, conflict };
    },
  };
}

/** One tab: loads the page (one read), then saves through the client's write path. */
function tab(store: ReturnType<typeof fakeStore>) {
  const { versions } = splitServedRows(store.list());
  const bases = seedBases({}, versions[KIND]);
  return {
    save: (d: GateDecision) =>
      writeAgainstBase((p, b) => store.put(p, b), bases, decisionItemKey(KIND, d), d, { kind: KIND }),
  };
}

test.describe("two tabs on one run — the client's write path", () => {
  test("@conflict a served row's version is split off its payload, and seeds the base", () => {
    const { rows, versions } = splitServedRows({
      [KIND]: [{ ...pick("g1", "CDE:1"), updatedAt: 1_790_000_100.5 }],
      composite: [{ definition: { name: "Fried" }, updatedAt: 7 }],
    });
    // The version is the ROW's, not a decision field: a payload that kept it would be written back inside the
    // next save's body and hashed into nothing, but it would still be a second answer to "which version".
    expect(rows[KIND]).toEqual([pick("g1", "CDE:1")]);
    expect(versions[KIND]).toEqual({ g1: 1_790_000_100.5 });
    // A kind that is not a gate decision passes through untouched — it has no identity rule here to key on.
    expect(rows.composite).toEqual([{ definition: { name: "Fried" }, updatedAt: 7 }]);
  });

  test("@conflict a base this tab already holds is never replaced by an older read", () => {
    // A save made before the read landed returned a NEWER version than the read served; replacing it with the read's
    // would make this tab's own next save look like a conflict.
    expect(seedBases({ g1: 200 }, { g1: 100, g2: 50 })).toEqual({ g1: 200, g2: 50 });
    expect(seedBases({ g1: 200 }, undefined)).toEqual({ g1: 200 });
  });

  test("@conflict the first save after a reload is quiet — the false conflict is gone", async () => {
    const store = fakeStore();
    await tab(store).save(pick("g1", "CDE:1"));
    // Reload = a new tab state seeded from a fresh read. Before the read served versions, this save was BLIND and
    // reported a conflict nobody had caused.
    expect(await tab(store).save(pick("g1", "CDE:2"))).toBeNull();
  });

  test("@conflict two writers seeded from the same read: the second save is the conflict", async () => {
    const store = fakeStore();
    await tab(store).save(pick("g1", "CDE:1"));
    const a = tab(store);
    const b = tab(store);
    expect(await a.save(pick("g1", "CDE:2"))).toBeNull();
    const conflict = await b.save(pick("g1", "CDE:1"));
    expect(conflict).not.toBeNull();
    expect(conflict).toMatchObject({ message: MESSAGE, sentBase: true, kind: KIND, itemKey: "g1" });
    // And the tab that was told keeps saving quietly: it now holds the version its own save produced.
    expect(await b.save(pick("g1", "CDE:2"))).toBeNull();
  });

  test("@conflict a save over a decision this tab never loaded is reported as blind", async () => {
    const store = fakeStore();
    const early = tab(store); // loaded before anyone had decided g1
    await tab(store).save(pick("g1", "CDE:1")); // another tab decides it
    const conflict = await early.save(pick("g1", "CDE:2"));
    expect(conflict).toMatchObject({ sentBase: false });
  });

  test("@conflict rows the SERVER wrote for this tab are absorbed with their versions, so the next save is quiet", async () => {
    // An accepted division is written server-side (the paid re-split and its decisions are one request) and the
    // rows come back. A tab that did not take their versions would save over them BLIND and raise a conflict
    // nobody caused — the reviewer's own accept, reported as another tab's work.
    const store = fakeStore();
    const t = tab(store); // loaded before the server wrote anything
    const written = await store.put(pick("g1", "CDE:1"), undefined); // the server's write on this tab's behalf
    const served = [{ ...pick("g1", "CDE:1"), updatedAt: written.updatedAt }];
    const { payloads, versions } = absorbServedRows(KIND, served);
    expect(payloads).toEqual({ g1: pick("g1", "CDE:1") }); // the version is not a decision field
    expect(versions).toEqual({ g1: written.updatedAt });
    const bases = { ...versions };
    const next = await writeAgainstBase((p, b) => store.put(p, b), bases, "g1", pick("g1", "CDE:2"), { kind: KIND });
    expect(next).toBeNull();
    // ...and without absorbing, the same save is the false alarm this prevents.
    expect(await t.save(pick("g1", "CDE:1"))).toMatchObject({ sentBase: false });
  });

  test("@conflict the notice only answers to its own run", () => {
    const detail: GateConflictDetail = { jobId: "run-a", replacedUpdatedAt: 1, message: MESSAGE, sentBase: true };
    expect(conflictForJob({ detail }, "run-a")).toEqual(detail);
    expect(conflictForJob({ detail }, "run-b")).toBeNull();
    expect(conflictForJob({ detail: null }, "run-a")).toBeNull();
    expect(conflictForJob({}, "run-a")).toBeNull();
  });

  test("@conflict the notice is placed ONCE, in the shell, and the hook writes through the shared path", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const { dirname, resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = dirname(fileURLToPath(import.meta.url));
    const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

    const placements: string[] = [];
    for (const dir of [resolve(here, "../../src/components/gate"), resolve(here, "../../src/pages/run")]) {
      for (const f of readdirSync(dir).filter((x) => x.endsWith(".tsx"))) {
        const src = strip(readFileSync(resolve(dir, f), "utf8"));
        for (const _ of src.matchAll(/<ConflictNotice\b/g)) placements.push(f);
      }
    }
    // Every gate screen renders inside GateShell, so one placement there is every screen — the same rule as the
    // stop control and the progress readout.
    expect(placements).toEqual(["GateShell.tsx"]);

    const hook = strip(readFileSync(resolve(here, "../../src/hooks/use-gate-decisions.ts"), "utf8"));
    expect(hook).toMatch(/writeAgainstBase\(/);
    expect(hook).toMatch(/announceConflict\(/);
    expect(hook).toMatch(/splitServedRows\(/);
  });
});

// --- the notice, in the browser ---------------------------------------------------------------------------

async function announce(page: Page, detail: GateConflictDetail): Promise<void> {
  await page.evaluate(
    ({ name, d }) => window.dispatchEvent(new CustomEvent(name, { detail: d })),
    { name: GATE_CONFLICT_EVENT, d: detail },
  );
}

const SCREENS = [
  { gate: "gate1", job: PAUSED_JOB },
  { gate: "gate2", job: FINISHED_JOB },
  { gate: "gate3", job: FINISHED_JOB },
  { gate: "gate4", job: FINISHED_JOB },
] as const;

test.describe("two tabs on one run — the notice", () => {
  for (const { gate, job } of SCREENS) {
    test(`@conflict ${gate} shows a two-tab conflict with Reload and Keep mine`, async ({ page }) => {
      if (job === FINISHED_JOB) await serveFinished(page);
      await page.goto(`/run/${job}/${gate}`);
      await page.waitForLoadState("networkidle");
      const notice = page.locator("[data-testid='gate-conflict']");
      await expect(notice).toHaveCount(0);

      // Another run's conflict is not this screen's.
      await announce(page, { jobId: "some-other-run", replacedUpdatedAt: 1, message: MESSAGE, sentBase: true });
      await expect(notice).toHaveCount(0);

      await announce(page, { jobId: job, replacedUpdatedAt: 1, message: MESSAGE, sentBase: true, kind: KIND });
      await expect(notice).toBeVisible();
      await expect(notice).toHaveAttribute("role", "alert");
      await expect(notice).toContainText(MESSAGE);
      // Visible wherever the reviewer has scrolled: a notice at the top of a long ledger is a notice nobody sees.
      await page.mouse.wheel(0, 4000);
      await expect(notice).toBeInViewport();
      await expect(notice.getByRole("button", { name: "Reload" })).toBeVisible();

      // Keep mine: the save stands (last write wins), and the notice goes.
      await notice.getByRole("button", { name: "Keep mine" }).click();
      await expect(notice).toHaveCount(0);
    });
  }

  test("@conflict a second conflict before the first is resolved says how many saves it covers", async ({ page }) => {
    await serveFinished(page);
    await page.goto(`/run/${FINISHED_JOB}/gate2`);
    await page.waitForLoadState("networkidle");
    const d = { jobId: FINISHED_JOB, replacedUpdatedAt: 1, message: MESSAGE, sentBase: true };
    await announce(page, d);
    await announce(page, { ...d, replacedUpdatedAt: 2 });
    await expect(page.locator("[data-testid='gate-conflict']")).toContainText("2 of your saves");
  });

  test("@conflict Reload reloads the page, and the reloaded screen starts clean", async ({ page }) => {
    await serveFinished(page);
    await page.goto(`/run/${FINISHED_JOB}/gate3`);
    await page.waitForLoadState("networkidle");
    await page.evaluate(() => ((window as unknown as { __beforeReload?: boolean }).__beforeReload = true));
    await announce(page, { jobId: FINISHED_JOB, replacedUpdatedAt: 1, message: MESSAGE, sentBase: true });
    const notice = page.locator("[data-testid='gate-conflict']");
    await Promise.all([page.waitForEvent("load"), notice.getByRole("button", { name: "Reload" }).click()]);
    await page.waitForLoadState("networkidle");
    expect(await page.evaluate(() => (window as unknown as { __beforeReload?: boolean }).__beforeReload)).toBeUndefined();
    await expect(notice).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe(`/run/${FINISHED_JOB}/gate3`);
  });
});
