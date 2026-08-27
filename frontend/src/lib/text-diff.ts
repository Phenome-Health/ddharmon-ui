/**
 * Word-level diff for the before/after pairs on Gate 0.
 *
 * WHY THIS EXISTS. Preparation's edits are often a handful of characters inside a paragraph — a stripped
 * `<p>`, a dropped administrative sentence, a collapsed run of spaces. Rendered as two blocks of prose the
 * change is invisible: the reviewer is asked to authorise the run's first charge on the strength of a
 * difference they cannot find. Marking it is not decoration, it is the panel's entire job.
 *
 * WHAT IT GUARANTEES, and what the tests pin:
 *
 *  1. **Lossless.** Concatenating the `same` + `removed` segments reproduces `before` byte for byte, and
 *     `same` + `added` reproduces `after`. A diff that quietly drops or reflows a character would be
 *     showing the reviewer a string neither the file nor the model contains — the same defect class as
 *     the `[:80]` truncation the 2026-08-26 review removed from these very panels.
 *  2. **Whitespace-preserving.** Tokens carry their own trailing whitespace, so a change that IS a
 *     whitespace change (the normalisation rules) still renders as a change rather than vanishing.
 *  3. **Bounded.** The common prefix and suffix are trimmed before the quadratic step, and past a token
 *     ceiling the result degrades to one coarse replacement rather than hanging the tab. Degraded is
 *     stated in the return value, so the UI can say "shown as a whole-value replacement" instead of
 *     implying the whole string changed.
 *
 * It is deliberately a WORD diff, not a character one. Character diffs on prose produce speckle —
 * fragments highlighted mid-word — which reads as corruption and is harder to scan than no marking.
 */

export type DiffKind = "same" | "removed" | "added";

export interface DiffSegment {
  kind: DiffKind;
  text: string;
}

export interface WordDiff {
  segments: DiffSegment[];
  /** Whether anything at all differs. `false` means the two strings are identical. */
  changed: boolean;
  /** True when the pair exceeded the token ceiling and is reported as one whole-value replacement. */
  coarse: boolean;
  /**
   * True when the two strings RENDER IDENTICALLY — they differ only in characters that draw nothing.
   *
   * Not "whitespace only": JavaScript's `\s` does not match the zero-width characters (U+200B–U+200D,
   * U+FEFF), and those are exactly the ones a reviewer has no chance of spotting. Marking alone is not
   * enough for any of these; the caller is expected to say what happened in words (see
   * `describeInvisibleChange`).
   */
  invisibleOnly: boolean;
}

/** Past this many tokens per side (after prefix/suffix trimming) the quadratic table is not worth it. */
const TOKEN_CEILING = 600;

/**
 * Split into tokens that each carry their trailing whitespace, so `tokens.join("")` is the input exactly.
 * A leading run of whitespace becomes its own token rather than being attached to nothing.
 */
export function tokenize(text: string): string[] {
  return text.match(/\s+|\S+\s*/g) ?? [];
}

function push(out: DiffSegment[], kind: DiffKind, text: string): void {
  if (!text) return;
  const last = out[out.length - 1];
  if (last && last.kind === kind) last.text += text;
  else out.push({ kind, text });
}

/** Longest common subsequence over token arrays, returned as the diff script. */
function lcsSegments(a: string[], b: string[]): DiffSegment[] {
  const n = a.length;
  const m = b.length;
  // table[i][j] = LCS length of a[i:] and b[j:]
  const table: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const out: DiffSegment[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push(out, "same", a[i]);
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      push(out, "removed", a[i]);
      i++;
    } else {
      push(out, "added", b[j]);
      j++;
    }
  }
  while (i < n) push(out, "removed", a[i++]);
  while (j < m) push(out, "added", b[j++]);
  return out;
}

/**
 * Diff two strings at word granularity.
 *
 * Equal strings return a single `same` segment with `changed: false` — which the caller renders as plain
 * text. Marking nothing is the correct rendering of "nothing changed", and is distinct from an empty
 * result, which would render as an empty panel.
 */
