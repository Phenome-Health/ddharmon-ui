import { Button } from "@/components/ui/button";
import { gate1ExportUrl } from "@/lib/api";

/**
 * Why Gate 1's export cannot be downloaded HERE — or `null` when it can (08-31).
 *
 * Two honest reasons, in the order they bind. The static build has no server to build the file (the same absence
 * Gate 0's downloads state, `PreparedExport`). And the shared sample keeps a guest's moves in the tab, where the server
 * — which builds the file from the run's stored decisions — cannot read them, so a download would hand back the groups
 * WITHOUT the edits on screen.
 */
export function groupsDownloadBlocked(jobId: string, pinned: boolean | undefined): string | null {
  if (gate1ExportUrl(jobId) === null) return "Unavailable here: this copy of the app has no server to build the file.";
  if (pinned === true) {
    return "Unavailable on the shared sample: your changes stay in this tab, where the server that builds the file cannot read them.";
  }
  return null;
}

/**
 * "Download groups (CSV)" — Gate 1's free export: every group's variables as the reviewer left them (moves, New
 * groups, renames), then the variables in no group. A plain download link: nothing is charged and no run state moves.
 *
 * Where it cannot work it is a DISABLED button with its reason beneath, never a link to a 404 — the caller decides
 * whether that explanation belongs on its screen (a Preview's end bar, where the export is the last step) or whether
 * to leave the control out (a paid Gate 1's bar, where it is an extra beside Continue).
 */
export function GroupsDownload({
  jobId,
  pinned,
  primary = false,
}: {
  jobId: string;
  pinned: boolean | undefined;
  /** The bar's main action (a Preview's end), rather than a secondary one beside Continue. */
  primary?: boolean;
}) {
  const blocked = groupsDownloadBlocked(jobId, pinned);
  const href = gate1ExportUrl(jobId);
  const variant = primary ? "default" : "outline";
  if (blocked || !href) {
    return (
      <div className="flex max-w-[32ch] flex-col items-end gap-1">
        <Button type="button" variant={variant} data-testid="gate1-export" disabled className="min-h-10">
          Download groups (CSV)
        </Button>
        <p data-testid="gate1-export-unavailable" className="text-right text-xs text-on-raised-muted">
          {blocked}
        </p>
      </div>
    );
  }
  return (
    <Button asChild variant={variant} className="min-h-10">
      <a data-testid="gate1-export" href={href} download>
        Download groups (CSV)
      </a>
    </Button>
  );
}
