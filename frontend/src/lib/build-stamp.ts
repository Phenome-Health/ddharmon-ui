/**
 * The name a build gives itself: its git TREE (7 hex), `+dirty` when tracked files differed from it at build time.
 *
 * The tree, not the commit, because `integration/dev` adds merge commits whose content IS the reviewed branch — a
 * Lavish review build and the dev deploy of the same content carry different commit SHAs but the same tree. The dev
 * badge shows it beside the live page width, so the reviewed build and the deployed one can be compared at a glance
 * and at the same width. Pure (no `import.meta.env`): `vite.config.ts` and Playwright specs import it.
 */
export function uiTreeStamp(tree: string | null | undefined, dirty: boolean): string | null {
  if (!tree) return null;
  return `${tree.slice(0, 7)}${dirty ? "+dirty" : ""}`;
}

/** The badge's text: "build 3f2c1a9 · 1440px". */
export function buildStampText(tree: string | null, width: number): string {
  return `build ${tree ?? "unknown"} · ${Math.round(width)}px`;
}
