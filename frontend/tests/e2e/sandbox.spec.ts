import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { GATE_DECISION_KINDS, optionSetKey, type GateDecision } from "@/lib/gate-decisions";
import { RAIL_SEQUENCE, nextRailGate, railReachOf } from "@/lib/gate-routes";
import type { JobResult } from "@/types";
import { FINISHED_JOB, PAUSED_JOB, finishedFixture, pausedFixture } from "./gate23-fixture";
import {
  DEMO_CONTINUE_NOTE,
  SANDBOX_BANNER_COPY,
  SANDBOX_PREFIX,
  cloneRequestFor,
  clonedPathFor,
  guestAuthCopy,
  hasSandboxWork,
  readSandbox,
  sandboxArtifactsOf,
  sandboxJobsWithWork,
  sandboxStateFrom,
  sandboxWorkCount,
  signInCloneOffer,
  uniqueCloneName,
  withGateDecision,
  writeSandbox,
  clearSandbox,
  type SandboxState,
} from "@/lib/sandbox";

/**
 * The guest sandbox across every gate (08-18, STGD-09 / R9).
 *
 * A guest walks the shared demo with every control live, and none of it may reach the server: the demo is ONE row
 * every visitor sees. Their work lives in this tab (sessionStorage) and is kept only by an explicit clone, which
 * posts the edits the browser has been holding all along. So the failure this suite exists to catch is the quiet
 * one — a decision kind the clone projection does not carry is guest work lost at sign-in with no error anywhere.
 *
 * WHAT RUNS WHERE, and why. The projection, the clone request, the collision rule and the sign-in decision are
 * pure (`lib/sandbox.ts`) and asserted here in Node, because `frontend/` has no component test runner and the
 * sign-in half cannot be driven in a browser at all: the static build has no Clerk, so "a guest signs in" is not
 * a state it can reach. The browser half is what only a browser can answer: the banner on every screen, the walk
 * with zero write requests, a refresh vs a new tab, storage that throws or is cleared, and the dialog itself.
 *
 *   run: npm run test:e2e -- --grep "guest sandbox"
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");

/** A decision the named kind's identity rule accepts — built from nothing but the kind's name. */
function decisionFor(kind: string): GateDecision {
  const alternatives = ["x", "y"];
  return {
    groupId: "rev:guest-1",
    memberId: "AoU:age",
    targetId: "CDE:9",
    sourceVariable: "AoU:age",
    cohort: "AoU",
    recordId: "r1",
    scoreName: "Fried",
    componentName: "grip",
    name: "My group",
    chosen: "x",
    alternatives,
    optionSetKey: optionSetKey(alternatives),
    note: `a ${kind} decision`,
  };
}

/**
 * The backend's own list of gate-decision kinds, read out of `backend/artifact_kinds.py` — NOT the frontend's
 * mirror. The projection is only proven complete against the registry the server validates with; checking it
 * against the frontend constant would pass the day a kind is added to the backend and nowhere else.
 */
function backendGateDecisionKinds(): string[] {
  const src = readFileSync(resolve(REPO, "backend/artifact_kinds.py"), "utf8");
  const constants = new Map([...src.matchAll(/^([A-Z0-9_]+) = "([a-z0-9_]+)"$/gm)].map((m) => [m[1], m[2]]));
  const tuple = src.match(/^GATE_DECISION_KINDS = \(([\s\S]*?)\n\)/m);
  if (!tuple) throw new Error("GATE_DECISION_KINDS not found in backend/artifact_kinds.py");
  return tuple[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((name) => {
      const value = constants.get(name);
      if (!value) throw new Error(`${name} has no string definition in artifact_kinds.py`);
      return value;
    });
}

/** A minimal Storage, so the storage-backed helpers can be exercised in Node. */
function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k) => (data.has(k) ? data.get(k)! : null),
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => void data.set(k, String(v)),
  };
}

/** A Storage that behaves like private-mode Safari or a full quota: every access throws. */
function throwingStorage(): Storage {
  const boom = () => {
    throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
  };
  return { length: 0, clear: boom, getItem: boom, key: boom, removeItem: boom, setItem: boom };
}

function withStorage<T>(storage: Storage, fn: () => T): T {
  const g = globalThis as { sessionStorage?: Storage };
  const prior = g.sessionStorage;
  g.sessionStorage = storage;
  try {
    return fn();
  } finally {
    if (prior === undefined) delete g.sessionStorage;
    else g.sessionStorage = prior;
  }
}

// --- the projection: nothing held in the tab is lost at sign-in ------------------------------------------------

