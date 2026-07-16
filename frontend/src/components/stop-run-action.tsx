import { useState } from "react";
import { CircleStop } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { formatUsd, type StopCostSplit } from "@/types";

// Stop an in-progress run behind a confirmation dialog that offers BOTH ways to stop, because a run carries
// real LLM cost: "Stop & keep results" lets the in-flight stage finish (you keep its partial output) and skips
// the rest; "Discard now" hard-aborts with no results. `onKeep`/`onDiscard` perform the actual stop (the
// backend cancel with its mode, or the static-preview replay stop) — both flow through the stream hook's
// `cancel(mode)`. `costNote` (when priced) shows the ≈ committed-vs-avoided split. `labeled` shows text beside
// the icon (the run view); icon-only fits a table row (the Runs list).
export function StopRunAction({
  displayName,
  onKeep,
  onDiscard,
  costNote,
  labeled = false,
}: {
  displayName: string;
  onKeep: () => Promise<void> | void;
  onDiscard: () => Promise<void> | void;
  costNote?: StopCostSplit;
  labeled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<"keep" | "discard" | null>(null);

  async function run(mode: "keep" | "discard", fn: () => Promise<void> | void) {
    setBusy(mode);
    try {
      await fn();
      setOpen(false);
    } finally {
      setBusy(null);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={(o) => !busy && setOpen(o)}>
      {labeled ? (
        <Button variant="outline" size="sm" onClick={() => setOpen(true)} className="shrink-0 text-danger">
          <CircleStop className="mr-1.5 h-3.5 w-3.5" /> Stop run
        </Button>
      ) : (
        <Button variant="ghost" size="icon" aria-label="Stop" title="Stop this run" onClick={() => setOpen(true)}>
          <CircleStop className="h-4 w-4 text-neutral-400" />
        </Button>
      )}
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Stop “{displayName}”?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p>
                <span className="font-medium text-neutral-700">Stop &amp; keep results</span> lets the current
                stage finish and keeps its partial output, then skips the rest.{" "}
                <span className="font-medium text-neutral-700">Discard now</span> stops immediately and produces
                no results. Either way you can re-run later from the same inputs.
              </p>
              {costNote?.hasEstimate ? (
                <p className="rounded-md bg-neutral-50 px-2.5 py-1.5 text-xs text-neutral-600">
                  ≈<span className="font-medium tabular-nums text-neutral-700">{formatUsd(costNote.committed)}</span>{" "}
                  already committed · stopping now avoids ≈
                  <span className="font-medium tabular-nums text-neutral-700">{formatUsd(costNote.avoided)}</span> more{" "}
                  <span className="text-neutral-400">(of a ≈{formatUsd(costNote.total)} run · estimate)</span>
                </p>
              ) : (
                <p className="text-xs text-neutral-500">
                  Work already sent to the model may still be billed; stopping now avoids the remaining stages.
                </p>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={!!busy}>Keep running</AlertDialogCancel>
          <Button
            onClick={(e) => {
              e.preventDefault();
              run("keep", onKeep);
            }}
            disabled={!!busy}
          >
            {busy === "keep" ? "Stopping…" : "Stop & keep results"}
          </Button>
          <Button
            variant="destructive"
            onClick={(e) => {
              e.preventDefault();
              run("discard", onDiscard);
            }}
            disabled={!!busy}
          >
            {busy === "discard" ? "Discarding…" : "Discard now"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
