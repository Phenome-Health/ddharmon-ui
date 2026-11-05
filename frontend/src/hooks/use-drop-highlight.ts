import { useEffect, useState } from "react";
import { isOver, nextDepth, type DragCue } from "@/lib/drop-highlight";

/**
 * One drop target's "the pointer is inside me" state, and the two listeners that stop it getting stuck
 * (08-16c review, item D).
 *
 * THE THIN WRAPPER IS DELIBERATE. All of the reasoning — why a counter rather than a boolean, why the
 * depth clamps at zero, why `end` exists beside `drop` — lives in `lib/drop-highlight.ts`, where it is
 * pure and asserted in node. This adds only the React state and the window listeners, which is the part a
 * spec cannot reach anyway.
 *
 * THE WINDOW LISTENERS ARE THE STUCK-HIGHLIGHT GUARD. `dragend` fires on the drag SOURCE and bubbles to
 * the document, so a drag released over nothing — or cancelled with Escape — reaches every lit zone even
 * though none of them saw a `dragleave`. `drop` is listened for as well because a zone that stops the
 * event's React propagation (which `MemberDropZone` does, deliberately, so a drop lands on the innermost
 * destination) still lets the NATIVE event continue past the React root — so a drop anywhere on the page
 * clears every other zone, not only the one that handled it.
 *
 * BOUND ONLY WHILE LIT. Nothing is listening on a page where no drag is in flight, and the cleanup runs on
 * every depth change, so the pair can never outlive the state it resets.
 */
export function useDropHighlight(): {
  /** True while the pointer is inside this zone — what the caller renders and marks in the DOM. */
  over: boolean;
  /** Record one cue. Call from `onDragEnter` / `onDragLeave` / `onDrop`. */
  cue: (c: DragCue) => void;
} {
  const [depth, setDepth] = useState(0);

  useEffect(() => {
    if (depth === 0) return;
    const clear = () => setDepth(0);
    window.addEventListener("dragend", clear);
    window.addEventListener("drop", clear);
    return () => {
      window.removeEventListener("dragend", clear);
      window.removeEventListener("drop", clear);
    };
  }, [depth]);

  return { over: isOver(depth), cue: (c) => setDepth((d) => nextDepth(d, c)) };
}