test.describe("guest sandbox — the clone projection", () => {
  test("@sandbox the frontend's kind list is the backend registry's, so the projection is checked against the real one", () => {
    expect([...GATE_DECISION_KINDS].sort()).toEqual(backendGateDecisionKinds().sort());
  });

  test("@sandbox every registered gate-decision kind held in the tab is in the projection, payload unchanged", () => {
    // Generic over the REGISTRY, not a hand-list: a kind added later (gate2_relation was, mid-phase) is covered
    // the moment it is registered, and a projection that silently skipped one fails here naming it.
    const kinds = backendGateDecisionKinds();
    let state: SandboxState = {};
    for (const kind of kinds) state = withGateDecision(state, kind, `${kind}-item`, decisionFor(kind));

    const projected = sandboxArtifactsOf(state);
    for (const kind of kinds) {
      const carried = projected.filter((a) => a.kind === kind);
      expect(carried, `${kind} is missing from the clone projection`).toHaveLength(1);
      expect(carried[0].payload).toEqual(decisionFor(kind));
    }
    expect(projected).toHaveLength(kinds.length);
    expect(sandboxWorkCount(state)).toBe(kinds.length);
  });

  test("@sandbox several decisions of one kind are each carried, and a cleared one is not", () => {
    let state: SandboxState = {};
    state = withGateDecision(state, "gate1_regroup", "AoU:a", { ...decisionFor("gate1_regroup"), memberId: "AoU:a" });
    state = withGateDecision(state, "gate1_regroup", "AoU:b", { ...decisionFor("gate1_regroup"), memberId: "AoU:b" });
    state = withGateDecision(state, "gate1_regroup", "AoU:a", null);
    const carried = sandboxArtifactsOf(state).map((a) => a.payload.memberId);
    expect(carried).toEqual(["AoU:b"]);
  });

  test("@sandbox the workbench's verdicts ride the same projection as the gates' decisions", () => {
    const state: SandboxState = {
      decisions: { "c1#g0": "approve" },
      transformDecisions: { "c1#g0:AoU:age": "reject" },
      gencdeDecisions: { "c2#g0": "refine" },
      notes: { "c1#g0": "checked" },
      gateDecisions: { gate2_candidate_pick: { "c1#g0": decisionFor("gate2_candidate_pick") } },
    };
    const projected = sandboxArtifactsOf(state);
    expect(projected).toContainEqual({
      kind: "verdict",
      payload: { recordId: "c1#g0", axis: "match", decision: "approve", note: "checked" },
    });
    // split on the FIRST colon only: a source variable is itself "cohort:var"
    expect(projected).toContainEqual({
      kind: "verdict",
      payload: { recordId: "c1#g0", axis: "transform", sourceVariable: "AoU:age", decision: "reject", note: "" },
    });
    expect(projected).toContainEqual({
      kind: "verdict",
      payload: { recordId: "c2#g0", axis: "gencde", decision: "refine", note: "" },
    });
    expect(projected.filter((a) => a.kind === "gate2_candidate_pick")).toHaveLength(1);
    // a note alone is not work: it rides a verdict, it is not one
    expect(sandboxWorkCount(state)).toBe(4);
    expect(sandboxWorkCount({ notes: { x: "a note" } })).toBe(0);
  });
});

// --- the store is best-effort: a missing, corrupt, cleared or throwing store is a normal state ----------------

