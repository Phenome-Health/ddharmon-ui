/**
 * Content pages a deployment may leave out, named by their route slug.
 *
 * Prod (ddharmon.io) runs dev's code as a stripped-down site for outside visitors (AMIA, 2026-11): it sets
 * `VITE_HIDDEN_PAGES=methods,benchmarks,design,roadmap,architecture,phenome` in its `frontend/.env`. Every other
 * build leaves it unset and shows the whole site. A hidden page is dropped from the nav, its URL sends the visitor
 * home, and in-page links to it are not drawn (`lib/page-visibility.ts` applies it; the lean e2e gate checks it).
 *
 * Pure (no `import.meta.env`): `vite.config.ts` imports it to refuse a build whose list names an unknown page — a
 * typo there would otherwise leave the very page it meant to hide on prod, silently.
 */
export const HIDEABLE_PAGES = ["methods", "benchmarks", "design", "roadmap", "architecture", "phenome"] as const;

export type HideablePage = (typeof HIDEABLE_PAGES)[number];

/** Parse the comma-separated list; `unknown` holds any entry that names no hideable page. */
export function parseHiddenPages(raw: string | undefined): { pages: ReadonlySet<HideablePage>; unknown: string[] } {
  const pages = new Set<HideablePage>();
  const unknown: string[] = [];
  for (const entry of (raw ?? "").split(",")) {
    const key = entry.trim().toLowerCase();
    if (!key) continue;
    if ((HIDEABLE_PAGES as readonly string[]).includes(key)) pages.add(key as HideablePage);
    else unknown.push(entry.trim());
  }
  return { pages, unknown };
}
