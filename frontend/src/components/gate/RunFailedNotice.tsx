import { RerunAction } from "@/components/rerun-action";
import type { JobResult } from "@/types";

/**
 * A run that FAILED, said once, in the run-state slot between the rail and the how-to panel.
 *
 * Round 10 (Bhargav, a live run in Lavish, 2026-10-14): a run whose first leg failed left him "no recourse". The
 * server's sentence said "press Continue" on a screen that has no Continue, Gate 1's empty state linked to the run's
 * read-only Setup, and the error sat BELOW the how-to panel. A run that failed before its first gate has no gate to
 * fall back to — the backend marks it `error` and refuses to resume it — so the honest way on is a NEW run with the
 * same inputs: Setup prefilled, which is also where the key is asked for. That is the one action offered here.
 *
 * A failure on a LATER leg never reaches this notice: the run stays parked at its last good gate with the error on
 * record, and that gate's Continue bar (with its key field) is the retry.
 */
export function RunFailedNotice({ job, jobId }: { job: JobResult; jobId: string }) {
  return (
    <section
      data-testid="run-failed"
      role="alert"
      className="flex flex-col gap-2 rounded-card bg-surface-raised px-6 py-4 shadow-card"
    >
      <p className="text-sm font-semibold text-status-danger">
        This run failed{job.failedPhase ? ` while ${job.failedPhase}` : ""}.
      </p>
      {job.errorMessage && <p className="max-w-[80ch] text-sm text-on-raised">{job.errorMessage}</p>}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <RerunAction job={{ jobId, displayName: job.displayName || jobId }} labeled testId="run-failed-rerun" />
        <p className="max-w-[68ch] text-xs text-on-raised-muted">
          Opens Set up with this run's dictionaries, mapping and settings filled in. Paste your key there and press
          Start — a re-run is a new run, so it pays for its steps again.
        </p>
      </div>
    </section>
  );
}
