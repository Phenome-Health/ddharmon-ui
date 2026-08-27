import { useMemo } from "react";
import { wordDiff } from "@/lib/text-diff";

/**
 * One side of a before/after pair, with the words that moved marked in place.
 *
 * THE PROBLEM IT SOLVES. Preparation's edits are usually small and interior — a stripped `<p>`, one
 * dropped administrative clause, a collapsed run of spaces. Presented as two paragraphs of prose they are
 * effectively invisible, so the reviewer authorises the run's first charge without having found the change
 * the screen is reporting. Marking is the panel's job, not its styling.
 *
 * TWO CHANNELS, NEVER COLOUR ALONE. A removal is struck through as well as washed; an addition is
 * underlined as well as washed. Colour alone would put the whole point of the screen behind normal colour
 * vision, and the two washes are the existing status registers rather than a new red/green family, so a
 * rebrand moves them with everything else.
 *
 * IT RENDERS THE STRING, NOT A SUMMARY. The segments concatenate back to the exact value for this side —
 * `textContent` is byte-identical to the raw string — so a test (or a reader copying it out) gets what the
 * file or the model actually holds. That is the same guarantee the 2026-08-26 review restored when it
 * removed the `[:80]` truncation from these panels, and marking must not quietly undo it.
 */
export function DiffText({
  before,
  after,
  side,
  empty,
  className = "",
  testId,
}: {
  before: string;
  after: string;
  /** Which half of the pair this is: removals show on `before`, additions on `after`. */
  side: "before" | "after";
  /** What to render when this side's value is empty — the panels distinguish "(empty)" from "(cleared)". */
  empty: string;
  className?: string;
  testId?: string;
}) {
  const diff = useMemo(() => wordDiff(before, after), [before, after]);
  const value = side === "before" ? before : after;
  const base = `whitespace-pre-wrap break-words text-xs text-on-raised ${className}`;

  if (!value) {
    return (
      <p data-testid={testId} className={base}>
        <span className="text-on-raised-muted">{empty}</span>
      </p>
    );
  }
  // Nothing to mark. Rendered as plain text rather than as a single unstyled span so an unchanged pair
  // looks unchanged — a screen where everything is marked teaches the reader to ignore the marking.
  if (!diff.changed) {
    return (
      <p data-testid={testId} className={base}>
        {value}
      </p>
    );
  }

  const mine = side === "before" ? "removed" : "added";
  return (
    <p data-testid={testId} data-diff-coarse={String(diff.coarse)} className={base}>
      {diff.segments
        .filter((s) => s.kind === "same" || s.kind === mine)
        .map((s, i) =>
          s.kind === "same" ? (
            <span key={i}>{s.text}</span>
          ) : s.kind === "removed" ? (
            <del
              key={i}
              data-diff="removed"
              className="rounded-[2px] bg-surface-danger px-[1px] text-on-danger decoration-2"
            >
              {s.text}
            </del>
          ) : (
            <ins
              key={i}
              data-diff="added"
              className="rounded-[2px] bg-surface-ok px-[1px] text-on-ok underline decoration-2 underline-offset-2"
            >
              {s.text}
            </ins>
          ),
        )}
    </p>
  );
}
