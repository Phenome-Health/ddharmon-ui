import { cn } from "@/lib/utils";

/**
 * A gate's zero-row state: HEADING, BODY and NEXT STEP (UI-SPEC §8.2).
 *
 * A blank pane is never acceptable. Every gate's empty case has documented copy, and every one of them
 * says what the reviewer can do about it — an empty state with no next step tells a reviewer they are
 * stuck without telling them where to go.
 *
 * IT IS NOT A `NotAvailable` TILE, and the two must not be confused: this one means "this surface works and
 * has nothing to show you", the other means "this capability is missing or was not asked for". Rendering
 * either as the other misinforms the reviewer about the product.
 */

export function GateEmptyState({
  heading,
  children,
  nextStep,
  className,
}: {
  heading: string;
  /** The body: what happened, in the reviewer's terms. */
  children: React.ReactNode;
  /** The next step — a sentence, or an action element. Required: an empty state without one is a dead end. */
  nextStep: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      data-testid="gate-empty-state"
      className={cn("flex flex-col gap-2 px-6 py-8", className)}
    >
      <p className="text-sm font-semibold text-on-raised">{heading}</p>
      <p className="max-w-[68ch] text-sm text-on-raised-muted">{children}</p>
      <p className="max-w-[68ch] text-sm text-on-raised">{nextStep}</p>
    </div>
  );
}
