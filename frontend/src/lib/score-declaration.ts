import type { DecisionIndex } from "@/lib/gate-decisions";
import { declaredScores } from "@/lib/score-match";
import type { ReadDocument } from "@/lib/score-proposal";
import type { CompositeSpec } from "@/types";

/**
 * What Gate 1's score panel says about the declaration it HOLDS (phase-8 final review, round 2).
 *
 * The panel already said how to make a declaration; these are about one that exists:
 *
 *  - H4 — the CLOSED strip names the declared score (`stripStatus`). Closed, the strip used to read as the same
 *    invitation whether the reviewer had declared 48 components or none, so a reviewer coming back to Gate 1 could
 *    not tell from the top of the screen that their score was there.
 *  - A PASTED source leaves a record (`declarationSource`, `pastedRecords`). Bhargav: *"if score builder source is
 *    pasted text, we should show a record of whatever was entered, same way we would for a doc. make it
 *    collapsible if it's long"*. A read document's text is shown read-only beside the form; a declaration typed or
 *    pasted into the components box left nothing behind but the split-up names.
 *
 * Pure, because `frontend/` has no component test runner: pinned node-side by `tests/e2e/score-declaration.spec.ts`
 * and on the static build by the same file.
 */

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "matched: 40 of 48 found" — the count `SpecView` heads its component list with ("40/48 found"). */
function matchState(spec: CompositeSpec | null): string {
  if (!spec) return "not matched yet";
  const found = spec.matches.filter((m) => m.conceptId != null).length;
  return `matched: ${found} of ${spec.matches.length} found`;
}

/**
 * The closed strip's one line when a score is declared (H4), or `null` when none is — the strip then keeps its
 * invitation copy (`STRIP_SUMMARY`), exactly as before.
 *
 * `{name} · {N} components declared · {match state}`. The match state is the spec derived under the score's OWN
 * name (case-insensitive, the `composite` kind's identity), else "not matched yet" — a spec derived for another
 * score is not this one's match. It deliberately does not name the gate where matching happens. A spec with no
 * declaration behind it (derived straight from a document) is still a score the panel shows, so it gets a status
 * too, without the word "declared". A second declared score is counted rather than hidden.
 */
export function stripStatus(
  index: DecisionIndex | null | undefined,
  spec: CompositeSpec | null | undefined,
): string | null {
  const scores = declaredScores(index);
  if (scores.length === 0) {
    if (!spec) return null;
    const name = spec.definition?.name?.trim() || "Declared score";
    return `${name} · ${plural(spec.matches.length, "component", "components")} · ${matchState(spec)}`;
  }
  const [first, ...rest] = scores;
  const own = spec && (spec.definition?.name ?? "").trim().toLowerCase() === first.scoreName.toLowerCase() ? spec : null;
  const more = rest.length ? ` · and ${plural(rest.length, "more score", "more scores")}` : "";
  return `${first.scoreName} · ${plural(first.components.length, "component", "components")} declared · ${matchState(own)}${more}`;
}

// --- the record of a pasted source ---------------------------------------------------------------------------

/**
 * Where a declaration's component list came from, stored on EACH of its `composite_swap` rows (as `source`).
 *
 * WHY ON THE ROWS. The declaration already persists there (one row per component, through the shared gate-decision
 * layer), so the record survives a reload, rides the demo's browser sandbox and a clone exactly as the declaration
 * does, and freezes with Gate 1 — and no artifact kind had to be added, which is the rule this panel was built on.
 * It is an extra payload field: it moves no identity, option set or content key, and the decision-log and score
 * exports read named fields only, so the pasted text goes nowhere the declaration did not already go.
 *
 * ON EVERY ROW, not on one, so the record cannot be lost with whichever component it was parked on. A component
 * list is a few lines; the copies are small.
 *
 * A DOCUMENT is recorded by its handle only — provenance and sha256, never its text. The read text is up to 200,000
 * characters and is shown from the read itself; the handle is here so a later declaration from a document
 * SUPERSEDES an earlier paste (see `pastedRecords`) instead of leaving the old paste on screen as if it were current.
 *
 * `at` orders declarations of the same score: a re-declaration rewrites the rows it names, and a row only the older
 * list named keeps the older source.
 */
