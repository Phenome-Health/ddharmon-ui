// An Excel/sheets-style grid of the RAW data-dictionary rows behind a concept group — one row per pooled
// variable, columns = the fields as they were ingested. This is the evidence layer under every derived claim
// in the workbench (summary, GenCDE, value mapping): a reviewer can verify those against the ground-truth
// metadata without leaving the app, and an over-merge (is this really 25 BP vars, or BP+pulse mislumped?)
// becomes obvious at a glance.
//
// Reads the already-persisted contract only — member ids ("cohort:var" keys) into `fieldIndex` — so it
// slots into EXISTING runs with no re-run or migration. For a run that predates `fieldIndex` it degrades to
// `memberDetails` (name + embedded text), then to the raw id: fewer columns, never a crash.
//
// LIFTED TO GATE 1, 2026-08-31 (the inherited-UI audit's verdict on this file). It was reachable only from
// the workbench, which is downstream of assignment — but the judgement it supports is Gate 1's: "is this
// really 25 blood-pressure variables, or blood-pressure plus pulse mislumped?" is exactly what a reviewer
// is asked at the concept-group gate, and asking it from a generated name and a row of chips leaves the
// evidence one screen away.
//
// THE ADAPT IS THE SIGNATURE, AND ONLY THE SIGNATURE. It took a whole `UIRecord`, which is a POST-ASSIGN
// shape — it carries a verdict, a route, a CDE and ranked candidates, none of which exist yet at Gate 1,
// whose row is a `ConceptGroup`. So it now takes the two things it ever read: the member ids and the
// optional per-member detail. Both call sites pass what they hold, and there is still ONE grid — building
// a second for Gate 1 is the duplication the audit exists to catch.
import { GripVertical, Undo2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { MEMBER_DRAG_TYPE } from "@/components/gate/MemberChip";
import { useDropHighlight } from "@/hooks/use-drop-highlight";
import type { FieldDetail, UIMember } from "@/types";

// Bound a pathological over-merge so the grid stays a bounded widget, never a page-blowing dump. The
// scroll region already caps height; this caps the DOM row count. Overflow is surfaced with a footer note.
const ROW_CAP = 100;

// A variable name the loader synthesized (no usable id column in the source) — not worth showing raw.
const isSyntheticName = (n: string): boolean => /^_ROW_\d+$/.test(n);

interface SourceRow {
  id: string; // "cohort:var"
  cohort: string;
  name: string;
  synthetic: boolean;
  text: string; // the cleaned signal actually embedded (may differ from the raw description/question)
  description?: string;
  questionText?: string;
  valueEncoding?: string;
  units?: string;
  dataType?: string;
}

// The coded response options, as a compact "code=label | code=label" string. Prefers the parsed
// responseOptions; falls back to the inline valueEncoding string the source carried.
function encodingText(fd: FieldDetail | undefined): string | undefined {
  if (!fd) return undefined;
  if (fd.responseOptions?.length) {
    return fd.responseOptions.map((o) => (o.label ? `${o.code}=${o.label}` : o.code)).join(" | ");
  }
  return fd.valueEncoding || undefined;
}

function buildRows(
  memberIds: string[],
  memberDetails: UIMember[] | undefined,
  fieldIndex: Record<string, FieldDetail>,
): SourceRow[] {
  // The caller's ordered member list; fall back to memberDetails ids for older shapes.
  const ids = memberIds.length ? memberIds : (memberDetails ?? []).map((m) => m.id);
  const byId = new Map((memberDetails ?? []).map((m) => [m.id, m]));
  return ids.map((id) => {
    const fd = fieldIndex[id];
    const md = byId.get(id);
    const i = id.indexOf(":");
    const cohort = md?.cohort ?? (i > 0 ? id.slice(0, i) : "");
    const name = fd?.name ?? md?.name ?? (i > 0 ? id.slice(i + 1) : id);
    const text = fd?.text ?? md?.text ?? name;
    return {
      id,
      cohort,
      name,
      synthetic: isSyntheticName(name),
      text,
      description: fd?.description,
      questionText: fd?.questionText,
      valueEncoding: encodingText(fd),
      units: fd?.units,
      dataType: fd?.dataType,
    };
  });
}

/**
 * Would `SourceRows` render anything for these members?
 *
 * EXPORTED BECAUSE GATE 1 HAS TO KNOW (08-14h Task 5). Since the tile strip merged into this grid, the
 * grid is the group's ONLY membership view — so when it declines to render, the caller has to put the
 * chips back or the reviewer sees a group with no members at all. The caller cannot infer that from a
 * component that returns null, so the question is answered here, by the same expression the component
 * itself uses. Two copies of this test drifting apart would show an empty expanded row.
 */
export function hasSourceRows(
  memberIds: string[],
  memberDetails: UIMember[] | undefined,
  fieldIndex: Record<string, FieldDetail>,
): boolean {
  const rows = buildRows(memberIds, memberDetails, fieldIndex);
  // Ids alone are not evidence: with no `fieldIndex` and no `memberDetails` every column but the two the
  // caller already renders as a chip would be a dash.
  return rows.length > 0 && rows.some((r) => r.description || r.questionText || r.valueEncoding || r.units || r.dataType);
}

/**
 * Making the grid's rows the thing a reviewer drags (08-14h Task 5).
 *
 * Bhargav, on the live run: *"the draggable var tiles + the spreadsheet style rows are redundant… have
 * the tiles be embedded into the spreadsheet layout such that the user can drag from the row directly
 * rather than have to look at both."* He is right — the reviewer was being asked to hold two renderings
 * of the same variable in their head and match them up.
 *
 * THE GRID IS THE SURVIVOR because it carries the metadata a coherence judgement actually needs; the
 * tiles carried only a name. This prop is what lets the grid take the tiles' job WITHOUT the workbench —
 * the other call site, which has no notion of regrouping — growing a drag affordance it has no handler
 * for. Omit it and this file behaves exactly as it did before.
 */
export interface SourceRowsDrag {
  /** The group these rows belong to. Dropping a variable here moves it into that group. */
  groupId: string;
  /** Accessible name for the drop destination. */
  label: string;
  onDropMember: (memberId: string) => void;
  /**
   * The row's own verb — THE KEYBOARD PATH, and the reason it is a discriminated kind rather than one
   * callback (08-16c review, item A).
   *
   * Native HTML5 drag and drop has NO keyboard equivalent, so a grid whose only verb is a drag is a
   * regression on this screen. But the verb is not the same everywhere the grid now renders: in a GROUP it
   * takes a variable out ("this does not belong here"), while in the reviewer's half of the pool it PUTS
   * ONE BACK. Two different actions with two different names, so the kind is named and the copy is
   * derived from it, rather than one `onRemoveMember` being labelled differently by each caller.
   *
   * OPTIONAL, because one place genuinely has no verb: the clustering's own leftovers were never in a
   * group, so there is nowhere to put them back TO. They are still draggable — placing one is a choice
   * only the reviewer can make — but a button offering an action that cannot be honoured is worse than
   * none. The workbench passes no `drag` at all and is unaffected either way.
   */
  action?: {
    kind: "remove" | "restore";
    onAct: (memberId: string) => void;
  };
  /** Member ids the reviewer has already moved, so a row can say so. */
  movedMembers: ReadonlySet<string>;
}

/** What each row verb is called and drawn as. One register, so no call site re-spells it. */
const ROW_ACTION = {
  remove: {
    testId: "member-remove",
    Icon: X,
    /** Names the ACTION AND ITS OBJECT — "remove" alone tells a screen-reader user nothing about which row. */
    name: (variable: string, cohort: string) => `Take ${variable} from ${cohort} out of this group`,
    title: (variable: string) => `Take ${variable} out of this group`,
    column: "Move or remove this variable",
  },
  restore: {
    testId: "pool-put-back",
    Icon: Undo2,
    name: (variable: string, cohort: string) => `Put ${variable} from ${cohort} back in the group it came from`,
    title: () => "Put this back in the group it came from",
    column: "Move this variable, or put it back",
  },
} as const;

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      className={cn(
        "border-b border-rule-on-raised px-2.5 py-1.5 text-left align-bottom font-semibold uppercase tracking-eyebrow text-on-raised-muted",
        className,
      )}
    >
      {children}
    </th>
  );
}

