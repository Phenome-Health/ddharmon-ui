import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import type { GatePosition } from "@/types";

/**
 * The gate rail — six equal columns, always, on the ground above the working surface (UI-SPEC §7.1.3).
 *
 * ALWAYS SIX, never collapsed and never variable-length. A rail that shortens as gates complete makes the
 * reviewer's position mean something different on every screen, which is the opposite of what a progress
 * rail is for. Zero through six completed gates therefore render at identical width.
 *
 * REALIZED vs FORECAST is the load-bearing distinction here. After UI-SPEC §0.1's reversal the reviewer
 * standing at Gate 1 is DOWNSTREAM of real spend — reaching Gate 1 already paid for concept generation,
 * splitting and the coherence judge — so a rail that renders "$2.14 spent" and "$3.99 to come" in the same
 * voice invites reading committed money as an estimate. Each column carries a `data-cost` attribute naming
 * which kind it is, and the two are distinguished visually AND in words ("spent $2.14" vs "est. $3.99"),
 * because a colour difference alone is not a statement.
 */

export interface GateRailItem {
  gate: GatePosition;
  /** Short column label, e.g. `Concept groups`. Kept short: the fold up to 12px left the tracks tight. */
  label: string;
  /**
   * What this column costs or is. `realized` = money already committed; `forecast` = an estimate for work
   * not yet bought; `state` = a non-monetary fact (`local`, `free`) — Setup and Gate 4 genuinely spend
   * nothing, and quoting them as $0.00 forecasts would be noise.
   */
  cost: { kind: "realized" | "forecast" | "state"; text: string };
}

/** The six columns and their order — the one place the rail's shape is declared. */
export const GATE_LABELS: Record<GatePosition, string> = {
  setup: "Set up",
  gate0: "Load & prepare",
  gate1: "Concept groups",
  gate2: "Concepts → elements",
  gate3: "Transform specs",
  gate4: "Export",
};

export const GATE_SEQUENCE: GatePosition[] = ["setup", "gate0", "gate1", "gate2", "gate3", "gate4"];

export function GateRail({
  current,
  items,
  className,
}: {
  current: GatePosition;
  /** One entry per gate, in order. Exactly six; a short list is a bug, not a collapsed rail. */
  items: GateRailItem[];
  className?: string;
}) {
  const currentIndex = GATE_SEQUENCE.indexOf(current);
  return (
    <ol
      aria-label="Review gates"
      data-testid="gate-rail"
      className={cn("grid grid-cols-6 gap-2", className)}
    >
      {items.map((item, i) => {
        const isCurrent = item.gate === current;
        const isDone = i < currentIndex;
        return (
          <li
            key={item.gate}
            data-gate={item.gate}
            data-state={isCurrent ? "current" : isDone ? "done" : "ahead"}
            // `aria-current="step"` on the CURRENT gate only. Without it the rail is six links and a
            // screen-reader user has no way to tell which screen they are on.
            aria-current={isCurrent ? "step" : undefined}
            className={cn(
              "flex min-h-8 flex-col gap-1 rounded-inner px-3 py-2",
              isCurrent
                ? "bg-surface-raised text-on-raised shadow-card"
                : "border border-rule-on-field bg-on-field/5 text-on-field",
            )}
          >
            <span
              className={cn(
                "flex items-center gap-1 text-xs font-semibold uppercase tracking-eyebrow",
                isCurrent ? "text-on-raised-muted" : "text-on-field-muted",
              )}
            >
              {isDone && <Check aria-hidden="true" className="h-3 w-3" />}
              {item.gate === "setup" ? "Set up" : `Gate ${item.gate.slice(4)}`}
              {isDone && <span className="sr-only">completed</span>}
            </span>
            <span className="truncate text-sm font-semibold">{item.label}</span>
            <span
              data-cost={item.cost.kind}
              className={cn(
                "text-xs",
                item.cost.kind === "realized" ? "font-semibold" : "font-normal",
                isCurrent ? "text-on-raised-muted" : "text-on-field-muted",
              )}
            >
              {item.cost.text}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
