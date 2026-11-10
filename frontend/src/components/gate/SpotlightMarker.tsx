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
 *
 * ON A PREVIEW (08-31) the tooltip names the free search and stops: a Preview never reaches Gate 4, so "the verdict is
 * Gate 4's" would promise a match the run will never make. That it cannot match is said once, in the panel.
 */
export function SpotlightMarker({
  components,
  source,
  cutoff,
  preview = false,
}: {
  components: string[];
  source: "match" | "suggestion";
  /**
   * The cut-off(s) the suggestion was made at — each reaching list's own (the reviewer's for it, else core's) — when the
   * run was scored. Several when concepts from lists with different cut-offs reached the group.
   */
  cutoff?: number | readonly number[];
  /** A Preview run's row: there is no Gate 4 to defer the verdict to. */
  preview?: boolean;
}) {
  const suggestion = source === "suggestion";
  const lead = suggestion ? "Concept Spotlight reached this group for" : "Concept Spotlight matched this group at Gate 4 for";
  const cutoffs = [...new Set(cutoff == null ? [] : typeof cutoff === "number" ? [cutoff] : cutoff)].sort((a, b) => a - b);
  const search =
    cutoffs.length === 1
      ? `A free search at the ${cutoffs[0]!.toFixed(2)} cut-off.`
      : cutoffs.length > 1
        ? `A free search, each list at its own cut-off (${cutoffs.map((c) => c.toFixed(2)).join(", ")}).`
        : "A free search suggested it.";
  const how = suggestion ? (preview ? search : `${search} The verdict is Gate 4's.`) : "";
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