// A wrapping text cell with a bounded width and a native tooltip for the full value. Empty → muted dash.
function TextCell({ value, className }: { value?: string; className?: string }) {
  if (!value) return <td className="px-2.5 py-1.5 align-top text-on-raised-muted">—</td>;
  return (
    <td className={cn("px-2.5 py-1.5 align-top text-on-raised", className)} title={value}>
      <span className="block min-w-[12rem] max-w-[24rem] whitespace-pre-wrap break-words">{value}</span>
    </td>
  );
}

/** The raw source-dictionary rows behind a concept group, as a bounded, horizontally-scrollable grid.
 *  Optional columns render only when at least one member carries that field, so older/sparse runs stay clean.
 *
 *  RETURNS NULL WHEN THERE IS NOTHING TO SHOW, which is the caller's cue to fall back to whatever
 *  membership view it already has. An empty grid would claim the rows are missing from the dictionary;
 *  they are missing from this RUN's payload, which is a different thing. */
export function SourceRows({
  memberIds,
  memberDetails,
  fieldIndex,
  drag,
}: {
  /** The group's member ids, `cohort:var`, in the order the pipeline pooled them. */
  memberIds: string[];
  /** Per-member name and embedded text, when the caller's shape carries it. */
  memberDetails?: UIMember[];
  fieldIndex: Record<string, FieldDetail>;
  /** Present only where regrouping is offered (Gate 1). The workbench passes nothing and is unchanged. */
  drag?: SourceRowsDrag;
}) {
  // BEFORE THE EARLY RETURN, because a hook cannot be called conditionally. `over` is read only where
  // `drag` is present; the workbench's call site passes none and is unchanged.
  const { over, cue } = useDropHighlight();
  const rows = buildRows(memberIds, memberDetails, fieldIndex);
  if (!hasSourceRows(memberIds, memberDetails, fieldIndex)) return null;

  const shown = rows.slice(0, ROW_CAP);
  const extra = rows.length - shown.length;
  const has = (pred: (r: SourceRow) => boolean) => rows.some(pred);

  // Optional columns: show a column only when some member actually carries it (keeps pre-fieldIndex and
  // sparse-dictionary runs from rendering a wall of empty cells).
  const showDesc = has((r) => !!r.description);
  const showQ = has((r) => !!r.questionText);
  const showEnc = has((r) => !!r.valueEncoding);
  const showUnits = has((r) => !!r.units);
  const showType = has((r) => !!r.dataType);
  // The embedded signal is worth its own column only where it DIFFERS from the raw description/question —
  // i.e. the pipeline cleaned it or fell back to another field. That difference is the debugging signal.
  const showEmbedded = has((r) => !!r.text && r.text !== r.description && r.text !== r.questionText);

  return (
    // `min-w-0` is load-bearing INSIDE THE GATE 1 EXPANDED ROW. Its parent is a flex column, whose items
    // default to `min-width: auto` and therefore refuse to shrink below their content — so without this
    // the widest cell would push the ledger's own columns sideways and give the whole page a horizontal
    // scrollbar. Wide content scrolls in the container below instead.
    <div data-testid="source-rows" className="min-w-0 space-y-1.5">
      <div
        data-testid="source-rows-scroll"
        // THE GRID IS THE GROUP'S DROP DESTINATION now that the tile strip is gone. It reads the payload
        // on DROP rather than on dragover — the payload is not readable during dragover in every browser,
        // so a target that inspected it there would reject legitimate drags (the rule `MemberDropZone`
        // already records). `stopPropagation` keeps a drop landing on the innermost destination.
        //
        // AND IT SAYS WHEN IT IS THE TARGET (08-16c review, item D). Same `useDropHighlight` every other
        // drop zone on this screen uses, driven by enter/leave GEOMETRY for the very reason recorded
        // above: the payload cannot be read before the drop, so the cue cannot depend on it.
        {...(drag
          ? {
              "data-group-id": drag.groupId,
              "data-drop-over": over ? "true" : undefined,
              role: "group",
              "aria-label": drag.label,
              onDragEnter: (e: React.DragEvent) => {
                e.preventDefault();
                e.stopPropagation();
                cue("enter");
              },
              onDragLeave: (e: React.DragEvent) => {
                e.stopPropagation();
                cue("leave");
              },
              onDragOver: (e: React.DragEvent) => {
                e.preventDefault();
                e.stopPropagation();
                e.dataTransfer.dropEffect = "move";
              },
              onDrop: (e: React.DragEvent) => {
                e.preventDefault();
                e.stopPropagation();
                cue("drop");
                const memberId = e.dataTransfer.getData(MEMBER_DRAG_TYPE);
                if (memberId) drag.onDropMember(memberId);
              },
            }
          : {})}
        className={cn(
          "max-h-[28rem] overflow-auto rounded-md border border-rule-on-raised",
          drag && over && "ring-2 ring-inset ring-rule-info",
        )}
      >
        <table className="w-full border-collapse text-xs">
          {/* sticky on the <thead> section (with border-collapse) is the combination that actually pins in
              Chromium/Firefox/Safari 16+; sticky on <th> cells silently fails under border-collapse. */}
          <thead className="sticky top-0 z-10 bg-surface-inset">
            <tr>
              {/* THE DRAG CUE GETS ITS OWN COLUMN, ALWAYS VISIBLE. A spreadsheet row does not look
                  draggable, and the first thing a reviewer does on this screen is try to move something —
                  so the affordance cannot be hover-only or tooltip-only. The header cell is empty of
                  visible text but named for assistive technology. */}
              {/* THE ROW-ACTION COLUMN LEADS, and that placement is the point. The grid scrolls
                  HORIZONTALLY, so anything parked at the end of a row is off-screen for a wide
                  dictionary — which would have hidden the drag cue and put the keyboard control behind a
                  sideways scroll. Both live at the row's start, where they are always in view. */}
              {drag && (
                <Th className="w-14">
                  <span className="sr-only">
                    {drag.action ? ROW_ACTION[drag.action.kind].column : "Move this variable"}
                  </span>
                </Th>
              )}
              <Th className="whitespace-nowrap">Cohort</Th>
              <Th className="whitespace-nowrap">Variable</Th>
              {showDesc && <Th>Description</Th>}
              {showQ && <Th>Question</Th>}
              {showEnc && <Th>Value encoding</Th>}
              {showUnits && <Th className="whitespace-nowrap">Units</Th>}
              {showType && <Th className="whitespace-nowrap">Type</Th>}
              {showEmbedded && <Th>Embedded text</Th>}
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr
                key={r.id}
                data-testid={drag ? "member-row" : undefined}
                data-member-id={drag ? r.id : undefined}
                // The moved state as DATA as well as as a colour: it is derived from a persisted
                // decision, so a gate asserting "this correction survived a reload" has to READ it
                // rather than eyeball a hue. Same contract `MemberChip` carries.
                data-moved={drag ? String(drag.movedMembers.has(r.id)) : undefined}
                draggable={drag ? true : undefined}
                onDragStart={
                  drag
                    ? (e) => {
                        e.dataTransfer.setData(MEMBER_DRAG_TYPE, r.id);
                        e.dataTransfer.effectAllowed = "move";
                      }
                    : undefined
                }
                aria-label={drag ? `Drag ${r.name} from ${r.cohort} into another group` : undefined}
                className={cn(
                  "border-b border-rule-quiet-on-raised last:border-0 hover:bg-surface-inset",
                  drag && "cursor-grab",
                  drag && drag.movedMembers.has(r.id) && "bg-surface-inset",
                )}
              >
                {drag && (
                  <td className="whitespace-nowrap px-1 py-1.5 align-top">
                    <span className="flex items-center gap-0.5">
                      {/* The drag cue. ALWAYS RENDERED, never hover-only: a spreadsheet row does not look
                          draggable, and the first thing a reviewer does here is try to move something. */}
                      <GripVertical aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-on-raised-faint" />
                      {/* THE KEYBOARD PATH, and it is not decoration. Native HTML5 drag and drop has NO
                          keyboard equivalent, so before this the only way to correct an over-merged group
                          was with a mouse — a drag with no keyboard path is a regression, not a
                          simplification. A real button: focusable in row order, named for the variable it
                          acts on, performing the row's verb. WHICH verb depends on where the grid is
                          rendered — see `SourceRowsDrag.action`. Moving a variable DIRECTLY from one group
                          into another is still drag-only, and the SUMMARY records that gap rather than
                          implying it is covered. */}
                      {drag.action &&
                        (() => {
                          const verb = ROW_ACTION[drag.action!.kind];
                          const act = drag.action!.onAct;
                          return (
                            <button
                              type="button"
                              data-testid={verb.testId}
                              data-member-id={r.id}
                              onClick={() => act(r.id)}
                              aria-label={verb.name(r.name, r.cohort)}
                              title={verb.title(r.name)}
                              className="shrink-0 rounded-inner p-0.5 text-on-raised-faint hover:bg-surface-inset hover:text-on-raised"
                            >
                              <verb.Icon aria-hidden="true" className="h-3.5 w-3.5" />
                            </button>
                          );
                        })()}
                    </span>
                  </td>
                )}
                <td className="px-2.5 py-1.5 align-top">
                  <Badge variant="neutral" className="font-normal">
                    {r.cohort || "—"}
                  </Badge>
                </td>
                <td className="px-2.5 py-1.5 align-top">
                  {r.synthetic ? (
                    <span className="text-on-raised-muted" title={r.name}>
                      —
                    </span>
                  ) : (
                    <span className="whitespace-nowrap font-mono text-on-raised">{r.name}</span>
                  )}
                </td>
                {showDesc && <TextCell value={r.description} />}
                {showQ && <TextCell value={r.questionText} />}
                {showEnc && <TextCell value={r.valueEncoding} className="font-mono text-on-raised" />}
                {showUnits && (
                  <td className="whitespace-nowrap px-2.5 py-1.5 align-top text-on-raised">{r.units || "—"}</td>
                )}
                {showType && (
                  <td className="whitespace-nowrap px-2.5 py-1.5 align-top text-on-raised">{r.dataType || "—"}</td>
                )}
                {showEmbedded && <TextCell value={r.text} className="italic text-on-raised-muted" />}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {extra > 0 && (
        <div className="text-xs text-on-raised-muted">
          Showing the first {ROW_CAP} of {rows.length} variables — use Export for the full set.
        </div>
      )}
      {showEmbedded && (
        <div className="text-xs text-on-raised-muted">
          <span className="italic">Embedded text</span> is the cleaned signal the pipeline actually embedded, shown
          where it differs from the raw description or question.
        </div>
      )}
    </div>
  );
}