test.describe("guest sandbox — best-effort storage", () => {
  test("@sandbox a missing, empty or corrupt entry reads as an empty sandbox, never an exception", () => {
    for (const raw of [null, "", "not json", "null", "[]", "42", '"text"']) {
      expect(sandboxStateFrom(raw), `raw=${raw}`).toEqual({});
    }
    // A wrong-shaped gate section is dropped rather than handed to the hook, whose first read would throw on it.
    expect(sandboxStateFrom('{"gateDecisions": 5}')).toEqual({});
    expect(sandboxStateFrom('{"gateDecisions": {"gate1_rename": [1, 2]}}')).toEqual({ gateDecisions: {} });
    const kept = sandboxStateFrom(
      JSON.stringify({
        decisions: { r1: "approve" },
        gateDecisions: { gate1_rename: { g1: { groupId: "g1", chosen: "Mine" }, bad: "nope" } },
      }),
    );
    expect(kept).toEqual({
      decisions: { r1: "approve" },
      gateDecisions: { gate1_rename: { g1: { groupId: "g1", chosen: "Mine" } } },
    });
  });

  test("@sandbox storage that throws on every access costs the guest their doodle, never the page", () => {
    withStorage(throwingStorage(), () => {
      expect(() => writeSandbox("demo-1", { decisions: { r1: "approve" } })).not.toThrow();
      expect(() => clearSandbox("demo-1")).not.toThrow();
      expect(readSandbox("demo-1")).toEqual({});
      expect(hasSandboxWork("demo-1")).toBe(false);
      expect(sandboxJobsWithWork()).toEqual([]);
    });
  });

  test("@sandbox storage cleared mid-walk continues from empty, and the next edit is held on its own", () => {
    withStorage(memoryStorage(), () => {
      writeSandbox("demo-1", withGateDecision({}, "gate1_rename", "g1", decisionFor("gate1_rename")));
      expect(hasSandboxWork("demo-1")).toBe(true);
      sessionStorage.clear(); // the visitor cleared site data, or the browser evicted it
      expect(readSandbox("demo-1")).toEqual({});
      expect(sandboxJobsWithWork()).toEqual([]);
      writeSandbox("demo-1", withGateDecision(readSandbox("demo-1"), "gate2_candidate_pick", "g1", decisionFor("x")));
      expect(sandboxJobsWithWork()).toEqual([{ jobId: "demo-1", count: 1 }]);
    });
  });

  test("@sandbox the runs holding work are found by the storage prefix, and only those with work", () => {
    withStorage(memoryStorage(), () => {
      writeSandbox("demo-a", withGateDecision({}, "gate1_rename", "g1", decisionFor("gate1_rename")));
      writeSandbox("demo-b", { notes: { r1: "a note, not work" } });
      let many: SandboxState = {};
      for (const k of ["a", "b", "c"]) many = withGateDecision(many, "gate1_regroup", k, decisionFor(k));
      writeSandbox("demo-c", many);
      sessionStorage.setItem("ddharmon.somethingElse", "{}");
      expect(sandboxJobsWithWork()).toEqual([
        { jobId: "demo-c", count: 3 },
        { jobId: "demo-a", count: 1 },
      ]);
      expect(SANDBOX_PREFIX).toBe("ddharmon.sandbox.");
    });
  });
});

// --- the clone: both flavours, explicit, and a name collision resolved in the open ---------------------------

test.describe("guest sandbox — the clone request", () => {
  const held = withGateDecision({}, "gate1_rename", "g1", decisionFor("gate1_rename"));

  test("@sandbox clone with my changes carries every held edit; clone fresh carries none", () => {
    expect(cloneRequestFor("changes", held, "  My copy  ")).toEqual({
      displayName: "My copy",
      artifacts: sandboxArtifactsOf(held),
    });
    expect(cloneRequestFor("fresh", held, "My copy")).toEqual({ displayName: "My copy", artifacts: [] });
  });

  test("@sandbox a default clone name that collides with one of your runs is resolved visibly, not silently", () => {
    const demo = "Demo · AI-READI + AoU";
    expect(uniqueCloneName(demo, ["Something else"])).toEqual({
      name: `${demo} (my copy)`,
      collided: false,
      taken: null,
    });
    // The collision is REPORTED (so the dialog can say so) and the proposal is the next free name.
    expect(uniqueCloneName(demo, [`${demo} (my copy)`])).toEqual({
      name: `${demo} (my copy 2)`,
      collided: true,
      taken: `${demo} (my copy)`,
    });
    expect(uniqueCloneName(demo, [`  ${demo.toUpperCase()} (MY COPY) `, `${demo} (my copy 2)`]).name).toBe(
      `${demo} (my copy 3)`,
    );
  });

  test("@sandbox after a clone the reviewer lands on the same screen of their own copy", () => {
    expect(clonedPathFor("/run/demo-1/gate2", "demo-1", "abc")).toBe("/run/abc/gate2");
    expect(clonedPathFor("/job/demo-1/workbench", "demo-1", "abc")).toBe("/job/abc/workbench");
    expect(clonedPathFor("/", "demo-1", "abc")).toBe("/job/abc");
    expect(clonedPathFor("/run/other/gate2", "demo-1", "abc")).toBe("/job/abc");
  });

  test("@sandbox no implicit fork-on-write: a clone is only ever requested from the two explicit clone controls", () => {
    // The explicit clone is the whole reason the sandbox can promise that nothing is saved. A write path that
    // forked the demo on the reviewer's behalf would make that promise false, so the call sites are pinned.
    const src = resolve(REPO, "frontend/src");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(name)) files.push(p);
      }
    };
    walk(src);
    const callers = files
      .filter((f) => /\bcloneJob\s*\(/.test(readFileSync(f, "utf8").replace(/export async function cloneJob\(/, "")))
      .map((f) => relative(src, f))
      .sort();
    expect(callers).toEqual(["components/demo-banner.tsx", "components/gate/CloneDialog.tsx"]);
    expect(readFileSync(resolve(src, "hooks/use-gate-decisions.ts"), "utf8")).not.toMatch(/clone/i);
  });
});

// --- sign-in: both flavours when there is work, and no prompt at all when there is none -----------------------

