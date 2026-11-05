import type { ReactNode } from "react";
import { Info } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

// A small info affordance placed next to a plot/chart title. On hover it explains, in plain language, what
// the chart is showing and how to read it. Relies on the app-wide TooltipProvider (see App.tsx).
export function PlotInfo({ children }: { children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="text-on-raised-muted transition-colors hover:text-accent-on-raised"
          aria-label="What this shows"
        >
          <Info className="h-4 w-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-xs font-normal leading-relaxed">{children}</TooltipContent>
    </Tooltip>
  );
}
