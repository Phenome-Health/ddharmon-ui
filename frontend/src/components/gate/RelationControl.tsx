import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { SKOS_RELATIONS, SKOS_RELATION_LABEL, type SkosRelation } from "@/lib/gate23";
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
 * NOTHING IS PRESELECTED AS A DECISION. `suggested` positions the control at the pipeline's implied
 * relation so the reviewer starts somewhere sensible, and the caller writes a decision only on an actual
 * pick — a run nobody touched must not come out carrying relation assertions.
 */
export function RelationControl({
  value,
  suggested,
  onChange,
  disabled,
  className,
}: {
  /** The persisted relation, or undefined when the reviewer has not asserted one. */
  value?: SkosRelation;
  /** Where the control sits before the reviewer picks — a suggestion, not a record. */
  suggested: SkosRelation;
  onChange: (relation: SkosRelation) => void;
  disabled?: boolean;
  className?: string;
}) {
  const active = value ?? suggested;
  return (
    <section data-testid="relation-control" className={cn("flex flex-col gap-2", className)}>
      <div className="flex items-baseline gap-2">
        <h3 className="text-sm font-semibold text-on-raised">Relation to the chosen target</h3>
        {!value && (
          // Said out loud rather than left to the highlight: a control that LOOKS answered and is not is
          // how an unmade decision gets exported as a made one.
          <span className="text-xs text-on-raised-muted">suggested — not yet recorded</span>
        )}
      </div>
      <ToggleGroup
        type="single"
        value={active}
        disabled={disabled}
        onValueChange={(v) => v && onChange(v as SkosRelation)}
        className="flex flex-wrap justify-start gap-2"
      >
        {SKOS_RELATIONS.map((relation) => (
          <ToggleGroupItem
            key={relation}
            value={relation}
            data-relation={relation}
            aria-label={`${relation} — ${SKOS_RELATION_LABEL[relation]}`}
            className="rounded-pill border border-rule-on-raised px-3 py-1 font-mono text-xs"
          >
            {relation.replace("skos:", "")}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <p className="max-w-[68ch] text-xs text-on-raised-muted">{SKOS_RELATION_LABEL[active]}</p>
    </section>
  );
}
