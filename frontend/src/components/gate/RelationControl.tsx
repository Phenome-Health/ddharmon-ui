import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { SKOS_RELATIONS, SKOS_RELATION_LABEL, type RelationView, type SkosRelation } from "@/lib/gate23";
import { cn } from "@/lib/utils";

/**
 * The relation the reviewer asserts between a source concept and the element it takes.
 *
 * WHY THIS IS A CONTROL AND NOT A DERIVED LABEL. The verdict (`adopt` / `refine` / `novel`) says how the
 * PIPELINE got to a target; the relation says what the reviewer claims is TRUE of the pair. Those come
 * apart constantly — a `refine` can be a genuine narrowing or merely a representation change, and the
 * difference is what a downstream consumer of the crosswalk needs. Deriving one from the other would
 * record a claim nobody made.
 *
 * SKOS, BECAUSE THE CDE MODEL HAS NO PREDICATE OF ITS OWN. Core already stamps `skos:*` on a refined
 * element (`GenCDE.relation`), so this vocabulary is core's, not a second one invented for the browser.
 *
 * NOTHING IS PRESELECTED AS A DECISION. When the reviewer has asserted nothing, the lit button is the MODEL's
 * relation for this edge (`view.source === "model"`), said out loud as the model's and drawn outlined rather
 * than filled; the caller writes a decision only on an actual pick — a run nobody touched must not come out
 * carrying relation assertions. Clicking the model's lit button CONFIRMS it (a single-select toggle group would
 * otherwise read that click as "un-set"). Once the reviewer asserts one, the model's stays on screen beside it,
 * so an override never hides what it replaced (08-28 3f).
 */
