import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cancelJob, deleteJob, listJobs } from "@/lib/api";
import { useAuthState } from "@/auth";
import { RerunAction } from "@/components/rerun-action";
import { StopRunAction } from "@/components/stop-run-action";
import { stopCostSplit, type JobSummary } from "@/types";

// Terminal statuses; anything else is an in-flight phase (data-driven — we don't enumerate phases).
const TERMINAL = new Set(["complete", "error", "cancelled"]);

// Delete a run behind a confirmation dialog — a run can carry real LLM cost, so guard the trash button
// against a fat-finger click. Names the run being deleted; delete is irreversible.
function DeleteAction({ job }: { job: JobSummary }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function confirm() {
    setBusy(true);
    try {
      await deleteJob(job.jobId);
      qc.invalidateQueries({ queryKey: ["jobs"] });
      setOpen(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <Button variant="ghost" size="icon" aria-label="Delete" title="Delete this run" onClick={() => setOpen(true)}>
        <Trash2 className="h-4 w-4 text-neutral-400" />
      </Button>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete “{job.displayName}”?</AlertDialogTitle>
          <AlertDialogDescription>
            This permanently deletes the run and its results. This can’t be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={busy}
            onClick={(e) => {
              e.preventDefault();
              confirm();
            }}
            className={cn(buttonVariants({ variant: "destructive" }))}
          >
            {busy ? "Deleting…" : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export default function JobsPage() {
  const qc = useQueryClient();
  const { isGuest } = useAuthState();
  // Real runs are per-account and behind the SSO gate, so guests don't fetch the list (it would 401) —
  // they get a sign-in CTA instead. The demo lives on its own page.
  const { data: jobs = [], isLoading } = useQuery({
    queryKey: ["jobs"],
    queryFn: listJobs,
    refetchInterval: 3000,
    enabled: !isGuest,
  });

  if (isGuest) {
    return (
      <div className="mx-auto max-w-4xl space-y-4">
        <h1 className="text-2xl font-semibold text-ph-ink">Runs</h1>
        <Card>
          <CardContent className="space-y-3 p-8 text-center">
            <p className="text-sm text-neutral-600">Your runs live in your account.</p>
            <p className="text-xs text-neutral-500">
              Sign in to upload cohorts and see your harmonization runs here — or try the{" "}
              <Link href="/demo" className="text-ph-navy underline hover:text-ph-ink">
                demo
              </Link>{" "}
              without an account.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <h1 className="text-2xl font-semibold text-ph-ink">Runs</h1>
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Run</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Records</TableHead>
                <TableHead>Created</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {jobs.map((j) => (
                <TableRow key={j.jobId}>
                  <TableCell>
                    <span className="flex items-center gap-2">
                      <Link
                        href={
                          j.status === "complete" || (j.config as { demo?: boolean })?.demo
                            ? `/job/${j.jobId}?results=1`
                            : `/job/${j.jobId}`
                        }
                        className="font-medium text-ph-navy hover:underline"
                      >
                        {j.displayName}
                      </Link>
                      {(j.config as { demo?: boolean })?.demo && (
                        <Badge variant="outline" className="border-ph-navy/30 text-ph-navy">
                          Demo
                        </Badge>
                      )}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Badge variant={j.status === "complete" ? "success" : j.status === "error" ? "destructive" : "outline"}>
                      {TERMINAL.has(j.status) ? j.status : j.phase}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{j.nRecords || "—"}</TableCell>
                  <TableCell className="text-sm text-neutral-500">
                    {new Date(j.createdAt * 1000).toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right">
                    <span className="flex items-center justify-end gap-1">
                      {!TERMINAL.has(j.status) && !(j.config as { demo?: boolean })?.demo && (
                        <StopRunAction
                          displayName={j.displayName}
                          costNote={stopCostSplit(j.config, j.phase)}
                          onKeep={async () => {
                            await cancelJob(j.jobId, "keep");
                            qc.invalidateQueries({ queryKey: ["jobs"] });
                          }}
                          onDiscard={async () => {
                            await cancelJob(j.jobId, "discard");
                            qc.invalidateQueries({ queryKey: ["jobs"] });
                          }}
                        />
                      )}
                      {TERMINAL.has(j.status) && !(j.config as { demo?: boolean })?.demo && <RerunAction job={j} />}
                      <DeleteAction job={j} />
                    </span>
                  </TableCell>
                </TableRow>
              ))}
              {!jobs.length && !isLoading && (
                <TableRow>
                  <TableCell colSpan={5} className="py-8 text-center text-sm text-neutral-400">
                    No runs yet. <Link href="/new" className="text-ph-navy hover:underline">Start one →</Link>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
