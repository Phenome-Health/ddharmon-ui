// Phenome Health brand mark — a circos-plot-inspired glyph of three concentric arcs
// (genetics · behavior · environment, the three factors of the phenome). Designed to sit
// on the mark's own chip; render inside <PhenomeChip>.
//
// THE ARCS ARE PAINTED FROM `--mark-*`, WHICH IS THE POINT (T-08-65). Until 2026-08-20 this
// file drew the organisation's logo from `var(--accent-2-on-chrome)`, `var(--on-chrome)` and
// `var(--status-destructive)` — three general-purpose UI roles. So the 2026-08-20 rebrand,
// which dropped the brand's second hue, would have silently RESTYLED the Phenome Health mark
// as a side effect of a UI accent decision, and any future accent re-tone would do it again.
// A brand asset must not be painted from semantic roles. The `--mark-*` roles resolve from
// `--brand-mark-*` primitives sourced from the logo artwork, and teal survives there and
// nowhere else in the product: it is IN the mark, which is why a CSS colour tally of the
// live site could not find it.
export function PhenomeMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      {/* outer — the mark's crimson */}
      <circle
        cx="12" cy="12" r="8.5" stroke="var(--mark-outer)" strokeWidth="1.6" strokeLinecap="round"
        strokeDasharray="38.6 53.4" transform="rotate(-50 12 12)"
      />
      {/* middle — the mark's paper */}
      <circle
        cx="12" cy="12" r="5.7" stroke="var(--mark-middle)" strokeWidth="1.6" strokeLinecap="round"
        strokeDasharray="25.9 35.8" transform="rotate(80 12 12)"
      />
      {/* inner — the mark's teal */}
      <circle
        cx="12" cy="12" r="2.9" stroke="var(--mark-inner)" strokeWidth="1.6" strokeLinecap="round"
        strokeDasharray="13.2 18.2" transform="rotate(200 12 12)"
      />
    </svg>
  );
}

// The mark on its branded navy chip. `size` is the chip edge in Tailwind sizing units.
//
// The chip is `bg-surface-chrome`, which is what this comment always claimed and what the code
// did not do: it painted `bg-accent-action`, so the crimson arc sat on the brand blue at
// 1.21:1 and the teal arc at 2.62:1 — a logo two thirds of which was invisible, on a chip the
// docstring called navy. On the chrome the three arcs measure 4.13 / 19.21 / 8.93, all clear
// of the 3:1 graphical floor, and `role-manifest.json` now asserts exactly that.
export function PhenomeChip({ className }: { className?: string }) {
  return (
    <span className={`flex items-center justify-center rounded bg-surface-chrome ${className ?? "h-6 w-6"}`}>
      <PhenomeMark className="h-[85%] w-[85%]" />
    </span>
  );
}
