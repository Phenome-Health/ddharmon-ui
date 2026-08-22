import { Info } from "lucide-react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ROLE_HELP, type ColumnRole } from "@/types";

/**
 * The small ⓘ that carries a field's or a role's explanation.
 *
 * EXTRACTED from `pages/home.tsx` (08-13 review), where it was a file-local helper. The staged-review
 * screens need the same affordance and there is exactly one right answer for what a role means, so the
 * component and its copy are shared rather than re-typed per screen. `home.tsx` now imports it, which is
 * why this move is a refactor and not a second implementation.
 */
export function InfoTip({ text, label }: { text: string; label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="text-on-raised-muted transition-colors hover:text-accent-on-raised"
          aria-label={label}
        >
          <Info className="h-3 w-3" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs whitespace-normal text-left font-normal normal-case leading-relaxed">
        {text}
      </TooltipContent>
    </Tooltip>
  );
}

/** A role's own help text, from the single `ROLE_HELP` register — never a re-worded copy. */
export function RoleInfo({ role }: { role: ColumnRole }) {
  return <InfoTip text={ROLE_HELP[role]} label={`What is ${role}?`} />;
}
