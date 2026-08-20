import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";
import {
  DECISION_IDENTITY_FIELDS,
  GATE_DECISION_KINDS,
  contentKey,
  decisionItemKey,
  deriveStaleness,
  indexDecisions,
  isEmptyDecisionPayload,
  mergeDecisionIndex,
  optionSetKey,
  sha256Hex,
  shouldHydrate,
  staleItemKeys,
  touchedItemKeys,
  writesGoToSandbox,
  type GateDecision,
} from "@/hooks/use-gate-decisions";
import { SANDBOX_PREFIX, gateDecisionsOf, withGateDecision, type SandboxState } from "@/lib/sandbox";
import { PAUSED_RUN_FIXTURE } from "./routes";

/**
 * The shared gate-decision layer (08-12 Task 1).
 *
 * WHY MOST OF THIS RUNS IN NODE, NOT IN A BROWSER. No screen consumes the hook yet — 08-13 through 08-17
 * each compose one from it — and every gate route already carries a committed visual baseline, so wiring a
 * consumer into one of them here would move a screenshot another plan owns. So the hook's LOGIC is exported
 * as plain functions and asserted directly: the identity table, the content keys, the hydration merge, the
 * staleness derivation and the sandbox routing are all pure, which is exactly what makes them assertable
 * without rendering a page. The one browser test below covers the half that is genuinely about the browser:
 * that a demo decision survives a reload, and that writing one issues no request.
 *
 *   run: npm run test:e2e -- --grep "@decisions"
 *        npm run test:e2e -- --grep "correction persists"
 */

/** A decision payload, filled in enough to be valid. */
function decision(fields: Record<string, unknown>, chosen: string, alternatives: string[]): GateDecision {
  return { ...fields, chosen, alternatives, optionSetKey: optionSetKey(alternatives) } as GateDecision;
}

