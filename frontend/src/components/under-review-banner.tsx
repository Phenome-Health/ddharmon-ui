import { FlaskConical } from "lucide-react";

/**
 * A persistent "under review" banner for the credibility pages (Methods / Benchmarks / Design choices).
 * Signals that the methodology + figures are provisional and still being validated, so a reader never
 * mistakes a work-in-progress page for a finalized, peer-reviewed one. Theme-aware (warning tokens).
 */
export function UnderReviewBanner() {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-warning-border bg-warning-bg px-4 py-3 text-sm">
      <FlaskConical className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
      <p className="text-neutral-700">
        <span className="font-semibold text-warning">Under review.</span> This page is a work in progress —
        its methodology and figures are provisional and still being validated. Treat them as indicative, not
        final.
      </p>
    </div>
  );
}
