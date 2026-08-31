import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { ClipboardCheck, Trash2 } from "lucide-react";
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
import { isInFlight, isParked, isTerminal } from "@/lib/run-state";
import { resumeGateOf, resumePathFor } from "@/lib/gate-routes";
import { GATE_LABELS } from "@/components/gate/GateRail";
import { useAuthState } from "@/auth";
import { RerunAction } from "@/components/rerun-action";
import { StopRunAction } from "@/components/stop-run-action";
import { formatUsd, stopCostSplit, type JobSummary } from "@/types";

/**
 * WHERE THE PREDICATES WENT. This file used to carry its own `TERMINAL = new Set(["complete", "error",
 * "cancelled"])`, which made every parked run look in-flight: `awaiting_review` is non-terminal, so a
 * paused run was linked to the progress dashboard, badged with a pipeline phase, and offered a Stop for a
 * worker that does not exist. `@/lib/run-state` now owns the three-way answer for every surface at once.
 */

// Resume a run parked at a review gate. NOT a Stop and NOT a Re-run: the row's own name links here too,
// but a reviewer scanning the actions column should find the one thing this run is waiting for.
function ResumeAction({ href, gateLabel }: { href: string; gateLabel: string }) {
  return (
    <Link
      href={href}
      data-testid="resume-review"
      aria-label="Resume review"
      title={`Resume review at ${gateLabel}`}
      className={cn(buttonVariants({ variant: "ghost", size: "icon" }))}
    >
      <ClipboardCheck className="h-4 w-4 text-accent-on-raised" />
    </Link>
  );
}

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
        <Trash2 className="h-4 w-4 text-on-raised-muted" />
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
        <h1 className="font-display text-xl font-semibold text-on-field">Runs</h1>
        <Card>
          <CardContent className="space-y-3 p-8 text-center">
            <p className="text-sm text-on-raised">Your runs live in your account.</p>
            <p className="text-xs text-on-raised-muted">
              Sign in to upload cohorts and see your harmonization runs here — or try the{" "}
              <Link href="/demo" className="text-link-on-raised underline hover:text-on-raised">
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
      <h1 className="font-display text-xl font-semibold text-on-field">Runs</h1>
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Run</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Records</TableHead>
                <TableHead className="text-right">Cost</TableHead>
                <TableHead>Created</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {jobs.map((j) => {
                const isDemo = !!(j.config as { demo?: boolean })?.demo;
                // The demo run is deliberately exempt from all of this: it is a shipped fixture, always
                // complete, and "every existing behaviour unchanged" is a requirement of this plan.
                const resume = isDemo ? null : resumePathFor(j);
                const parkedGate = isDemo ? null : resumeGateOf(j);
                return (
                <TableRow key={j.jobId} data-testid={`job-row-${j.jobId}`}>
                  <TableCell>
                    <span className="flex items-center gap-2">
                      <Link
                        // A parked run re-enters at its gate; everything else keeps the destination it
                        // already had (results for a finished run, the dashboard for a live one).
                        href={
                          resume ??
                          (j.status === "complete" || isDemo ? `/job/${j.jobId}?results=1` : `/job/${j.jobId}`)
                        }
                        className="font-semibold text-link-on-raised hover:underline"
                      >
                        {j.displayName}
                      </Link>
                      {isDemo && (
                        <Badge variant="outline" className="border-rule-info text-accent-on-inset-strong">
                          Demo
                        </Badge>
                      )}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Badge
                      data-testid="job-status"
                      variant={j.status === "complete" ? "success" : j.status === "error" ? "destructive" : "outline"}
                    >
                      {/* A parked run's `phase` is the literal token `awaiting_review` (measured against the
                          live backend 2026-08-31) — honest but unreadable, and it names no gate. The label
                          names the screen the row's link actually OPENS, so the two cannot disagree: a run
                          parked at the retired `gate0` reads "Set up", which is where clicking it lands. */}
                      {parkedGate
                        ? `Awaiting review · ${GATE_LABELS[parkedGate]}`
                        : isTerminal(j.status)
                          ? j.status
                          : j.phase}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{j.nRecords || "—"}</TableCell>
                  <TableCell
                    className="text-right tabular-nums text-on-raised"
                    title={j.costSoFar ? "Actual token cost of this run (real spend, not an estimate)" : undefined}
                  >
                    {j.costSoFar ? formatUsd(j.costSoFar) : "—"}
                  </TableCell>
                  <TableCell className="text-sm text-on-raised-muted">
                    {new Date(j.createdAt * 1000).toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right">
                    <span className="flex items-center justify-end gap-1">
                      {isInFlight(j.status) && !isDemo && (
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
                      {/* A pause is an EXIT (08 D-01): there is no worker to cancel, so a Stop here would
                          offer to save money that is not being spent. Offer the resume instead. */}
                      {isParked(j.status) && !isDemo && resume && parkedGate && (
                        <ResumeAction href={resume} gateLabel={GATE_LABELS[parkedGate]} />
                      )}
                      {isTerminal(j.status) && !isDemo && <RerunAction job={j} />}
                      <DeleteAction job={j} />
                    </span>
                  </TableCell>
                </TableRow>
                );
              })}
              {!jobs.length && !isLoading && (
                <TableRow>
                  <TableCell colSpan={6} className="py-8 text-center text-sm text-on-raised-muted">
                    No runs yet. <Link href="/new" className="text-link-on-raised hover:underline">Start one →</Link>
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
