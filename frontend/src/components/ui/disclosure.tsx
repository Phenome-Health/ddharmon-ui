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

/**
 * The OUTLINED FOLD's box — one per section of a Concept Spotlight panel (Gate 1 round 7; Gate 4 joined it in round
 * 9). A fold that is a peer of others draws this outline, so a reader sees where each section starts and ends.
 */
export const FOLD_BOX = "rounded-md border border-border bg-surface-raised px-3 py-2.5 text-xs";

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
 * THE DROPDOWN ARROW (option B — Bhargav, Lavish 2026-11-08: "it's easy to scroll past this because it's not obvious
 * that it's expandable. The drop down arrow should be highlighted when collapsed … throughout the UI"; then "ensure
 * that arrows align vertically whether collapsed or expanded").
 *
 * ONE FIXED SLOT (24px, or 20px `sm` for a toggle inside a line of text): CLOSED it is filled with a soft accent and the
 * arrow is accent ink; OPEN it has no fill and the arrow is the ground's muted ink, turned up. The slot never changes
 * size, so the arrow's centre never moves between the two states.
 *
 * STATE: pass `open` when the caller holds it. Otherwise the slot reads it from its trigger — `aria-expanded` (every
 * Radix trigger and our own toggles), or a native `<details open>` — in `index.css` (`[data-disclosure-arrow]`), so an
 * uncontrolled Collapsible needs no wiring. Never add a `rotate-180` class: the turn is the stylesheet's, and a second
 * one would turn the arrow back down.
 */
export function DisclosureChevron({
  ground,
  open,
  size = "md",
  className,
}: {
  ground: DisclosureGround;
  open?: boolean;
  size?: "md" | "sm";
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      data-disclosure-arrow=""
      data-size={size}
      data-open={open === undefined ? undefined : String(open)}
      className={cn(MUTED[ground], className)}
    >
      <ChevronDown />
    </span>
  );
}