test.describe("guest sandbox — the sign-in prompt", () => {
  const demos = new Set(["demo-1", "demo-2"]);
  const base = { authEnabled: true, isAuthed: true, isGuest: false, wasGuest: true, demoJobIds: demos };

  test("@sandbox a guest who signs in holding edits is offered the clone, for the run with the most work", () => {
    expect(
      signInCloneOffer({
        ...base,
        withWork: [
          { jobId: "demo-2", count: 5 },
          { jobId: "demo-1", count: 2 },
        ],
      }),
    ).toEqual({ jobId: "demo-2", count: 5 });
  });

  test("@sandbox a guest who signs in having made no edits gets no clone prompt at all", () => {
    expect(signInCloneOffer({ ...base, withWork: [] })).toBeNull();
  });

  test("@sandbox the prompt is for a sign-in, not for every visit", () => {
    const withWork = [{ jobId: "demo-1", count: 1 }];
    // already signed in when the edits were made — the banner's own controls serve them
    expect(signInCloneOffer({ ...base, wasGuest: false, withWork })).toBeNull();
    // still a guest (or a read-only account, which cannot own a copy)
    expect(signInCloneOffer({ ...base, isGuest: true, withWork })).toBeNull();
    expect(signInCloneOffer({ ...base, isAuthed: false, withWork })).toBeNull();
    // no sign-in exists on this build at all
    expect(signInCloneOffer({ ...base, authEnabled: false, withWork })).toBeNull();
  });

  test("@sandbox work held against a run that is not a demo is never offered as demo work", () => {
    // `writesGoToSandbox` routes an UNKNOWN run to the sandbox on its first render, so a stray entry for a real
    // run can exist. Offering to "clone" it would fork a run the reviewer already owns.
    expect(signInCloneOffer({ ...base, withWork: [{ jobId: "real-run", count: 3 }] })).toBeNull();
  });

  test("@sandbox the auth-gated copy names the one action that needs an account", () => {
    expect(guestAuthCopy("downloading the export")).toEqual({
      title: "Sign in to do this.",
      body: "You can walk every gate on the demo without an account — downloading the export needs one.",
    });
    expect(SANDBOX_BANNER_COPY).toBe(
      "This is the shared demo. Your changes are yours alone, are not saved, and disappear when you close the tab — clone it to keep them.",
    );
  });
});

// --- the walk: every gate of the demo is reachable, and moving forward spends and sends nothing --------------

test.describe("guest sandbox — the walk", () => {
  test("@sandbox a finished run has reached every gate; a parked one has reached only its own", () => {
    // A FINISHED run carries no gate position, and "unknown position" used to read as "reached nothing" — so the
    // finished shared demo, the one every guest sees, drew all four gates as "this run has not reached this gate
    // yet": a false statement, and no way forward. Reachability is about what the run HAS, so complete = all.
    expect(railReachOf({ status: "complete", gatePosition: null })).toBe("gate4");
    expect(railReachOf({ status: "complete" })).toBe("gate4");
    expect(railReachOf({ status: "awaiting_review", gatePosition: "gate2" })).toBe("gate2");
    expect(railReachOf({ status: "running", gatePosition: null })).toBeNull();
    expect(railReachOf(null)).toBeNull();
  });

  test("@sandbox the demo's Continue walks to the next screen on the rail, and Gate 4 is the end", () => {
    expect(RAIL_SEQUENCE.map(nextRailGate)).toEqual(["gate1", "gate2", "gate3", "gate4", null]);
    expect(DEMO_CONTINUE_NOTE).toMatch(/spends nothing/);
  });
});

/**
 * The shared demo, walkable end to end: the FINISHED demo (records, candidates, specs for Gates 2–4) carrying the
 * Gate 1 projection the paused fixture was derived from it with (all 54 of its groups are the finished demo's own
 * group ids — `scripts/build_gate_fixture.py`). Constructed here rather than committed, per the fixture rule in
 * `gate1-fixture.ts`: the prod demo snapshot does not carry the Gate 1 projection yet (08-21 regenerates it), so a
 * committed file claiming it does would describe no run that exists. Records are trimmed to the 54 grouped
 * concepts plus the combine-rule pair so every gate renders quickly.
 */
const PAIR = "c46be33d9a542#g5"; // two AoU variables on one CDE — the one place a combine rule is offered
function walkableDemo(): JobResult {
  const run = finishedFixture();
  const paused = pausedFixture().result!;
  const grouped = new Set((paused.conceptGroups ?? []).map((g) => g.groupId));
  run.result!.records = run.result!.records.filter((r) => grouped.has(r.groupId) || r.groupId === PAIR);
  run.result!.conceptGroups = paused.conceptGroups;
  run.result!.conceptGroupMembers = paused.conceptGroupMembers;
  run.result!.preprocessing = paused.preprocessing;
  return run;
}

