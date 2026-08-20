// Phenome Health brand mark — a circos-plot-inspired glyph of three concentric arcs
// (genetics · behavior · environment, the three factors of the phenome), in the brand
// accent palette. Designed to sit on the action chip; render inside <PhenomeChip>.
// The arcs resolve from the identity tokens, and teal appears in its GROUND form
// (`--b-teal`, 5.53:1) because the chip it sits on is a dark field, not paper.
export function PhenomeMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      {/* outer — crimson */}
      <circle
        cx="12" cy="12" r="8.5" stroke="var(--status-destructive)" strokeWidth="1.6" strokeLinecap="round"
        strokeDasharray="38.6 53.4" transform="rotate(-50 12 12)"
      />
      {/* middle — white */}
      <circle
        cx="12" cy="12" r="5.7" stroke="var(--on-chrome)" strokeWidth="1.6" strokeLinecap="round"
        strokeDasharray="25.9 35.8" transform="rotate(80 12 12)"
      />
      {/* inner — teal */}
      <circle
        cx="12" cy="12" r="2.9" stroke="var(--accent-2-on-chrome)" strokeWidth="1.6" strokeLinecap="round"
        strokeDasharray="13.2 18.2" transform="rotate(200 12 12)"
      />
    </svg>
  );
}

// The mark on its branded navy chip. `size` is the chip edge in Tailwind sizing units.
export function PhenomeChip({ className }: { className?: string }) {
  return (
    <span className={`flex items-center justify-center rounded bg-accent-action ${className ?? "h-6 w-6"}`}>
      <PhenomeMark className="h-[85%] w-[85%]" />
    </span>
  );
}
