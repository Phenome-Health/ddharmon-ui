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
  /**
   * A stable hook for the button itself, when a screen's primary control has an identity of its own.
   *
   * Setup's start control uses it to keep `start-run`. That hook predates this bar by three plans and is
   * asserted from a dozen places; renaming every one of them to `commit-bar` in the plan that MOVED the
   * charge onto it would have mixed "the control is now the first charge" with "the control is called
   * something else", and only one of those is a behaviour change.
   */
  actionTestId?: string;
  /** What pressing it will cost. Omit for a gate that buys nothing (Gate 4's download). */
  total?: number;
  /** Realized spend already committed to reach this gate. */
  spentHere?: number;
  /** True when this press is the run's FIRST charge — Setup's pre-flight Continue (UI-SPEC §8.1). */
  firstCharge?: boolean;
  /** How many things are in scope, so the statement names what is being bought. */
  scopeLabel?: string;
  /** Something upstream changed and this gate's rows need re-checking — the accent notice dot. */
  recheckNotice?: React.ReactNode;
  /**
   * A standing assurance carried on the bar itself (Gate 4's participant-data line, UI-SPEC §8.6). Rendered
   * only when passed, so no other gate's bar changes. It rides IN the bar rather than above it because the
   * bar is sticky, and an assurance that scrolls away is one the reviewer may never see at the moment they
   * press download.
   */
  assurance?: React.ReactNode;
  onCommit?: () => void;
  busy?: boolean;
  disabled?: boolean;
  className?: string;
}

export function CommitBar({
  action,
  actionTestId,
  total,
  spentHere,
  firstCharge = false,
  scopeLabel,
  recheckNotice,
  assurance,
  onCommit,
  busy = false,
  disabled = false,
  className,
}: CommitBarProps) {
  return (
    <div
      data-testid="commit-bar"
      // The amount as DATA as well as words. A gate asserting "this press carries a non-zero charge" has
      // to read the figure, and parsing it back out of a formatted sentence is a gate that breaks on a
      // copy edit rather than on a wrong number.
      data-total={total === undefined ? "" : String(total)}
      data-first-charge={String(firstCharge)}
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
        <Button
          type="button"
          data-testid={actionTestId}
          onClick={onCommit}
          disabled={disabled || busy}
          className="min-h-10"
        >
          {busy && <Loader2 aria-hidden="true" className="mr-2 h-4 w-4 animate-spin" />}
          {action}
          {total !== undefined && (
            <span className="ml-2 font-mono tabular-nums">{formatUsd(total)}</span>
          )}
        </Button>
      </div>

      {assurance && (
        <p data-testid="commit-assurance" className="max-w-[80ch] text-xs text-on-raised-muted">
          {assurance}
        </p>
      )}
    </div>
  );
}