async function serveWalkableDemo(page: Page, mutate?: (run: JobResult) => void): Promise<void> {
  await page.route(`**/static-data/result-${FINISHED_JOB}.json`, async (route) => {
    const run = walkableDemo();
    mutate?.(run);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(run) });
  });
}

/** Every request that is not a plain read of the static bundle — what "nothing reached the server" rules out. */
function watchWrites(page: Page): string[] {
  const writes: string[] = [];
  page.on("request", (r) => {
    if (r.method() !== "GET" || r.url().includes("/api/")) writes.push(`${r.method()} ${r.url()}`);
  });
  return writes;
}

async function open(page: Page, gate: string, job = FINISHED_JOB): Promise<void> {
  await page.goto(`/run/${job}/${gate}`);
  await page.waitForLoadState("networkidle");
}

async function heldState(page: Page, job = FINISHED_JOB): Promise<SandboxState> {
  return sandboxStateFrom(await page.evaluate((k) => sessionStorage.getItem(k), `${SANDBOX_PREFIX}${job}`));
}

test.describe("guest sandbox — on screen", () => {
  test("@sandbox guest sandbox: on the finished demo every gate on the rail is a link, from every screen", async ({ page }) => {
    await serveWalkableDemo(page);
    for (const gate of RAIL_SEQUENCE) {
      await open(page, gate);
      for (const other of RAIL_SEQUENCE.filter((g) => g !== gate)) {
        await expect(page.locator(`[data-testid='rail-link-${other}']`), `${gate} → ${other}`).toBeVisible();
        await expect(page.locator(`[data-testid='rail-ahead-${other}']`)).toHaveCount(0);
      }
    }
    // Direction-aware names: a gate ahead is "Go to", not "Back to".
    await open(page, "gate1");
    await expect(page.locator("[data-testid='rail-link-gate3']")).toHaveAttribute("aria-label", /^Go to Gate 3/);
    await expect(page.locator("[data-testid='rail-link-setup']")).toHaveAttribute("aria-label", /^Back to Set up/);
  });

  test("@sandbox guest sandbox: the demo's Continue walks forward without a price and without a request", async ({ page }) => {
    await serveWalkableDemo(page);
    const writes = watchWrites(page);
    await open(page, "gate1");
    await page.locator("[data-testid='ledger-row']").first().locator("[data-testid='queue-scope']").click();
    const bar = page.locator("[data-testid='commit-bar']");
    // No amount on the demo's bar: the press buys nothing, so quoting one would be a false claim.
    await expect(bar).toHaveAttribute("data-total", "");
    await expect(bar).toContainText(DEMO_CONTINUE_NOTE);
    await bar.getByRole("button", { name: /Continue to Gate 2/ }).click();
    await expect(page).toHaveURL(new RegExp(`/run/${FINISHED_JOB}/gate2$`));

    await page.waitForLoadState("networkidle");
    await page.locator("[data-testid='gate2-continue']").click();
    await expect(page).toHaveURL(new RegExp(`/run/${FINISHED_JOB}/gate3$`));

    await page.waitForLoadState("networkidle");
    await page.locator("[data-testid='commit-bar']").getByRole("button", { name: /Continue to Gate 4/ }).click();
    await expect(page).toHaveURL(new RegExp(`/run/${FINISHED_JOB}/gate4$`));
    expect(writes).toEqual([]);
  });
});

const BIG = "c8331409f61e1#g0"; // a large refine concept: 17 variables, 20 ranked candidates

/** The shared-demo banner is on this screen, persistent and in the flow — never a dialog. */
async function expectBanner(page: Page, screen: string): Promise<void> {
  const banner = page.locator("[data-testid='sandbox-banner']");
  await expect(banner, `${screen} carries no sandbox banner`).toBeVisible();
  await expect(banner.locator("[data-testid='sandbox-banner-copy']")).toHaveText(SANDBOX_BANNER_COPY);
  // Not a modal: no dialog role, not inside one, and the page behind it is not inert.
  expect(await banner.evaluate((el) => !!el.closest("[role='dialog'],[role='alertdialog'],[aria-modal='true']"))).toBe(
    false,
  );
  await expect(page.locator("[role='dialog']")).toHaveCount(0);
}

