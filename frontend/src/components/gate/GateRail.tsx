import { Check } from "lucide-react";
import { Link } from "wouter";
import { isGateReachable, pathForGate } from "@/lib/gate-routes";
import { cn } from "@/lib/utils";
import type { GatePosition } from "@/types";

/**
 * The gate rail — five equal columns, always, on the ground above the working surface (UI-SPEC §7.1.3).
 *
 * ALWAYS FIVE, never collapsed and never variable-length. A rail that shortens as gates complete makes the
 * reviewer's position mean something different on every screen, which is the opposite of what a progress
 * rail is for. Zero through five completed gates therefore render at identical width.
 *
 * FIVE RATHER THAN SIX SINCE 2026-08-26 (`08-DECISION-GATE0.md` D-2). Gate 0 was a gate with no decision —
 * its only control was Continue — so it was a receipt, not a gate, and its content moved to Setup as a
 * free pre-flight whose own Continue is the run's first charge. THE RULE ABOVE DID NOT CHANGE; only the length did. This rail is still fixed-length,
 * and the reason is still that a variable-length rail relocates the reviewer on every screen.
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

/**
 * Every gate position's label, keyed by the WIRE type.
 *
 * IT HOLDS ONE MORE ENTRY THAN THE RAIL DRAWS, and that is deliberate — do not "tidy" it. `GatePosition`
 * is the client half of contract.py's literal and still carries `gate0`, because the backend still PARKS
 * runs there (D-3 keeps the entry boundary exactly as built). Dropping the key fails typecheck, and
 * `setup.tsx` reads `GATE_LABELS[gate]` when it renders the per-gate bill, which walks every wire position.
 */
export const GATE_LABELS: Record<GatePosition, string> = {
  setup: "Set up",
  gate0: "Load & prepare",
  gate1: "Concept groups",
  gate2: "Concepts → elements",
  gate3: "Transform specs",
  gate4: "Export",
};

/**
 * The five columns and their order — the ONE place the rail's shape is declared.
 *
 * NOT THE SAME LIST AS `GATE_ORDER` in `lib/api.ts`, and the difference is load-bearing. That constant is
 * the client half of the WIRE contract and still contains `gate0`, so `next_gate("gate0") === "gate1"`
 * still resumes a parked run. This one is what the rail DRAWS. Two near-identical names, opposite jobs;
 * `gates.spec.ts` asserts they differ in exactly the retired position so a later tidying edit fails loudly
 * rather than silently breaking either the rail or the resume.
 */
export const GATE_SEQUENCE: GatePosition[] = ["setup", "gate1", "gate2", "gate3", "gate4"];

/**
 * One column's contents, wrapped so the whole card is the hit target rather than just its label.
 *
 * THREE STATES, THREE ELEMENTS, and the distinction is deliberate. A REACHABLE past gate is a real
 * `Link` — keyboard-focusable, announced as a link, and it names its destination so "Gate 2, Concepts →
 * elements" is what a screen-reader user hears rather than "link". A gate the run has NOT reached is a
 * `span` with `aria-disabled` and a reason on `title`: rendering it as a link that silently did nothing
 * would be indistinguishable from a broken one, and the requirement is that it be VISIBLY unreachable.
 * The CURRENT gate is neither — it is where you already are.
 */
function Inner({
  linkable,
  unreachable,
  href,
  label,
  gate,
  children,
}: {
  linkable: boolean;
  unreachable: boolean;
  href: string;
  label: string;
  gate: GatePosition;
  children: React.ReactNode;
}) {
  const name = gate === "setup" ? `Set up, ${label}` : `Gate ${gate.slice(4)}, ${label}`;
  if (linkable) {
    return (
      <Link
        href={href}
        data-testid={`rail-link-${gate}`}
        aria-label={`Back to ${name}`}
        className="flex flex-col gap-1 rounded-inner focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        {children}
      </Link>
    );
  }
  if (unreachable) {
    return (
      <span
        data-testid={`rail-ahead-${gate}`}
        aria-disabled="true"
        title={`${name} — this run has not reached this gate yet.`}
        className="flex cursor-not-allowed flex-col gap-1 opacity-60"
      >
        {children}
      </span>
    );
  }
  return <span className="flex flex-col gap-1">{children}</span>;
}

export function GateRail({
  current,
  items,
  className,
  jobId,
  runPosition,
}: {
  current: GatePosition;
  /** One entry per gate, in order. Exactly five; a short list is a bug, not a collapsed rail. */
  items: GateRailItem[];
  className?: string;
  /**
   * The run, so the rail can NAVIGATE (08-16c Task 2). Omit both and every column renders as plain text
   * exactly as before — which is what keeps a rail with no run behind it from offering dead links.
   */
  jobId?: string;
  /** Where the run actually is. Gates at or behind it are reachable; gates ahead of it are not. */
  runPosition?: GatePosition | null;
}) {
  const currentIndex = GATE_SEQUENCE.indexOf(current);
  return (
    <ol
      aria-label="Review gates"
      data-testid="gate-rail"
      className={cn("grid grid-cols-5 gap-2", className)}
    >
      {items.map((item, i) => {
        const isCurrent = item.gate === current;
        const isDone = i < currentIndex;
        /**
         * REACHABLE means the run has got at least this far — not merely that this screen is past it.
         * The two differ while a reviewer is standing on a PAST gate: from a frozen Gate 1 the run may be
         * parked at Gate 3, and Gates 2 and 3 must stay reachable so the reviewer is not stranded in the
         * past with only a one-way trip. That is why this asks the RUN's position, not `currentIndex`.
         */
        const linkable = !!jobId && !isCurrent && isGateReachable(item.gate, runPosition);
        const unreachable = !!jobId && !isCurrent && !isGateReachable(item.gate, runPosition);
        return (
          <li
            key={item.gate}
            data-gate={item.gate}
            data-reachable={jobId ? String(!unreachable) : undefined}
            data-state={isCurrent ? "current" : isDone ? "done" : "ahead"}
            // `aria-current="step"` on the CURRENT gate only. Without it the rail is five links and a
            // screen-reader user has no way to tell which screen they are on.
            aria-current={isCurrent ? "step" : undefined}
            className={cn(
              "flex min-h-8 flex-col gap-1 rounded-inner px-3 py-2",
              isCurrent
                ? "bg-surface-raised text-on-raised shadow-card"
                : "border border-rule-on-field bg-on-field/5 text-on-field",
            )}
          >
            <Inner
              linkable={linkable}
              unreachable={unreachable}
              href={jobId ? pathForGate(jobId, item.gate) : ""}
              label={item.label}
              gate={item.gate}
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
            </Inner>
          </li>
        );
      })}
    </ol>
  );
}
