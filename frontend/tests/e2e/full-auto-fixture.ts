import type { Page } from "@playwright/test";
import type { GatePosition, JobResult } from "@/types";
import { FINISHED_JOB, finishedFixture, pausedFixture } from "./gate23-fixture";

/**
 * A FULL-AUTO run (08-30), constructed in the spec from the two committed, derived fixtures — never a third file.
 *
 * The finished demo carries the records (candidates, generated elements, transform specs) and the paused fixture
 * carries the Gate 1 groups; the walk the sandbox spec already builds joins them on the groups both have. On top of
 * that sits exactly what Full auto writes on a run's config — its review mode, Gate 1's scope (every group) and who
 * committed each gate — and the position Full auto leaves a run at. Every one of those is visible here, in the
 * construction, rather than hidden in a file that would look as authoritative as the derived ones.
 */

/** Two AoU variables on one CDE — the one place a combine rule is offered (as in the sandbox spec). */
export const PAIR = "c46be33d9a542#g5";

export interface AutoRunShape {
  /** Where the run is: parked here, or (with an in-flight `status`) the gate it last parked at. Default Gate 4. */
  gate?: GatePosition | null;
  status?: JobResult["status"];
  /** The gates Full auto committed. Default: Gates 1-3 (a finished Full-auto run). */
  decided?: GatePosition[];
  autoAdvancing?: boolean;
  errorMessage?: string | null;
  /** The shared demo (pinned) rather than a run of the reviewer's own. Default: the reviewer's own. */
  demo?: boolean;
  /** Guided instead — the same run, with no review mode on its config. */
  guided?: boolean;
  phase?: string;
}

export function autoRun({
  gate = "gate4",
  status = "awaiting_review",
  decided = ["gate1", "gate2", "gate3"],
  autoAdvancing = false,
  errorMessage = null,
  demo = false,
  guided = false,
  phase,
}: AutoRunShape = {}): JobResult {
  const run = finishedFixture();
  const paused = pausedFixture().result!;
  const grouped = new Set((paused.conceptGroups ?? []).map((g) => g.groupId));
  run.result!.records = run.result!.records.filter((r) => grouped.has(r.groupId) || r.groupId === PAIR);
  run.result!.conceptGroups = paused.conceptGroups;
  run.result!.conceptGroupMembers = paused.conceptGroupMembers;
  run.result!.preprocessing = paused.preprocessing;
  run.result!.gatePosition = gate ?? undefined;
  const scope = [...new Set([...(paused.conceptGroups ?? []).map((g) => g.groupId), PAIR])];
  const { demo: _demo, ...rest } = (run.config ?? {}) as Record<string, unknown>;
  run.config = {
    ...rest,
    ...(demo ? { demo: true } : {}),
    run_mode: "batch",
    gate1_scope: scope,
    ...(guided
      ? {}
      : { review_mode: "auto", gate_decided_by: Object.fromEntries(decided.map((g) => [g, "auto"])) }),
  };
  run.status = status;
  run.phase = phase ?? status;
  run.gatePosition = gate;
  run.errorMessage = errorMessage;
  if (!guided) {
    (run as JobResult & { reviewMode?: string }).reviewMode = "auto";
    run.autoAdvancing = autoAdvancing;
  }
  return run;
}

/** Serve `autoRun(shape)` as the finished demo's result file — the only file the static client reads. */
export async function serveAutoRun(page: Page, shape: AutoRunShape = {}): Promise<void> {
  await page.route(`**/static-data/result-${FINISHED_JOB}.json`, async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(autoRun(shape)) });
  });
}

export { FINISHED_JOB };