test.describe("guest sandbox — the walk, on screen", () => {
  test("@sandbox guest sandbox: a guest walks every gate on the demo, edits at each, and nothing leaves the browser", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await serveWalkableDemo(page);
    const writes = watchWrites(page);
    const unsaved = page.locator("[data-testid='sandbox-banner']");

    // --- Setup: a read-back of the demo's parameters, banner and all.
    await open(page, "setup");
    await expectBanner(page, "Setup");
    await expect(unsaved).toHaveAttribute("data-unsaved", "0");

    // --- Gate 1: scope, rename, a New group, a move out of a group, and a declared score.
    await page.locator("[data-testid='rail-link-gate1']").click();
    await expect(page.locator("[data-testid='ledger']")).toBeVisible();
    await expectBanner(page, "Gate 1");
    await page.locator("[data-testid='ledger-row']").first().locator("[data-testid='queue-scope']").click();
    await expect(unsaved).toHaveAttribute("data-unsaved", "1"); // the count is LIVE, not one click behind

    await page.locator(`[data-testid='ledger-row'][data-row-id='${BIG}']`).click();
    const detail = page.locator("[data-testid='gate1-detail']");
    await detail.locator("[data-testid='rename-group']").click();
    const renameInput = detail.getByRole("textbox", { name: "Rename group" });
    await renameInput.fill("Smoking — my working set");
    await renameInput.press("Enter");

    const member = detail.locator("[data-testid='member-row']").first();
    const memberId = await member.getAttribute("data-member-id");
    await detail.locator(`[data-testid='member-remove'][data-member-id='${memberId}']`).click();

    await page.locator("[data-testid='new-group']").click();
    const nameInput = page.locator("[data-testid='new-group-name']");
    await nameInput.fill("Guest group");
    await nameInput.press("Enter");
    await expect(page.locator("[data-testid='ledger-row'][data-reviewer='true']", { hasText: "Guest group" })).toBeVisible();

    await page.locator("[data-testid='score-panel-toggle']").click();
    await page.locator("[data-testid='score-components']").fill("Weak grip strength\nSlow walking speed");
    await page.getByRole("button", { name: "Declare these components" }).click();
    await expect(page.locator("[data-testid='score-component']")).toHaveCount(2);

    // --- Gate 2: re-pick a candidate for the renamed concept.
    await page.locator("[data-testid='commit-bar']").getByRole("button", { name: /Continue to Gate 2/ }).click();
    await expect(page).toHaveURL(new RegExp(`/run/${FINISHED_JOB}/gate2$`));
    await expectBanner(page, "Gate 2");
    await page.locator(`[data-testid='gate2-concept'][data-concept-id='${BIG}']`).click();
    // Keyed on `data-chosen`, which an expand does not move (the chosen row's "Selected" mark does).
    const unchosen = page.locator("[data-testid='candidate-row']:not([data-chosen='true'])").first();
    await unchosen.locator("[data-testid='candidate-expand']").click();
    await unchosen.locator("[data-testid='candidate-select']").click();
    const confirm = page.locator("[data-testid='repick-confirm']");
    if (await confirm.isVisible().catch(() => false)) await page.locator("[data-testid='repick-accept']").click();

    // --- Gate 3: a combine rule on the one column two AoU variables share, and a note on a spec.
    await page.locator("[data-testid='gate2-continue']").click();
    await expect(page).toHaveURL(new RegExp(`/run/${FINISHED_JOB}/gate3$`));
    await expectBanner(page, "Gate 3");
    await page.locator(`[data-testid='gate3-concept'][data-concept-id='${PAIR}']`).click();
    await page.getByTestId("combine-rule-select").selectOption("separate");
    await expect(page.getByTestId("combine-rule")).toHaveAttribute("data-rule", "separate");
    await page.locator("[data-testid='spec-note-input']").first().fill("Checked against the source dictionary.");
    await page.locator("[data-testid='spec-save']").first().click();

    // --- Gate 4: choose what to take away, and read it before it leaves.
    await page.locator("[data-testid='gate3-continue']").click();
    await expect(page).toHaveURL(new RegExp(`/run/${FINISHED_JOB}/gate4$`));
    await expectBanner(page, "Gate 4");
    const tile = page.locator("[data-testid='artifact-tile']").first();
    await tile.locator("[data-testid='artifact-checkbox']").click();
    await expect(tile.locator("[data-testid='artifact-checkbox']")).not.toBeChecked();

    // THE PROJECTION: every kind this walk exercised is what "clone with my changes" would carry.
    const state = await heldState(page);
    const carried = new Set(sandboxArtifactsOf(state).map((a) => a.kind));
    for (const kind of [
      "gate1_group_scope",
      "gate1_rename",
      "gate1_regroup",
      "gate1_new_group",
      "composite_swap",
      "gate2_candidate_pick",
      "gate3_combine_rule",
      "gate3_spec_edit",
    ]) {
      expect(carried.has(kind), `${kind} was decided on the walk but is not in the clone projection`).toBe(true);
    }
    // The banner reports exactly what would be carried.
    await expect(unsaved).toHaveAttribute("data-unsaved", String(sandboxWorkCount(state)));

    // NOTHING LEFT THE BROWSER: no write of any kind, and no API call at all on the static demo.
    expect(writes).toEqual([]);
    // A guest's writes never reach a store, so they can never come back as a two-tab conflict.
    await expect(page.locator("[data-testid='gate-conflict']")).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("@sandbox guest sandbox: a refresh keeps the edits; a new tab starts from none", async ({ page, context }) => {
    await serveWalkableDemo(page);
    await open(page, "gate1");
    await page.locator("[data-testid='ledger-row']").first().locator("[data-testid='queue-scope']").click();
    const banner = page.locator("[data-testid='sandbox-banner']");
    await expect(banner).toHaveAttribute("data-unsaved", "1");

    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(banner).toHaveAttribute("data-unsaved", "1");
    await expect(page.locator("[data-testid='ledger-row']").first().locator("[data-testid='queue-scope']")).toBeChecked();

    // sessionStorage is per tab: a second tab on the same demo holds none of it — "not saved" is literally true.
    const other = await context.newPage();
    await serveWalkableDemo(other);
    await open(other, "gate1");
    await expect(other.locator("[data-testid='sandbox-banner']")).toHaveAttribute("data-unsaved", "0");
    expect(await other.evaluate((k) => sessionStorage.getItem(k), `${SANDBOX_PREFIX}${FINISHED_JOB}`)).toBeNull();
  });

  test("@sandbox guest sandbox: storage that throws leaves every screen working; the edit simply is not kept", async ({
    page,
  }) => {
    // Private-mode Safari and a full quota both THROW from sessionStorage. Every access in the sandbox is
    // best-effort, so the page must render, take the click and show it — only the refresh-survival is lost.
    await page.addInitScript(() => {
      const session = window.sessionStorage;
      const boom = () => {
        throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      };
      for (const m of ["getItem", "setItem", "removeItem", "key", "clear"] as const) {
        const original = Storage.prototype[m] as (...a: unknown[]) => unknown;
        Storage.prototype[m] = function (this: Storage, ...args: unknown[]) {
          if (this === session) boom();
          return original.apply(this, args);
        } as never;
      }
    });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await serveWalkableDemo(page);
    for (const gate of RAIL_SEQUENCE) {
      await open(page, gate);
      await expectBanner(page, gate);
    }
    await open(page, "gate1");
    const scope = page.locator("[data-testid='ledger-row']").first().locator("[data-testid='queue-scope']");
    await scope.click();
    await expect(scope).toBeChecked(); // the screen still shows the decision it was given
    expect(errors).toEqual([]);
  });

  test("@sandbox guest sandbox: storage cleared mid-walk continues from an empty sandbox", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await serveWalkableDemo(page);
    await open(page, "gate1");
    const scopeOf = (i: number) => page.locator("[data-testid='ledger-row']").nth(i).locator("[data-testid='queue-scope']");
    await scopeOf(0).click();
    await expect(page.locator("[data-testid='sandbox-banner']")).toHaveAttribute("data-unsaved", "1");

    // The visitor clears site data (or the browser evicts it) between two screens.
    await page.evaluate(() => sessionStorage.clear());
    await page.locator("[data-testid='rail-link-gate2']").click();
    await expect(page.locator("[data-testid='sandbox-banner']")).toHaveAttribute("data-unsaved", "0");
    await page.locator("[data-testid='rail-link-gate1']").click();
    await expect(page.locator("[data-testid='ledger']")).toBeVisible();
    await expect(scopeOf(0)).not.toBeChecked(); // nothing held, nothing shown — and no error
    await scopeOf(1).click();
    await expect(page.locator("[data-testid='sandbox-banner']")).toHaveAttribute("data-unsaved", "1");
    expect(errors).toEqual([]);
  });

  test("@sandbox guest sandbox: a corrupt sandbox entry is read as empty, not as a crash", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await serveWalkableDemo(page);
    await page.addInitScript(
      ({ key }) => sessionStorage.setItem(key, JSON.stringify({ gateDecisions: { gate1_group_scope: "broken" } })),
      { key: `${SANDBOX_PREFIX}${FINISHED_JOB}` },
    );
    await open(page, "gate1");
    await expect(page.locator("[data-testid='ledger']")).toBeVisible();
    await expect(page.locator("[data-testid='sandbox-banner']")).toHaveAttribute("data-unsaved", "0");
    expect(errors).toEqual([]);
  });
});

