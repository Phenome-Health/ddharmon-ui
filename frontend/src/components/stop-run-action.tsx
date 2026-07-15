import { useState } from "react";
import { CircleStop } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";

// Stop an in-progress run behind a confirmation dialog — a run carries real LLM cost/time, so guard the
// control (reusing the delete-confirmation pattern from the Runs list). `onConfirm` performs the actual stop:
// the backend cancel, or the static-preview replay stop (both flow through the stream hook's `cancel`).
// `labeled` shows text beside the icon (the run view); icon-only fits a table row (the Runs list).
export function StopRunAction({
  displayName,
  onConfirm,
  labeled = false,
}: {
  displayName: string;
  onConfirm: () => Promise<void> | void;
  labeled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function confirm() {
    setBusy(true);
    try {
      await onConfirm();
      setOpen(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
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
          <AlertDialogDescription>
            The run stops at its next step and won’t start any further stages. Work already sent to the model
            may still be billed, and a stopped run produces no results. You can re-run it later from the same
            inputs.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Keep running</AlertDialogCancel>
          <AlertDialogAction
            disabled={busy}
            onClick={(e) => {
              e.preventDefault();
              confirm();
            }}
            className={cn(buttonVariants({ variant: "destructive" }))}
          >
            {busy ? "Stopping…" : "Stop run"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
