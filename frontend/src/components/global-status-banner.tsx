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
 *
 * ONE LINE on a laptop (Bhargav, 2026-11-06): the two-line version pushed every screen down. It keeps the two things
 * it is for — results are provisional, and where feedback goes — and `status-banner.spec.ts` measures it at 1280px.
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
        <span className="font-semibold">ddharmon is under active development</span> — treat results as provisional.
        Feedback welcome: <span className="font-semibold">&ldquo;Report an issue&rdquo;</span>, bottom left.
      </p>
    </div>
  );
}
