import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatUsd } from "@/lib/estimate";

/**
 * The sticky commit bar — the re-check notice, the spend at this gate, and the primary action.
 *
 * THE IRREVERSIBLE-SPEND CONFIRMATION IS INLINE HERE, NEVER A MODAL (UI-SPEC §8.5). A modal on the primary
 * path trains the reviewer to dismiss it: they meet it on every gate, it always says yes, and by the third
 * gate they are clicking through it without reading. An unmissable statement in the bar they are already
 * looking at is read once and remains true.
 *
 * REALIZED AND FORECAST ARE DIFFERENT SENTENCES. `spentHere` is money already gone (it is realized, from
 * the run's own cost ledger); `total` is what the button will buy. They are labelled in WORDS, not merely
 * placed differently, because after UI-SPEC §0.1's reversal the reviewer is standing downstream of real
 * spend and a bar that renders both in the same voice invites reading one as the other.
 *
 * GEOMETRY. The bar is a paper surface floating on the ground, so it DOES take the container radius and the
 * single elevation token (UI-SPEC §4).
 */

export interface CommitBarProps {
  /** The button's words, without the amount — e.g. `Continue to Gate 2`. */
  action: string;
  /** What pressing it will cost. Omit for a gate that buys nothing (Gate 4's download). */
  total?: number;
  /** Realized spend already committed to reach this gate. */
  spentHere?: number;
  /** True when this press is the run's FIRST charge — Gate 0's Continue (UI-SPEC §8.1). */
  firstCharge?: boolean;
  /** How many things are in scope, so the statement names what is being bought. */
  scopeLabel?: string;
  /** Something upstream changed and this gate's rows need re-checking — the accent notice dot. */
  recheckNotice?: React.ReactNode;
  onCommit?: () => void;
  busy?: boolean;
  disabled?: boolean;
  className?: string;
}

export function CommitBar({
  action,
  total,
  spentHere,
  firstCharge = false,
  scopeLabel,
  recheckNotice,
  onCommit,
  busy = false,
  disabled = false,
  className,
}: CommitBarProps) {
  return (
    <div
      data-testid="commit-bar"
      className={cn(
        "sticky bottom-0 z-10 flex flex-col gap-3 rounded-card bg-surface-raised px-6 py-4 shadow-card",
        className,
      )}
    >
      {recheckNotice && (
        <p role="status" className="flex items-start gap-2 text-sm text-on-raised">
          <span aria-hidden="true" className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-accent-action" />
          {recheckNotice}
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          {spentHere !== undefined && (
            <p className="text-sm text-on-raised-muted">
              <span className="font-semibold text-on-raised">
                Already spent to reach this gate: <span className="font-mono tabular-nums">{formatUsd(spentHere)}</span>
              </span>{" "}
              — money the run has committed, not an estimate.
            </p>
          )}
          {total !== undefined && (
            <p className="max-w-[68ch] text-sm text-on-raised">
              {/* The unmissable statement. It names the amount, the scope and the fact that this is where
                  spending begins — inline, in the bar the reviewer is already reading. */}
              Pressing {action} buys <span className="font-mono tabular-nums">{formatUsd(total)}</span>
              {scopeLabel ? ` of work for ${scopeLabel}` : " of work"}, and it is not refundable.
              {firstCharge && " This is where spending begins; everything before it ran on this machine."}
            </p>
          )}
        </div>
        <Button type="button" onClick={onCommit} disabled={disabled || busy} className="min-h-10">
          {busy && <Loader2 aria-hidden="true" className="mr-2 h-4 w-4 animate-spin" />}
          {action}
          {total !== undefined && (
            <span className="ml-2 font-mono tabular-nums">{formatUsd(total)}</span>
          )}
        </Button>
      </div>
    </div>
  );
}