export type DeclarationSource =
  | { kind: "paste"; text: string; at: number }
  | { kind: "document"; provenance: string; sha256: string; at: number };

/**
 * The source of a declaration made NOW from `draft`. With no document read, the components box is the source and
 * it is kept EXACTLY as entered — blank lines, spacing and all; that is the record asked for. With a document read
 * (its proposal fills the same box), the document is the source.
 */
export function declarationSource(
  draft: string,
  document: Pick<ReadDocument, "provenance" | "sha256"> | null,
  at: number,
): DeclarationSource {
  if (document) return { kind: "document", provenance: document.provenance, sha256: document.sha256, at };
  return { kind: "paste", text: draft, at };
}

function sourceOf(row: Record<string, unknown>): DeclarationSource | null {
  const s = row.source as Record<string, unknown> | null | undefined;
  if (!s || typeof s !== "object" || typeof s.at !== "number") return null;
  if (s.kind === "paste" && typeof s.text === "string") return { kind: "paste", text: s.text, at: s.at };
  if (s.kind === "document" && typeof s.provenance === "string")
    return { kind: "document", provenance: s.provenance, sha256: String(s.sha256 ?? ""), at: s.at };
  return null;
}

/** One declared score whose newest declaration was pasted text, and that text as entered. */
export interface PastedRecord {
  scoreName: string;
  text: string;
}

/**
 * The pasted-text record of each declared score whose NEWEST declaration was pasted, in declared order.
 *
 * A score re-declared from a document has no pasted record, even though a row only the paste named still carries the
 * paste. Rows declared before sources were recorded carry none, and nothing is reconstructed for them: the split-up
 * names are not "whatever was entered".
 */
export function pastedRecords(index: DecisionIndex | null | undefined): PastedRecord[] {
  const newest = new Map<string, DeclarationSource>();
  for (const row of Object.values(index?.composite_swap ?? {})) {
    const score = typeof row.scoreName === "string" ? row.scoreName.trim() : "";
    const source = sourceOf(row);
    if (!score || !source) continue;
    const held = newest.get(score);
    if (!held || source.at > held.at) newest.set(score, source);
  }
  const out: PastedRecord[] = [];
  for (const { scoreName } of declaredScores(index)) {
    const source = newest.get(scoreName);
    if (source?.kind === "paste" && source.text.trim()) out.push({ scoreName, text: source.text });
  }
  return out;
}

/**
 * When the record starts COLLAPSED. The document record has no collapse of its own; it is a box capped at
 * `max-h-80` (320px) that scrolls, which on the app's 20px line height (`py-2`, a 1px border) shows 15 lines — the
 * static-build spec measures it. So a pasted record that would not fit that box unscrolled is LONG: more than 15
 * lines, or — for a pasted paragraph, which is few lines that wrap — more than 2,000 characters (15 lines of the
 * full-width record at ~140 monospace characters a line). Trailing blank lines do not count.
 */
export const RECORD_OPEN_LINES = 15;
export const RECORD_OPEN_CHARS = 2000;

const trimEnd = (text: string) => text.replace(/\s+$/u, "");
const lineCount = (text: string) => (trimEnd(text) ? trimEnd(text).split(/\r?\n/).length : 0);

export function isLongRecord(text: string): boolean {
  return lineCount(text) > RECORD_OPEN_LINES || trimEnd(text).length > RECORD_OPEN_CHARS;
}

/** "48 lines · 1,234 characters" — what a collapsed record still tells the reviewer. */
export function recordSize(text: string): string {
  const chars = trimEnd(text).length;
  return `${plural(lineCount(text), "line", "lines")} · ${chars.toLocaleString("en-US")} ${chars === 1 ? "character" : "characters"}`;
}
