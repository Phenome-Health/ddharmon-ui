/**
 * What a signed-in account gets, from its email domain (`src/auth.tsx` applies it).
 *
 * - No full-access domains listed (prod, local) → everyone signed in is `full`.
 * - A listed domain → `full`.
 * - Any other account → `read-only` (the demo, no runs) while the read-only tier is on, or `refused` when it is off.
 *   The dev channel turned it off on 2026-11-05 (`VITE_READ_ONLY_TIER=false`): dev is Phenome Health accounts only.
 *
 * The domain is the text after the LAST "@", compared exactly (case-insensitive) — a look-alike such as
 * `phenomehealth.org.evil.test` is a different domain. Pure (no `import.meta.env`), so specs import it directly.
 */
export type AccessTier = "full" | "read-only" | "refused";

export function accessTier(
  email: string | undefined,
  fullAccessDomains: readonly string[],
  readOnlyTier: boolean,
): AccessTier {
  if (fullAccessDomains.length === 0) return "full";
  const at = email?.lastIndexOf("@") ?? -1;
  const domain = email && at >= 0 ? email.slice(at + 1).toLowerCase() : undefined;
  if (domain && fullAccessDomains.includes(domain)) return "full";
  return readOnlyTier ? "read-only" : "refused";
}
