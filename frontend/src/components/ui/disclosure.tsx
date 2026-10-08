import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * THE DISCLOSURE HEADER — one look for every fold on the review screens (08-30b, controls lab round 2).
 *
 * Bhargav wanted the Show/Hide MEANING without Show/Hide TEXT on screen: the whole header row lights up on
 * hover, a small chevron trails it, and the label is a plain sentence-case section label (14px semibold, full
 * ink) rather than a muted uppercase eyebrow. The accessible name still states the action — a trigger that
 * only says "toggle" is a defect (UI-SPEC §6) — so the words moved into `aria-label`, not away.
 *
 * Helpers rather than a wrapper component, because the folds are built on two different primitives (Radix
 * `Collapsible` and native `<details>`) and both must keep their own semantics.
 *
 * `ground` is the surface the header sits on: the how-to and score strips sit on the page FIELD, the
 * inherited panels on an INSET card, everything else on a RAISED card.
 */
export type DisclosureGround = "field" | "raised" | "inset";

const HOVER: Record<DisclosureGround, string> = {
  field: "hover:bg-on-field/10",
  raised: "hover:bg-surface-inset",
  inset: "hover:bg-surface-inset-strong",
};
const INK: Record<DisclosureGround, string> = {
  field: "text-on-field",
  raised: "text-on-raised",
  inset: "text-on-inset",
};
const MUTED: Record<DisclosureGround, string> = {
  field: "text-on-field-muted",
  raised: "text-on-raised-muted",
  inset: "text-on-inset-muted",
};

/**
 * The trigger row's classes. The negative margins let the hover fill bleed a little past the label, so the
 * lit area reads as the row, not as a box drawn tight around the words.
 */
export function disclosureRow(ground: DisclosureGround, className?: string): string {
  return cn(
    "-mx-2 -my-1 flex w-[calc(100%+1rem)] cursor-pointer items-center justify-between gap-2 rounded-inner px-2 py-1 text-left transition-colors",
    HOVER[ground],
    className,
  );
}

/** The section label every fold opens with — sentence case, 14px semibold, full ink. */
export function DisclosureLabel({
  ground,
  className,
  children,
}: {
  ground: DisclosureGround;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span data-disclosure-label className={cn("text-sm font-semibold", INK[ground], className)}>
      {children}
    </span>
  );
}

/**
 * The trailing chevron. `open` drives it for a controlled fold; a native `<details>` passes
 * `className="group-open:rotate-180"` instead and leaves `open` unset.
 */
export function DisclosureChevron({
  ground,
  open,
  className,
}: {
  ground: DisclosureGround;
  open?: boolean;
  className?: string;
}) {
  return (
    <ChevronDown
      aria-hidden="true"
      className={cn("h-4 w-4 shrink-0 transition-transform duration-200", MUTED[ground], open && "rotate-180", className)}
    />
  );
}