export function wordDiff(before: string, after: string): WordDiff {
  const a0 = before ?? "";
  const b0 = after ?? "";
  if (a0 === b0) {
    return {
      segments: a0 ? [{ kind: "same", text: a0 }] : [],
      changed: false,
      coarse: false,
      invisibleOnly: false,
    };
  }
  const invisibleOnly = collapse(a0) === collapse(b0);

  const a = tokenize(a0);
  const b = tokenize(b0);

  // Trim the shared head and tail first. On the real cases — one clause removed from a paragraph — this
  // is most of the work, and it keeps the quadratic step off the parts that obviously match.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) {
    tail++;
  }

  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);

  const out: DiffSegment[] = [];
  push(out, "same", a.slice(0, head).join(""));
  let coarse = false;
  if (midA.length > TOKEN_CEILING || midB.length > TOKEN_CEILING) {
    coarse = true;
    push(out, "removed", midA.join(""));
    push(out, "added", midB.join(""));
  } else {
    for (const seg of lcsSegments(midA, midB)) push(out, seg.kind, seg.text);
  }
  push(out, "same", a.slice(a.length - tail).join(""));
  return { segments: out, changed: true, coarse, invisibleOnly };
}

/**
 * The "same to the eye" normal form: zero-width characters dropped, every run of whitespace flattened to
 * one space, ends trimmed.
 *
 * Zero-width characters are removed rather than collapsed because they occupy no space at all — treating
 * them as whitespace would make `a\u200bb` normalise to `a b`, which is not what the reader sees. They
 * are also invisible to `\s`, so a regex-only normal form silently misses the single hardest class of
 * difference to spot by eye.
 */
function collapse(text: string): string {
  return text
    .replace(/[\u200b\u200c\u200d\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The invisible characters this table can name, most specific first.
 *
 * A report that says "the difference is whitespace" leaves the reviewer unable to find it in their own
 * file. Naming the codepoint makes it searchable, which is the difference between a report and a claim.
 * An unlisted invisible character falls through to the generic entry rather than being ignored — a change
 * we cannot name is still a change the reviewer must be told about.
 */
const INVISIBLES: Array<{ test: RegExp; label: string }> = [
  { test: /\u00a0/, label: "a no-break space (U+00A0)" },
  { test: /[\u200b\u200c\u200d\ufeff]/, label: "a zero-width character (U+200B–U+200D / U+FEFF)" },
  { test: /\t/, label: "a tab" },
  { test: /\r/, label: "a carriage return" },
  { test: /\n/, label: "a line break" },
  { test: /[\u2000-\u200a\u202f\u205f\u3000]/, label: "an unusual space character (U+2000–U+3000)" },
  { test: /  +/, label: "repeated spaces" },
];

/**
 * Name what invisible thing differs between two strings, for a pair that renders identically.
 *
 * Returns `null` when the difference is visible — the marking already shows it and a note would be noise.
 * Only characters present on ONE side are reported, so a tab that survives preparation is not blamed for
 * a change it was not part of.
 */
export function describeInvisibleChange(before: string, after: string): string | null {
  const a = before ?? "";
  const b = after ?? "";
  if (a === b || collapse(a) !== collapse(b)) return null;
  const gone = INVISIBLES.filter((i) => i.test.test(a) && !i.test.test(b)).map((i) => i.label);
  const added = INVISIBLES.filter((i) => i.test.test(b) && !i.test.test(a)).map((i) => i.label);
  if (gone.length === 0 && added.length === 0) {
    return "Nothing visible changed: the difference is in characters that draw nothing, so the two read identically on screen.";
  }
  // Phrased with the VERB first (`removed a no-break space`) rather than as a passive subject
  // (`a no-break space was removed`), so a plural label like "repeated spaces" reads correctly too.
  const parts: string[] = [];
  if (gone.length) parts.push(`removed ${gone.join(" and ")}`);
  if (added.length) parts.push(`introduced ${added.join(" and ")}`);
  return `Nothing visible changed: preparation ${parts.join(", and ")}.`;
}

/** The `before` side reconstructed from a diff — what was there, with removals still in place. */
export function beforeOf(diff: WordDiff): string {
  return diff.segments
    .filter((s) => s.kind !== "added")
    .map((s) => s.text)
    .join("");
}

/** The `after` side reconstructed from a diff. */
export function afterOf(diff: WordDiff): string {
  return diff.segments
    .filter((s) => s.kind !== "removed")
    .map((s) => s.text)
    .join("");
}
