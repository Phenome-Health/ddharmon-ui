import { RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatUsd, type GatePosition } from "@/types";
import { GATE_LABELS } from "@/components/gate/GateRail";

/**
 * The resume banner (UI-SPEC §7.1.5, R7) — shown when a run is REJOINED at a gate rather than walked to.
 *
 * NO COUNTDOWN, deliberately. Retention is indefinite until the reviewer deletes the run, so a timer would
 * be a threat the product does not carry out (UI-SPEC §8.6). The honest register is a resume affordance:
 * "Paused at Gate 1 · resume any time."
 *
 * It also states the SPEND ALREADY COMMITTED, because a run rejoined days later is the exact case where
 * the reviewer has forgotten what it cost, and reporting nothing there reads as "nothing yet" (T-08-44).
 */
export function ResumeBanner({
  gate,
  costSoFar,
  className,
}: {
  gate: GatePosition;
  /** Realized spend to reach this gate — persisted, so it survives the restart that made this banner show. */
  costSoFar: number;
  className?: string;
}) {
  return (
    <div
      role="status"
      data-testid="resume-banner"
      className={cn(
        "flex items-center gap-3 rounded-inner border border-rule-on-field bg-on-field/5 px-4 py-3",
        className,
      )}
    >
      <RotateCcw aria-hidden="true" className="h-4 w-4 shrink-0 text-on-field-muted" />
      <p className="text-sm text-on-field">
        <span className="font-semibold">
          Paused at {gate === "setup" ? "set up" : `Gate ${gate.slice(4)}`} · resume any time.
        </span>{" "}
        <span className="text-on-field-muted">
          You stopped on the {GATE_LABELS[gate].toLowerCase()} screen.{" "}
          {costSoFar > 0
            ? `${formatUsd(costSoFar)} has already been charged for the work behind it.`
            : "Nothing has been charged on this run so far."}
        </span>
      </p>
    </div>
  );
}
