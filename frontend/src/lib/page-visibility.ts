import { parseHiddenPages, type HideablePage } from "@/lib/hidden-pages";

// Baked in at build time from VITE_HIDDEN_PAGES (see `lib/hidden-pages.ts`); empty unless the deployment sets it.
const HIDDEN = parseHiddenPages(import.meta.env.VITE_HIDDEN_PAGES as string | undefined).pages;

/** Whether this build leaves `page` out — no nav entry, no in-page links, and its URL redirects home. */
export function isPageHidden(page: HideablePage): boolean {
  return HIDDEN.has(page);
}
