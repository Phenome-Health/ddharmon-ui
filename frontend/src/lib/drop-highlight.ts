/**
 * WHICH DROP TARGET IS UNDER THE CURSOR — the algebra behind the live highlight (08-16c review, item D).
 *
 * Bhargav, annotating the live Gate 1: *"the drag drop behavior should have dynamic highlighting of which
 * group is being dragged onto (including no group area) so user knows that theyre dropping their var in
 * the intended place."*
 *
 * WHY IT IS A COUNTER AND NOT A BOOLEAN. `dragleave` fires on an element when the pointer crosses into one
 * of its CHILDREN, not only when it leaves the element for good. A zone that set `over = false` on every
 * `dragleave` therefore goes dark the instant the cursor passes over the label, the chip or the table row
 * inside it — which is to say, for most of the time the reviewer is actually aiming at it. The child's
 * `dragenter` and the parent's `dragleave` arrive as a BALANCED PAIR, so counting them nets to zero and the
 * zone stays lit. That is the whole reason this is arithmetic rather than a flag.
 *
 * WHY GEOMETRY AND NEVER THE PAYLOAD. The dragged data is NOT readable during `dragover`/`dragenter` in
 * every browser — the rule already recorded on `MemberChip`'s `MemberDropZone` and again on the evidence
 * grid in `source-rows.tsx`, both of which read the member id on DROP for exactly this reason. So a target
 * cannot decide whether to light up by asking what is being dragged; it lights up because the pointer is
 * inside it, and nothing here ever touches `dataTransfer`.
 *
 * WHY `end` EXISTS ALONGSIDE `drop`. A drag can finish WITHOUT a drop — released over nothing, or
 * cancelled — and no `dragleave` is guaranteed on the way out. Without a reset the zone stays lit for the
 * rest of the session, permanently naming a destination nobody is aiming at, which is worse than no
 * highlight at all: it is a confident wrong answer to the question the feature exists to answer.
 *
 * PURE, AND IN `lib/` FOR THE STANDING TWO REASONS (see `lib/ledger.ts`): `frontend/` has no component test
 * runner, so behaviour reachable only through React ships unasserted; and nothing here reads
 * `import.meta.env`, so a Playwright spec can import it in the node runtime.
 */

/** What just happened to the pointer, from one drop target's point of view. */
export type DragCue = "enter" | "leave" | "drop" | "end";

/**
 * The zone's new nesting depth after `cue`.
 *
 * CLAMPED AT ZERO, and that is not defensive tidiness. A `dragleave` with no matching `dragenter` is
 * ordinary — it is what a drag STARTED inside the zone produces — and if it banked a −1 the next genuine
 * enter would land on 0 and the zone would silently refuse to light for the rest of the drag.
 */
export function nextDepth(depth: number, cue: DragCue): number {
  switch (cue) {
    case "enter":
      return depth + 1;
    case "leave":
      return Math.max(0, depth - 1);
    case "drop":
    case "end":
      return 0;
  }
}

/** Whether this zone is the one the pointer is currently inside. */
export function isOver(depth: number): boolean {
  return depth > 0;
}
