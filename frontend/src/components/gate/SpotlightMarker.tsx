import { Flashlight } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * Concept Spotlight's mark on a Gate 1 queue row (review round 8, note 9 — Bhargav's picks from the Lavish mockups):
 * the Flashlight ALONE, under the row's checkbox (P1), with the components it reached named in the app's own tooltip
 * (H2) on hover or keyboard focus.
 *
 * The RING carries the claim, as it has since round 6: DASHED = a free search suggested this group (the verdict is
 * still Gate 4's), SOLID = Gate 4 matched it. One mark per row however many components reached the group — the
 * names are in the tooltip, so a row reached twice no longer spends two lines on chips.
 *
 * The tooltip's plain-text reading is passed as its `aria-label`, so a screen reader hears one sentence instead of the
 * list markup, and the visible list is not duplicated in the accessibility copy Radix renders.
 */
export function SpotlightMarker({
  components,
  source,
  cutoff,
}: {
  components: string[];
  source: "match" | "suggestion";
  /** The suggestion cut-off in force (the reviewer's, else core's), when the run was scored. */
  cutoff?: number;
}) {
  const suggestion = source === "suggestion";
  const lead = suggestion ? "Concept Spotlight reached this group for" : "Concept Spotlight matched this group at Gate 4 for";
  const how = suggestion
    ? `${cutoff != null ? `A free search at the ${cutoff.toFixed(2)} cut-off.` : "A free search suggested it."} The verdict is Gate 4's.`
    : "";
  const reading = `${lead}: ${components.join(", ")}.${how ? ` ${how}` : ""}`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="img"
          tabIndex={0}
          aria-label={`Concept Spotlight: ${suggestion ? "suggested" : "matched at Gate 4"} for ${components.join(", ")}`}
          data-testid="queue-score-tag"
          data-tag-source={source}
          data-ring={suggestion ? "dashed" : "solid"}
          className={cn(
            "inline-flex h-5 w-5 cursor-help items-center justify-center rounded-full border border-accent-action text-accent-on-raised",
            "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-action",
            suggestion && "border-dashed",
          )}
        >
          <Flashlight aria-hidden="true" className="h-3 w-3" />
        </span>
      </TooltipTrigger>
      <TooltipContent
        side="right"
        align="start"
        aria-label={reading}
        data-testid="queue-score-tip"
        className="max-w-xs whitespace-normal text-left leading-relaxed"
      >
        <p className="font-semibold">{lead}:</p>
        <ul className="mt-0.5 list-disc pl-4">
          {components.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
        {how && <p className="mt-1">{how}</p>}
      </TooltipContent>
    </Tooltip>
  );
}
