/**
 * Whether the app's left nav is collapsed — per browser, remembered across pages and reloads
 * (08-16c Task 5).
 *
 * Bhargav: *"make the UI sidebar collapsible so we have more space to work with."* The aside is a fixed
 * `w-60` — 240px taken from every screen, including the two widest things this phase has built (Gate 1's
 * ledger and the source-rows grid, which already needs `min-width: 0` on its track to avoid forcing
 * horizontal overflow).
 *
 * DEFAULT EXPANDED, and that is a decision about the SUITE as much as the product: this is app chrome, so
 * it changes every route's rendering and every visual baseline. Defaulting to expanded keeps the existing
 * baselines correct and makes only the collapsed state new — the alternative re-baselines twenty-odd
 * routes for a preference.
 *
 * PERSISTED THE WAY THIS APP ALREADY PERSISTS PER-BROWSER UI STATE, not by inventing a second mechanism:
 * a namespaced `localStorage` key with a try/catch around every access, following `lib/column-prefill.ts`
 * (`ddharmon:column-assignments:v1`). Storage throws in private-mode Safari and wherever it is disabled,
 * and a nav that cannot render because a preference could not be read is a worse failure than a nav that
 * forgets.
 */
const NAV_COLLAPSED_KEY = "ddharmon:nav-collapsed:v1";

export function readNavCollapsed(): boolean {
  try {
    return localStorage.getItem(NAV_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeNavCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(NAV_COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch {
    /* Storage unavailable — the preference is simply not remembered. */
  }
}
