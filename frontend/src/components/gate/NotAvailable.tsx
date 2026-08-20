import { cn } from "@/lib/utils";

/**
 * The honest "not available" tile (UI-SPEC §9, P8-D3).
 *
 * A deferred capability RENDERS. It is never quietly omitted, because a missing panel is indistinguishable
 * from a capability the product does not have, and the reviewer has no way to tell which they are looking
 * at. A tile with a reason is the difference.
 *
 * NOT AN ERROR. Dashed rule in the rule colour at the inner radius, a hollow dashed dot, title at body
 * size and weight 600, body at meta size — and NO destructive colour and NO warning icon. "Deferred by
 * design" and "failed to build" are different claims and must not look alike.
 *
 * THREE CLAIMS, and the third is the one that is easy to get wrong:
 *
 *  - `deferred`   — the capability does not exist yet (no query path, no provenance stamp, an open
 *                   research question). A PERMANENT absence, as far as this run is concerned.
 *  - `failed`     — the capability exists and did not produce anything this time.
 *  - `not-enabled`— the capability exists and THIS RUN did not ask for it (an opt-in stage left off).
 *                   Its copy must NAME THE OPTION rather than implying the product cannot do it: an
 *                   opt-in rendered as a permanent gap understates what the tool has.
 */

export type NotAvailableClaim = "deferred" | "failed" | "not-enabled";

export interface NotAvailableProps {
  /** What is not available, e.g. `Knowledge-graph context`. The status is appended by the component. */
  thing: string;
  claim: NotAvailableClaim;
  /** Why, in one sentence, and what the reviewer can do instead — or nothing. */
  children: React.ReactNode;
  className?: string;
}

/** The status half of the title. Kept here so three call sites cannot word the same claim three ways. */
const STATUS: Record<NotAvailableClaim, string> = {
  deferred: "not available",
  failed: "not produced for this run",
  "not-enabled": "not enabled for this run",
};

export function NotAvailable({ thing, claim, children, className }: NotAvailableProps) {
  return (
    <section
      data-testid="not-available"
      data-claim={claim}
      className={cn(
        // Dashed, inner radius, no shadow: this is not a paper surface floating on the ground, it is a
        // stated gap in one. No destructive colour anywhere — see the docstring.
        "flex flex-col gap-2 rounded-inner border border-dashed border-rule-on-raised px-6 py-4",
        className,
      )}
    >
      <h3 className="flex items-center gap-2 text-sm font-semibold text-on-raised">
        <span
          aria-hidden="true"
          className="h-2 w-2 shrink-0 rounded-full border border-dashed border-rule-control-on-raised"
        />
        {thing} — {STATUS[claim]}.
      </h3>
      <p className="max-w-[68ch] text-xs text-on-raised-muted">{children}</p>
    </section>
  );
}
