import { AlertTriangle } from "lucide-react";

/**
 * Site-wide "under active development" notice, shown at the very top of EVERY page on BOTH the prod
 * and dev channels. Deliberately bright yellow via inline hex (palette-independent, identical in
 * light + dark) so it's unmissable. Persistent — not dismissible — because the caveat applies on
 * every page, not just a first visit: coherence gating is still being fine-tuned, so some pipeline
 * outputs (e.g. value mappings for borderline concepts) are provisional. Soften/retire once
 * coherence gating lands and spec generation is gated on it.
 */
export function GlobalStatusBanner() {
  return (
    <div
      role="status"
      className="flex shrink-0 items-center justify-center gap-2 px-4 py-1.5 text-center text-[13px] font-medium leading-snug"
      style={{ backgroundColor: "#FACC15", color: "#1C1917", borderBottom: "1px solid #EAB308" }}
    >
      <AlertTriangle className="hidden h-4 w-4 shrink-0 sm:block" aria-hidden />
      <p>
        <span className="font-bold">ddharmon is under active development.</span> Variable-cluster
        coherence is still being fine-tuned, and the UI is undergoing regular cosmetic &amp;
        functional updates — treat results as provisional. We welcome your feedback: use{" "}
        <span className="font-semibold">&ldquo;Report an issue&rdquo;</span> at the bottom left.
      </p>
    </div>
  );
}
