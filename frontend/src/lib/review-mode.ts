import type { GatePosition, JobStatus, ReviewMode } from "@/types";
import type { CostBreakdown } from "@/lib/estimate";
import { isGatePast } from "@/lib/gate-routes";

/**
 * Review mode (08-30) — how a run's gates are committed. The arithmetic and the copy live here, with no environment
 * reads and no JSX, so a Playwright spec can import and assert them (the rule `lib/estimate.ts` follows).
 *
 *   guided — every gate waits for the reviewer's Continue. The default, and what every run before 08-30 was.
 *   auto   — Full auto: the server commits each gate with the pipeline's own proposals (Gate 1: every group in
 *            scope; Gate 2: the model's picks; Gate 3: the specs as drafted) and starts the next step by itself,
 *            until the run waits at Gate 4.
 *
 * An enum rather than a flag, as on the server (`backend/jobs.py`), so "auto with gates" can join later.
 */
export type { ReviewMode };

export const REVIEW_MODES: readonly ReviewMode[] = ["guided", "auto"];
export const DEFAULT_REVIEW_MODE: ReviewMode = "guided";

/** Setup's two options: a label and ONE plain sentence each — what the reviewer is choosing between. */
export const REVIEW_MODE_COPY: Record<ReviewMode, { label: string; sentence: string }> = {
  guided: {
    label: "Guided",
    sentence:
      "The run stops at every gate for you to check and continue, and nothing after a gate is paid for until you do.",
  },
  auto: {
    label: "Full auto",
    sentence:
      "The run accepts its own proposals at every gate and goes straight to the export screen, so nobody reviews it before the whole run is paid for.",
  },
};

/** What an auto-committed gate is called everywhere — the server's `AUTO_ACCEPTED_LABEL`, verbatim. */
export const AUTO_ACCEPTED_LABEL = "Auto-accepted — not reviewed";
/** The decided-by value the decision log's `after` column carries for such a gate (`AUTO_DECIDED_AFTER`). */
export const AUTO_DECIDED_AFTER = "auto — not reviewed";

/** The gates Full auto can commit, in order. Gate 4 is the export screen; nothing is committed there. */
export const AUTO_GATES: readonly GatePosition[] = ["gate1", "gate2", "gate3"];

/** The gates a reviewer decides on — every screen after Setup. */
const REVIEW_GATES: readonly GatePosition[] = ["gate1", "gate2", "gate3", "gate4"];

/**
 * The decision kinds a Full-auto run's PASSED gates still accept — `backend/artifact_kinds.py::AUTO_REVISABLE_KINDS`.
 *
 * What the export applies without re-running anything: a group's name, the Gate 2 target (and its generated
 * element), the Gate 3 recodes, how variables combine and which are removed. Gate 1's grouping (scope, moves, new
 * groups) and the score declaration stay as committed — changing them would need those groups re-run, which is not
 * available yet, and the server refuses it.
 */
export const AUTO_REVISABLE_KINDS: ReadonlySet<string> = new Set([
  "gate1_rename",
  "gate2_candidate_pick",
  "gate2_relation",
  "gate3_spec_edit",
  "gate3_combine_rule",
  "gate3_member_exclusion",
]);

type Config = Record<string, unknown> | null | undefined;

/** The run's review mode; absent or unknown reads as guided (every run before 08-30 was). */
export function reviewModeOf(config: Config): ReviewMode {
  const mode = config?.review_mode;
  return mode === "auto" ? "auto" : "guided";
}

export function isAutoRun(config: Config): boolean {
  return reviewModeOf(config) === "auto";
}

/** Whether Full auto committed this gate — so nobody has reviewed it. */
export function isAutoAccepted(config: Config, gate: GatePosition): boolean {
  const decided = config?.gate_decided_by;
  return !!decided && typeof decided === "object" && (decided as Record<string, unknown>)[gate] === "auto";
}

/** The gates Full auto committed, in gate order — `[]` for every guided run. */
export function autoAcceptedGates(config: Config): GatePosition[] {
  return AUTO_GATES.filter((g) => isAutoAccepted(config, g));
}

/**
 * Whether a gate's decisions of `kind` are LOCKED — a record that can no longer change.
 *
 * A gate the run has passed is a record when a person continued it (its decisions were consumed by a paid step). One
 * Full auto committed was never reviewed, so the kinds the export applies without a re-run stay open on it. Mirrors
 * the server's `_refuse_past_gate`, so a control is never offered that the server would refuse.
 *
 * The shared demo locks none of its review gates: it is where a guest learns the controls. Its edits are held in the
 * tab and never sent — the server refuses every write to it anyway — so no review gate on it is a record. Setup still
 * is: it holds no review decision to practise, only the parameters the demo was built with.
 */