export function RelationControl({
  view,
  onChange,
  disabled,
  className,
}: {
  view: RelationView;
  onChange: (relation: SkosRelation) => void;
  disabled?: boolean;
  className?: string;
}) {
  const { active, source, model, overridden } = view;
  return (
    <div data-testid="relation-control" data-source={source} className={cn("flex flex-col gap-2", className)}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h3 className="text-sm font-semibold text-on-raised">Relation to the chosen target</h3>
        <span data-testid="relation-status" className="text-xs text-on-raised-muted">
          {source === "model"
            ? "the model's — not yet confirmed by you"
            : source === "none"
              ? "not recorded — the model asserted none for this target"
              : overridden
                ? "yours — overrides the model's"
                : model
                  ? "yours — agrees with the model"
                  : "yours — the model asserted none for this target"}
        </span>
        {source === "reviewer" && model && (
          <span
            data-testid="relation-model"
            className="rounded-pill border border-rule-on-raised px-2 py-0.5 text-xs text-on-raised-muted"
          >
            model: {model}
          </span>
        )}
      </div>
      <ToggleGroup
        type="single"
        value={active ?? ""}
        disabled={disabled}
        onValueChange={(v) => {
          if (v) onChange(v as SkosRelation);
          // Radix reports a click on the lit button as "" (deselect). On the MODEL's lit button that click is the
          // reviewer confirming it; on their own it is a no-op (Clear is the explicit way to un-record).
          else if (source === "model" && active) onChange(active);
        }}
        className="flex flex-wrap justify-start gap-2"
      >
        {SKOS_RELATIONS.map((relation) => (
          <ToggleGroupItem
            key={relation}
            value={relation}
            data-relation={relation}
            aria-label={`${relation} — ${SKOS_RELATION_LABEL[relation]}`}
            title={SKOS_RELATION_LABEL[relation]}
            className={cn(
              "h-7 min-w-0 rounded-pill border border-rule-control-on-raised bg-surface-raised px-3 text-xs",
              "text-on-raised hover:bg-surface-inset hover:text-on-raised",
              source === "reviewer"
                ? "data-[state=on]:border-accent-action data-[state=on]:bg-accent-action data-[state=on]:text-on-accent-action data-[state=on]:hover:bg-accent-action-hover data-[state=on]:hover:text-on-accent-action"
                : // The model's position is outlined, never filled: it must not look like a recorded answer.
                  "data-[state=on]:border-accent-action data-[state=on]:bg-surface-raised data-[state=on]:text-accent-on-raised data-[state=on]:hover:bg-surface-inset",
            )}
          >
            {relation.replace("skos:", "")}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <p className="max-w-[68ch] text-xs text-on-raised-muted">
        {active
          ? `${active} — ${SKOS_RELATION_LABEL[active]}.`
          : "Pick the one that is true of this concept and the target. The export carries it beside the model's."}
      </p>
    </div>
  );
}

/**
 * The Gate 2 panel for ONE (group, target) edge: the relation (for a catalog target) and a free-text note, both
 * written as the edge's `gate2_relation` decision. The page owns the state and the writes; this renders them.
 *
 * The group's OWN generated element gets the note only (`ownTarget`): it was written for this concept, so a SKOS
 * predicate to it would present a generated element as a catalog one.
 */
export function RelationPanel({
  view,
  ownTarget,
  targetId,
  note,
  noteDirty,
  saved,
  local,
  canClear,
  frozen,
  onPick,
  onNoteChange,
  onSaveNote,
  onClear,
}: {
  view: RelationView;
  ownTarget: boolean;
  /** The edge's target id — the relation decision's `targetId`. */
  targetId: string;
  note: string;
  /** The note on screen differs from the saved one. */
  noteDirty: boolean;
  /** The last note save of this edge LANDED (set off the write's result, never off having pressed Save). */
  saved: boolean;
  /** Writes stay in this browser (a demo or a static build). */
  local: boolean;
  /** A relation or note is recorded for this edge. */
  canClear: boolean;
  frozen: boolean;
  onPick: (relation: SkosRelation) => void;
  onNoteChange: (note: string) => void;
  onSaveNote: () => void;
  onClear: () => void;
}) {
  return (
    <section
      data-testid="relation-panel"
      data-target-id={targetId}
      className="flex flex-col gap-3 rounded-card border border-rule-on-raised px-5 py-4"
    >
      {ownTarget ? (
        <div className="flex flex-col gap-1">
          <h3 className="text-sm font-semibold text-on-raised">Your note on this target</h3>
          <p data-testid="relation-own-target" className="max-w-[68ch] text-xs text-on-raised-muted">
            The target is this concept&apos;s own generated CDE, written for it — so there is no catalog relation to
            assert. A note travels with it into the export and the decision log.
          </p>
        </div>
      ) : (
        <RelationControl view={view} onChange={onPick} disabled={frozen} />
      )}
      <div className="flex flex-col gap-1">
        <label htmlFor="relation-note" className="text-xs font-semibold text-on-raised">
          {ownTarget ? "Note" : "Note on this match"}
          <span className="font-normal text-on-raised-muted"> — optional; exported and logged with it</span>
        </label>
        <Textarea
          id="relation-note"
          data-testid="relation-note-input"
          value={note}
          disabled={frozen}
          onChange={(e) => onNoteChange(e.target.value)}
          placeholder={ownTarget ? "Why this target, or what you checked" : "Why this relation, or what you checked"}
          className="min-h-14 text-sm"
        />
      </div>
      {!frozen && (
        <div className="flex flex-wrap items-center gap-2">
          <Button data-testid="relation-note-save" variant="outline" size="sm" onClick={onSaveNote}>
            Save note
          </Button>
          {canClear && (
            <Button data-testid="relation-clear" variant="outline" size="sm" onClick={onClear}>
              {ownTarget ? "Clear note" : "Clear relation and note"}
            </Button>
          )}
          {noteDirty ? (
            <span data-testid="relation-note-unsaved" className="text-xs text-on-raised-muted">
              Unsaved
            </span>
          ) : (
            saved && (
              <span
                data-testid="relation-saved"
                role="status"
                className="inline-flex items-center gap-1 text-xs text-on-raised-muted"
              >
                <Check aria-hidden="true" className="h-3.5 w-3.5 text-status-ok" />
                {local ? "Saved in this browser" : "Saved"}
              </span>
            )
          )}
        </div>
      )}
    </section>
  );
}
