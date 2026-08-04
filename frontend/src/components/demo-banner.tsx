// The demo's honesty strip: a persistent notice that this run is shared and read-only, plus the one action
// that changes that — take a copy of your own.
//
// The demo is deliberately fully clickable: you can approve, reject, and build composites to get the feel of
// the workbench. None of it reaches the server (writes to a pinned run are refused there), so the promise
// this banner makes has to be exact — the work is yours, it is not saved, and it disappears with the tab.
//
// The clone offers BOTH flavours whenever the sandbox holds anything, because neither is right for everyone:
// someone who has been evaluating wants their verdicts carried over; someone who was just poking at buttons
// wants a clean copy.
import { useState } from "react";
import { useLocation } from "wouter";
import { Copy, FlaskConical, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { AUTH_ENABLED, cloneJob } from "@/lib/api";
import { clearSandbox, sandboxArtifacts, sandboxVerdictCount } from "@/lib/sandbox";

export function DemoBanner({
  jobId,
  displayName,
  unsavedCount,
}: {
  jobId: string;
  displayName?: string;
  /**
   * How many unsaved verdicts the parent is holding. Passed in rather than read from sessionStorage,
   * because the sandbox is written by an effect that runs AFTER the render triggered by a verdict — reading
   * storage here would always render one click behind. The parent has the value already.
   */
  unsavedCount?: number;
}) {
  const [, navigate] = useLocation();
  const [busy, setBusy] = useState<"" | "fresh" | "changes">("");
  // Fall back to storage for callers that don't track verdicts themselves (they render one behind only if
  // they mutate the sandbox, which those callers by definition don't).
  const carried = unsavedCount ?? sandboxVerdictCount(jobId);

  async function clone(withChanges: boolean) {
    setBusy(withChanges ? "changes" : "fresh");
    try {
      const { jobId: newId } = await cloneJob(jobId, {
        displayName: displayName ? `${displayName} (my copy)` : undefined,
        artifacts: withChanges ? sandboxArtifacts(jobId) : [],
      });
      if (withChanges) clearSandbox(jobId); // it lives on the copy now — leaving it would double-count
      toast.success(withChanges ? `Copied with your ${carried} change${carried === 1 ? "" : "s"}` : "Copy created");
      navigate(`/job/${newId}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not copy this run");
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200">
      <span className="flex items-center gap-1.5 font-medium">
        <FlaskConical className="h-3.5 w-3.5" /> Shared demo
      </span>
      <span className="text-amber-800 dark:text-amber-300/90">
        Try anything — verdicts and composites here are yours alone, are <strong>not saved</strong>, and go
        away when you close the tab.
        {carried > 0 && ` ${carried} unsaved change${carried === 1 ? "" : "s"}.`}
      </span>
      <div className="ml-auto flex items-center gap-1.5">
        {carried > 0 && (
          <Button size="sm" variant="default" className="h-7 gap-1.5" disabled={!!busy} onClick={() => clone(true)}>
            {busy === "changes" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Copy className="h-3 w-3" />}
            Keep my changes
          </Button>
        )}
        <Button size="sm" variant="outline" className="h-7 gap-1.5" disabled={!!busy} onClick={() => clone(false)}>
          {busy === "fresh" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Copy className="h-3 w-3" />}
          {carried > 0 ? "Copy without them" : "Make my own copy"}
        </Button>
      </div>
      {AUTH_ENABLED && (
        <span className="w-full text-[11px] text-amber-700/80 dark:text-amber-300/60">
          Copying needs an account — the copy is yours, and everything you do in it is saved.
        </span>
      )}
    </div>
  );
}
