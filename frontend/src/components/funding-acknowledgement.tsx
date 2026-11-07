/**
 * The ARPA-H funding acknowledgement. The wording is the funder's required language, supplied verbatim
 * (Bhargav, 2026-11-05) — do not edit, shorten, or reflow it into other copy; `tests/e2e/smoke.spec.ts` pins it.
 * Shown on every deployment, prod and dev alike: the funding is a fact about the work, not about a channel.
 */
export function FundingAcknowledgement() {
  return (
    <footer className="border-t border-rule-on-field pt-4">
      <p className="font-mono text-xs font-semibold uppercase tracking-eyebrow text-on-field-muted">Funding</p>
      <p data-testid="funding-acknowledgement" className="mt-1.5 max-w-4xl text-xs leading-relaxed text-on-field-muted">
        This research was, in part, funded by the Advanced Research Projects Agency for Health (ARPA-H). The views and
        conclusions contained in this document are those of the authors and should not be interpreted as representing
        the official policies, either expressed or implied, of the United States Government.
      </p>
    </footer>
  );
}
