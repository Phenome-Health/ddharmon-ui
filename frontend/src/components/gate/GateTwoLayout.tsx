import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

/**
 * Gate 2's two-pane master–detail layout.
 *
 * ADAPTED FROM CDEMapper (Wang et al., JAMIA 2025;32:1130–1139, doi:10.1093/jamia/ocaf064, Fig. 4) and
 * CREDITED ON SCREEN by the page that uses it. We do not claim to beat CDEMapper on recall and the credit
 * must not imply we do: convergent method, extended scope.
 *
 * `minmax(0, 1fr)` ON THE DETAIL TRACK, NEVER A PLAIN `1fr`. A plain `fr` keeps `min-width: auto`, so a
 * wide permissible-value matrix widens the TRACK rather than scrolling inside it, and the whole page scrolls
 * sideways. This was discovered on the mockup and is recorded here so it is not rediscovered (UI-SPEC §6).
 *
 * The master track is a fixed 320px — a layout track, not spacing, so it is exempt from the round-to-4
 * rule (§2).
 */

export function GateTwoLayout({
  master,
  detail,
  masterLabel,
  detailLabel,
  className,
}: {
  /** The ranked concept list. */
  master: React.ReactNode;
  /** The selected concept's candidates and controls. */
  detail: React.ReactNode;
  masterLabel: string;
  detailLabel: string;
  className?: string;
}) {
  return (
    <div
      data-testid="gate-two-layout"
      className={cn("grid grid-cols-[320px_minmax(0,1fr)] gap-8", className)}
    >
      <ScrollArea aria-label={masterLabel} className="max-h-[70vh] rounded-card bg-surface-raised shadow-card">
        <nav aria-label={masterLabel}>{master}</nav>
      </ScrollArea>
      {/* `min-w-0` on the child as well as `minmax(0,…)` on the track: the track stops the PAGE from
          widening, and this stops a wide table from widening the pane's own flex children. */}
      <section aria-label={detailLabel} className="flex min-w-0 flex-col gap-6">
        {detail}
      </section>
    </div>
  );
}
