import type { UICandidate } from "@/types";

/**
 * Which catalog element a candidate IS (08-28 1h, F13) — pure, no environment reads, so a spec can import it.
 *
 * A candidate's `cdeId` is core's key for the element: the catalog's designation, which is NOT unique. The
 * endorsed catalog repeats "Age", "Age Units" and "Employment Status", and core keeps every row by minting
 * `Age__2` for the later ones. That key is unique but tells a reviewer nothing, so:
 *
 *  - on screen a repeated name is shown with its tinyId beside it ("Age · fmMMaUGpKS"), never as `Age__2`;
 *  - every pick records the element's `externalId` (tinyId) beside `chosen`, which stays the id for
 *    compatibility — the backend resolves an ambiguous name by the tinyId (`adapter._resolve_pick`).
 */

/** The loader's mint for a repeated name's later rows: `<name>__<n>`. An identity, never a display name. */
const MINTED = /__\d+$/;

/** The catalog's own name for a candidate: the wire's `sharedName` when it sent one, else the id less any mint. */
export function catalogName(c: Pick<UICandidate, "cdeId" | "sharedName">): string {
  return c.sharedName || c.cdeId.replace(MINTED, "");
}

/**
 * What a reviewer reads for a candidate: its name, with the tinyId beside it whenever the name does not say which
 * element it is — the wire marks it shared, the id was minted, or another candidate in `all` has the same name.
 */
export function candidateLabel(c: UICandidate, all: readonly UICandidate[] = []): string {
  const name = catalogName(c);
  const repeated =
    !!c.sharedName || name !== c.cdeId || all.some((o) => o.cdeId !== c.cdeId && catalogName(o) === name);
  if (!repeated) return c.cdeId;
  return c.cdeExternalId ? `${name} · ${c.cdeExternalId}` : c.cdeId;
}

/**
 * The candidate a persisted pick names: by its `externalId` when it carries one that a candidate has (the
 * catalog id disambiguates a repeated name), else by `chosen`. Mirrors the backend's reading of the same pick.
 */
export function pickedCandidateId(
  pick: { chosen?: unknown; externalId?: unknown } | undefined,
  candidates: readonly UICandidate[],
): string | undefined {
  if (!pick || typeof pick.chosen !== "string") return undefined;
  const ext = typeof pick.externalId === "string" ? pick.externalId : "";
  const hit = ext && pick.chosen ? candidates.find((c) => c.cdeExternalId === ext) : undefined;
  return hit ? hit.cdeId : pick.chosen;
}

/**
 * A catalog definition WITHOUT the element's name at its head (round 5 repeated-copy sweep). The flattened catalog
 * often prefixes a definition with the element's name — sometimes twice ("Other relative PhenX Other relative PhenX")
 * — so a row read "<name>" over "<name> <name> <definition>". The name is stripped, case-insensitively and as often
 * as it leads; what is left is the definition proper, or "" when the definition was only the name.
 */
export function definitionWithoutName(definition: string | null | undefined, name: string | null | undefined): string {
  let d = (definition ?? "").trim();
  const n = (name ?? "").trim();
  if (!n) return d;
  while (d.toLowerCase().startsWith(n.toLowerCase())) {
    const rest = d.slice(n.length);
    // Only a whole-name prefix: the next character must end the name (a space, punctuation, or the end).
    if (rest && /^[\w]/.test(rest)) break;
    d = rest.replace(/^[\s:;,.\-–—]+/, "").trim();
  }
  return d;
}