export function isGateLocked(
  gate: GatePosition,
  runPosition: GatePosition | null | undefined,
  config: Config,
  kind?: string,
): boolean {
  if (config?.demo && REVIEW_GATES.includes(gate)) return false;
  if (!isGatePast(gate, runPosition)) return false;
  if (!isAutoAccepted(config, gate)) return true;
  return kind === undefined ? true : !AUTO_REVISABLE_KINDS.has(kind);
}

/** "gate2" -> "Gate 2". */
export function gateLabel(gate: GatePosition | string): string {
  return gate.startsWith("gate") ? `Gate ${gate.slice(4)}` : gate;
}

/**
 * What pressing Start buys on a Full-auto run: EVERY gate's forecast, every group in scope — not the first charge.
 *
 * A guided Start buys Gate 1's work only, and each later gate re-quotes before its own Continue. Full auto has no
 * later Continue: Start is the one consent for the whole run, so the figure on it must be the whole run's (R8 —
 * never quote less than will be charged). The estimate already prices every variable, i.e. every group in scope.
 * Lines no gate buys (analysis ideas, `gate: "after"`) are left out: a Full-auto run stops at Gate 4.
 */
export function fullAutoCharge(estimate: CostBreakdown): number {
  return AUTO_GATES.reduce((sum, g) => sum + (estimate.byGate[g]?.forecast ?? 0), 0);
}

/** One gate's state on the Full-auto progress strip. */
export type AutoGateState = "accepted" | "running" | "waiting" | "stopped" | "reached";

/**
 * Where a Full-auto run is on its walk, gate by gate — what the in-flight screen shows so the run is seen moving
 * through the gates rather than stopping at them.
 *
 *   accepted — committed by Full auto (or being committed by it right now);
 *   running  — the step that produces this gate is running now (or the server is about to start it);
 *   reached  — the run waits here (Gate 4 at the end, or a gate where Full auto stopped), or a person continued it;
 *   stopped  — not reached, because the run stopped first;
 *   waiting  — not reached yet.
 */
export function autoGateStates(job: {
  status?: JobStatus | string | null;
  gatePosition?: GatePosition | null;
  autoAdvancing?: boolean | null;
  config?: Config;
}): Record<"gate1" | "gate2" | "gate3" | "gate4", AutoGateState> {
  const order = ["gate1", "gate2", "gate3", "gate4"] as const;
  const at = job.gatePosition ? order.indexOf(job.gatePosition as (typeof order)[number]) : -1;
  const parked = job.status === "awaiting_review";
  const advancing = parked && !!job.autoAdvancing;
  const ended = job.status === "complete" || job.status === "error" || job.status === "cancelled";
  const moving = (!parked && !ended) || advancing;
  const out = {} as Record<(typeof order)[number], AutoGateState>;
  order.forEach((g, i) => {
    if (isAutoAccepted(job.config, g) || (advancing && i === at)) out[g] = "accepted";
    else if (i < at || (parked && i === at)) out[g] = "reached";
    else if (moving && i === at + 1) out[g] = "running";
    else out[g] = moving ? "waiting" : "stopped";
  });
  return out;
}

/**
 * Why a Full-auto run is waiting at this gate for a person — or null when it is not.
 *
 * Full auto only ever waits at Gate 4. Anywhere earlier, with the server no longer continuing it, it stopped: a Stop,
 * a step that failed, no key, or a server restart (the key is held in memory only, so a restart cannot go on). The
 * server's recorded reason is used when there is one.
 */
export function autoPausedReason(job: {
  status?: JobStatus | string | null;
  gatePosition?: GatePosition | null;
  autoAdvancing?: boolean | null;
  errorMessage?: string | null;
  config?: Config;
}): string | null {
  if (!isAutoRun(job.config) || job.status !== "awaiting_review" || job.autoAdvancing) return null;
  if (!job.gatePosition || job.gatePosition === "gate4") return null;
  return (
    job.errorMessage ||
    `Full auto stopped at ${gateLabel(job.gatePosition)} before it could go on by itself — the server restarted, or ` +
      "the run was stopped. Its key is only ever held in memory, so it cannot continue on its own now."
  );
}