test.describe("gate decisions", () => {
  test("@decisions the hand-written sha256 agrees with the platform's", () => {
    // The keys have to match the BACKEND's byte for byte, so the hash cannot be an approximation. It is
    // hand-written because `crypto.subtle` is async and staleness must be a synchronous derived value.
    for (const s of ["", "abc", "a".repeat(1000), "grüße  ünïcode", JSON.stringify({ a: [1, 2, 3] })]) {
      expect(sha256Hex(s)).toBe(createHash("sha256").update(s, "utf8").digest("hex"));
    }
  });

  test("@decisions the option-set key ignores order and the content key does not ignore the choice", () => {
    expect(optionSetKey(["CDE:2", "CDE:1"])).toBe(optionSetKey(["CDE:1", "CDE:2"]));
    expect(optionSetKey(["CDE:1", "CDE:1", " ", ""])).toBe(optionSetKey(["CDE:1"]));
    // A re-pick among UNCHANGED candidates is the commonest correction there is, so it must move the key.
    const alts = ["CDE:1", "CDE:2"];
    expect(contentKey({ chosen: "CDE:1", alternatives: alts })).not.toBe(
      contentKey({ chosen: "CDE:2", alternatives: alts }),
    );
    // And a changed candidate list moves it too, for the same downstream reason.
    expect(contentKey({ chosen: "CDE:1", alternatives: alts })).not.toBe(
      contentKey({ chosen: "CDE:1", alternatives: [...alts, "CDE:3"] }),
    );
  });

  test("@decisions the content keys match the backend's, pinned by literal", () => {
    // The same two literals are asserted in tests/test_content_drift.py against the PYTHON functions, so a
    // change to either side's canonicalization fails on the other side rather than silently marking every
    // downstream decision stale forever.
    expect(optionSetKey(["CDE:2", "CDE:1"])).toBe("a9727a7585616812");
    expect(contentKey({ chosen: "CDE:1", alternatives: ["CDE:1", "CDE:2"] })).toBe("c5bb88b56d7e6094");
  });

  test("@decisions every kind keys on the thing decided, and names a missing field", () => {
    expect([...GATE_DECISION_KINDS].sort()).toEqual([
      "composite_swap",
      "gate1_group_scope",
      "gate1_regroup",
      "gate2_candidate_pick",
      "gate2_relation",
      "gate3_spec_edit",
      "gate4_export_selection",
    ]);
    expect(DECISION_IDENTITY_FIELDS.gate1_regroup).toEqual(["memberId"]);
    expect(decisionItemKey("gate1_regroup", { memberId: "ukbb:21001" })).toBe("ukbb:21001");
    expect(decisionItemKey("gate2_relation", { groupId: "c1#g0", targetId: "CDE:9" })).toBe("c1#g0|CDE:9");
    expect(decisionItemKey("composite_swap", { scoreName: "frailty", componentName: "grip" })).toBe(
      "frailty|grip",
    );
    expect(() => decisionItemKey("gate1_group_scope", {})).toThrow(/groupId/);
  });

  test("@decisions hydration runs once per run and never over an empty payload", () => {
    // Once per run, because the progress stream re-pushes the whole job every half second and a
    // re-hydrate on every frame fights the reviewer's clicks.
    expect(shouldHydrate({ jobId: "a", hydratedJobId: null, payload: { gate1_group_scope: [] } })).toBe(false);
    const payload = { gate1_group_scope: [decision({ groupId: "g1" }, "in", ["in", "out"])] };
    expect(shouldHydrate({ jobId: "a", hydratedJobId: null, payload })).toBe(true);
    expect(shouldHydrate({ jobId: "a", hydratedJobId: "a", payload })).toBe(false);
    expect(shouldHydrate({ jobId: "b", hydratedJobId: "a", payload })).toBe(true);
    // Skipped on an EMPTY payload, which is what keeps the demo safe without testing a demo flag that is
    // still false on the first render.
    expect(isEmptyDecisionPayload({})).toBe(true);
    expect(isEmptyDecisionPayload(null)).toBe(true);
    expect(isEmptyDecisionPayload({ gate1_group_scope: [] })).toBe(true);
    expect(isEmptyDecisionPayload(payload)).toBe(false);
  });

  test("@decisions the hydration merge lets the local write win", () => {
    const server = indexDecisions({
      gate1_group_scope: [decision({ groupId: "g1" }, "out", ["in", "out"])],
      gate2_candidate_pick: [decision({ groupId: "g2" }, "CDE:1", ["CDE:1", "CDE:2"])],
    });
    const local = indexDecisions({
      gate1_group_scope: [decision({ groupId: "g1" }, "in", ["in", "out"])],
    });
    const merged = mergeDecisionIndex(server, local);
    // A click made before the payload arrived is not reverted to its saved value…
    expect(merged.gate1_group_scope.g1.chosen).toBe("in");
    // …and a decision only the server holds is still hydrated.
    expect(merged.gate2_candidate_pick.g2.chosen).toBe("CDE:1");
  });

  test("@decisions staleness is derived by comparison, not read from a flag", () => {
    const upstream = decision({ groupId: "g1" }, "CDE:2", ["CDE:1", "CDE:2"]);
    const downstreamOf = (seen: string): GateDecision => ({
      ...decision({ sourceVariable: "ukbb:21001" }, "recode-a", ["recode-a"]),
      upstream: { kind: "gate2_candidate_pick", itemKey: "g1", contentKey: seen },
    });

    // Made against the CURRENT upstream: not stale.
    const fresh = indexDecisions({
      gate2_candidate_pick: [upstream],
      gate3_spec_edit: [downstreamOf(contentKey(upstream))],
    });
    expect(deriveStaleness(fresh)).toEqual([]);

    // Made against an EARLIER upstream: stale, and it says which upstream moved.
    const stale = indexDecisions({
      gate2_candidate_pick: [upstream],
      gate3_spec_edit: [downstreamOf(contentKey({ chosen: "CDE:1", alternatives: ["CDE:1", "CDE:2"] }))],
    });
    expect(deriveStaleness(stale)).toEqual([
      {
        kind: "gate3_spec_edit",
        itemKey: "ukbb:21001",
        upstreamKind: "gate2_candidate_pick",
        upstreamItemKey: "g1",
        reason: "the upstream decision changed after this one was made",
      },
    ]);
    expect(staleItemKeys(deriveStaleness(stale), "gate3_spec_edit")).toEqual(["ukbb:21001"]);

    // An ABSENT upstream is not reported: the reviewer may simply have cleared it, and absence is not
    // evidence of change.
    const orphan = indexDecisions({ gate3_spec_edit: [downstreamOf("deadbeefdeadbeef")] });
    expect(deriveStaleness(orphan)).toEqual([]);
  });

  test("@decisions touched state is derived from the persisted decisions, not from component state", () => {
    const index = indexDecisions({
      gate1_group_scope: [decision({ groupId: "g1" }, "in", ["in", "out"]), decision({ groupId: "g2" }, "out", ["in", "out"])],
    });
    expect(touchedItemKeys(index, "gate1_group_scope").sort()).toEqual(["g1", "g2"]);
    expect(touchedItemKeys(index, "gate2_candidate_pick")).toEqual([]);
  });

  test("@decisions a pinned run and a backend-less build both write to the sandbox", () => {
    expect(writesGoToSandbox({ pinned: true, isStatic: false })).toBe(true);
    expect(writesGoToSandbox({ pinned: false, isStatic: true })).toBe(true);
    expect(writesGoToSandbox({ pinned: false, isStatic: false })).toBe(false);
    // The demo flag is still false on the first render (the stream hook's first jobState has an empty
    // config), so an UNDEFINED pinned state must not resolve to "this is a real run, go write to it".
    expect(writesGoToSandbox({ pinned: undefined, isStatic: false })).toBe(true);
  });

  test("@decisions a correction persists across a reload and reaches no store", async ({ page }) => {
    // WHAT EACH HALF PROVES. The sandbox writer and reader are this plan's code and run here in Node
    // (`withGateDecision` / `gateDecisionsOf` are pure by design for exactly this reason). The BROWSER's
    // job is the half only a browser can answer: that the medium the hook writes to survives a real
    // reload of a real page. A built static bundle cannot import `src/` at runtime, so the module is not
    // re-imported inside the page — the serialized state it produces is.
    const apiCalls: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/api/")) apiCalls.push(`${r.method()} ${r.url()}`);
    });

    const written = withGateDecision({}, "gate1_group_scope", "c8331409f61e1#g0", {
      groupId: "c8331409f61e1#g0",
      chosen: "in",
      alternatives: ["in", "out"],
      optionSetKey: optionSetKey(["in", "out"]),
    } as GateDecision);

    await page.goto(`/run/${PAUSED_RUN_FIXTURE}/gate1`);
    await page.waitForLoadState("networkidle");
    // sessionStorage, not localStorage, is what makes "nothing is saved" literally true — and it is also
    // what makes this survive a reload, which is what R6 requires.
    await page.evaluate(
      ({ key, state }) => sessionStorage.setItem(key, JSON.stringify(state)),
      { key: `${SANDBOX_PREFIX}${PAUSED_RUN_FIXTURE}`, state: written },
    );

    await page.reload();
    await page.waitForLoadState("networkidle");

    const raw = await page.evaluate((key) => sessionStorage.getItem(key), `${SANDBOX_PREFIX}${PAUSED_RUN_FIXTURE}`);
    expect(raw).toBeTruthy();
    const survived = gateDecisionsOf(JSON.parse(raw!) as SandboxState);
    expect(survived.gate1_group_scope["c8331409f61e1#g0"].chosen).toBe("in");
    // And the touched/stale derivation reads THAT — not component state, which is the shipped defect.
    expect(touchedItemKeys(survived, "gate1_group_scope")).toEqual(["c8331409f61e1#g0"]);

    // Nothing about the demo reached the store. A guest action that could spend or persist is the one
    // thing the sandbox exists to make impossible.
    expect(apiCalls).toEqual([]);
  });
});
