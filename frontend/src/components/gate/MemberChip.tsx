import { GripVertical } from "lucide-react";
import { cn } from "@/lib/utils";
import { useDropHighlight } from "@/hooks/use-drop-highlight";

/**
 * One member variable, as a draggable chip.
 *
 * DECLARED AT MODULE SCOPE, AND THAT IS LOAD-BEARING. A component defined inside the page that renders it
 * is a NEW COMPONENT TYPE on every render, so React unmounts and remounts every chip — which cancels any
 * drag in flight. That was discovered on the drag prototype branch and is recorded here so it is not
 * rediscovered. Never move this into a page.
 *
 * NATIVE HTML5 DRAG AND DROP, no package. The phase introduces no npm dependency, and a chip that carries
 * an id from one list to another needs nothing a library adds (UI-SPEC §11).
 *
 * THE DRAG PAYLOAD is the member's id, on the `text/plain` type — the only type every browser guarantees on
 * a drop, and the one a drop target can read during `dragover` on none of them, which is why the drop
 * handler reads it and the dragover handler only accepts.
 *
 * TEAL IS FOR THE COHORT CODE, one of its exactly four reserved uses (UI-SPEC §5.4), and on paper it is
 * `--accent-2-on-raised` — the ink form. The bright form fails contrast on paper and is prohibited there.
 */

export const MEMBER_DRAG_TYPE = "text/plain";

/** The drop target for "no group" — a real destination, not a special-cased sentinel. */
export const UNASSIGNED_GROUP_ID = "__unassigned__";

export interface MemberChipProps {
  /** The member id, `cohort:variable`. Carried as the drag payload. */
  memberId: string;
  /** The cohort code, rendered in mono — the machine produced it. */
  cohort: string;
  /** The variable name as the dictionary spells it. */
  variable: string;
  /** True once the reviewer has moved this variable — the "you changed it" register. */
  moved?: boolean;
  draggable?: boolean;
  className?: string;
}

export function MemberChip({
  memberId,
  cohort,
  variable,
  moved = false,
  draggable = true,
  className,
}: MemberChipProps) {
  return (
    <span
      data-testid="member-chip"
      data-member-id={memberId}
      // The moved state as DATA as well as as a border colour. It is derived from a persisted decision, so
      // a gate asserting "this correction survived a reload" has to read it rather than eyeball a hue.
      data-moved={String(moved)}
      draggable={draggable}
      onDragStart={(e) => {
        e.dataTransfer.setData(MEMBER_DRAG_TYPE, memberId);
        e.dataTransfer.effectAllowed = "move";
      }}
      // The chip IS the control, so the name goes here rather than on the handle glyph inside it.
      aria-label={`Drag ${variable} from ${cohort} into another group`}
      className={cn(
        // A chip never takes the container radius — pill geometry at instrument level (UI-SPEC §4).
        "inline-flex min-h-8 max-w-full items-center gap-1 rounded-pill border px-2 py-1",
        moved ? "border-accent-on-raised" : "border-rule-control-on-raised",
        className,
      )}
    >
      {draggable && <GripVertical aria-hidden="true" className="h-3 w-3 shrink-0 text-on-raised-faint" />}
      <span className="shrink-0 font-mono text-xs font-semibold text-accent-2-on-raised">{cohort}</span>
      <span className="truncate text-xs text-on-raised" title={variable}>
        {variable}
      </span>
    </span>
  );
}

/**
 * A drop destination for member chips. Reads the payload on DROP, not on dragover — the payload is not
 * readable during dragover in every browser, so a target that tried to inspect it there would reject
 * legitimate drags.
 *
 * IT SAYS SO WHILE THE POINTER IS INSIDE IT (08-16c review, item D). Bhargav: *"the drag drop behavior
 * should have dynamic highlighting of which group is being dragged onto (including no group area) so user
 * knows that theyre dropping their var in the intended place."* The state comes from
 * `useDropHighlight`, whose docstring carries the two constraints that shape it — the highlight is decided
 * by ENTER/LEAVE GEOMETRY and never by inspecting the payload (which is unreadable here), and a counter
 * rather than a boolean, so crossing a child does not extinguish it.
 *
 * `dragenter` AND `dragleave` BOTH STOP AT THE INNERMOST ZONE, which is what makes exactly one target
 * light up. A nested zone that stopped only ONE of the pair would leave the enclosing row's count
 * unbalanced — lit alongside its own child in one direction, dark over its own body in the other. It is
 * the same rule `dragover` and `drop` below already follow, extended to the pair that drives the cue.
 */
export function MemberDropZone({
  groupId,
  label,
  onDropMember,
  children,
  className,
}: {
  /** The group the drop assigns to. `UNASSIGNED_GROUP_ID` is a real destination. */
  groupId: string;
  label: string;
  onDropMember: (memberId: string, groupId: string) => void;
  children?: React.ReactNode;
  className?: string;
}) {
  const { over, cue } = useDropHighlight();
  return (
    <div
      data-testid="member-drop-zone"
      data-group-id={groupId}
      // The live cue as DATA as well as as a ring: "which target am I over" is behaviour, so a gate
      // asserting it has to READ it rather than eyeball a colour. Same contract the chips carry for
      // `data-moved`, and the one `LedgerRow` already carries.
      data-drop-over={over ? "true" : undefined}
      role="group"
      aria-label={label}
      onDragEnter={(e) => {
        e.preventDefault();
        e.stopPropagation();
        cue("enter");
      }}
      onDragLeave={(e) => {
        e.stopPropagation();
        cue("leave");
      }}
      onDragOver={(e) => {
        e.preventDefault();
        // STOPS AT THE INNERMOST ZONE. A drop zone nested inside a droppable ledger row would otherwise
        // let the row light up as the destination while the cursor is over the tray inside it.
        e.stopPropagation();
        e.dataTransfer.dropEffect = "move";
      }}
      onDrop={(e) => {
        e.preventDefault();
        // LOAD-BEARING. Without it the drop bubbles to the enclosing ledger row, whose own handler runs
        // SECOND and moves the variable straight back into the group it was just dragged out of — so
        // dropping onto the no-group tray silently did nothing. Found in test, and invisible by
        // inspection: each handler is correct on its own.
        e.stopPropagation();
        cue("drop");
        const memberId = e.dataTransfer.getData(MEMBER_DRAG_TYPE);
        if (memberId) onDropMember(memberId, groupId);
      }}
      className={cn(
        "flex flex-wrap gap-1 rounded-inner border border-dashed border-rule-on-raised p-3",
        // A RING, not a fill. These zones sit on several different surfaces and two of them already carry
        // state of their own (the pool's card, the emptied-group band); repainting the surface would
        // overwrite that, while an inset ring reads on every one of them.
        over && "ring-2 ring-inset ring-rule-info",
        className,
      )}
    >
      {children}
    </div>
  );
}