/**
 * The clone dialog, on screen. The static build has no auth, so the viewer is treated as able to own a run and the
 * banner opens the dialog directly; the SIGN-IN route to the same dialog is `signInCloneOffer`, asserted in Node
 * above, because no static build can sign anyone in. The clone POST itself cannot complete here (the static
 * client refuses it before any request) — which makes it the honest place to prove a FAILED clone loses nothing.
 */
test.describe("guest sandbox — the clone dialog", () => {
  const DEMO_NAME = "Demo · AI-READI + AoU + CLSA + MESA + UKBB";

  async function withEdits(page: Page): Promise<void> {
    await open(page, "gate1");
    await page.locator("[data-testid='ledger-row']").first().locator("[data-testid='queue-scope']").click();
    await page.locator("[data-testid='ledger-row']").nth(1).locator("[data-testid='queue-scope']").click();
    await expect(page.locator("[data-testid='sandbox-banner']")).toHaveAttribute("data-unsaved", "2");
  }

  test("@sandbox guest sandbox: with edits, BOTH flavours are offered and neither is picked for you", async ({ page }) => {
    await serveWalkableDemo(page);
    await withEdits(page);
    await page.locator("[data-testid='sandbox-keep']").click();
    const dialog = page.locator("[data-testid='clone-dialog']");
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute("data-unsaved", "2");
    await expect(dialog.locator("[data-testid='clone-fresh']")).toHaveText(/Clone fresh/);
    await expect(dialog.locator("[data-testid='clone-with-changes']")).toHaveText(/Clone with my changes \(2\)/);
    await expect(dialog.locator("[data-testid='clone-name']")).toHaveValue(`${DEMO_NAME} (my copy)`);
    // "Not now" keeps everything exactly as it was.
    await dialog.locator("[data-testid='clone-not-now']").click();
    await expect(dialog).toHaveCount(0);
    expect(sandboxWorkCount(await heldState(page))).toBe(2);
  });

  test("@sandbox guest sandbox: with no edits there is nothing to carry, so only a clean copy is offered", async ({
    page,
  }) => {
    await serveWalkableDemo(page);
    await open(page, "gate2");
    await expect(page.locator("[data-testid='sandbox-keep']")).toHaveText(/Make my own copy/);
    await page.locator("[data-testid='sandbox-keep']").click();
    const dialog = page.locator("[data-testid='clone-dialog']");
    await expect(dialog.locator("[data-testid='clone-fresh']")).toBeVisible();
    await expect(dialog.locator("[data-testid='clone-with-changes']")).toHaveCount(0);
  });

  test("@sandbox guest sandbox: a clone-name collision is surfaced and resolved in the open, never silently", async ({
    page,
  }) => {
    // One of the reviewer's runs already carries the default copy name.
    await page.route("**/static-data/jobs.json", async (route) => {
      const jobs = JSON.parse(readFileSync(resolve(REPO, "frontend/public/static-data/jobs.json"), "utf8"));
      jobs.push({ ...jobs[0], jobId: "mine-1", displayName: `${DEMO_NAME} (my copy)`, config: {} });
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(jobs) });
    });
    await serveWalkableDemo(page);
    await withEdits(page);
    await page.locator("[data-testid='sandbox-keep']").click();
    const dialog = page.locator("[data-testid='clone-dialog']");
    const name = dialog.locator("[data-testid='clone-name']");
    await expect(name).toHaveValue(`${DEMO_NAME} (my copy 2)`);
    await expect(dialog.locator("[data-testid='clone-name-collision']")).toContainText(
      `You already have a run called “${DEMO_NAME} (my copy)”`,
    );
    // Typing the taken name back is refused in place — both flavours wait for a free name.
    await name.fill(`${DEMO_NAME} (my copy)`);
    await expect(dialog.locator("[data-testid='clone-name-taken']")).toBeVisible();
    await expect(dialog.locator("[data-testid='clone-fresh']")).toBeDisabled();
    await expect(dialog.locator("[data-testid='clone-with-changes']")).toBeDisabled();
    await name.fill("My frailty review");
    await expect(dialog.locator("[data-testid='clone-name-taken']")).toHaveCount(0);
    await expect(dialog.locator("[data-testid='clone-with-changes']")).toBeEnabled();
  });

  test("@sandbox guest sandbox: a clone that fails clears nothing — the tab is the only place the work exists", async ({
    page,
  }) => {
    await serveWalkableDemo(page);
    await withEdits(page);
    const writes = watchWrites(page);
    for (const flavour of ["clone-with-changes", "clone-fresh"]) {
      await page.locator("[data-testid='sandbox-keep']").click();
      const dialog = page.locator("[data-testid='clone-dialog']");
      await dialog.locator(`[data-testid='${flavour}']`).click();
      await expect(dialog.locator("[data-testid='clone-error']")).toContainText("Your changes are still here");
      await expect(dialog).toBeVisible(); // still open, still offering both
      expect(sandboxWorkCount(await heldState(page)), flavour).toBe(2);
      await dialog.locator("[data-testid='clone-not-now']").click();
    }
    await expect(page.locator("[data-testid='sandbox-banner']")).toHaveAttribute("data-unsaved", "2");
    expect(writes).toEqual([]); // the static client refuses before any request
  });
});
