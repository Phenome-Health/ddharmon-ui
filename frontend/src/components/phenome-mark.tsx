// Phenome Health brand mark — a circos-plot-inspired glyph of three concentric arcs
// (genetics · behavior · environment, the three factors of the phenome), in the brand
// accent palette. Designed to sit on a navy (#113682) chip; render inside <PhenomeChip>.
export function PhenomeMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      {/* outer — crimson */}
      <circle
        cx="12" cy="12" r="8.5" stroke="#E21C52" strokeWidth="1.6" strokeLinecap="round"
        strokeDasharray="38.6 53.4" transform="rotate(-50 12 12)"
      />
      {/* middle — white */}
      <circle
        cx="12" cy="12" r="5.7" stroke="#FFFFFF" strokeWidth="1.6" strokeLinecap="round"
        strokeDasharray="25.9 35.8" transform="rotate(80 12 12)"
      />
      {/* inner — teal */}
      <circle
        cx="12" cy="12" r="2.9" stroke="#3AC2CB" strokeWidth="1.6" strokeLinecap="round"
        strokeDasharray="13.2 18.2" transform="rotate(200 12 12)"
      />
    </svg>
  );
}

// The mark on its branded navy chip. `size` is the chip edge in Tailwind sizing units.
export function PhenomeChip({ className }: { className?: string }) {
  return (
    <span className={`flex items-center justify-center rounded bg-ph-navy ${className ?? "h-6 w-6"}`}>
      <PhenomeMark className="h-[85%] w-[85%]" />
    </span>
  );
}
