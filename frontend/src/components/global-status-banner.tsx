import { AlertTriangle } from "lucide-react";

/**
 * Site-wide "under active development" notice, shown at the very top of EVERY page on BOTH the prod
 * and dev channels. It draws from the identity's WARN family (§5.3) — `--warn` on `--warn-bg` with a
 * `--warn-line` rule, 5.67:1 — rather than the inline yellow it used to hard-code. That yellow was
 * picked to be palette-independent across two themes; there is one theme now, so the reason is gone
 * and "provisional" has a register of its own. Persistent — not dismissible — because the caveat applies on
 * every page, not just a first visit: coherence gating is still being fine-tuned, so some pipeline
 * outputs (e.g. value mappings for borderline concepts) are provisional. Soften/retire once
 * coherence gating lands and spec generation is gated on it.
 */
export function GlobalStatusBanner() {
  return (
    <div
      role="status"
      className="flex shrink-0 items-center justify-center gap-2 px-4 py-1.5 text-center text-sm font-semibold leading-snug"
      style={{
        backgroundColor: "var(--surface-warn)",
        color: "var(--on-warn)",
        borderBottom: "1px solid var(--rule-warn)",
      }}
    >
      <AlertTriangle className="hidden h-4 w-4 shrink-0 sm:block" aria-hidden />
      <p>
        <span className="font-semibold">ddharmon is under active development.</span> Variable-cluster
        coherence is still being fine-tuned, and the UI is undergoing regular cosmetic &amp;
        functional updates — treat results as provisional. We welcome your feedback: use{" "}
        <span className="font-semibold">&ldquo;Report an issue&rdquo;</span> at the bottom left.
      </p>
    </div>
  );
}
