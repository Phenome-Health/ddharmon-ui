import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { GATE_DECISION_KINDS, optionSetKey, type GateDecision } from "@/lib/gate-decisions";
import {
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
